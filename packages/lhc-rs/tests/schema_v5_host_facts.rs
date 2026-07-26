//! Ported from packages/lhc/test/schema-v5-host-facts.test.ts.
//!
//! Schema v5 slice: turn-scoped host facts (provider usage, turn outcome,
//! wall-clock timing). Intake accepts optional payload fields; projection
//! writes them; turns/messages reads expose them; empty turn_end stays valid.

mod fixtures;

use fixtures::{
    TempStore, TurnEndOverrides, TurnEndPayload, open_raw, temp_store, valid_event,
    valid_event_for_kind,
};
use lhc::intake_stream::{EventKind, MessageEventInput, TurnOutcome};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{intake_stream, messages, threads, turns};
use serde_json::{Map, Value, json};

async fn create_thread(store: &TempStore) -> String {
    let file_path = store.thread_path(None);
    let created = threads::new_thread(NewThreadInput {
        file_path: file_path.to_string_lossy().into_owned(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await;
    match created {
        OpResult::Ok { value } => value.file_path,
        OpResult::Err { error } => panic!("fixture thread creation failed: {}", error.reason),
    }
}

async fn send(file_path: &str, batch: &[MessageEventInput]) -> lhc::BatchResult {
    let result = intake_stream::message_events(ThreadRef::file_path(file_path), batch).await;
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("fixture batch failed: {}", error.reason),
    }
}

fn with_payload(mut event: MessageEventInput, payload: Map<String, Value>) -> MessageEventInput {
    event.payload = payload;
    event
}

#[tokio::test]
async fn empty_turn_end_payload_is_still_valid_and_closes_the_turn_without_host_facts() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let result = send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    assert_eq!(
        result
            .events
            .iter()
            .map(|e| e.outcome.as_str())
            .collect::<Vec<_>>(),
        vec!["recorded", "recorded", "recorded"]
    );
    assert_eq!(result.turn_transitions.len(), 2);
    assert_eq!(result.turn_transitions[0].action.as_str(), "closed");
    assert_eq!(result.turn_transitions[0].turn_id, "t1");
    assert_eq!(result.turn_transitions[1].action.as_str(), "opened");
    assert_eq!(result.turn_transitions[1].turn_id, "t2");

    let turn_records = turns::list_turns(ThreadRef::file_path(&file_path)).await;
    assert!(turn_records.is_ok());
    let OpResult::Ok { value: listed } = turn_records else {
        return;
    };
    let closed = listed.iter().find(|t| t.turn_id == "t1").expect("t1");
    assert_eq!(closed.status.as_str(), "closed");
    assert_eq!(closed.closed_at_event_order, Some(3));
    // Absent keys when unknown — not null-serialized Option fields on the wire.
    assert!(closed.outcome.is_none());
    assert!(closed.outcome_reason.is_none());
    assert!(closed.started_at.is_none());
    assert!(closed.ended_at.is_none());

    let db = open_raw(&file_path);
    let row = db
        .prepare(
            "SELECT outcome, outcome_reason, started_at, ended_at FROM turns WHERE turn_id = 't1'",
        )
        .get()
        .expect("t1 row");
    assert!(matches!(row.get("outcome"), None | Some(Value::Null)));
    assert!(matches!(
        row.get("outcome_reason"),
        None | Some(Value::Null)
    ));
    assert!(matches!(row.get("started_at"), None | Some(Value::Null)));
    assert!(matches!(row.get("ended_at"), None | Some(Value::Null)));
    db.close();
    store.cleanup();
}

#[tokio::test]
async fn turn_end_host_facts_round_trip_intake_storage_turns_list_turns_verbatim() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let host_facts = TurnEndPayload {
        outcome: Some("aborted".into()),
        outcome_reason: Some("user cancelled mid-tool".into()),
        started_at: Some("2026-07-01T12:00:00.000Z".into()),
        ended_at: Some("2026-07-01T12:00:04.250Z".into()),
    };
    send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
            valid_event(
                fixtures::kind::TURN_END,
                TurnEndOverrides {
                    payload: Some(host_facts.clone()),
                    ..Default::default()
                },
            ),
        ],
    )
    .await;

    let listed = turns::list_turns(ThreadRef::file_path(&file_path)).await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };
    let closed = listed.iter().find(|t| t.turn_id == "t1").expect("t1");
    assert_eq!(closed.status.as_str(), "closed");
    assert_eq!(closed.outcome, Some(TurnOutcome::Aborted));
    assert_eq!(
        closed.outcome_reason.as_deref(),
        Some("user cancelled mid-tool")
    );
    assert_eq!(
        closed.started_at.as_deref(),
        Some("2026-07-01T12:00:00.000Z")
    );
    assert_eq!(closed.ended_at.as_deref(), Some("2026-07-01T12:00:04.250Z"));

    // Storage holds the same strings; no rewrite, no defaulting.
    let db = open_raw(&file_path);
    let row = db
        .prepare(
            "SELECT outcome, outcome_reason, started_at, ended_at FROM turns WHERE turn_id = 't1'",
        )
        .get()
        .expect("t1 row");
    assert_eq!(row.get("outcome").and_then(|v| v.as_str()), Some("aborted"));
    assert_eq!(
        row.get("outcome_reason").and_then(|v| v.as_str()),
        Some("user cancelled mid-tool")
    );
    assert_eq!(
        row.get("started_at").and_then(|v| v.as_str()),
        Some("2026-07-01T12:00:00.000Z")
    );
    assert_eq!(
        row.get("ended_at").and_then(|v| v.as_str()),
        Some("2026-07-01T12:00:04.250Z")
    );
    db.close();

    // Event payload also retains the facts (canonical record).
    let events = intake_stream::list_events(ThreadRef::file_path(&file_path)).await;
    assert!(events.is_ok());
    let OpResult::Ok { value: events } = events else {
        return;
    };
    let turn_end = events
        .iter()
        .find(|e| e.event_kind() == EventKind::TurnEnd)
        .expect("turn_end event");
    let payload = turn_end.turn_end_payload().expect("turn_end payload");
    assert_eq!(payload.outcome, Some(TurnOutcome::Aborted));
    assert_eq!(
        payload.outcome_reason.as_deref(),
        Some("user cancelled mid-tool")
    );
    assert_eq!(
        payload.started_at.as_deref(),
        Some("2026-07-01T12:00:00.000Z")
    );
    assert_eq!(
        payload.ended_at.as_deref(),
        Some("2026-07-01T12:00:04.250Z")
    );
    store.cleanup();
}

#[tokio::test]
async fn assistant_text_provider_usage_round_trips_byte_level_through_list_and_show() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    // Nested, mixed-type shape — not a fixed column set; fidelity is the point.
    let provider_usage = json!({
        "input_tokens": 1204,
        "cached_input_tokens": 900,
        "output_tokens": 88,
        "reasoning_output_tokens": 12,
        "nested": { "cache_write": 0, "provider": "openai-codex" },
    });
    let usage_json = js_json_stringify(&provider_usage);

    let mut assistant = valid_event_for_kind(EventKind::AssistantText);
    assistant.payload = json!({
        "text": "done",
        "providerUsage": provider_usage,
    })
    .as_object()
    .expect("object")
    .clone();

    send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            assistant,
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;

    let listed = messages::list(ThreadRef::file_path(&file_path), None).await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };
    let assistant_msg = listed
        .iter()
        .find(|m| m.kind.as_str() == "assistant_text")
        .expect("assistant_text");
    let listed_usage = assistant_msg
        .provider_usage
        .as_ref()
        .expect("providerUsage present");
    assert_eq!(
        js_json_stringify(&Value::Object(listed_usage.clone())),
        usage_json
    );

    let shown = messages::show(ThreadRef::file_path(&file_path), &assistant_msg.message_id).await;
    assert!(shown.is_ok());
    let OpResult::Ok { value: shown } = shown else {
        return;
    };
    let shown_usage = shown
        .provider_usage
        .as_ref()
        .expect("providerUsage present");
    assert_eq!(
        js_json_stringify(&Value::Object(shown_usage.clone())),
        usage_json
    );

    let db = open_raw(&file_path);
    let row = db
        .prepare("SELECT provider_usage FROM message WHERE message_id = ?")
        .get_params(&[lhc::shared_tech::storage::SqlParam::from(
            assistant_msg.message_id.as_str(),
        )])
        .expect("message row");
    // Stored column is the verbatim JSON string.
    assert_eq!(
        row.get("provider_usage").and_then(|v| v.as_str()),
        Some(usage_json.as_str())
    );
    db.close();
    store.cleanup();
}

#[tokio::test]
async fn assistant_text_without_provider_usage_stores_and_reads_as_null_absent() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let mut assistant = valid_event_for_kind(EventKind::AssistantText);
    assistant.payload = json!({"text": "no usage attached"})
        .as_object()
        .expect("object")
        .clone();

    send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            assistant,
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;

    let listed = messages::list(ThreadRef::file_path(&file_path), None).await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };
    let assistant_msg = listed
        .iter()
        .find(|m| m.kind.as_str() == "assistant_text")
        .expect("assistant_text");
    assert!(assistant_msg.provider_usage.is_none());

    let shown = messages::show(ThreadRef::file_path(&file_path), &assistant_msg.message_id).await;
    assert!(shown.is_ok());
    let OpResult::Ok { value: shown } = shown else {
        return;
    };
    assert!(shown.provider_usage.is_none());

    let db = open_raw(&file_path);
    let row = db
        .prepare("SELECT provider_usage FROM message WHERE message_id = ?")
        .get_params(&[lhc::shared_tech::storage::SqlParam::from(
            assistant_msg.message_id.as_str(),
        )])
        .expect("message row");
    assert!(matches!(
        row.get("provider_usage"),
        None | Some(Value::Null)
    ));
    db.close();
    store.cleanup();
}

#[tokio::test]
async fn invalid_outcome_value_is_rejected_whole() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let result = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            with_payload(
                valid_event_for_kind(EventKind::TurnEnd),
                json!({"outcome": "interrupted"})
                    .as_object()
                    .expect("object")
                    .clone(),
            ),
        ],
    )
    .await;
    assert!(!result.is_ok());
    if let OpResult::Err { error } = result {
        assert_eq!(error.error_class, ErrorClass::CallerError);
        assert_eq!(error.code, ErrorCode::InvalidEvent);
        assert_eq!(error.event_index, Some(1));
        assert!(error.reason.contains("outcome"), "reason={}", error.reason);
    }
    store.cleanup();
}

#[tokio::test]
async fn unknown_key_in_turn_end_payload_is_rejected() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let result = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[with_payload(
            valid_event_for_kind(EventKind::TurnEnd),
            json!({"surprise": true})
                .as_object()
                .expect("object")
                .clone(),
        )],
    )
    .await;
    assert!(!result.is_ok());
    if let OpResult::Err { error } = result {
        assert_eq!(error.error_class, ErrorClass::CallerError);
        assert_eq!(error.code, ErrorCode::InvalidEvent);
        assert!(error.reason.contains("surprise"), "reason={}", error.reason);
    }
    store.cleanup();
}

#[tokio::test]
async fn provider_usage_that_is_not_a_json_object_is_rejected() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let bads: Vec<Value> = vec![
        json!("tokens"),
        json!(12),
        json!(true),
        json!(null),
        json!([1, 2]),
    ];
    for bad in bads {
        let result = intake_stream::message_events(
            ThreadRef::file_path(&file_path),
            &[with_payload(
                valid_event_for_kind(EventKind::AssistantText),
                json!({"text": "hi", "providerUsage": bad})
                    .as_object()
                    .expect("object")
                    .clone(),
            )],
        )
        .await;
        assert!(!result.is_ok());
        if let OpResult::Err { error } = result {
            assert_eq!(error.code, ErrorCode::InvalidEvent);
            assert!(
                error.reason.contains("providerUsage"),
                "reason={}",
                error.reason
            );
        }
    }
    store.cleanup();
}

#[tokio::test]
async fn outcome_completed_alone_is_valid_and_projects() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
            valid_event(
                fixtures::kind::TURN_END,
                TurnEndOverrides {
                    payload: Some(TurnEndPayload {
                        outcome: Some("completed".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            ),
        ],
    )
    .await;
    let listed = turns::list_turns(ThreadRef::file_path(&file_path)).await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };
    let closed = listed.iter().find(|t| t.turn_id == "t1").expect("t1");
    assert_eq!(closed.status.as_str(), "closed");
    assert_eq!(closed.outcome, Some(TurnOutcome::Completed));
    store.cleanup();
}
