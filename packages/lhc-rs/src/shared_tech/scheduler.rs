//! Ported from packages/lhc/src/shared-tech/scheduler.ts.
//! Phase 1 skeleton — Drain* types REAL; behavior bodies `todo!("phase 2")`.
//!
//! SDK-internal scheduler and drain: the one component holding cross-operation
//! in-memory state. TS `createScheduler` closes over `states`/`seen`/`deps`/
//! `mode`; Rust encodes that capture as `Scheduler { mode, shared }`.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::derivation::ResolvedSdkConfig;
use super::durable_work::{DurableWorkDispatcher, DurableWorkOperation};
use super::errors::OpResult;
use super::storage::Db;
use super::work_queue::WorkSourceRef;

/// Injected by SDK wiring to avoid importing from the threads domain.
pub type ThreadDbOpener = Box<dyn Fn(&str) -> OpResult<Db> + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DrainDisposition {
    Done,
    FailedTerminal,
    StaleDiscarded,
    LostLease,
}

impl DrainDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            DrainDisposition::Done => "done",
            DrainDisposition::FailedTerminal => "failed_terminal",
            DrainDisposition::StaleDiscarded => "stale_discarded",
            DrainDisposition::LostLease => "lost_lease",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DrainStoppedBecause {
    Empty,
    InFlight,
    MaxItems,
}

impl DrainStoppedBecause {
    pub fn as_str(self) -> &'static str {
        match self {
            DrainStoppedBecause::Empty => "empty",
            DrainStoppedBecause::InFlight => "in_flight",
            DrainStoppedBecause::MaxItems => "max_items",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainRanEntry {
    pub work_item_id: String,
    /// Raw-row boundary: `ClaimedWorkItem.kind` is a plain string so unknown/
    /// corrupted kinds remain claimable and reportable (TS casts to WorkKind).
    pub kind: String,
    pub source_ref: WorkSourceRef,
    pub disposition: DrainDisposition,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// TS `DrainReport` (scheduler.ts:46).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainReport {
    pub ran: Vec<DrainRanEntry>,
    pub stopped_because: DrainStoppedBecause,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_expires_at: Option<String>,
    pub remaining: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SchedulerMode {
    Background,
    Manual,
}

impl SchedulerMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SchedulerMode::Background => "background",
            SchedulerMode::Manual => "manual",
        }
    }
}

/// Drain lookup / handler / config / opener deps (TS `DrainDeps`).
pub struct DrainDeps {
    pub lookup_dispatcher: Box<
        dyn Fn(Option<&DurableWorkOperation>, &str) -> OpResult<DurableWorkDispatcher>
            + Send
            + Sync,
    >,
    /// Whether any handler is registered at all. Background scheduling is
    /// gated on this, fail-closed.
    pub has_any_handler: Box<dyn Fn() -> bool + Send + Sync>,
    pub config: ResolvedSdkConfig,
    pub open_thread_database: ThreadDbOpener,
}

fn ran_entry(
    _item: &super::work_queue::ClaimedWorkItem,
    _disposition: DrainDisposition,
    _reason: Option<String>,
) -> DrainRanEntry {
    todo!("phase 2")
}

fn log_derivation_execution(
    _identity: Option<&DrainIdentity>,
    _db: &Db,
    _derivations: &[super::work_queue::EnqueueDerivationTarget],
    _event_kind: super::logging::derivation_log::DerivationLogEventKind,
    _payload: super::logging::derivation_log::DerivationLogPayload,
) {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq)]
pub struct DrainIdentity {
    pub thread_id: String,
    pub file_path: String,
}

#[derive(Debug, Clone, Default)]
pub struct DrainOpenOpts {
    pub max_items: Option<i64>,
}

pub async fn drain_open_db(
    _db: &Db,
    _deps: &DrainDeps,
    _opts: Option<DrainOpenOpts>,
    _identity: Option<DrainIdentity>,
) -> DrainReport {
    todo!("phase 2")
}

fn thread_not_found<T>(_file_path: &str) -> OpResult<T> {
    todo!("phase 2")
}

pub async fn run_drain(
    _file_path: &str,
    _deps: &DrainDeps,
    _opts: Option<DrainOpenOpts>,
) -> OpResult<DrainReport> {
    todo!("phase 2")
}

/// Opaque cancellable wake timer (TS `ReturnType<typeof scheduleTimer>`).
/// Phase 2 fills in the real abort/join handle; not unit `()`.
struct WakeTimerHandle {
    _private: (),
}

/// TS `scheduleTimer` — arm a delayed wake callback.
fn schedule_timer(_delay_ms: i64, _on_fire: Box<dyn FnOnce() + Send>) -> WakeTimerHandle {
    todo!("phase 2")
}

/// TS `cancelTimer` — cancel a previously armed wake.
fn cancel_timer(_handle: WakeTimerHandle) {
    todo!("phase 2")
}

/// TS private `ThreadDrainState` — per-thread single-flight + wake coalescing.
struct ThreadDrainState {
    thread_id: String,
    file_path: String,
    running: bool,
    pending: bool,
    /// test-only observability (TC-1.2); must not become API
    passes: i64,
    waiters: Vec<Box<dyn FnOnce() + Send>>,
    /// At most one pending wake per thread for claim expiry (TS timer handle).
    wake_timer: Option<WakeTimerHandle>,
}

/// Closure-captured state of TS `createScheduler` (`states` / `seen` / `deps`).
struct SchedulerInner {
    deps: DrainDeps,
    /// Insertion-ordered per-thread drain state (TS `Map` is insertion-ordered).
    states: IndexMap<String, ThreadDrainState>,
    /// First-touch catch-up guard, process lifetime (TS `Set`).
    seen: HashSet<String>,
}

type SharedScheduler = Arc<Mutex<SchedulerInner>>;

/// A wake floored to a sane minimum (TS `WAKE_MIN_DELAY_MS`).
const WAKE_MIN_DELAY_MS: i64 = 5;

fn state_for<'a>(_shared: &'a mut SchedulerInner, _thread_id: &str) -> &'a mut ThreadDrainState {
    todo!("phase 2")
}

fn clear_wake(_st: &mut ThreadDrainState) {
    todo!("phase 2")
}

fn arm_wake(_shared: &mut SchedulerInner, _thread_id: &str, _wake_at: &str) {
    todo!("phase 2")
}

fn next_wake_at(_report: Option<&DrainReport>) -> Option<String> {
    todo!("phase 2")
}

async fn run_loop(_shared: SharedScheduler, _thread_id: String) {
    todo!("phase 2")
}

fn schedule(_shared: &SharedScheduler, _thread_id: &str) {
    todo!("phase 2")
}

fn read_thread_id(_db: &Db) -> Option<String> {
    todo!("phase 2")
}

/// Read a thread file's id without side effects (no migration, no touch).
pub fn peek_thread_id(_file_path: &str) -> Option<String> {
    todo!("phase 2")
}

/// TS `Scheduler` — mode + poke/touch/drainSettled/testPassCount.
/// `shared` encodes the TS closure capture over states/seen/deps.
pub struct Scheduler {
    pub mode: SchedulerMode,
    shared: SharedScheduler,
}

impl Scheduler {
    pub fn poke(&self, _thread_id: &str) {
        todo!("phase 2")
    }

    pub fn touch(&self, _file_path: &str, _db: &Db) {
        todo!("phase 2")
    }

    pub async fn drain_settled(&self, _thread_id: &str) {
        todo!("phase 2")
    }

    /// Test-only observability for coalescing exactness (TC-1.2).
    pub fn test_pass_count(&self, _thread_id: &str) -> i64 {
        todo!("phase 2")
    }
}

pub fn create_scheduler(_mode: SchedulerMode, _deps: DrainDeps) -> Scheduler {
    todo!("phase 2")
}
