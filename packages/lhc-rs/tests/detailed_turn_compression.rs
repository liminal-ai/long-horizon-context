//! Ported from packages/lhc/test/detailed-turn-compression.test.ts. Phase 1.

mod fixtures;

use std::sync::{Arc, Mutex};

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, AssistantThinkingOverrides,
    AssistantThinkingPayload, InferenceCallbackOpName, TempStore, ToolCallOverrides,
    ToolCallPayload, ToolResultOverrides, ToolResultPayload, UserPromptOverrides,
    UserPromptPayload, create_inference_callbacks_double, kind, open_raw, read_chunks,
    read_derived_forms, temp_store, valid_event,
};
use lhc::intake_stream::BatchResult;
use lhc::sdk::DrainOpts;
use lhc::shared_tech::derivation::{
    BoxFuture, CompressDetailedTurnInput, Derivation, DerivationState, InferenceCallbacks,
    InferenceResult, LeaseConfig, SdkConfig, SdkMode, SizeDisposition,
};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::inference_types::{
    DerivationGuards, DetailedTurnCompressionGuards, InferenceConfig, ModelCall, ModelCallInput,
    ModelCallResult,
};
use lhc::shared_tech::logging::{DerivationLogEventKind, DerivationLogQuery, LogLevel, LogQuery};
use lhc::shared_tech::scheduler::{DrainDisposition, DrainReport};
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc, threads};
use serde_json::{Map, Value, json};

/// JS `Math.round` for non-negative values: `floor(x + 0.5)`.
fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

fn token_text(min_tokens: i64) -> String {
    let mut text = String::new();
    while estimate_tokens(&text) < min_tokens {
        text.push_str("compressionword ");
    }
    text.trim().to_string()
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

/// Phase 1 narrowing of TS `Partial<Pick<SdkConfig, "guards">>` — only `guards`
/// is exercised by this suite's `sdkFor` call sites.
struct SdkForOverrides {
    guards: Option<DerivationGuards>,
}

fn sdk_for(inference_callbacks: InferenceCallbacks, overrides: SdkForOverrides) -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(inference_callbacks),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: overrides.guards,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
        view: None,
    })
}

/// TS nested plain-object equality: exact key set (order-independent).
fn assert_exact_object_keys(value: &Value, expected: &[&str]) {
    let obj = value
        .as_object()
        .unwrap_or_else(|| panic!("expected object, got {value}"));
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    assert_eq!(keys, expected);
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

async fn drain(sdk: &Lhc, file_path: &str, opts: Option<DrainOpts>) -> DrainReport {
    match sdk.work.drain(ThreadRef::file_path(file_path), opts).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

fn form_of(file_path: &str, subject_id: &str, derivation_type: &str) -> Option<Derivation> {
    read_derived_forms(file_path)
        .into_iter()
        .find(|f| f.subject_id == subject_id && f.derivation_type == derivation_type)
}

struct RecordingHost {
    log: Arc<Mutex<Vec<ModelCallInput>>>,
    text: String,
}

impl RecordingHost {
    fn new(text: String) -> Self {
        Self {
            log: Arc::new(Mutex::new(Vec::new())),
            text,
        }
    }

    fn call(&self) -> ModelCall {
        let log = Arc::clone(&self.log);
        let text = self.text.clone();
        Box::new(move |input: ModelCallInput| {
            let log = Arc::clone(&log);
            let text = text.clone();
            Box::pin(async move {
                log.lock().unwrap().push(input);
                ModelCallResult::Ok { text }
            }) as BoxFuture<ModelCallResult>
        })
    }

    fn log_snapshot(&self) -> Vec<ModelCallInput> {
        self.log.lock().unwrap().clone()
    }
}

fn tool_args(path: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("path".into(), json!(path));
    m
}

#[tokio::test]
async fn stores_tiny_turns_as_detailed_turn_compression_without_calling_compression_inference() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = sdk_for(
        double.to_callbacks(),
        SdkForOverrides {
            guards: Some(DerivationGuards {
                smoothed_prompt: None,
                tool_result_summary: None,
                detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                    tiny_turn_tokens: Some(1000),
                }),
            }),
        },
    );
    let file_path = new_thread(&store).await;

    send_turn(&sdk, &file_path, "tiny turn", "short answer").await;
    drain(&sdk, &file_path, None).await;

    let assembly = form_of(&file_path, "t1", "pre_detailed_assembly");
    let compression = form_of(&file_path, "t1", "detailed_turn_compression");
    assert!(
        captured
            .snapshot()
            .iter()
            .filter(|e| e.op == InferenceCallbackOpName::CompressDetailedTurn)
            .collect::<Vec<_>>()
            .is_empty()
    );
    assert_eq!(
        assembly.as_ref().map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(
        compression.as_ref().map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(
        compression.as_ref().and_then(|f| f.content.as_ref()),
        assembly.as_ref().and_then(|f| f.content.as_ref())
    );
    assert!(
        compression
            .as_ref()
            .and_then(|f| f.metadata.as_ref())
            .and_then(|m| m.size_disposition)
            .is_none()
    );
}

#[tokio::test]
async fn composes_pre_detailed_assembly_from_dialog_only_in_user_assistant_sections() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = sdk_for(
        double.to_callbacks(),
        SdkForOverrides {
            guards: Some(DerivationGuards {
                smoothed_prompt: None,
                tool_result_summary: None,
                detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                    tiny_turn_tokens: Some(1000),
                }),
            }),
        },
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
                        text: "read runtime state".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_THINKING,
                AssistantThinkingOverrides {
                    payload: Some(AssistantThinkingPayload {
                        text: "planning the read".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "I will inspect it".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "call-1".into(),
                        tool_name: "read_file".into(),
                        arguments: tool_args("state.txt"),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "call-1".into(),
                        content: "state is ready".into(),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path, None).await;

    let assembly = form_of(&file_path, "t1", "pre_detailed_assembly")
        .and_then(|f| f.content)
        .unwrap_or_default();
    assert!(assembly.contains("User:\n"));
    assert!(assembly.contains("read runtime state"));
    assert!(assembly.contains("⏺ I will inspect it"));
    assert!(!assembly.contains("planning the read"));
    assert!(!assembly.contains("read_file"));
    assert!(!assembly.contains("state is ready"));
    assert!(!assembly.contains("[1]"));
}

#[tokio::test]
async fn item_1_writes_deterministic_derivations_and_enqueues_detailed_turn_compression() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = sdk_for(
        double.to_callbacks(),
        SdkForOverrides {
            guards: Some(DerivationGuards {
                smoothed_prompt: None,
                tool_result_summary: None,
                detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                    tiny_turn_tokens: Some(1),
                }),
            }),
        },
    );
    let file_path = new_thread(&store).await;

    send_turn(&sdk, &file_path, "two item flow", &token_text(120)).await;
    let partial = drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(2) })).await;
    assert!(partial.ran.iter().any(|e| {
        e.work_item_id == "w-t1-turn_derivation-v1" && e.disposition == DrainDisposition::Done
    }));

    assert_eq!(
        form_of(&file_path, "t1", "turn_rendering")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(
        form_of(&file_path, "t1", "pre_detailed_assembly")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(
        form_of(&file_path, "t1", "detailed_turn_compression")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Pending)
    );

    let db = open_raw(&file_path);
    let queued = db
        .prepare(
            "SELECT kind, status FROM work_item WHERE work_item_id = 'w-t1-detailed_turn_compression-v1'",
        )
        .get();
    db.close();
    let queued = queued.expect("queued row");
    assert_eq!(
        queued.get("kind").and_then(|v| v.as_str()),
        Some("detailed_turn_compression")
    );
    assert_eq!(
        queued.get("status").and_then(|v| v.as_str()),
        Some("queued")
    );

    drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(1) })).await;
    assert_eq!(
        form_of(&file_path, "t1", "detailed_turn_compression")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
}

#[tokio::test]
async fn renders_structured_turn_text_with_message_kind_markers_in_record_order() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = sdk_for(
        double.to_callbacks(),
        SdkForOverrides {
            guards: Some(DerivationGuards {
                smoothed_prompt: None,
                tool_result_summary: None,
                detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                    tiny_turn_tokens: Some(1000),
                }),
            }),
        },
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
                        text: "read runtime state".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "I will inspect it".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "call-1".into(),
                        tool_name: "read_file".into(),
                        arguments: tool_args("state.txt"),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "call-1".into(),
                        content: "state is ready".into(),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path, None).await;

    let rendering = form_of(&file_path, "t1", "turn_rendering")
        .and_then(|f| f.content)
        .unwrap_or_default();
    let user_idx = rendering.find("User prompt\n").expect("user");
    let assistant_idx = rendering.find("Assistant response\n").expect("assistant");
    let tool_idx = rendering
        .find("Tool call [outcome: succeeded]\n")
        .expect("tool");
    assert!(user_idx < assistant_idx);
    assert!(assistant_idx < tool_idx);
    assert!(rendering.contains("read_file"));
    assert!(rendering.contains("state is ready"));
}

#[tokio::test]
async fn passes_concrete_target_tokens_to_compression_and_records_size_disposition() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured: Arc<Mutex<Vec<(InferenceCallbackOpName, Value)>>> =
        Arc::new(Mutex::new(Vec::new()));
    let output = token_text(90);
    let captured_for_cb = Arc::clone(&captured);
    let output_for_cb = output.clone();
    let base = double.to_callbacks();
    let callbacks = InferenceCallbacks {
        smooth_prompt: base.smooth_prompt.clone(),
        summarize_tool_result: base.summarize_tool_result.clone(),
        compress_detailed_turn: Arc::new(move |input: CompressDetailedTurnInput| {
            let captured = Arc::clone(&captured_for_cb);
            let output = output_for_cb.clone();
            Box::pin(async move {
                captured.lock().unwrap().push((
                    InferenceCallbackOpName::CompressDetailedTurn,
                    serde_json::to_value(&input).unwrap(),
                ));
                InferenceResult::Ok {
                    text: output,
                    provenance: None,
                    request_messages: None,
                    raw_response: None,
                }
            }) as BoxFuture<InferenceResult>
        }),
        summarize_chunk_brief: base.summarize_chunk_brief.clone(),
    };
    let sdk = sdk_for(callbacks, SdkForOverrides { guards: None });
    let file_path = new_thread(&store).await;

    send_turn(&sdk, &file_path, "target ratios", &token_text(300)).await;
    drain(&sdk, &file_path, None).await;

    let call = captured
        .lock()
        .unwrap()
        .iter()
        .find(|(op, _)| *op == InferenceCallbackOpName::CompressDetailedTurn)
        .map(|(_, v)| v.clone());
    assert!(call.is_some());
    let Some(call) = call else {
        return;
    };
    let dialogue = call.get("dialogueText").and_then(|v| v.as_str()).unwrap();
    assert!(dialogue.contains("User:\n"));
    assert!(dialogue.contains("target ratios"));
    assert!(dialogue.contains("⏺ "));
    assert!(!dialogue.contains("[1] User prompt"));
    let input_tokens = call.get("inputTokens").and_then(|v| v.as_i64()).unwrap();
    assert_eq!(input_tokens, estimate_tokens(dialogue));
    assert_eq!(
        call.get("targetMinTokens").and_then(|v| v.as_i64()),
        Some(1.max(js_round(input_tokens as f64 * 0.35)))
    );
    assert_eq!(
        call.get("targetAimTokens").and_then(|v| v.as_i64()),
        Some(1.max(js_round(input_tokens as f64 * 0.5)))
    );
    assert_eq!(
        call.get("targetMaxTokens").and_then(|v| v.as_i64()),
        Some(1.max(js_round(input_tokens as f64 * 0.65)))
    );
    let compression = form_of(&file_path, "t1", "detailed_turn_compression").expect("compression");
    assert_eq!(compression.state, DerivationState::Ready);
    assert_eq!(compression.content.as_deref(), Some(output.as_str()));
    assert_eq!(
        compression
            .metadata
            .as_ref()
            .and_then(|m| m.size_disposition),
        Some(SizeDisposition::UnderMin)
    );
}

#[tokio::test]
async fn uses_the_tuned_prompt_as_the_default_for_model_call_hosts() {
    let store = temp_store();
    let host = RecordingHost::new(token_text(120));
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call: host.call(),
            assignments: None,
            timeout_ms: None,
            max_input_chars: None,
        }),
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
        chunk_policy: None,
        view: None,
    });
    let file_path = new_thread(&store).await;

    send_turn(
        &sdk,
        &file_path,
        "target ratios",
        "assistant answer with enough content",
    )
    .await;
    drain(&sdk, &file_path, None).await;

    let compression = form_of(&file_path, "t1", "detailed_turn_compression").expect("compression");
    assert_eq!(compression.state, DerivationState::Ready);
    assert_eq!(
        compression
            .metadata
            .as_ref()
            .and_then(|m| m.provenance.as_ref())
            .map(|p| p.prompt.as_str()),
        Some("detailed-turn-compression-v3")
    );
    let log = host.log_snapshot();
    let rendered = log.last().expect("rendered");
    let prompt_text = rendered
        .messages
        .iter()
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(prompt_text.contains("<instructions-for-summarizing>"));
    assert!(prompt_text.contains("<content-for-summarizing>"));
    assert!(prompt_text.contains("targetting approximately 20%-30%"));

    let derivation_log = sdk
        .logging
        .query_derivation_log(
            ThreadRef::file_path(&file_path),
            DerivationLogQuery {
                subject_kind: None,
                subject_id: Some("t1".into()),
                derivation_type: Some("detailed_turn_compression".into()),
                event_kind: None,
            },
        )
        .await;
    assert!(derivation_log.is_ok());
    let OpResult::Ok { value } = derivation_log else {
        return;
    };
    let succeeded = value
        .iter()
        .find(|e| e.event_kind == DerivationLogEventKind::InferenceSucceeded);
    let succeeded = succeeded.expect("succeeded");
    assert_eq!(
        succeeded.event_kind,
        DerivationLogEventKind::InferenceSucceeded
    );
    // TS nested plain objects → exact key sets (outer objectContaining).
    assert_exact_object_keys(
        &Value::Object(succeeded.payload.clone()),
        &["provenance", "requestMessages", "rawResponse"],
    );
    let provenance = succeeded.payload.get("provenance").expect("provenance");
    assert_exact_object_keys(provenance, &["provider", "model", "prompt"]);
    assert!(
        provenance
            .get("provider")
            .and_then(|v| v.as_str())
            .is_some()
    );
    assert!(provenance.get("model").and_then(|v| v.as_str()).is_some());
    assert_eq!(
        provenance.get("prompt").and_then(|v| v.as_str()),
        Some("detailed-turn-compression-v3")
    );
    assert_eq!(
        succeeded.payload.get("requestMessages"),
        Some(&serde_json::to_value(&rendered.messages).unwrap())
    );
    assert_eq!(
        succeeded
            .payload
            .get("rawResponse")
            .and_then(|v| v.as_str()),
        Some(token_text(120).as_str())
    );
}

#[tokio::test]
async fn compression_failure_logs_request_messages_on_inference_failed() {
    let store = temp_store();
    let log: Arc<Mutex<Vec<ModelCallInput>>> = Arc::new(Mutex::new(Vec::new()));
    let log_for_call = Arc::clone(&log);
    let call: ModelCall = Box::new(move |input: ModelCallInput| {
        let log = Arc::clone(&log_for_call);
        Box::pin(async move {
            log.lock().unwrap().push(input);
            ModelCallResult::Ok { text: "   ".into() }
        }) as BoxFuture<ModelCallResult>
    });
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call,
            assignments: None,
            timeout_ms: None,
            max_input_chars: None,
        }),
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
        chunk_policy: None,
        view: None,
    });
    let file_path = new_thread(&store).await;

    send_turn(&sdk, &file_path, "observable failure", &token_text(120)).await;
    drain(&sdk, &file_path, None).await;

    let derivation_log = sdk
        .logging
        .query_derivation_log(
            ThreadRef::file_path(&file_path),
            DerivationLogQuery {
                subject_kind: None,
                subject_id: Some("t1".into()),
                derivation_type: Some("detailed_turn_compression".into()),
                event_kind: None,
            },
        )
        .await;
    assert!(derivation_log.is_ok());
    let OpResult::Ok { value } = derivation_log else {
        return;
    };
    let failed = value
        .iter()
        .find(|e| e.event_kind == DerivationLogEventKind::InferenceFailed)
        .expect("failed");
    let compression_call = log.lock().unwrap().last().cloned();
    assert_eq!(failed.event_kind, DerivationLogEventKind::InferenceFailed);
    // TS nested plain objects → exact key sets (outer objectContaining).
    assert_exact_object_keys(
        &Value::Object(failed.payload.clone()),
        &["reason", "requestMessages"],
    );
    assert_eq!(
        failed.payload.get("reason").and_then(|v| v.as_str()),
        Some("provider_failure: empty_output: model returned empty or whitespace-only text")
    );
    assert_eq!(
        failed.payload.get("requestMessages"),
        compression_call
            .as_ref()
            .map(|c| serde_json::to_value(&c.messages).unwrap())
            .as_ref()
    );
}

#[tokio::test]
async fn the_first_compression_failure_lands_ready_with_the_pre_detailed_assembly_fallback() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    double.fail_kind(
        "detailed_turn_compression",
        99,
        Some("provider_failure: empty_output: model returned empty or whitespace-only text"),
    );
    let sdk = sdk_for(
        double.to_callbacks(),
        SdkForOverrides {
            guards: Some(DerivationGuards {
                smoothed_prompt: None,
                tool_result_summary: None,
                detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                    tiny_turn_tokens: Some(1),
                }),
            }),
        },
    );
    let file_path = new_thread(&store).await;

    send_turn(&sdk, &file_path, "fallback compression", &token_text(120)).await;
    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(drained.is_ok());
    let OpResult::Ok { value } = drained else {
        return;
    };
    assert!(value.ran.iter().any(|e| {
        e.work_item_id == "w-t1-detailed_turn_compression-v1"
            && e.disposition == DrainDisposition::Done
    }));

    let assembly = form_of(&file_path, "t1", "pre_detailed_assembly");
    let compression = form_of(&file_path, "t1", "detailed_turn_compression").expect("compression");
    assert_eq!(
        form_of(&file_path, "t1", "turn_rendering")
            .as_ref()
            .map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(
        assembly.as_ref().map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(compression.state, DerivationState::Ready);
    assert_eq!(
        compression.content.as_ref(),
        assembly.as_ref().and_then(|f| f.content.as_ref())
    );
    let meta = compression.metadata.as_ref().expect("metadata");
    assert_eq!(
        meta.fallback_floor.as_deref(),
        Some("pre_detailed_assembly")
    );
    assert_eq!(meta.fallback_used, Some(true));
    assert_eq!(meta.inference_attempted, Some(true));
    assert_eq!(meta.inference_succeeded, Some(false));
    assert_eq!(
        meta.last_error.as_deref(),
        Some("provider_failure: empty_output: model returned empty or whitespace-only text")
    );

    let derivation_log = sdk
        .logging
        .query_derivation_log(
            ThreadRef::file_path(&file_path),
            DerivationLogQuery {
                subject_kind: None,
                subject_id: Some("t1".into()),
                derivation_type: Some("detailed_turn_compression".into()),
                event_kind: None,
            },
        )
        .await;
    assert!(derivation_log.is_ok());
    let OpResult::Ok { value } = derivation_log else {
        return;
    };
    let kinds: Vec<_> = value.iter().map(|e| e.event_kind).collect();
    assert!(kinds.contains(&DerivationLogEventKind::InferenceFailed));
    assert!(kinds.contains(&DerivationLogEventKind::FallbackApplied));
    let failed_events: Vec<_> = value
        .iter()
        .filter(|e| e.event_kind == DerivationLogEventKind::InferenceFailed)
        .collect();
    assert_eq!(failed_events.len(), 1);
    assert!(
        failed_events
            .last()
            .unwrap()
            .payload
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap()
            .contains("empty_output")
    );
    let fallback_event = value
        .iter()
        .find(|e| e.event_kind == DerivationLogEventKind::FallbackApplied)
        .expect("fallback");
    assert_eq!(
        fallback_event
            .payload
            .get("fallbackFloor")
            .and_then(|v| v.as_str()),
        Some("pre_detailed_assembly")
    );
    assert!(
        fallback_event
            .payload
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap()
            .contains("empty_output")
    );

    let chunks = read_chunks(&file_path);
    assert!(chunks.members.iter().any(|m| m.turn_id == "t1"));

    let logs = sdk
        .logging
        .query(
            ThreadRef::file_path(&file_path),
            LogQuery {
                level: Some(LogLevel::Warning),
                derivation_type: Some("detailed_turn_compression".into()),
                subject_id: Some("t1".into()),
                reason: None,
            },
        )
        .await;
    assert!(logs.is_ok());
    let OpResult::Ok { value } = logs else {
        return;
    };
    assert_eq!(value.len(), 1);
    assert_eq!(value[0].message, "turn compression fallback used");
    assert_eq!(
        value[0].reason.as_deref(),
        Some("provider_failure: empty_output: model returned empty or whitespace-only text")
    );
    assert_eq!(
        value[0].floor_used.as_deref(),
        Some("pre_detailed_assembly")
    );
}
