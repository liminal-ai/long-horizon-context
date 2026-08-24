//! Ported from packages/lhc/src/intake-stream/internal/pipeline.ts.

use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use super::super::{
    BatchEventOutcome, BatchEventResult, BatchResult, BatchSkipReason, EventRecord,
    MessageEventInput, QueuedWorkItem, ThreadPosition, TurnTransition, TurnTransitionAction,
};
use super::validate::{validate_events, validate_thread_ref};
use crate::shared_tech::derivation::Clock;
use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult, storage_failure};
use crate::shared_tech::js_json::js_json_stringify;
use crate::shared_tech::persist::{create_db_read_transaction, create_db_write_transaction};
use crate::shared_tech::storage::{Db, SqlParam};
use crate::shared_tech::work_queue::WorkItemRecord;
use crate::threads::ThreadRef;
use crate::turns::{RecordedTurnEvent, TurnStateCorruptionError, create as create_turn};

/// Called after each event is processed inside the walk (TS `IntakeWalkHook`).
/// Public setter still accepts `Box`; storage is `Arc` for reentrant dispatch
/// (clone out of the RefCell before invoke — clear/replace/nested intake).
pub type IntakeWalkHook = Box<dyn Fn(&Db, i64) + Send + Sync>;

type StoredWalkHook = Arc<dyn Fn(&Db, i64) + Send + Sync>;

// Thread-local module seams: vitest keeps file tests on one JS thread; cargo
// runs Rust tests in parallel across OS threads. TLS preserves TS per-test
// isolation without a shared poisoned global mutex.
thread_local! {
    static WALK_HOOK: RefCell<Option<StoredWalkHook>> = const { RefCell::new(None) };
    static INJECTED_CLOCK: RefCell<Option<Clock>> = const { RefCell::new(None) };
}

/// TS `setIntakeWalkHook` — REAL test seam (stores module state only).
pub fn set_intake_walk_hook(hook: Option<IntakeWalkHook>) {
    WALK_HOOK.with(|slot| {
        *slot.borrow_mut() = hook.map(Arc::from);
    });
}

/// TS `setIntakeClock` — REAL test seam (stores module state only).
pub fn set_intake_clock(clock: Option<Clock>) {
    INJECTED_CLOCK.with(|slot| {
        *slot.borrow_mut() = clock;
    });
}

fn take_injected_clock() -> Option<Clock> {
    INJECTED_CLOCK.with(|slot| slot.borrow().clone())
}

fn call_walk_hook(db: &Db, index: i64) {
    // Clone Arc out before invoke — no RefCell borrow across the callback
    // (hook may clear/replace itself or nest into intake).
    let hook = WALK_HOOK.with(|slot| slot.borrow().clone());
    if let Some(hook) = hook {
        hook(db, index);
    }
}

fn panic_detail(panic: Box<dyn std::any::Any + Send>) -> String {
    if let Some(err) = panic.downcast_ref::<TurnStateCorruptionError>() {
        return err.message.clone();
    }
    if let Some(s) = panic.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = panic.downcast_ref::<String>() {
        return s.clone();
    }
    "unknown panic".to_string()
}

fn is_turn_state_corruption(panic: &(dyn std::any::Any + Send)) -> Option<String> {
    panic
        .downcast_ref::<TurnStateCorruptionError>()
        .map(|e| e.message.clone())
}

fn system_time_to_iso(time: SystemTime) -> String {
    let ms = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64;
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let hh = tod / 3600;
    let mm = (tod % 3600) / 60;
    let ss = tod % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }).div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

fn thread_ref_value(thread_ref: &ThreadRef) -> Value {
    serde_json::to_value(thread_ref).expect("ThreadRef serializes")
}

fn events_value(events: &[MessageEventInput]) -> Value {
    serde_json::to_value(events).expect("MessageEventInput slice serializes")
}

/// The skip set is read at transaction start and reads only the key column:
/// key-wins-over-content is the absence of a content comparison.
/// Chunked to stay under SQLite's bound-parameter limit.
fn recorded_keys(db: &Db, keys: &[String]) -> HashSet<String> {
    let mut found = HashSet::new();
    for chunk in keys.chunks(400) {
        if chunk.is_empty() {
            continue;
        }
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql =
            format!("SELECT idempotency_key FROM event WHERE idempotency_key IN ({placeholders})");
        let params: Vec<SqlParam> = chunk.iter().map(|k| SqlParam::from(k.as_str())).collect();
        for row in db.prepare(&sql).all(&params) {
            if let Some(Value::String(key)) = row.get("idempotency_key") {
                found.insert(key.clone());
            }
        }
    }
    found
}

fn max_event_order(db: &Db) -> i64 {
    let row = db
        .prepare("SELECT MAX(event_order) AS max_order FROM event")
        .get();
    match row.as_ref().and_then(|m| m.get("max_order")) {
        None | Some(Value::Null) => 0,
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_u64().map(|u| u as i64))
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or(0),
        Some(other) => other
            .as_i64()
            .or_else(|| other.as_f64().map(|f| f as i64))
            .unwrap_or(0),
    }
}

fn map_queued(item: &WorkItemRecord) -> QueuedWorkItem {
    QueuedWorkItem {
        work_item_id: item.work_item_id.clone(),
        owner: item.owner,
        kind: item.kind,
        source_ref: item.source_ref.clone(),
    }
}

fn map_turn_transition(t: &crate::turns::TurnTransition) -> TurnTransition {
    TurnTransition {
        action: match t.action {
            crate::turns::TurnTransitionAction::Opened => TurnTransitionAction::Opened,
            crate::turns::TurnTransitionAction::Closed => TurnTransitionAction::Closed,
        },
        turn_id: t.turn_id.clone(),
    }
}

fn build_recorded_event(
    event: &MessageEventInput,
    event_order: i64,
    recorded_at: &str,
) -> EventRecord {
    let key = event
        .idempotency_key
        .clone()
        .expect("validated event has idempotencyKey");
    let mut obj = Map::new();
    obj.insert("eventKind".into(), Value::String(event.event_kind.clone()));
    obj.insert("idempotencyKey".into(), Value::String(key));
    obj.insert("actor".into(), Value::String(event.actor.clone()));
    obj.insert("harness".into(), Value::String(event.harness.clone()));
    obj.insert("payload".into(), Value::Object(event.payload.clone()));
    obj.insert("eventOrder".into(), Value::Number(event_order.into()));
    obj.insert("recordedAt".into(), Value::String(recorded_at.to_string()));
    serde_json::from_value(Value::Object(obj)).expect("validated event builds EventRecord")
}

/// TS `runMessageEvents` — optional `clock` matches the TS default-param /
/// Python `Callable | None` (explicit arg wins over [`set_intake_clock`]).
pub async fn run_message_events(
    thread_ref: ThreadRef,
    events: &[MessageEventInput],
    clock: Option<Clock>,
) -> OpResult<BatchResult> {
    if let Some(error) = validate_thread_ref(&thread_ref_value(&thread_ref)) {
        return OpResult::Err { error };
    }
    if let Some(error) = validate_events(&events_value(events)) {
        return OpResult::Err { error };
    }

    // Explicit arg / test seam / SDK instance clock / wall time — TS freezes
    // Date globally; Rust lifecycle injects SdkConfig.clock on the seam.
    let effective: Clock = clock
        .or_else(take_injected_clock)
        .or_else(|| {
            crate::shared_tech::context::resolve_instance_config().map(|c| Arc::clone(&c.clock))
        })
        .unwrap_or_else(|| Arc::new(SystemTime::now));

    let events_owned = events.to_vec();
    let clock_for_txn = effective.clone();
    let walk_result = std::panic::AssertUnwindSafe(create_db_write_transaction(
        thread_ref,
        move |transaction| {
            let events_owned = events_owned;
            let effective = effective.clone();
            Box::pin(async move {
                // Lazy import seam: messages ↔ intake_stream cycle.
                use crate::messages;

                let keys: Vec<String> = events_owned
                    .iter()
                    .filter_map(|e| e.idempotency_key.clone())
                    .collect();
                let mut skip_set = recorded_keys(transaction.db, &keys);
                let mut last_order = max_event_order(transaction.db);
                let insert = transaction.db.prepare(
                    "INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
                );

                let mut event_results = Vec::new();
                let mut turn_transitions = Vec::new();
                let mut queued_items = Vec::new();

                for (index, event) in events_owned.iter().enumerate() {
                    let key = event
                        .idempotency_key
                        .as_deref()
                        .expect("validated idempotencyKey");
                    if skip_set.contains(key) {
                        event_results.push(BatchEventResult {
                            idempotency_key: key.to_string(),
                            outcome: BatchEventOutcome::Skipped,
                            message_id: None,
                            skip_reason: Some(BatchSkipReason::DuplicateIdempotencyKey),
                        });
                    } else {
                        last_order += 1;
                        let recorded_at = system_time_to_iso(effective());
                        let payload_json = js_json_stringify(&Value::Object(event.payload.clone()));
                        insert.run(&[
                            SqlParam::from(last_order),
                            SqlParam::from(event.event_kind.as_str()),
                            SqlParam::from(key),
                            SqlParam::from(event.actor.as_str()),
                            SqlParam::from(event.harness.as_str()),
                            SqlParam::from(payload_json.as_str()),
                            SqlParam::from(recorded_at.as_str()),
                        ]);
                        skip_set.insert(key.to_string());
                        let recorded_event = build_recorded_event(event, last_order, &recorded_at);
                        // turn_end payload carries host facts; other kinds pass empty.
                        let turn_payload = recorded_event
                            .turn_end_payload()
                            .cloned()
                            .unwrap_or_default();
                        let turn_outcome = create_turn(
                            transaction,
                            &RecordedTurnEvent {
                                event_kind: recorded_event.event_kind(),
                                event_order: last_order,
                                payload: turn_payload,
                                steer: matches!(
                                    &recorded_event,
                                    EventRecord::UserPrompt { payload, .. } if payload.steer == Some(true)
                                ),
                            },
                        );
                        turn_transitions
                            .extend(turn_outcome.transitions.iter().map(map_turn_transition));
                        queued_items.extend(turn_outcome.queued_work.iter().map(map_queued));
                        let created =
                            messages::create(transaction, &recorded_event, &turn_outcome.turn_id);
                        queued_items.extend(created.queued_work.iter().map(map_queued));
                        event_results.push(BatchEventResult {
                            idempotency_key: key.to_string(),
                            outcome: BatchEventOutcome::Recorded,
                            message_id: created.message.map(|m| m.message_id),
                            skip_reason: None,
                        });
                    }
                    call_walk_hook(transaction.db, index as i64);
                }

                OpResult::Ok {
                    value: BatchResult {
                        events: event_results,
                        turn_transitions,
                        queued_work: queued_items,
                        thread_position: ThreadPosition {
                            last_event_order: last_order,
                        },
                    },
                }
            })
        },
        Some(clock_for_txn),
    ));

    let result = match futures::FutureExt::catch_unwind(walk_result).await {
        Ok(result) => result,
        Err(panic) => {
            if let Some(message) = is_turn_state_corruption(panic.as_ref()) {
                return OpResult::Err {
                    error: ErrorResult {
                        error_class: ErrorClass::StateCorruption,
                        code: ErrorCode::TurnStateCorrupt,
                        reason: message,
                        event_index: None,
                    },
                };
            }
            return storage_failure(&format!(
                "event batch failed and rolled back whole: {}",
                panic_detail(panic)
            ));
        }
    };

    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => OpResult::Err { error },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RawEventRow {
    event_order: i64,
    event_kind: String,
    idempotency_key: String,
    actor: String,
    harness: String,
    payload: String,
    recorded_at: String,
}

fn map_raw_event(row: &serde_json::Map<String, Value>) -> RawEventRow {
    fn req_str(map: &serde_json::Map<String, Value>, key: &str) -> String {
        map.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("missing {key}"))
            .to_string()
    }
    fn req_i64(map: &serde_json::Map<String, Value>, key: &str) -> i64 {
        match map.get(key) {
            Some(Value::Number(n)) => n
                .as_i64()
                .or_else(|| n.as_u64().map(|u| u as i64))
                .or_else(|| n.as_f64().map(|f| f as i64))
                .unwrap_or_else(|| panic!("bad {key}")),
            _ => panic!("missing {key}"),
        }
    }
    RawEventRow {
        event_order: req_i64(row, "event_order"),
        event_kind: req_str(row, "event_kind"),
        idempotency_key: req_str(row, "idempotency_key"),
        actor: req_str(row, "actor"),
        harness: req_str(row, "harness"),
        payload: req_str(row, "payload"),
        recorded_at: req_str(row, "recorded_at"),
    }
}

fn event_record_from_row(row: &RawEventRow) -> EventRecord {
    let payload: Value = serde_json::from_str(&row.payload).expect("event payload json");
    let mut obj = Map::new();
    obj.insert("eventKind".into(), Value::String(row.event_kind.clone()));
    obj.insert(
        "idempotencyKey".into(),
        Value::String(row.idempotency_key.clone()),
    );
    obj.insert("actor".into(), Value::String(row.actor.clone()));
    obj.insert("harness".into(), Value::String(row.harness.clone()));
    obj.insert("payload".into(), payload);
    obj.insert("eventOrder".into(), Value::Number(row.event_order.into()));
    obj.insert("recordedAt".into(), Value::String(row.recorded_at.clone()));
    serde_json::from_value(Value::Object(obj)).expect("event row → EventRecord")
}

pub async fn run_list_events(thread_ref: ThreadRef) -> OpResult<Vec<EventRecord>> {
    if let Some(error) = validate_thread_ref(&thread_ref_value(&thread_ref)) {
        return OpResult::Err { error };
    }
    let result = std::panic::AssertUnwindSafe(create_db_read_transaction(
        thread_ref,
        |transaction| {
            Box::pin(async move {
                let rows = transaction
                .db
                .prepare(
                    "SELECT event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at
                   FROM event ORDER BY event_order",
                )
                .all(&[]);
                rows.iter()
                    .map(|row| event_record_from_row(&map_raw_event(row)))
                    .collect::<Vec<_>>()
            })
        },
    ));
    match futures::FutureExt::catch_unwind(result).await {
        Ok(OpResult::Ok { value }) => OpResult::Ok { value },
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(panic) => storage_failure(&format!("event read-back failed: {}", panic_detail(panic))),
    }
}
