//! Ported from packages/lhc/test/runtime-change-typing.test.ts. Phase 1.

mod fixtures;

use lhc::messages::{self, Block, BlockType, MessageKind};
use lhc::shared_tech::derivation::{LeaseConfig, SdkConfig, SdkMode};
use lhc::shared_tech::inference_types::{DerivationGuards, DetailedTurnCompressionGuards};
use lhc::threads::NewThreadInput;
use lhc::{MessageEventInput, ThreadRef, init_lhc, threads};
use serde_json::{Map, Value, json};

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, ModelChangeOverrides, ModelChangePayload,
    TempStore, ThinkingLevelChangeOverrides, ThinkingLevelChangePayload, TurnEndOverrides,
    UserPromptOverrides, UserPromptPayload, create_inference_callbacks_double, kind, temp_store,
    valid_event,
};
use lhc::OpResult;

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
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

fn sdk_for() -> lhc::Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
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
        chunk_policy: None,
        view: None,
    })
}

async fn send(file_path: &str, batch: &[MessageEventInput]) {
    let sdk = sdk_for();
    let result = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(file_path), batch)
        .await;
    if let OpResult::Err { error } = result {
        panic!("{}", error.reason);
    }
}

fn content_map(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), v.clone()))
        .collect()
}

#[tokio::test]
async fn projects_model_changes_as_typed_model_change_blocks() {
    let store = temp_store();
    let file_path = new_thread(&store).await;
    send(
        &file_path,
        &[valid_event(
            kind::MODEL_CHANGE,
            ModelChangeOverrides {
                payload: Some(ModelChangePayload {
                    previous_model: "gpt-5".into(),
                    new_model: "gpt-5.1".into(),
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    let listed = messages::list(ThreadRef::file_path(&file_path), None).await;
    assert!(listed.is_ok());
    if let OpResult::Ok { value } = listed {
        assert_eq!(value.len(), 1);
        assert_eq!(value[0].kind, MessageKind::ModelChange);
        assert_eq!(
            value[0].blocks,
            vec![Block {
                block_type: BlockType::ModelChange,
                content: content_map(&[
                    ("previousModel", json!("gpt-5")),
                    ("newModel", json!("gpt-5.1")),
                ]),
            }]
        );
    }
    store.cleanup();
}

#[tokio::test]
async fn projects_thinking_level_changes_as_typed_thinking_level_change_blocks() {
    let store = temp_store();
    let file_path = new_thread(&store).await;
    send(
        &file_path,
        &[valid_event(
            kind::THINKING_LEVEL_CHANGE,
            ThinkingLevelChangeOverrides {
                payload: Some(ThinkingLevelChangePayload {
                    previous_level: "medium".into(),
                    new_level: "high".into(),
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    let listed = messages::list(ThreadRef::file_path(&file_path), None).await;
    assert!(listed.is_ok());
    if let OpResult::Ok { value } = listed {
        assert_eq!(value.len(), 1);
        assert_eq!(value[0].kind, MessageKind::ThinkingLevelChange);
        assert_eq!(
            value[0].blocks,
            vec![Block {
                block_type: BlockType::ThinkingLevelChange,
                content: content_map(&[
                    ("previousLevel", json!("medium")),
                    ("newLevel", json!("high")),
                ]),
            }]
        );
    }
    store.cleanup();
}

#[tokio::test]
async fn places_typed_runtime_change_blocks_verbatim_in_constructed_turns_in_stream_order() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
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
        chunk_policy: None,
        view: None,
    });
    let file_path = new_thread(&store).await;

    let intake = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "runtime order".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::MODEL_CHANGE,
                    ModelChangeOverrides {
                        payload: Some(ModelChangePayload {
                            previous_model: "gpt-5".into(),
                            new_model: "gpt-5.1".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::THINKING_LEVEL_CHANGE,
                    ThinkingLevelChangeOverrides {
                        payload: Some(ThinkingLevelChangePayload {
                            previous_level: "medium".into(),
                            new_level: "high".into(),
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
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(intake.is_ok());
    if !intake.is_ok() {
        return;
    }

    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(drained.is_ok());
    if !drained.is_ok() {
        return;
    }

    let rendering = fixtures::read_derived_forms(&file_path)
        .into_iter()
        .find(|form| form.subject_id == "t1" && form.derivation_type == "turn_rendering")
        .and_then(|f| f.content);
    let segments: Vec<_> = rendering.as_deref().unwrap_or("").split("\n\n").collect();
    assert_eq!(segments.len(), 4);
    assert!(segments[1].contains("model_change gpt-5 -> gpt-5.1"));
    assert!(segments[2].contains("thinking_level_change medium -> high"));
    assert!(segments[3].contains("answer"));

    let compression = captured
        .snapshot()
        .into_iter()
        .find(|e| e.op == fixtures::InferenceCallbackOpName::CompressDetailedTurn);
    let assembly_text = compression
        .as_ref()
        .and_then(|e| e.input.get("dialogueText"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    assert!(assembly_text.contains("User:"));
    assert!(assembly_text.contains("⏺ "));
    assert!(!assembly_text.contains("model_change"));
    store.cleanup();
}
