//! Ported from packages/lhc/test/chunk-brief-from-detailed.test.ts. Phase 1.

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, DerivationType, FormStateTarget, FormStateUpdate,
    InferenceCallbackOpName, TempStore, UserPromptOverrides, UserPromptPayload,
    create_inference_callbacks_double, kind, open_raw, read_derived_forms, set_form_state,
    temp_store, valid_event,
};
use lhc::sdk::DrainOpts;
use lhc::shared_tech::derivation::{
    ChunkPolicyConfig, Derivation, DerivationState, InferenceCallbacks, LeaseConfig, SdkConfig,
    SdkMode, SubjectKind, SummarizeChunkBriefInput,
};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::inference_types::{DerivationGuards, DetailedTurnCompressionGuards};
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::scheduler::DrainReport;
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::shared_tech::work_queue::{QueueLiveStatus, queue_detail};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::turns::{ChunkDeriveDerivationType, ChunkDeriveResult};
use lhc::{Lhc, init_lhc, threads};

const SELF_CHUNK: ChunkPolicyConfig = ChunkPolicyConfig {
    target_projected_tokens: 1,
    max_projected_tokens: 1,
};

/// JS `Math.round` for non-negative values: `floor(x + 0.5)`.
fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

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

fn sdk_for(inference_callbacks: InferenceCallbacks) -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(inference_callbacks),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: Some(DerivationGuards {
            smoothed_prompt: None,
            tool_result_summary: None,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: Some(1),
            }),
        }),
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: Some(SELF_CHUNK),
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

async fn drain(sdk: &Lhc, file_path: &str, opts: Option<DrainOpts>) -> DrainReport {
    match sdk.work.drain(ThreadRef::file_path(file_path), opts).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

async fn send_prompt_turn(sdk: &Lhc, file_path: &str, prompt: &str, answer: &str) {
    send(
        sdk,
        file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: prompt.into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new(answer)),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
}

fn exec_sql(file_path: &str, sql: &str, params: &[SqlParam]) {
    let db = open_raw(file_path);
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
    derivation_type: DerivationType,
    state: DerivationState,
    content: Option<&str>,
    reason: Option<&str>,
) {
    set_form_state(
        file_path,
        &FormStateTarget {
            subject_kind: SubjectKind::Chunk,
            subject_id: chunk_id.into(),
            derivation_type,
        },
        &FormStateUpdate {
            state,
            content: content.map(str::to_string),
            reason: reason.map(str::to_string),
            metadata: None,
            derived_at: None,
        },
    );
}

fn enqueue_chunk_summary_work(
    file_path: &str,
    work_item_id: &str,
    chunk_id: &str,
    derivation_type: &str,
    source_version: i64,
) {
    exec_sql(
        file_path,
        "INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
     VALUES (?, 'turns', ?, ?, 'queued', '2026-06-22T00:00:00.000Z', ?)",
        &[
            SqlParam::from(work_item_id),
            SqlParam::from(derivation_type),
            SqlParam::Text(js_json_stringify(
                &serde_json::json!({ "chunkId": chunk_id }),
            )),
            SqlParam::Text(js_json_stringify(&serde_json::json!({
                "sourceVersion": source_version,
                "derivations": [{
                    "subjectKind": "chunk",
                    "subjectId": chunk_id,
                    "derivationType": derivation_type
                }]
            }))),
        ],
    );
}

async fn seed_closed_chunk(sdk: &Lhc, file_path: &str) {
    send_prompt_turn(sdk, file_path, "brief source prompt", "brief source answer").await;
    drain(sdk, file_path, None).await;
}

fn target_input_for(text: &str) -> SummarizeChunkBriefInput {
    let input_tokens = estimate_tokens(text);
    SummarizeChunkBriefInput {
        text: text.into(),
        input_tokens,
        target_min_tokens: 1.max(js_round(input_tokens as f64 * 0.08)),
        target_aim_tokens: 1.max(js_round(input_tokens as f64 * 0.12)),
        target_max_tokens: 1.max(js_round(input_tokens as f64 * 0.2)),
    }
}

#[tokio::test]
async fn sends_detailed_text_and_concrete_targets_to_the_model_then_records_size_disposition() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = sdk_for(double.to_callbacks());
    let file_path = new_thread(&store).await;
    seed_closed_chunk(&sdk, &file_path).await;
    let detailed_text = "seeded detailed text; not the member compression";
    let member_compression = form_of(&file_path, "t1", "detailed_turn_compression")
        .and_then(|f| f.content)
        .unwrap_or_default();
    assert_ne!(member_compression, detailed_text);

    set_chunk_summary_state(
        &file_path,
        "c1",
        DerivationType::ChunkSummaryDetailed,
        DerivationState::Ready,
        Some(detailed_text),
        None,
    );
    set_chunk_summary_state(
        &file_path,
        "c1",
        DerivationType::ChunkSummaryBrief,
        DerivationState::Pending,
        None,
        None,
    );

    let derived = sdk
        .turns
        .derive_brief_chunk(ThreadRef::file_path(&file_path), "c1")
        .await;

    assert!(derived.is_ok());
    let OpResult::Ok { value } = derived else {
        return;
    };
    match value {
        ChunkDeriveResult::Derived {
            chunk_id,
            derivation_type,
            ..
        } => {
            assert_eq!(chunk_id, "c1");
            assert_eq!(
                derivation_type,
                ChunkDeriveDerivationType::ChunkSummaryBrief
            );
        }
        ChunkDeriveResult::Failed { .. } => panic!("expected derived"),
    }
    let expected_input = target_input_for(detailed_text);
    let brief_input = captured
        .snapshot()
        .into_iter()
        .filter(|e| e.op == InferenceCallbackOpName::SummarizeChunkBrief)
        .map(|e| e.input)
        .next_back();
    assert_eq!(
        brief_input,
        Some(serde_json::to_value(&expected_input).unwrap())
    );
    assert!(!js_json_stringify(brief_input.as_ref().unwrap()).contains(&member_compression));
    let brief = form_of(&file_path, "c1", "chunk_summary_brief").expect("brief");
    assert_eq!(brief.state, DerivationState::Ready);
    assert!(
        brief
            .metadata
            .as_ref()
            .and_then(|m| m.size_disposition)
            .is_some()
    );
}

#[tokio::test]
async fn defers_behind_live_detailed_work_without_writing_detailed_directly() {
    let store = temp_store();
    let sdk = sdk_for(create_inference_callbacks_double().to_callbacks());
    let file_path = new_thread(&store).await;
    seed_closed_chunk(&sdk, &file_path).await;
    set_chunk_summary_state(
        &file_path,
        "c1",
        DerivationType::ChunkSummaryDetailed,
        DerivationState::Pending,
        None,
        None,
    );
    set_chunk_summary_state(
        &file_path,
        "c1",
        DerivationType::ChunkSummaryBrief,
        DerivationState::Pending,
        None,
        None,
    );
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_brief-v1",
        "c1",
        "chunk_summary_brief",
        1,
    );
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_detailed-v1",
        "c1",
        "chunk_summary_detailed",
        1,
    );

    drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(1) })).await;

    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_detailed")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Pending)
    );
    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_brief")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Pending)
    );
    let brief_row = live_queue(&file_path)
        .into_iter()
        .find(|r| r.work_item_id == "w-c1-chunk_summary_brief-v1");
    assert_eq!(
        brief_row.as_ref().map(|r| r.status),
        Some(QueueLiveStatus::Queued)
    );
    assert!(
        live_queue(&file_path)
            .iter()
            .any(|r| r.work_item_id == "w-c1-chunk_summary_detailed-v1")
    );
    assert_eq!(
        live_queue(&file_path)
            .iter()
            .filter(|r| r.kind == "chunk_summary_brief")
            .count(),
        1
    );

    drain(&sdk, &file_path, None).await;

    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_detailed")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_brief")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
}

#[tokio::test]
async fn schedules_detailed_work_before_requeued_brief_when_no_detailed_work_is_live() {
    let store = temp_store();
    let sdk = sdk_for(create_inference_callbacks_double().to_callbacks());
    let file_path = new_thread(&store).await;
    seed_closed_chunk(&sdk, &file_path).await;
    set_chunk_summary_state(
        &file_path,
        "c1",
        DerivationType::ChunkSummaryDetailed,
        DerivationState::Pending,
        None,
        None,
    );
    set_chunk_summary_state(
        &file_path,
        "c1",
        DerivationType::ChunkSummaryBrief,
        DerivationState::Pending,
        None,
        None,
    );
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_brief-v1",
        "c1",
        "chunk_summary_brief",
        1,
    );

    drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(1) })).await;

    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_detailed")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Pending)
    );
    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_brief")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Pending)
    );
    assert_eq!(
        live_queue(&file_path)
            .iter()
            .find(|r| r.work_item_id == "w-c1-chunk_summary_brief-v1")
            .map(|r| r.status),
        Some(QueueLiveStatus::Queued)
    );
    assert!(
        live_queue(&file_path)
            .iter()
            .any(|r| r.work_item_id == "w-c1-chunk_summary_detailed-v1")
    );
    assert_eq!(
        live_queue(&file_path)
            .iter()
            .filter(|r| r.kind == "chunk_summary_brief")
            .count(),
        1
    );

    drain(&sdk, &file_path, None).await;

    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_detailed")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_brief")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
}

#[tokio::test]
async fn uses_the_current_brief_source_version_when_the_detailed_row_is_missing() {
    let store = temp_store();
    let sdk = sdk_for(create_inference_callbacks_double().to_callbacks());
    let file_path = new_thread(&store).await;
    seed_closed_chunk(&sdk, &file_path).await;
    exec_sql(
        &file_path,
        "DELETE FROM derivation
       WHERE subject_kind = 'chunk' AND subject_id = 'c1' AND derivation_type = 'chunk_summary_detailed'",
        &[],
    );
    exec_sql(
        &file_path,
        "UPDATE derivation SET state = 'pending', content = NULL, reason = NULL, metadata = NULL, source_version = 3
       WHERE subject_kind = 'chunk' AND subject_id = 'c1' AND derivation_type = 'chunk_summary_brief'",
        &[],
    );
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_brief-v3",
        "c1",
        "chunk_summary_brief",
        3,
    );

    drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(1) })).await;

    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_detailed")
            .as_ref()
            .map(|f| f.source_version),
        Some(3)
    );
    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_brief")
            .as_ref()
            .map(|f| f.source_version),
        Some(3)
    );
    let detailed_q = live_queue(&file_path)
        .into_iter()
        .find(|r| r.work_item_id == "w-c1-chunk_summary_detailed-v3");
    assert_eq!(detailed_q.as_ref().map(|r| r.source_version), Some(3));
    assert_eq!(
        detailed_q.as_ref().map(|r| r.status),
        Some(QueueLiveStatus::Queued)
    );
    let brief_q = live_queue(&file_path)
        .into_iter()
        .find(|r| r.work_item_id == "w-c1-chunk_summary_brief-v3");
    assert_eq!(brief_q.as_ref().map(|r| r.source_version), Some(3));
    assert_eq!(
        brief_q.as_ref().map(|r| r.status),
        Some(QueueLiveStatus::Queued)
    );
}

#[tokio::test]
async fn keeps_detailed_pending_when_its_member_projection_is_pending() {
    let store = temp_store();
    let sdk = sdk_for(create_inference_callbacks_double().to_callbacks());
    let file_path = new_thread(&store).await;
    seed_closed_chunk(&sdk, &file_path).await;
    set_chunk_summary_state(
        &file_path,
        "c1",
        DerivationType::ChunkSummaryDetailed,
        DerivationState::Pending,
        None,
        None,
    );
    set_chunk_summary_state(
        &file_path,
        "c1",
        DerivationType::ChunkSummaryBrief,
        DerivationState::Pending,
        None,
        None,
    );
    set_form_state(
        &file_path,
        &FormStateTarget {
            subject_kind: SubjectKind::Turn,
            subject_id: "t1".into(),
            derivation_type: DerivationType::DetailedTurnCompression,
        },
        &FormStateUpdate {
            state: DerivationState::Pending,
            content: None,
            reason: None,
            metadata: None,
            derived_at: None,
        },
    );
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_brief-v1",
        "c1",
        "chunk_summary_brief",
        1,
    );

    drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(1) })).await;

    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_detailed")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Pending)
    );
    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_brief")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Pending)
    );
    assert_eq!(
        live_queue(&file_path)
            .iter()
            .find(|r| r.work_item_id == "w-c1-chunk_summary_brief-v1")
            .map(|r| r.status),
        Some(QueueLiveStatus::Queued)
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
    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_brief")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Pending)
    );
    assert!(
        live_queue(&file_path)
            .iter()
            .find(|r| r.work_item_id == "w-c1-chunk_summary_detailed-v1")
            .is_none()
    );
}

#[tokio::test]
async fn blocks_when_detailed_is_blocked_or_failed() {
    let store = temp_store();
    let sdk = sdk_for(create_inference_callbacks_double().to_callbacks());
    let file_path = new_thread(&store).await;
    seed_closed_chunk(&sdk, &file_path).await;

    set_chunk_summary_state(
        &file_path,
        "c1",
        DerivationType::ChunkSummaryDetailed,
        DerivationState::Blocked,
        None,
        Some("source damaged"),
    );
    set_chunk_summary_state(
        &file_path,
        "c1",
        DerivationType::ChunkSummaryBrief,
        DerivationState::Pending,
        None,
        None,
    );
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_brief-v1",
        "c1",
        "chunk_summary_brief",
        1,
    );
    drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(1) })).await;
    let brief = form_of(&file_path, "c1", "chunk_summary_brief").expect("brief");
    assert_eq!(brief.state, DerivationState::Blocked);
    assert!(
        brief
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("source_damaged")
    );

    set_chunk_summary_state(
        &file_path,
        "c1",
        DerivationType::ChunkSummaryDetailed,
        DerivationState::Failed,
        None,
        Some("detailed failed"),
    );
    set_chunk_summary_state(
        &file_path,
        "c1",
        DerivationType::ChunkSummaryBrief,
        DerivationState::Pending,
        None,
        None,
    );
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_brief-v2",
        "c1",
        "chunk_summary_brief",
        1,
    );
    drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(1) })).await;
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
