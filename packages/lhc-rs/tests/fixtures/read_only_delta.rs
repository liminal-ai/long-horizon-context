//! Ported from packages/lhc/test/fixtures/read-only-delta.ts.
//!
//! Shared read-only delta helper (Epic 04, DD-6): inspect describes, never
//! changes — asserted as ABSENCE OF DELTA in observable state.

#![allow(dead_code)]

use std::future::Future;

use lhc::intake_stream;
use lhc::messages::{self, MessageListOptions};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::js_json::js_json_stringify_of;
use lhc::shared_tech::storage::open_database;
use lhc::shared_tech::work_queue::{WorkItemRecord, WorkOwner, list_items};
use lhc::thread_view;
use lhc::threads::ThreadRef;
use serde::Serialize;
use serde_json::{Value, json};

use super::threads::read_derived_forms;

/// Snapshot of everything a forgotten side effect could move.
#[derive(Debug, Clone, PartialEq)]
pub struct ObservableState {
    pub events: Value,
    pub messages: Value,
    pub message_work: Value,
    pub turn_work: Value,
    pub view_status: Value,
    pub model_context: Value,
    pub stored_view: Value,
    pub derivations: Value,
}

/// TS `queuedFor` — file-private; opens db and `list_items` for one owner.
/// Always closes (TS `finally`), including when `list_items` panics.
fn queued_for(file_path: &str, owner: WorkOwner) -> Vec<WorkItemRecord> {
    let db = match open_database(file_path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("queued_for open failed: {}", error.reason),
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| list_items(&db, owner)));
    db.close();
    match result {
        Ok(items) => items,
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

fn op_result_value<T: Serialize>(result: &OpResult<T>) -> Value {
    match result {
        OpResult::Ok { value } => json!({
            "ok": true,
            "value": value,
        }),
        OpResult::Err { error } => json!({
            "ok": false,
            "error": error,
        }),
    }
}

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::from_str(&js_json_stringify_of(value).expect("observable_state stringify"))
        .expect("observable_state parse")
}

/// TS `observableState`.
pub async fn observable_state(file_path: &str) -> ObservableState {
    let ref_ = ThreadRef::file_path(file_path);
    let context_read = thread_view::get_llm_request_context(ref_.clone()).await;
    ObservableState {
        events: op_result_value(&intake_stream::list_events(ref_.clone()).await),
        messages: op_result_value(
            &messages::list(
                ref_.clone(),
                Some(MessageListOptions {
                    from: None,
                    to: None,
                    limit: None,
                    include_deleted: Some(true),
                }),
            )
            .await,
        ),
        message_work: to_value(&queued_for(file_path, WorkOwner::Messages)),
        turn_work: to_value(&queued_for(file_path, WorkOwner::Turns)),
        view_status: op_result_value(&thread_view::status(ref_.clone()).await),
        model_context: op_result_value(&context_read),
        stored_view: op_result_value(&thread_view::describe(ref_).await),
        derivations: to_value(&read_derived_forms(file_path)),
    }
}

/// Run one operation under before/after snapshot; panic when observable state
/// moves. Returns the operation's result.
pub async fn expect_read_only<T, F, Fut>(file_path: &str, operation: F) -> T
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
{
    let before = observable_state(file_path).await;
    let result = operation().await;
    let after = observable_state(file_path).await;
    assert_eq!(
        after, before,
        "read-only delta: operation changed observable state"
    );
    result
}
