//! Ported from packages/lhc/test/fixtures/read-only-delta.ts.
//!
//! Shared read-only delta helper (Epic 04, DD-6): inspect describes, never
//! changes — asserted as ABSENCE OF DELTA in observable state.
//!
//! [`ObservableState`] is the pure data shape — REAL. [`queued_for`] is REAL
//! (`open_database` + `list_items` + `close`). Snapshot / expect helpers stay
//! `todo!("phase 2")` while `intake_stream::list_events`, `messages::list`, and
//! `thread_view::{get_llm_request_context, status, describe}` remain todos.

#![allow(dead_code)] // queued_for lands ahead of observable_state callers

use std::future::Future;

use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::open_database;
use lhc::shared_tech::work_queue::{WorkItemRecord, WorkOwner, list_items};
use serde_json::Value;

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

/// TS `observableState` — PARTIAL.
///
/// Needs from src: `intake_stream::list_events`, `messages::list`,
/// `thread_view::{get_llm_request_context, status, describe}`,
/// plus [`super::threads::read_derived_forms`]. Those domain reads are still
/// `todo!("phase 2")` (Wave 3/6); keep this gate until they are callable.
pub async fn observable_state(_file_path: &str) -> ObservableState {
    todo!("phase 2")
}

/// Run one operation under before/after snapshot; panic when observable state
/// moves. Returns the operation's result. PARTIAL — depends on
/// [`observable_state`].
pub async fn expect_read_only<T, F, Fut>(_file_path: &str, _operation: F) -> T
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
{
    todo!("phase 2")
}
