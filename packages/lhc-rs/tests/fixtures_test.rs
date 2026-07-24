//! Ported from packages/lhc/test/fixtures.test.ts. Phase 1.

mod fixtures;

use std::collections::BTreeSet;

use lhc::intake_stream::EventKind;
use lhc::shared_tech::derivation::{
    CompressDetailedTurnInput, InferenceResult, SmoothPromptInput, SummarizeChunkBriefInput,
    SummarizeToolResultInput,
};
use lhc::shared_tech::derivation::{LeaseConfig, SdkConfig, SdkMode};
use lhc::{init_lhc, intake_stream, messages, turns};
use serde_json::json;

use fixtures::{
    CapturedInput, InferenceCallbackOpName, ToolRunOpts, UserPromptOverrides, UserPromptPayload,
    create_inference_callbacks_double, damaged_source_thread, event_batch, kind,
    multi_state_thread, open_raw, read_derived_forms, temp_store, thread_with_closed_turns,
    thread_with_tool_run, valid_event, valid_event_for_kind, valid_event_forced,
};
use lhc::shared_tech::derivation::DerivationState;
use lhc::shared_tech::errors::ErrorCode;

const ALL_KINDS: [EventKind; 9] = EventKind::ALL;

fn golden_payload_keys(kind: EventKind) -> &'static [&'static str] {
    match kind {
        EventKind::UserPrompt
        | EventKind::AssistantText
        | EventKind::AssistantThinking
        | EventKind::RuntimeNote => &["text"],
        EventKind::ModelChange => &["previousModel", "newModel"],
        EventKind::ThinkingLevelChange => &["previousLevel", "newLevel"],
        EventKind::ToolCall => &["toolCallId", "toolName", "arguments"],
        EventKind::ToolResult => &["toolCallId", "content", "isError"],
        EventKind::TurnEnd => &[],
    }
}

#[test]
fn valid_event_produces_a_golden_shaped_event_for_every_kind() {
    for kind in ALL_KINDS {
        let event = valid_event_for_kind(kind);
        assert_eq!(event.event_kind, kind.as_str());
        assert!(event.idempotency_key.as_ref().unwrap().len() > 0);
        assert!(event.actor.len() > 0);
        assert!(event.harness.len() > 0);
        let mut keys: Vec<_> = event.payload.keys().cloned().collect();
        keys.sort();
        let mut expected: Vec<_> = golden_payload_keys(kind)
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        expected.sort();
        assert_eq!(keys, expected);
        let mut top: Vec<_> = ["actor", "eventKind", "harness", "idempotencyKey", "payload"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        top.sort();
        let serialized = serde_json::to_value(&event).unwrap();
        let mut got: Vec<_> = serialized.as_object().unwrap().keys().cloned().collect();
        got.sort();
        assert_eq!(got, top);
    }
}

#[test]
fn valid_event_applies_overrides_without_changing_the_kind() {
    let event = valid_event(
        kind::USER_PROMPT,
        UserPromptOverrides {
            actor: Some("custom-actor".into()),
            payload: Some(UserPromptPayload {
                text: "custom prompt".into(),
            }),
            ..Default::default()
        },
    );
    assert_eq!(event.event_kind, "user_prompt");
    assert_eq!(event.actor, "custom-actor");
    assert_eq!(event.payload.get("text").unwrap(), "custom prompt");
}

#[test]
fn building_an_invalid_kind_payload_pairing_requires_an_explicit_cast() {
    let forced = valid_event_forced(
        EventKind::UserPrompt,
        json!({"payload": {"toolCallId": "x", "toolName": "y", "arguments": {}}}),
    );
    assert_eq!(forced.event_kind, "user_prompt");
}

#[test]
fn event_batch_yields_unique_idempotency_keys_in_order() {
    let batch = event_batch(&ALL_KINDS);
    assert_eq!(
        batch
            .iter()
            .map(|e| e.event_kind.as_str())
            .collect::<Vec<_>>(),
        ALL_KINDS.iter().map(|k| k.as_str()).collect::<Vec<_>>()
    );
    let keys: BTreeSet<_> = batch
        .iter()
        .map(|e| e.idempotency_key.clone().unwrap())
        .collect();
    assert_eq!(keys.len(), batch.len());
}

#[test]
fn conversation_turn_is_one_complete_turn() {
    use fixtures::conversation_turn;
    assert_eq!(
        conversation_turn()
            .iter()
            .map(|e| e.event_kind.as_str())
            .collect::<Vec<_>>(),
        vec![
            "user_prompt",
            "assistant_text",
            "tool_call",
            "tool_result",
            "turn_end"
        ]
    );
}

#[test]
fn temp_store_creates_an_isolated_directory_and_cleans_it_up() {
    let store = temp_store();
    assert!(store.dir.exists());
    assert!(store.registry_path.starts_with(&store.dir));
    let a = store.thread_path(None);
    let b = store.thread_path(None);
    assert_ne!(a, b);
    store.cleanup();
    assert!(!store.dir.exists());
}

/// Rust-only: TempStore Drop removes the dir after a caught panic (todo! unwind).
#[test]
fn temp_store_drop_removes_dir_on_panic_unwind() {
    use std::sync::Mutex;
    let dir_slot = Mutex::new(None);
    let result = std::panic::catch_unwind(|| {
        let store = temp_store();
        *dir_slot.lock().expect("dir slot") = Some(store.dir.clone());
        assert!(store.dir.exists());
        panic!("simulated todo!");
    });
    assert!(result.is_err());
    let dir = dir_slot
        .lock()
        .expect("dir slot")
        .clone()
        .expect("dir recorded before panic");
    assert!(
        !dir.exists(),
        "TempStore Drop must remove dir on panic unwind: {}",
        dir.display()
    );
}

#[test]
fn open_raw_opens_a_real_sqlite_handle_for_below_sdk_assertions() {
    let store = temp_store();
    let path = store.thread_path(Some("raw"));
    let writer = open_raw(&path);
    writer.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT)");
    writer.exec("INSERT INTO probe (note) VALUES ('hello')");
    writer.close();
    let reader = open_raw(&path);
    let row = reader.prepare("SELECT note FROM probe WHERE id = 1").get();
    assert_eq!(
        row.as_ref()
            .and_then(|m| m.get("note"))
            .and_then(|v| v.as_str()),
        Some("hello")
    );
    reader.close();
    store.cleanup();
}

async fn call_all_operations(double: &fixtures::InferenceCallbacksDouble) -> Vec<InferenceResult> {
    vec![
        double
            .smooth_prompt(SmoothPromptInput {
                text: "please smooth this prompt text".into(),
            })
            .await,
        double
            .summarize_tool_result(SummarizeToolResultInput {
                tool_name: "read_file".into(),
                content: "tool result content".into(),
                outcome: None,
                target_tokens: None,
                operation_class: None,
                response_shape: None,
                prompt_mode: None,
                facts: None,
            })
            .await,
        double
            .compress_detailed_turn(CompressDetailedTurnInput {
                dialogue_text: "the rendering text".into(),
                input_tokens: 10,
                target_min_tokens: 4,
                target_aim_tokens: 5,
                target_max_tokens: 7,
            })
            .await,
        double
            .summarize_chunk_brief(SummarizeChunkBriefInput {
                text: "detailed projection text".into(),
                input_tokens: 10,
                target_min_tokens: 1,
                target_aim_tokens: 2,
                target_max_tokens: 3,
            })
            .await,
    ]
}

const OPERATION_MARKERS: [&str; 4] = ["smoothed", "toolresult", "projection", "brief"];

fn ok_text(r: &InferenceResult) -> &str {
    match r {
        InferenceResult::Ok { text, .. } => text,
        InferenceResult::Err { reason, .. } => panic!("expected ok, got err: {reason}"),
    }
}

#[tokio::test]
async fn fc_0_1_implements_all_operations_with_marked_input_derived_output() {
    let results = call_all_operations(&create_inference_callbacks_double()).await;
    for (index, result) in results.iter().enumerate() {
        match result {
            InferenceResult::Ok { text, .. } => {
                assert!(text.starts_with(&format!("{}(", OPERATION_MARKERS[index])));
            }
            InferenceResult::Err { .. } => panic!("expected ok"),
        }
    }
    let double = create_inference_callbacks_double();
    let a = double
        .smooth_prompt(SmoothPromptInput {
            text: "first input".into(),
        })
        .await;
    let b = double
        .smooth_prompt(SmoothPromptInput {
            text: "second input".into(),
        })
        .await;
    let a_text = ok_text(&a);
    let b_text = ok_text(&b);
    assert_ne!(a_text, b_text);
    assert!(a_text.contains("first input"));
}

#[tokio::test]
async fn fc_0_2_identical_input_yields_identical_output_across_double_instances() {
    let first = call_all_operations(&create_inference_callbacks_double()).await;
    let second = call_all_operations(&create_inference_callbacks_double()).await;
    assert_eq!(format!("{first:?}"), format!("{second:?}"));
    let texts: Vec<_> = first.iter().map(ok_text).collect();
    assert_eq!(texts.iter().collect::<BTreeSet<_>>().len(), 4);
    let markers: Vec<_> = texts.iter().map(|t| &t[..t.find('(').unwrap()]).collect();
    assert_eq!(markers, OPERATION_MARKERS);
}

#[tokio::test]
async fn fc_0_2_fail_next_drives_fail_n_then_succeed() {
    let double = create_inference_callbacks_double();
    double.fail_next(2, None);
    let r1 = double
        .smooth_prompt(SmoothPromptInput { text: "x".into() })
        .await;
    let r2 = double
        .summarize_chunk_brief(SummarizeChunkBriefInput {
            text: "y".into(),
            input_tokens: 10,
            target_min_tokens: 1,
            target_aim_tokens: 2,
            target_max_tokens: 3,
        })
        .await;
    let r3 = double
        .smooth_prompt(SmoothPromptInput { text: "x".into() })
        .await;
    assert!(matches!(r1, InferenceResult::Err { .. }));
    assert!(matches!(r2, InferenceResult::Err { .. }));
    assert!(matches!(r3, InferenceResult::Ok { .. }));
    let fresh = create_inference_callbacks_double()
        .smooth_prompt(SmoothPromptInput { text: "x".into() })
        .await;
    assert_eq!(format!("{r3:?}"), format!("{fresh:?}"));
}

#[tokio::test]
async fn fc_0_2_fail_kind_scripts_failure_per_operation() {
    let double = create_inference_callbacks_double();
    double.fail_kind("prompt_smoothing", 99, Some("content refusal"));
    let failed = double
        .smooth_prompt(SmoothPromptInput { text: "x".into() })
        .await;
    assert_eq!(
        failed,
        InferenceResult::Err {
            reason: "content refusal".into(),
            request_messages: None,
        }
    );
    let other = double
        .summarize_tool_result(SummarizeToolResultInput {
            tool_name: "t".into(),
            content: "c".into(),
            outcome: None,
            target_tokens: None,
            operation_class: None,
            response_shape: None,
            prompt_mode: None,
            facts: None,
        })
        .await;
    assert!(matches!(other, InferenceResult::Ok { .. }));
}

#[tokio::test]
async fn fc_0_2_delay_kind_injects_latency_on_the_scripted_operation() {
    let double = create_inference_callbacks_double();
    double.delay_kind("chunk_summary_brief", 40);
    let before = std::time::Instant::now();
    let result = double
        .summarize_chunk_brief(SummarizeChunkBriefInput {
            text: "p".into(),
            input_tokens: 10,
            target_min_tokens: 1,
            target_aim_tokens: 2,
            target_max_tokens: 3,
        })
        .await;
    let elapsed = before.elapsed().as_millis();
    assert!(matches!(result, InferenceResult::Ok { .. }));
    assert!(elapsed >= 35);
}

#[tokio::test]
async fn scripting_and_capture_state_are_per_instance() {
    let scripted = create_inference_callbacks_double();
    let clean = create_inference_callbacks_double();
    let captured_scripted = scripted.capture_inputs();
    scripted.fail_next(1, None);
    let clean_result = clean
        .smooth_prompt(SmoothPromptInput {
            text: "untouched".into(),
        })
        .await;
    assert!(matches!(clean_result, InferenceResult::Ok { .. }));
    assert!(captured_scripted.is_empty());
    let captured_clean = clean.capture_inputs();
    clean
        .compress_detailed_turn(CompressDetailedTurnInput {
            dialogue_text: "r".into(),
            input_tokens: 10,
            target_min_tokens: 4,
            target_aim_tokens: 5,
            target_max_tokens: 7,
        })
        .await;
    let snap = captured_clean.snapshot();
    assert_eq!(
        snap,
        vec![CapturedInput {
            op: InferenceCallbackOpName::CompressDetailedTurn,
            input: json!({
                "dialogueText": "r",
                "inputTokens": 10,
                "targetMinTokens": 4,
                "targetAimTokens": 5,
                "targetMaxTokens": 7,
            }),
        }]
    );
    assert!(captured_scripted.is_empty());
    let scripted_result = scripted
        .smooth_prompt(SmoothPromptInput {
            text: "untouched".into(),
        })
        .await;
    assert!(matches!(scripted_result, InferenceResult::Err { .. }));
    let snap = captured_scripted.snapshot();
    assert_eq!(
        snap,
        vec![CapturedInput {
            op: InferenceCallbackOpName::SmoothPrompt,
            input: json!({ "text": "untouched" }),
        }]
    );
}

#[test]
fn resolves_config_defaults_centrally_and_carries_the_injected_inference_callbacks_and_mode() {
    let double = create_inference_callbacks_double();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    // Judgment: TS identity-compares callbacks to the double; Rust stores
    // boxed closures — assert mode/defaults instead of pointer identity.
    assert_eq!(sdk.config.mode, SdkMode::Manual);
    assert_eq!(
        sdk.config.lease,
        LeaseConfig {
            duration_ms: 120_000
        }
    );
    assert_eq!(sdk.config.chunk_policy.target_projected_tokens, 2200);
    assert_eq!(sdk.config.chunk_policy.max_projected_tokens, 4400);
    assert_eq!(sdk.scheduler.mode.as_str(), "manual");
    // The Epic 01 surfaces ride the assembled SDK (functions present).
    let _threads = &sdk.threads;
    let _intake = &sdk.intake_stream;
}

#[test]
fn background_mode_is_a_validated_construction_option() {
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Background,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    assert_eq!(sdk.scheduler.mode.as_str(), "background");
    sdk.scheduler.poke("th_x");
}

#[test]
fn rejects_malformed_config_at_construction() {
    let double = create_inference_callbacks_double();
    // Bad mode / incomplete callbacks: compile-fail UI coverage in tests/ui/.
    // Bad chunkPolicy (max < target) — catch_unwind + reason must name chunkPolicy.
    // Phase 1 init_lhc is todo!("phase 2"): re-raise so the gate classifies notimpl
    // (do not treat bare todo as a successful rejection).
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        init_lhc(SdkConfig {
            inference_callbacks: Some(double.to_callbacks()),
            inference: None,
            mode: SdkMode::Manual,
            clock: None,
            guards: None,
            tool_result: None,
            lease: None,
            chunk_policy: Some(lhc::shared_tech::derivation::ChunkPolicyConfig {
                target_projected_tokens: 4400,
                max_projected_tokens: 2200,
            }),
            view: None,
        })
    }));
    let Err(err) = result else {
        panic!("init_lhc must reject inverted chunkPolicy");
    };
    let msg = panic_message(err);
    if msg.contains("phase 2") || msg.contains("not yet implemented") {
        panic!("{msg}");
    }
    assert!(
        msg.contains("chunkPolicy"),
        "expected chunkPolicy rejection, got {msg}"
    );
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
        .unwrap_or_else(|| "non-string panic payload".into())
}

#[tokio::test]
async fn thread_with_closed_turns_n_closed_turns_read_back_closed() {
    let store = temp_store();
    let built = thread_with_closed_turns(&store, 2).await;
    assert_eq!(built.turn_ids, vec!["t1".to_string(), "t2".to_string()]);
    let listed = turns::list_turns(lhc::ThreadRef::file_path(&built.file_path)).await;
    assert!(listed.is_ok());
    if let lhc::OpResult::Ok { value } = listed {
        assert_eq!(
            value
                .iter()
                .map(|t| (t.turn_id.as_str(), t.status.as_str()))
                .collect::<Vec<_>>(),
            vec![("t1", "closed"), ("t2", "closed"), ("t3", "open")]
        );
        assert_eq!(
            value
                .iter()
                .map(|t| t.member_message_ids.len())
                .collect::<Vec<_>>(),
            vec![2, 2, 0]
        );
    }
    store.cleanup();
}

#[tokio::test]
async fn thread_with_tool_run_call_result_pair_recorded() {
    let store = temp_store();
    let paired = thread_with_tool_run(&store, None).await;
    let paired_messages = messages::list(lhc::ThreadRef::file_path(&paired.file_path), None).await;
    assert!(paired_messages.is_ok());
    if let lhc::OpResult::Ok { value } = paired_messages {
        assert_eq!(
            value.iter().map(|m| m.kind.as_str()).collect::<Vec<_>>(),
            vec!["user_prompt", "tool_call", "tool_result"]
        );
    }

    let errored = thread_with_tool_run(
        &store,
        Some(ToolRunOpts {
            is_error: Some(true),
            ..Default::default()
        }),
    )
    .await;
    let errored_messages =
        messages::list(lhc::ThreadRef::file_path(&errored.file_path), None).await;
    assert!(errored_messages.is_ok());
    if let lhc::OpResult::Ok { value } = errored_messages {
        let result_block = &value[2].blocks[0];
        assert_eq!(result_block.content.get("isError"), Some(&json!(true)));
    }

    let missing = thread_with_tool_run(
        &store,
        Some(ToolRunOpts {
            missing_result: Some(true),
            ..Default::default()
        }),
    )
    .await;
    let missing_messages =
        messages::list(lhc::ThreadRef::file_path(&missing.file_path), None).await;
    assert!(missing_messages.is_ok());
    if let lhc::OpResult::Ok { value } = missing_messages {
        assert_eq!(
            value.iter().map(|m| m.kind.as_str()).collect::<Vec<_>>(),
            vec!["user_prompt", "tool_call"]
        );
    }
    store.cleanup();
}

#[tokio::test]
async fn fc_0_6_multi_state_thread_reads_back_every_claimed_state() {
    let store = temp_store();
    let built = multi_state_thread(&store).await;
    let forms = read_derived_forms(&built.file_path);
    for claim in &built.expected {
        let match_ = forms.iter().find(|f| {
            f.subject_kind == claim.subject_kind
                && f.subject_id == claim.subject_id
                && f.derivation_type == claim.derivation_type.as_str()
        });
        assert!(
            match_.is_some(),
            "{:?}/{}/{}",
            claim.subject_kind,
            claim.subject_id,
            claim.derivation_type.as_str()
        );
        assert_eq!(match_.unwrap().state, claim.state);
    }
    let mut states: Vec<_> = forms.iter().map(|f| f.state.as_str()).collect();
    states.sort();
    states.dedup();
    assert_eq!(states, vec!["blocked", "failed", "pending", "ready"]);
    for form in &forms {
        match form.state {
            DerivationState::Ready => assert!(form.content.is_some()),
            DerivationState::Failed | DerivationState::Blocked => {
                assert!(form.reason.is_some());
                assert!(form.content.is_none());
            }
            DerivationState::Pending => {
                assert!(form.content.is_none());
                assert!(form.reason.is_none());
            }
        }
    }
    store.cleanup();
}

#[tokio::test]
async fn fc_0_3_tool_activity_outcome_lives_in_machine_readable_metadata() {
    let store = temp_store();
    let built = multi_state_thread(&store).await;
    let tool_form = read_derived_forms(&built.file_path)
        .into_iter()
        .find(|f| f.derivation_type == "tool_result_summary");
    assert!(tool_form.is_some());
    let tool_form = tool_form.unwrap();
    assert_eq!(
        serde_json::to_value(tool_form.metadata.as_ref()).unwrap(),
        serde_json::json!({"outcome": "succeeded"})
    );
    assert!(
        !tool_form
            .content
            .as_deref()
            .unwrap_or("")
            .contains("succeeded")
    );
    assert_eq!(tool_form.state.as_str(), "ready");
    store.cleanup();
}

#[tokio::test]
async fn fc_0_6_damaged_source_thread_reads_back_the_corruption_it_claims() {
    let store = temp_store();
    let built = damaged_source_thread(&store).await;
    assert_eq!(built.turn_id, "t1");
    let db = open_raw(&built.file_path);
    let open = db
        .prepare("SELECT COUNT(*) AS n FROM turns WHERE status = 'open'")
        .get();
    assert_eq!(
        open.as_ref()
            .and_then(|m| m.get("n"))
            .and_then(|v| v.as_i64()),
        Some(2)
    );
    db.close();
    let rejected = intake_stream::message_events(
        lhc::ThreadRef::file_path(&built.file_path),
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;
    assert!(!rejected.is_ok());
    if let lhc::OpResult::Err { error } = rejected {
        assert_eq!(error.code, ErrorCode::TurnStateCorrupt);
    }
    let queue_db = open_raw(&built.file_path);
    let queued = queue_db
        .prepare("SELECT kind FROM work_item WHERE owner = 'turns' ORDER BY rowid")
        .all(&[]);
    assert_eq!(
        queued
            .iter()
            .map(|r| r
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string())
            .collect::<Vec<_>>(),
        vec!["turn_derivation".to_string()]
    );
    queue_db.close();
    store.cleanup();
}
