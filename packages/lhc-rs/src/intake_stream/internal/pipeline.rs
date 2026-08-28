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

// ── Bounded archive projections ───────────────────────────────────────────
//
// TS parity: packages/lhc/src/intake-stream/internal/pipeline.ts. run_list_events
// above is the explicit full-archive read; the projections below are the
// bounded alternative for consumers that only need durable position or a
// finite, caller-named slice of the key space. Every statement selects
// indexed, non-payload columns only, and every result set is constant-sized or
// O(caller input).
//
// event.idempotency_key is UNIQUE (sqlite_autoindex_event_1) and event_order is
// the rowid, so a key-prefix range is an index range whose entries already
// carry the order — no payload is read or parsed on any of these paths.

use super::super::{
    EventKeyPage, EventKeyPageQuery, EventKeyPrefixCount, EventKeyReference, ThreadFrontier,
};

/// Constant-row frontier statements. No payload column, no history-wide COUNT.
pub const FRONTIER_METADATA_SQL: &str =
    "SELECT thread_id, created_at FROM thread_metadata WHERE id = 1";
pub const FRONTIER_LAST_EVENT_SQL: &str =
    "SELECT event_order, recorded_at FROM event ORDER BY event_order DESC LIMIT 1";
pub const FRONTIER_VIEW_BOUNDARY_SQL: &str =
    "SELECT position FROM view_boundary WHERE thread_singleton = 1";

/// Hard per-page row cap for the legacy prefix listing.
pub const LEGACY_KEY_PAGE_LIMIT: i64 = 200;
/// Named total cap on rows one cursor walk may traverse for a single prefix.
pub const LEGACY_KEY_TOTAL_LOOKUP_CAP: i64 = 2000;

fn invalid_bounds(reason: &str) -> ErrorResult {
    ErrorResult {
        error_class: ErrorClass::CallerError,
        code: ErrorCode::InvalidBounds,
        reason: reason.to_string(),
        event_index: None,
    }
}

/// Least string strictly greater than every string carrying `prefix`.
///
/// SQLite's BINARY collation compares UTF-8 bytes and UTF-8 byte order equals
/// code-point order, so incrementing the final code point — skipping the
/// surrogate gap, carrying past U+10FFFF — makes [prefix, upper) contain
/// exactly the prefixed keys. `None` means "no upper bound exists" (prefix is
/// all U+10FFFF); the range is then open-ended, which is still exact because
/// nothing sorts above it.
pub fn prefix_upper_bound(prefix: &str) -> Option<String> {
    let points: Vec<char> = prefix.chars().collect();
    for index in (0..points.len()).rev() {
        let code_point = points[index] as u32;
        if code_point >= 0x10ffff {
            continue; // carry into the previous position
        }
        let mut next = code_point + 1;
        if (0xd800..=0xdfff).contains(&next) {
            next = 0xe000;
        }
        let mut upper: String = points[..index].iter().collect();
        upper.push(char::from_u32(next).expect("incremented scalar value"));
        return Some(upper);
    }
    None
}

// A prefix must be non-empty: an empty prefix is the whole archive, which is
// list_events' explicit job. (TS additionally rejects lone surrogates; a Rust
// `str` cannot hold one, so that case is unrepresentable here.)
fn validate_prefix(prefix: &str) -> Option<ErrorResult> {
    if prefix.is_empty() {
        return Some(invalid_bounds(
            "prefix must be a non-empty string; use listEvents for the full archive",
        ));
    }
    None
}

/// TS `runThreadFrontier`.
pub async fn run_thread_frontier(thread_ref: ThreadRef) -> OpResult<ThreadFrontier> {
    if let Some(error) = validate_thread_ref(&thread_ref_value(&thread_ref)) {
        return OpResult::Err { error };
    }
    let result =
        std::panic::AssertUnwindSafe(create_db_read_transaction(thread_ref, |transaction| {
            Box::pin(async move {
                let metadata = transaction
                    .db
                    .prepare(FRONTIER_METADATA_SQL)
                    .get()
                    .unwrap_or_else(|| panic!("thread_metadata row is missing"));
                let thread_id = metadata
                    .get("thread_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_else(|| panic!("thread_metadata.thread_id missing"))
                    .to_string();
                let created_at = metadata
                    .get("created_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or_else(|| panic!("thread_metadata.created_at missing"))
                    .to_string();
                let last = transaction.db.prepare(FRONTIER_LAST_EVENT_SQL).get();
                let boundary = transaction.db.prepare(FRONTIER_VIEW_BOUNDARY_SQL).get();
                ThreadFrontier {
                    thread_id,
                    created_at,
                    // 0 on an empty archive — same origin as the recorded
                    // event counter.
                    last_event_order: last
                        .as_ref()
                        .and_then(|row| row.get("event_order"))
                        .and_then(json_as_i64)
                        .unwrap_or(0),
                    last_recorded_at: last
                        .as_ref()
                        .and_then(|row| row.get("recorded_at"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    view_boundary_position: boundary
                        .as_ref()
                        .and_then(|row| row.get("position"))
                        .and_then(json_as_i64)
                        .unwrap_or(0),
                }
            })
        }));
    match futures::FutureExt::catch_unwind(result).await {
        Ok(OpResult::Ok { value }) => OpResult::Ok { value },
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(panic) => storage_failure(&format!(
            "thread frontier read failed: {}",
            panic_detail(panic)
        )),
    }
}

fn json_as_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_u64().map(|u| u as i64))
            .or_else(|| n.as_f64().map(|f| f as i64)),
        _ => None,
    }
}

fn prefix_count_sql(bounded: bool) -> &'static str {
    if bounded {
        "SELECT COUNT(*) AS matches FROM event WHERE idempotency_key >= ? AND idempotency_key < ?"
    } else {
        "SELECT COUNT(*) AS matches FROM event WHERE idempotency_key >= ?"
    }
}

/// TS `runEventKeyPrefixCounts`.
pub async fn run_event_key_prefix_counts(
    thread_ref: ThreadRef,
    prefixes: &[String],
) -> OpResult<Vec<EventKeyPrefixCount>> {
    if let Some(error) = validate_thread_ref(&thread_ref_value(&thread_ref)) {
        return OpResult::Err { error };
    }
    for prefix in prefixes {
        if let Some(error) = validate_prefix(prefix) {
            return OpResult::Err { error };
        }
    }
    // Duplicates collapse to one queried, first-occurrence-ordered entry;
    // overlapping prefixes stay independent (a key under both is counted by
    // both), so the result is exactly one row per distinct input prefix.
    let mut distinct: Vec<String> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for prefix in prefixes {
        if seen.insert(prefix.as_str()) {
            distinct.push(prefix.clone());
        }
    }
    let result =
        std::panic::AssertUnwindSafe(create_db_read_transaction(thread_ref, move |transaction| {
            let distinct = distinct.clone();
            Box::pin(async move {
                let bounded = transaction.db.prepare(prefix_count_sql(true));
                let open_ended = transaction.db.prepare(prefix_count_sql(false));
                distinct
                    .into_iter()
                    .map(|prefix| {
                        let upper = prefix_upper_bound(&prefix);
                        let row = match &upper {
                            Some(upper) => bounded.get_params(&[
                                SqlParam::from(prefix.as_str()),
                                SqlParam::from(upper.as_str()),
                            ]),
                            None => open_ended.get_params(&[SqlParam::from(prefix.as_str())]),
                        };
                        let count = row
                            .as_ref()
                            .and_then(|row| row.get("matches"))
                            .and_then(json_as_i64)
                            .unwrap_or(0);
                        EventKeyPrefixCount {
                            prefix,
                            exists: count > 0,
                            count,
                        }
                    })
                    .collect::<Vec<_>>()
            })
        }));
    match futures::FutureExt::catch_unwind(result).await {
        Ok(OpResult::Ok { value }) => OpResult::Ok { value },
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(panic) => storage_failure(&format!(
            "event key prefix count failed: {}",
            panic_detail(panic)
        )),
    }
}

// ── Continuation cursor ──────────────────────────────────────────────────
//
// Wire form: "v1:<frontier>:<traversed>:<lastKey>" — version literal, decimal
// thread frontier, decimal traversed rank, raw key tail after the third
// colon. Identical to build and parse in either port.
//
// This is stateless database-consistency validation, not proof that this
// server issued the token and not an authorization boundary: the cursor
// carries no secret, no MAC, no persistent row and no cache. A continuation
// runs only when all three claims still agree with the database inside its
// own read transaction — the thread frontier is exactly the one the cursor
// names, the key is still present under the exact prefix, and its rank from
// the prefix start equals the traversed count. Stale, missing-key,
// count/rank-inconsistent, out-of-range and malformed tokens refuse as
// invalid_bounds. A forged token that happens to be consistent with the
// database on all three counts is indistinguishable from an issued one, and
// is accepted; it can still neither skip a live key nor pass the cap.
//
// Exact frontier equality is what keeps the walk honest under concurrent
// appends. Any append anywhere in the thread — a key sorting before the
// cursor's key, after it, or under an unrelated prefix — moves the frontier
// and makes every outstanding cursor stale. A stale cursor is refused
// visibly: never continued, never silently skipped past a new key, never
// reported as `complete`. The caller restarts the walk and sees the appends.
// That visible degradation is deliberate — it is what lets every statement
// below stay indexed, non-payload and hard-bounded, with no snapshot table,
// persistent cursor row or history-wide scan anywhere.
const KEY_CURSOR_VERSION: &str = "v1";

// Largest integer both ports carry exactly (TS Number.MAX_SAFE_INTEGER): a
// cursor integer above it is refused here as it is there, so the two ports
// decode every cursor identically.
const MAX_EXACT_CURSOR_INTEGER: i64 = 9_007_199_254_740_991;

/// Thread frontier for one walk: the newest event order in the archive. An
/// index endpoint read (event_order is the rowid), one row, never a history
/// count. Page one stamps it into the cursor; a continuation must match it.
pub const KEY_WALK_FRONTIER_SQL: &str =
    "SELECT event_order FROM event ORDER BY event_order DESC LIMIT 1";

/// Bounded rank/existence witness for a continuation cursor.
///
/// The inner LIMIT is bound to [`KEY_CURSOR_WITNESS_LIMIT`] — the total lookup
/// cap itself — so the statement examines at most that many indexed,
/// non-payload entries over one contiguous index range, never a history-wide
/// count.
///
/// There is deliberately no `event_order` predicate. An accepted continuation
/// has already proven the frontier is unmoved, so no row outside the walk can
/// exist in this transaction; and an order filter would let arbitrarily many
/// newer keys interleave inside the range, forcing SQLite to examine and
/// reject them before the LIMIT could be satisfied. Dropping it is what makes
/// the examined-entry bound true, not just the returned-row bound.
///
/// `rank` is the cursor key's exact 1-based position from the prefix start;
/// `last_key` equals the cursor key exactly when the key is still present and
/// its rank is inside the cap.
///
/// No upper prefix bound is needed: `last_key` carries the prefix, so every key
/// in [prefix, last_key] carries it too.
pub const KEY_CURSOR_WITNESS_SQL: &str =
    "SELECT COUNT(*) AS rank, MAX(idempotency_key) AS last_key FROM
     (SELECT idempotency_key FROM event
       WHERE idempotency_key >= ? AND idempotency_key <= ?
       ORDER BY idempotency_key ASC LIMIT ?)";

/// The value bound to [`KEY_CURSOR_WITNESS_SQL`]'s inner LIMIT: the total cap.
pub const KEY_CURSOR_WITNESS_LIMIT: i64 = LEGACY_KEY_TOTAL_LOOKUP_CAP;

#[derive(Debug, Clone)]
struct KeyCursor {
    frontier: i64,
    traversed: i64,
    last_key: String,
}

fn encode_key_cursor(frontier: i64, traversed: i64, last_key: &str) -> String {
    format!("{KEY_CURSOR_VERSION}:{frontier}:{traversed}:{last_key}")
}

// Digits only, and inside the range both ports represent exactly: a value the
// other port could not hold is refused here rather than silently truncated.
fn decode_cursor_integer(text: &str) -> Option<i64> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let value = text.parse::<i64>().ok()?;
    if !(0..=MAX_EXACT_CURSOR_INTEGER).contains(&value) {
        return None;
    }
    Some(value)
}

fn decode_key_cursor(cursor: &str, prefix: &str) -> Result<KeyCursor, ErrorResult> {
    let malformed = || invalid_bounds(&format!("cursor is malformed: {cursor}"));
    let Some(version) = cursor.find(':') else {
        return Err(malformed());
    };
    if &cursor[..version] != KEY_CURSOR_VERSION {
        return Err(malformed());
    }
    let Some(after_frontier) = cursor[version + 1..].find(':').map(|at| version + 1 + at) else {
        return Err(malformed());
    };
    let Some(after_traversed) = cursor[after_frontier + 1..]
        .find(':')
        .map(|at| after_frontier + 1 + at)
    else {
        return Err(malformed());
    };
    let Some(frontier) = decode_cursor_integer(&cursor[version + 1..after_frontier]) else {
        return Err(malformed());
    };
    let Some(traversed) = decode_cursor_integer(&cursor[after_frontier + 1..after_traversed])
    else {
        return Err(malformed());
    };
    // A walk that returned nothing emits no cursor, and no walk may claim more
    // rows than the total cap allows.
    if !(1..=LEGACY_KEY_TOTAL_LOOKUP_CAP).contains(&traversed) {
        return Err(invalid_bounds(&format!(
            "cursor traversed count must be 1..{LEGACY_KEY_TOTAL_LOOKUP_CAP}, got {traversed}"
        )));
    }
    let last_key = &cursor[after_traversed + 1..];
    if !last_key.starts_with(prefix) {
        return Err(invalid_bounds("cursor belongs to a different prefix walk"));
    }
    Ok(KeyCursor {
        frontier,
        traversed,
        last_key: last_key.to_string(),
    })
}

// Database witness for a decoded cursor, run inside the continuation's own
// read transaction. Refuses — never skips — on a frontier that has moved, a
// key absent under the prefix, a rank past the cap, or a rank that disagrees
// with the claimed traversed count.
//
// Work: one index-endpoint row for the frontier plus at most
// LEGACY_KEY_TOTAL_LOOKUP_CAP indexed, non-payload entries — never more than
// LEGACY_KEY_TOTAL_LOOKUP_CAP + 1 examined entries, whatever the archive size.
fn witness_key_cursor(
    db: &Db,
    prefix: &str,
    cursor: &KeyCursor,
    frontier: i64,
) -> Option<ErrorResult> {
    // Exact equality, not `<=`: any append anywhere moves the frontier, and a
    // cursor issued before it no longer describes a walk over this archive.
    if cursor.frontier != frontier {
        return Some(invalid_bounds(&format!(
            "cursor frontier {} does not match the thread frontier {frontier}: restart the walk",
            cursor.frontier
        )));
    }
    let row = db.prepare(KEY_CURSOR_WITNESS_SQL).get_params(&[
        SqlParam::from(prefix),
        SqlParam::from(cursor.last_key.as_str()),
        SqlParam::from(KEY_CURSOR_WITNESS_LIMIT),
    ]);
    let rank = row
        .as_ref()
        .and_then(|row| row.get("rank"))
        .and_then(json_as_i64)
        .unwrap_or(0);
    let witnessed = row
        .as_ref()
        .and_then(|row| row.get("last_key"))
        .and_then(|value| value.as_str());
    if witnessed != Some(cursor.last_key.as_str()) {
        if rank >= LEGACY_KEY_TOTAL_LOOKUP_CAP {
            return Some(invalid_bounds(&format!(
                "cursor rank exceeds LEGACY_KEY_TOTAL_LOOKUP_CAP ({LEGACY_KEY_TOTAL_LOOKUP_CAP}): {}",
                cursor.last_key
            )));
        }
        return Some(invalid_bounds(&format!(
            "cursor key is not present under this prefix: {}",
            cursor.last_key
        )));
    }
    if rank != cursor.traversed {
        return Some(invalid_bounds(&format!(
            "cursor traversed count {} does not match its rank {rank}",
            cursor.traversed
        )));
    }
    None
}

fn page_sql(from_inclusive: bool, bounded: bool) -> String {
    let comparison = if from_inclusive { ">=" } else { ">" };
    let upper = if bounded {
        " AND idempotency_key < ?"
    } else {
        ""
    };
    // No event_order predicate, for the same reason the witness has none: a
    // continuation only runs on an unmoved frontier, so every row in range was
    // already there when the walk began, and an order filter would let newer
    // keys interleave into the range and be examined past the row LIMIT.
    format!(
        "SELECT idempotency_key, event_order FROM event
     WHERE idempotency_key {comparison} ?{upper}
     ORDER BY idempotency_key ASC LIMIT ?"
    )
}

/// Exported for the structural bound assertions; not a caller surface.
pub fn page_sql_shapes() -> Vec<String> {
    vec![
        page_sql(true, true),
        page_sql(true, false),
        page_sql(false, true),
        page_sql(false, false),
    ]
}

/// TS `runListEventKeysByPrefix`.
pub async fn run_list_event_keys_by_prefix(
    thread_ref: ThreadRef,
    options: EventKeyPageQuery,
) -> OpResult<EventKeyPage> {
    if let Some(error) = validate_thread_ref(&thread_ref_value(&thread_ref)) {
        return OpResult::Err { error };
    }
    if let Some(error) = validate_prefix(&options.prefix) {
        return OpResult::Err { error };
    }
    // A limit above the hard page cap is refused, never silently clamped: a
    // caller that asked for more than the cap must see that it cannot have it.
    let limit = options.limit.unwrap_or(LEGACY_KEY_PAGE_LIMIT);
    if limit < 1 {
        return OpResult::Err {
            error: invalid_bounds(&format!(
                "limit must be an integer of at least 1, got {limit}"
            )),
        };
    }
    if limit > LEGACY_KEY_PAGE_LIMIT {
        return OpResult::Err {
            error: invalid_bounds(&format!(
                "limit must not exceed LEGACY_KEY_PAGE_LIMIT ({LEGACY_KEY_PAGE_LIMIT}), got {limit}"
            )),
        };
    }
    let mut decoded: Option<KeyCursor> = None;
    if let Some(cursor) = options.cursor.as_deref() {
        match decode_key_cursor(cursor, &options.prefix) {
            Ok(parsed) => decoded = Some(parsed),
            Err(error) => return OpResult::Err { error },
        }
    }
    let lower = options.prefix.clone();
    let upper = prefix_upper_bound(&options.prefix);
    let prefix = options.prefix.clone();

    let result =
        std::panic::AssertUnwindSafe(create_db_read_transaction(thread_ref, move |transaction| {
            let lower = lower.clone();
            let upper = upper.clone();
            let prefix = prefix.clone();
            let decoded = decoded.clone();
            Box::pin(async move {
                // Current frontier, read in this read transaction: page one
                // stamps it into the cursor, and every continuation must still
                // match it exactly.
                let frontier = transaction
                    .db
                    .prepare(KEY_WALK_FRONTIER_SQL)
                    .get()
                    .as_ref()
                    .and_then(|row| row.get("event_order"))
                    .and_then(json_as_i64)
                    .unwrap_or(0);
                let mut traversed = 0i64;
                let mut last_key: Option<String> = None;
                if let Some(cursor) = decoded.as_ref() {
                    if let Some(error) =
                        witness_key_cursor(transaction.db, &prefix, cursor, frontier)
                    {
                        return Err(error);
                    }
                    traversed = cursor.traversed;
                    last_key = Some(cursor.last_key.clone());
                }
                let remaining = LEGACY_KEY_TOTAL_LOOKUP_CAP - traversed;
                if remaining <= 0 {
                    // Degraded truth: the walk is over, and it did not reach
                    // the end.
                    return Ok(EventKeyPage {
                        keys: Vec::new(),
                        cursor: None,
                        complete: false,
                        cap_exhausted: true,
                    });
                }
                let page_size = limit.min(remaining);
                let statement = transaction
                    .db
                    .prepare(&page_sql(last_key.is_none(), upper.is_some()));
                let from = last_key.clone().unwrap_or(lower);
                // One extra row distinguishes "page full" from "prefix
                // exhausted".
                let params: Vec<SqlParam> = match &upper {
                    Some(upper) => vec![
                        SqlParam::from(from.as_str()),
                        SqlParam::from(upper.as_str()),
                        SqlParam::from(page_size + 1),
                    ],
                    None => vec![SqlParam::from(from.as_str()), SqlParam::from(page_size + 1)],
                };
                let rows = statement.all(&params);
                let page_len = rows.len().min(page_size as usize);
                let keys: Vec<EventKeyReference> = rows[..page_len]
                    .iter()
                    .map(|row| EventKeyReference {
                        idempotency_key: row
                            .get("idempotency_key")
                            .and_then(|v| v.as_str())
                            .unwrap_or_else(|| panic!("event.idempotency_key missing"))
                            .to_string(),
                        event_order: row
                            .get("event_order")
                            .and_then(json_as_i64)
                            .unwrap_or_else(|| panic!("event.event_order missing")),
                    })
                    .collect();
                let has_more = rows.len() > page_len;
                let walked = traversed + keys.len() as i64;
                if !has_more {
                    // Complete: everything under the prefix at this frontier
                    // — which the witness proved is still the current one — has
                    // been returned.
                    return Ok(EventKeyPage {
                        keys,
                        cursor: None,
                        complete: true,
                        cap_exhausted: false,
                    });
                }
                if walked >= LEGACY_KEY_TOTAL_LOOKUP_CAP {
                    return Ok(EventKeyPage {
                        keys,
                        cursor: None,
                        complete: false,
                        cap_exhausted: true,
                    });
                }
                let cursor = encode_key_cursor(
                    frontier,
                    walked,
                    &keys
                        .last()
                        .expect("a full page has a last row")
                        .idempotency_key,
                );
                Ok(EventKeyPage {
                    keys,
                    cursor: Some(cursor),
                    complete: false,
                    cap_exhausted: false,
                })
            })
        }));
    match futures::FutureExt::catch_unwind(result).await {
        Ok(OpResult::Ok { value: Ok(page) }) => OpResult::Ok { value: page },
        Ok(OpResult::Ok { value: Err(error) }) | Ok(OpResult::Err { error }) => {
            OpResult::Err { error }
        }
        Err(panic) => storage_failure(&format!(
            "event key prefix listing failed: {}",
            panic_detail(panic)
        )),
    }
}
