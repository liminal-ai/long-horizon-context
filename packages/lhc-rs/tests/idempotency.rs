//! Ported from packages/lhc/test/idempotency.test.ts. Phase 1.
//!
//! Flow 5: idempotent resend (TC-5.1 through TC-5.5, asserted at the event
//! level — the no-message / no-transition / no-work-item clauses re-assert in
//! Stories 3-5 as those records exist).

mod fixtures;

use fixtures::{
    TempStore, UserPromptOverrides, UserPromptPayload, conversation_turn, event_batch, kind,
    open_raw, temp_store, valid_event, valid_event_for_kind,
};
use lhc::intake_stream::{
    BatchEventOutcome, BatchEventResult, BatchSkipReason, EventKind, EventRecord,
};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{intake_stream, threads};
use serde_json::Value;

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

async fn read_back(file_path: &str) -> Vec<EventRecord> {
    match intake_stream::list_events(ThreadRef::file_path(file_path)).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("read-back failed: {}", error.reason),
    }
}

/// Serializes every row of every table for below-SDK absence assertions.
fn raw_dump(file_path: &str) -> String {
    let db = open_raw(file_path);
    let tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all(&[]);
    let mut dump = String::new();
    for table in tables {
        let name = table
            .get("name")
            .and_then(|v| v.as_str())
            .expect("table name");
        let rows = db.prepare(&format!("SELECT * FROM \"{name}\"")).all(&[]);
        dump.push_str(&js_json_stringify(&Value::Array(
            rows.into_iter().map(Value::Object).collect(),
        )));
    }
    db.close();
    dump
}

#[tokio::test]
async fn tc_5_1_resending_a_fully_recorded_batch_skips_everything_and_changes_nothing() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let batch = conversation_turn();
    let first = intake_stream::message_events(ThreadRef::file_path(&file_path), &batch).await;
    assert!(first.is_ok());
    if let OpResult::Ok { value } = &first {
        assert!(
            value
                .events
                .iter()
                .all(|entry| entry.outcome == BatchEventOutcome::Recorded)
        );
        assert_eq!(value.thread_position.last_event_order, 5);
    }
    let baseline = read_back(&file_path).await;

    let resend = intake_stream::message_events(ThreadRef::file_path(&file_path), &batch).await;
    assert!(resend.is_ok());
    if let OpResult::Ok { value } = resend {
        assert_eq!(value.events.len(), 5);
        for (index, entry) in value.events.iter().enumerate() {
            assert_eq!(entry.outcome, BatchEventOutcome::Skipped);
            assert_eq!(
                entry.skip_reason,
                Some(BatchSkipReason::DuplicateIdempotencyKey)
            );
            assert_eq!(
                entry.idempotency_key,
                batch[index].idempotency_key.clone().unwrap()
            );
        }
        assert_eq!(value.thread_position.last_event_order, 5);
    }

    assert_eq!(read_back(&file_path).await, baseline);
    store.cleanup();
}

#[tokio::test]
async fn tc_5_2_partial_resend_skips_the_old_records_the_new_and_keeps_the_order_dense() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let old = event_batch(&[
        EventKind::UserPrompt,
        EventKind::AssistantText,
        EventKind::ToolCall,
    ]);
    let first = intake_stream::message_events(ThreadRef::file_path(&file_path), &old).await;
    assert!(first.is_ok());

    let fresh = vec![
        valid_event_for_kind(EventKind::ToolResult),
        valid_event_for_kind(EventKind::TurnEnd),
    ];
    let mut combined = old.clone();
    combined.extend(fresh.clone());
    let resend = intake_stream::message_events(ThreadRef::file_path(&file_path), &combined).await;
    assert!(resend.is_ok());
    if let OpResult::Ok { value } = resend {
        assert_eq!(
            value
                .events
                .iter()
                .map(|entry| entry.outcome)
                .collect::<Vec<_>>(),
            vec![
                BatchEventOutcome::Skipped,
                BatchEventOutcome::Skipped,
                BatchEventOutcome::Skipped,
                BatchEventOutcome::Recorded,
                BatchEventOutcome::Recorded,
            ]
        );
        assert_eq!(value.thread_position.last_event_order, 5);
    }

    let events = read_back(&file_path).await;
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_order())
            .collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5]
    );
    assert_eq!(
        events[3].idempotency_key(),
        fresh[0].idempotency_key.as_deref().unwrap()
    );
    assert_eq!(
        events[4].idempotency_key(),
        fresh[1].idempotency_key.as_deref().unwrap()
    );
    store.cleanup();
}

#[tokio::test]
async fn tc_5_3_idempotency_keys_are_scoped_to_the_thread_same_key_records_in_both_threads() {
    let store = temp_store();
    let thread_a = create_thread(&store).await;
    let thread_b = create_thread(&store).await;
    let event = valid_event(
        kind::USER_PROMPT,
        UserPromptOverrides {
            idempotency_key: Some("shared-key-1".into()),
            ..Default::default()
        },
    );

    let in_a =
        intake_stream::message_events(ThreadRef::file_path(&thread_a), &[event.clone()]).await;
    let in_b = intake_stream::message_events(ThreadRef::file_path(&thread_b), &[event]).await;
    assert!(in_a.is_ok());
    assert!(in_b.is_ok());
    if let (OpResult::Ok { value: a }, OpResult::Ok { value: b }) = (in_a, in_b) {
        assert_eq!(a.events[0].outcome, BatchEventOutcome::Recorded);
        assert_eq!(b.events[0].outcome, BatchEventOutcome::Recorded);
    }

    assert_eq!(
        read_back(&thread_a)
            .await
            .iter()
            .map(|e| e.idempotency_key())
            .collect::<Vec<_>>(),
        vec!["shared-key-1"]
    );
    assert_eq!(
        read_back(&thread_b)
            .await
            .iter()
            .map(|e| e.idempotency_key())
            .collect::<Vec<_>>(),
        vec!["shared-key-1"]
    );
    store.cleanup();
}

#[tokio::test]
async fn tc_5_4_skips_are_inert_no_duplicate_rows_no_order_numbers_consumed_no_transitions_reported()
 {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let batch = event_batch(&[EventKind::UserPrompt, EventKind::TurnEnd]);
    let first = intake_stream::message_events(ThreadRef::file_path(&file_path), &batch).await;
    assert!(first.is_ok());

    let resend = intake_stream::message_events(ThreadRef::file_path(&file_path), &batch).await;
    assert!(resend.is_ok());
    if let OpResult::Ok { value } = resend {
        assert!(
            value
                .events
                .iter()
                .all(|entry| entry.outcome == BatchEventOutcome::Skipped)
        );
        assert_eq!(value.turn_transitions, vec![]);
        assert_eq!(value.queued_work, vec![]);
    }

    // No duplicate event rows: each key appears exactly once below the SDK.
    let db = open_raw(&file_path);
    let counts = db
        .prepare("SELECT idempotency_key, COUNT(*) AS n FROM event GROUP BY idempotency_key")
        .all(&[]);
    assert_eq!(counts.len(), 2);
    for row in &counts {
        assert_eq!(row.get("n").and_then(|v| v.as_i64()), Some(1));
    }
    db.close();

    // Skips consumed no order numbers: the next recorded event lands at 3.
    let next = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;
    assert!(next.is_ok());
    if let OpResult::Ok { value } = next {
        assert_eq!(value.thread_position.last_event_order, 3);
    }
    assert_eq!(
        read_back(&file_path)
            .await
            .iter()
            .map(|e| e.event_order())
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    store.cleanup();
}

#[tokio::test]
async fn tc_5_5_key_wins_over_content_original_payload_intact_resent_payload_stored_nowhere() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let original = valid_event(
        kind::USER_PROMPT,
        UserPromptOverrides {
            idempotency_key: Some("key-K".into()),
            payload: Some(UserPromptPayload {
                text: "PAYLOAD-A-ORIGINAL".into(),
            }),
            ..Default::default()
        },
    );
    let first = intake_stream::message_events(ThreadRef::file_path(&file_path), &[original]).await;
    assert!(first.is_ok());

    let reused = valid_event(
        kind::USER_PROMPT,
        UserPromptOverrides {
            idempotency_key: Some("key-K".into()),
            payload: Some(UserPromptPayload {
                text: "PAYLOAD-B-MUST-VANISH".into(),
            }),
            ..Default::default()
        },
    );
    let resend = intake_stream::message_events(ThreadRef::file_path(&file_path), &[reused]).await;
    assert!(resend.is_ok());
    if let OpResult::Ok { value } = resend {
        assert_eq!(
            value.events[0],
            BatchEventResult {
                idempotency_key: "key-K".into(),
                outcome: BatchEventOutcome::Skipped,
                message_id: None,
                skip_reason: Some(BatchSkipReason::DuplicateIdempotencyKey),
            }
        );
    }

    let events = read_back(&file_path).await;
    assert_eq!(events.len(), 1);
    // Full payload structural equality — rejects extras (TS `.toEqual({ text })`).
    assert_eq!(events[0].prompt_or_note_text(), Some("PAYLOAD-A-ORIGINAL"));
    assert_eq!(events[0].event_kind(), EventKind::UserPrompt);

    // openRaw scan: payload B appears in no table at all.
    let dump = raw_dump(&file_path);
    assert!(dump.contains("PAYLOAD-A-ORIGINAL"));
    assert!(!dump.contains("PAYLOAD-B-MUST-VANISH"));
    store.cleanup();
}
