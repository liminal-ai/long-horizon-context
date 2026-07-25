//! Ported from packages/lhc/src/shared-tech/scheduler.ts.
//! Phase 2 — drain loop, background single-flight, claim-expiry wake.
//!
//! SDK-internal scheduler and drain: the one component holding cross-operation
//! in-memory state. TS `createScheduler` closes over `states`/`seen`/`deps`/
//! `mode`; Rust encodes that capture as `Scheduler { mode, shared }`.

use std::collections::HashSet;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::FutureExt;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::derivation::{HandlerRunContext, ResolvedSdkConfig};
use super::durable_work::{
    ApplyDerivationTerminalDisposition, DerivationAttempt, DerivationCompletionError,
    DerivationTerminalFailure, DerivationTerminalState, DurableWorkDispatchResult,
    DurableWorkDispatcher, DurableWorkDispatcherItem, DurableWorkOperation,
    DurableWorkSettledDisposition, apply_derivation_terminal_failure,
};
use super::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult, storage_failure};
use super::logging::derivation_log::{
    DerivationLogEntry, DerivationLogEventKind, DerivationLogPayload, DerivationLogTarget,
    append_derivation_log,
};
use super::persist::{DbReadTransaction, DbTransaction};
use super::storage::{Db, open_database, open_database_read_only};
use super::work_queue::{
    ClaimOutcome, ClaimedWorkItem, WorkSourceRef, claim_next, count_live_items,
};

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
    item: &ClaimedWorkItem,
    disposition: DrainDisposition,
    reason: Option<String>,
) -> DrainRanEntry {
    DrainRanEntry {
        work_item_id: item.work_item_id.clone(),
        kind: item.kind.clone(),
        source_ref: item.source_ref.clone(),
        disposition,
        reason,
    }
}

fn log_derivation_execution(
    identity: Option<&DrainIdentity>,
    db: &Db,
    derivations: &[super::work_queue::EnqueueDerivationTarget],
    event_kind: DerivationLogEventKind,
    payload: DerivationLogPayload,
) {
    let Some(identity) = identity else {
        return;
    };
    if derivations.is_empty() {
        return;
    }
    // TS passes a read-txn-shaped `{ db, threadId, filePath }`. Amendment A:
    // bags borrow `&Db`; logging only needs `db.path()` then re-opens.
    let txn = DbReadTransaction {
        db,
        thread_id: identity.thread_id.clone(),
        file_path: identity.file_path.clone(),
    };
    for target in derivations {
        let entry = DerivationLogEntry {
            target: DerivationLogTarget {
                subject_kind: target.subject_kind,
                subject_id: target.subject_id.clone(),
                derivation_type: target.derivation_type.clone(),
            },
            event_kind,
            payload: payload.clone(),
        };
        // Bare call, as TS logDerivationExecution (scheduler.ts:96-101):
        // fail-softness lives inside append_derivation_log; a close-failure
        // there propagates to the drain's catch, same as TS (phase-2 review).
        append_derivation_log(DbTransaction::Read(&txn), &entry);
    }
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

fn attempt_from_item(item: &ClaimedWorkItem) -> DerivationAttempt {
    DerivationAttempt {
        source_version: item.source_version,
        derivations: item.derivations.clone(),
        work_item_id: Some(item.work_item_id.clone()),
    }
}

fn terminal_ran_entry(
    item: &ClaimedWorkItem,
    terminal: ApplyDerivationTerminalDisposition,
    reason: String,
) -> DrainRanEntry {
    match terminal {
        ApplyDerivationTerminalDisposition::LostLease => {
            ran_entry(item, DrainDisposition::LostLease, Some(reason))
        }
        ApplyDerivationTerminalDisposition::Done => {
            ran_entry(item, DrainDisposition::FailedTerminal, Some(reason))
        }
    }
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "Box<Any>".to_string()
}

fn system_time_to_iso(t: SystemTime) -> String {
    let ms = t
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64;
    iso_from_unix_millis(ms)
}

fn system_time_to_millis(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64
}

fn iso_from_unix_millis(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let millis = ms % 1000;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let hh = tod / 3600;
    let mm = (tod % 3600) / 60;
    let ss = tod % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

/// Howard Hinnant civil_from_days (days since Unix epoch → Y-M-D).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse_ascii_digits(bytes: &[u8]) -> Option<i64> {
    if bytes.is_empty() || !bytes.iter().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    std::str::from_utf8(bytes).ok()?.parse().ok()
}

/// TS `Date.parse` for wake timestamps — finite millis or none (→ min delay).
///
/// Amendment D (Lee/Fable, Node >=24.17): two fixed UTC shapes only
/// (`YYYY-MM-DDTHH:mm:ssZ` / `…ss.sssZ`); ASCII digits; month `01..12`; day
/// `01..31` with Node calendar overflow via [`days_from_civil`]; exact
/// `24:00:00(.000)` → next midnight; hour 24 with nonzero remainder invalid.
fn parse_iso_to_millis(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    let millis = if b.len() == 24 {
        if b[4] != b'-'
            || b[7] != b'-'
            || b[10] != b'T'
            || b[13] != b':'
            || b[16] != b':'
            || b[19] != b'.'
            || b[23] != b'Z'
        {
            return None;
        }
        parse_ascii_digits(&b[20..23])?
    } else if b.len() == 20 {
        if b[4] != b'-'
            || b[7] != b'-'
            || b[10] != b'T'
            || b[13] != b':'
            || b[16] != b':'
            || b[19] != b'Z'
        {
            return None;
        }
        0
    } else {
        return None;
    };
    let y = parse_ascii_digits(&b[0..4])?;
    let mo = parse_ascii_digits(&b[5..7])?;
    let d = parse_ascii_digits(&b[8..10])?;
    let hh = parse_ascii_digits(&b[11..13])?;
    let mm = parse_ascii_digits(&b[14..16])?;
    let ss = parse_ascii_digits(&b[17..19])?;
    if !(1..=12).contains(&mo)
        || !(1..=31).contains(&d)
        || !(0..=59).contains(&mm)
        || !(0..=59).contains(&ss)
        || !(0..=999).contains(&millis)
    {
        return None;
    }
    let (hh, day_adjust) = if hh == 24 {
        if mm != 0 || ss != 0 || millis != 0 {
            return None;
        }
        (0, 1)
    } else if (0..=23).contains(&hh) {
        (hh, 0)
    } else {
        return None;
    };
    let days = days_from_civil(y, mo, d) + day_adjust;
    let secs = days * 86_400 + hh * 3600 + mm * 60 + ss;
    Some(secs * 1000 + millis)
}

pub async fn drain_open_db(
    db: &Db,
    deps: &DrainDeps,
    opts: Option<DrainOpenOpts>,
    identity: Option<DrainIdentity>,
) -> DrainReport {
    let clock = deps.config.clock.clone();
    let lease_duration_ms = deps.config.lease.duration_ms;
    let inference_callbacks = deps.config.inference_callbacks.clone();
    let config = deps.config.clone();
    let opts = opts.unwrap_or_default();

    let mut ran: Vec<DrainRanEntry> = Vec::new();
    let stopped_because;
    let mut claim_expires_at: Option<String> = None;

    loop {
        if let Some(max_items) = opts.max_items {
            if ran.len() as i64 >= max_items {
                stopped_because = DrainStoppedBecause::MaxItems;
                break;
            }
        }

        let now = system_time_to_iso(clock());
        let claim = claim_next(db, &now, lease_duration_ms);
        match claim {
            ClaimOutcome::Empty => {
                stopped_because = DrainStoppedBecause::Empty;
                break;
            }
            ClaimOutcome::InFlight {
                claim_expires_at: expires,
            } => {
                stopped_because = DrainStoppedBecause::InFlight;
                claim_expires_at = Some(expires);
                break;
            }
            ClaimOutcome::Expired { item } => {
                let reason = "claim_expired".to_string();
                let terminal = apply_derivation_terminal_failure(
                    db,
                    &attempt_from_item(&item),
                    &DerivationTerminalFailure {
                        reason: reason.clone(),
                        state: DerivationTerminalState::Failed,
                        now: system_time_to_iso(clock()),
                    },
                );
                if terminal != ApplyDerivationTerminalDisposition::LostLease {
                    let mut payload = DerivationLogPayload::new();
                    payload.insert(
                        "reason".to_string(),
                        serde_json::Value::String(reason.clone()),
                    );
                    log_derivation_execution(
                        identity.as_ref(),
                        db,
                        &item.derivations,
                        DerivationLogEventKind::TerminalFailed,
                        payload,
                    );
                }
                ran.push(terminal_ran_entry(&item, terminal, reason));
                continue;
            }
            ClaimOutcome::Claimed { item } => {
                let looked_up = (deps.lookup_dispatcher)(item.operation.as_ref(), &item.kind);
                let dispatcher = match looked_up {
                    OpResult::Ok { value } => value,
                    OpResult::Err { error } => {
                        let reason = error.code.as_str().to_string();
                        let terminal = apply_derivation_terminal_failure(
                            db,
                            &attempt_from_item(&item),
                            &DerivationTerminalFailure {
                                reason: reason.clone(),
                                state: DerivationTerminalState::Failed,
                                now: system_time_to_iso(clock()),
                            },
                        );
                        ran.push(terminal_ran_entry(&item, terminal, reason));
                        continue;
                    }
                };

                let db_path = db.path().to_string();
                let open_db: Arc<dyn Fn() -> OpResult<Db> + Send + Sync> =
                    Arc::new(move || open_database(&db_path));
                let run = HandlerRunContext {
                    thread_id: identity
                        .as_ref()
                        .map(|i| i.thread_id.clone())
                        .unwrap_or_default(),
                    file_path: identity
                        .as_ref()
                        .map(|i| i.file_path.clone())
                        .unwrap_or_default(),
                    open_db,
                    inference_callbacks: inference_callbacks.clone(),
                    clock: clock.clone(),
                    config: config.clone(),
                };

                let Some(operation) = item.operation.clone() else {
                    let reason = "unknown_work_kind".to_string();
                    let terminal = apply_derivation_terminal_failure(
                        db,
                        &attempt_from_item(&item),
                        &DerivationTerminalFailure {
                            reason: reason.clone(),
                            state: DerivationTerminalState::Failed,
                            now: system_time_to_iso(clock()),
                        },
                    );
                    ran.push(terminal_ran_entry(&item, terminal, reason));
                    continue;
                };

                let dispatch_item = DurableWorkDispatcherItem {
                    work_item_id: item.work_item_id.clone(),
                    kind: item.kind.clone(),
                    source_ref: item.source_ref.clone(),
                    source_version: item.source_version,
                    derivations: item.derivations.clone(),
                    operation,
                };

                let outcome =
                    match catch_unwind(AssertUnwindSafe(|| dispatcher(run, dispatch_item))) {
                        Ok(fut) => match AssertUnwindSafe(fut).catch_unwind().await {
                            Ok(outcome) => outcome,
                            Err(payload) => {
                                if payload.is::<DerivationCompletionError>() {
                                    resume_unwind(payload);
                                }
                                let detail = panic_message(payload);
                                DurableWorkDispatchResult::Failed {
                                    reason: format!("handler threw: {detail}"),
                                }
                            }
                        },
                        Err(payload) => {
                            if payload.is::<DerivationCompletionError>() {
                                resume_unwind(payload);
                            }
                            let detail = panic_message(payload);
                            DurableWorkDispatchResult::Failed {
                                reason: format!("handler threw: {detail}"),
                            }
                        }
                    };

                match outcome {
                    DurableWorkDispatchResult::Settled { disposition } => {
                        let drain_disp = match disposition {
                            DurableWorkSettledDisposition::Done => DrainDisposition::Done,
                            DurableWorkSettledDisposition::StaleDiscarded => {
                                DrainDisposition::StaleDiscarded
                            }
                            DurableWorkSettledDisposition::LostLease => DrainDisposition::LostLease,
                        };
                        ran.push(ran_entry(&item, drain_disp, None));
                    }
                    DurableWorkDispatchResult::Blocked { reason } => {
                        let terminal = apply_derivation_terminal_failure(
                            db,
                            &attempt_from_item(&item),
                            &DerivationTerminalFailure {
                                reason: reason.clone(),
                                state: DerivationTerminalState::Blocked,
                                now: system_time_to_iso(clock()),
                            },
                        );
                        if terminal != ApplyDerivationTerminalDisposition::LostLease {
                            let mut payload = DerivationLogPayload::new();
                            payload.insert(
                                "reason".to_string(),
                                serde_json::Value::String(reason.clone()),
                            );
                            log_derivation_execution(
                                identity.as_ref(),
                                db,
                                &item.derivations,
                                DerivationLogEventKind::TerminalFailed,
                                payload,
                            );
                        }
                        ran.push(terminal_ran_entry(&item, terminal, reason));
                    }
                    DurableWorkDispatchResult::Failed { reason } => {
                        let terminal = apply_derivation_terminal_failure(
                            db,
                            &attempt_from_item(&item),
                            &DerivationTerminalFailure {
                                reason: reason.clone(),
                                state: DerivationTerminalState::Failed,
                                now: system_time_to_iso(clock()),
                            },
                        );
                        if terminal != ApplyDerivationTerminalDisposition::LostLease {
                            let mut payload = DerivationLogPayload::new();
                            payload.insert(
                                "reason".to_string(),
                                serde_json::Value::String(reason.clone()),
                            );
                            log_derivation_execution(
                                identity.as_ref(),
                                db,
                                &item.derivations,
                                DerivationLogEventKind::TerminalFailed,
                                payload,
                            );
                        }
                        ran.push(terminal_ran_entry(&item, terminal, reason));
                    }
                }
            }
        }
    }

    let mut report = DrainReport {
        ran,
        stopped_because,
        claim_expires_at: None,
        remaining: count_live_items(db),
    };
    if let Some(expires) = claim_expires_at {
        report.claim_expires_at = Some(expires);
    }
    report
}

fn thread_not_found<T>(file_path: &str) -> OpResult<T> {
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::CallerError,
            code: ErrorCode::ThreadNotFound,
            reason: format!("no thread file exists at {file_path}"),
            event_index: None,
        },
    }
}

pub async fn run_drain(
    file_path: &str,
    deps: &DrainDeps,
    opts: Option<DrainOpenOpts>,
) -> OpResult<DrainReport> {
    if !Path::new(file_path).exists() {
        return thread_not_found(file_path);
    }
    let opened = (deps.open_thread_database)(file_path);
    let db = match opened {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };

    let file_path_owned = file_path.to_string();
    let drain_fut = async {
        let thread_id = match read_thread_id(&db) {
            Some(id) => id,
            None => {
                return storage_failure(&format!(
                    "thread file at {file_path_owned} lost its metadata row"
                ));
            }
        };
        let report = drain_open_db(
            &db,
            deps,
            opts,
            Some(DrainIdentity {
                thread_id,
                file_path: file_path_owned,
            }),
        )
        .await;
        OpResult::Ok { value: report }
    };

    let result = match AssertUnwindSafe(drain_fut).catch_unwind().await {
        Ok(result) => result,
        Err(payload) => {
            if let Some(err) = payload.downcast_ref::<DerivationCompletionError>() {
                // TS `reason: cause.message` — Display includes the code prefix.
                OpResult::Err {
                    error: ErrorResult {
                        error_class: ErrorClass::StateCorruption,
                        code: ErrorCode::DerivationCompletionMismatch,
                        reason: err.to_string(),
                        event_index: None,
                    },
                }
            } else {
                let detail = panic_message(payload);
                storage_failure(&format!("drain failed: {detail}"))
            }
        }
    };

    // finally close — match TS `db.close()` (close errors panic)
    db.close();
    result
}

/// Opaque cancellable wake timer (TS `ReturnType<typeof scheduleTimer>`).
/// Abort matches Node `clearTimeout`: a cancelled wake must not run.
struct WakeTimerHandle {
    /// Held until the sleep is allowed to start — publish-before-fire gate.
    start: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for WakeTimerHandle {
    fn drop(&mut self) {
        // Dropping `start` without send cancels pre-start; abort cancels post-start.
        self.start.take();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Arm a delayed wake whose sleep does not begin until the caller publishes the
/// returned handle into scheduler state (closes fire-before-publication).
fn schedule_timer_gated(delay_ms: i64, on_fire: Box<dyn FnOnce() + Send>) -> WakeTimerHandle {
    let delay = Duration::from_millis(delay_ms.max(0) as u64);
    let (start_tx, start_rx) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        // Wait until the handle is stored in ThreadDrainState.
        if start_rx.await.is_err() {
            return;
        }
        tokio::time::sleep(delay).await;
        on_fire();
    });
    WakeTimerHandle {
        start: Some(start_tx),
        task: Some(task),
    }
}

/// Release the start gate after the handle is represented in scheduler state.
fn publish_timer(handle: &mut WakeTimerHandle) {
    if let Some(start) = handle.start.take() {
        let _ = start.send(());
    }
}

/// TS `cancelTimer` — cancel a previously armed wake.
fn cancel_timer(handle: WakeTimerHandle) {
    drop(handle);
}

/// TS private `ThreadDrainState` — per-thread single-flight + wake coalescing.
struct ThreadDrainState {
    /// Mirrored from TS state map key; map lookup uses the HashMap key.
    #[allow(dead_code)]
    thread_id: String,
    file_path: String,
    running: bool,
    pending: bool,
    /// test-only observability (TC-1.2); must not become API
    passes: i64,
    waiters: Vec<Box<dyn FnOnce() + Send>>,
    /// At most one pending wake per thread for claim expiry (TS timer handle).
    wake_timer: Option<WakeTimerHandle>,
    /// Bumped on clear/replace so a stale fired/cancelled task cannot clear or
    /// replace a newer timer.
    wake_generation: u64,
}

/// Closure-captured state of TS `createScheduler` (`states` / `seen` / `deps`).
struct SchedulerInner {
    /// Arc so background passes can borrow deps without holding the mutex
    /// across await / SQLite / callbacks.
    deps: Arc<DrainDeps>,
    /// Insertion-ordered per-thread drain state (TS `Map` is insertion-ordered).
    states: IndexMap<String, ThreadDrainState>,
    /// First-touch catch-up guard, process lifetime (TS `Set`).
    seen: HashSet<String>,
    /// Weak self-ref so claim-expiry wakes can re-enter `schedule`.
    self_weak: Weak<Mutex<SchedulerInner>>,
}

type SharedScheduler = Arc<Mutex<SchedulerInner>>;

/// A wake floored to a sane minimum (TS `WAKE_MIN_DELAY_MS`).
const WAKE_MIN_DELAY_MS: i64 = 5;

fn lock_inner(shared: &SharedScheduler) -> std::sync::MutexGuard<'_, SchedulerInner> {
    shared.lock().unwrap_or_else(|p| p.into_inner())
}

fn state_for<'a>(shared: &'a mut SchedulerInner, thread_id: &str) -> &'a mut ThreadDrainState {
    if !shared.states.contains_key(thread_id) {
        shared.states.insert(
            thread_id.to_string(),
            ThreadDrainState {
                thread_id: thread_id.to_string(),
                file_path: String::new(),
                running: false,
                pending: false,
                passes: 0,
                waiters: Vec::new(),
                wake_timer: None,
                wake_generation: 0,
            },
        );
    }
    shared
        .states
        .get_mut(thread_id)
        .expect("state_for just ensured insertion")
}

fn clear_wake(st: &mut ThreadDrainState) {
    // Invalidate first so a concurrent fire at the deadline cannot clear/replace
    // a newer timer after abort races with an already-running callback.
    st.wake_generation = st.wake_generation.wrapping_add(1);
    if let Some(handle) = st.wake_timer.take() {
        cancel_timer(handle);
    }
}

/// Arm a claim-expiry wake. `now_ms` must be computed **outside** the scheduler
/// mutex (clock callback must not run under `SchedulerInner`).
///
/// Publishes the outstanding wake handle into state before the sleep gate opens,
/// so a min-delay fire cannot observe `wake_timer=None` or race a newer arm.
fn arm_wake(shared: &mut SchedulerInner, thread_id: &str, wake_at: &str, now_ms: i64) {
    let delay = match parse_iso_to_millis(wake_at) {
        Some(parsed) => (parsed - now_ms).max(WAKE_MIN_DELAY_MS),
        None => WAKE_MIN_DELAY_MS,
    };

    let weak = shared.self_weak.clone();
    let tid = thread_id.to_string();

    let generation = {
        let st = state_for(shared, thread_id);
        clear_wake(st);
        st.wake_generation
    };

    let handle = schedule_timer_gated(
        delay,
        Box::new(move || {
            fired_timer_handoff(&weak, &tid, generation);
        }),
    );

    {
        let st = state_for(shared, thread_id);
        st.wake_timer = Some(handle);
        // Handle is represented before sleep may begin.
        if let Some(h) = st.wake_timer.as_mut() {
            publish_timer(h);
        }
    }
}

/// Fired-timer clear→schedule handoff under one lock (TS synchronous callback).
/// Validates generation, clears the outstanding wake, and applies the same
/// running/pending decision as [`schedule`]. Spawns outside the lock.
fn fired_timer_handoff(weak: &Weak<Mutex<SchedulerInner>>, thread_id: &str, generation: u64) {
    let Some(shared) = weak.upgrade() else {
        return;
    };
    let should_spawn = {
        let mut guard = lock_inner(&shared);
        let Some(st) = guard.states.get_mut(thread_id) else {
            return;
        };
        // Stale fired/cancelled task: a newer wake superseded us.
        if st.wake_generation != generation {
            return;
        }
        // Disarm Drop-abort so taking the handle does not abort this task.
        if let Some(mut handle) = st.wake_timer.take() {
            handle.start.take();
            handle.task.take();
        }
        if st.file_path.is_empty() {
            return;
        }
        if st.running {
            st.pending = true;
            false
        } else {
            st.running = true;
            true
        }
    };
    if should_spawn {
        let shared = Arc::clone(&shared);
        let thread_id = thread_id.to_string();
        tokio::spawn(async move {
            run_loop(shared, thread_id).await;
        });
    }
}

fn next_wake_at(report: Option<&DrainReport>) -> Option<String> {
    match report {
        Some(DrainReport {
            stopped_because: DrainStoppedBecause::InFlight,
            claim_expires_at: Some(expires),
            ..
        }) => Some(expires.clone()),
        _ => None,
    }
}

/// Finish a background loop under the mutex: either keep running for a pending
/// poke, or set `running=false` and arm wake / take waiters. Never leaves
/// `running=false, pending=true` without a scheduled replacement pass.
fn finish_or_continue(
    shared: &mut SchedulerInner,
    thread_id: &str,
    last_report: Option<&DrainReport>,
    now_ms: i64,
) -> FinishDecision {
    {
        let st = state_for(shared, thread_id);
        if st.pending {
            return FinishDecision::AnotherPass;
        }
        st.running = false;
    }
    let wake_at = next_wake_at(last_report);
    let should_arm = {
        let st = state_for(shared, thread_id);
        st.wake_timer.is_none() && wake_at.is_some()
    };
    if should_arm {
        let wake_at = wake_at.expect("should_arm implies Some");
        arm_wake(shared, thread_id, &wake_at, now_ms);
        FinishDecision::Done(Vec::new())
    } else {
        let st = state_for(shared, thread_id);
        FinishDecision::Done(std::mem::take(&mut st.waiters))
    }
}

enum FinishDecision {
    AnotherPass,
    Done(Vec<Box<dyn FnOnce() + Send>>),
}

async fn run_loop(shared: SharedScheduler, thread_id: String) {
    // Defer past the committing operation's synchronous tail so the drain
    // never contends with the transaction whose commit scheduled it.
    tokio::task::yield_now().await;

    let mut last_report: Option<DrainReport> = None;
    let mut finished_waiters: Option<Vec<Box<dyn FnOnce() + Send>>> = None;

    let result = AssertUnwindSafe(async {
        loop {
            let (file_path, deps) = {
                let mut guard = lock_inner(&shared);
                let st = state_for(&mut guard, &thread_id);
                st.pending = false;
                st.passes += 1;
                (st.file_path.clone(), Arc::clone(&guard.deps))
            };
            // Drain / SQLite / dispatcher await outside the mutex.
            let result = run_drain(&file_path, deps.as_ref(), None).await;
            last_report = match result {
                OpResult::Ok { value } => Some(value),
                OpResult::Err { .. } => None,
            };

            // Clock for wake arming — outside the mutex.
            let now_ms = system_time_to_millis((deps.config.clock)());

            // Atomic: observe pending → another pass vs running=false + wake/waiters.
            let decision = {
                let mut guard = lock_inner(&shared);
                finish_or_continue(&mut guard, &thread_id, last_report.as_ref(), now_ms)
            };
            match decision {
                FinishDecision::AnotherPass => continue,
                FinishDecision::Done(waiters) => {
                    finished_waiters = Some(waiters);
                    break;
                }
            }
        }
    })
    .catch_unwind()
    .await;

    // Panic / unwind path: body never finished — mirror TS `finally`.
    let waiters = if let Some(waiters) = finished_waiters.take() {
        waiters
    } else {
        let now_ms = {
            let deps = {
                let guard = lock_inner(&shared);
                Arc::clone(&guard.deps)
            };
            system_time_to_millis((deps.config.clock)())
        };
        let decision = {
            let mut guard = lock_inner(&shared);
            let st = state_for(&mut guard, &thread_id);
            if !st.running {
                // Already finished by a racing path; nothing to release here.
                FinishDecision::Done(Vec::new())
            } else if st.pending {
                // Poke arrived during unwind: drop running and schedule a
                // replacement so pending is never stranded.
                st.running = false;
                drop(guard);
                schedule(&shared, &thread_id);
                FinishDecision::Done(Vec::new())
            } else {
                finish_or_continue(&mut guard, &thread_id, last_report.as_ref(), now_ms)
            }
        };
        match decision {
            FinishDecision::AnotherPass => {
                // pending was consumed into a continue decision after running was
                // still true — schedule a replacement pass instead.
                {
                    let mut guard = lock_inner(&shared);
                    let st = state_for(&mut guard, &thread_id);
                    st.running = false;
                }
                schedule(&shared, &thread_id);
                Vec::new()
            }
            FinishDecision::Done(waiters) => waiters,
        }
    };

    // If a poke restarted the drain after we decided to settle, re-queue
    // waiters so drain_settled cannot resolve early.
    let waiters = if waiters.is_empty() {
        waiters
    } else {
        let mut guard = lock_inner(&shared);
        let st = state_for(&mut guard, &thread_id);
        if st.running || st.pending || st.wake_timer.is_some() {
            st.waiters.extend(waiters);
            Vec::new()
        } else {
            waiters
        }
    };

    for waiter in waiters {
        waiter();
    }

    if let Err(payload) = result {
        resume_unwind(payload);
    }
}

fn schedule(shared: &SharedScheduler, thread_id: &str) {
    let should_spawn = {
        let mut guard = lock_inner(shared);
        let st = state_for(&mut guard, thread_id);
        // A poke (or the wake itself) supersedes any pending claim-expiry wake.
        clear_wake(st);
        if st.file_path.is_empty() {
            return; // never touched here: no path to drain
        }
        if st.running {
            st.pending = true; // burst coalesce: at most one further pass
            false
        } else {
            st.running = true;
            true
        }
    };
    if should_spawn {
        let shared = Arc::clone(shared);
        let thread_id = thread_id.to_string();
        tokio::spawn(async move {
            run_loop(shared, thread_id).await;
        });
    }
}

fn read_thread_id(db: &Db) -> Option<String> {
    let row = db
        .prepare("SELECT thread_id FROM thread_metadata WHERE id = 1")
        .get()?;
    row.get("thread_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Read a thread file's id without side effects (no migration, no touch).
/// Mirrors TS `new DatabaseSync(filePath, { readOnly: true })` via the
/// internal read-only storage helper; swallows failures like TS `catch`.
pub fn peek_thread_id(file_path: &str) -> Option<String> {
    if !Path::new(file_path).exists() {
        return None;
    }
    let db = match open_database_read_only(file_path) {
        OpResult::Ok { value } => value,
        OpResult::Err { .. } => return None,
    };
    let id = catch_unwind(AssertUnwindSafe(|| read_thread_id(&db)))
        .ok()
        .flatten();
    let _ = catch_unwind(AssertUnwindSafe(|| db.close()));
    id
}

/// TS `Scheduler` — mode + poke/touch/drainSettled/testPassCount.
/// `shared` encodes the TS closure capture over states/seen/deps.
pub struct Scheduler {
    pub mode: SchedulerMode,
    shared: SharedScheduler,
}

impl Scheduler {
    /// Crate-private Arc-handle share for SDK seam/default poke+touch captures.
    /// Not a public `Clone` surface — TS Scheduler is not cloneable; Rust only
    /// needs to duplicate the Arc-backed closure handle at init sites.
    pub(crate) fn shared_handle(&self) -> Self {
        Self {
            mode: self.mode,
            shared: Arc::clone(&self.shared),
        }
    }

    pub fn poke(&self, thread_id: &str) {
        if self.mode != SchedulerMode::Background {
            return;
        }
        let deps = {
            let guard = lock_inner(&self.shared);
            Arc::clone(&guard.deps)
        };
        // Fail-closed: empty handler map must not destroy queued rows.
        if !(deps.has_any_handler)() {
            return;
        }
        schedule(&self.shared, thread_id);
    }

    pub fn touch(&self, file_path: &str, db: &Db) {
        if self.mode != SchedulerMode::Background {
            return;
        }
        let Some(thread_id) = read_thread_id(db) else {
            return;
        };
        let first_touch = {
            let mut guard = lock_inner(&self.shared);
            let st = state_for(&mut guard, &thread_id);
            st.file_path = file_path.to_string();
            if guard.seen.contains(&thread_id) {
                false
            } else {
                guard.seen.insert(thread_id.clone());
                true
            }
        };
        if !first_touch {
            return;
        }
        // Catch-up: leftover live work from a previous process runs on first
        // touch. Callback + SQLite outside the mutex.
        let deps = {
            let guard = lock_inner(&self.shared);
            Arc::clone(&guard.deps)
        };
        if (deps.has_any_handler)() && count_live_items(db) > 0 {
            schedule(&self.shared, &thread_id);
        }
    }

    pub async fn drain_settled(&self, thread_id: &str) {
        let (tx, rx) = oneshot::channel::<()>();
        let wait = {
            let mut guard = lock_inner(&self.shared);
            let Some(st) = guard.states.get_mut(thread_id) else {
                return;
            };
            // A pending claim-expiry wake counts as unsettled.
            if !st.running && !st.pending && st.wake_timer.is_none() {
                return;
            }
            st.waiters.push(Box::new(move || {
                let _ = tx.send(());
            }));
            true
        };
        if wait {
            let _ = rx.await;
        }
    }

    /// Test-only observability for coalescing exactness (TC-1.2).
    pub fn test_pass_count(&self, thread_id: &str) -> i64 {
        let guard = lock_inner(&self.shared);
        guard.states.get(thread_id).map(|st| st.passes).unwrap_or(0)
    }
}

pub fn create_scheduler(mode: SchedulerMode, deps: DrainDeps) -> Scheduler {
    let shared = Arc::new(Mutex::new(SchedulerInner {
        deps: Arc::new(deps),
        states: IndexMap::new(),
        seen: HashSet::new(),
        self_weak: Weak::new(),
    }));
    {
        let mut guard = lock_inner(&shared);
        guard.self_weak = Arc::downgrade(&shared);
    }
    Scheduler { mode, shared }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Amendment D — Node >=24.17 `Date.parse` oracle for wake timestamps.
    #[test]
    fn parse_iso_to_millis_matches_node_oracle() {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct DateParseOracleRow {
            name: String,
            input: String,
            expected: String,
        }

        fn is_canonical_ms_utc_iso(s: &str) -> bool {
            let b = s.as_bytes();
            b.len() == 24
                && b[4] == b'-'
                && b[7] == b'-'
                && b[10] == b'T'
                && b[13] == b':'
                && b[16] == b':'
                && b[19] == b'.'
                && b[23] == b'Z'
                && b[0..4].iter().all(u8::is_ascii_digit)
                && b[5..7].iter().all(u8::is_ascii_digit)
                && b[8..10].iter().all(u8::is_ascii_digit)
                && b[11..13].iter().all(u8::is_ascii_digit)
                && b[14..16].iter().all(u8::is_ascii_digit)
                && b[17..19].iter().all(u8::is_ascii_digit)
                && b[20..23].iter().all(u8::is_ascii_digit)
        }

        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/date-parse-cases.jsonl"
        );
        let body = std::fs::read_to_string(path).expect("read date-parse-cases.jsonl");
        let mut n = 0usize;
        let mut names = std::collections::HashSet::new();
        let mut inputs = std::collections::HashSet::new();
        for (line_no, line) in body.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let row: DateParseOracleRow =
                serde_json::from_str(line).unwrap_or_else(|e| panic!("line {}: {e}", line_no + 1));
            assert!(
                names.insert(row.name.clone()),
                "line {}: duplicate name {}",
                line_no + 1,
                row.name
            );
            assert!(
                inputs.insert(row.input.clone()),
                "line {}: duplicate input {:?}",
                line_no + 1,
                row.input
            );
            assert!(
                row.expected == "invalid" || is_canonical_ms_utc_iso(&row.expected),
                "line {}: expected must be \"invalid\" or canonical ms UTC ISO, got {:?}",
                line_no + 1,
                row.expected
            );
            n += 1;
            let parsed = parse_iso_to_millis(&row.input);
            if row.expected == "invalid" {
                assert!(
                    parsed.is_none(),
                    "{}: expected invalid for {:?}, got {parsed:?}",
                    row.name,
                    row.input
                );
            } else {
                let ms = parsed
                    .unwrap_or_else(|| panic!("{}: expected {}, got None", row.name, row.expected));
                // Signed render (pre-1970 oracle rows are negative millis).
                let secs = ms.div_euclid(1000);
                let millis = ms.rem_euclid(1000) as u32;
                let days = secs.div_euclid(86_400);
                let tod = secs.rem_euclid(86_400);
                let (y, m, d) = civil_from_days(days);
                let hh = tod / 3600;
                let mm = (tod % 3600) / 60;
                let ss = tod % 60;
                let rendered = format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z");
                assert_eq!(
                    rendered, row.expected,
                    "{}: input {:?} rendered {rendered}, oracle {}",
                    row.name, row.input, row.expected
                );
            }
        }
        assert!(
            n >= 80,
            "oracle truncated: only {n} cases (need a meaningful fixed-format matrix)"
        );
        assert_eq!(names.len(), n, "unique names must equal row count");
        assert_eq!(inputs.len(), n, "unique inputs must equal row count");
    }
}
