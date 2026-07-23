//! Ported from packages/lhc/test/tool-result-rendering.test.ts. Phase 1.

mod fixtures;

use lhc::OpResult;
use lhc::shared_tech::derivation::{LeaseConfig, SdkConfig, SdkMode};
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::threads::NewThreadInput;
use lhc::{
    BatchResult, DrainReport, Lhc, MessageEventInput, ThreadRef, count_live_items, init_lhc,
    threads,
};
use serde_json::json;

use fixtures::{
    TempStore, ToolCallOverrides, ToolCallPayload, ToolResultOverrides, ToolResultPayload,
    TurnEndOverrides, UserPromptOverrides, UserPromptPayload, create_inference_callbacks_double,
    kind, open_raw, read_derived_forms, temp_store, valid_event,
};
use serde_json::Map;

async fn new_thread(store: &TempStore) -> String {
    let created = threads::new_thread(NewThreadInput {
        file_path: store.thread_path(None).to_string_lossy().into_owned(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await;
    match created {
        OpResult::Ok { value } => value.file_path,
        OpResult::Err { error } => panic!("thread creation failed: {}", error.reason),
    }
}

fn sdk_for(double: &fixtures::InferenceCallbacksDouble) -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
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

async fn send(sdk: &Lhc, file_path: &str, batch: &[MessageEventInput]) -> BatchResult {
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

fn form_of<'a>(
    forms: &'a [lhc::Derivation],
    subject_id: &str,
    derivation_type: &str,
) -> Option<&'a lhc::Derivation> {
    forms
        .iter()
        .find(|f| f.subject_id == subject_id && f.derivation_type == derivation_type)
}

fn live_count(file_path: &str) -> i64 {
    let db = open_raw(file_path);
    let n = count_live_items(&db);
    db.close();
    n
}

#[tokio::test]
#[ignore = "skipped in TS source (it.skip)"]
async fn large_tool_results_queue_work_and_reach_inference() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = sdk_for(&double);
    let file_path = new_thread(&store).await;
    let content = "result-token ".repeat(6000);

    let batch = send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "large".into(),
                        tool_name: "read_file".into(),
                        arguments: json!({"path": "huge.log"}).as_object().unwrap().clone(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "large".into(),
                        content: content.clone(),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ),
        ],
    )
    .await;

    assert_eq!(
        batch
            .queued_work
            .iter()
            .map(|i| i.work_item_id.as_str())
            .collect::<Vec<_>>(),
        vec!["w-m2-tool_result_summary-v1"]
    );
    assert_eq!(live_count(&file_path), 1);
    drain(&sdk, &file_path).await;

    let calls: Vec<_> = captured
        .snapshot()
        .into_iter()
        .filter(|e| e.op == fixtures::InferenceCallbackOpName::SummarizeToolResult)
        .collect();
    assert_eq!(calls.len(), 1);
    let inp = &calls[0].input;
    assert_eq!(inp["toolName"], "read_file");
    assert_eq!(inp["content"], content);
    assert_eq!(inp["outcome"], "succeeded");
    assert_eq!(inp["operationClass"], "unknown");
    assert_eq!(inp["responseShape"], "large_log");
    assert_eq!(inp["promptMode"], "large_log");
    assert!(inp["facts"].is_object());
    assert_eq!(inp["facts"]["outcome"], "succeeded");
    assert_eq!(inp["facts"]["noOutput"], false);
    assert!(inp.get("guidance").is_none());
    let forms = read_derived_forms(&file_path);
    let form = form_of(&forms, "m2", "tool_result_summary");
    assert!(form.is_some());
    let form = form.unwrap();
    assert_eq!(form.state.as_str(), "ready");
    assert_eq!(
        form.metadata.as_ref().and_then(|m| m.outcome),
        Some(lhc::ToolOutcome::Succeeded)
    );
    assert!(!form.content.as_deref().unwrap_or("").contains("truncated"));

    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(listed.is_ok());
    if let OpResult::Ok { value } = listed {
        let msg = value.iter().find(|m| m.message_id == "m2");
        assert!(msg.is_some());
        assert_eq!(
            msg.unwrap().blocks[0].content.get("content"),
            Some(&json!(content))
        );
    }
    store.cleanup();
}

#[tokio::test]
#[ignore = "skipped in TS source (it.skip)"]
async fn small_results_pass_through_while_larger_results_classify_before_queued_inference() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = sdk_for(&double);
    let file_path = new_thread(&store).await;
    let small = "small-result ".repeat(100);
    let mid = "mid-result ".repeat(1500);
    let batch = send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "small".into(),
                        tool_name: "read".into(),
                        arguments: json!({"path": "a.txt"}).as_object().unwrap().clone(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "small".into(),
                        content: small.clone(),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "mid".into(),
                        tool_name: "bash".into(),
                        arguments: json!({"command": "rg TODO src"})
                            .as_object()
                            .unwrap()
                            .clone(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "mid".into(),
                        content: mid.clone(),
                        is_error: Some(true),
                    }),
                    ..Default::default()
                },
            ),
        ],
    )
    .await;
    assert_eq!(
        batch
            .queued_work
            .iter()
            .map(|i| i.work_item_id.as_str())
            .collect::<Vec<_>>(),
        vec!["w-m2-tool_result_summary-v1", "w-m4-tool_result_summary-v1"]
    );
    let report = drain(&sdk, &file_path).await;
    assert_eq!(
        report
            .ran
            .iter()
            .map(|e| e.disposition.as_str())
            .collect::<Vec<_>>(),
        vec!["done", "done"]
    );
    let calls: Vec<_> = captured
        .snapshot()
        .into_iter()
        .filter(|e| e.op == fixtures::InferenceCallbackOpName::SummarizeToolResult)
        .collect();
    assert_eq!(calls.len(), 1);
    let inp = &calls[0].input;
    assert_eq!(inp["toolName"], "bash");
    assert_eq!(inp["content"], mid);
    assert_eq!(inp["outcome"], "failed");
    assert_eq!(inp["operationClass"], "search_or_listing");
    assert_eq!(inp["responseShape"], "search_result");
    assert_eq!(inp["promptMode"], "search_summary");
    assert_eq!(inp["facts"]["command"], "rg TODO src");
    assert_eq!(inp["facts"]["outcome"], "failed");
    assert!(inp.get("guidance").is_none());
    let forms = read_derived_forms(&file_path);
    assert_eq!(
        form_of(&forms, "m2", "tool_result_summary").and_then(|f| f.content.clone()),
        Some(small)
    );
    let meta = form_of(&forms, "m4", "tool_result_summary").and_then(|f| f.metadata.clone());
    assert_eq!(
        serde_json::to_value(&meta).unwrap(),
        json!({"outcome": "failed"})
    );
    store.cleanup();
}

#[tokio::test]
async fn tool_call_arguments_render_as_recorded() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = sdk_for(&double);
    let file_path = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "run it".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "call".into(),
                        tool_name: "exec".into(),
                        arguments: json!({"cmd": "pnpm test"}).as_object().unwrap().clone(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "call".into(),
                        content: "passed".into(),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path).await;
    let rendering = read_derived_forms(&file_path)
        .into_iter()
        .find(|f| f.derivation_type == "turn_rendering");
    assert!(rendering.is_some());
    let args = js_json_stringify(&json!({"cmd": "pnpm test"}));
    assert!(
        rendering
            .unwrap()
            .content
            .as_deref()
            .unwrap_or("")
            .contains(&format!("exec({args})"))
    );
    store.cleanup();
}

#[tokio::test]
async fn tail_tool_call_rendering_preserves_long_recorded_arguments_without_truncation() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = sdk_for(&double);
    let file_path = new_thread(&store).await;
    let cmd = "x".repeat(240);
    let args = js_json_stringify(&json!({"cmd": cmd}));
    send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: "long-call".into(),
                    tool_name: "exec".into(),
                    arguments: {
                        let mut m = Map::new();
                        m.insert("cmd".into(), json!(cmd));
                        m
                    },
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    let context_read = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(context_read.is_ok());
    if let OpResult::Ok { value } = context_read {
        let rendered: String = value
            .messages
            .iter()
            .map(|m| {
                m.content
                    .iter()
                    .map(|p| p.text.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains(&format!("[tool call · exec] {args}")));
        assert!(!rendered.contains("truncated"));
    }
    store.cleanup();
}

#[tokio::test]
#[ignore = "skipped in TS source (it.skip)"]
async fn terminal_summary_failure_lands_failed_with_reason_while_source_result_remains_intact() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    double.fail_kind(
        "tool_result_summary",
        99,
        Some("scripted tool summary failure"),
    );
    let sdk = sdk_for(&double);
    let file_path = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "fail".into(),
                        tool_name: "read_file".into(),
                        arguments: json!({"path": "x"}).as_object().unwrap().clone(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "fail".into(),
                        content: "failure target ".repeat(1500),
                        is_error: Some(true),
                    }),
                    ..Default::default()
                },
            ),
        ],
    )
    .await;
    let report = drain(&sdk, &file_path).await;
    assert_eq!(report.ran.len(), 1);
    assert_eq!(report.ran[0].work_item_id, "w-m2-tool_result_summary-v1");
    assert_eq!(report.ran[0].disposition.as_str(), "failed_terminal");
    assert_eq!(
        report.ran[0].reason.as_deref(),
        Some("scripted tool summary failure")
    );
    let forms = read_derived_forms(&file_path);
    let form = form_of(&forms, "m2", "tool_result_summary").unwrap();
    assert_eq!(form.state.as_str(), "failed");
    assert_eq!(
        form.reason.as_deref(),
        Some("scripted tool summary failure")
    );
    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(listed.is_ok());
    if let OpResult::Ok { value } = listed {
        let msg = value.iter().find(|m| m.message_id == "m2").unwrap();
        assert_eq!(
            msg.blocks[0].content.get("content"),
            Some(&json!("failure target ".repeat(1500)))
        );
    }
    store.cleanup();
}
