//! Ported from packages/lhc/test/intake-message-materialization.test.ts. Phase 1.
//!
//! Story 3 (Flow 2, message materialization half): TC-2.2 through TC-2.5, TC-5.4's
//! no-duplicate-message clause, and the message materialization rung of the
//! rollback ladder.

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, AssistantThinkingOverrides,
    AssistantThinkingPayload, RuntimeNoteOverrides, RuntimeNotePayload, ToolCallOverrides,
    ToolCallPayload, ToolResultOverrides, ToolResultPayload, UserPromptOverrides,
    UserPromptPayload, event_batch, kind, open_raw, set_intake_walk_hook, temp_store, valid_event,
};
use lhc::intake_stream::{BatchEventOutcome, EventKind, EventRecord};
use lhc::messages::{Block, BlockType, MessageKind, MessageRecord};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{intake_stream, messages, threads};
use serde_json::{Map, Value, json};

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

async fn create_thread(store: &fixtures::TempStore) -> String {
    let file_path = path_str(&store.thread_path(None));
    let created = threads::new_thread(NewThreadInput {
        file_path: file_path.clone(),
        title: None,
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    match created {
        OpResult::Ok { value: _ } => file_path,
        OpResult::Err { error } => panic!("fixture thread creation failed: {}", error.reason),
    }
}

async fn read_events(file_path: &str) -> Vec<EventRecord> {
    match intake_stream::list_events(ThreadRef::file_path(file_path)).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("event read-back failed: {}", error.reason),
    }
}

async fn read_messages(file_path: &str) -> Vec<MessageRecord> {
    match messages::list(ThreadRef::file_path(file_path), None).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("message read-back failed: {}", error.reason),
    }
}

fn text_block(text: &str) -> Block {
    let mut content = Map::new();
    content.insert("text".into(), json!(text));
    Block {
        block_type: BlockType::Text,
        content,
    }
}

#[tokio::test]
async fn tc_2_2_one_of_each_kind_materializes_six_messages_with_kind_appropriate_blocks_turn_end_stays_event_only()
 {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let mut tool_args = Map::new();
    tool_args.insert("path".into(), json!("notes.txt"));
    tool_args.insert("offset".into(), json!(10));
    let batch = vec![
        valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "please summarize the file".into(),
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::ASSISTANT_TEXT,
            AssistantTextOverrides {
                payload: Some(AssistantTextPayload {
                    text: "the file describes turn handling".into(),
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::ASSISTANT_THINKING,
            AssistantThinkingOverrides {
                payload: Some(AssistantThinkingPayload {
                    text: "the request needs the file first".into(),
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::RUNTIME_NOTE,
            RuntimeNoteOverrides {
                payload: Some(RuntimeNotePayload {
                    text: "harness reconnected".into(),
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: "call-42".into(),
                    tool_name: "read_file".into(),
                    arguments: tool_args,
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::TOOL_RESULT,
            ToolResultOverrides {
                payload: Some(ToolResultPayload {
                    tool_call_id: "call-42".into(),
                    content: "line one\nline two".into(),
                    is_error: Some(false),
                }),
                ..Default::default()
            },
        ),
        valid_event(kind::TURN_END, Default::default()),
    ];

    let result = intake_stream::message_events(ThreadRef::file_path(&file_path), &batch).await;
    assert!(result.is_ok());
    let OpResult::Ok { value } = result else {
        panic!("message_events Ok payload");
    };

    // messageId appears on every recorded message-producing entry, in walk
    // order; the turn_end entry is recorded but carries no messageId.
    assert_eq!(
        value.events.iter().map(|e| e.outcome).collect::<Vec<_>>(),
        vec![BatchEventOutcome::Recorded; 7]
    );
    assert_eq!(
        value
            .events
            .iter()
            .map(|e| e.message_id.clone())
            .collect::<Vec<_>>(),
        vec![
            Some("m1".into()),
            Some("m2".into()),
            Some("m3".into()),
            Some("m4".into()),
            Some("m5".into()),
            Some("m6".into()),
            None,
        ]
    );

    // turn_end is present in the event order but absent from messages.
    assert_eq!(
        read_events(&file_path)
            .await
            .iter()
            .map(|e| e.event_kind().as_str())
            .collect::<Vec<_>>(),
        [
            "user_prompt",
            "assistant_text",
            "assistant_thinking",
            "runtime_note",
            "tool_call",
            "tool_result",
            "turn_end",
        ]
    );

    let materialized = read_messages(&file_path).await;
    assert_eq!(
        materialized
            .iter()
            .map(|m| m.message_id.as_str())
            .collect::<Vec<_>>(),
        ["m1", "m2", "m3", "m4", "m5", "m6"]
    );
    assert_eq!(
        materialized
            .iter()
            .map(|m| m.source_event_order)
            .collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5, 6]
    );
    assert_eq!(
        materialized.iter().map(|m| m.kind).collect::<Vec<_>>(),
        [
            MessageKind::UserPrompt,
            MessageKind::AssistantText,
            MessageKind::AssistantThinking,
            MessageKind::RuntimeNote,
            MessageKind::ToolCall,
            MessageKind::ToolResult,
        ]
    );

    // Full block structure per kind, content verbatim — not just block count.
    assert_eq!(
        materialized[0].blocks,
        vec![text_block("please summarize the file")]
    );
    assert_eq!(
        materialized[1].blocks,
        vec![text_block("the file describes turn handling")]
    );
    assert_eq!(
        materialized[2].blocks,
        vec![text_block("the request needs the file first")]
    );
    assert_eq!(
        materialized[3].blocks,
        vec![text_block("harness reconnected")]
    );

    let mut tool_call_content = Map::new();
    tool_call_content.insert("toolCallId".into(), json!("call-42"));
    tool_call_content.insert("toolName".into(), json!("read_file"));
    let mut args = Map::new();
    args.insert("path".into(), json!("notes.txt"));
    args.insert("offset".into(), json!(10));
    tool_call_content.insert("arguments".into(), Value::Object(args));
    assert_eq!(
        materialized[4].blocks,
        vec![Block {
            block_type: BlockType::ToolCall,
            content: tool_call_content,
        }]
    );

    let mut tool_result_content = Map::new();
    tool_result_content.insert("toolCallId".into(), json!("call-42"));
    tool_result_content.insert("content".into(), json!("line one\nline two"));
    tool_result_content.insert("isError".into(), json!(false));
    assert_eq!(
        materialized[5].blocks,
        vec![Block {
            block_type: BlockType::ToolResult,
            content: tool_result_content,
        }]
    );

    // Story 4 stamps membership at intake: the prompt opened t1 and every
    // message in the batch belongs to it (turn_end closed it, no message).
    for message in &materialized {
        assert_eq!(message.turn_id, "t1");
    }
    set_intake_walk_hook(None);
    store.cleanup();
}

#[tokio::test]
async fn tc_2_3_identical_content_in_two_threads_yields_identical_token_estimates_every_message_carries_one()
 {
    let store = temp_store();
    let thread_a = create_thread(&store).await;
    let thread_b = create_thread(&store).await;

    let build_batch = || {
        let mut args = Map::new();
        args.insert("query".into(), json!("same query"));
        vec![
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "estimate me consistently".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "c1".into(),
                        tool_name: "search".into(),
                        arguments: args,
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "c1".into(),
                        content: "same result content".into(),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ),
        ]
    };

    let in_a = intake_stream::message_events(ThreadRef::file_path(&thread_a), &build_batch()).await;
    let in_b = intake_stream::message_events(ThreadRef::file_path(&thread_b), &build_batch()).await;
    assert!(in_a.is_ok());
    assert!(in_b.is_ok());

    let messages_a = read_messages(&thread_a).await;
    let messages_b = read_messages(&thread_b).await;
    assert_eq!(messages_a.len(), 3);
    for message in messages_a.iter().chain(messages_b.iter()) {
        assert!(message.token_estimate > 0);
    }
    assert_eq!(
        messages_a
            .iter()
            .map(|m| m.token_estimate)
            .collect::<Vec<_>>(),
        messages_b
            .iter()
            .map(|m| m.token_estimate)
            .collect::<Vec<_>>()
    );
    set_intake_walk_hook(None);
    store.cleanup();
}

#[tokio::test]
async fn tc_2_4_a_300kb_tool_result_reads_back_byte_identical_through_the_sdk() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    // Varied content (unicode included) repeated past any rendering
    // threshold; byte-identity is asserted on the full string, not a length
    // or checksum shortcut.
    let big_content = "tool output line δσπ 😀 — verbatim?\n".repeat(8000);
    assert!(big_content.len() > 300_000);

    let result = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[valid_event(
            kind::TOOL_RESULT,
            ToolResultOverrides {
                payload: Some(ToolResultPayload {
                    tool_call_id: "big-1".into(),
                    content: big_content.clone(),
                    is_error: Some(false),
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    assert!(result.is_ok());

    let events = read_events(&file_path).await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_kind(), EventKind::ToolResult);
    let payload = events[0]
        .tool_result_payload()
        .expect("tool_result payload");
    assert_eq!(payload.content.as_str(), big_content.as_str());

    let materialized = read_messages(&file_path).await;
    assert_eq!(materialized.len(), 1);
    assert_eq!(materialized[0].blocks.len(), 1);
    let block = &materialized[0].blocks[0];
    assert_eq!(block.block_type, BlockType::ToolResult);
    assert_eq!(
        block.content.get("content").and_then(|v| v.as_str()),
        Some(big_content.as_str())
    );
    assert_eq!(
        block.content.get("toolCallId").and_then(|v| v.as_str()),
        Some("big-1")
    );
    set_intake_walk_hook(None);
    store.cleanup();
}

#[tokio::test]
async fn tc_2_5_actor_and_harness_are_recorded_as_given_and_carried_onto_messages() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let batch = vec![
        valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                actor: Some("user:lee".into()),
                harness: Some("pi-extension/1.2".into()),
                ..Default::default()
            },
        ),
        valid_event(
            kind::ASSISTANT_TEXT,
            AssistantTextOverrides {
                actor: Some("agent:claude".into()),
                harness: Some("claude-code/2.0".into()),
                ..Default::default()
            },
        ),
    ];
    let result = intake_stream::message_events(ThreadRef::file_path(&file_path), &batch).await;
    assert!(result.is_ok());

    let events = read_events(&file_path).await;
    assert_eq!(
        events
            .iter()
            .map(|e| (e.actor(), e.harness()))
            .collect::<Vec<_>>(),
        [
            ("user:lee", "pi-extension/1.2"),
            ("agent:claude", "claude-code/2.0")
        ]
    );

    let materialized = read_messages(&file_path).await;
    assert_eq!(
        materialized
            .iter()
            .map(|m| (m.actor.as_str(), m.harness.as_str()))
            .collect::<Vec<_>>(),
        [
            ("user:lee", "pi-extension/1.2"),
            ("agent:claude", "claude-code/2.0")
        ]
    );
    set_intake_walk_hook(None);
    store.cleanup();
}

#[tokio::test]
async fn tc_5_4_message_clause_a_skipped_event_creates_no_duplicate_message() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let batch = event_batch(&[EventKind::UserPrompt, EventKind::TurnEnd]);
    let first = intake_stream::message_events(ThreadRef::file_path(&file_path), &batch).await;
    assert!(first.is_ok());
    let baseline = read_messages(&file_path).await;
    assert_eq!(baseline.len(), 1);

    let resend = intake_stream::message_events(ThreadRef::file_path(&file_path), &batch).await;
    assert!(resend.is_ok());
    if let OpResult::Ok { value } = &resend {
        assert!(
            value
                .events
                .iter()
                .all(|e| e.outcome == BatchEventOutcome::Skipped)
        );
        assert!(value.events.iter().all(|e| e.message_id.is_none()));
    }

    assert_eq!(read_messages(&file_path).await, baseline);

    // Below the SDK: exactly one message row per source event order.
    let db = open_raw(&file_path);
    let counts = db
        .prepare(
            "SELECT source_event_order, COUNT(*) AS n FROM message GROUP BY source_event_order",
        )
        .all(&[]);
    assert_eq!(counts.len(), 1);
    let n = counts[0].get("n").and_then(|v| v.as_i64()).unwrap_or(0);
    assert_eq!(n, 1);
    db.close();
    set_intake_walk_hook(None);
    store.cleanup();
}

#[tokio::test]
async fn architecture_risk_an_induced_message_materialization_failure_rejects_the_whole_batch() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let seeded = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[valid_event(kind::USER_PROMPT, Default::default())],
    )
    .await;
    assert!(seeded.is_ok());
    let baseline_events = read_events(&file_path).await;
    let baseline_messages = read_messages(&file_path).await;
    assert_eq!(baseline_events.len(), 1);
    assert_eq!(baseline_messages.len(), 1);

    // Real mechanism: after the new batch's first event records and materializes,
    // the seam drops the block table, so the second event's message materialization insert
    // fails inside the transaction.
    set_intake_walk_hook(Some(Box::new(|db, event_index| {
        if event_index == 0 {
            db.exec("DROP TABLE message_block");
        }
    })));
    let result = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &event_batch(&[EventKind::AssistantText, EventKind::AssistantThinking]),
    )
    .await;
    set_intake_walk_hook(None);
    assert!(!result.is_ok());
    if let OpResult::Err { error } = &result {
        assert_eq!(error.error_class, ErrorClass::SystemError);
        assert_eq!(error.code, ErrorCode::StorageFailure);
    }

    // Read-back state, not the error result alone: events and messages are
    // both at baseline — message materialization failure stranded no event rows.
    assert_eq!(read_events(&file_path).await, baseline_events);
    assert_eq!(read_messages(&file_path).await, baseline_messages);
    store.cleanup();
}
