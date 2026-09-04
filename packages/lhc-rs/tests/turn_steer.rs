//! Ported from packages/lhc/test/turn-steer.test.ts (turn parts, Flow 7).
//!
//! The host's steer assertion on user_prompt. A steering prompt (steer: true)
//! inside a run in progress joins the open turn; it is never a boundary, so
//! the task's turn identity survives a steer. Absent, a populated open turn
//! still closes and a new one opens.
mod fixtures;

use fixtures::{TempStore, open_raw, temp_store, valid_event_for_kind};
use lhc::intake_stream::{EventKind, MessageEventInput, TurnTransitionAction};
use lhc::shared_tech::errors::{ErrorCode, OpResult};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::turns::{TurnStatus, read_turn_steps};
use lhc::{intake_stream, messages, threads, turns};
use serde_json::{Value, json};

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

fn event(kind: EventKind, payload: Value) -> MessageEventInput {
    let mut e = valid_event_for_kind(kind);
    e.payload = payload.as_object().expect("payload object").clone();
    e
}

#[tokio::test]
async fn a_steer_joins_the_open_turn_a_plain_prompt_still_closes_and_opens_and_the_flag_is_validated()
 {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let sent = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[
            event(EventKind::UserPrompt, json!({"text": "big task"})),
            event(
                EventKind::AssistantText,
                json!({"text": "step 0", "stepIndex": 0}),
            ),
            event(
                EventKind::UserPrompt,
                json!({"text": "actually, focus on the tests", "steer": true}),
            ),
            event(
                EventKind::AssistantText,
                json!({"text": "step 1", "stepIndex": 1}),
            ),
        ],
    )
    .await;
    let batch = match sent {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    assert!(batch.turn_transitions.is_empty());

    let listed = match messages::list(ThreadRef::file_path(&file_path), None).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let shape: Vec<(String, String)> = listed
        .iter()
        .map(|r| (r.turn_id.clone(), r.kind.as_str().to_string()))
        .collect();
    assert_eq!(
        shape,
        vec![
            ("t1".into(), "user_prompt".into()),
            ("t1".into(), "assistant_text".into()),
            ("t1".into(), "user_prompt".into()),
            ("t1".into(), "assistant_text".into()),
        ]
    );
    assert_eq!(
        Value::Object(listed[2].blocks[0].content.clone()),
        json!({"text": "actually, focus on the tests", "steer": true})
    );
    assert_eq!(
        Value::Object(listed[0].blocks[0].content.clone()),
        json!({"text": "big task"})
    );

    // Steps stay consistent around the steer; the turn is still splittable.
    let db = open_raw(&file_path);
    let edges = read_turn_steps(&db, "t1");
    db.close();
    assert!(edges.splittable);
    assert_eq!((edges.complete, edges.last_edge), (2, Some(1)));

    // A plain prompt is still a boundary.
    let next = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[event(EventKind::UserPrompt, json!({"text": "new task"}))],
    )
    .await;
    let next = match next {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let transitions: Vec<(TurnTransitionAction, String)> = next
        .turn_transitions
        .iter()
        .map(|t| (t.action.clone(), t.turn_id.clone()))
        .collect();
    assert_eq!(
        transitions,
        vec![
            (TurnTransitionAction::Closed, "t1".into()),
            (TurnTransitionAction::Opened, "t2".into()),
        ]
    );
    let open = match turns::list_turns(ThreadRef::file_path(&file_path)).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let statuses: Vec<(String, TurnStatus)> = open
        .iter()
        .map(|t| (t.turn_id.clone(), t.status.clone()))
        .collect();
    assert_eq!(
        statuses,
        vec![
            ("t1".into(), TurnStatus::Closed),
            ("t2".into(), TurnStatus::Open)
        ]
    );

    // Closed validation: steer must be a boolean; no other kind takes it.
    for (bad, reason) in [
        (
            event(EventKind::UserPrompt, json!({"text": "x", "steer": "yes"})),
            "payload: \"steer\" Expected boolean, actual \"yes\"",
        ),
        (
            event(
                EventKind::AssistantText,
                json!({"text": "x", "steer": true}),
            ),
            "payload: \"steer\" is unexpected, expected: \"text\" | \"providerUsage\" | \"provider\" | \"model\" | \"api\" | \"stepIndex\"",
        ),
        (
            event(EventKind::RuntimeNote, json!({"text": "x", "steer": true})),
            "payload: \"steer\" is unexpected, expected: \"text\"",
        ),
    ] {
        let result = intake_stream::message_events(ThreadRef::file_path(&file_path), &[bad]).await;
        match result {
            OpResult::Ok { .. } => panic!("expected rejection: {reason}"),
            OpResult::Err { error } => {
                assert_eq!(error.code, ErrorCode::InvalidEvent);
                assert_eq!(error.reason, reason);
            }
        }
    }
    store.cleanup();
}
