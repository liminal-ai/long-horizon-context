//! Ported from packages/lhc/test/turn-cascade.test.ts. Phase 1.

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, AssistantThinkingOverrides,
    AssistantThinkingPayload, InferenceCallbackOpName, RuntimeNoteOverrides, RuntimeNotePayload,
    TempStore, ToolCallOverrides, ToolCallPayload, ToolResultOverrides, ToolResultPayload,
    UserPromptOverrides, UserPromptPayload, create_inference_callbacks_double, kind, open_raw,
    read_derived_forms, temp_store, valid_event,
};
use lhc::sdk::DrainOpts;
use lhc::shared_tech::derivation::{
    Derivation, DerivationState, InferenceCallbacks, LeaseConfig, SdkConfig, SdkMode,
};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::inference_types::{
    DerivationGuards, DetailedTurnCompressionGuards, SmoothedPromptGuards,
};
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::logging::{LogLevel, LogQuery};
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::tool_result_rendering::truncate_for_fallback;
use lhc::shared_tech::work_queue::{count_live_items, queue_detail};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc, threads};
use serde_json::{Map, Value, json};

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

fn sdk_for(inference_callbacks: InferenceCallbacks, guards: Option<DerivationGuards>) -> Lhc {
    let guards = match guards {
        None => DerivationGuards {
            smoothed_prompt: None,
            tool_result_summary: None,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: Some(1),
            }),
        },
        Some(g) => DerivationGuards {
            smoothed_prompt: g.smoothed_prompt,
            tool_result_summary: g.tool_result_summary,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: g
                    .detailed_turn_compression
                    .and_then(|d| d.tiny_turn_tokens)
                    .or(Some(1)),
            }),
        },
    };
    init_lhc(SdkConfig {
        inference_callbacks: Some(inference_callbacks),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: Some(guards),
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
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

fn form_of(file_path: &str, subject_id: &str, derivation_type: &str) -> Option<Derivation> {
    read_derived_forms(file_path)
        .into_iter()
        .find(|f| f.subject_id == subject_id && f.derivation_type == derivation_type)
}

fn rendering_content(file_path: &str) -> String {
    // TS: find by derivationType === "turn_rendering" only (no subject-id probe).
    read_derived_forms(file_path)
        .into_iter()
        .find(|f| f.derivation_type == "turn_rendering")
        .and_then(|f| f.content)
        .unwrap_or_default()
}

fn strip_entity_xml(body: &str) -> String {
    // Block wrap: <mN>\n…\n</mN>. Tool-run lines: <mN>…</mN> on each line.
    if let Some(rest) = body.strip_prefix('<') {
        if let Some((tag, after_open)) = rest.split_once('>') {
            if tag.starts_with('m') && tag[1..].chars().all(|c| c.is_ascii_digit()) {
                let close = format!("</{tag}>");
                if let Some(inner) = after_open.strip_prefix('\n') {
                    if let Some(inner) = inner.strip_suffix(&close) {
                        return inner.strip_suffix('\n').unwrap_or(inner).to_string();
                    }
                }
            }
        }
    }
    // Strip inline <mN>…</mN> tags (tool-run member lines).
    let mut out = String::new();
    let mut rest = body;
    while let Some(lt) = rest.find('<') {
        out.push_str(&rest[..lt]);
        let after_lt = &rest[lt + 1..];
        let Some(gt) = after_lt.find('>') else {
            out.push_str(&rest[lt..]);
            return out;
        };
        let tag = &after_lt[..gt];
        let after_gt = &after_lt[gt + 1..];
        if tag.starts_with('m') && tag[1..].chars().all(|c| c.is_ascii_digit()) {
            let close = format!("</{tag}>");
            if let Some(close_at) = after_gt.find(&close) {
                out.push_str(&after_gt[..close_at]);
                rest = &after_gt[close_at + close.len()..];
                continue;
            }
        }
        out.push('<');
        out.push_str(tag);
        out.push('>');
        rest = after_gt;
    }
    out.push_str(rest);
    out
}

fn strip_outer_turn_xml(content: &str) -> String {
    let Some(rest) = content.strip_prefix('<') else {
        return content.to_string();
    };
    let Some((tag, after_open)) = rest.split_once('>') else {
        return content.to_string();
    };
    if !(tag.starts_with('t') && tag[1..].chars().all(|c| c.is_ascii_digit())) {
        return content.to_string();
    }
    let close = format!("</{tag}>");
    let Some(inner) = after_open.strip_prefix('\n') else {
        return content.to_string();
    };
    let Some(inner) = inner.strip_suffix(&close) else {
        return content.to_string();
    };
    inner.strip_suffix('\n').unwrap_or(inner).to_string()
}

fn rendering_bodies(file_path: &str) -> Vec<String> {
    let content = strip_outer_turn_xml(&rendering_content(file_path));
    content
        .split("\n\n")
        .map(|part| {
            let body = part.split('\n').skip(1).collect::<Vec<_>>().join("\n");
            strip_entity_xml(&body)
        })
        .collect()
}

fn exec_sql(file_path: &str, sql: &str, params: &[SqlParam]) {
    let db = open_raw(file_path);
    db.prepare(sql).run(params);
    db.close();
}

fn delete_work_item(file_path: &str, work_item_id: &str) {
    exec_sql(
        file_path,
        "DELETE FROM work_item WHERE work_item_id = ?",
        &[SqlParam::from(work_item_id)],
    );
}

fn tool_args(path: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("path".into(), json!(path));
    m
}

fn tool_call(
    id: &str,
    name: &str,
    args: Map<String, Value>,
) -> lhc::intake_stream::MessageEventInput {
    valid_event(
        kind::TOOL_CALL,
        ToolCallOverrides {
            payload: Some(ToolCallPayload {
                tool_call_id: id.into(),
                tool_name: name.into(),
                arguments: args,
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
async fn uses_ready_derivations_directly_and_writes_no_fallback_log() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "ready prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path, None).await;

    let smoothed = form_of(&file_path, "m1", "smoothed_prompt");
    let smoothed_content = smoothed.as_ref().and_then(|s| s.content.clone());
    assert_eq!(
        rendering_bodies(&file_path).first(),
        smoothed_content.as_ref()
    );

    let logs = sdk
        .logging
        .query(
            ThreadRef::file_path(&file_path),
            LogQuery {
                level: None,
                derivation_type: None,
                subject_id: None,
                reason: Some("not_ready".into()),
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
async fn falls_pending_derivations_to_deterministic_floors_when_re_derivation_does_not_complete() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    double.fail_kind("smoothed_prompt", 1, Some("recovery unavailable"));
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "  pending    prompt because i asked  ".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    drain(&sdk, &file_path, None).await;

    assert_eq!(
        rendering_bodies(&file_path).first().map(String::as_str),
        Some("pending prompt because I asked")
    );
    let form = form_of(&file_path, "m1", "smoothed_prompt").expect("form");
    assert_eq!(form.state, DerivationState::Ready);
    assert_eq!(
        form.content.as_deref(),
        Some("pending prompt because I asked")
    );

    let logs = sdk
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
    assert!(logs.is_ok());
    let OpResult::Ok { value } = logs else {
        return;
    };
    assert_eq!(
        value
            .iter()
            .map(|e| (
                e.subject_id.as_deref(),
                e.reason.as_deref(),
                e.floor_used.as_deref()
            ))
            .collect::<Vec<_>>(),
        [(
            Some("m1"),
            Some("not_ready"),
            Some("pending prompt because I asked")
        )]
    );
}

#[tokio::test]
async fn falls_back_to_original_prompt_source_when_the_deterministic_floor_is_unavailable() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    double.fail_kind("smoothed_prompt", 1, Some("recovery unavailable"));
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;
    let original = " \t\n  ";

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: original.into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    drain(&sdk, &file_path, None).await;

    assert_eq!(
        rendering_bodies(&file_path).first().map(String::as_str),
        Some(original)
    );
    let form = form_of(&file_path, "m1", "smoothed_prompt").expect("form");
    assert_eq!(form.state, DerivationState::Ready);
    assert_eq!(form.content.as_deref(), Some(original));
}

#[tokio::test]
async fn falls_failed_derivations_through_the_same_floor_path_when_re_derivation_does_not_complete()
{
    let store = temp_store();
    let double = create_inference_callbacks_double();
    double.fail_kind("smoothed_prompt", 1, Some("recovery unavailable"));
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "  failed    prompt because i asked  ".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    exec_sql(
        &file_path,
        "UPDATE derivation SET state = 'failed', reason = 'terminal'
         WHERE subject_id = ? AND derivation_type = 'smoothed_prompt'",
        &[SqlParam::from("m1")],
    );
    drain(&sdk, &file_path, None).await;

    assert_eq!(
        rendering_bodies(&file_path).first().map(String::as_str),
        Some("failed prompt because I asked")
    );
    let form = form_of(&file_path, "m1", "smoothed_prompt").expect("form");
    assert_eq!(form.state, DerivationState::Ready);
    assert_eq!(
        form.content.as_deref(),
        Some("failed prompt because I asked")
    );
}

#[tokio::test]
async fn uses_deterministic_floors_for_failed_message_derivations_without_calling_message_inference()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "  recover    me  ".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    exec_sql(
        &file_path,
        "UPDATE derivation SET state = 'failed', reason = 'terminal'
         WHERE subject_id = ? AND derivation_type = 'smoothed_prompt'",
        &[SqlParam::from("m1")],
    );
    let calls_before_turn = captured.len();
    drain(&sdk, &file_path, None).await;

    assert!(
        captured
            .snapshot()
            .iter()
            .skip(calls_before_turn)
            .filter(|e| e.op == InferenceCallbackOpName::SmoothPrompt)
            .count()
            == 0
    );
    assert_eq!(
        rendering_bodies(&file_path).first().map(String::as_str),
        Some("recover me")
    );
    let form = form_of(&file_path, "m1", "smoothed_prompt").expect("form");
    assert_eq!(form.state, DerivationState::Ready);
    assert_eq!(form.content.as_deref(), Some("recover me"));
    assert!(form.reason.is_none());
    let logs = sdk
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
    assert!(logs.is_ok());
    let OpResult::Ok { value } = logs else {
        return;
    };
    assert_eq!(
        value
            .iter()
            .map(|e| (e.subject_id.as_deref(), e.reason.as_deref()))
            .collect::<Vec<_>>(),
        [(Some("m1"), Some("failed_floor"))]
    );
}

#[tokio::test]
async fn does_not_overwrite_an_already_ready_message_derivation_when_composing_the_turn() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "  race    prompt because i asked  ".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(1) })).await;
    exec_sql(
        &file_path,
        "UPDATE derivation
         SET state = 'ready', content = ?, reason = NULL, derived_at = ?
         WHERE subject_id = ? AND derivation_type = 'smoothed_prompt'",
        &[
            SqlParam::from("real worker output"),
            SqlParam::from("2026-01-01T00:00:00.000Z"),
            SqlParam::from("m1"),
        ],
    );

    let derived = sdk
        .turns
        .derive_turn(ThreadRef::file_path(&file_path), "t1")
        .await;
    assert!(derived.is_ok());
    assert_eq!(
        rendering_bodies(&file_path).first().map(String::as_str),
        Some("real worker output")
    );
    let form = form_of(&file_path, "m1", "smoothed_prompt").expect("form");
    assert_eq!(form.state, DerivationState::Ready);
    assert_eq!(form.content.as_deref(), Some("real worker output"));
}

#[tokio::test]
async fn renders_assistant_text_thinking_and_runtime_notes_verbatim_in_record_order() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "order check".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("first answer")),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_THINKING,
                AssistantThinkingOverrides {
                    payload: Some(AssistantThinkingPayload::new("thinking exactly")),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::RUNTIME_NOTE,
                RuntimeNoteOverrides {
                    payload: Some(RuntimeNotePayload {
                        text: "runtime changed exactly".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("second answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path, None).await;

    let smoothed = form_of(&file_path, "m1", "smoothed_prompt");
    let smoothed_content = smoothed.as_ref().and_then(|s| s.content.clone());
    let bodies = rendering_bodies(&file_path);
    // Compare Option so a missing form cannot masquerade as empty string.
    assert_eq!(bodies.first(), smoothed_content.as_ref());
    assert_eq!(
        &bodies[1..],
        [
            "first answer".to_string(),
            "thinking exactly".to_string(),
            "runtime changed exactly".to_string(),
            "second answer".to_string(),
        ]
    );
}

#[tokio::test]
async fn floors_small_tool_result_summaries_without_calling_message_inference_during_turn_construction()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;
    let content = "tool-output";

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "summarize tool".into(),
                    }),
                    ..Default::default()
                },
            ),
            tool_call("call", "read_file", tool_args("large.txt")),
            tool_result("call", content, false),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    delete_work_item(&file_path, "w-m3-tool_result_summary-v1");
    let calls_before_turn = captured.len();
    drain(&sdk, &file_path, None).await;

    assert!(
        captured
            .snapshot()
            .iter()
            .skip(calls_before_turn)
            .filter(|e| e.op == InferenceCallbackOpName::SummarizeToolResult)
            .count()
            == 0
    );
    let floored = truncate_for_fallback(content);
    assert!(rendering_content(&file_path).contains(&floored));
    let form = form_of(&file_path, "m3", "tool_result_summary").expect("form");
    assert_eq!(form.state, DerivationState::Ready);
    assert_eq!(form.content.as_deref(), Some(floored.as_str()));
}

#[tokio::test]
async fn floors_over_large_failed_tool_result_summaries_with_deterministic_truncation_and_no_turn_time_inference()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;
    let content = "large-result-token ".repeat(6000);

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "summarize the large result".into(),
                    }),
                    ..Default::default()
                },
            ),
            tool_call("call", "read_file", tool_args("huge.log")),
            tool_result("call", &content, false),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    exec_sql(
        &file_path,
        "UPDATE derivation
         SET state = 'failed', content = NULL, reason = 'scripted failure'
         WHERE subject_kind = 'message'
           AND subject_id = 'm3'
           AND derivation_type = 'tool_result_summary'",
        &[],
    );
    delete_work_item(&file_path, "w-m3-tool_result_summary-v1");
    let calls_before_turn = captured.len();
    drain(&sdk, &file_path, None).await;

    assert!(
        captured
            .snapshot()
            .iter()
            .skip(calls_before_turn)
            .filter(|e| e.op == InferenceCallbackOpName::SummarizeToolResult)
            .count()
            == 0
    );
    let floored = form_of(&file_path, "m3", "tool_result_summary").expect("floored");
    assert_eq!(floored.state, DerivationState::Ready);
    let floored_content = floored.content.as_ref().expect("content");
    assert!(floored_content.contains("large-result-token"));
    assert!(floored_content.len() < content.len());
    let rendering = rendering_content(&file_path);
    assert!(rendering.contains(floored_content.as_str()));
    assert!(rendering.contains("[fallback; outcome: succeeded]"));
}

#[tokio::test]
async fn floors_failed_tool_result_summaries_during_turn_construction_without_re_running_classification_inference()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;
    let content = "search-hit ".repeat(1500);
    let mut args = Map::new();
    args.insert("command".into(), json!("rg TODO src"));

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "summarize search output".into(),
                    }),
                    ..Default::default()
                },
            ),
            tool_call("call", "bash", args),
            tool_result("call", &content, true),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    delete_work_item(&file_path, "w-m3-tool_result_summary-v1");
    let calls_before_turn = captured.len();
    drain(&sdk, &file_path, None).await;

    assert!(
        captured
            .snapshot()
            .iter()
            .skip(calls_before_turn)
            .filter(|e| e.op == InferenceCallbackOpName::SummarizeToolResult)
            .count()
            == 0
    );
    let floored = form_of(&file_path, "m3", "tool_result_summary").expect("floored");
    assert_eq!(floored.state, DerivationState::Ready);
    let floored_content = floored.content.as_ref().expect("content");
    assert!(floored_content.contains("search-hit"));
    assert!(floored_content.len() < content.len());
    let rendering = rendering_content(&file_path);
    assert!(rendering.contains(floored_content.as_str()));
    assert!(rendering.contains("[fallback; outcome: failed]"));
}

#[tokio::test]
async fn recovers_over_cap_prompts_with_deterministic_cleaned_text_and_no_smoothing_model_call() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = sdk_for(
        double.to_callbacks(),
        Some(DerivationGuards {
            smoothed_prompt: Some(SmoothedPromptGuards {
                max_inference_tokens: Some(1),
                suspicious_output_ratio: None,
            }),
            tool_result_summary: None,
            detailed_turn_compression: None,
        }),
    );
    let file_path = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "  please    fix this because i asked  ".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    drain(&sdk, &file_path, None).await;

    assert!(
        captured
            .snapshot()
            .iter()
            .filter(|e| e.op == InferenceCallbackOpName::SmoothPrompt)
            .count()
            == 0
    );
    let form = form_of(&file_path, "m1", "smoothed_prompt").expect("form");
    assert_eq!(form.state, DerivationState::Ready);
    assert_eq!(
        form.content.as_deref(),
        Some("please fix this because I asked")
    );
}

#[tokio::test]
async fn logs_fallback_when_a_message_derivation_row_is_absent() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "summarize the missing row".into(),
                    }),
                    ..Default::default()
                },
            ),
            tool_call("call", "read_file", tool_args("missing.txt")),
            tool_result("call", "rowless output", false),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    delete_work_item(&file_path, "w-m3-tool_result_summary-v1");
    exec_sql(
        &file_path,
        "DELETE FROM derivation
         WHERE subject_kind = 'message'
           AND subject_id = 'm3'
           AND derivation_type = 'tool_result_summary'",
        &[],
    );
    drain(&sdk, &file_path, None).await;

    let queried = sdk
        .logging
        .query(
            ThreadRef::file_path(&file_path),
            LogQuery {
                level: None,
                derivation_type: Some("tool_result_summary".into()),
                subject_id: None,
                reason: None,
            },
        )
        .await;
    assert!(queried.is_ok());
    let OpResult::Ok { value } = queried else {
        return;
    };
    assert_eq!(value.len(), 1);
    assert_eq!(value[0].level, LogLevel::Warning);
    assert_eq!(value[0].message, "derivation fallback used");
    assert_eq!(
        value[0].derivation_type.as_deref(),
        Some("tool_result_summary")
    );
    assert_eq!(value[0].subject_id.as_deref(), Some("m3"));
    assert_eq!(value[0].reason.as_deref(), Some("not_ready"));
    assert_eq!(value[0].floor_used.as_deref(), Some("rowless output"));
    let form = form_of(&file_path, "m3", "tool_result_summary").expect("form");
    assert_eq!(form.state, DerivationState::Ready);
    assert_eq!(form.content.as_deref(), Some("rowless output"));
}

#[tokio::test]
async fn constructs_a_turn_with_every_component_present_when_multiple_derivations_are_not_ready() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    double.fail_kind("smoothed_prompt", 1, Some("recovery unavailable"));
    double.fail_kind("tool_result_summary", 1, Some("recovery unavailable"));
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "  multi    fallback because i asked  ".into(),
                    }),
                    ..Default::default()
                },
            ),
            tool_call("call", "read_file", tool_args("multi.txt")),
            tool_result("call", "tool-output", false),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("answer after tool")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    delete_work_item(&file_path, "w-m3-tool_result_summary-v1");
    drain(&sdk, &file_path, None).await;

    let rendering = rendering_content(&file_path);
    assert!(rendering.contains("multi fallback because I asked"));
    assert!(rendering.contains(r#"read_file({"path":"multi.txt"})"#));
    assert!(rendering.contains("tool-output"));
    assert!(rendering.contains("answer after tool"));
    let form_m1 = form_of(&file_path, "m1", "smoothed_prompt").expect("m1");
    assert_eq!(form_m1.state, DerivationState::Ready);
    assert_eq!(
        form_m1.content.as_deref(),
        Some("multi fallback because I asked")
    );
    let form_m3 = form_of(&file_path, "m3", "tool_result_summary").expect("m3");
    assert_eq!(form_m3.state, DerivationState::Ready);
    assert_eq!(form_m3.content.as_deref(), Some("tool-output"));
}

#[tokio::test]
async fn leaves_derivation_rows_untouched_when_live_work_exists_but_still_renders_a_floor() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "  live    work because i asked  ".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    let source_ref = js_json_stringify(&json!({ "messageId": "m1" }));
    let payload = js_json_stringify(&json!({
        "sourceVersion": 1,
        "derivations": [{
            "subjectKind": "message",
            "subjectId": "m1",
            "derivationType": "smoothed_prompt",
        }],
    }));
    exec_sql(
        &file_path,
        "INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
         VALUES (?, 'messages', 'prompt_smoothing', ?, 'queued', ?, ?)",
        &[
            SqlParam::from("w-m1-prompt_smoothing-v1-live"),
            SqlParam::from(source_ref.as_str()),
            SqlParam::from("2026-01-01T00:00:00.000Z"),
            SqlParam::from(payload.as_str()),
        ],
    );

    drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(1) })).await;

    assert_eq!(
        rendering_bodies(&file_path).first().map(String::as_str),
        Some("live work because I asked")
    );
    let form = form_of(&file_path, "m1", "smoothed_prompt").expect("form");
    assert_eq!(form.state, DerivationState::Pending);

    let db = open_raw(&file_path);
    assert_eq!(count_live_items(&db), 2);
    assert_eq!(
        queue_detail(&db)[0].work_item_id,
        "w-m1-prompt_smoothing-v1-live"
    );
    db.close();
}
