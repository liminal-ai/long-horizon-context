//! Ported from packages/lhc/test/work-execution.test.ts. Phase 1.
//!
//! Story 1 (Epic 02): queue execution and drain — Flow 1, in-process half.
//! Claim/lease mechanics, queue-order dispatch, terminal dispositions (reported
//! then deleted, DD-1), unknown-kind handling, both host modes, and coalesced
//! background scheduling. The cross-process legs (TC-1.3 kill, TC-1.4 claim
//! exclusion, CLI parity) live in cli-process-work (not ported here).
//!
//! `it.each` for null/invalid claim_expires_at expands to two distinct
//! `#[tokio::test]` functions.

mod fixtures;

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, CapturedLog, InferenceCallbackOpName,
    InferenceCallbacksDouble, TempStore, UserPromptOverrides, UserPromptPayload,
    create_inference_callbacks_double, kind, open_raw, read_derived_forms,
    register_test_work_handlers, temp_store, valid_event, valid_event_for_kind,
}; // AssistantText* used by concurrent turn derive tests
use lhc::intake_stream::EventKind;
use lhc::messages::{MessageDeriveDerivationType, MessageDeriveResult};
use lhc::sdk::{DrainOpts, TestingWorkRegistration};
use lhc::shared_tech::derivation::{
    BoxFuture, CompressDetailedTurnInput, DerivationState, HandlerDerivationWrite,
    HandlerRunContext, InferenceCallbacks, InferenceResult, LeaseConfig, SdkConfig, SdkMode,
    SmoothPromptInput, SubjectKind, SummarizeChunkBriefInput,
};
use lhc::shared_tech::durable_work::{
    ApplyDerivationSuccessDisposition, DerivationAttempt, DurableWorkDispatchResult,
    DurableWorkDispatcher, DurableWorkDispatcherItem, DurableWorkOperationName,
    DurableWorkSettledDisposition, apply_derivation_success,
};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::inference_types::{DerivationGuards, DetailedTurnCompressionGuards};
use lhc::shared_tech::scheduler::{DrainDisposition, DrainReport, DrainStoppedBecause};
use lhc::shared_tech::storage::{Db, SqlParam};
use lhc::shared_tech::work_queue::{QueueLiveStatus, count_live_items, queue_detail};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::turns::{ChunkDeriveDerivationType, ChunkDeriveResult, TurnDeriveResult};
use lhc::{
    Lhc, init_lhc, intake_stream, register_testing_work, set_scheduler_poke, set_thread_touch,
    threads,
};
use tokio::sync::oneshot;

const FIXED_INSTANT_MS: u64 = 1_781_092_800_000;

fn system_time_to_iso(t: SystemTime) -> String {
    let ms = t
        .duration_since(UNIX_EPOCH)
        .expect("time after epoch")
        .as_millis() as u64;
    iso_from_unix_millis(ms)
}

fn iso_from_unix_millis(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let millis = ms % 1000;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let hh = tod / 3600;
    let mm = (tod % 3600) / 60;
    let ss = tod % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

/// Howard Hinnant civil_from_days (days since Unix epoch → Y-M-D).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
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

fn parse_iso_to_system_time(iso: &str) -> SystemTime {
    // Expect `YYYY-MM-DDTHH:MM:SS.mmmZ` (the form these suites emit).
    let b = iso.as_bytes();
    assert!(b.len() >= 24 && b[b.len() - 1] == b'Z', "bad iso: {iso}");
    let y: i64 = std::str::from_utf8(&b[0..4]).unwrap().parse().unwrap();
    let mo: i64 = std::str::from_utf8(&b[5..7]).unwrap().parse().unwrap();
    let d: i64 = std::str::from_utf8(&b[8..10]).unwrap().parse().unwrap();
    let hh: i64 = std::str::from_utf8(&b[11..13]).unwrap().parse().unwrap();
    let mm: i64 = std::str::from_utf8(&b[14..16]).unwrap().parse().unwrap();
    let ss: i64 = std::str::from_utf8(&b[17..19]).unwrap().parse().unwrap();
    let millis: u64 = if b.len() >= 24 && b[19] == b'.' {
        std::str::from_utf8(&b[20..23]).unwrap().parse().unwrap()
    } else {
        0
    };
    let days = days_from_civil(y, mo, d);
    let secs = days * 86_400 + hh * 3600 + mm * 60 + ss;
    UNIX_EPOCH + Duration::from_millis(secs as u64 * 1000 + millis)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

fn cleanup_seams() {
    set_scheduler_poke(None);
    set_thread_touch(None);
}

async fn new_thread(store: &TempStore) -> (String, String) {
    let created = threads::new_thread(NewThreadInput {
        file_path: store.thread_path(None).to_string_lossy().into_owned(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await;
    match created {
        OpResult::Ok { value } => (value.thread_id, value.file_path),
        OpResult::Err { error } => panic!("thread creation failed: {}", error.reason),
    }
}

async fn send(sdk: &Lhc, file_path: &str, batch: &[lhc::MessageEventInput]) {
    let result = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(file_path), batch)
        .await;
    if !result.is_ok() {
        if let OpResult::Err { error } = result {
            panic!("batch failed: {}", error.reason);
        }
    }
}

fn manual_sdk(
    double: &InferenceCallbacksDouble,
    clock: Option<lhc::shared_tech::derivation::Clock>,
) -> Lhc {
    let callbacks = double.to_callbacks();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(callbacks.clone()),
        inference: None,
        mode: SdkMode::Manual,
        clock: Some(clock.unwrap_or_else(|| Arc::new(SystemTime::now))),
        guards: Some(DerivationGuards {
            smoothed_prompt: None,
            tool_result_summary: None,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: Some(1),
            }),
        }),
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
        view: None,
    });
    register_test_work_handlers(&sdk, callbacks, None);
    sdk
}

async fn drain(sdk: &Lhc, file_path: &str, max_items: Option<i64>) -> DrainReport {
    let opts = max_items.map(|n| DrainOpts { max_items: Some(n) });
    let result = sdk.work.drain(ThreadRef::file_path(file_path), opts).await;
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("drain failed: {}", error.reason),
    }
}

fn live_count(file_path: &str) -> i64 {
    let db = open_raw(file_path);
    let n = count_live_items(&db);
    db.close();
    n
}

fn live_detail(file_path: &str) -> Vec<lhc::shared_tech::work_queue::QueueDetailRow> {
    let db = open_raw(file_path);
    let detail = queue_detail(&db);
    db.close();
    detail
}

fn last_changes(db: &Db) -> i64 {
    db.prepare("SELECT changes() AS n")
        .get()
        .and_then(|m| m.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(-1)
}

fn claim_head_work_item(file_path: &str, expires_at: &str) {
    let db = open_raw(file_path);
    db.exec("BEGIN IMMEDIATE;");
    let expires = parse_iso_to_system_time(expires_at);
    let claimed_at = system_time_to_iso(expires - Duration::from_millis(1000));
    db.prepare(
        "UPDATE work_item
         SET status = 'claimed',
             claimed_at = ?,
             claim_expires_at = ?
         WHERE work_item_id = (
           SELECT work_item_id FROM work_item
           WHERE status IN ('queued', 'claimed')
           ORDER BY rowid LIMIT 1
         )",
    )
    .run(&[
        SqlParam::from(claimed_at.as_str()),
        SqlParam::from(expires_at),
    ]);
    let changes = last_changes(&db);
    if changes != 1 {
        db.exec("ROLLBACK;");
        db.close();
        panic!("expected to claim exactly one work item, changed {changes}");
    }
    db.exec("COMMIT;");
    db.close();
}

fn set_head_claim_expiry(file_path: &str, expires_at: Option<&str>) {
    let db = open_raw(file_path);
    db.prepare(
        "UPDATE work_item
         SET claim_expires_at = ?
         WHERE work_item_id = (
           SELECT work_item_id FROM work_item
           WHERE status = 'claimed'
           ORDER BY rowid LIMIT 1
         )",
    )
    .run(&[SqlParam::from(expires_at)]);
    let changes = last_changes(&db);
    if changes != 1 {
        db.close();
        panic!("expected to update exactly one claimed work item, changed {changes}");
    }
    db.close();
}

fn delete_work_item(file_path: &str, work_item_id: &str) {
    let db = open_raw(file_path);
    db.prepare("DELETE FROM work_item WHERE work_item_id = ?")
        .run(&[SqlParam::from(work_item_id)]);
    db.close();
}

fn set_ready_derivation(
    file_path: &str,
    subject_kind: &str,
    subject_id: &str,
    derivation_type: &str,
    content: &str,
    source_version: i64,
) {
    let db = open_raw(file_path);
    db.prepare(
        "UPDATE derivation
         SET state = 'ready', content = ?, reason = NULL, metadata = NULL,
             gaps = NULL, derived_at = ?, source_version = ?
         WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?",
    )
    .run(&[
        SqlParam::from(content),
        SqlParam::from("2026-06-10T12:00:01.000Z"),
        SqlParam::from(source_version),
        SqlParam::from(subject_kind),
        SqlParam::from(subject_id),
        SqlParam::from(derivation_type),
    ]);
    let changes = last_changes(&db);
    if changes != 1 {
        db.close();
        panic!("expected to update one derivation, changed {changes}");
    }
    db.close();
}

fn insert_abandoned_chunk_summary(file_path: &str, chunk_id: &str, derivation_type: &str) {
    let db = open_raw(file_path);
    db.prepare(
        "INSERT INTO chunk (chunk_id, chunk_order, status, accumulated_projected_tokens)
         VALUES (?, 1, 'closed', 0)",
    )
    .run(&[SqlParam::from(chunk_id)]);
    db.prepare(
        "INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
         VALUES ('chunk', ?, ?, 'pending', 1)",
    )
    .run(&[SqlParam::from(chunk_id), SqlParam::from(derivation_type)]);
    db.close();
}

type SharedSmooth = Arc<dyn Fn(SmoothPromptInput) -> BoxFuture<InferenceResult> + Send + Sync>;
type SharedCompress =
    Arc<dyn Fn(CompressDetailedTurnInput) -> BoxFuture<InferenceResult> + Send + Sync>;
type SharedBrief =
    Arc<dyn Fn(SummarizeChunkBriefInput) -> BoxFuture<InferenceResult> + Send + Sync>;

/// TS `manualSdk(callbacks)` — same callbacks object for init + handler registration.
fn callbacks_with_smooth(
    base: &InferenceCallbacksDouble,
    smooth: SharedSmooth,
) -> InferenceCallbacks {
    let base_cbs = base.to_callbacks();
    InferenceCallbacks {
        smooth_prompt: smooth,
        summarize_tool_result: base_cbs.summarize_tool_result,
        compress_detailed_turn: base_cbs.compress_detailed_turn,
        summarize_chunk_brief: base_cbs.summarize_chunk_brief,
    }
}

fn callbacks_with_compress(
    base: &InferenceCallbacksDouble,
    compress: SharedCompress,
) -> InferenceCallbacks {
    let base_cbs = base.to_callbacks();
    InferenceCallbacks {
        smooth_prompt: base_cbs.smooth_prompt,
        summarize_tool_result: base_cbs.summarize_tool_result,
        compress_detailed_turn: compress,
        summarize_chunk_brief: base_cbs.summarize_chunk_brief,
    }
}

fn callbacks_with_brief(base: &InferenceCallbacksDouble, brief: SharedBrief) -> InferenceCallbacks {
    let base_cbs = base.to_callbacks();
    InferenceCallbacks {
        smooth_prompt: base_cbs.smooth_prompt,
        summarize_tool_result: base_cbs.summarize_tool_result,
        compress_detailed_turn: base_cbs.compress_detailed_turn,
        summarize_chunk_brief: brief,
    }
}

/// Mutation-sensitive proof: clone shares Arc identity on every callback field.
fn assert_shared_callback_identity(a: &InferenceCallbacks, b: &InferenceCallbacks) {
    assert!(Arc::ptr_eq(&a.smooth_prompt, &b.smooth_prompt));
    assert!(Arc::ptr_eq(
        &a.summarize_tool_result,
        &b.summarize_tool_result
    ));
    assert!(Arc::ptr_eq(
        &a.compress_detailed_turn,
        &b.compress_detailed_turn
    ));
    assert!(Arc::ptr_eq(
        &a.summarize_chunk_brief,
        &b.summarize_chunk_brief
    ));
}

fn map_success_disposition(d: ApplyDerivationSuccessDisposition) -> DurableWorkSettledDisposition {
    match d {
        ApplyDerivationSuccessDisposition::Done => DurableWorkSettledDisposition::Done,
        ApplyDerivationSuccessDisposition::StaleDiscarded => {
            DurableWorkSettledDisposition::StaleDiscarded
        }
        ApplyDerivationSuccessDisposition::LostLease => DurableWorkSettledDisposition::LostLease,
    }
}

// ── TC-1.1 ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn tc_1_1_three_items_across_both_owners_run_in_order_rows_deleted_at_terminal_transition_derived_at_monotone()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let tick = Arc::new(AtomicI64::new(0));
    let tick_c = Arc::clone(&tick);
    let base = UNIX_EPOCH + Duration::from_millis(FIXED_INSTANT_MS);
    let sdk = manual_sdk(
        &double,
        Some(Arc::new(move || {
            let t = tick_c.fetch_add(1, Ordering::SeqCst);
            base + Duration::from_secs(t as u64)
        })),
    );
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::ToolCall),
            valid_event_for_kind(EventKind::ToolResult),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    assert_eq!(live_count(&file_path), 3);

    let report = drain(&sdk, &file_path, None).await;
    // Queue order across owners: m1's smoothing, m3's result summary, then
    // the turn derivation queued at close — never reordered.
    assert_eq!(
        report
            .ran
            .iter()
            .map(|e| e.work_item_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "w-m1-prompt_smoothing-v1",
            "w-m3-tool_result_summary-v1",
            "w-t1-turn_derivation-v1",
            "w-t1-detailed_turn_compression-v1",
        ]
    );
    assert_eq!(
        report.ran.iter().map(|e| e.disposition).collect::<Vec<_>>(),
        vec![
            DrainDisposition::Done,
            DrainDisposition::Done,
            DrainDisposition::Done,
            DrainDisposition::Done,
        ]
    );
    assert_eq!(report.stopped_because, DrainStoppedBecause::Empty);
    assert_eq!(report.remaining, 0);

    // DD-1 storage contract: terminal rows are gone — the report is the only
    // place the dispositions exist (raw zero-row read).
    assert_eq!(live_count(&file_path), 0);
    let db = open_raw(&file_path);
    let rows = db.prepare("SELECT COUNT(*) AS n FROM work_item").get();
    assert_eq!(
        rows.and_then(|r| r.get("n").cloned()),
        Some(serde_json::json!(0))
    );
    db.close();

    // Artifacts landed in run order: derivedAt strictly monotone with the
    // injected clock from m1 to m3 to the turn's forms.
    let forms = read_derived_forms(&file_path);
    assert_eq!(
        forms.iter().map(|f| f.state).collect::<Vec<_>>(),
        vec![
            DerivationState::Ready,
            DerivationState::Ready,
            DerivationState::Ready,
            DerivationState::Ready,
            DerivationState::Ready,
        ]
    );
    let at = |subject_id: &str, derivation_type: &str| -> u128 {
        let row = forms
            .iter()
            .find(|f| f.subject_id == subject_id && f.derivation_type == derivation_type);
        let derived_at = row
            .and_then(|r| r.derived_at.as_deref())
            .unwrap_or_else(|| panic!("no derivedAt for {subject_id}/{derivation_type}"));
        parse_iso_to_system_time(derived_at)
            .duration_since(UNIX_EPOCH)
            .expect("epoch")
            .as_millis()
    };
    assert!(at("m1", "smoothed_prompt") < at("m3", "tool_result_summary"));
    assert!(at("m3", "tool_result_summary") < at("t1", "turn_rendering"));
    assert_eq!(
        at("t1", "pre_detailed_assembly"),
        at("t1", "turn_rendering")
    );
    assert!(at("t1", "turn_rendering") < at("t1", "detailed_turn_compression"));
    cleanup_seams();
    store.cleanup();
}

// ── TC-1.2 ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn tc_1_2_a_burst_of_two_more_batches_during_a_slow_in_flight_drain_yields_exactly_two_passes_and_all_artifacts()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    double.delay_kind("prompt_smoothing", 100);
    let callbacks = double.to_callbacks();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(callbacks.clone()),
        inference: None,
        mode: SdkMode::Background,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 1000 }),
        chunk_policy: None,
        view: None,
    });
    register_test_work_handlers(&sdk, callbacks, None);
    let (thread_id, file_path) = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "batch A".into(),
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    // Let the poked drain start (it defers one macrotask), then queue two
    // more batches while item A's slow handler is in flight.
    sleep_ms(10).await;
    send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "batch B".into(),
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "batch C".into(),
                }),
                ..Default::default()
            },
        )],
    )
    .await;

    sdk.drain_settled(ThreadRef::file_path(&file_path)).await;

    // Everything queued mid-drain was processed before the cycle ended…
    assert_eq!(live_count(&file_path), 0);
    let smoothed: Vec<_> = read_derived_forms(&file_path)
        .into_iter()
        .filter(|f| f.derivation_type == "smoothed_prompt")
        .collect();
    assert_eq!(
        smoothed.iter().map(|f| f.state).collect::<Vec<_>>(),
        vec![
            DerivationState::Ready,
            DerivationState::Ready,
            DerivationState::Ready,
        ]
    );
    // …and the burst coalesced: one initial pass plus exactly one follow-up,
    // not one pass per poke (the cost model is the assertion).
    assert_eq!(sdk.scheduler.test_pass_count(&thread_id), 2);
    cleanup_seams();
    store.cleanup();
}

// ── TC-1.5 ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn tc_1_5_an_intake_batch_is_processed_with_no_drain_call_drain_settled_is_the_completion_signal()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let callbacks = double.to_callbacks();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(callbacks.clone()),
        inference: None,
        mode: SdkMode::Background,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 1000 }),
        chunk_policy: None,
        view: None,
    });
    register_test_work_handlers(&sdk, callbacks, None);
    let (_thread_id, file_path) = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    sdk.drain_settled(ThreadRef::file_path(&file_path)).await;

    let forms = read_derived_forms(&file_path);
    let mut keys: Vec<_> = forms
        .iter()
        .map(|f| {
            format!(
                "{}/{}/{}",
                f.subject_id,
                f.derivation_type,
                f.state.as_str()
            )
        })
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "m1/smoothed_prompt/ready".to_string(),
            "t1/detailed_turn_compression/ready".to_string(),
            "t1/pre_detailed_assembly/ready".to_string(),
            "t1/turn_rendering/ready".to_string(),
        ]
    );
    assert_eq!(live_count(&file_path), 0);
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn sync_derive_queued_behind_an_older_head_wakes_the_background_scheduler() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let callbacks = double.to_callbacks();
    let background = init_lhc(SdkConfig {
        inference_callbacks: Some(callbacks.clone()),
        inference: None,
        mode: SdkMode::Background,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 1000 }),
        chunk_policy: None,
        view: None,
    });
    register_test_work_handlers(&background, callbacks, None);
    let manual = manual_sdk(&double, None);
    let (thread_id, file_path) = new_thread(&store).await;

    let touched = background
        .logging
        .write(
            ThreadRef::file_path(&file_path),
            lhc::LogEntry {
                level: lhc::LogLevel::Info,
                message: "touch empty thread".into(),
                derivation_type: None,
                subject_id: None,
                reason: None,
                floor_used: None,
            },
        )
        .await;
    assert!(touched.is_ok());
    background
        .drain_settled(ThreadRef::file_path(&file_path))
        .await;

    send(
        &manual,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "first prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "first answer".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event_for_kind(EventKind::TurnEnd),
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "second prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "second answer".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    let db = open_raw(&file_path);
    db.prepare("DELETE FROM work_item WHERE kind = 'prompt_smoothing'")
        .run(&[]);
    db.prepare("DELETE FROM work_item WHERE work_item_id = 'w-t2-turn_derivation-v1'")
        .run(&[]);
    db.close();

    let queued = background
        .turns
        .derive_turn(ThreadRef::file_path(&file_path), "t2")
        .await;
    assert!(queued.is_ok());
    if let OpResult::Ok { value } = &queued {
        match value {
            TurnDeriveResult::Failed { turn_id, error } => {
                assert_eq!(turn_id, "t2");
                assert_eq!(error.error_class, ErrorClass::CallerError);
                assert_eq!(error.code, ErrorCode::DerivationWorkInFlight);
            }
            other => panic!("expected failed, got {other:?}"),
        }
    }

    background
        .drain_settled(ThreadRef::file_path(&file_path))
        .await;

    assert!(background.scheduler.test_pass_count(&thread_id) > 0);
    assert_eq!(live_count(&file_path), 0);
    let mut t2: Vec<_> = read_derived_forms(&file_path)
        .into_iter()
        .filter(|f| f.subject_id == "t2")
        .map(|f| (f.derivation_type, f.state.as_str().to_string()))
        .collect();
    t2.sort();
    assert_eq!(
        t2,
        vec![
            ("detailed_turn_compression".into(), "ready".into()),
            ("pre_detailed_assembly".into(), "ready".into()),
            ("turn_rendering".into(), "ready".into()),
        ]
    );
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn reopening_a_thread_with_leftover_queued_rows_recovers_them_when_the_process_engages_message_reads_stay_pure()
 {
    let store = temp_store();
    // Build the leftover state with no background scheduler installed: rows
    // accumulate exactly as a dead process would have left them.
    let (_thread_id, file_path) = new_thread(&store).await;
    let seeded = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    assert!(seeded.is_ok());
    assert_eq!(live_count(&file_path), 2);

    let double = create_inference_callbacks_double();
    let callbacks = double.to_callbacks();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(callbacks.clone()),
        inference: None,
        mode: SdkMode::Background,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 1000 }),
        chunk_policy: None,
        view: None,
    });
    register_test_work_handlers(&sdk, callbacks, None);

    // First touch of the thread in this process lifetime is a read. Message
    // list/show are read-only (Epic 04 DD-6, SV-01-001): like thread-view's
    // model-context/status before them, they suppress the open announcement, so the
    // read schedules no first-touch catch-up — the leftover rows stay exactly
    // as the dead process left them, and no model call fires off a read.
    let read = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(read.is_ok());
    sdk.drain_settled(ThreadRef::file_path(&file_path)).await;
    assert_eq!(live_count(&file_path), 2);

    // Recovery arrives the moment the process engages the thread through a
    // non-read path — here an explicit drain (an intake or any write touches
    // the same way). The leftover work catches up to ready.
    let recovered = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(recovered.is_ok());
    sdk.drain_settled(ThreadRef::file_path(&file_path)).await;

    assert_eq!(live_count(&file_path), 0);
    let states: Vec<_> = read_derived_forms(&file_path)
        .into_iter()
        .map(|f| f.state)
        .collect();
    assert_eq!(
        states,
        vec![
            DerivationState::Ready,
            DerivationState::Ready,
            DerivationState::Ready,
            DerivationState::Ready,
        ]
    );
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn first_touch_catch_up_fails_an_expired_claimed_head_and_drains_the_item_behind_it() {
    let store = temp_store();
    let (_thread_id, file_path) = new_thread(&store).await;
    let seeded = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    assert!(seeded.is_ok());

    let expires_at = system_time_to_iso(SystemTime::now() + Duration::from_millis(35));
    claim_head_work_item(&file_path, &expires_at);
    let detail = live_detail(&file_path);
    assert_eq!(detail.len(), 1);
    assert_eq!(detail[0].work_item_id, "w-m1-prompt_smoothing-v1");
    assert_eq!(detail[0].status, QueueLiveStatus::Claimed);
    assert_eq!(
        detail[0].claim_expires_at.as_deref(),
        Some(expires_at.as_str())
    );

    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let callbacks = double.to_callbacks();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(callbacks.clone()),
        inference: None,
        mode: SdkMode::Background,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 1000 }),
        chunk_policy: None,
        view: None,
    });
    register_test_work_handlers(&sdk, callbacks, None);

    let touched = sdk
        .logging
        .write(
            ThreadRef::file_path(&file_path),
            lhc::LogEntry {
                level: lhc::LogLevel::Info,
                message: "touch thread for claimed-item catch-up".into(),
                derivation_type: None,
                subject_id: None,
                reason: None,
                floor_used: None,
            },
        )
        .await;
    assert!(touched.is_ok());

    sdk.drain_settled(ThreadRef::file_path(&file_path)).await;

    assert_eq!(
        captured
            .snapshot()
            .into_iter()
            .filter(|e| e.op == InferenceCallbackOpName::SmoothPrompt)
            .count(),
        0
    );
    assert_eq!(
        read_derived_forms(&file_path)
            .into_iter()
            .map(|f| format!(
                "{}/{}/{}",
                f.subject_id,
                f.derivation_type,
                f.state.as_str()
            ))
            .collect::<Vec<_>>(),
        vec![
            "m1/smoothed_prompt/failed".to_string(),
            "t1/detailed_turn_compression/ready".to_string(),
            "t1/pre_detailed_assembly/ready".to_string(),
            "t1/turn_rendering/ready".to_string(),
        ]
    );
    assert_eq!(live_count(&file_path), 0);
    let _ = CapturedLog::len(&captured); // keep type in scope for unused lint quiet
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn a_claimed_head_with_null_claim_expires_at_is_failed_immediately() {
    claimed_head_with_claim_expires_at_is_failed_immediately(None).await;
}

#[tokio::test]
async fn a_claimed_head_with_invalid_claim_expires_at_is_failed_immediately() {
    claimed_head_with_claim_expires_at_is_failed_immediately(Some("not-a-date")).await;
}

async fn claimed_head_with_claim_expires_at_is_failed_immediately(claim_expires_at: Option<&str>) {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(&double, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;

    claim_head_work_item(&file_path, "2026-06-10T12:05:00.000Z");
    set_head_claim_expiry(&file_path, claim_expires_at);

    let report = drain(&sdk, &file_path, None).await;
    assert_eq!(report.ran.len(), 1);
    assert_eq!(report.ran[0].work_item_id, "w-m1-prompt_smoothing-v1");
    assert_eq!(report.ran[0].disposition, DrainDisposition::FailedTerminal);
    assert_eq!(report.ran[0].reason.as_deref(), Some("claim_expired"));
    assert_eq!(report.stopped_because, DrainStoppedBecause::Empty);
    assert_eq!(report.claim_expires_at, None);
    assert_eq!(live_count(&file_path), 0);
    let forms = read_derived_forms(&file_path);
    assert_eq!(forms.len(), 1);
    assert_eq!(forms[0].state, DerivationState::Failed);
    assert_eq!(forms[0].reason.as_deref(), Some("claim_expired"));
    cleanup_seams();
    store.cleanup();
}

// ── TC-1.6 ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn tc_1_6_queued_work_sits_until_work_drain_artifacts_land_after() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(&double, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;

    sleep_ms(100).await;
    assert_eq!(live_count(&file_path), 1);
    assert_eq!(live_detail(&file_path)[0].status, QueueLiveStatus::Queued);
    assert_eq!(
        read_derived_forms(&file_path)
            .into_iter()
            .map(|f| f.state)
            .collect::<Vec<_>>(),
        vec![DerivationState::Pending]
    );

    let report = drain(&sdk, &file_path, None).await;
    assert_eq!(report.ran.len(), 1);
    assert_eq!(report.ran[0].disposition, DrainDisposition::Done);
    assert_eq!(
        read_derived_forms(&file_path)
            .into_iter()
            .map(|f| f.state)
            .collect::<Vec<_>>(),
        vec![DerivationState::Ready]
    );
    assert_eq!(live_count(&file_path), 0);
    cleanup_seams();
    store.cleanup();
}

// ── TC-1.7 ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn tc_1_7_a_bogus_kind_row_ahead_of_a_valid_item_fails_with_unknown_work_kind_the_valid_item_still_runs()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(&double, None);
    let (_thread_id, file_path) = new_thread(&store).await;

    // Raw current-shape row with an unregistered kind, queued ahead of any valid work.
    let db = open_raw(&file_path);
    db.prepare(
        "INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
         VALUES ('w-mX-bogus_kind-v1', 'messages', 'bogus_kind', '{\"messageId\":\"mX\"}', 'queued',
                 '2026-06-10T11:00:00.000Z', '{\"sourceVersion\":1,\"derivations\":[]}')",
    )
    .run(&[]);
    db.close();
    send(
        &sdk,
        &file_path,
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;

    let report = drain(&sdk, &file_path, None).await;
    assert_eq!(report.ran.len(), 2);
    assert_eq!(report.ran[0].work_item_id, "w-mX-bogus_kind-v1");
    assert_eq!(report.ran[0].disposition, DrainDisposition::FailedTerminal);
    assert_eq!(report.ran[0].reason.as_deref(), Some("unknown_work_kind"));
    assert_eq!(report.ran[1].work_item_id, "w-m1-prompt_smoothing-v1");
    assert_eq!(report.ran[1].disposition, DrainDisposition::Done);
    assert_eq!(report.stopped_because, DrainStoppedBecause::Empty);
    assert_eq!(live_count(&file_path), 0);
    let smoothed = read_derived_forms(&file_path)
        .into_iter()
        .find(|f| f.subject_id == "m1");
    assert_eq!(smoothed.map(|f| f.state), Some(DerivationState::Ready));
    cleanup_seams();
    store.cleanup();
}

// ── TC-1.8 ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn tc_1_8_the_first_failure_marks_failed_deletes_the_row_and_runs_the_next_item_immediately()
{
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(&double, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;

    double.fail_kind(
        "prompt_smoothing",
        99,
        Some("scripted failure (smoothPrompt)"),
    );
    let report = drain(&sdk, &file_path, None).await;
    assert_eq!(report.ran.len(), 3);
    assert_eq!(report.ran[0].work_item_id, "w-m1-prompt_smoothing-v1");
    assert_eq!(report.ran[0].disposition, DrainDisposition::FailedTerminal);
    assert_eq!(
        report.ran[0].reason.as_deref(),
        Some("scripted failure (smoothPrompt)")
    );
    assert_eq!(report.ran[1].work_item_id, "w-t1-turn_derivation-v1");
    assert_eq!(report.ran[1].disposition, DrainDisposition::Done);
    assert_eq!(
        report.ran[2].work_item_id,
        "w-t1-detailed_turn_compression-v1"
    );
    assert_eq!(report.ran[2].disposition, DrainDisposition::Done);

    let forms = read_derived_forms(&file_path);
    let failed = forms
        .iter()
        .find(|f| f.derivation_type == "smoothed_prompt")
        .expect("smoothed");
    assert_eq!(failed.state, DerivationState::Failed);
    assert_eq!(
        failed.reason.as_deref(),
        Some("scripted failure (smoothPrompt)")
    );
    assert_eq!(
        forms
            .iter()
            .find(|f| f.derivation_type == "turn_rendering")
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(live_count(&file_path), 0);
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn tc_1_8_max_items_stops_the_drain_with_max_items_and_reports_the_remainder() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(&double, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::ToolCall),
            valid_event_for_kind(EventKind::ToolResult),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;

    let report = drain(&sdk, &file_path, Some(1)).await;
    assert_eq!(report.ran.len(), 1);
    assert_eq!(report.stopped_because, DrainStoppedBecause::MaxItems);
    assert_eq!(report.remaining, 2);
    assert_eq!(live_count(&file_path), 2);
    cleanup_seams();
    store.cleanup();
}

// ── claim ownership fencing ─────────────────────────────────────────────────

struct Scripted {
    content: String,
    mismatched_write: bool,
}

struct DeferredRun {
    tx: oneshot::Sender<DurableWorkDispatchResult>,
    run: HandlerRunContext,
    item: DurableWorkDispatcherItem,
}

fn deferred_message_sdk(now_ms: Arc<Mutex<u64>>) -> (Lhc, Arc<Mutex<Vec<DeferredRun>>>) {
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: {
            let now_ms = Arc::clone(&now_ms);
            Some(Arc::new(move || {
                let ms = *now_ms.lock().expect("now");
                UNIX_EPOCH + Duration::from_millis(ms)
            }))
        },
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 50 }),
        chunk_policy: None,
        view: None,
    });
    let runs: Arc<Mutex<Vec<DeferredRun>>> = Arc::new(Mutex::new(Vec::new()));
    let runs_for_disp = Arc::clone(&runs);
    let dispatcher: DurableWorkDispatcher = Arc::new(move |run, item| {
        let (tx, rx) = oneshot::channel();
        runs_for_disp
            .lock()
            .expect("runs")
            .push(DeferredRun { tx, run, item });
        Box::pin(async move { rx.await.expect("deferred resolve") })
    });
    let mut map = std::collections::HashMap::new();
    map.insert(DurableWorkOperationName::MessagesDerive, dispatcher);
    register_testing_work(
        &sdk,
        TestingWorkRegistration {
            handlers: None,
            dispatchers: Some(map),
        },
    );
    (sdk, runs)
}

fn resolve_deferred(pending: DeferredRun, scripted: Scripted) {
    let writes = if scripted.mismatched_write {
        vec![HandlerDerivationWrite {
            subject_kind: SubjectKind::Message,
            subject_id: "m1".to_string(),
            derivation_type: "tool_result_summary".into(),
            content: scripted.content,
            metadata: None,
            gaps: None,
        }]
    } else {
        vec![HandlerDerivationWrite {
            subject_kind: SubjectKind::Message,
            subject_id: "m1".to_string(),
            derivation_type: "smoothed_prompt".into(),
            content: scripted.content,
            metadata: None,
            gaps: None,
        }]
    };
    let db = match (pending.run.open_db)() {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("open_db failed: {}", error.reason),
    };
    let derived_at = system_time_to_iso((pending.run.clock)());
    let disposition = apply_derivation_success(
        &db,
        &DerivationAttempt {
            source_version: pending.item.source_version,
            derivations: pending.item.derivations.clone(),
            work_item_id: Some(pending.item.work_item_id.clone()),
        },
        &writes,
        &derived_at,
        None,
    );
    let _ = pending.tx.send(DurableWorkDispatchResult::Settled {
        disposition: map_success_disposition(disposition),
    });
}

#[tokio::test]
async fn an_expired_claim_is_failed_without_rerunning_it_and_its_late_completion_cannot_write() {
    let store = temp_store();
    let now_ms = Arc::new(Mutex::new(FIXED_INSTANT_MS));
    let (sdk, runs) = deferred_message_sdk(Arc::clone(&now_ms));
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;

    let older_fut = drain(&sdk, &file_path, None);
    tokio::pin!(older_fut);
    let start = std::time::Instant::now();
    while runs.lock().expect("runs").len() != 1 {
        if start.elapsed().as_millis() > 3000 {
            panic!("timed out waiting for older claim");
        }
        tokio::select! {
            _ = &mut older_fut => panic!("older drain finished before claim"),
            _ = sleep_ms(5) => {}
        }
    }

    *now_ms.lock().expect("now") += 100;
    let cleanup_report = drain(&sdk, &file_path, None).await;
    assert_eq!(cleanup_report.ran.len(), 1);
    assert_eq!(
        cleanup_report.ran[0].disposition,
        DrainDisposition::FailedTerminal
    );
    assert_eq!(
        cleanup_report.ran[0].reason.as_deref(),
        Some("claim_expired")
    );
    assert_eq!(runs.lock().expect("runs").len(), 1);

    let pending = runs.lock().expect("runs").pop().expect("pending");
    resolve_deferred(
        pending,
        Scripted {
            content: "stale completion".into(),
            mismatched_write: true,
        },
    );
    let older_report = older_fut.await;
    assert_eq!(older_report.ran.len(), 1);
    assert_eq!(older_report.ran[0].disposition, DrainDisposition::LostLease);

    let form = read_derived_forms(&file_path)
        .into_iter()
        .find(|e| e.derivation_type == "smoothed_prompt")
        .expect("form");
    assert_eq!(form.state, DerivationState::Failed);
    assert_eq!(form.reason.as_deref(), Some("claim_expired"));
    assert_eq!(live_count(&file_path), 0);
    cleanup_seams();
    store.cleanup();
}

// ── completion exactness ────────────────────────────────────────────────────

fn turn_derive_partial_dispatcher() -> DurableWorkDispatcher {
    Arc::new(|run, item| {
        Box::pin(async move {
            let db = match (run.open_db)() {
                OpResult::Ok { value } => value,
                OpResult::Err { error } => panic!("open_db failed: {}", error.reason),
            };
            let derived_at = system_time_to_iso((run.clock)());
            let disposition = apply_derivation_success(
                &db,
                &DerivationAttempt {
                    source_version: item.source_version,
                    derivations: item.derivations.clone(),
                    work_item_id: Some(item.work_item_id.clone()),
                },
                &[HandlerDerivationWrite {
                    subject_kind: SubjectKind::Turn,
                    subject_id: "t1".to_string(),
                    derivation_type: "turn_rendering".into(),
                    content: "partial rendering".into(),
                    metadata: None,
                    gaps: None,
                }],
                &derived_at,
                None,
            );
            DurableWorkDispatchResult::Settled {
                disposition: map_success_disposition(disposition),
            }
        })
    })
}

#[tokio::test]
async fn a_queued_turn_derivation_success_missing_one_expected_write_rolls_back_and_leaves_the_item_live()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(&double, None);
    let mut map = std::collections::HashMap::new();
    map.insert(
        DurableWorkOperationName::TurnsDeriveTurn,
        turn_derive_partial_dispatcher(),
    );
    register_testing_work(
        &sdk,
        TestingWorkRegistration {
            handlers: None,
            dispatchers: Some(map),
        },
    );
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    drain(&sdk, &file_path, Some(1)).await;

    let failed = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(!failed.is_ok());
    if let OpResult::Err { error } = failed {
        assert_eq!(error.error_class, ErrorClass::StateCorruption);
        assert_eq!(error.code, ErrorCode::DerivationCompletionMismatch);
        assert!(error.reason.contains("derivation_completion_mismatch"));
    }

    let mut forms: Vec<_> = read_derived_forms(&file_path)
        .into_iter()
        .filter(|f| f.subject_id == "t1")
        .map(|f| {
            (
                f.derivation_type,
                f.state.as_str().to_string(),
                f.content.clone(),
            )
        })
        .collect();
    forms.sort();
    assert_eq!(
        forms,
        vec![
            ("pre_detailed_assembly".into(), "pending".into(), None),
            ("turn_rendering".into(), "pending".into(), None),
        ]
    );
    let detail = live_detail(&file_path);
    assert_eq!(detail.len(), 1);
    assert_eq!(detail[0].work_item_id, "w-t1-turn_derivation-v1");
    assert_eq!(detail[0].status, QueueLiveStatus::Claimed);

    let db = open_raw(&file_path);
    let members = db
        .prepare("SELECT COUNT(*) AS n FROM chunk_member WHERE turn_id = 't1'")
        .get();
    let summaries = db
        .prepare("SELECT COUNT(*) AS n FROM work_item WHERE kind LIKE 'chunk_summary_%'")
        .get();
    assert_eq!(
        members.and_then(|r| r.get("n").cloned()),
        Some(serde_json::json!(0))
    );
    assert_eq!(
        summaries.and_then(|r| r.get("n").cloned()),
        Some(serde_json::json!(0))
    );
    db.close();
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn a_stale_queued_terminal_failure_deletes_owned_work_without_stamping_the_newer_derivation()
{
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(&double, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;
    let db = open_raw(&file_path);
    db.prepare(
        "UPDATE derivation
         SET source_version = 2
         WHERE subject_kind = 'message' AND subject_id = 'm1' AND derivation_type = 'smoothed_prompt'",
    )
    .run(&[]);
    db.close();

    double.fail_kind("prompt_smoothing", 1, Some("stale terminal failure"));
    let report = drain(&sdk, &file_path, None).await;
    assert_eq!(report.ran.len(), 1);
    assert_eq!(report.ran[0].work_item_id, "w-m1-prompt_smoothing-v1");
    assert_eq!(report.ran[0].disposition, DrainDisposition::FailedTerminal);
    assert_eq!(
        report.ran[0].reason.as_deref(),
        Some("stale terminal failure")
    );
    assert_eq!(live_count(&file_path), 0);
    let forms = read_derived_forms(&file_path);
    assert_eq!(forms.len(), 1);
    assert_eq!(forms[0].subject_id, "m1");
    assert_eq!(forms[0].derivation_type, "smoothed_prompt");
    assert_eq!(forms[0].state, DerivationState::Pending);
    assert_eq!(forms[0].source_version, 2);
    assert_eq!(forms[0].reason, None);
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn a_queued_terminal_failure_that_hits_only_part_of_its_targets_rolls_back_and_leaves_the_item_live()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(&double, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    drain(&sdk, &file_path, Some(1)).await;

    let db = open_raw(&file_path);
    db.prepare(
        "UPDATE derivation
         SET source_version = 2
         WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'pre_detailed_assembly'",
    )
    .run(&[]);
    db.close();

    let mut map = std::collections::HashMap::new();
    map.insert(
        DurableWorkOperationName::TurnsDeriveTurn,
        turn_derive_partial_dispatcher(),
    );
    register_testing_work(
        &sdk,
        TestingWorkRegistration {
            handlers: None,
            dispatchers: Some(map),
        },
    );

    let failed = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(!failed.is_ok());
    if let OpResult::Err { error } = failed {
        assert_eq!(error.error_class, ErrorClass::StateCorruption);
        assert_eq!(error.code, ErrorCode::DerivationCompletionMismatch);
        assert!(
            error
                .reason
                .contains("derivation completion target mismatch")
        );
    }

    let mut forms: Vec<_> = read_derived_forms(&file_path)
        .into_iter()
        .filter(|f| f.subject_id == "t1")
        .map(|f| {
            (
                f.derivation_type,
                f.state.as_str().to_string(),
                f.reason.clone(),
                f.source_version,
            )
        })
        .collect();
    forms.sort();
    assert_eq!(
        forms,
        vec![
            ("pre_detailed_assembly".into(), "pending".into(), None, 2),
            ("turn_rendering".into(), "pending".into(), None, 1),
        ]
    );
    let detail = live_detail(&file_path);
    assert_eq!(detail.len(), 1);
    assert_eq!(detail[0].work_item_id, "w-t1-turn_derivation-v1");
    assert_eq!(detail[0].status, QueueLiveStatus::Claimed);
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn an_extra_handler_write_target_fails_closed_before_any_completion_write_lands() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(&double, None);
    let dispatcher: DurableWorkDispatcher = Arc::new(|run, item| {
        Box::pin(async move {
            let db = match (run.open_db)() {
                OpResult::Ok { value } => value,
                OpResult::Err { error } => panic!("open_db failed: {}", error.reason),
            };
            let derived_at = system_time_to_iso((run.clock)());
            let disposition = apply_derivation_success(
                &db,
                &DerivationAttempt {
                    source_version: item.source_version,
                    derivations: item.derivations.clone(),
                    work_item_id: Some(item.work_item_id.clone()),
                },
                &[
                    HandlerDerivationWrite {
                        subject_kind: SubjectKind::Message,
                        subject_id: "m1".to_string(),
                        derivation_type: "smoothed_prompt".into(),
                        content: "expected write".into(),
                        metadata: None,
                        gaps: None,
                    },
                    HandlerDerivationWrite {
                        subject_kind: SubjectKind::Message,
                        subject_id: "m1".to_string(),
                        derivation_type: "tool_result_summary".into(),
                        content: "extra write".into(),
                        metadata: None,
                        gaps: None,
                    },
                ],
                &derived_at,
                None,
            );
            DurableWorkDispatchResult::Settled {
                disposition: map_success_disposition(disposition),
            }
        })
    });
    let mut map = std::collections::HashMap::new();
    map.insert(DurableWorkOperationName::MessagesDerive, dispatcher);
    register_testing_work(
        &sdk,
        TestingWorkRegistration {
            handlers: None,
            dispatchers: Some(map),
        },
    );
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;

    let failed = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(!failed.is_ok());
    if let OpResult::Err { error } = failed {
        assert_eq!(error.error_class, ErrorClass::StateCorruption);
        assert_eq!(error.code, ErrorCode::DerivationCompletionMismatch);
        assert!(error.reason.contains("derivation_completion_mismatch"));
    }
    let forms = read_derived_forms(&file_path);
    assert_eq!(forms.len(), 1);
    assert_eq!(forms[0].subject_id, "m1");
    assert_eq!(forms[0].derivation_type, "smoothed_prompt");
    assert_eq!(forms[0].state, DerivationState::Pending);
    let detail = live_detail(&file_path);
    assert_eq!(detail.len(), 1);
    assert_eq!(detail[0].work_item_id, "w-m1-prompt_smoothing-v1");
    assert_eq!(detail[0].status, QueueLiveStatus::Claimed);
    cleanup_seams();
    store.cleanup();
}

// ── sync derive collision policy ────────────────────────────────────────────

#[tokio::test]
async fn messages_derive_is_a_bounded_inline_attempt_and_does_not_consume_queued_work() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(&double, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;
    let message_ids_m1 = ["m1".to_string()];

    let result = sdk
        .messages
        .derive(ThreadRef::file_path(&file_path), &message_ids_m1)
        .await;

    assert!(result.is_ok());
    if let OpResult::Ok { value } = result {
        assert_eq!(value.len(), 1);
        match &value[0] {
            MessageDeriveResult::Failed { message_id, error } => {
                assert_eq!(message_id, "m1");
                assert_eq!(error.error_class, ErrorClass::CallerError);
                assert_eq!(error.code, ErrorCode::DerivationWorkInFlight);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    let detail = live_detail(&file_path);
    assert_eq!(detail.len(), 1);
    assert_eq!(detail[0].work_item_id, "w-m1-prompt_smoothing-v1");
    assert_eq!(detail[0].status, QueueLiveStatus::Queued);
    let forms = read_derived_forms(&file_path);
    assert_eq!(forms.len(), 1);
    assert_eq!(forms[0].state, DerivationState::Pending);
    assert_eq!(forms[0].source_version, 1);
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn messages_derive_attempts_once_and_leaves_no_queued_work_on_failure() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    double.fail_kind("prompt_smoothing", 1, Some("timeout: inline attempt"));
    let sdk = manual_sdk(&double, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    let message_ids_m1 = ["m1".to_string()];

    let result = sdk
        .messages
        .derive(ThreadRef::file_path(&file_path), &message_ids_m1)
        .await;

    assert!(result.is_ok());
    if let OpResult::Ok { value } = result {
        assert_eq!(value.len(), 1);
        match &value[0] {
            MessageDeriveResult::Failed { message_id, error } => {
                assert_eq!(message_id, "m1");
                assert_eq!(error.error_class, ErrorClass::SystemError);
                assert_eq!(error.code, ErrorCode::ProviderFailure);
                assert_eq!(error.reason, "timeout: inline attempt");
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert!(live_detail(&file_path).is_empty());
    let forms = read_derived_forms(&file_path);
    assert_eq!(forms.len(), 1);
    assert_eq!(forms[0].state, DerivationState::Pending);
    assert_eq!(forms[0].source_version, 1);
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn messages_derive_writes_ready_when_no_live_work_owns_the_derivation() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(&double, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    let message_ids_m1 = ["m1".to_string()];

    let result = sdk
        .messages
        .derive(ThreadRef::file_path(&file_path), &message_ids_m1)
        .await;

    assert!(result.is_ok());
    if let OpResult::Ok { value } = result {
        assert_eq!(value.len(), 1);
        match &value[0] {
            MessageDeriveResult::Derived {
                message_id,
                derivation_type,
                source_version,
            } => {
                assert_eq!(message_id, "m1");
                assert_eq!(
                    *derivation_type,
                    MessageDeriveDerivationType::SmoothedPrompt
                );
                assert_eq!(*source_version, 1);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(
        read_derived_forms(&file_path)[0].state,
        DerivationState::Ready
    );
    assert_eq!(live_count(&file_path), 0);
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn messages_derive_accepts_same_version_ready_races_without_overwriting_them() {
    let store = temp_store();
    let file_path_box: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let base = create_inference_callbacks_double();
    let path_for_cb = Arc::clone(&file_path_box);
    let smooth: SharedSmooth = Arc::new(move |_i| {
        let path = path_for_cb.lock().expect("path").clone();
        Box::pin(async move {
            set_ready_derivation(
                &path,
                "message",
                "m1",
                "smoothed_prompt",
                "competing ready value",
                1,
            );
            InferenceResult::Ok {
                text: "late inline value".into(),
                provenance: None,
                request_messages: None,
                raw_response: None,
            }
        })
    });
    let callbacks = callbacks_with_smooth(&base, Arc::clone(&smooth));
    let for_handlers = callbacks.clone();
    assert_shared_callback_identity(&callbacks, &for_handlers);
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(callbacks),
        inference: None,
        mode: SdkMode::Manual,
        clock: Some(Arc::new(SystemTime::now)),
        guards: Some(DerivationGuards {
            smoothed_prompt: None,
            tool_result_summary: None,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: Some(1),
            }),
        }),
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
        view: None,
    });
    register_test_work_handlers(&sdk, for_handlers, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    *file_path_box.lock().expect("path") = file_path.clone();
    send(
        &sdk,
        &file_path,
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    let message_ids_m1 = ["m1".to_string()];

    let result = sdk
        .messages
        .derive(ThreadRef::file_path(&file_path), &message_ids_m1)
        .await;

    assert!(result.is_ok());
    if let OpResult::Ok { value } = result {
        assert_eq!(value.len(), 1);
        match &value[0] {
            MessageDeriveResult::Derived {
                message_id,
                derivation_type,
                source_version,
            } => {
                assert_eq!(message_id, "m1");
                assert_eq!(
                    *derivation_type,
                    MessageDeriveDerivationType::SmoothedPrompt
                );
                assert_eq!(*source_version, 1);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    let form = &read_derived_forms(&file_path)[0];
    assert_eq!(form.state, DerivationState::Ready);
    assert_eq!(form.content.as_deref(), Some("competing ready value"));
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn messages_derive_refuses_when_the_derivation_advances_after_its_initial_read() {
    let store = temp_store();
    let file_path_box: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let base = create_inference_callbacks_double();
    let path_for_cb = Arc::clone(&file_path_box);
    let smooth: SharedSmooth = Arc::new(move |_i| {
        let path = path_for_cb.lock().expect("path").clone();
        Box::pin(async move {
            set_ready_derivation(
                &path,
                "message",
                "m1",
                "smoothed_prompt",
                "newer completion",
                2,
            );
            InferenceResult::Ok {
                text: "stale inline completion".into(),
                provenance: None,
                request_messages: None,
                raw_response: None,
            }
        })
    });
    let callbacks = callbacks_with_smooth(&base, Arc::clone(&smooth));
    let for_handlers = callbacks.clone();
    assert_shared_callback_identity(&callbacks, &for_handlers);
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(callbacks),
        inference: None,
        mode: SdkMode::Manual,
        clock: Some(Arc::new(SystemTime::now)),
        guards: Some(DerivationGuards {
            smoothed_prompt: None,
            tool_result_summary: None,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: Some(1),
            }),
        }),
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
        view: None,
    });
    register_test_work_handlers(&sdk, for_handlers, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    *file_path_box.lock().expect("path") = file_path.clone();
    send(
        &sdk,
        &file_path,
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    let message_ids_m1 = ["m1".to_string()];

    let raced = sdk
        .messages
        .derive(ThreadRef::file_path(&file_path), &message_ids_m1)
        .await;

    assert!(raced.is_ok());
    if let OpResult::Ok { value } = raced {
        assert_eq!(value.len(), 1);
        match &value[0] {
            MessageDeriveResult::Failed { message_id, error } => {
                assert_eq!(message_id, "m1");
                assert_eq!(error.error_class, ErrorClass::CallerError);
                assert_eq!(error.code, ErrorCode::DerivationWorkInFlight);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    let forms = read_derived_forms(&file_path);
    assert_eq!(forms.len(), 1);
    assert_eq!(forms[0].subject_id, "m1");
    assert_eq!(forms[0].derivation_type, "smoothed_prompt");
    assert_eq!(forms[0].state, DerivationState::Ready);
    assert_eq!(forms[0].content.as_deref(), Some("newer completion"));
    assert_eq!(forms[0].source_version, 2);
    assert!(
        live_detail(&file_path)
            .into_iter()
            .map(|i| i.work_item_id)
            .collect::<Vec<_>>()
            .is_empty()
    );
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn turns_derive_turn_refuses_an_abandoned_later_turn_while_older_turn_derivation_work_is_queued()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(&double, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "first prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "first answer".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event_for_kind(EventKind::TurnEnd),
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "second prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "second answer".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    let db = open_raw(&file_path);
    db.prepare("DELETE FROM work_item WHERE kind = 'prompt_smoothing'")
        .run(&[]);
    db.close();
    delete_work_item(&file_path, "w-t2-turn_derivation-v1");

    let refused = sdk
        .turns
        .derive_turn(ThreadRef::file_path(&file_path), "t2")
        .await;

    assert!(refused.is_ok());
    if let OpResult::Ok { value } = refused {
        match value {
            TurnDeriveResult::Failed { turn_id, error } => {
                assert_eq!(turn_id, "t2");
                assert_eq!(error.error_class, ErrorClass::CallerError);
                assert_eq!(error.code, ErrorCode::DerivationWorkInFlight);
            }
            other => panic!("expected failed, got {other:?}"),
        }
    }
    let detail = live_detail(&file_path);
    assert_eq!(detail.len(), 2);
    assert_eq!(detail[0].work_item_id, "w-t1-turn_derivation-v1");
    assert_eq!(detail[0].status, QueueLiveStatus::Queued);
    assert_eq!(detail[1].work_item_id, "w-t2-turn_derivation-v1");
    assert_eq!(detail[1].status, QueueLiveStatus::Queued);
    let mut t2: Vec<_> = read_derived_forms(&file_path)
        .into_iter()
        .filter(|f| f.subject_id == "t2")
        .map(|f| {
            (
                f.derivation_type,
                f.state.as_str().to_string(),
                f.source_version,
            )
        })
        .collect();
    t2.sort();
    assert_eq!(
        t2,
        vec![
            ("pre_detailed_assembly".into(), "pending".into(), 1),
            ("turn_rendering".into(), "pending".into(), 1),
        ]
    );
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn turns_derive_turn_refuses_an_exact_head_when_one_of_its_two_derivations_advances_before_claim()
 {
    let store = temp_store();
    let advance_on_clock = Arc::new(AtomicBool::new(false));
    let file_path_box: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let advance = Arc::clone(&advance_on_clock);
    let path_for_clock = Arc::clone(&file_path_box);
    let sdk = manual_sdk(
        &double,
        Some(Arc::new(move || {
            if advance.swap(false, Ordering::SeqCst) {
                let path = path_for_clock.lock().expect("path").clone();
                set_ready_derivation(
                    &path,
                    "turn",
                    "t1",
                    "pre_detailed_assembly",
                    "newer assembly",
                    2,
                );
            }
            UNIX_EPOCH + Duration::from_millis(FIXED_INSTANT_MS)
        })),
    );
    let (_thread_id, file_path) = new_thread(&store).await;
    *file_path_box.lock().expect("path") = file_path.clone();
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "turn boundary".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "answer".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");

    advance_on_clock.store(true, Ordering::SeqCst);
    let raced = sdk
        .turns
        .derive_turn(ThreadRef::file_path(&file_path), "t1")
        .await;

    assert!(raced.is_ok());
    if let OpResult::Ok { value } = raced {
        match value {
            TurnDeriveResult::Failed { turn_id, error } => {
                assert_eq!(turn_id, "t1");
                assert_eq!(error.error_class, ErrorClass::CallerError);
                assert_eq!(error.code, ErrorCode::DerivationWorkInFlight);
            }
            other => panic!("expected failed, got {other:?}"),
        }
    }
    assert_eq!(captured.len(), 0);
    let detail = live_detail(&file_path);
    assert_eq!(detail.len(), 1);
    assert_eq!(detail[0].work_item_id, "w-t1-turn_derivation-v1");
    assert_eq!(detail[0].status, QueueLiveStatus::Queued);
    let mut t1: Vec<_> = read_derived_forms(&file_path)
        .into_iter()
        .filter(|f| f.subject_id == "t1")
        .map(|f| {
            (
                f.derivation_type,
                f.state.as_str().to_string(),
                f.content.clone(),
                f.source_version,
            )
        })
        .collect();
    t1.sort();
    assert_eq!(
        t1,
        vec![
            (
                "pre_detailed_assembly".into(),
                "ready".into(),
                Some("newer assembly".into()),
                2
            ),
            ("turn_rendering".into(), "pending".into(), None, 1),
        ]
    );
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn two_concurrent_messages_derive_calls_are_inline_attempts_fenced_by_the_derivation_row() {
    let store = temp_store();
    let base = create_inference_callbacks_double();
    let smooth_txs: Arc<Mutex<Vec<oneshot::Sender<InferenceResult>>>> =
        Arc::new(Mutex::new(Vec::new()));
    let smooth_txs_cb = Arc::clone(&smooth_txs);
    let smooth: SharedSmooth = Arc::new(move |_i| {
        let (tx, rx) = oneshot::channel();
        smooth_txs_cb.lock().expect("smooth").push(tx);
        Box::pin(async move { rx.await.expect("smooth resolve") })
    });
    let callbacks = callbacks_with_smooth(&base, Arc::clone(&smooth));
    let for_handlers = callbacks.clone();
    assert_shared_callback_identity(&callbacks, &for_handlers);
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(callbacks),
        inference: None,
        mode: SdkMode::Manual,
        clock: Some(Arc::new(SystemTime::now)),
        guards: Some(DerivationGuards {
            smoothed_prompt: None,
            tool_result_summary: None,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: Some(1),
            }),
        }),
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
        view: None,
    });
    register_test_work_handlers(&sdk, for_handlers, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "claim me".into(),
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");

    let ids = ["m1".to_string()];
    let first_fut = sdk.messages.derive(ThreadRef::file_path(&file_path), &ids);
    tokio::pin!(first_fut);
    let start = std::time::Instant::now();
    while smooth_txs.lock().expect("smooth").len() != 1 {
        if start.elapsed().as_millis() > 3000 {
            panic!("timed out waiting for first inline message derive attempt");
        }
        tokio::select! {
            _ = &mut first_fut => panic!("first derive finished early"),
            _ = sleep_ms(5) => {}
        }
    }
    let second_fut = sdk.messages.derive(ThreadRef::file_path(&file_path), &ids);
    tokio::pin!(second_fut);
    while smooth_txs.lock().expect("smooth").len() != 2 {
        if start.elapsed().as_millis() > 3000 {
            panic!("timed out waiting for second inline message derive attempt");
        }
        tokio::select! {
            _ = &mut first_fut => {}
            _ = &mut second_fut => {}
            _ = sleep_ms(5) => {}
        }
    }
    {
        let mut txs = smooth_txs.lock().expect("smooth");
        let _ = txs.remove(0).send(InferenceResult::Ok {
            text: "first inline completion".into(),
            provenance: None,
            request_messages: None,
            raw_response: None,
        });
    }
    let first_result = first_fut.await;
    {
        let mut txs = smooth_txs.lock().expect("smooth");
        let _ = txs.remove(0).send(InferenceResult::Ok {
            text: "second inline completion".into(),
            provenance: None,
            request_messages: None,
            raw_response: None,
        });
    }
    let second_result = second_fut.await;

    assert!(first_result.is_ok());
    assert!(second_result.is_ok());
    if let (OpResult::Ok { value: first }, OpResult::Ok { value: second }) =
        (first_result, second_result)
    {
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        match &first[0] {
            MessageDeriveResult::Derived {
                message_id,
                derivation_type,
                source_version,
            } => {
                assert_eq!(message_id, "m1");
                assert_eq!(
                    *derivation_type,
                    MessageDeriveDerivationType::SmoothedPrompt
                );
                assert_eq!(*source_version, 1);
            }
            other => panic!("unexpected first {other:?}"),
        }
        match &second[0] {
            MessageDeriveResult::Derived {
                message_id,
                derivation_type,
                source_version,
            } => {
                assert_eq!(message_id, "m1");
                assert_eq!(
                    *derivation_type,
                    MessageDeriveDerivationType::SmoothedPrompt
                );
                assert_eq!(*source_version, 1);
            }
            other => panic!("unexpected second {other:?}"),
        }
    }
    let forms = read_derived_forms(&file_path);
    assert_eq!(forms.len(), 1);
    assert_eq!(forms[0].subject_id, "m1");
    assert_eq!(forms[0].derivation_type, "smoothed_prompt");
    assert_eq!(forms[0].state, DerivationState::Ready);
    assert_eq!(forms[0].content.as_deref(), Some("first inline completion"));
    assert_eq!(live_count(&file_path), 0);
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn two_concurrent_turns_derive_turn_calls_share_the_durable_claim() {
    let store = temp_store();
    let base = create_inference_callbacks_double();
    let compression_txs: Arc<Mutex<Vec<oneshot::Sender<InferenceResult>>>> =
        Arc::new(Mutex::new(Vec::new()));
    let compression_cb = Arc::clone(&compression_txs);
    let compress: SharedCompress = Arc::new(move |_i| {
        let (tx, rx) = oneshot::channel();
        compression_cb.lock().expect("compression").push(tx);
        Box::pin(async move { rx.await.expect("compression resolve") })
    });
    let callbacks = callbacks_with_compress(&base, Arc::clone(&compress));
    let for_handlers = callbacks.clone();
    assert_shared_callback_identity(&callbacks, &for_handlers);
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(callbacks),
        inference: None,
        mode: SdkMode::Manual,
        clock: Some(Arc::new(SystemTime::now)),
        guards: Some(DerivationGuards {
            smoothed_prompt: None,
            tool_result_summary: None,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: Some(1),
            }),
        }),
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
        view: None,
    });
    register_test_work_handlers(&sdk, for_handlers, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "turn claim".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "answer".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    drain(&sdk, &file_path, Some(2)).await;
    delete_work_item(&file_path, "w-t1-detailed_turn_compression-v1");

    let first_fut = sdk
        .turns
        .derive_turn(ThreadRef::file_path(&file_path), "t1");
    tokio::pin!(first_fut);
    let start = std::time::Instant::now();
    while compression_txs.lock().expect("compression").len() != 1 {
        if start.elapsed().as_millis() > 3000 {
            panic!("timed out waiting for first sync turn derive claim");
        }
        tokio::select! {
            _ = &mut first_fut => panic!("first derive finished early"),
            _ = sleep_ms(5) => {}
        }
    }
    let second = sdk
        .turns
        .derive_turn(ThreadRef::file_path(&file_path), "t1")
        .await;
    {
        let mut txs = compression_txs.lock().expect("compression");
        let _ = txs.remove(0).send(InferenceResult::Ok {
            text: "owned turn compression".into(),
            provenance: None,
            request_messages: None,
            raw_response: None,
        });
    }
    let owned = first_fut.await;

    assert!(second.is_ok());
    assert!(owned.is_ok());
    if let (OpResult::Ok { value: second }, OpResult::Ok { value: owned }) = (second, owned) {
        match &second {
            TurnDeriveResult::Failed { turn_id, error } => {
                assert_eq!(turn_id, "t1");
                assert_eq!(error.error_class, ErrorClass::CallerError);
                assert_eq!(error.code, ErrorCode::DerivationWorkInFlight);
            }
            other => panic!("expected second failed, got {other:?}"),
        }
        match &owned {
            TurnDeriveResult::Derived {
                turn_id,
                source_version,
            } => {
                assert_eq!(turn_id, "t1");
                assert_eq!(*source_version, 2);
            }
            other => panic!("unexpected owned {other:?}"),
        }
    }
    let turn_forms: Vec<_> = read_derived_forms(&file_path)
        .into_iter()
        .filter(|f| f.subject_id == "t1")
        .collect();
    let compression = turn_forms
        .iter()
        .find(|f| f.derivation_type == "detailed_turn_compression")
        .expect("compression");
    assert_eq!(compression.state, DerivationState::Ready);
    assert_eq!(
        compression.content.as_deref(),
        Some("owned turn compression")
    );
    assert!(
        live_detail(&file_path)
            .into_iter()
            .filter(|item| item.work_item_id == "w-t1-turn_derivation-v1")
            .collect::<Vec<_>>()
            .is_empty()
    );
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn two_concurrent_turns_derive_brief_chunk_calls_share_the_durable_claim() {
    let store = temp_store();
    let base = create_inference_callbacks_double();
    let brief_txs: Arc<Mutex<Vec<oneshot::Sender<InferenceResult>>>> =
        Arc::new(Mutex::new(Vec::new()));
    let brief_cb = Arc::clone(&brief_txs);
    let brief: SharedBrief = Arc::new(move |_i| {
        let (tx, rx) = oneshot::channel();
        brief_cb.lock().expect("brief").push(tx);
        Box::pin(async move { rx.await.expect("brief resolve") })
    });
    let callbacks = callbacks_with_brief(&base, Arc::clone(&brief));
    let for_handlers = callbacks.clone();
    assert_shared_callback_identity(&callbacks, &for_handlers);
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(callbacks),
        inference: None,
        mode: SdkMode::Manual,
        clock: Some(Arc::new(SystemTime::now)),
        guards: Some(DerivationGuards {
            smoothed_prompt: None,
            tool_result_summary: None,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: Some(1),
            }),
        }),
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
        view: None,
    });
    register_test_work_handlers(&sdk, for_handlers, None);
    let (_thread_id, file_path) = new_thread(&store).await;
    insert_abandoned_chunk_summary(&file_path, "c1", "chunk_summary_brief");
    let db = open_raw(&file_path);
    db.prepare(
        "INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, content, source_version)
         VALUES ('chunk', 'c1', 'chunk_summary_detailed', 'ready', 'owned detailed input', 1)",
    )
    .run(&[]);
    db.close();

    let first_fut = sdk
        .turns
        .derive_brief_chunk(ThreadRef::file_path(&file_path), "c1");
    tokio::pin!(first_fut);
    let start = std::time::Instant::now();
    while brief_txs.lock().expect("brief").len() != 1 {
        if start.elapsed().as_millis() > 3000 {
            panic!("timed out waiting for first sync chunk derive claim");
        }
        tokio::select! {
            _ = &mut first_fut => panic!("first derive finished early"),
            _ = sleep_ms(5) => {}
        }
    }
    let second = sdk
        .turns
        .derive_brief_chunk(ThreadRef::file_path(&file_path), "c1")
        .await;
    {
        let mut txs = brief_txs.lock().expect("brief");
        let _ = txs.remove(0).send(InferenceResult::Ok {
            text: "owned chunk brief".into(),
            provenance: None,
            request_messages: None,
            raw_response: None,
        });
    }
    let owned = first_fut.await;

    assert!(second.is_ok());
    assert!(owned.is_ok());
    if let (OpResult::Ok { value: second }, OpResult::Ok { value: owned }) = (second, owned) {
        match &second {
            ChunkDeriveResult::Failed { chunk_id, error } => {
                assert_eq!(chunk_id, "c1");
                assert_eq!(error.error_class, ErrorClass::CallerError);
                assert_eq!(error.code, ErrorCode::DerivationWorkInFlight);
            }
            other => panic!("expected second failed, got {other:?}"),
        }
        match &owned {
            ChunkDeriveResult::Derived {
                chunk_id,
                derivation_type,
                source_version,
            } => {
                assert_eq!(chunk_id, "c1");
                assert_eq!(
                    *derivation_type,
                    ChunkDeriveDerivationType::ChunkSummaryBrief
                );
                assert_eq!(*source_version, 1);
            }
            other => panic!("unexpected owned {other:?}"),
        }
    }
    let briefs: Vec<_> = read_derived_forms(&file_path)
        .into_iter()
        .filter(|f| f.derivation_type == "chunk_summary_brief")
        .collect();
    assert_eq!(briefs.len(), 1);
    assert_eq!(briefs[0].subject_kind, SubjectKind::Chunk);
    assert_eq!(briefs[0].subject_id, "c1");
    assert_eq!(briefs[0].state, DerivationState::Ready);
    assert_eq!(briefs[0].content.as_deref(), Some("owned chunk brief"));
    assert_eq!(live_count(&file_path), 0);
    cleanup_seams();
    store.cleanup();
}
