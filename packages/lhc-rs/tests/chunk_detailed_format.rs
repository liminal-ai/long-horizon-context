//! Ported from packages/lhc/test/chunk-detailed-format.test.ts. Phase 1.

mod fixtures;

use std::sync::Arc;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, DerivationType, FormStateTarget, FormStateUpdate,
    TempStore, ToolCallOverrides, ToolCallPayload, ToolResultOverrides, ToolResultPayload,
    UserPromptOverrides, UserPromptPayload, create_inference_callbacks_double, kind, open_raw,
    read_derived_forms, set_form_state, temp_store, valid_event,
};
use lhc::shared_tech::derivation::{
    BoxFuture, ChunkPolicyConfig, Derivation, DerivationState, InferenceCallbacks, InferenceResult,
    LeaseConfig, SdkConfig, SdkMode, SubjectKind,
};
use lhc::shared_tech::deterministic::{DeterministicOpName, deterministic_text};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::inference_types::{DerivationGuards, DetailedTurnCompressionGuards};
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::logging::{LogLevel, LogQuery};
use lhc::shared_tech::scheduler::{DrainDisposition, DrainReport};
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::shared_tech::work_queue::queue_detail;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{DrainOpts, Lhc, init_lhc, threads};
use serde_json::{Map, Value, json};

const SELF_CHUNK: ChunkPolicyConfig = ChunkPolicyConfig {
    target_projected_tokens: 1,
    max_projected_tokens: 1,
};
const FIXED_PROJECTION: &str = "fixed projected turn text";

fn smoothed_prompt(text: &str) -> String {
    deterministic_text(
        DeterministicOpName::SmoothPrompt,
        &json!({ "text": text }),
        text,
    )
}

fn dialogue_assembly_text(prompt: &str, answer: &str) -> String {
    format!("User:\n{}\n\n⏺ {answer}", smoothed_prompt(prompt))
}

fn assembly_tokens(prompt: &str, answer: &str) -> i64 {
    estimate_tokens(&dialogue_assembly_text(prompt, answer))
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

/// Phase 1 narrowing of TS `Partial<SdkConfig>` — only `chunk_policy` is
/// exercised by this suite's `sdkFor` call sites.
struct SdkForOverrides {
    chunk_policy: Option<ChunkPolicyConfig>,
}

fn sdk_for(inference_callbacks: InferenceCallbacks, overrides: SdkForOverrides) -> Lhc {
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
        chunk_policy: Some(overrides.chunk_policy.unwrap_or(SELF_CHUNK)),
        view: None,
    })
}

fn with_scripted_projection(base: InferenceCallbacks, projection: &str) -> InferenceCallbacks {
    let projection = projection.to_string();
    InferenceCallbacks {
        smooth_prompt: base.smooth_prompt.clone(),
        summarize_tool_result: base.summarize_tool_result.clone(),
        compress_detailed_turn: Arc::new(move |_input| {
            let projection = projection.clone();
            Box::pin(async move {
                InferenceResult::Ok {
                    text: projection,
                    provenance: None,
                    request_messages: None,
                    raw_response: None,
                }
            }) as BoxFuture<InferenceResult>
        }),
        summarize_chunk_brief: base.summarize_chunk_brief.clone(),
    }
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
                    payload: Some(AssistantTextPayload {
                        text: answer.into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
}

fn tool_args(path: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("path".into(), json!(path));
    m
}

async fn send_tool_turn(sdk: &Lhc, file_path: &str) {
    send(
        sdk,
        file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "read the project plan".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "tool-a".into(),
                        tool_name: "read_file".into(),
                        arguments: tool_args("docs/plan.md"),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "tool-a".into(),
                        content: "plan contents".into(),
                        is_error: Some(false),
                    }),
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

fn enqueue_chunk_summary_work(
    file_path: &str,
    work_item_id: &str,
    chunk_id: &str,
    derivation_type: &str,
) {
    exec_sql(
        file_path,
        "INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
     VALUES (?, 'turns', ?, ?, 'queued', '2026-06-22T00:00:00.000Z', ?)",
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

fn reset_chunk_summary(file_path: &str, chunk_id: &str, derivation_type: DerivationType) {
    set_form_state(
        file_path,
        &FormStateTarget {
            subject_kind: SubjectKind::Chunk,
            subject_id: chunk_id.into(),
            derivation_type,
        },
        &FormStateUpdate {
            state: DerivationState::Pending,
            content: None,
            reason: None,
            metadata: None,
            derived_at: None,
        },
    );
}

fn set_compression_state(
    file_path: &str,
    turn_id: &str,
    state: DerivationState,
    reason: Option<&str>,
    content: Option<&str>,
) {
    set_form_state(
        file_path,
        &FormStateTarget {
            subject_kind: SubjectKind::Turn,
            subject_id: turn_id.into(),
            derivation_type: DerivationType::DetailedTurnCompression,
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

#[tokio::test]
async fn derives_blank_line_separated_member_text_in_order_without_a_detailed_model_call() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let per_turn_tokens = assembly_tokens("first prompt", "first answer");
    let sdk = sdk_for(
        with_scripted_projection(double.to_callbacks(), FIXED_PROJECTION),
        SdkForOverrides {
            chunk_policy: Some(ChunkPolicyConfig {
                target_projected_tokens: 4 * per_turn_tokens,
                max_projected_tokens: 999999,
            }),
        },
    );
    let file_path = new_thread(&store).await;

    send_prompt_turn(&sdk, &file_path, "first prompt", "first answer").await;
    send_prompt_turn(&sdk, &file_path, "second prompt", "second answer").await;
    send_prompt_turn(&sdk, &file_path, "third prompt", "third answer").await;
    send_prompt_turn(&sdk, &file_path, "fourth prompt", "fourth answer").await;
    drain(&sdk, &file_path, None).await;

    let detailed_text = form_of(&file_path, "c1", "chunk_summary_detailed").and_then(|f| f.content);
    let expected = format!("{FIXED_PROJECTION}\n\n{FIXED_PROJECTION}\n\n{FIXED_PROJECTION}");
    assert_eq!(detailed_text.as_deref(), Some(expected.as_str()));
    assert!(!detailed_text.as_deref().unwrap_or("").contains(" | "));
}

#[tokio::test]
async fn detailed_assembly_is_compression_text_only_no_receipt_block_no_tool_argument_leak() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let per_turn_tokens = assembly_tokens("plain prompt", "plain answer");
    let tool_turn_tokens = estimate_tokens(&format!(
        "User:\n{}",
        smoothed_prompt("read the project plan")
    ));
    let placement_tokens = per_turn_tokens.max(tool_turn_tokens);
    let sdk = sdk_for(
        with_scripted_projection(double.to_callbacks(), FIXED_PROJECTION),
        SdkForOverrides {
            chunk_policy: Some(ChunkPolicyConfig {
                target_projected_tokens: 2 * placement_tokens,
                max_projected_tokens: 999999,
            }),
        },
    );
    let file_path = new_thread(&store).await;
    send_tool_turn(&sdk, &file_path).await;
    send_prompt_turn(&sdk, &file_path, "plain prompt", "plain answer").await;
    send_prompt_turn(&sdk, &file_path, "closing prompt", "closing answer").await;

    drain(&sdk, &file_path, None).await;

    let detailed = form_of(&file_path, "c1", "chunk_summary_detailed");
    let expected = format!("{FIXED_PROJECTION}\n\n{FIXED_PROJECTION}");
    assert_eq!(
        detailed.as_ref().and_then(|f| f.content.as_deref()),
        Some(expected.as_str())
    );
    let content = detailed.as_ref().and_then(|f| f.content.as_ref()).unwrap();
    assert!(!content.contains("[receipts"));
    assert!(!content.contains(r#"({""#));
    assert!(!content.contains("docs/plan.md"));
    let rendering = form_of(&file_path, "t1", "turn_rendering");
    assert!(
        rendering
            .as_ref()
            .and_then(|f| f.content.as_ref())
            .is_some_and(|c| c.contains("tool run · read_file · 1 call · 1 succeeded"))
    );
    assert!(
        rendering
            .as_ref()
            .and_then(|f| f.metadata.as_ref())
            .is_none()
    );
}

#[tokio::test]
async fn uses_ready_pre_detailed_assembly_as_the_floor_for_failed_detailed_members_and_logs_the_fallback()
 {
    let store = temp_store();
    let sdk = sdk_for(
        create_inference_callbacks_double().to_callbacks(),
        SdkForOverrides { chunk_policy: None },
    );
    let file_path = new_thread(&store).await;
    send_prompt_turn(&sdk, &file_path, "floor prompt", "floor answer").await;
    drain(&sdk, &file_path, None).await;
    let assembly = form_of(&file_path, "t1", "pre_detailed_assembly").and_then(|f| f.content);
    assert!(assembly.is_some());

    set_compression_state(
        &file_path,
        "t1",
        DerivationState::Failed,
        Some("scripted compression failure"),
        None,
    );
    reset_chunk_summary(&file_path, "c1", DerivationType::ChunkSummaryDetailed);
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_detailed-v1",
        "c1",
        "chunk_summary_detailed",
    );

    let report = drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(1) })).await;

    assert_eq!(
        report
            .ran
            .iter()
            .map(|e| (e.work_item_id.as_str(), e.disposition))
            .collect::<Vec<_>>(),
        [("w-c1-chunk_summary_detailed-v1", DrainDisposition::Done)]
    );
    let detailed = form_of(&file_path, "c1", "chunk_summary_detailed").expect("detailed");
    assert_eq!(detailed.state, DerivationState::Ready);
    assert_eq!(detailed.content, assembly);
    let logs = sdk
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
    assert!(value.iter().any(|e| {
        e.reason.as_deref() == Some("failed_floor")
            && e.floor_used.as_deref() == Some("t1")
            && e.level == LogLevel::Warning
    }));
}

#[tokio::test]
async fn does_not_log_failed_floor_fallback_when_completion_is_stale_discarded() {
    let store = temp_store();
    let sdk = sdk_for(
        create_inference_callbacks_double().to_callbacks(),
        SdkForOverrides { chunk_policy: None },
    );
    let file_path = new_thread(&store).await;
    send_prompt_turn(&sdk, &file_path, "stale floor prompt", "stale floor answer").await;
    drain(&sdk, &file_path, None).await;

    set_compression_state(
        &file_path,
        "t1",
        DerivationState::Failed,
        Some("scripted compression failure"),
        None,
    );
    reset_chunk_summary(&file_path, "c1", DerivationType::ChunkSummaryDetailed);
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_detailed-v1",
        "c1",
        "chunk_summary_detailed",
    );
    exec_sql(
        &file_path,
        "UPDATE derivation SET source_version = 2
       WHERE subject_kind = 'chunk' AND subject_id = 'c1' AND derivation_type = 'chunk_summary_detailed'",
        &[],
    );

    let report = drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(1) })).await;

    assert_eq!(
        report
            .ran
            .iter()
            .map(|e| (e.work_item_id.as_str(), e.disposition))
            .collect::<Vec<_>>(),
        [(
            "w-c1-chunk_summary_detailed-v1",
            DrainDisposition::StaleDiscarded
        )]
    );
    let logs = sdk
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
    assert!(value.is_empty());
}

#[tokio::test]
async fn requeues_pending_members_and_blocks_blocked_members() {
    let store = temp_store();
    let sdk = sdk_for(
        create_inference_callbacks_double().to_callbacks(),
        SdkForOverrides { chunk_policy: None },
    );
    let file_path = new_thread(&store).await;
    send_prompt_turn(&sdk, &file_path, "pending prompt", "pending answer").await;
    send_prompt_turn(&sdk, &file_path, "blocked prompt", "blocked answer").await;
    drain(&sdk, &file_path, None).await;

    set_compression_state(&file_path, "t1", DerivationState::Pending, None, None);
    reset_chunk_summary(&file_path, "c1", DerivationType::ChunkSummaryDetailed);
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_detailed-v1",
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
            .find(|r| r.work_item_id == "w-c1-chunk_summary_detailed-v1")
            .is_none()
    );

    set_compression_state(
        &file_path,
        "t2",
        DerivationState::Blocked,
        Some("source damaged"),
        None,
    );
    reset_chunk_summary(&file_path, "c2", DerivationType::ChunkSummaryDetailed);
    enqueue_chunk_summary_work(
        &file_path,
        "w-c2-chunk_summary_detailed-v1",
        "c2",
        "chunk_summary_detailed",
    );
    drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(1) })).await;

    let blocked = form_of(&file_path, "c2", "chunk_summary_detailed").expect("blocked");
    assert_eq!(blocked.state, DerivationState::Blocked);
    assert!(
        blocked
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("source_damaged")
    );
}

#[tokio::test]
async fn brief_consumes_the_detailed_summary_when_detailed_uses_a_failed_member_floor() {
    let store = temp_store();
    let sdk = sdk_for(
        create_inference_callbacks_double().to_callbacks(),
        SdkForOverrides { chunk_policy: None },
    );
    let file_path = new_thread(&store).await;
    send_prompt_turn(&sdk, &file_path, "brief floor prompt", "brief floor answer").await;
    drain(&sdk, &file_path, None).await;

    set_compression_state(
        &file_path,
        "t1",
        DerivationState::Failed,
        Some("scripted compression failure"),
        None,
    );
    reset_chunk_summary(&file_path, "c1", DerivationType::ChunkSummaryDetailed);
    reset_chunk_summary(&file_path, "c1", DerivationType::ChunkSummaryBrief);
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_detailed-v1",
        "c1",
        "chunk_summary_detailed",
    );
    enqueue_chunk_summary_work(
        &file_path,
        "w-c1-chunk_summary_brief-v1",
        "c1",
        "chunk_summary_brief",
    );

    drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(2) })).await;

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
    assert!(
        form_of(&file_path, "c1", "chunk_summary_brief")
            .as_ref()
            .and_then(|f| f.metadata.as_ref())
            .and_then(|m| m.size_disposition)
            .is_some()
    );
    assert!(
        live_queue(&file_path)
            .iter()
            .find(|r| r.work_item_id == "w-c1-chunk_summary_brief-v1")
            .is_none()
    );
}

#[tokio::test]
async fn produces_byte_identical_detailed_output_for_identical_input() {
    let store = temp_store();
    async fn build(store: &TempStore) -> String {
        let double = create_inference_callbacks_double();
        let projected_tokens = estimate_tokens(FIXED_PROJECTION);
        let sdk = sdk_for(
            with_scripted_projection(double.to_callbacks(), FIXED_PROJECTION),
            SdkForOverrides {
                chunk_policy: Some(ChunkPolicyConfig {
                    target_projected_tokens: 3 * projected_tokens,
                    max_projected_tokens: 999999,
                }),
            },
        );
        let file_path = new_thread(store).await;
        send_prompt_turn(&sdk, &file_path, "same first prompt", "same first answer").await;
        send_prompt_turn(&sdk, &file_path, "same second prompt", "same second answer").await;
        send_prompt_turn(
            &sdk,
            &file_path,
            "same closing prompt",
            "same closing answer",
        )
        .await;
        drain(&sdk, &file_path, None).await;
        form_of(&file_path, "c1", "chunk_summary_detailed")
            .and_then(|f| f.content)
            .unwrap_or_default()
    }

    assert_eq!(build(&store).await, build(&store).await);
}
