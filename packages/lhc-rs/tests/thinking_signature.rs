//! Thinking-signature capture (R2 / resume fidelity on fable-class models):
//! assistant_thinking may carry an opaque provider signature and optional
//! provider/model/api provenance. Capture stores them verbatim; session-view
//! round-trips signature as thinkingSignature and provenance on the grouped
//! assistant message. The text LLM path still skips signature-only blocks.
//! Identity-match suppression is HOST work — the SDK always exports verbatim.
//!
//! Ported from packages/lhc/test/thinking-signature.test.ts (+ ledger R2
//! validate: mismatched/synthetic identity still exports).

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, AssistantThinkingOverrides,
    AssistantThinkingPayload, ModelChangeOverrides, ModelChangePayload, TempStore,
    TurnEndOverrides, UserPromptOverrides, UserPromptPayload, kind, temp_store, valid_event,
};
use lhc::messages::MessageKind;
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::{ErrorCode, OpResult};
use lhc::shared_tech::view::{
    SessionAssistantPartType, SessionThreadViewEntry, SessionThreadViewMessage,
};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, create_deterministic_inference_callbacks, init_lhc};
use serde_json::{Map, Value, json};

async fn new_thread(sdk: &Lhc, store: &TempStore) -> String {
    let path = store.thread_path(None).to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    match created {
        OpResult::Ok { .. } => path,
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

fn manual_sdk() -> Lhc {
    init_lhc(SdkConfig {
        mode: SdkMode::Manual,
        inference_callbacks: Some(create_deterministic_inference_callbacks()),
        inference: None,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    })
}

fn thinking_payload(
    text: &str,
    signature: Option<&str>,
    provider: Option<&str>,
    model: Option<&str>,
    api: Option<&str>,
) -> AssistantThinkingPayload {
    AssistantThinkingPayload {
        text: text.into(),
        signature: signature.map(str::to_string),
        provider: provider.map(str::to_string),
        model: model.map(str::to_string),
        api: api.map(str::to_string),
    }
}

fn text_payload(
    text: &str,
    provider: Option<&str>,
    model: Option<&str>,
    api: Option<&str>,
) -> AssistantTextPayload {
    AssistantTextPayload {
        text: text.into(),
        provider: provider.map(str::to_string),
        model: model.map(str::to_string),
        api: api.map(str::to_string),
    }
}

fn assistant_entries(
    entries: &[SessionThreadViewEntry],
) -> Vec<&lhc::shared_tech::view::SessionAssistantMessage> {
    entries
        .iter()
        .filter_map(|e| match e {
            SessionThreadViewEntry::Message(SessionThreadViewMessage::Assistant(a)) => Some(a),
            _ => None,
        })
        .collect()
}

// ── intake ─────────────────────────────────────────────────────────

#[tokio::test]
async fn accepts_optional_signature_and_materializes_it_on_the_message_block() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "hi".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(thinking_payload("", Some("enc-sig-abc"), None, None, None)),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(text_payload("hello", None, None, None)),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(captured.is_ok());

    let listed = sdk.messages.list(ThreadRef::file_path(&file_path), None).await;
    let OpResult::Ok { value } = listed else {
        panic!("list failed");
    };
    let thinking = value
        .iter()
        .find(|row| row.kind == MessageKind::AssistantThinking)
        .expect("thinking row");
    let expected = json!({"text": "", "signature": "enc-sig-abc"});
    assert_eq!(
        Value::Object(thinking.blocks[0].content.clone()),
        expected
    );
}

#[tokio::test]
async fn rejects_unknown_payload_fields_on_assistant_thinking() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let mut event = valid_event(
        kind::ASSISTANT_THINKING,
        AssistantThinkingOverrides {
            payload: Some(thinking_payload("x", Some("s"), None, None, None)),
            ..Default::default()
        },
    );
    event.payload.insert("extra".into(), Value::Bool(true));

    let result = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(&file_path), &[event])
        .await;
    let OpResult::Err { error } = result else {
        panic!("expected reject");
    };
    assert_eq!(error.code, ErrorCode::InvalidEvent);
    assert!(
        error.reason.to_lowercase().contains("extra")
            || error.reason.to_lowercase().contains("unexpected")
            || error.reason.contains("unexpected property")
            || error.reason.contains("is unexpected"),
        "reason: {}",
        error.reason
    );
}

#[tokio::test]
async fn omitted_signature_stays_omitted_on_the_block() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(thinking_payload("plain thought", None, None, None, None)),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(captured.is_ok());

    let listed = sdk.messages.list(ThreadRef::file_path(&file_path), None).await;
    let OpResult::Ok { value } = listed else {
        panic!("list failed");
    };
    let thinking = value
        .iter()
        .find(|row| row.kind == MessageKind::AssistantThinking)
        .expect("thinking");
    assert_eq!(
        Value::Object(thinking.blocks[0].content.clone()),
        json!({"text": "plain thought"})
    );
    assert!(!thinking.blocks[0].content.contains_key("signature"));
}

// ── serving round-trip ─────────────────────────────────────────────

async fn seed_signed_empty(sdk: &Lhc, file_path: &str) {
    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "what changed?".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(thinking_payload(
                            "",
                            Some("enc-fable-sig-001"),
                            None,
                            None,
                            None,
                        )),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(text_payload("Three files changed.", None, None, None)),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(captured.is_ok());
}

#[tokio::test]
async fn get_session_thread_view_emits_thinking_signature_on_the_thinking_part() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_signed_empty(&sdk, &file_path).await;

    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value } = view else {
        panic!("view failed");
    };
    let assistants = assistant_entries(&value.entries);
    let parts: Vec<_> = assistants.iter().flat_map(|a| a.content.iter()).collect();
    let thinking = parts
        .iter()
        .find(|p| p.type_ == SessionAssistantPartType::Thinking)
        .expect("thinking part");
    assert_eq!(thinking.thinking.as_deref(), Some(""));
    assert_eq!(
        thinking.thinking_signature.as_deref(),
        Some("enc-fable-sig-001")
    );
}

#[tokio::test]
async fn get_llm_request_context_skips_signature_only_thinking() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_signed_empty(&sdk, &file_path).await;

    let context = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value } = context else {
        panic!("context failed");
    };
    let texts: Vec<String> = value
        .messages
        .iter()
        .map(|m| {
            m.content
                .iter()
                .map(|p| p.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect();
    assert!(!texts.iter().any(|t| t.contains("[thinking]")));
    assert!(
        texts
            .iter()
            .any(|t| t.contains("Three files changed."))
    );
}

#[tokio::test]
async fn non_empty_thinking_text_with_signature_still_serves_on_both_exits() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload { text: "q".into() }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(thinking_payload(
                            "visible reasoning",
                            Some("enc-sig-2"),
                            None,
                            None,
                            None,
                        )),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(text_payload("answer", None, None, None)),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(captured.is_ok());

    let context = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    let (OpResult::Ok { value: context }, OpResult::Ok { value: view }) = (context, view) else {
        panic!("serve failed");
    };

    let texts: Vec<String> = context
        .messages
        .iter()
        .map(|m| {
            m.content
                .iter()
                .map(|p| p.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect();
    assert!(
        texts
            .iter()
            .any(|t| t.contains("[thinking]\nvisible reasoning"))
    );

    let parts: Vec<_> = assistant_entries(&view.entries)
        .iter()
        .flat_map(|a| a.content.iter())
        .collect();
    assert!(parts.iter().any(|p| {
        p.type_ == SessionAssistantPartType::Thinking
            && p.thinking_signature.as_deref() == Some("enc-sig-2")
    }));
}

// ── provenance ─────────────────────────────────────────────────────

#[tokio::test]
async fn stores_provider_model_api_on_thinking_blocks_and_surfaces_them_on_session_view() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload { text: "q".into() }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(thinking_payload(
                            "",
                            Some("enc-prov"),
                            Some("anthropic"),
                            Some("claude-fable-5"),
                            Some("anthropic-messages"),
                        )),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(text_payload(
                            "a",
                            Some("anthropic"),
                            Some("claude-fable-5"),
                            Some("anthropic-messages"),
                        )),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(captured.is_ok());

    let listed = sdk.messages.list(ThreadRef::file_path(&file_path), None).await;
    let OpResult::Ok { value } = listed else {
        panic!("list failed");
    };
    let thinking = value
        .iter()
        .find(|row| row.kind == MessageKind::AssistantThinking)
        .expect("thinking");
    let content = &thinking.blocks[0].content;
    assert_eq!(content.get("text"), Some(&json!("")));
    assert_eq!(content.get("signature"), Some(&json!("enc-prov")));
    assert_eq!(content.get("provider"), Some(&json!("anthropic")));
    assert_eq!(content.get("model"), Some(&json!("claude-fable-5")));
    assert_eq!(content.get("api"), Some(&json!("anthropic-messages")));

    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value: view } = view else {
        panic!("view failed");
    };
    let assistants = assistant_entries(&view.entries);
    assert_eq!(assistants.len(), 1);
    assert_eq!(assistants[0].provider.as_deref(), Some("anthropic"));
    assert_eq!(assistants[0].model.as_deref(), Some("claude-fable-5"));
    assert_eq!(assistants[0].api.as_deref(), Some("anthropic-messages"));
}

/// R2 validate: mismatched / synthetic identity still EXPORTS verbatim
/// (suppression is host work, not SDK).
#[tokio::test]
async fn synthetic_or_mismatched_identity_still_exports_verbatim() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    // Synthetic labels a host might stamp (lhc/thread-view style) — SDK must
    // not strip them at export even if they would fail a live-model check.
    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload { text: "q".into() }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(thinking_payload(
                            "",
                            Some("enc-synthetic"),
                            Some("lhc"),
                            Some("thread-view"),
                            Some("synthetic"),
                        )),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(text_payload(
                            "answer",
                            Some("lhc"),
                            Some("thread-view"),
                            Some("synthetic"),
                        )),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(captured.is_ok());

    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value: view } = view else {
        panic!("view failed");
    };
    let assistants = assistant_entries(&view.entries);
    assert_eq!(assistants.len(), 1);
    assert_eq!(assistants[0].provider.as_deref(), Some("lhc"));
    assert_eq!(assistants[0].model.as_deref(), Some("thread-view"));
    assert_eq!(assistants[0].api.as_deref(), Some("synthetic"));
    let thinking = assistants[0]
        .content
        .iter()
        .find(|p| p.type_ == SessionAssistantPartType::Thinking)
        .expect("thinking part");
    assert_eq!(
        thinking.thinking_signature.as_deref(),
        Some("enc-synthetic")
    );

    // Also verify assistant_text block retained provenance in the record.
    let listed = sdk.messages.list(ThreadRef::file_path(&file_path), None).await;
    let OpResult::Ok { value } = listed else {
        panic!("list failed");
    };
    let text_row = value
        .iter()
        .find(|row| row.kind == MessageKind::AssistantText)
        .expect("text");
    assert_eq!(
        text_row.blocks[0].content.get("provider"),
        Some(&json!("lhc"))
    );
    assert_eq!(
        text_row.blocks[0].content.get("model"),
        Some(&json!("thread-view"))
    );
    assert_eq!(
        text_row.blocks[0].content.get("api"),
        Some(&json!("synthetic"))
    );

    let _ = Map::<String, Value>::new();
}

// ── identity-boundary split (TS session-view parity) ────────────────

/// Two thinking rows captured under DIFFERENT identities in one assistant run
/// must serve as two assistant entries, each with its own provenance —
/// message-level provenance covers every signature in a group, so grouping
/// them would hand the second ciphertext to the wrong identity gate.
#[tokio::test]
async fn splits_assistant_group_at_identity_boundary() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload { text: "hi".into() }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(thinking_payload(
                            "plan a",
                            Some("SIG_A"),
                            Some("openai"),
                            Some("gpt-a"),
                            Some("responses"),
                        )),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(thinking_payload(
                            "plan b",
                            Some("SIG_B"),
                            Some("openai"),
                            Some("gpt-b"),
                            Some("responses"),
                        )),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(text_payload("done", None, None, None)),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(captured.is_ok());

    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value: view } = view else {
        panic!("view failed");
    };

    let assistants = assistant_entries(&view.entries);
    assert_eq!(assistants.len(), 2, "identity change must split the group");
    assert_eq!(assistants[0].model.as_deref(), Some("gpt-a"));
    assert_eq!(assistants[1].model.as_deref(), Some("gpt-b"));
    assert_eq!(
        assistants[0].content[0].thinking_signature.as_deref(),
        Some("SIG_A")
    );
    assert_eq!(
        assistants[1].content[0].thinking_signature.as_deref(),
        Some("SIG_B")
    );
    // Trailing no-provenance text inherits the open (second) group.
    assert!(
        assistants[1]
            .content
            .iter()
            .any(|p| p.type_ == SessionAssistantPartType::Text)
    );
}

/// Provider-only identity conflicts split too, and model_change entries land
/// AFTER the assistant group they interrupt (history order preserved).
#[tokio::test]
async fn provider_only_conflict_splits_and_change_entries_stay_ordered() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload { text: "hi".into() }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(thinking_payload(
                            "plan a",
                            Some("SIG_A"),
                            Some("openai"),
                            Some("m"),
                            Some("responses"),
                        )),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::MODEL_CHANGE,
                    ModelChangeOverrides {
                        payload: Some(ModelChangePayload {
                            previous_model: "openai/m".into(),
                            new_model: "other/m".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(thinking_payload(
                            "plan b",
                            Some("SIG_B"),
                            Some("other"),
                            Some("m"),
                            Some("responses"),
                        )),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(captured.is_ok());

    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value: view } = view else {
        panic!("view failed");
    };

    let shapes: Vec<&str> = view
        .entries
        .iter()
        .map(|e| match e {
            SessionThreadViewEntry::Message(SessionThreadViewMessage::User(_)) => "user",
            SessionThreadViewEntry::Message(SessionThreadViewMessage::Assistant(_)) => "assistant",
            SessionThreadViewEntry::Message(SessionThreadViewMessage::ToolResult(_)) => {
                "tool_result"
            }
            SessionThreadViewEntry::Runtime(
                lhc::shared_tech::view::SessionThreadViewRuntimeEntry::ModelChange(_),
            ) => "model_change",
            SessionThreadViewEntry::Runtime(
                lhc::shared_tech::view::SessionThreadViewRuntimeEntry::ThinkingLevelChange(_),
            ) => "thinking_level_change",
        })
        .collect();
    assert_eq!(
        shapes,
        vec!["user", "assistant", "model_change", "assistant"],
        "assistant(A) must precede the model_change marker"
    );
    let assistants = assistant_entries(&view.entries);
    assert_eq!(assistants[0].provider.as_deref(), Some("openai"));
    assert_eq!(assistants[1].provider.as_deref(), Some("other"));
}
