//! Ported from packages/lhc/test/chunk-compact-recovery.test.ts. Phase 1.

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, TempStore, UserPromptOverrides,
    UserPromptPayload, create_inference_callbacks_double, kind, open_raw, read_derived_forms,
    temp_store, valid_event,
};
use lhc::sdk::DrainOpts;
use lhc::shared_tech::derivation::{
    ChunkPolicyConfig, Derivation, DerivationState, InferenceCallbacks, LeaseConfig, SdkConfig,
    SdkMode,
};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::logging::LogQuery;
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::view::{
    Band, CompactWarning, CompactWarningDerivationType, PartialViewProfilePercentages,
    SkippedRecord, ViewCompactParams,
};
use lhc::shared_tech::work_queue::queue_detail;
use lhc::thread_view::{CompactAbortSignal, CompactOpts};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc, threads};
use serde_json::json;

async fn new_thread(store: &TempStore) -> String {
    match threads::new_thread(NewThreadInput {
        file_path: store.thread_path(None).to_string_lossy().into_owned(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await
    {
        OpResult::Ok { value } => value.file_path,
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

/// Phase 1 narrowing of TS `Partial<SdkConfig>` — this suite's call sites never
/// pass overrides (defaults only: manual mode, lease, default chunkPolicy).
struct SdkForOverrides;

fn sdk_for(inference_callbacks: InferenceCallbacks, _overrides: SdkForOverrides) -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(inference_callbacks),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: Some(ChunkPolicyConfig {
            target_projected_tokens: 1,
            max_projected_tokens: 999999,
        }),
        view: None,
    })
}

async fn send(sdk: &Lhc, file_path: &str, batch: &[lhc::intake_stream::MessageEventInput]) {
    let result = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(file_path), batch)
        .await;
    if !result.is_ok() {
        let OpResult::Err { error } = result else {
            unreachable!()
        };
        panic!("{}", error.reason);
    }
}

async fn drain(sdk: &Lhc, file_path: &str, opts: Option<DrainOpts>) {
    match sdk.work.drain(ThreadRef::file_path(file_path), opts).await {
        OpResult::Ok { .. } => {}
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

fn exec_sql(file_path: &str, sql: &str, params: &[SqlParam]) {
    let db = open_raw(file_path);
    db.prepare(sql).run(params);
    db.close();
}

fn exec_corrupt_sql(file_path: &str, sql: &str, params: &[SqlParam]) {
    let db = open_raw(file_path);
    db.exec("PRAGMA foreign_keys = OFF;");
    db.prepare(sql).run(params);
    db.close();
}

fn form_of(file_path: &str, subject_id: &str, derivation_type: &str) -> Option<Derivation> {
    read_derived_forms(file_path)
        .into_iter()
        .find(|f| f.subject_id == subject_id && f.derivation_type == derivation_type)
}

fn live_queue(file_path: &str) -> Vec<lhc::shared_tech::work_queue::QueueDetailRow> {
    let db = open_raw(file_path);
    let rows = queue_detail(&db);
    db.close();
    rows
}

fn set_chunk_summary_state(
    file_path: &str,
    chunk_id: &str,
    derivation_type: &str,
    state: DerivationState,
    content: Option<&str>,
    reason: Option<&str>,
) {
    exec_sql(
        file_path,
        concat!(
            "UPDATE derivation SET state = ?, content = ?, reason = ? \n",
            "     WHERE subject_kind = 'chunk' AND subject_id = ? AND derivation_type = ?"
        ),
        &[
            SqlParam::from(state.as_str()),
            SqlParam::from(content),
            SqlParam::from(reason),
            SqlParam::from(chunk_id),
            SqlParam::from(derivation_type),
        ],
    );
}

fn delete_work_for(file_path: &str, kind: &str, chunk_id: &str) {
    exec_sql(
        file_path,
        "DELETE FROM work_item WHERE kind = ? AND json_extract(source_ref, '$.chunkId') = ?",
        &[SqlParam::from(kind), SqlParam::from(chunk_id)],
    );
}

fn enqueue_chunk_summary_work(
    file_path: &str,
    work_item_id: &str,
    chunk_id: &str,
    derivation_type: &str,
) {
    exec_sql(
        file_path,
        "INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
     VALUES (?, 'turns', ?, ?, 'queued', '2026-06-15T00:00:00.000Z', ?)",
        &[
            SqlParam::from(work_item_id),
            SqlParam::from(derivation_type),
            SqlParam::Text(js_json_stringify(&json!({ "chunkId": chunk_id }))),
            SqlParam::Text(js_json_stringify(&json!({
                "sourceVersion": 1,
                "derivations": [{
                    "subjectKind": "chunk",
                    "subjectId": chunk_id,
                    "derivationType": derivation_type
                }]
            }))),
        ],
    );
}

async fn seed_four_closed_turns(sdk: &Lhc, file_path: &str) {
    for i in 1..=4 {
        send(
            sdk,
            file_path,
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: format!("prompt {i}"),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new(format!("answer {i}"))),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, Default::default()),
            ],
        )
        .await;
    }
    drain(sdk, file_path, None).await;
}

fn compact_params() -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(120.0),
        percentages: Some(PartialViewProfilePercentages {
            full: Some(10.0),
            smooth: Some(10.0),
            detailed: Some(70.0),
            brief: Some(10.0),
        }),
    }
}

#[tokio::test]
async fn queues_detailed_and_brief_chunk_summaries_as_independent_work_items_and_states() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    double.fail_kind(
        "chunk_summary_brief",
        1,
        Some("timeout: scripted brief failure"),
    );
    let sdk = sdk_for(double.to_callbacks(), SdkForOverrides);
    let file_path = new_thread(&store).await;

    seed_four_closed_turns(&sdk, &file_path).await;

    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_detailed")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
    let brief = form_of(&file_path, "c1", "chunk_summary_brief").expect("brief");
    assert_eq!(brief.state, DerivationState::Failed);
    assert_eq!(
        brief.reason.as_deref(),
        Some("timeout: scripted brief failure")
    );
}

#[tokio::test]
async fn compacts_not_ready_chunk_summaries_through_stored_member_concat_with_zero_model_calls() {
    let store = temp_store();
    let sdk = sdk_for(
        create_inference_callbacks_double().to_callbacks(),
        SdkForOverrides,
    );
    let file_path = new_thread(&store).await;
    seed_four_closed_turns(&sdk, &file_path).await;
    set_chunk_summary_state(
        &file_path,
        "c1",
        "chunk_summary_detailed",
        DerivationState::Failed,
        None,
        Some("timeout: old summary failed"),
    );
    delete_work_for(&file_path, "chunk_summary_detailed", "c1");

    let spy = create_inference_callbacks_double();
    let captured = spy.capture_inputs();
    let compact_sdk = sdk_for(spy.to_callbacks(), SdkForOverrides);
    let compacted = compact_sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&file_path),
            CompactOpts {
                profile: None,
                params: Some(compact_params()),
                signal: None,
                compact_point_upper_bound: None,
            },
        )
        .await;

    assert!(compacted.is_ok());
    let OpResult::Ok { value } = compacted else {
        return;
    };
    assert!(captured.snapshot().is_empty());
    let warnings = value.warnings.as_ref().expect("warnings");
    assert!(warnings.contains(&CompactWarning {
        band: Band::Detailed,
        subject_id: "c1".into(),
        derivation_type: CompactWarningDerivationType::ChunkSummaryDetailed,
        reason: "failed_floor: timeout: old summary failed".into(),
    }));
    let context_read = compact_sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(context_read.is_ok());
    let OpResult::Ok { value: context } = context_read else {
        return;
    };
    let detailed = context
        .messages
        .iter()
        .find(|message| {
            message
                .content
                .iter()
                .any(|part| part.text.starts_with("[context · detailed]"))
        })
        .expect("detailed context message present");
    let detailed_text: String = detailed.content.iter().map(|p| p.text.as_str()).collect();
    assert!(detailed_text.contains("[degraded: detailed-from-stored-members]"));
    assert!(detailed_text.contains("prompt 1\nanswer 1"));
    assert!(!detailed_text.contains("unavailable"));

    let logs = compact_sdk
        .logging
        .query(
            ThreadRef::file_path(&file_path),
            LogQuery {
                level: None,
                derivation_type: Some("chunk_summary_detailed".into()),
                subject_id: Some("c1".into()),
                reason: None,
            },
        )
        .await;
    assert!(logs.is_ok());
    let OpResult::Ok { value } = logs else {
        return;
    };
    assert_eq!(value[0].level, lhc::shared_tech::logging::LogLevel::Warning);
    assert_eq!(
        value[0].reason.as_deref(),
        Some("failed_floor: timeout: old summary failed")
    );
    assert_eq!(value[0].floor_used.as_deref(), Some("stored_member_concat"));
}

#[tokio::test]
async fn compacts_claim_expired_chunk_summary_detailed_through_degraded_fallback() {
    let store = temp_store();
    let sdk = sdk_for(
        create_inference_callbacks_double().to_callbacks(),
        SdkForOverrides,
    );
    let file_path = new_thread(&store).await;
    seed_four_closed_turns(&sdk, &file_path).await;
    set_chunk_summary_state(
        &file_path,
        "c1",
        "chunk_summary_detailed",
        DerivationState::Failed,
        None,
        Some("claim_expired"),
    );
    set_chunk_summary_state(
        &file_path,
        "c1",
        "chunk_summary_brief",
        DerivationState::Blocked,
        None,
        Some("source_damaged: chunk c1 chunk_summary_detailed is failed: claim_expired"),
    );
    delete_work_for(&file_path, "chunk_summary_detailed", "c1");
    delete_work_for(&file_path, "chunk_summary_brief", "c1");

    let compacted = sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&file_path),
            CompactOpts {
                profile: None,
                params: Some(compact_params()),
                signal: None,
                compact_point_upper_bound: None,
            },
        )
        .await;

    assert!(compacted.is_ok());
    let OpResult::Ok { value } = compacted else {
        return;
    };
    let warnings = value.warnings.as_ref().expect("warnings");
    assert!(warnings.contains(&CompactWarning {
        band: Band::Detailed,
        subject_id: "c1".into(),
        derivation_type: CompactWarningDerivationType::ChunkSummaryDetailed,
        reason: "failed_floor: claim_expired".into(),
    }));
    assert!(value.degraded.iter().any(|entry| {
        entry.band == Band::Detailed
            && entry.subject_id == "c1"
            && entry.used_derivation == "stored_member_concat"
    }));
    let context_read = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(context_read.is_ok());
    let OpResult::Ok { value: context } = context_read else {
        return;
    };
    let detailed = context
        .messages
        .iter()
        .find(|message| {
            message
                .content
                .iter()
                .any(|part| part.text.starts_with("[context · detailed]"))
        })
        .expect("detailed context message present");
    let detailed_text: String = detailed.content.iter().map(|p| p.text.as_str()).collect();
    assert!(detailed_text.contains("[degraded: detailed-from-stored-members]"));
    assert!(detailed_text.contains("prompt 1\nanswer 1"));
}

#[tokio::test]
async fn halts_compact_before_fallback_assembly_when_stop_is_requested() {
    let store = temp_store();
    let sdk = sdk_for(
        create_inference_callbacks_double().to_callbacks(),
        SdkForOverrides,
    );
    let file_path = new_thread(&store).await;
    seed_four_closed_turns(&sdk, &file_path).await;
    set_chunk_summary_state(
        &file_path,
        "c1",
        "chunk_summary_detailed",
        DerivationState::Pending,
        None,
        None,
    );
    delete_work_for(&file_path, "chunk_summary_detailed", "c1");

    let stopped = sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&file_path),
            CompactOpts {
                profile: None,
                params: Some(compact_params()),
                signal: Some({
                    let s = CompactAbortSignal::new();
                    s.abort();
                    s
                }),
                compact_point_upper_bound: None,
            },
        )
        .await;

    assert!(!stopped.is_ok());
    let OpResult::Err { error } = stopped else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::CompactStopped);
    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_detailed")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Pending)
    );
}

#[tokio::test]
async fn skips_and_reports_a_chunk_member_whose_turn_row_is_missing() {
    let store = temp_store();
    let sdk = sdk_for(
        create_inference_callbacks_double().to_callbacks(),
        SdkForOverrides,
    );
    let file_path = new_thread(&store).await;
    seed_four_closed_turns(&sdk, &file_path).await;
    set_chunk_summary_state(
        &file_path,
        "c1",
        "chunk_summary_detailed",
        DerivationState::Pending,
        None,
        None,
    );
    delete_work_for(&file_path, "chunk_summary_detailed", "c1");
    exec_corrupt_sql(&file_path, "DELETE FROM turns WHERE turn_id = 't1'", &[]);

    let compacted = sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&file_path),
            CompactOpts {
                profile: None,
                params: Some(compact_params()),
                signal: None,
                compact_point_upper_bound: None,
            },
        )
        .await;

    let OpResult::Ok { value: receipt } = compacted else {
        panic!("compact should skip the dangling member");
    };
    assert!(receipt.skipped_records.iter().any(|record| matches!(
        record,
        SkippedRecord::DanglingChunkMember { chunk_id, turn_id, .. }
            if chunk_id == "c1" && turn_id == "t1"
    )));
}

#[tokio::test]
async fn background_chunk_summary_work_requeues_on_not_ready_member_projection() {
    let store = temp_store();
    let sdk = sdk_for(
        create_inference_callbacks_double().to_callbacks(),
        SdkForOverrides,
    );
    let file_path = new_thread(&store).await;
    seed_four_closed_turns(&sdk, &file_path).await;
    set_chunk_summary_state(
        &file_path,
        "c1",
        "chunk_summary_detailed",
        DerivationState::Pending,
        None,
        None,
    );
    exec_sql(
        &file_path,
        "UPDATE derivation SET state = 'pending', content = NULL
       WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'detailed_turn_compression'",
        &[],
    );
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_detailed-v99",
        "c1",
        "chunk_summary_detailed",
    );

    drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(1) })).await;

    let detailed = form_of(&file_path, "c1", "chunk_summary_detailed").expect("detailed");
    assert_eq!(detailed.state, DerivationState::Failed);
    assert!(
        detailed
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("member_projection_not_ready")
    );
    assert!(
        live_queue(&file_path)
            .iter()
            .find(|r| r.work_item_id == "w-c1-chunk_summary_detailed-v99")
            .is_none()
    );
}

#[tokio::test]
async fn background_chunk_summaries_block_when_a_chunk_member_references_a_missing_turn() {
    let store = temp_store();
    let sdk = sdk_for(
        create_inference_callbacks_double().to_callbacks(),
        SdkForOverrides,
    );
    let file_path = new_thread(&store).await;
    seed_four_closed_turns(&sdk, &file_path).await;
    set_chunk_summary_state(
        &file_path,
        "c1",
        "chunk_summary_detailed",
        DerivationState::Pending,
        None,
        None,
    );
    set_chunk_summary_state(
        &file_path,
        "c1",
        "chunk_summary_brief",
        DerivationState::Pending,
        None,
        None,
    );
    exec_corrupt_sql(&file_path, "DELETE FROM turns WHERE turn_id = 't1'", &[]);
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_detailed-v98",
        "c1",
        "chunk_summary_detailed",
    );
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_brief-v98",
        "c1",
        "chunk_summary_brief",
    );

    drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(2) })).await;

    let detailed = form_of(&file_path, "c1", "chunk_summary_detailed").expect("detailed");
    assert_eq!(detailed.state, DerivationState::Blocked);
    assert!(
        detailed
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("source_damaged")
    );
    let brief = form_of(&file_path, "c1", "chunk_summary_brief").expect("brief");
    assert_eq!(brief.state, DerivationState::Blocked);
    assert!(
        brief
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("source_damaged")
    );
}
