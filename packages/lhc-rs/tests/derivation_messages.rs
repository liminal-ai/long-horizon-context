//! Ported from packages/lhc/test/derivation-messages.test.ts. Phase 1.
//!
//! Story 2 (Epic 02): message-level derivation — Flow 2.
//! Three `#[ignore]` tests preserve full bodies (TS `it.skip`).

mod fixtures;

use std::sync::Arc;

use fixtures::{
    AssistantTextOverrides, InferenceCallbackOpName, TempStore, ToolRunOpts, UserPromptOverrides,
    UserPromptPayload, create_inference_callbacks_double, kind, open_raw, read_derived_forms,
    temp_store, thread_with_tool_run, valid_event,
};
use lhc::intake_stream::BatchResult;
use lhc::shared_tech::derivation::{
    BoxFuture, Derivation, DerivationMetadata, DerivationState, InferenceCallbacks,
    InferenceResult, LeaseConfig, SdkConfig, SdkMode, SubjectKind, ToolOutcome,
};
use lhc::shared_tech::deterministic::{DeterministicOpName, deterministic_text};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::scheduler::{DrainDisposition, DrainReport, DrainStoppedBecause};
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::work_queue::{WorkKind, count_live_items};
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
        OpResult::Err { error } => panic!("thread creation failed: {}", error.reason),
    }
}

fn manual_sdk(inference_callbacks: InferenceCallbacks) -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(inference_callbacks),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
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

fn live_count(file_path: &str) -> i64 {
    let db = open_raw(file_path);
    let n = count_live_items(&db);
    db.close();
    n
}

fn form_of(file_path: &str, subject_id: &str, derivation_type: &str) -> Option<Derivation> {
    read_derived_forms(file_path)
        .into_iter()
        .find(|f| f.subject_id == subject_id && f.derivation_type == derivation_type)
}

#[tokio::test]
async fn intake_a_prompt_drain_smoothed_form_ready_with_the_doubles_deterministic_output() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks());
    let file_path = new_thread(&store).await;
    let text = "please smooth this prompt";
    send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload { text: text.into() }),
                ..Default::default()
            },
        )],
    )
    .await;

    let report = drain(&sdk, &file_path).await;
    assert_eq!(report.ran.len(), 1);
    assert_eq!(report.ran[0].work_item_id, "w-m1-prompt_smoothing-v1");
    assert_eq!(report.ran[0].disposition, DrainDisposition::Done);

    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value } = listed else {
        return;
    };
    let message = &value[0];
    assert_eq!(
        message.blocks[0]
            .content
            .get("text")
            .and_then(|v| v.as_str()),
        Some(text)
    );
    let derivations = message.derivations.as_ref().expect("derivations");
    assert_eq!(derivations.len(), 1);
    let form = &derivations[0];
    assert_eq!(form.subject_kind, SubjectKind::Message);
    assert_eq!(form.subject_id, "m1");
    assert_eq!(form.derivation_type, "smoothed_prompt");
    assert_eq!(form.state, DerivationState::Ready);
    assert_eq!(
        form.content.as_deref(),
        Some(
            deterministic_text(
                DeterministicOpName::SmoothPrompt,
                &json!({ "text": text }),
                text
            )
            .as_str()
        )
    );
    assert_eq!(form.source_version, 1);

    let raw = form_of(&file_path, "m1", "smoothed_prompt").expect("raw");
    assert_eq!(raw.state, DerivationState::Ready);
    assert_eq!(
        raw.content.as_deref(),
        Some(
            deterministic_text(
                DeterministicOpName::SmoothPrompt,
                &json!({ "text": text }),
                text
            )
            .as_str()
        )
    );
}

#[tokio::test]
async fn the_batch_reports_no_queued_item_and_no_derivation_row() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = manual_sdk(double.to_callbacks());
    let file_path = new_thread(&store).await;

    let batch = send(
        &sdk,
        &file_path,
        &[valid_event(kind::TOOL_CALL, Default::default())],
    )
    .await;
    assert_eq!(captured.len(), 0);
    assert!(batch.queued_work.is_empty());

    let report = drain(&sdk, &file_path).await;
    assert!(report.ran.is_empty());
    assert!(form_of(&file_path, "m1", "tool_result_summary").is_none());
}

#[tokio::test]
#[ignore = "skipped in TS source (it.skip)"]
async fn a_300kb_result_drains_to_a_bounded_summary_and_reads_back_whole_through_the_epic_01_surface()
 {
    let store = temp_store();
    let big = "result-bytes ".repeat(24000);
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = manual_sdk(double.to_callbacks());
    let tool_run = thread_with_tool_run(
        &store,
        Some(ToolRunOpts {
            result_content: Some(big.clone()),
            ..Default::default()
        }),
    )
    .await;
    let file_path = tool_run.file_path;

    drain(&sdk, &file_path).await;
    assert_eq!(
        captured
            .snapshot()
            .iter()
            .filter(|e| e.op == InferenceCallbackOpName::SummarizeToolResult)
            .count(),
        1
    );
    let summary = form_of(&file_path, "m3", "tool_result_summary").expect("summary");
    assert_eq!(summary.state, DerivationState::Ready);
    let content = summary.content.as_ref().expect("content");
    assert!(content.starts_with("toolresult("));
    assert!(!content.contains("truncated"));
    assert_eq!(
        summary.metadata,
        Some(DerivationMetadata {
            outcome: Some(ToolOutcome::Succeeded),
            last_error: None,
            discard_reason: None,
            fallback_floor: None,
            fallback_used: None,
            inference_attempted: None,
            inference_succeeded: None,
            size_disposition: None,
            provenance: None,
        })
    );

    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value } = listed else {
        return;
    };
    let result_message = value
        .iter()
        .find(|m| m.kind == lhc::messages::MessageKind::ToolResult)
        .expect("tool_result");
    assert_eq!(
        result_message.blocks[0]
            .content
            .get("content")
            .and_then(|v| v.as_str()),
        Some(big.as_str())
    );
}

#[tokio::test]
#[ignore = "skipped in TS source (it.skip)"]
async fn tool_result_summaries_preserve_succeeded_failed_outcome_from_metadata_alone() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let constant_text = "the tool output says nothing reliable about status";
    let callbacks = InferenceCallbacks {
        smooth_prompt: {
            let d = double.clone();
            Arc::new(move |i| {
                let d = d.clone();
                Box::pin(async move { d.smooth_prompt(i).await }) as BoxFuture<_>
            })
        },
        summarize_tool_result: Arc::new({
            let text = constant_text.to_string();
            move |_| {
                let text = text.clone();
                Box::pin(async move {
                    InferenceResult::Ok {
                        text,
                        provenance: None,
                        request_messages: None,
                        raw_response: None,
                    }
                }) as BoxFuture<_>
            }
        }),
        compress_detailed_turn: {
            let d = double.clone();
            Arc::new(move |i| {
                let d = d.clone();
                Box::pin(async move { d.compress_detailed_turn(i).await }) as BoxFuture<_>
            })
        },
        summarize_chunk_brief: {
            let d = double.clone();
            Arc::new(move |i| {
                let d = d.clone();
                Box::pin(async move { d.summarize_chunk_brief(i).await }) as BoxFuture<_>
            })
        },
    };
    let sdk = manual_sdk(callbacks);
    let content = "model text status fixture ".repeat(1500);
    let ok = thread_with_tool_run(
        &store,
        Some(ToolRunOpts {
            result_content: Some(content.clone()),
            ..Default::default()
        }),
    )
    .await;
    let errored = thread_with_tool_run(
        &store,
        Some(ToolRunOpts {
            result_content: Some(content),
            is_error: Some(true),
            ..Default::default()
        }),
    )
    .await;
    for run in [&ok, &errored] {
        drain(&sdk, &run.file_path).await;
    }

    let summaries = [
        form_of(&ok.file_path, "m3", "tool_result_summary"),
        form_of(&errored.file_path, "m3", "tool_result_summary"),
    ];
    assert_eq!(
        summaries
            .iter()
            .map(|f| f.as_ref().map(|f| f.state))
            .collect::<Vec<_>>(),
        [Some(DerivationState::Ready), Some(DerivationState::Ready)]
    );
    assert_eq!(
        summaries
            .iter()
            .map(|f| f.as_ref().and_then(|f| f.content.clone()))
            .collect::<Vec<_>>(),
        [
            Some(constant_text.to_string()),
            Some(constant_text.to_string())
        ]
    );
    assert_eq!(
        summaries
            .iter()
            .map(|f| f
                .as_ref()
                .and_then(|f| f.metadata.as_ref())
                .and_then(|m| m.outcome))
            .collect::<Vec<_>>(),
        [Some(ToolOutcome::Succeeded), Some(ToolOutcome::Failed)]
    );
}

#[tokio::test]
#[ignore = "skipped in TS source (it.skip)"]
async fn the_captured_tool_result_summary_input_carries_classification_and_outcome() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = manual_sdk(double.to_callbacks());
    let content = "src/file.ts:1:TODO\n".repeat(1200);
    let tool_run = thread_with_tool_run(
        &store,
        Some(ToolRunOpts {
            result_content: Some(content.clone()),
            ..Default::default()
        }),
    )
    .await;
    let file_path = tool_run.file_path;

    drain(&sdk, &file_path).await;
    let inputs: Vec<_> = captured
        .snapshot()
        .into_iter()
        .filter(|e| e.op == InferenceCallbackOpName::SummarizeToolResult)
        .collect();
    assert_eq!(inputs.len(), 1);
    let inp = inputs[0].input.as_object().expect("object");
    let keys: std::collections::BTreeSet<_> = inp.keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "toolName",
            "content",
            "outcome",
            "targetTokens",
            "operationClass",
            "responseShape",
            "promptMode",
            "facts",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    );
    assert_eq!(
        inp.get("toolName").and_then(|v| v.as_str()),
        Some("read_file")
    );
    assert_eq!(
        inp.get("content").and_then(|v| v.as_str()),
        Some(content.as_str())
    );
    assert_eq!(
        inp.get("outcome").and_then(|v| v.as_str()),
        Some("succeeded")
    );
    assert!(
        inp.get("targetTokens").and_then(|v| v.as_i64()).is_some()
            || inp.get("targetTokens").and_then(|v| v.as_f64()).is_some()
    );
    assert_eq!(
        inp.get("operationClass").and_then(|v| v.as_str()),
        Some("unknown")
    );
    assert_eq!(
        inp.get("responseShape").and_then(|v| v.as_str()),
        Some("search_result")
    );
    assert_eq!(
        inp.get("promptMode").and_then(|v| v.as_str()),
        Some("search_summary")
    );
    let facts = inp.get("facts").and_then(|v| v.as_object()).expect("facts");
    assert_eq!(
        facts.get("outcome").and_then(|v| v.as_str()),
        Some("succeeded")
    );
    assert!(!inp.contains_key("guidance"));
}

#[tokio::test]
async fn smoothing_failure_lands_failed_with_the_inference_callback_reason_read_back_is_unaffected()
{
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks());
    let file_path = new_thread(&store).await;
    let text = "this prompt will never smooth";
    send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload { text: text.into() }),
                ..Default::default()
            },
        )],
    )
    .await;

    double.fail_kind(
        "prompt_smoothing",
        99,
        Some("scripted failure (smoothPrompt)"),
    );
    let report = drain(&sdk, &file_path).await;
    assert_eq!(report.ran.len(), 1);
    assert_eq!(report.ran[0].work_item_id, "w-m1-prompt_smoothing-v1");
    assert_eq!(report.ran[0].disposition, DrainDisposition::FailedTerminal);
    assert_eq!(
        report.ran[0].reason.as_deref(),
        Some("scripted failure (smoothPrompt)")
    );

    let form = form_of(&file_path, "m1", "smoothed_prompt").expect("form");
    assert_eq!(form.state, DerivationState::Failed);
    assert_eq!(
        form.reason.as_deref(),
        Some("scripted failure (smoothPrompt)")
    );
    assert!(form.content.is_none());

    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value } = listed else {
        return;
    };
    assert_eq!(value.len(), 1);
    assert_eq!(
        value[0].blocks[0]
            .content
            .get("text")
            .and_then(|v| v.as_str()),
        Some(text)
    );
}

#[tokio::test]
async fn message_source_damage_lands_blocked_rather_than_failed() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks());
    let file_path = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[valid_event(kind::USER_PROMPT, Default::default())],
    )
    .await;

    let db = open_raw(&file_path);
    db.prepare(
        "UPDATE message_block SET content = '{}' WHERE message_id = 'm1' AND block_index = 0",
    )
    .run(&[]);
    db.close();

    let report = drain(&sdk, &file_path).await;
    assert_eq!(report.ran.len(), 1);
    assert_eq!(report.ran[0].work_item_id, "w-m1-prompt_smoothing-v1");
    assert_eq!(report.ran[0].disposition, DrainDisposition::FailedTerminal);
    assert_eq!(
        report.ran[0].reason.as_deref(),
        Some("source_damaged: prompt m1 has no text block")
    );
    let form = form_of(&file_path, "m1", "smoothed_prompt").expect("form");
    assert_eq!(form.state, DerivationState::Blocked);
    assert_eq!(
        form.reason.as_deref(),
        Some("source_damaged: prompt m1 has no text block")
    );
    let _ = SqlParam::from("");
    let _ = AssistantTextOverrides::default();
}

#[tokio::test]
async fn assistant_text_a_runtime_note_and_assistant_thinking_no_items_no_derivation_rows_an_empty_drain()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks());
    let file_path = new_thread(&store).await;

    let batch = send(
        &sdk,
        &file_path,
        &[
            valid_event(kind::ASSISTANT_TEXT, Default::default()),
            valid_event(kind::RUNTIME_NOTE, Default::default()),
            valid_event(kind::ASSISTANT_THINKING, Default::default()),
        ],
    )
    .await;
    assert!(batch.queued_work.is_empty());
    assert_eq!(live_count(&file_path), 0);

    let report = drain(&sdk, &file_path).await;
    assert!(report.ran.is_empty());
    assert_eq!(report.stopped_because, DrainStoppedBecause::Empty);
    assert!(read_derived_forms(&file_path).is_empty());
}

#[tokio::test]
async fn tool_calls_create_no_work_item_or_derivation_row() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks());
    let file_path = new_thread(&store).await;

    let batch = send(
        &sdk,
        &file_path,
        &[
            valid_event(kind::TOOL_CALL, Default::default()),
            valid_event(kind::TOOL_RESULT, Default::default()),
        ],
    )
    .await;
    assert_eq!(
        batch.queued_work.iter().map(|i| i.kind).collect::<Vec<_>>(),
        [WorkKind::ToolResultSummary]
    );

    drain(&sdk, &file_path).await;
    assert_eq!(
        read_derived_forms(&file_path)
            .iter()
            .map(|f| f.derivation_type.as_str())
            .collect::<Vec<_>>(),
        ["tool_result_summary"]
    );
    assert_eq!(live_count(&file_path), 0);
}
