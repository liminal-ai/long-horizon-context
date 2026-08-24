//! Ported from packages/lhc/test/host-metadata.test.ts (turn parts, AC-7.1).
//!
//! Host metadata surface: the pressure-decision reads. active_turn comes from
//! the record's open turn and its host-supplied step indices; unsettled_turn
//! comes from the installed view alone.
mod fixtures;

use fixtures::{TempStore, open_raw, temp_store, valid_event_for_kind};
use lhc::intake_stream::{EventKind, MessageEventInput};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::view::{HostMetadata, HostMetadataActiveTurn, HostMetadataUnsettledTurn};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{intake_stream, thread_view, threads};
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

async fn read(file_path: &str) -> HostMetadata {
    match thread_view::host_metadata(ThreadRef::file_path(file_path)).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

async fn send(file_path: &str, batch: &[MessageEventInput]) {
    let sent = intake_stream::message_events(ThreadRef::file_path(file_path), batch).await;
    assert!(sent.is_ok(), "{sent:?}");
}

fn active(
    turn_id: &str,
    estimated_tokens: i64,
    complete_steps: i64,
    last_step_edge: Option<i64>,
    splittable: bool,
) -> HostMetadataActiveTurn {
    HostMetadataActiveTurn {
        turn_id: turn_id.into(),
        estimated_tokens,
        complete_steps,
        last_step_edge,
        splittable,
    }
}

#[tokio::test]
async fn reports_the_open_turns_size_and_complete_step_edges_from_stamped_step_indices() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    assert_eq!(
        read(&file_path).await,
        HostMetadata {
            active_turn: Some(active("t1", 0, 0, None, false)),
            unsettled_turn: None,
        }
    );
    send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            event(
                EventKind::AssistantText,
                json!({"text": "step zero", "stepIndex": 0}),
            ),
            event(
                EventKind::ToolCall,
                json!({"toolCallId": "a", "toolName": "read", "arguments": {}, "stepIndex": 1}),
            ),
            event(
                EventKind::ToolCall,
                json!({"toolCallId": "b", "toolName": "read", "arguments": {}, "stepIndex": 1}),
            ),
            event(
                EventKind::ToolResult,
                json!({"toolCallId": "b", "content": "bb", "stepIndex": 1}),
            ),
            event(
                EventKind::ToolResult,
                json!({"toolCallId": "a", "content": "aa", "stepIndex": 1}),
            ),
            event(
                EventKind::ToolCall,
                json!({"toolCallId": "c", "toolName": "read", "arguments": {}, "stepIndex": 2}),
            ),
        ],
    )
    .await;
    let db = open_raw(&file_path);
    let stored_sum = db
        .prepare("SELECT SUM(token_estimate) AS s FROM message WHERE turn_id = 't1'")
        .get()
        .and_then(|r| r.get("s").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    db.close();
    assert!(stored_sum > 0);
    assert_eq!(
        read(&file_path).await,
        HostMetadata {
            active_turn: Some(active("t1", stored_sum, 2, Some(1), true)),
            unsettled_turn: None,
        }
    );

    // Closing the turn moves the active turn to the fresh empty one.
    send(&file_path, &[valid_event_for_kind(EventKind::TurnEnd)]).await;
    assert_eq!(
        read(&file_path).await.active_turn,
        Some(active("t2", 0, 0, None, false))
    );

    // Exactly one complete step: splittable, but no admissible k — the one
    // complete step is the minimum verbatim tail, and 0 is not a split.
    send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            event(
                EventKind::AssistantText,
                json!({"text": "only step", "stepIndex": 0}),
            ),
        ],
    )
    .await;
    let one = read(&file_path).await.active_turn.expect("open turn");
    assert_eq!(
        (
            one.turn_id.as_str(),
            one.complete_steps,
            one.last_step_edge,
            one.splittable
        ),
        ("t2", 1, None, true)
    );
    store.cleanup();
}

#[tokio::test]
async fn a_null_step_index_on_any_step_bearing_member_makes_the_turn_not_splittable_with_no_edge() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            event(
                EventKind::AssistantText,
                json!({"text": "stamped", "stepIndex": 0}),
            ),
            event(EventKind::AssistantText, json!({"text": "unstamped"})),
            event(
                EventKind::AssistantText,
                json!({"text": "stamped again", "stepIndex": 1}),
            ),
        ],
    )
    .await;
    let turn = read(&file_path).await.active_turn.expect("open turn");
    assert_eq!(
        (
            turn.turn_id.as_str(),
            turn.complete_steps,
            turn.last_step_edge,
            turn.splittable
        ),
        ("t1", 2, None, false)
    );
    store.cleanup();
}

#[tokio::test]
async fn derives_the_unsettled_turn_from_the_installed_views_part_entry_never_from_the_record() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            event(
                EventKind::AssistantText,
                json!({"text": "a", "stepIndex": 0}),
            ),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    let install = |arrangement: Value| {
        let db = open_raw(&file_path);
        db.exec("DELETE FROM thread_view");
        db.prepare(
            "INSERT INTO thread_view (singleton, view_id, created_at, compact_point, covered_from, profile_name,
               config_json, arrangement_json, gaps_json, source_state_json)
             VALUES (1, 'v-test', '2026-01-01T00:00:00.000Z', 2, 0, NULL, '{\"lowerBound\":1,\"percentages\":{}}', ?, '[]', '{\"maxEventOrder\":0,\"derivationCounts\":{}}')",
        )
        .run(&[lhc::shared_tech::storage::SqlParam::from(arrangement.to_string().as_str())]);
        db.close();
    };
    let whole = json!({
        "band": "smooth",
        "subjectKind": "turn",
        "subjectId": "t1",
        "derivationUsed": "turn_rendering",
        "degraded": false
    });
    install(json!([whole]));
    assert_eq!(read(&file_path).await.unsettled_turn, None);
    let mut part = whole.clone();
    part["derivationUsed"] = json!("part");
    part["part"] = json!({"fromStep": 0, "toStep": 0});
    install(json!([part]));
    assert_eq!(
        read(&file_path).await.unsettled_turn,
        Some(HostMetadataUnsettledTurn {
            turn_id: "t1".into()
        })
    );
    // The stored view reports the part range verbatim.
    let described = match thread_view::describe(ThreadRef::file_path(&file_path)).await {
        OpResult::Ok { value } => value.expect("view"),
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let entry = serde_json::to_value(&described.arrangement[0]).expect("entry");
    assert_eq!(entry["part"], json!({"fromStep": 0, "toStep": 0}));
    store.cleanup();
}
