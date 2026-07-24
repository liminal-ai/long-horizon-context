//! Ported from packages/lhc/test/derivation-turns.test.ts. Phase 1.
//!
//! Story 3 (Epic 02): turn composition and chunk formation — Flow 3.

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, InferenceCallbackOpName, TempStore,
    ToolCallOverrides, ToolCallPayload, ToolResultOverrides, ToolResultPayload,
    UserPromptOverrides, UserPromptPayload, create_inference_callbacks_double, kind, open_raw,
    read_chunks, read_derived_forms, temp_store, valid_event,
};
use lhc::intake_stream::BatchResult;
use lhc::shared_tech::derivation::{
    ChunkPolicyConfig, CompressDetailedTurnInput, Derivation, DerivationState, InferenceCallbacks,
    LeaseConfig, RenderingPart, RenderingPartKind, SdkConfig, SdkMode, SubjectKind,
    SummarizeChunkBriefInput,
};
use lhc::shared_tech::deterministic::{DeterministicOpName, deterministic_text};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::inference_types::{DerivationGuards, DetailedTurnCompressionGuards};
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::logging::{DerivationLogEventKind, DerivationLogQuery, LogQuery};
use lhc::shared_tech::persist::create_db_write_transaction;
use lhc::shared_tech::scheduler::{DrainDisposition, DrainReport};
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::shared_tech::work_queue::{
    EnqueueDerivationTarget, EnqueueInput, WorkKind, WorkOwner, WorkSourceRef, count_live_items,
    enqueue,
};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::turns::TurnStatus;
use lhc::{Lhc, init_lhc, threads};
use regex::Regex;
use serde_json::{Map, Value, json};

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
        OpResult::Err { error } => panic!("thread creation failed: {}", error.reason),
    }
}

fn manual_sdk(
    inference_callbacks: InferenceCallbacks,
    chunk_policy: Option<ChunkPolicyConfig>,
) -> Lhc {
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
        chunk_policy,
        view: None,
    })
}

async fn send(
    sdk: &Lhc,
    file_path: &str,
    batch: &[lhc::intake_stream::MessageEventInput],
) -> BatchResult {
    match sdk
        .intake_stream
        .message_events(ThreadRef::file_path(file_path), batch)
        .await
    {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("batch failed: {}", error.reason),
    }
}

async fn drain(sdk: &Lhc, file_path: &str) -> DrainReport {
    match sdk.work.drain(ThreadRef::file_path(file_path), None).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("drain failed: {}", error.reason),
    }
}

async fn send_turn(sdk: &Lhc, file_path: &str, prompt: &str, answer: &str) {
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

fn form_of(file_path: &str, subject_id: &str, derivation_type: &str) -> Option<Derivation> {
    read_derived_forms(file_path)
        .into_iter()
        .find(|f| f.subject_id == subject_id && f.derivation_type == derivation_type)
}

fn live_count(file_path: &str) -> i64 {
    let db = open_raw(file_path);
    let n = count_live_items(&db);
    db.close();
    n
}

fn delete_work_item(file_path: &str, work_item_id: &str) {
    let db = open_raw(file_path);
    db.prepare("DELETE FROM work_item WHERE work_item_id = ?")
        .run(&[SqlParam::from(work_item_id)]);
    db.close();
}

fn dialogue_assembly_text(prompt: &str, answer: &str) -> String {
    format!("User:\n{prompt}\n\n⏺ {answer}")
}

fn assembly_tokens(prompt: &str, answer: &str) -> i64 {
    estimate_tokens(&dialogue_assembly_text(prompt, answer))
}

fn structured_rendering(parts: &[RenderingPart]) -> String {
    let label = |kind: RenderingPartKind| -> &'static str {
        match kind {
            RenderingPartKind::UserPrompt => "User prompt",
            RenderingPartKind::AssistantText => "Assistant response",
            RenderingPartKind::AssistantThinking => "Assistant thinking",
            RenderingPartKind::RuntimeNote => "Runtime note",
            RenderingPartKind::ModelChange => "Model change",
            RenderingPartKind::ThinkingLevelChange => "Thinking level change",
            RenderingPartKind::ToolCall => "Tool call",
            RenderingPartKind::ToolResult => "Tool result",
        }
    };
    parts
        .iter()
        .map(|part| {
            let mut annotations = Vec::new();
            if part.fallback {
                annotations.push("fallback".to_string());
            }
            if let Some(outcome) = part.outcome {
                annotations.push(format!("outcome: {}", outcome.as_str()));
            }
            let suffix = if annotations.is_empty() {
                String::new()
            } else {
                format!(" [{}]", annotations.join("; "))
            };
            format!("{}{}\n{}", label(part.kind), suffix, part.text)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

async fn requeue_direct(file_path: &str, input: EnqueueInput) {
    let queued = create_db_write_transaction(
        ThreadRef::file_path(file_path),
        move |transaction| {
            Box::pin(async move {
                enqueue(transaction, input);
            })
        },
        None,
    )
    .await;
    if !queued.is_ok() {
        let OpResult::Err { error } = queued else {
            unreachable!()
        };
        panic!("direct requeue failed: {}", error.reason);
    }
}

fn tool_args(path: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("path".into(), json!(path));
    m
}

fn tool_call(id: &str, path: &str) -> lhc::intake_stream::MessageEventInput {
    valid_event(
        kind::TOOL_CALL,
        ToolCallOverrides {
            payload: Some(ToolCallPayload {
                tool_call_id: id.into(),
                tool_name: "edit_file".into(),
                arguments: tool_args(path),
            }),
            ..Default::default()
        },
    )
}

fn tool_result(id: &str, content: &str, is_error: bool) -> lhc::intake_stream::MessageEventInput {
    valid_event(
        kind::TOOL_RESULT,
        ToolResultOverrides {
            payload: Some(ToolResultPayload {
                tool_call_id: id.into(),
                content: content.into(),
                is_error: Some(is_error),
            }),
            ..Default::default()
        },
    )
}

#[tokio::test]
async fn all_message_forms_ready_both_turn_forms_ready_composed_from_the_forms_each_its_own_state_row()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;
    let prompt = "compose this turn";
    let answer = "the composed answer";
    send_turn(&sdk, &file_path, prompt, answer).await;

    let report = drain(&sdk, &file_path).await;
    assert_eq!(
        report
            .ran
            .iter()
            .map(|e| (e.work_item_id.as_str(), e.disposition))
            .collect::<Vec<_>>(),
        [
            ("w-m1-prompt_smoothing-v1", DrainDisposition::Done),
            ("w-t1-turn_derivation-v1", DrainDisposition::Done),
            ("w-t1-detailed_turn_compression-v1", DrainDisposition::Done),
        ]
    );

    let smoothed = deterministic_text(
        DeterministicOpName::SmoothPrompt,
        &json!({ "text": prompt }),
        prompt,
    );
    let parts = [
        RenderingPart {
            message_id: "m1".into(),
            kind: RenderingPartKind::UserPrompt,
            text: smoothed.clone(),
            fallback: false,
            blocks: None,
            outcome: None,
        },
        RenderingPart {
            message_id: "m2".into(),
            kind: RenderingPartKind::AssistantText,
            text: answer.into(),
            fallback: false,
            blocks: None,
            outcome: None,
        },
    ];
    let rendering_text = structured_rendering(&parts);
    let assembly_text = dialogue_assembly_text(&smoothed, answer);
    let input_tokens = estimate_tokens(&assembly_text);
    let compression_input = CompressDetailedTurnInput {
        dialogue_text: assembly_text.clone(),
        input_tokens,
        target_min_tokens: 1.max(js_round(input_tokens as f64 * 0.35)),
        target_aim_tokens: 1.max(js_round(input_tokens as f64 * 0.5)),
        target_max_tokens: 1.max(js_round(input_tokens as f64 * 0.65)),
    };
    let rendering = form_of(&file_path, "t1", "turn_rendering");
    let assembly = form_of(&file_path, "t1", "pre_detailed_assembly");
    let compression = form_of(&file_path, "t1", "detailed_turn_compression");
    let rendering = rendering.expect("rendering");
    assert_eq!(rendering.subject_kind, SubjectKind::Turn);
    assert_eq!(rendering.state, DerivationState::Ready);
    assert_eq!(rendering.content.as_deref(), Some(rendering_text.as_str()));
    assert_eq!(rendering.source_version, 1);
    assert!(rendering.gaps.is_none());
    let assembly = assembly.expect("assembly");
    assert_eq!(assembly.subject_kind, SubjectKind::Turn);
    assert_eq!(assembly.state, DerivationState::Ready);
    assert_eq!(assembly.content.as_deref(), Some(assembly_text.as_str()));
    assert_eq!(assembly.source_version, 1);
    let compression = compression.expect("compression");
    assert_eq!(compression.subject_kind, SubjectKind::Turn);
    assert_eq!(compression.state, DerivationState::Ready);
    assert_eq!(
        compression.content.as_deref(),
        Some(
            deterministic_text(
                DeterministicOpName::CompressDetailedTurn,
                &serde_json::to_value(&compression_input).unwrap(),
                &assembly_text,
            )
            .as_str()
        )
    );
    assert_eq!(compression.source_version, 1);
    assert_eq!(live_count(&file_path), 0);
}

#[tokio::test]
async fn failed_smoothing_rendering_ready_with_the_raw_prompt_text_and_a_gap_naming_message_and_form()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;
    double.fail_kind("prompt_smoothing", 1, Some("scripted smoothing failure"));
    send_turn(&sdk, &file_path, "raw prompt one", "answer text").await;

    let report = drain(&sdk, &file_path).await;
    assert_eq!(
        report
            .ran
            .iter()
            .map(|e| (e.work_item_id.as_str(), e.disposition))
            .collect::<Vec<_>>(),
        [
            ("w-m1-prompt_smoothing-v1", DrainDisposition::FailedTerminal),
            ("w-t1-turn_derivation-v1", DrainDisposition::Done),
            ("w-t1-detailed_turn_compression-v1", DrainDisposition::Done),
        ]
    );

    let rendering = form_of(&file_path, "t1", "turn_rendering");
    assert_eq!(
        rendering.as_ref().map(|r| r.state),
        Some(DerivationState::Ready)
    );
    assert!(
        rendering
            .as_ref()
            .and_then(|r| r.content.as_ref())
            .is_some_and(|c| c.contains("raw prompt one"))
    );
    assert!(rendering.as_ref().and_then(|r| r.gaps.as_ref()).is_none());
    let log = sdk
        .logging
        .query(
            ThreadRef::file_path(&file_path),
            LogQuery {
                level: None,
                derivation_type: Some("smoothed_prompt".into()),
                subject_id: None,
                reason: None,
            },
        )
        .await;
    assert!(log.is_ok());
    let OpResult::Ok { value } = log else {
        return;
    };
    assert_eq!(
        value
            .iter()
            .map(|e| (e.derivation_type.as_deref(), e.subject_id.as_deref()))
            .collect::<Vec<_>>(),
        [(Some("smoothed_prompt"), Some("m1"))]
    );
    assert_eq!(
        form_of(&file_path, "t1", "detailed_turn_compression")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(
        form_of(&file_path, "m1", "smoothed_prompt")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
}

#[tokio::test]
async fn does_not_re_run_message_inference_for_pending_or_failed_message_derivations_during_turn_construction()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = manual_sdk(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "  pending prompt  ".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "answer text".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    let calls_before_turn = captured.len();
    drain(&sdk, &file_path).await;

    assert!(
        captured.snapshot()[calls_before_turn..]
            .iter()
            .filter(|e| e.op == InferenceCallbackOpName::SmoothPrompt)
            .collect::<Vec<_>>()
            .is_empty()
    );
    assert_eq!(
        form_of(&file_path, "t1", "turn_rendering")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(
        form_of(&file_path, "t1", "detailed_turn_compression")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
}

#[tokio::test]
async fn repairing_the_smoothing_changes_nothing_re_queueing_the_rendering_rebuilds_it_at_the_next_source_version()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;
    double.fail_kind("prompt_smoothing", 1, Some("scripted smoothing failure"));
    send_turn(&sdk, &file_path, "gapped prompt", "gapped answer").await;
    drain(&sdk, &file_path).await;
    let gapped = form_of(&file_path, "t1", "turn_rendering");
    assert_eq!(
        gapped.as_ref().map(|g| g.state),
        Some(DerivationState::Ready)
    );
    assert!(gapped.as_ref().and_then(|g| g.gaps.as_ref()).is_none());
    let placed_before = read_chunks(&file_path);

    requeue_direct(
        &file_path,
        EnqueueInput {
            owner: WorkOwner::Messages,
            kind: WorkKind::PromptSmoothing,
            source_ref: WorkSourceRef::Message {
                message_id: "m1".into(),
            },
            derivations: vec![EnqueueDerivationTarget {
                subject_kind: SubjectKind::Message,
                subject_id: "m1".into(),
                derivation_type: "smoothed_prompt".into(),
            }],
            operation: None,
            source_version: None,
        },
    )
    .await;
    let repair_report = drain(&sdk, &file_path).await;
    assert_eq!(
        repair_report
            .ran
            .iter()
            .map(|e| (e.work_item_id.as_str(), e.disposition))
            .collect::<Vec<_>>(),
        [("w-m1-prompt_smoothing-v1", DrainDisposition::Done)]
    );
    assert_eq!(
        form_of(&file_path, "m1", "smoothed_prompt")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(form_of(&file_path, "t1", "turn_rendering"), gapped);
    assert_eq!(live_count(&file_path), 0);

    requeue_direct(
        &file_path,
        EnqueueInput {
            owner: WorkOwner::Turns,
            kind: WorkKind::TurnDerivation,
            source_ref: WorkSourceRef::Turn {
                turn_id: "t1".into(),
            },
            source_version: Some(2),
            derivations: vec![
                EnqueueDerivationTarget {
                    subject_kind: SubjectKind::Turn,
                    subject_id: "t1".into(),
                    derivation_type: "turn_rendering".into(),
                },
                EnqueueDerivationTarget {
                    subject_kind: SubjectKind::Turn,
                    subject_id: "t1".into(),
                    derivation_type: "pre_detailed_assembly".into(),
                },
            ],
            operation: None,
        },
    )
    .await;
    let rebuild_report = drain(&sdk, &file_path).await;
    assert_eq!(
        rebuild_report
            .ran
            .iter()
            .map(|e| (e.work_item_id.as_str(), e.disposition))
            .collect::<Vec<_>>(),
        [
            ("w-t1-turn_derivation-v2", DrainDisposition::Done),
            ("w-t1-detailed_turn_compression-v2", DrainDisposition::Done),
        ]
    );
    let rebuilt = form_of(&file_path, "t1", "turn_rendering");
    assert_eq!(
        rebuilt.as_ref().map(|r| r.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(rebuilt.as_ref().map(|r| r.source_version), Some(2));
    assert!(rebuilt.as_ref().and_then(|r| r.gaps.as_ref()).is_none());
    assert_ne!(
        rebuilt.as_ref().and_then(|r| r.content.as_ref()),
        gapped.as_ref().and_then(|g| g.content.as_ref())
    );
    assert_eq!(read_chunks(&file_path), placed_before);
}

#[tokio::test]
async fn a_three_call_edit_run_with_one_is_error_carries_per_call_outcomes_into_the_composition_input_from_the_forms()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "edit three files".into(),
                    }),
                    ..Default::default()
                },
            ),
            tool_call("call-a", "a.txt"),
            tool_result("call-a", "edited a.txt", false),
            tool_call("call-b", "b.txt"),
            tool_result("call-b", "permission denied", true),
            tool_call("call-c", "c.txt"),
            tool_result("call-c", "edited c.txt", false),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;

    drain(&sdk, &file_path).await;
    assert_eq!(
        form_of(&file_path, "t1", "turn_rendering")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );

    let rendering = form_of(&file_path, "t1", "turn_rendering");
    let run_text = rendering
        .as_ref()
        .and_then(|r| r.content.clone())
        .unwrap_or_default();
    assert!(run_text.contains("[tool run · edit_file · 3 calls · 2 succeeded, 1 failed]"));
    let three_succeeded = Regex::new(r"\b3 succeeded\b").expect("word-boundary pattern");
    assert!(!three_succeeded.is_match(&run_text));

    struct ToolMsg {
        id: &'static str,
        kind: &'static str,
        outcome: &'static str,
        text: Option<&'static str>,
    }
    let tool_messages = [
        ToolMsg {
            id: "m2",
            kind: "tool_call",
            outcome: "succeeded",
            text: Some(r#"edit_file({"path":"a.txt"})"#),
        },
        ToolMsg {
            id: "m3",
            kind: "tool_result",
            outcome: "succeeded",
            text: None,
        },
        ToolMsg {
            id: "m4",
            kind: "tool_call",
            outcome: "failed",
            text: Some(r#"edit_file({"path":"b.txt"})"#),
        },
        ToolMsg {
            id: "m5",
            kind: "tool_result",
            outcome: "failed",
            text: None,
        },
        ToolMsg {
            id: "m6",
            kind: "tool_call",
            outcome: "succeeded",
            text: Some(r#"edit_file({"path":"c.txt"})"#),
        },
        ToolMsg {
            id: "m7",
            kind: "tool_result",
            outcome: "succeeded",
            text: None,
        },
    ];
    for m in tool_messages {
        let summary = if m.kind == "tool_call" {
            m.text.expect("tool_call text").to_string()
        } else {
            form_of(&file_path, m.id, "tool_result_summary")
                .and_then(|f| f.content)
                .expect("tool_result_summary content")
        };
        assert!(run_text.contains(&format!("{summary} ⇒ {}", m.outcome)));
    }
}

#[tokio::test]
async fn draining_a_closed_turn_shows_chunk_id_and_member_idx_on_the_turn_read_back() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;
    send_turn(&sdk, &file_path, "place me", "placed").await;

    drain(&sdk, &file_path).await;
    let turns = sdk.turns.list_turns(ThreadRef::file_path(&file_path)).await;
    assert!(turns.is_ok());
    let OpResult::Ok { value } = turns else {
        return;
    };
    let t0 = &value[0];
    assert_eq!(t0.turn_id, "t1");
    assert_eq!(t0.status, TurnStatus::Closed);
    assert_eq!(t0.chunk_id.as_deref(), Some("c1"));
    assert_eq!(t0.member_idx, Some(0));
}

#[tokio::test]
async fn three_turns_at_equal_size_the_thirds_placement_closes_the_chunk_holding_two_and_the_third_opens_chunk_2()
 {
    let store = temp_store();
    let prompt = "prompt text";
    let answer = "answer text";
    let smoothed = deterministic_text(
        DeterministicOpName::SmoothPrompt,
        &json!({ "text": prompt }),
        prompt,
    );
    let per = assembly_tokens(&smoothed, answer);
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(
        double.to_callbacks(),
        Some(ChunkPolicyConfig {
            target_projected_tokens: 2 * per + 1,
            max_projected_tokens: 100 * per,
        }),
    );
    let file_path = new_thread(&store).await;
    for _ in 1..=3 {
        send_turn(&sdk, &file_path, prompt, answer).await;
    }

    drain(&sdk, &file_path).await;
    let snapshot = read_chunks(&file_path);
    assert_eq!(
        snapshot.chunks,
        [
            fixtures::ChunkSnapshotChunk {
                chunk_id: "c1".into(),
                chunk_order: 1,
                status: TurnStatus::Closed,
                accumulated_projected_tokens: 2 * per,
            },
            fixtures::ChunkSnapshotChunk {
                chunk_id: "c2".into(),
                chunk_order: 2,
                status: TurnStatus::Open,
                accumulated_projected_tokens: per,
            },
        ]
    );
    assert_eq!(
        snapshot.members,
        [
            fixtures::ChunkSnapshotMember {
                chunk_id: "c1".into(),
                turn_id: "t1".into(),
                member_idx: 0,
            },
            fixtures::ChunkSnapshotMember {
                chunk_id: "c1".into(),
                turn_id: "t2".into(),
                member_idx: 1,
            },
            fixtures::ChunkSnapshotMember {
                chunk_id: "c2".into(),
                turn_id: "t3".into(),
                member_idx: 0,
            },
        ]
    );
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
    assert!(form_of(&file_path, "c2", "chunk_summary_detailed").is_none());
    assert_eq!(live_count(&file_path), 0);
}

#[tokio::test]
async fn threshold_exactness_accumulated_incoming_equal_to_the_target_closes_inclusive_holding_only_the_prior_member()
 {
    let store = temp_store();
    let prompt = "prompt text";
    let answer = "answer text";
    let smoothed = deterministic_text(
        DeterministicOpName::SmoothPrompt,
        &json!({ "text": prompt }),
        prompt,
    );
    let per = assembly_tokens(&smoothed, answer);
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(
        double.to_callbacks(),
        Some(ChunkPolicyConfig {
            target_projected_tokens: 2 * per,
            max_projected_tokens: 100 * per,
        }),
    );
    let file_path = new_thread(&store).await;
    send_turn(&sdk, &file_path, prompt, answer).await;
    send_turn(&sdk, &file_path, prompt, answer).await;

    drain(&sdk, &file_path).await;
    let snapshot = read_chunks(&file_path);
    assert_eq!(
        snapshot.members,
        [
            fixtures::ChunkSnapshotMember {
                chunk_id: "c1".into(),
                turn_id: "t1".into(),
                member_idx: 0,
            },
            fixtures::ChunkSnapshotMember {
                chunk_id: "c2".into(),
                turn_id: "t2".into(),
                member_idx: 0,
            },
        ]
    );
    assert_eq!(
        snapshot
            .chunks
            .iter()
            .map(|c| (c.chunk_id.as_str(), c.status))
            .collect::<Vec<_>>(),
        [("c1", TurnStatus::Closed), ("c2", TurnStatus::Open)]
    );
}

#[tokio::test]
async fn one_oversized_turn_its_own_closed_chunk_with_both_summaries_derived() {
    let store = temp_store();
    let big_answer = "omega ".repeat(120).trim().to_string();
    let prompt = "huge turn";
    let smoothed = deterministic_text(
        DeterministicOpName::SmoothPrompt,
        &json!({ "text": prompt }),
        prompt,
    );
    let big = assembly_tokens(&smoothed, &big_answer);
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(
        double.to_callbacks(),
        Some(ChunkPolicyConfig {
            target_projected_tokens: big,
            max_projected_tokens: big,
        }),
    );
    let file_path = new_thread(&store).await;
    send_turn(&sdk, &file_path, prompt, &big_answer).await;

    drain(&sdk, &file_path).await;
    assert_eq!(
        read_chunks(&file_path),
        fixtures::ChunkSnapshot {
            chunks: vec![fixtures::ChunkSnapshotChunk {
                chunk_id: "c1".into(),
                chunk_order: 1,
                status: TurnStatus::Closed,
                accumulated_projected_tokens: big,
            }],
            members: vec![fixtures::ChunkSnapshotMember {
                chunk_id: "c1".into(),
                turn_id: "t1".into(),
                member_idx: 0,
            }],
        }
    );
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
async fn an_oversized_turn_arriving_behind_an_open_chunk_closes_both_the_open_chunk_without_it_its_own_chunk_with_it()
 {
    let store = temp_store();
    let big_answer = "omega ".repeat(120).trim().to_string();
    let small_prompt = "small turn";
    let small_answer = "small answer";
    let huge_prompt = "huge turn";
    let huge_smoothed = deterministic_text(
        DeterministicOpName::SmoothPrompt,
        &json!({ "text": huge_prompt }),
        huge_prompt,
    );
    let big = assembly_tokens(&huge_smoothed, &big_answer);
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(
        double.to_callbacks(),
        Some(ChunkPolicyConfig {
            target_projected_tokens: big,
            max_projected_tokens: big,
        }),
    );
    let file_path = new_thread(&store).await;
    send_turn(&sdk, &file_path, small_prompt, small_answer).await;
    send_turn(&sdk, &file_path, huge_prompt, &big_answer).await;

    drain(&sdk, &file_path).await;
    let snapshot = read_chunks(&file_path);
    assert_eq!(
        snapshot
            .chunks
            .iter()
            .map(|c| (c.chunk_id.as_str(), c.status))
            .collect::<Vec<_>>(),
        [("c1", TurnStatus::Closed), ("c2", TurnStatus::Closed)]
    );
    assert_eq!(
        snapshot.members,
        [
            fixtures::ChunkSnapshotMember {
                chunk_id: "c1".into(),
                turn_id: "t1".into(),
                member_idx: 0,
            },
            fixtures::ChunkSnapshotMember {
                chunk_id: "c2".into(),
                turn_id: "t2".into(),
                member_idx: 0,
            },
        ]
    );
    for chunk_id in ["c1", "c2"] {
        assert_eq!(
            form_of(&file_path, chunk_id, "chunk_summary_detailed")
                .as_ref()
                .map(|f| f.state),
            Some(DerivationState::Ready)
        );
        assert_eq!(
            form_of(&file_path, chunk_id, "chunk_summary_brief")
                .as_ref()
                .map(|f| f.state),
            Some(DerivationState::Ready)
        );
    }
}

const SELF_CHUNK: ChunkPolicyConfig = ChunkPolicyConfig {
    target_projected_tokens: 1,
    max_projected_tokens: 1,
};

#[tokio::test]
async fn both_summaries_land_ready_as_distinct_chunk_level_forms() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), Some(SELF_CHUNK));
    let file_path = new_thread(&store).await;
    send_turn(&sdk, &file_path, "summarize me", "summarized").await;

    let report = drain(&sdk, &file_path).await;
    assert_eq!(
        report
            .ran
            .iter()
            .map(|e| (e.kind.as_str(), e.disposition))
            .collect::<Vec<_>>(),
        [
            ("prompt_smoothing", DrainDisposition::Done),
            ("turn_derivation", DrainDisposition::Done),
            ("detailed_turn_compression", DrainDisposition::Done),
            ("chunk_summary_detailed", DrainDisposition::Done),
            ("chunk_summary_brief", DrainDisposition::Done),
        ]
    );
    let detailed = form_of(&file_path, "c1", "chunk_summary_detailed");
    let brief = form_of(&file_path, "c1", "chunk_summary_brief");
    assert_eq!(
        detailed.as_ref().map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(
        brief.as_ref().map(|f| f.state),
        Some(DerivationState::Ready)
    );
    let member_projection = form_of(&file_path, "t1", "detailed_turn_compression")
        .and_then(|f| f.content)
        .unwrap_or_default();
    assert_eq!(
        detailed.as_ref().and_then(|f| f.content.as_ref()),
        Some(&member_projection)
    );
    let brief_input_text = detailed
        .as_ref()
        .and_then(|f| f.content.clone())
        .unwrap_or_default();
    let brief_input_tokens = estimate_tokens(&brief_input_text);
    let brief_input = SummarizeChunkBriefInput {
        text: brief_input_text.clone(),
        input_tokens: brief_input_tokens,
        target_min_tokens: 1.max(js_round(brief_input_tokens as f64 * 0.08)),
        target_aim_tokens: 1.max(js_round(brief_input_tokens as f64 * 0.12)),
        target_max_tokens: 1.max(js_round(brief_input_tokens as f64 * 0.2)),
    };
    assert_eq!(
        brief
            .as_ref()
            .and_then(|f| f.content.as_ref())
            .map(|s| s.as_str()),
        Some(
            deterministic_text(
                DeterministicOpName::SummarizeChunkBrief,
                &serde_json::to_value(&brief_input).unwrap(),
                &brief_input_text,
            )
            .as_str()
        )
    );
    assert!(
        brief
            .as_ref()
            .and_then(|f| f.metadata.as_ref())
            .and_then(|m| m.size_disposition)
            .is_some()
    );
    assert_ne!(
        detailed.as_ref().and_then(|f| f.content.as_ref()),
        brief.as_ref().and_then(|f| f.content.as_ref())
    );
}

#[tokio::test]
async fn detailed_is_compression_only_assembly_brief_consumes_the_detailed_text() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = manual_sdk(double.to_callbacks(), Some(SELF_CHUNK));
    let file_path = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "edit two files".into(),
                    }),
                    ..Default::default()
                },
            ),
            tool_call("rcpt-a", "ok.txt"),
            tool_result("rcpt-a", "edited ok.txt", false),
            tool_call("rcpt-b", "ro.txt"),
            tool_result("rcpt-b", "read-only file", true),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path).await;

    let call_a = r#"edit_file({"path":"ok.txt"})"#;
    let result_a = form_of(&file_path, "m3", "tool_result_summary")
        .and_then(|f| f.content)
        .expect("m3 tool_result_summary content");
    let call_b = r#"edit_file({"path":"ro.txt"})"#;
    let result_b = form_of(&file_path, "m5", "tool_result_summary")
        .and_then(|f| f.content)
        .expect("m5 tool_result_summary content");
    let rendering = form_of(&file_path, "t1", "turn_rendering");
    let account = "tool run · edit_file · 2 calls · 1 succeeded, 1 failed";
    let run_text = rendering
        .as_ref()
        .and_then(|r| r.content.clone())
        .unwrap_or_default();
    assert!(run_text.contains(account));
    assert!(run_text.contains(&format!("{call_a} ⇒ succeeded")));
    assert!(run_text.contains(&format!("{result_a} ⇒ succeeded")));
    assert!(run_text.contains(&format!("{call_b} ⇒ failed")));
    assert!(run_text.contains(&format!("{result_b} ⇒ failed")));
    assert!(
        rendering
            .as_ref()
            .and_then(|r| r.metadata.as_ref())
            .is_none()
    );

    let brief_input = captured
        .snapshot()
        .into_iter()
        .find(|e| e.op == InferenceCallbackOpName::SummarizeChunkBrief)
        .map(|e| e.input);
    let detailed = form_of(&file_path, "c1", "chunk_summary_detailed");
    let detailed_text = detailed
        .as_ref()
        .and_then(|f| f.content.clone())
        .unwrap_or_default();
    assert_eq!(
        brief_input
            .as_ref()
            .and_then(|v| v.get("text"))
            .and_then(|v| v.as_str()),
        Some(detailed_text.as_str())
    );
    let brief_json = js_json_stringify(brief_input.as_ref().unwrap_or(&Value::Null));
    let compression = form_of(&file_path, "t1", "detailed_turn_compression")
        .and_then(|f| f.content)
        .unwrap_or_default();
    assert!(!brief_json.contains(&compression));
    assert!(!detailed_text.contains("[receipts"));
    assert!(!detailed_text.contains(r#"({""#));
    // All four summaries required before negative containment — never skip missing.
    let summaries = [call_a.to_string(), result_a, call_b.to_string(), result_b];
    assert_eq!(summaries.len(), 4);
    for s in &summaries {
        assert!(!detailed_text.contains(s));
    }

    let brief = form_of(&file_path, "c1", "chunk_summary_brief");
    assert_eq!(
        detailed.as_ref().map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(
        brief.as_ref().map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert!(
        detailed
            .as_ref()
            .and_then(|f| f.content.as_ref())
            .is_some_and(|c| c.contains(
                form_of(&file_path, "t1", "detailed_turn_compression")
                    .and_then(|f| f.content)
                    .unwrap_or_default()
                    .as_str()
            ))
    );
    assert!(
        detailed
            .as_ref()
            .and_then(|f| f.content.as_ref())
            .is_some_and(|c| !c.contains("[receipts"))
    );
    assert!(
        brief
            .as_ref()
            .and_then(|f| f.metadata.as_ref())
            .and_then(|m| m.size_disposition)
            .is_some()
    );
}

#[tokio::test]
async fn the_brief_item_fails_alone_detailed_ready_brief_failed_brief_re_derivable_by_itself() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), Some(SELF_CHUNK));
    let file_path = new_thread(&store).await;
    double.fail_kind("chunk_summary_brief", 1, Some("scripted brief failure"));
    send_turn(&sdk, &file_path, "independent failure", "answer").await;

    let report = drain(&sdk, &file_path).await;
    assert_eq!(
        report
            .ran
            .iter()
            .map(|e| (e.kind.as_str(), e.disposition))
            .collect::<Vec<_>>(),
        [
            ("prompt_smoothing", DrainDisposition::Done),
            ("turn_derivation", DrainDisposition::Done),
            ("detailed_turn_compression", DrainDisposition::Done),
            ("chunk_summary_detailed", DrainDisposition::Done),
            ("chunk_summary_brief", DrainDisposition::FailedTerminal),
        ]
    );
    let detailed_before = form_of(&file_path, "c1", "chunk_summary_detailed");
    assert_eq!(
        detailed_before.as_ref().map(|f| f.state),
        Some(DerivationState::Ready)
    );
    let failed_brief = form_of(&file_path, "c1", "chunk_summary_brief");
    assert_eq!(
        failed_brief.as_ref().map(|f| f.state),
        Some(DerivationState::Failed)
    );
    assert_eq!(
        failed_brief.as_ref().and_then(|f| f.reason.as_deref()),
        Some("scripted brief failure")
    );

    let derivation_log = sdk
        .logging
        .query_derivation_log(
            ThreadRef::file_path(&file_path),
            DerivationLogQuery {
                subject_kind: None,
                subject_id: Some("c1".into()),
                derivation_type: Some("chunk_summary_brief".into()),
                event_kind: None,
            },
        )
        .await;
    assert!(derivation_log.is_ok());
    let OpResult::Ok { value } = derivation_log else {
        return;
    };
    assert!(value.iter().any(|e| {
        e.event_kind == DerivationLogEventKind::InferenceFailed
            && e.payload.get("reason").and_then(|v| v.as_str()) == Some("scripted brief failure")
    }));
    assert!(value.iter().any(|e| {
        e.event_kind == DerivationLogEventKind::TerminalFailed
            && e.payload.get("reason").and_then(|v| v.as_str()) == Some("scripted brief failure")
    }));

    requeue_direct(
        &file_path,
        EnqueueInput {
            owner: WorkOwner::Turns,
            kind: WorkKind::ChunkSummaryBrief,
            source_ref: WorkSourceRef::Chunk {
                chunk_id: "c1".into(),
            },
            derivations: vec![EnqueueDerivationTarget {
                subject_kind: SubjectKind::Chunk,
                subject_id: "c1".into(),
                derivation_type: "chunk_summary_brief".into(),
            }],
            operation: None,
            source_version: None,
        },
    )
    .await;
    let requeued = drain(&sdk, &file_path).await;
    assert_eq!(
        requeued
            .ran
            .iter()
            .map(|e| (e.kind.as_str(), e.disposition))
            .collect::<Vec<_>>(),
        [("chunk_summary_brief", DrainDisposition::Done)]
    );
    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_brief")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(
        form_of(&file_path, "c1", "chunk_summary_detailed"),
        detailed_before
    );
}

#[tokio::test]
async fn the_same_event_stream_into_a_fresh_thread_re_chunks_identically_membership_and_boundaries_deep_equal()
 {
    let store = temp_store();
    let policy = ChunkPolicyConfig {
        target_projected_tokens: 60,
        max_projected_tokens: 4400,
    };
    let turns_content: [(&str, &str); 5] = [
        ("first prompt about the parser", "parser answer with detail"),
        (
            "second prompt about the cache",
            "cache answer, longer, with extra words",
        ),
        ("third prompt about the index rebuild", "index answer"),
        ("fourth prompt, short", "fourth answer, also short"),
        (
            "fifth prompt to push past one chunk",
            "fifth answer closing things out",
        ),
    ];

    async fn build_and_drain(
        store: &TempStore,
        policy: ChunkPolicyConfig,
        turns_content: &[(&str, &str)],
    ) -> String {
        let double = create_inference_callbacks_double();
        let sdk = manual_sdk(double.to_callbacks(), Some(policy));
        let file_path = new_thread(store).await;
        for (prompt, answer) in turns_content {
            send_turn(&sdk, &file_path, prompt, answer).await;
        }
        drain(&sdk, &file_path).await;
        file_path
    }

    let first = build_and_drain(&store, policy.clone(), &turns_content).await;
    let second = build_and_drain(&store, policy, &turns_content).await;

    let first_snapshot = read_chunks(&first);
    assert_eq!(first_snapshot, read_chunks(&second));
    assert!(first_snapshot.chunks.len() > 1);
    let summaries_of = |file_path: &str| {
        read_derived_forms(file_path)
            .into_iter()
            .filter(|form| form.subject_kind == SubjectKind::Chunk)
            .map(|form| {
                (
                    form.subject_id,
                    form.derivation_type,
                    form.state,
                    form.content,
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(summaries_of(&first), summaries_of(&second));
}
