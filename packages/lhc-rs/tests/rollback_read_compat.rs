//! A thread TS wrote with a logged rollback stays readable from Rust.
//! The fixture comes from scripts/gen-rollback-thread-fixture.mjs: turns at
//! events 1-3 and 4-6, then a rollback at event 7 keeping through event 3.

mod fixtures;

use fixtures::{TempStore, temp_store};
use lhc::intake_stream::{EventRecord, MessageEventInput, RollbackPayload};
use lhc::shared_tech::errors::{ErrorCode, OpResult};
use lhc::{ThreadRef, inspect, intake_stream, messages};
use serde_json::json;

struct Thread {
    store: TempStore,
    reference: ThreadRef,
}

impl Drop for Thread {
    fn drop(&mut self) {
        self.store.cleanup();
    }
}

fn ts_rollback_thread() -> Thread {
    let store = temp_store();
    let path = store.dir.join("rollback-thread.sqlite");
    std::fs::copy(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/rollback-thread.sqlite"
        ),
        &path,
    )
    .expect("copy fixture");
    let reference = ThreadRef::file_path(path.to_string_lossy().into_owned());
    Thread { store, reference }
}

fn ok<T: std::fmt::Debug>(result: OpResult<T>) -> T {
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("expected ok, got {error:?}"),
    }
}

#[tokio::test]
async fn list_events_decodes_the_ts_rollback_record() {
    let thread = ts_rollback_thread();
    let events = ok(intake_stream::list_events(thread.reference.clone()).await);
    assert_eq!(events.len(), 7);
    let EventRecord::Rollback {
        payload,
        event_order,
        ..
    } = &events[6]
    else {
        panic!("event 7 is not a rollback: {:?}", events[6]);
    };
    assert_eq!(*event_order, 7);
    assert_eq!(
        payload,
        &RollbackPayload {
            keep_through_event_order: 3,
            reason: Some("host rewind".into()),
        }
    );
}

#[tokio::test]
async fn reads_hide_what_ts_rolled_back() {
    let thread = ts_rollback_thread();
    let listed = ok(messages::list(thread.reference.clone(), None).await);
    let ids: Vec<_> = listed.iter().map(|m| m.message_id.as_str()).collect();
    assert_eq!(ids, ["m1", "m2"]);

    let overview = ok(inspect::overview(thread.reference.clone()).await);
    assert_eq!(overview.events.count, 7);
    assert_eq!(overview.messages.visible, 2);
    assert_eq!(overview.messages.deleted, 2);

    ok(inspect::health(thread.reference.clone()).await);
}

#[tokio::test]
async fn rust_intake_refuses_a_rollback_input() {
    let thread = ts_rollback_thread();
    let input: MessageEventInput = serde_json::from_value(json!({
        "eventKind": "rollback",
        "idempotencyKey": "rust-rollback",
        "actor": "test",
        "harness": "test",
        "payload": { "keepThroughEventOrder": 0 },
    }))
    .unwrap();
    match intake_stream::message_events(thread.reference.clone(), &[input]).await {
        OpResult::Err { error } => assert_eq!(error.code, ErrorCode::InvalidEvent),
        OpResult::Ok { value: batch } => panic!("rollback intake accepted: {batch:?}"),
    }
    let events = ok(intake_stream::list_events(thread.reference.clone()).await);
    assert_eq!(events.len(), 7);
}
