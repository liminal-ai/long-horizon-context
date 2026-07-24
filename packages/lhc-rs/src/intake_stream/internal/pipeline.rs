//! Ported from packages/lhc/src/intake-stream/internal/pipeline.ts.
//!
//! Batch transaction pipeline. Walk-hook / clock test seams keep module state.
//! Walk / record / list bodies land in Phase 2 (`todo!("phase 2")`).

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

#[allow(unused_imports)] // Phase 2 walk body
use super::validate::{validate_events, validate_thread_ref};
use crate::shared_tech::derivation::Clock;
use crate::shared_tech::errors::OpResult;
use crate::shared_tech::storage::Db;
use crate::threads::ThreadRef;

use super::super::{BatchResult, EventRecord, MessageEventInput};

/// Called after each event is processed inside the walk (TS `IntakeWalkHook`).
pub type IntakeWalkHook = Box<dyn Fn(&Db, i64) + Send + Sync>;

fn walk_hook_slot() -> &'static Mutex<Option<IntakeWalkHook>> {
    static SLOT: OnceLock<Mutex<Option<IntakeWalkHook>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn clock_slot() -> &'static Mutex<Option<Clock>> {
    static SLOT: OnceLock<Mutex<Option<Clock>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// TS `setIntakeWalkHook` — REAL test seam (stores module state only).
pub fn set_intake_walk_hook(hook: Option<IntakeWalkHook>) {
    *walk_hook_slot().lock().expect("intake walk hook") = hook;
}

/// TS `setIntakeClock` — REAL test seam (stores module state only).
pub fn set_intake_clock(clock: Option<Clock>) {
    *clock_slot().lock().expect("intake clock") = clock;
}

fn detail(_cause: &dyn std::fmt::Display) -> String {
    todo!("phase 2")
}

/// The skip set is read at transaction start and reads only the key column:
/// key-wins-over-content is the absence of a content comparison.
/// Chunked to stay under SQLite's bound-parameter limit.
fn recorded_keys(_db: &Db, _keys: &[String]) -> HashSet<String> {
    todo!("phase 2")
}

fn max_event_order(_db: &Db) -> i64 {
    todo!("phase 2")
}

/// TS `runMessageEvents` — optional `clock` matches the TS default-param /
/// Python `Callable | None` (explicit arg wins over [`set_intake_clock`]).
pub async fn run_message_events(
    _thread_ref: ThreadRef,
    _events: &[MessageEventInput],
    _clock: Option<Clock>,
) -> OpResult<BatchResult> {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RawEventRow {
    event_order: i64,
    event_kind: String,
    idempotency_key: String,
    actor: String,
    harness: String,
    payload: String,
    recorded_at: String,
}

pub async fn run_list_events(_thread_ref: ThreadRef) -> OpResult<Vec<EventRecord>> {
    todo!("phase 2")
}
