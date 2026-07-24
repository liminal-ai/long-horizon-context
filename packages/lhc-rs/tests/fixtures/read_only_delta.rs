//! Ported from packages/lhc/test/fixtures/read-only-delta.ts.
//!
//! Shared read-only delta helper (Epic 04, DD-6): inspect describes, never
//! changes — asserted as ABSENCE OF DELTA in observable state.
//!
//! [`ObservableState`] is the pure data shape — REAL. Snapshot / expect helpers
//! and private `queued_for` reach the SDK / work-queue list seam, so they are
//! `todo!("phase 2")`.

use std::future::Future;

use lhc::shared_tech::work_queue::{WorkItemRecord, WorkOwner};
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
fn queued_for(_file_path: &str, _owner: WorkOwner) -> Vec<WorkItemRecord> {
    todo!("phase 2")
}

/// TS `observableState` — PARTIAL.
///
/// Needs from src: `intake_stream::list_events`, `messages::list`,
/// `thread_view::{get_llm_request_context, status, describe}`,
/// `work_queue::list_items`, plus [`super::threads::read_derived_forms`].
pub async fn observable_state(_file_path: &str) -> ObservableState {
    todo!("phase 2")
}

/// Run one operation under before/after snapshot; panic when observable state
/// moves. Returns the operation's result. PARTIAL.
pub async fn expect_read_only<T, F, Fut>(_file_path: &str, _operation: F) -> T
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
{
    todo!("phase 2")
}
