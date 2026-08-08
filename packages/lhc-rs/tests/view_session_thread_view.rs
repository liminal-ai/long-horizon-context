//! Ported from packages/lhc/test/view-session-thread-view.test.ts. Phase 1.
//!
//! Judgment: Rust has no async beforeAll — each test builds a fresh
//! thread/store (acceptable isolation translation of TS `beforeAll`).

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, ModelChangeOverrides, ModelChangePayload,
    RuntimeNoteOverrides, RuntimeNotePayload, TempStore, ThinkingLevelChangeOverrides,
    ThinkingLevelChangePayload, ToolCallOverrides, ToolCallPayload, ToolResultOverrides,
    ToolResultPayload, TurnEndOverrides, UserPromptOverrides, UserPromptPayload, boundary_tokens,
    conversation_turn, event_batch, kind, seed_view_boundary, temp_store, valid_event,
};
use lhc::intake_stream::EventKind;
use lhc::messages::MessageKind;
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::view::{
    PartialVisibilityBudgets, SdkViewConfig, SessionAssistantMessage, SessionAssistantPart,
    SessionAssistantPartType, SessionModelChangeEntry, SessionThinkingLevelChangeEntry,
    SessionThreadViewEntry, SessionThreadViewEntrySource, SessionThreadViewMessage,
    SessionThreadViewRuntimeEntry, SessionToolResultMessage, SessionUserMessage,
};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, create_deterministic_inference_callbacks, init_lhc};
use regex::Regex;
use serde_json::{Map, Value};

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

fn message_entries(entries: &[SessionThreadViewEntry]) -> Vec<&SessionThreadViewMessage> {
    entries
        .iter()
        .filter_map(|e| match e {
            SessionThreadViewEntry::Message(m) => Some(m),
            SessionThreadViewEntry::Runtime(_) => None,
        })
        .collect()
}

fn message_roles(entries: &[SessionThreadViewEntry]) -> Vec<&'static str> {
    message_entries(entries)
        .into_iter()
        .map(|m| match m {
            SessionThreadViewMessage::User(_) => "user",
            SessionThreadViewMessage::Assistant(_) => "assistant",
            SessionThreadViewMessage::ToolResult(_) => "toolResult",
        })
        .collect()
}

fn entry_kinds(entries: &[SessionThreadViewEntry]) -> Vec<&'static str> {
    entries
        .iter()
        .map(|entry| match entry {
            SessionThreadViewEntry::Runtime(SessionThreadViewRuntimeEntry::ModelChange(_)) => {
                "model_change"
            }
            SessionThreadViewEntry::Runtime(
                SessionThreadViewRuntimeEntry::ThinkingLevelChange(_),
            ) => "thinking_level_change",
            SessionThreadViewEntry::Message(SessionThreadViewMessage::User(_)) => "user",
            SessionThreadViewEntry::Message(SessionThreadViewMessage::Assistant(_)) => "assistant",
            SessionThreadViewEntry::Message(SessionThreadViewMessage::ToolResult(_)) => {
                "toolResult"
            }
        })
        .collect()
}

fn idempotency_key_pattern() -> Regex {
    Regex::new(r"^fixture-key-\d+$").expect("pattern")
}

fn assert_source(source: &SessionThreadViewEntrySource, message_id: &str) {
    assert_eq!(source.message_id, message_id);
    let key = source
        .idempotency_key
        .as_deref()
        .expect("idempotency_key present");
    assert!(
        idempotency_key_pattern().is_match(key),
        "idempotency_key {key:?} does not match fixture-key-\\d+"
    );
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

#[tokio::test]
async fn returns_user_and_assistant_messages_for_a_simple_turn() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &event_batch(&[EventKind::UserPrompt, EventKind::AssistantText]),
        )
        .await;
    assert!(captured.is_ok());

    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    assert!(view.is_ok());
    let OpResult::Ok { value: view } = view else {
        return;
    };

    let msgs = message_entries(&view.entries);
    // TS toEqual — full exact structures (idempotencyKey via pattern).
    assert_eq!(msgs.len(), 2);
    match msgs[0] {
        SessionThreadViewMessage::User(SessionUserMessage {
            content,
            source_messages,
        }) => {
            assert_eq!(content, "please read the file");
            assert_eq!(source_messages.len(), 1);
            assert_source(&source_messages[0], "m1");
        }
        other => panic!("expected user, got {other:?}"),
    }
    match msgs[1] {
        SessionThreadViewMessage::Assistant(SessionAssistantMessage {
            content,
            source_messages,
            provider: _,
            model: _,
            api: _,
        }) => {
            assert_eq!(content.len(), 1);
            // TS toEqual — full SessionAssistantPart including every optional as None.
            assert_eq!(
                content[0],
                SessionAssistantPart {
                    type_: SessionAssistantPartType::Text,
                    text: Some("here is what I found".into()),
                    thinking: None,
                    thinking_signature: None,
                    tool_call_id: None,
                    tool_name: None,
                    arguments: None,
                }
            );
            assert_eq!(source_messages.len(), 1);
            assert_source(&source_messages[0], "m2");
        }
        other => panic!("expected assistant, got {other:?}"),
    }
}

#[tokio::test]
async fn groups_assistant_thinking_text_and_tool_calls_into_one_assistant_message() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &event_batch(&[
                EventKind::UserPrompt,
                EventKind::AssistantThinking,
                EventKind::AssistantText,
                EventKind::ToolCall,
            ]),
        )
        .await;
    assert!(captured.is_ok());

    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    assert!(view.is_ok());
    let OpResult::Ok { value: view } = view else {
        return;
    };

    assert_eq!(message_roles(&view.entries), ["user", "assistant"]);
    let assistant = message_entries(&view.entries)[1];
    let SessionThreadViewMessage::Assistant(SessionAssistantMessage {
        content,
        source_messages,
        provider: _,
        model: _,
        api: _,
    }) = assistant
    else {
        panic!("expected assistant");
    };
    assert_eq!(
        content.iter().map(|p| p.type_).collect::<Vec<_>>(),
        [
            SessionAssistantPartType::Thinking,
            SessionAssistantPartType::Text,
            SessionAssistantPartType::ToolCall,
        ]
    );
    // TS toMatchObject — named fields only (extras allowed).
    let part = &content[2];
    assert_eq!(part.type_, SessionAssistantPartType::ToolCall);
    assert_eq!(part.tool_call_id.as_deref(), Some("call-1"));
    assert_eq!(part.tool_name.as_deref(), Some("read_file"));
    let mut expected_args = Map::new();
    expected_args.insert("path".into(), Value::String("notes.txt".into()));
    assert_eq!(part.arguments.as_ref(), Some(&expected_args));
    // TS toEqual on sourceMessages array (keys via pattern).
    assert_eq!(source_messages.len(), 3);
    assert_source(&source_messages[0], "m2");
    assert_source(&source_messages[1], "m3");
    assert_source(&source_messages[2], "m4");
}

#[tokio::test]
async fn emits_tool_result_after_the_assistant_message_and_starts_a_new_assistant() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &event_batch(&[
                EventKind::UserPrompt,
                EventKind::AssistantThinking,
                EventKind::ToolCall,
                EventKind::ToolResult,
                EventKind::AssistantText,
                EventKind::TurnEnd,
            ]),
        )
        .await;
    assert!(captured.is_ok());

    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    assert!(view.is_ok());
    let OpResult::Ok { value: view } = view else {
        return;
    };

    assert_eq!(
        message_roles(&view.entries),
        ["user", "assistant", "toolResult", "assistant"]
    );
    let tool_result = message_entries(&view.entries)[2];
    // TS toMatchObject — named fields only (extras allowed).
    match tool_result {
        SessionThreadViewMessage::ToolResult(SessionToolResultMessage {
            tool_call_id,
            content,
            ..
        }) => {
            assert_eq!(tool_call_id, "call-1");
            assert_eq!(content, "contents of notes.txt");
        }
        other => panic!("expected toolResult, got {other:?}"),
    }
}

#[tokio::test]
async fn covers_a_full_conversation_turn_with_native_session_shapes() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let captured = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(&file_path), &conversation_turn())
        .await;
    assert!(captured.is_ok());

    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    assert!(view.is_ok());
    let OpResult::Ok { value: view } = view else {
        return;
    };

    assert_eq!(
        message_roles(&view.entries),
        ["user", "assistant", "toolResult"]
    );
}

#[tokio::test]
async fn emits_model_change_and_thinking_level_change_entries_for_runtime_changes() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(kind::USER_PROMPT, UserPromptOverrides::default()),
                valid_event(
                    kind::MODEL_CHANGE,
                    ModelChangeOverrides {
                        payload: Some(ModelChangePayload {
                            previous_model: "anthropic/claude-3".into(),
                            new_model: "openai/gpt-4o".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::THINKING_LEVEL_CHANGE,
                    ThinkingLevelChangeOverrides {
                        payload: Some(ThinkingLevelChangePayload {
                            previous_level: "low".into(),
                            new_level: "high".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(kind::ASSISTANT_TEXT, AssistantTextOverrides::default()),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(captured.is_ok());

    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    assert!(view.is_ok());
    let OpResult::Ok { value: view } = view else {
        return;
    };

    assert_eq!(
        entry_kinds(&view.entries),
        ["user", "model_change", "thinking_level_change", "assistant"]
    );
    // TS toEqual — full exact structures (idempotencyKey via pattern).
    match &view.entries[1] {
        SessionThreadViewEntry::Runtime(SessionThreadViewRuntimeEntry::ModelChange(
            SessionModelChangeEntry {
                provider,
                model_id,
                source_messages,
            },
        )) => {
            assert_eq!(provider, "openai");
            assert_eq!(model_id, "gpt-4o");
            assert_eq!(source_messages.len(), 1);
            assert_source(&source_messages[0], "m2");
        }
        other => panic!("expected model_change, got {other:?}"),
    }
    match &view.entries[2] {
        SessionThreadViewEntry::Runtime(SessionThreadViewRuntimeEntry::ThinkingLevelChange(
            SessionThinkingLevelChangeEntry {
                level,
                source_messages,
            },
        )) => {
            assert_eq!(level, "high");
            assert_eq!(source_messages.len(), 1);
            assert_source(&source_messages[0], "m3");
        }
        other => panic!("expected thinking_level_change, got {other:?}"),
    }
}

#[tokio::test]
async fn serves_full_tool_result_content_before_compact_even_when_zone_exceeds_max() {
    let store = temp_store();
    let sdk_with_budgets = init_lhc(SdkConfig {
        mode: SdkMode::Manual,
        inference_callbacks: Some(create_deterministic_inference_callbacks()),
        inference: None,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: Some(SdkViewConfig {
            profiles: None,
            visibility: Some(PartialVisibilityBudgets {
                max_tokens: Some(10.0),
                target_tokens: Some(5.0),
            }),
            compact_threshold: None,
        }),
    });
    let path = new_thread(&sdk_with_budgets, &store).await;

    let large_result = boundary_tokens(40);
    let mut args = Map::new();
    args.insert("path".into(), Value::String("big.txt".into()));
    let captured = sdk_with_budgets
        .intake_stream
        .message_events(
            ThreadRef::file_path(&path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "read a large file".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_CALL,
                    ToolCallOverrides {
                        payload: Some(ToolCallPayload {
                            tool_call_id: "call-large".into(),
                            tool_name: "read_file".into(),
                            arguments: args,
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_RESULT,
                    ToolResultOverrides {
                        payload: Some(ToolResultPayload {
                            tool_call_id: "call-large".into(),
                            content: large_result.clone(),
                            is_error: Some(false),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(captured.is_ok());

    let view = sdk_with_budgets
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&path))
        .await;
    assert!(view.is_ok());
    let OpResult::Ok { value: view } = view else {
        return;
    };

    let tool_result = message_entries(&view.entries)
        .into_iter()
        .find(|e| matches!(e, SessionThreadViewMessage::ToolResult(_)));
    // TS toMatchObject — named fields only (extras allowed).
    let Some(SessionThreadViewMessage::ToolResult(SessionToolResultMessage {
        tool_call_id,
        content,
        ..
    })) = tool_result
    else {
        panic!("expected toolResult");
    };
    assert_eq!(tool_call_id, "call-large");
    assert_eq!(content, &large_result);
    assert!(!content.contains("abridged"));
}

#[tokio::test]
async fn shortens_at_or_behind_boundary_tool_results_like_get_llm_request_context() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &event_batch(&[
                EventKind::UserPrompt,
                EventKind::ToolCall,
                EventKind::ToolResult,
                EventKind::AssistantText,
                EventKind::TurnEnd,
            ]),
        )
        .await;
    assert!(captured.is_ok());

    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };
    let result = listed.iter().find(|m| m.kind == MessageKind::ToolResult);
    assert!(result.is_some());
    let Some(result) = result else {
        return;
    };

    seed_view_boundary(&file_path, result.source_event_order);

    // TS Promise.all → tokio::join!
    let (session_view, llm_context) = tokio::join!(
        sdk.thread_view
            .get_session_thread_view(ThreadRef::file_path(&file_path)),
        sdk.thread_view
            .get_llm_request_context(ThreadRef::file_path(&file_path)),
    );
    assert!(session_view.is_ok());
    assert!(llm_context.is_ok());
    let (
        OpResult::Ok {
            value: session_view,
        },
        OpResult::Ok { value: llm_context },
    ) = (session_view, llm_context)
    else {
        return;
    };

    let session_tool_result = message_entries(&session_view.entries)
        .into_iter()
        .find(|e| matches!(e, SessionThreadViewMessage::ToolResult(_)));
    let Some(SessionThreadViewMessage::ToolResult(SessionToolResultMessage {
        content: session_content,
        ..
    })) = session_tool_result
    else {
        panic!("expected toolResult");
    };

    let llm_tool_result = llm_context.messages.iter().find(|message| {
        message
            .content
            .first()
            .is_some_and(|p| p.text.starts_with("[tool result · read_file"))
    });
    assert!(llm_tool_result.is_some());
    let Some(llm_tool_result) = llm_tool_result else {
        return;
    };

    let llm_text = llm_tool_result
        .content
        .first()
        .map(|p| p.text.as_str())
        .expect("llm tool result text part");
    let re = Regex::new(r"^\[tool result · [^\]]+\]\n").expect("re");
    let llm_body = re.replace(llm_text, "").into_owned();
    assert_eq!(session_content, &llm_body);
}

#[tokio::test]
async fn renders_runtime_notes_as_labeled_user_entries_in_tail_order() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let note_text = "<task-notification>task t-123 completed: build finished</task-notification>";
    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(kind::USER_PROMPT, UserPromptOverrides::default()),
                valid_event(kind::ASSISTANT_TEXT, AssistantTextOverrides::default()),
                valid_event(
                    kind::RUNTIME_NOTE,
                    RuntimeNoteOverrides {
                        payload: Some(RuntimeNotePayload {
                            text: note_text.into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new("picked up the notification")),
                        ..Default::default()
                    },
                ),
            ],
        )
        .await;
    assert!(captured.is_ok());

    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    assert!(view.is_ok());
    let OpResult::Ok { value: view } = view else {
        return;
    };

    assert_eq!(
        message_roles(&view.entries),
        ["user", "assistant", "user", "assistant"]
    );
    let note = message_entries(&view.entries)[2];
    // TS toMatchObject — named fields; then sourceMessages length.
    match note {
        SessionThreadViewMessage::User(SessionUserMessage {
            content,
            source_messages,
        }) => {
            assert_eq!(content, &format!("[runtime note] {note_text}"));
            assert_eq!(source_messages.len(), 1);
        }
        other => panic!("expected user note, got {other:?}"),
    }
}
