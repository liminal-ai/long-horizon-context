//! Ported from packages/lhc/test/step-index.test.ts (turn parts, F2).
//!
//! Schema v12 step index: the wire accepts an optional non-negative integer on
//! the four step-bearing kinds, storage keeps it verbatim, `step_edges` reads
//! step structure from it and refuses to split on NULL or inconsistent
//! indices, and the open turn's step edges are structure for compact drift
//! detection.
mod fixtures;

use fixtures::{TempStore, open_raw, temp_store, valid_event_for_kind};
use lhc::intake_stream::{EventKind, MessageEventInput};
use lhc::shared_tech::errors::{ErrorCode, OpResult};
use lhc::thread_view::read_prepared_source_state;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::turns::internal::steps::{StepEdges, StepMember, StepRange, step_edges};
use lhc::{intake_stream, messages, threads};
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

fn event(kind: EventKind, payload: Value) -> MessageEventInput {
    let mut e = valid_event_for_kind(kind);
    e.payload = payload.as_object().expect("payload object").clone();
    e
}

fn m(
    message_id: &str,
    kind: &str,
    step_index: Option<i64>,
    tool_call_id: Option<&str>,
) -> StepMember {
    StepMember {
        message_id: message_id.to_string(),
        order: message_id[1..].parse().expect("m<order>"),
        kind: kind.to_string(),
        step_index,
        tool_call_id: tool_call_id.map(str::to_string),
    }
}

#[tokio::test]
async fn round_trips_verbatim_on_the_four_step_bearing_kinds_and_stays_absent_when_omitted() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let sent = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            event(
                EventKind::AssistantThinking,
                json!({"text": "t", "stepIndex": 0}),
            ),
            event(
                EventKind::AssistantText,
                json!({"text": "a", "stepIndex": 0}),
            ),
            event(
                EventKind::ToolCall,
                json!({"toolCallId": "c1", "toolName": "read", "arguments": {}, "stepIndex": 0}),
            ),
            event(
                EventKind::ToolResult,
                json!({"toolCallId": "c1", "content": "r", "stepIndex": 0}),
            ),
            event(EventKind::AssistantText, json!({"text": "b"})),
        ],
    )
    .await;
    assert!(sent.is_ok(), "{sent:?}");
    let listed = match messages::list(ThreadRef::file_path(&file_path), None).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let shape: Vec<(String, Option<i64>)> = listed
        .iter()
        .map(|r| (r.kind.as_str().to_string(), r.step_index))
        .collect();
    assert_eq!(
        shape,
        vec![
            ("user_prompt".into(), None),
            ("assistant_thinking".into(), Some(0)),
            ("assistant_text".into(), Some(0)),
            ("tool_call".into(), Some(0)),
            ("tool_result".into(), Some(0)),
            ("assistant_text".into(), None),
        ]
    );
    // Absent means the key is omitted on the wire, never null.
    let first = serde_json::to_value(&listed[0]).expect("serialize record");
    assert!(first.get("stepIndex").is_none());
    let fourth = serde_json::to_value(&listed[3]).expect("serialize record");
    assert_eq!(fourth.get("stepIndex"), Some(&json!(0)));
    let shown = messages::show(ThreadRef::file_path(&file_path), "m4").await;
    match shown {
        OpResult::Ok { value } => assert_eq!(value.step_index, Some(0)),
        OpResult::Err { error } => panic!("{}", error.reason),
    }
    store.cleanup();
}

#[tokio::test]
async fn rejects_a_negative_non_integer_or_non_step_kind_step_index_whole() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let bad: Vec<(MessageEventInput, &str)> = vec![
        (
            event(
                EventKind::ToolCall,
                json!({"toolCallId": "c", "toolName": "n", "arguments": {}, "stepIndex": -1}),
            ),
            "payload: \"stepIndex\" Expected a non-negative number, actual -1",
        ),
        (
            event(
                EventKind::AssistantText,
                json!({"text": "x", "stepIndex": 1.5}),
            ),
            "payload: \"stepIndex\" Expected an integer, actual 1.5",
        ),
        (
            event(
                EventKind::AssistantText,
                json!({"text": "x", "stepIndex": "0"}),
            ),
            "payload: \"stepIndex\" Expected number, actual \"0\"",
        ),
        (
            event(EventKind::UserPrompt, json!({"text": "x", "stepIndex": 0})),
            // Merged schema (v13 line): user_prompt also admits `blocks`.
            "payload: \"stepIndex\" is unexpected, expected: \"text\" | \"steer\" | \"blocks\"",
        ),
    ];
    for (e, reason) in bad {
        let result = intake_stream::message_events(ThreadRef::file_path(&file_path), &[e]).await;
        match result {
            OpResult::Ok { .. } => panic!("expected rejection: {reason}"),
            OpResult::Err { error } => {
                assert_eq!(error.code, ErrorCode::InvalidEvent);
                assert_eq!(error.reason, reason);
            }
        }
    }
    let listed = messages::list(ThreadRef::file_path(&file_path), None).await;
    assert!(matches!(listed, OpResult::Ok { ref value } if value.is_empty()));
    store.cleanup();
}

#[test]
fn counts_complete_steps_with_interleaved_parallel_results_and_keeps_the_in_flight_step_open() {
    let edges = step_edges(&[
        m("m1", "user_prompt", None, None),
        m("m2", "assistant_thinking", Some(0), None),
        m("m3", "tool_call", Some(0), Some("a")),
        m("m4", "tool_result", Some(0), Some("a")),
        m("m5", "tool_call", Some(1), Some("b")),
        m("m6", "tool_call", Some(1), Some("c")),
        m("m7", "runtime_note", None, None),
        m("m8", "tool_result", Some(1), Some("c")),
        m("m9", "tool_result", Some(1), Some("b")),
        m("m10", "assistant_text", Some(2), None),
        m("m11", "tool_call", Some(2), Some("d")),
    ]);
    let range = |index: i64, first: &str, last: &str, fo: i64, lo: i64, complete: bool| StepRange {
        index,
        first_message_id: first.into(),
        last_message_id: last.into(),
        first_order: fo,
        last_order: lo,
        complete,
    };
    assert_eq!(
        edges,
        StepEdges {
            splittable: true,
            complete: 2,
            last_edge: Some(1),
            steps: vec![
                range(0, "m2", "m4", 2, 4, true),
                range(1, "m5", "m9", 5, 9, true),
                range(2, "m10", "m11", 10, 11, false),
            ],
        }
    );
}

#[test]
fn is_not_splittable_on_a_null_a_regressing_index_a_straddling_pair_a_start_offset_or_a_gap() {
    let base = vec![
        m("m1", "assistant_text", Some(0), None),
        m("m2", "tool_call", Some(1), Some("a")),
        m("m3", "tool_result", Some(1), Some("a")),
    ];
    let ok = step_edges(&base);
    assert!(ok.splittable);
    assert_eq!((ok.complete, ok.last_edge), (2, Some(1)));

    let mut with_null = base.clone();
    with_null.push(m("m4", "assistant_text", None, None));
    assert!(!step_edges(&with_null).splittable);

    let mut regress = base.clone();
    regress.push(m("m4", "assistant_text", Some(0), None));
    assert!(!step_edges(&regress).splittable);

    let straddle = step_edges(&[
        m("m1", "assistant_text", Some(0), None),
        m("m2", "tool_call", Some(0), Some("a")),
        m("m3", "tool_result", Some(1), Some("a")),
    ]);
    assert!(!straddle.splittable);
    assert_eq!((straddle.complete, straddle.last_edge), (0, None));

    let none = step_edges(&[m("m1", "user_prompt", None, None)]);
    assert!(!none.splittable);
    assert!(none.steps.is_empty());
    assert_eq!(none.last_edge, None);

    // Step coordinates: the first step is 0 and each new step advances by
    // exactly one. An offset start and a gap both fail closed; repeated
    // members inside a step (m2/m3 above) remain valid.
    let offset = step_edges(&[
        m("m1", "assistant_text", Some(1), None),
        m("m2", "assistant_text", Some(2), None),
    ]);
    assert!(!offset.splittable);
    assert_eq!(
        offset.steps.iter().map(|s| s.index).collect::<Vec<_>>(),
        vec![1, 2]
    );
    let gap = step_edges(&[
        m("m1", "assistant_text", Some(0), None),
        m("m2", "assistant_text", Some(2), None),
    ]);
    assert!(!gap.splittable);
    assert_eq!(gap.complete, 2);

    // Exactly one complete step: 0 is not an admissible k.
    let one = step_edges(&[m("m1", "assistant_text", Some(0), None)]);
    assert!(one.splittable);
    assert_eq!((one.complete, one.last_edge), (1, None));
}

#[tokio::test]
async fn structure_digest_changes_with_an_open_turn_step_index_and_not_a_closed_turn_one() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let sent = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            event(
                EventKind::AssistantText,
                json!({"text": "closed", "stepIndex": 0}),
            ),
            valid_event_for_kind(EventKind::TurnEnd),
            valid_event_for_kind(EventKind::UserPrompt),
            event(
                EventKind::AssistantText,
                json!({"text": "open", "stepIndex": 0}),
            ),
        ],
    )
    .await;
    assert!(sent.is_ok(), "{sent:?}");
    let db = open_raw(&file_path);
    let digest = |db: &lhc::shared_tech::storage::Db| {
        read_prepared_source_state(db, 0, &[], None).structure_digest
    };
    let before = digest(&db);
    db.exec("UPDATE message SET step_index = 7 WHERE message_id = 'm2'");
    assert_eq!(digest(&db), before);
    db.exec("UPDATE message SET step_index = 1 WHERE message_id = 'm5'");
    let after = digest(&db);
    assert_ne!(after, before);
    db.exec("UPDATE message SET step_index = NULL WHERE message_id = 'm5'");
    assert_ne!(digest(&db), after);
    db.close();
    store.cleanup();
}

// Keep the raw-map helper type in scope for readers of this file.
#[allow(dead_code)]
fn _payload_type(_: Map<String, Value>) {}
