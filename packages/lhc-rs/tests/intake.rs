//! Ported from packages/lhc/test/intake.test.ts. Phase 1.
//!
//! Flow 2 (recording half): TC-2.1, TC-2.8, TC-1.4, and architecture-risk tests.

mod fixtures;

use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use fixtures::{
    conversation_turn, event_batch, open_raw, set_intake_clock, set_intake_walk_hook, temp_store,
    valid_event_for_kind,
};
use lhc::intake_stream::{BatchEventOutcome, EventKind, EventRecord};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::threads::{NewThreadInput, ThreadRef, ThreadRefId};
use lhc::{intake_stream, threads};

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

async fn read_back(file_path: &str) -> Vec<EventRecord> {
    match intake_stream::list_events(ThreadRef::file_path(file_path)).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("read-back failed: {}", error.reason),
    }
}

#[tokio::test]
async fn tc_2_1_two_batches_record_in_array_order_with_a_dense_continuing_event_order() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let batch_one = event_batch(&[
        EventKind::UserPrompt,
        EventKind::AssistantText,
        EventKind::ToolCall,
    ]);
    let batch_two = event_batch(&[
        EventKind::ToolResult,
        EventKind::RuntimeNote,
        EventKind::TurnEnd,
    ]);

    let first = intake_stream::message_events(ThreadRef::file_path(&file_path), &batch_one).await;
    assert!(first.is_ok());
    if let OpResult::Ok { value } = &first {
        assert_eq!(
            value.events.iter().map(|e| e.outcome).collect::<Vec<_>>(),
            vec![
                BatchEventOutcome::Recorded,
                BatchEventOutcome::Recorded,
                BatchEventOutcome::Recorded
            ]
        );
        assert_eq!(value.thread_position.last_event_order, 3);
    }

    let second = intake_stream::message_events(ThreadRef::file_path(&file_path), &batch_two).await;
    assert!(second.is_ok());
    if let OpResult::Ok { value } = &second {
        assert_eq!(value.thread_position.last_event_order, 6);
    }

    let events = read_back(&file_path).await;
    assert_eq!(
        events.iter().map(|e| e.event_order()).collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5, 6]
    );
    assert_eq!(
        events
            .iter()
            .map(|e| e.event_kind().as_str())
            .collect::<Vec<_>>(),
        [
            "user_prompt",
            "assistant_text",
            "tool_call",
            "tool_result",
            "runtime_note",
            "turn_end",
        ]
    );
    let expected_keys: Vec<_> = batch_one
        .iter()
        .chain(batch_two.iter())
        .map(|e| e.idempotency_key.clone().expect("fixture key"))
        .collect();
    assert_eq!(
        events
            .iter()
            .map(|e| e.idempotency_key().to_string())
            .collect::<Vec<_>>(),
        expected_keys
    );
    set_intake_walk_hook(None);
    set_intake_clock(None);
    store.cleanup();
}

#[tokio::test]
async fn tc_2_8_an_empty_batch_is_a_caller_error_and_records_nothing() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let result = intake_stream::message_events(ThreadRef::file_path(&file_path), &[]).await;
    assert!(!result.is_ok());
    if let OpResult::Err { error } = &result {
        assert_eq!(error.error_class, ErrorClass::CallerError);
        assert_eq!(error.code, ErrorCode::EmptyBatch);
        assert!(error.reason.contains("empty"));
    }

    assert!(read_back(&file_path).await.is_empty());
    set_intake_walk_hook(None);
    set_intake_clock(None);
    store.cleanup();
}

#[tokio::test]
async fn tc_1_4_the_same_batch_by_thread_id_and_by_file_path_produces_identical_results_and_read_back()
 {
    // recordedAt is sourced from the injected clock (test-plan: fixed per
    // test), so the two independent recordings stamp the same instant and the
    // read-back can be compared field-for-field — recordedAt included, nothing
    // stripped.
    let recorded_at = UNIX_EPOCH + Duration::from_secs(1_767_225_600); // 2026-01-01T00:00:00.000Z
    set_intake_clock(Some(Arc::new(move || recorded_at)));

    let store = temp_store();
    let path_a = path_str(&store.thread_path(None));
    let created_a = threads::new_thread(NewThreadInput {
        file_path: path_a.clone(),
        title: None,
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(created_a.is_ok());
    let OpResult::Ok { value: created_a } = created_a else {
        return;
    };
    let path_b = create_thread(&store).await;

    let batch = event_batch(&[
        EventKind::UserPrompt,
        EventKind::AssistantText,
        EventKind::ToolCall,
        EventKind::TurnEnd,
    ]);
    let by_id = intake_stream::message_events(
        ThreadRef::Id(ThreadRefId {
            thread_id: created_a.thread_id.clone(),
            registry_path: Some(path_str(&store.registry_path)),
        }),
        &batch,
    )
    .await;
    let by_path = intake_stream::message_events(ThreadRef::file_path(&path_b), &batch).await;
    assert!(by_id.is_ok());
    assert!(by_path.is_ok());
    if let (OpResult::Ok { value: id_val }, OpResult::Ok { value: path_val }) = (&by_id, &by_path) {
        assert_eq!(id_val, path_val);
    }

    let read_by_id = intake_stream::list_events(ThreadRef::Id(ThreadRefId {
        thread_id: created_a.thread_id,
        registry_path: Some(path_str(&store.registry_path)),
    }))
    .await;
    assert!(read_by_id.is_ok());
    let OpResult::Ok { value: read_by_id } = read_by_id else {
        return;
    };
    let read_by_path = read_back(&path_b).await;
    assert_eq!(read_by_id, read_by_path);

    // recordedAt is the injected instant, proving it came from the clock seam
    // rather than wall time.
    assert_eq!(
        read_by_id
            .iter()
            .map(|e| e.recorded_at())
            .collect::<Vec<_>>(),
        vec!["2026-01-01T00:00:00.000Z"; read_by_path.len()]
    );
    set_intake_walk_hook(None);
    set_intake_clock(None);
    store.cleanup();
}

#[tokio::test]
async fn architecture_risk_mid_walk_failure_rolls_the_whole_batch_back_to_baseline() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let baseline_batch = event_batch(&[EventKind::UserPrompt, EventKind::AssistantText]);
    let recorded =
        intake_stream::message_events(ThreadRef::file_path(&file_path), &baseline_batch).await;
    assert!(recorded.is_ok());
    let baseline = read_back(&file_path).await;
    assert_eq!(baseline.len(), 2);

    // Real mechanism: force an in-transaction storage failure after the first
    // event of the new batch has been recorded.
    set_intake_walk_hook(Some(Box::new(|db, event_index| {
        if event_index == 0 {
            // TS: db.close() on the walk handle. Rust IntakeWalkHook is Fn(&Db, …)
            // so close(self) cannot run through a borrow — transactional
            // `DROP TABLE event` induces the same storage_failure class inside
            // the transaction (Wave 3 representation ruling; Db::close unchanged).
            db.exec("DROP TABLE event");
        }
    })));
    let result = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &event_batch(&[
            EventKind::ToolCall,
            EventKind::ToolResult,
            EventKind::TurnEnd,
        ]),
    )
    .await;
    set_intake_walk_hook(None);
    assert!(!result.is_ok());
    if let OpResult::Err { error } = &result {
        assert_eq!(error.error_class, ErrorClass::SystemError);
        assert_eq!(error.code, ErrorCode::StorageFailure);
    }

    // Post-reopen read-back: not the operation's own claim about itself.
    assert_eq!(read_back(&file_path).await, baseline);
    set_intake_clock(None);
    store.cleanup();
}

#[tokio::test]
async fn architecture_risk_system_error_rollback_parity_storage_failure_mid_batch_leaves_no_partial_events()
 {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    set_intake_walk_hook(Some(Box::new(|db, event_index| {
        if event_index == 1 {
            // TS: db.close() — see mid-walk test note (&Db / DROP TABLE ruling).
            db.exec("DROP TABLE event");
        }
    })));
    let result =
        intake_stream::message_events(ThreadRef::file_path(&file_path), &conversation_turn()).await;
    set_intake_walk_hook(None);
    assert!(!result.is_ok());
    if let OpResult::Err { error } = &result {
        assert_eq!(error.error_class, ErrorClass::SystemError);
        assert_eq!(error.code, ErrorCode::StorageFailure);
    }

    // AC-4.6 is class-independent: the first two walked events are gone too.
    assert!(read_back(&file_path).await.is_empty());
    let db = open_raw(&file_path);
    let row = db
        .prepare("SELECT COUNT(*) AS n FROM event")
        .get()
        .expect("count row");
    let n = row
        .get("n")
        .and_then(|v| v.as_i64())
        .expect("COUNT(*) AS n must be present as an integer");
    assert_eq!(n, 0);
    db.close();
    set_intake_clock(None);
    store.cleanup();
}

#[tokio::test]
async fn architecture_risk_restart_survival_reopen_sees_the_identical_record() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let batch = conversation_turn();
    let recorded = intake_stream::message_events(ThreadRef::file_path(&file_path), &batch).await;
    assert!(recorded.is_ok());

    // Every SDK operation opens and closes its own handle, so each read-back
    // below is a fresh open of the file the write durably left behind.
    let first_read = read_back(&file_path).await;
    assert_eq!(first_read.len(), 5);
    let second_read = read_back(&file_path).await;
    assert_eq!(second_read, first_read);

    let db = open_raw(&file_path);
    let row = db
        .prepare("SELECT COUNT(*) AS n FROM event")
        .get()
        .expect("count row");
    let n = row
        .get("n")
        .and_then(|v| v.as_i64())
        .expect("COUNT(*) AS n must be present as an integer");
    assert_eq!(n, 5);
    db.close();
    set_intake_walk_hook(None);
    set_intake_clock(None);
    store.cleanup();
}

#[tokio::test]
async fn architecture_risk_a_rejected_batch_takes_no_lock_rejection_succeeds_while_another_connection_holds_the_write_lock()
 {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let locker = open_raw(&file_path);
    locker.exec("BEGIN IMMEDIATE;");
    // If rejection touched the transaction path it would block on the held
    // lock and surface SQLITE_BUSY as storage_failure; pure validation
    // returns the caller error immediately instead.
    let mut bogus = valid_event_for_kind(EventKind::UserPrompt);
    bogus.event_kind = "bogus".into();
    let result = intake_stream::message_events(ThreadRef::file_path(&file_path), &[bogus]).await;
    assert!(!result.is_ok());
    if let OpResult::Err { error } = &result {
        assert_eq!(error.error_class, ErrorClass::CallerError);
        assert_eq!(error.code, ErrorCode::InvalidEvent);
    }
    locker.exec("ROLLBACK;");
    locker.close();
    assert!(read_back(&file_path).await.is_empty());
    set_intake_walk_hook(None);
    set_intake_clock(None);
    store.cleanup();
}
