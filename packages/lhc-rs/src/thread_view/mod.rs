//! Ported from packages/lhc/src/thread-view/index.ts.
//!
//! thread-view surface: model context, status, compact, materialize, and
//! describe. Hot-path reads use local deterministic assembly only: no inference,
//! no network, no queue interaction, and no writes. Profile resolution consumed
//! by initLhc is re-exported at the bottom.
//!
//! Wave 6 owns the full thread-view surface. Wave 1/4/5 PARTIAL stubs
//! ([`CompactAbortSignal`], [`CompactOpts`], [`get_llm_request_context`],
//! [`status`], [`compact`]) are extended — not reshaped.

pub mod internal;

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use futures::FutureExt;
use serde_json::{Map, Value};

use crate::messages;
use crate::shared_tech::context::{resolve_instance_config, resolve_instance_view_config};
use crate::shared_tech::derivation::{DerivationReportEntry, DerivationState};
use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult, storage_failure};
use crate::shared_tech::js_json::{js_json_stringify, js_number_value, js_string_of_number};
use crate::shared_tech::logging::{LogEntry, LogLevel, write_log};
use crate::shared_tech::persist::{
    DbReadTransaction, DbTransaction, DbWriteTransaction, create_db_read_transaction,
    create_db_write_transaction,
};
use crate::shared_tech::storage::{Db, SqlParam};
use crate::shared_tech::token_counting::estimate_tokens;
use crate::shared_tech::view::{
    Band, CompactBandStats, CompactDegradedEntry, CompactGapEntry, CompactReceipt,
    CompactReceiptBands, CompactReceiptConfig, CompactRenderedBand, CompactWarning,
    CompactWarningDerivationType, LlmRequestContext, LlmRequestContextMessage,
    LlmRequestContextPart, LlmRequestContextPartType, LlmRequestContextRole, PreviewCompactOutcome,
    PreviewCompactResult, PruneReceipt, ResolvedViewConfig, SessionThreadView, StoredView,
    StoredViewSourceState, ViewCompactParams, ViewProfile, ViewProfilePercentages, ViewStatus,
    ViewStatusDerivation, ViewStatusView, ViewStatusVisibility,
};
use crate::threads::{ThreadRef, open_thread_database, resolve_thread_ref};
use crate::turns;

use internal::assemble::assemble_view;
use internal::boundary::{read_boundary_position, visibility_zone_tokens};
use internal::compact_compute::{ComputeArrangementOpts, compact_stopped, compute_arrangement};
use internal::materialize::{
    MaterializeEntry, MaterializeInput, path_resolve, write_pi_session_file,
};
use internal::profiles::{default_resolved_view_config, profile_violation};
use internal::render::{
    AssembledContextRole, LITERAL_DERIVATION_STORED_MEMBER_CONCAT, assemble_band_text,
};
use internal::seam::{ViewInjectionPoint, fire_view_injection};
use internal::select::{ArrangementEntry, SkippedEntry};
use internal::session_view::build_session_thread_view;
use internal::snapshot::{
    ViewReplaceBand, ViewReplaceInput, read_stored_view, read_thread_metadata, read_view_snapshot,
    replace_view_snapshot, tail_token_sum,
};

/// Canonical materialize/writePiSessionFile result — one type, re-exported.
pub use internal::materialize::MaterializeResult;

// Config resolution for the operation in hand: the SDK instance's resolved
// view config rides the per-instance seam; below-SDK direct domain calls fall
// back to the built-in defaults through the same one resolution path initLhc
// uses.
//
// REAL no-arg `resolveViewConfig()` result — constructed from defaults without
// calling a todo at module init.
static DEFAULT_VIEW_CONFIG: LazyLock<ResolvedViewConfig> =
    LazyLock::new(default_resolved_view_config);

/// TS `BAND_ORDER` — brief → detailed → smooth (receipt / render walk).
const BAND_ORDER: [Band; 3] = [Band::Brief, Band::Detailed, Band::Smooth];

/// The default base when no profile is named: the first built-in, matching
/// the PI continuation harness. Explicit params override the base field-wise.
const DEFAULT_PROFILE_NAME: &str = "continuation";

/// Accepted materialize format literal — byte-exact from TS.
const MATERIALIZE_FORMAT_PI_SESSION: &str = "pi-session";

/// Unknown-format diagnostic fragments — byte-exact from TS
/// ``unknown materialize format "${String(format)}"; accepted formats are "pi-session"``.
const LITERAL_UNKNOWN_MATERIALIZE_FORMAT_PREFIX: &str = "unknown materialize format \"";
const LITERAL_UNKNOWN_MATERIALIZE_FORMAT_SUFFIX: &str = "\"; accepted formats are \"pi-session\"";

/// Compact warning log / receipt reason literals — byte-exact from index.ts.
const LITERAL_COMPACT_CHUNK_FALLBACK_USED: &str = "compact chunk fallback used";
const LITERAL_NOT_READY: &str = "not_ready";
const LITERAL_UNKNOWN: &str = "unknown";

// ── operation / storage / prune / compact diagnostics (index.ts) ──

/// `no thread file exists at ${filePath}`
const DIAG_NO_THREAD_FILE_PREFIX: &str = "no thread file exists at ";
/// `view getLlmRequestContext failed: ${detail}`
const DIAG_VIEW_GET_LLM_REQUEST_CONTEXT_FAILED: &str = "view getLlmRequestContext failed: ";
const DIAG_VIEW_GET_SESSION_THREAD_VIEW_FAILED: &str = "view getSessionThreadView failed: ";
const DIAG_VIEW_STATUS_FAILED: &str = "view status failed: ";
const DIAG_VIEW_DESCRIBE_FAILED: &str = "view describe failed: ";
const DIAG_VIEW_PRUNE_FAILED: &str = "view prune failed: ";
const DIAG_VIEW_PREVIEW_COMPACT_FAILED: &str = "view previewCompact failed: ";
const DIAG_VIEW_COMPACT_FAILED: &str = "view compact failed: ";
const DIAG_VIEW_MATERIALIZE_FAILED: &str = "view materialize failed: ";
/// `view materialize could not write ${path}: ${detail}`
const DIAG_VIEW_MATERIALIZE_COULD_NOT_WRITE_PREFIX: &str = "view materialize could not write ";
const DIAG_VIEW_MATERIALIZE_COULD_NOT_WRITE_MID: &str = ": ";
/// `targetTokens must be a non-negative finite integer; received ${…}`
const DIAG_TARGET_TOKENS_MUST_BE_NON_NEGATIVE: &str =
    "targetTokens must be a non-negative finite integer; received ";
/// `prune boundary ${computed} would land behind compact point ${compactPoint}`
const DIAG_PRUNE_BOUNDARY_PREFIX: &str = "prune boundary ";
const DIAG_PRUNE_BOUNDARY_WOULD_LAND_MID: &str = " would land behind compact point ";
/// `unknown profile "${baseName}"; configured profiles are ${…}`
const DIAG_UNKNOWN_PROFILE_PREFIX: &str = "unknown profile \"";
const DIAG_UNKNOWN_PROFILE_MID: &str = "\"; configured profiles are ";
/// `.map((name) => `"${name}"`).join(", ")` fragments (same bytes as profiles).
const DIAG_PROFILE_NAME_QUOTE: &str = "\"";
const DIAG_PROFILE_NAME_LIST_JOIN: &str = ", ";
const DIAG_COMPACT_STOPPED_BEFORE_SNAPSHOT_WRITE: &str = "compact stopped before snapshot write";

/// TS compact opts.signal — closed by-value Phase 1 snapshot `{ aborted: bool }`.
/// Mapped Wave 5 use is pre-aborted only. Compact-compute uses this same type
/// (no duplicate AbortSignal). LIVE (phase-review): TS reads a getter that
/// re-evaluates mid-compact; the Rust spelling is a shared atomic flag —
/// `aborted()` re-reads on every call. Constructed non-aborted; the holder
/// (or a clone) flips it via `abort()`.
#[derive(Debug, Clone)]
pub struct CompactAbortSignal {
    aborted: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl CompactAbortSignal {
    pub fn new() -> Self {
        Self {
            aborted: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// TS `signal.aborted` — a live read, never a snapshot.
    pub fn aborted(&self) -> bool {
        self.aborted.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn abort(&self) {
        self.aborted
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Default for CompactAbortSignal {
    fn default() -> Self {
        Self::new()
    }
}

/// Value equality = current aborted state (opts bags derive PartialEq for
/// test snapshot comparisons; two signals compare by what a live read sees).
impl PartialEq for CompactAbortSignal {
    fn eq(&self, other: &Self) -> bool {
        self.aborted() == other.aborted()
    }
}

impl Eq for CompactAbortSignal {}

/// Opts bag for compact / previewCompact — mirrors the TS inline object.
/// No `Default` derive (callers construct the closed shape directly).
#[derive(Debug, Clone, PartialEq)]
pub struct CompactOpts {
    pub profile: Option<String>,
    pub params: Option<ViewCompactParams>,
    pub signal: Option<CompactAbortSignal>,
}

/// TS `params?: { targetTokens?: number }` — JS number (may be fractional;
/// validation rejects non-integers). Tests deliberately pass `10.5`.
#[derive(Debug, Clone, PartialEq)]
pub struct PruneParams {
    pub target_tokens: Option<f64>,
}

/// TS materialize opts `{ path: string; format?: "pi-session" }`.
///
/// `format` is a runtime string (TS type-level literal only). Tests deliberately
/// pass `"markdown"` via cast; a closed Rust enum would make that unrepresentable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializeOpts {
    pub path: String,
    pub format: Option<String>,
}

fn view_config() -> ResolvedViewConfig {
    resolve_instance_view_config().unwrap_or_else(|| DEFAULT_VIEW_CONFIG.clone())
}

fn thread_not_found<T>(file_path: &str) -> OpResult<T> {
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::CallerError,
            code: ErrorCode::ThreadNotFound,
            reason: format!("{DIAG_NO_THREAD_FILE_PREFIX}{file_path}"),
            event_index: None,
        },
    }
}

/// TS `detail(cause)` — Error.message / String(cause). Panic payloads use
/// [`panic_detail`]; this Display lane stays for thrown Error-shaped causes.
#[allow(dead_code)]
fn detail(cause: &dyn std::fmt::Display) -> String {
    cause.to_string()
}

fn panic_detail(panic: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

fn system_time_to_iso(time: SystemTime) -> String {
    let dur = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();
    let days = secs.div_euclid(86_400);
    let day_secs = secs.rem_euclid(86_400) as u32;
    let hour = day_secs / 3600;
    let min = (day_secs % 3600) / 60;
    let sec = day_secs % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z")
}

/// Howard Hinnant civil-from-days (proleptic Gregorian) for UTC dates.
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

fn path_dirname(path: &Path) -> PathBuf {
    path.parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

// ── model context ────────────────────────────────────────────────

/// TS `getLlmRequestContext` — PARTIAL stub (Wave 1); full body Phase 2.
pub async fn get_llm_request_context(ref_: ThreadRef) -> OpResult<LlmRequestContext> {
    let result = AssertUnwindSafe(create_db_read_transaction(ref_, move |transaction| {
        Box::pin(async move {
            let thread_id = read_thread_metadata(transaction.db).thread_id;
            let assembled = assemble_view(transaction.db);
            LlmRequestContext {
                thread_id,
                messages: assembled
                    .entries
                    .into_iter()
                    .map(|entry| LlmRequestContextMessage {
                        role: match entry.message.role {
                            AssembledContextRole::User => LlmRequestContextRole::User,
                            AssembledContextRole::Assistant => LlmRequestContextRole::Assistant,
                        },
                        content: vec![LlmRequestContextPart {
                            type_: LlmRequestContextPartType::Text,
                            text: entry.message.content,
                        }],
                    })
                    .collect(),
            }
        })
    }))
    .catch_unwind()
    .await;

    match result {
        Ok(OpResult::Ok { value }) => OpResult::Ok { value },
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(payload) => storage_failure(&format!(
            "{DIAG_VIEW_GET_LLM_REQUEST_CONTEXT_FAILED}{}",
            panic_detail(payload)
        )),
    }
}

/// SessionManager-friendly materialization from canonical record data.
pub async fn get_session_thread_view(ref_: ThreadRef) -> OpResult<SessionThreadView> {
    let result = AssertUnwindSafe(create_db_read_transaction(ref_, move |transaction| {
        Box::pin(async move { build_session_thread_view(transaction.db) })
    }))
    .catch_unwind()
    .await;

    match result {
        Ok(OpResult::Ok { value }) => OpResult::Ok { value },
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(payload) => storage_failure(&format!(
            "{DIAG_VIEW_GET_SESSION_THREAD_VIEW_FAILED}{}",
            panic_detail(payload)
        )),
    }
}

// ── status ───────────────────────────────────────────────────────

/// Derivation counts bucket from one report entry. Ready derivations are healthy
/// and not an operational situation.
fn bucket_derivation(entries: &[DerivationReportEntry], counts: &mut ViewStatusDerivation) {
    for entry in entries {
        match entry.state {
            DerivationState::Pending => counts.pending += 1,
            DerivationState::Failed => counts.failed += 1,
            DerivationState::Blocked => counts.blocked += 1,
            DerivationState::Ready => {}
        }
    }
}

/// TS `status` — PARTIAL (Wave 4 messages-read DD-6 snapshot; full body later).
pub async fn status(ref_: ThreadRef) -> OpResult<ViewStatus> {
    let resolved = resolve_thread_ref(ref_).await;
    let OpResult::Ok { value: resolved } = resolved else {
        return match resolved {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };
    let file_path = resolved.file_path;
    if !Path::new(&file_path).exists() {
        return thread_not_found(&file_path);
    }

    let config = view_config();
    let read = AssertUnwindSafe(create_db_read_transaction(
        ThreadRef::file_path(file_path.clone()),
        move |transaction| {
            Box::pin(async move {
                let snapshot = read_view_snapshot(transaction.db);
                let compact_point = snapshot.as_ref().map(|s| s.compact_point).unwrap_or(0);
                let boundary_position = read_boundary_position(transaction.db);
                (
                    tail_token_sum(transaction.db, compact_point),
                    boundary_position,
                    visibility_zone_tokens(transaction.db, boundary_position, compact_point),
                    match snapshot {
                        None => None,
                        Some(s) => Some(ViewStatusView {
                            degraded: s.degraded_count,
                            gaps: s.gap_count,
                            built_at: s.created_at,
                        }),
                    },
                )
            })
        },
    ))
    .catch_unwind()
    .await;

    let (tail_tokens, boundary_position, zone_tokens, view) = match read {
        Ok(OpResult::Ok { value }) => value,
        Ok(OpResult::Err { error }) => return OpResult::Err { error },
        Err(payload) => {
            return storage_failure(&format!(
                "{DIAG_VIEW_STATUS_FAILED}{}",
                panic_detail(payload)
            ));
        }
    };

    // The owners' report surfaces open their own handles; ours is closed first
    // so the status read never holds two handles on one thread file.
    let message_report = messages::report(ThreadRef::file_path(file_path.clone()), None).await;
    let OpResult::Ok {
        value: message_report,
    } = message_report
    else {
        return match message_report {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };
    let turn_report = turns::report(ThreadRef::file_path(file_path), None).await;
    let OpResult::Ok { value: turn_report } = turn_report else {
        return match turn_report {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };
    let mut derivation = ViewStatusDerivation {
        pending: 0,
        failed: 0,
        blocked: 0,
    };
    bucket_derivation(&message_report, &mut derivation);
    bucket_derivation(&turn_report, &mut derivation);

    OpResult::Ok {
        value: ViewStatus {
            tail_tokens,
            threshold: config.compact_threshold,
            compact_recommended: tail_tokens as f64 > config.compact_threshold,
            derivation,
            view,
            visibility: ViewStatusVisibility {
                boundary_position,
                zone_tokens,
                max_tokens: config.visibility.max_tokens,
            },
        },
    }
}

// ── describe ─────────────────────────────────────────────────────

/// The stored active view row, exposed read-only so inspect never reads
/// thread-view tables directly.
pub async fn describe(ref_: ThreadRef) -> OpResult<Option<StoredView>> {
    let result = AssertUnwindSafe(create_db_read_transaction(ref_, move |transaction| {
        Box::pin(async move { read_stored_view(transaction.db) })
    }))
    .catch_unwind()
    .await;

    match result {
        Ok(OpResult::Ok { value }) => OpResult::Ok { value },
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(payload) => storage_failure(&format!(
            "{DIAG_VIEW_DESCRIBE_FAILED}{}",
            panic_detail(payload)
        )),
    }
}

// ── prune ────────────────────────────────────────────────────────

/// TS SQL — exact source bytes (index.ts prune helpers).
const SQL_READ_ZONE_TOOL_RESULTS: &str = "SELECT source_event_order, token_estimate FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL AND source_event_order > ?
       ORDER BY source_event_order DESC";

const SQL_TOKENS_BEHIND_BOUNDARY: &str =
    "SELECT COALESCE(SUM(token_estimate), 0) AS total FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL
         AND source_event_order > ? AND source_event_order <= ?";

const SQL_COUNT_PRUNED_TOOL_RESULTS: &str = "SELECT COUNT(*) AS n FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL
         AND source_event_order > ? AND source_event_order <= ?";

const SQL_UPDATE_BOUNDARY: &str =
    "UPDATE view_boundary SET position = ?, updated_at = ? WHERE thread_singleton = 1";

/// Closed prune caller-error code — TS `code: "invalid_target_tokens"` only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PruneCallerErrorCode {
    InvalidTargetTokens,
}

impl PruneCallerErrorCode {
    fn as_error_code(self) -> ErrorCode {
        match self {
            PruneCallerErrorCode::InvalidTargetTokens => ErrorCode::InvalidTargetTokens,
        }
    }
}

fn prune_caller_error<T>(code: PruneCallerErrorCode, reason: String) -> OpResult<T> {
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::CallerError,
            code: code.as_error_code(),
            reason,
            event_index: None,
        },
    }
}

/// Explicit prune input rejects non-integers; default path may return fractional
/// configured `visibility.targetTokens` (no silent round/truncate).
fn validate_prune_target(target_tokens: Option<f64>) -> OpResult<f64> {
    match target_tokens {
        None => OpResult::Ok {
            value: view_config().visibility.target_tokens,
        },
        Some(n) => {
            if !n.is_finite() || n.fract() != 0.0 || n < 0.0 {
                return prune_caller_error(
                    PruneCallerErrorCode::InvalidTargetTokens,
                    format!(
                        "{DIAG_TARGET_TOKENS_MUST_BE_NON_NEGATIVE}{}",
                        js_string_of_number(n)
                    ),
                );
            }
            OpResult::Ok { value: n }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolResultZoneRow {
    source_event_order: i64,
    token_estimate: i64,
}

fn map_required_i64(row: &Map<String, Value>, key: &str) -> i64 {
    match row.get(key) {
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                return i;
            }
            if let Some(f) = n.as_f64() {
                return internal::exact_i64::f64_to_exact_i64(f)
                    .unwrap_or_else(|| panic!("column {key} not integer"));
            }
            panic!("column {key} not integer");
        }
        Some(Value::String(s)) => s
            .parse::<i64>()
            .unwrap_or_else(|_| panic!("column {key} not integer")),
        _ => panic!("missing column {key}"),
    }
}

fn read_zone_tool_results(db: &Db, effective_start: i64) -> Vec<ToolResultZoneRow> {
    db.prepare(SQL_READ_ZONE_TOOL_RESULTS)
        .all(&[SqlParam::from(effective_start)])
        .into_iter()
        .map(|row| ToolResultZoneRow {
            source_event_order: map_required_i64(&row, "source_event_order"),
            token_estimate: map_required_i64(&row, "token_estimate"),
        })
        .collect()
}

fn tokens_behind_boundary(db: &Db, boundary: i64, compact_point: i64) -> i64 {
    let row = db
        .prepare(SQL_TOKENS_BEHIND_BOUNDARY)
        .get_params(&[SqlParam::from(compact_point), SqlParam::from(boundary)]);
    match row {
        Some(row) => map_required_i64(&row, "total"),
        None => 0,
    }
}

fn count_pruned_tool_results(
    db: &Db,
    previous_boundary: i64,
    new_boundary: i64,
    compact_point: i64,
) -> i64 {
    let row = db.prepare(SQL_COUNT_PRUNED_TOOL_RESULTS).get_params(&[
        SqlParam::from(previous_boundary.max(compact_point)),
        SqlParam::from(new_boundary),
    ]);
    match row {
        Some(row) => map_required_i64(&row, "n"),
        None => 0,
    }
}

#[derive(Debug, Clone, PartialEq)]
struct BuildPruneReceiptInput {
    previous_boundary: i64,
    new_boundary: i64,
    compact_point: i64,
    /// Validated integer or fractional configured default — TS `number`.
    target_tokens: f64,
    zone_tokens_before: i64,
    no_op: bool,
}

fn build_prune_receipt(db: &Db, input: &BuildPruneReceiptInput) -> PruneReceipt {
    let zone_tokens_after = visibility_zone_tokens(db, input.new_boundary, input.compact_point);
    PruneReceipt {
        previous_boundary: input.previous_boundary,
        new_boundary: input.new_boundary,
        compact_point: input.compact_point,
        target_tokens: input.target_tokens,
        tool_results_pruned: if input.no_op {
            0
        } else {
            count_pruned_tool_results(
                db,
                input.previous_boundary,
                input.new_boundary,
                input.compact_point,
            )
        },
        tokens_behind_boundary: tokens_behind_boundary(db, input.new_boundary, input.compact_point),
        zone_tokens_before: input.zone_tokens_before,
        zone_tokens_after,
        no_op: input.no_op,
    }
}

fn compute_prune_boundary(
    rows: &[ToolResultZoneRow],
    target_tokens: f64,
    previous_boundary: i64,
) -> i64 {
    let mut accumulated = 0.0;
    for row in rows {
        if accumulated + (row.token_estimate as f64) <= target_tokens {
            accumulated += row.token_estimate as f64;
            continue;
        }
        return row.source_event_order;
    }
    previous_boundary
}

fn prune_in_transaction(transaction: &DbWriteTransaction, target_tokens: f64) -> PruneReceipt {
    let db = transaction.db;
    let snapshot = read_view_snapshot(db);
    let compact_point = snapshot.as_ref().map(|s| s.compact_point).unwrap_or(0);
    let previous_boundary = read_boundary_position(db);
    let effective_start = previous_boundary.max(compact_point);
    let zone_tokens_before = visibility_zone_tokens(db, previous_boundary, compact_point);

    if (zone_tokens_before as f64) <= target_tokens {
        return build_prune_receipt(
            db,
            &BuildPruneReceiptInput {
                previous_boundary,
                new_boundary: previous_boundary,
                compact_point,
                target_tokens,
                zone_tokens_before,
                no_op: true,
            },
        );
    }

    let rows = read_zone_tool_results(db, effective_start);
    let computed_boundary = compute_prune_boundary(&rows, target_tokens, previous_boundary);

    if computed_boundary <= previous_boundary {
        return build_prune_receipt(
            db,
            &BuildPruneReceiptInput {
                previous_boundary,
                new_boundary: previous_boundary,
                compact_point,
                target_tokens,
                zone_tokens_before,
                no_op: true,
            },
        );
    }

    if computed_boundary <= compact_point {
        panic!(
            "{DIAG_PRUNE_BOUNDARY_PREFIX}{computed_boundary}{DIAG_PRUNE_BOUNDARY_WOULD_LAND_MID}{compact_point}"
        );
    }

    let updated_at = system_time_to_iso((transaction.clock)());
    db.prepare(SQL_UPDATE_BOUNDARY).run(&[
        SqlParam::from(computed_boundary),
        SqlParam::from(updated_at.as_str()),
    ]);

    build_prune_receipt(
        db,
        &BuildPruneReceiptInput {
            previous_boundary,
            new_boundary: computed_boundary,
            compact_point,
            target_tokens,
            zone_tokens_before,
            no_op: false,
        },
    )
}

/// Advance the visibility boundary forward so older tool results in the
/// visibility zone render short.
pub async fn prune(ref_: ThreadRef, params: Option<PruneParams>) -> OpResult<PruneReceipt> {
    let resolved = resolve_thread_ref(ref_.clone()).await;
    let OpResult::Ok { value: resolved } = resolved else {
        return match resolved {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };
    let file_path = resolved.file_path;
    if !Path::new(&file_path).exists() {
        return thread_not_found(&file_path);
    }

    let target = validate_prune_target(params.and_then(|p| p.target_tokens));
    let OpResult::Ok {
        value: target_tokens,
    } = target
    else {
        return match target {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };

    let result = AssertUnwindSafe(create_db_write_transaction(
        ref_,
        move |transaction| {
            Box::pin(async move { prune_in_transaction(transaction, target_tokens) })
        },
        None,
    ))
    .catch_unwind()
    .await;

    match result {
        Ok(OpResult::Ok { value }) => OpResult::Ok { value },
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(payload) => storage_failure(&format!(
            "{DIAG_VIEW_PRUNE_FAILED}{}",
            panic_detail(payload)
        )),
    }
}

// ── compact ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallerErrorCode {
    UnknownProfile,
    InvalidViewConfig,
    CompactStopped,
}

fn caller_error<T>(code: CallerErrorCode, reason: String) -> OpResult<T> {
    let code = match code {
        CallerErrorCode::UnknownProfile => ErrorCode::UnknownProfile,
        CallerErrorCode::InvalidViewConfig => ErrorCode::InvalidViewConfig,
        CallerErrorCode::CompactStopped => ErrorCode::CompactStopped,
    };
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::CallerError,
            code,
            reason,
            event_index: None,
        },
    }
}

#[derive(Debug, Clone, PartialEq)]
struct ResolvedCompactCall {
    merged: ViewProfile,
    profile_name: Option<String>,
}

fn resolve_compact_call(opts: &CompactOpts) -> OpResult<ResolvedCompactCall> {
    let config = view_config();
    let base_name = opts.profile.as_deref().unwrap_or(DEFAULT_PROFILE_NAME);
    let Some(base) = config.profiles.get(base_name) else {
        let names = config
            .profiles
            .keys()
            .map(|name| format!("{DIAG_PROFILE_NAME_QUOTE}{name}{DIAG_PROFILE_NAME_QUOTE}"))
            .collect::<Vec<_>>()
            .join(DIAG_PROFILE_NAME_LIST_JOIN);
        return caller_error(
            CallerErrorCode::UnknownProfile,
            format!("{DIAG_UNKNOWN_PROFILE_PREFIX}{base_name}{DIAG_UNKNOWN_PROFILE_MID}{names}"),
        );
    };
    let mut percentages = base.percentages.clone();
    if let Some(partial) = opts.params.as_ref().and_then(|p| p.percentages.as_ref()) {
        if let Some(v) = partial.full {
            percentages.full = v;
        }
        if let Some(v) = partial.smooth {
            percentages.smooth = v;
        }
        if let Some(v) = partial.detailed {
            percentages.detailed = v;
        }
        if let Some(v) = partial.brief {
            percentages.brief = v;
        }
    }
    let merged = ViewProfile {
        name: base.name.clone(),
        lower_bound: opts
            .params
            .as_ref()
            .and_then(|p| p.lower_bound)
            .unwrap_or(base.lower_bound),
        percentages,
    };
    if let Some(violation) = profile_violation(&merged) {
        return caller_error(CallerErrorCode::InvalidViewConfig, violation);
    }
    let profile_name = if opts.params.is_none() {
        Some(base_name.to_string())
    } else {
        None
    };
    OpResult::Ok {
        value: ResolvedCompactCall {
            merged,
            profile_name,
        },
    }
}

#[derive(Debug, Clone, PartialEq)]
struct StoredBandRow {
    band: Band,
    rendered_text: String,
    token_count: i64,
}

fn build_rendered_bands(
    selection_entries: &[ArrangementEntry],
    bands: &[StoredBandRow],
) -> Vec<CompactRenderedBand> {
    BAND_ORDER
        .into_iter()
        .flat_map(|band| {
            let entries: Vec<&ArrangementEntry> = selection_entries
                .iter()
                .filter(|entry| entry.band == band)
                .collect();
            if entries.is_empty() {
                return Vec::new();
            }
            let stored = bands.iter().find(|row| row.band == band);
            let text = match stored {
                Some(row) => row.rendered_text.clone(),
                None => assemble_band_text(
                    &entries
                        .iter()
                        .map(|entry| entry.text.clone())
                        .collect::<Vec<_>>(),
                ),
            };
            vec![CompactRenderedBand { band, text }]
        })
        .collect()
}

fn arrangement_json_value(entries: &[ArrangementEntry]) -> Value {
    Value::Array(
        entries
            .iter()
            .map(|entry| {
                let mut obj = Map::new();
                obj.insert(
                    "band".into(),
                    Value::String(entry.band.as_str().to_string()),
                );
                obj.insert(
                    "subjectKind".into(),
                    Value::String(entry.subject_kind.as_str().to_string()),
                );
                obj.insert("subjectId".into(), Value::String(entry.subject_id.clone()));
                obj.insert(
                    "derivationUsed".into(),
                    Value::String(entry.derivation_used.clone()),
                );
                obj.insert("degraded".into(), Value::Bool(entry.degraded));
                Value::Object(obj)
            })
            .collect(),
    )
}

/// The view's gaps: gap entries (a rendered subject with no usable material)
/// and subjects the last band's walk skipped as too large (no entry at all).
/// Both are holes in the same coverage window, so both land in gaps_json and
/// the receipt — one projection, used at every serialization site.
fn gap_notes(entries: &[ArrangementEntry], skipped: &[SkippedEntry]) -> Vec<CompactGapEntry> {
    entries
        .iter()
        .filter(|entry| entry.gap)
        .map(|entry| CompactGapEntry {
            band: entry.band,
            subject_id: entry.subject_id.clone(),
            reason: entry
                .reason
                .clone()
                .unwrap_or_else(|| LITERAL_UNKNOWN.to_string()),
        })
        .chain(skipped.iter().map(|skip| CompactGapEntry {
            band: skip.band,
            subject_id: skip.subject_id.clone(),
            reason: skip.reason.clone(),
        }))
        .collect()
}

fn gaps_json_value(entries: &[ArrangementEntry], skipped: &[SkippedEntry]) -> Value {
    Value::Array(
        gap_notes(entries, skipped)
            .into_iter()
            .map(|note| {
                let mut obj = Map::new();
                obj.insert("band".into(), Value::String(note.band.as_str().to_string()));
                obj.insert("subjectId".into(), Value::String(note.subject_id));
                obj.insert("reason".into(), Value::String(note.reason));
                Value::Object(obj)
            })
            .collect(),
    )
}

/// Preview helper for wouldProduceBands.
fn selection_would_write_snapshot(
    transaction: &DbReadTransaction,
    compact_point: i64,
    entries: &[ArrangementEntry],
    skipped: &[SkippedEntry],
) -> bool {
    if compact_point <= 0 {
        return false;
    }
    let stored = read_stored_view(transaction.db);
    let Some(stored) = stored else {
        return true;
    };
    if compact_point != stored.compact_point {
        return true;
    }

    let arrangement = arrangement_json_value(entries);
    let gaps = gaps_json_value(entries, skipped);
    let stored_arrangement =
        js_json_stringify(&serde_json::to_value(&stored.arrangement).unwrap_or(Value::Null));
    let stored_gaps = js_json_stringify(&serde_json::to_value(&stored.gaps).unwrap_or(Value::Null));
    js_json_stringify(&arrangement) != stored_arrangement || js_json_stringify(&gaps) != stored_gaps
}

/// TS nested `entriesByBand` inside `compact`.
fn entries_by_band(entries: &[ArrangementEntry], band: Band) -> Vec<ArrangementEntry> {
    entries
        .iter()
        .filter(|entry| entry.band == band)
        .cloned()
        .collect()
}

/// Read-only compact preflight: same selection path as compact, no snapshot write.
pub async fn preview_compact(
    ref_: ThreadRef,
    opts: CompactOpts,
) -> OpResult<PreviewCompactOutcome> {
    let call = resolve_compact_call(&opts);
    let OpResult::Ok { value: call } = call else {
        return match call {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };

    let signal = opts.signal.clone();
    let result = AssertUnwindSafe(create_db_read_transaction(ref_, move |transaction| {
        let merged = call.merged.clone();
        let signal = signal.clone();
        Box::pin(async move {
            let computed = compute_arrangement(
                transaction.db,
                transaction,
                &merged,
                &ComputeArrangementOpts {
                    signal,
                    include_chunk_materials: false,
                },
            );
            match computed {
                OpResult::Err { error } => PreviewCompactOutcome::Error {
                    reason: error.reason,
                },
                OpResult::Ok { value } => {
                    let selection = value.selection;
                    let tail_tokens = tail_token_sum(transaction.db, selection.compact_point);
                    PreviewCompactOutcome::Ok {
                        preview: PreviewCompactResult {
                            compact_point: selection.compact_point,
                            would_produce_bands: selection_would_write_snapshot(
                                transaction,
                                selection.compact_point,
                                &selection.entries,
                                &selection.skipped,
                            ),
                            tail_tokens,
                            first_kept_message_id: value.first_kept_message_id,
                        },
                    }
                }
            }
        })
    }))
    .catch_unwind()
    .await;

    match result {
        Ok(OpResult::Ok { value }) => OpResult::Ok { value },
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(payload) => storage_failure(&format!(
            "{DIAG_VIEW_PREVIEW_COMPACT_FAILED}{}",
            panic_detail(payload)
        )),
    }
}

fn percentages_json(percentages: &ViewProfilePercentages) -> Value {
    let mut pct = Map::new();
    pct.insert("full".into(), js_number_value(percentages.full));
    pct.insert("smooth".into(), js_number_value(percentages.smooth));
    pct.insert("detailed".into(), js_number_value(percentages.detailed));
    pct.insert("brief".into(), js_number_value(percentages.brief));
    Value::Object(pct)
}

/// Stored-config JSON bytes compact persists as `config_json`.
fn stored_view_config_json(lower_bound: f64, percentages: &ViewProfilePercentages) -> String {
    let mut config_obj = Map::new();
    config_obj.insert("lowerBound".into(), js_number_value(lower_bound));
    config_obj.insert("percentages".into(), percentages_json(percentages));
    js_json_stringify(&Value::Object(config_obj))
}

/// Compact-receipt config — `{ ...percentages, lowerBound }`.
fn compact_receipt_config(merged: &ViewProfile) -> CompactReceiptConfig {
    CompactReceiptConfig {
        full: merged.percentages.full,
        smooth: merged.percentages.smooth,
        detailed: merged.percentages.detailed,
        brief: merged.percentages.brief,
        lower_bound: merged.lower_bound,
    }
}

/// TS `compact` — PARTIAL (Wave 5 chunk-compact-recovery); full body Phase 2.
pub async fn compact(ref_: ThreadRef, opts: CompactOpts) -> OpResult<CompactReceipt> {
    let resolved = resolve_thread_ref(ref_).await;
    let OpResult::Ok { value: resolved } = resolved else {
        return match resolved {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };
    let file_path = resolved.file_path;
    if !Path::new(&file_path).exists() {
        return thread_not_found(&file_path);
    }

    let call = resolve_compact_call(&opts);
    let OpResult::Ok {
        value: ResolvedCompactCall {
            merged,
            profile_name,
        },
    } = call
    else {
        return match call {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };

    let opened = open_thread_database(&file_path);
    let OpResult::Ok { value: db } = opened else {
        return match opened {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };

    let outcome = catch_unwind_compact(|| {
        let thread_id = read_thread_metadata(&db).thread_id;
        let transaction = DbReadTransaction {
            db: &db,
            file_path: file_path.clone(),
            thread_id,
        };
        let computed = compute_arrangement(
            &db,
            &transaction,
            &merged,
            &ComputeArrangementOpts {
                signal: opts.signal.clone(),
                include_chunk_materials: true,
            },
        );
        let OpResult::Ok { value: computed } = computed else {
            return match computed {
                OpResult::Err { error } => OpResult::Err { error },
                OpResult::Ok { .. } => unreachable!(),
            };
        };

        let selection = computed.selection;
        let inputs = computed.inputs;
        let view_id = computed.view_id;
        let first_kept_message_id = computed.first_kept_message_id;

        let warnings: Vec<CompactWarning> = selection
            .entries
            .iter()
            .filter(|entry| entry.derivation_used == LITERAL_DERIVATION_STORED_MEMBER_CONCAT)
            .map(|entry| CompactWarning {
                band: entry.band,
                subject_id: entry.subject_id.clone(),
                derivation_type: if entry.band == Band::Brief {
                    CompactWarningDerivationType::ChunkSummaryBrief
                } else {
                    CompactWarningDerivationType::ChunkSummaryDetailed
                },
                reason: entry
                    .reason
                    .clone()
                    .unwrap_or_else(|| LITERAL_NOT_READY.to_string()),
            })
            .collect();
        for warning in &warnings {
            write_log(
                DbTransaction::Read(&transaction),
                &LogEntry {
                    level: LogLevel::Warning,
                    message: LITERAL_COMPACT_CHUNK_FALLBACK_USED.to_string(),
                    derivation_type: Some(warning.derivation_type.as_str().to_string()),
                    subject_id: Some(warning.subject_id.clone()),
                    reason: Some(warning.reason.clone()),
                    floor_used: Some(LITERAL_DERIVATION_STORED_MEMBER_CONCAT.to_string()),
                },
            );
        }

        let bands: Vec<StoredBandRow> = BAND_ORDER
            .into_iter()
            .flat_map(|band| {
                let entries = entries_by_band(&selection.entries, band);
                if entries.is_empty() {
                    return Vec::new();
                }
                let rendered_text =
                    assemble_band_text(&entries.iter().map(|e| e.text.clone()).collect::<Vec<_>>());
                let token_count = estimate_tokens(&rendered_text);
                vec![StoredBandRow {
                    band,
                    rendered_text,
                    token_count,
                }]
            })
            .collect();

        // TS `new Date().toISOString()` — under the SDK seam, honor the
        // instance clock (lifecycle freezes Date / injects SdkConfig.clock).
        let created_at = system_time_to_iso(
            resolve_instance_config()
                .map(|c| (c.clock)())
                .unwrap_or_else(SystemTime::now),
        );

        fire_view_injection(ViewInjectionPoint::CompactWrite);

        if compact_stopped(opts.signal.as_ref()) {
            return caller_error(
                CallerErrorCode::CompactStopped,
                DIAG_COMPACT_STOPPED_BEFORE_SNAPSHOT_WRITE.to_string(),
            );
        }

        let source_state = StoredViewSourceState {
            max_event_order: inputs.max_event_order,
            derivation_counts: inputs.derivation_counts.clone(),
        };
        let source_state_json =
            js_json_stringify(&serde_json::to_value(&source_state).unwrap_or(Value::Null));

        replace_view_snapshot(
            &db,
            &ViewReplaceInput {
                view_id: view_id.clone(),
                created_at,
                compact_point: selection.compact_point,
                covered_from: selection.covered_from,
                profile_name: profile_name.clone(),
                config_json: stored_view_config_json(merged.lower_bound, &merged.percentages),
                arrangement_json: js_json_stringify(&arrangement_json_value(&selection.entries)),
                gaps_json: js_json_stringify(&gaps_json_value(
                    &selection.entries,
                    &selection.skipped,
                )),
                source_state_json,
                bands: bands
                    .iter()
                    .map(|b| ViewReplaceBand {
                        band: b.band,
                        rendered_text: b.rendered_text.clone(),
                        token_count: b.token_count,
                    })
                    .collect(),
            },
        );

        let mut brief = CompactBandStats {
            entries: 0,
            tokens: 0,
        };
        let mut detailed = CompactBandStats {
            entries: 0,
            tokens: 0,
        };
        let mut smooth = CompactBandStats {
            entries: 0,
            tokens: 0,
        };
        for band in BAND_ORDER {
            let stored = bands.iter().find(|row| row.band == band);
            let stats = CompactBandStats {
                entries: entries_by_band(&selection.entries, band).len() as i64,
                tokens: stored.map(|s| s.token_count).unwrap_or(0),
            };
            match band {
                Band::Brief => brief = stats,
                Band::Detailed => detailed = stats,
                Band::Smooth => smooth = stats,
            }
        }
        let band_report = CompactReceiptBands {
            brief,
            detailed,
            smooth,
        };
        let tail_tokens = tail_token_sum(&db, selection.compact_point);
        let rendered_bands = build_rendered_bands(&selection.entries, &bands);
        OpResult::Ok {
            value: CompactReceipt {
                view_id,
                profile: profile_name,
                config: compact_receipt_config(&merged),
                bands: band_report.clone(),
                tail_tokens,
                total_tokens: band_report.brief.tokens
                    + band_report.detailed.tokens
                    + band_report.smooth.tokens
                    + tail_tokens,
                covered_from: selection.covered_from,
                compact_point: selection.compact_point,
                degraded: selection
                    .entries
                    .iter()
                    .filter(|entry| entry.degraded)
                    .map(|entry| CompactDegradedEntry {
                        band: entry.band,
                        subject_id: entry.subject_id.clone(),
                        used_derivation: entry.derivation_used.clone(),
                    })
                    .collect(),
                gaps: gap_notes(&selection.entries, &selection.skipped),
                warnings: Some(warnings),
                rendered_bands,
                first_kept_message_id,
            },
        }
    });

    // Explicit cleanup: always close the handle opened for compact.
    db.close();

    match outcome {
        Ok(result) => result,
        Err(payload) => storage_failure(&format!(
            "{DIAG_VIEW_COMPACT_FAILED}{}",
            panic_detail(payload)
        )),
    }
}

fn catch_unwind_compact<F>(f: F) -> Result<OpResult<CompactReceipt>, Box<dyn std::any::Any + Send>>
where
    F: FnOnce() -> OpResult<CompactReceipt>,
{
    std::panic::catch_unwind(AssertUnwindSafe(f))
}

// ── materialize ──────────────────────────────────────────────────

/// PI session-file materialization: run the serving assembly internally, hand
/// the same entry array to the JSONL writer, return the written path.
pub async fn materialize(ref_: ThreadRef, opts: MaterializeOpts) -> OpResult<MaterializeResult> {
    let format = opts
        .format
        .as_deref()
        .unwrap_or(MATERIALIZE_FORMAT_PI_SESSION);
    if format != MATERIALIZE_FORMAT_PI_SESSION {
        return OpResult::Err {
            error: ErrorResult {
                error_class: ErrorClass::CallerError,
                code: ErrorCode::UnknownFormat,
                reason: format!(
                    "{LITERAL_UNKNOWN_MATERIALIZE_FORMAT_PREFIX}{format}{LITERAL_UNKNOWN_MATERIALIZE_FORMAT_SUFFIX}"
                ),
                event_index: None,
            },
        };
    }

    let read = AssertUnwindSafe(create_db_read_transaction(ref_, move |transaction| {
        Box::pin(async move {
            let assembled = assemble_view(transaction.db);
            let thread_meta = read_thread_metadata(transaction.db);
            let resolved_file = path_resolve(&transaction.file_path);
            MaterializeInput {
                thread_id: thread_meta.thread_id,
                header_timestamp: assembled
                    .snapshot
                    .as_ref()
                    .map(|s| s.created_at.clone())
                    .unwrap_or(thread_meta.created_at),
                // Deterministic per thread file — never the writing process's cwd.
                cwd: path_dirname(&resolved_file).to_string_lossy().into_owned(),
                entries: assembled
                    .entries
                    .into_iter()
                    .map(|e| MaterializeEntry {
                        message: e.message,
                        entry_id: e.entry_id,
                        timestamp: e.timestamp,
                    })
                    .collect(),
            }
        })
    }))
    .catch_unwind()
    .await;

    let input = match read {
        Ok(OpResult::Ok { value }) => value,
        Ok(OpResult::Err { error }) => return OpResult::Err { error },
        Err(payload) => {
            return storage_failure(&format!(
                "{DIAG_VIEW_MATERIALIZE_FAILED}{}",
                panic_detail(payload)
            ));
        }
    };

    let write = std::panic::catch_unwind(AssertUnwindSafe(|| {
        write_pi_session_file(&input, &opts.path)
    }));
    match write {
        Ok(value) => OpResult::Ok { value },
        Err(payload) => storage_failure(&format!(
            "{DIAG_VIEW_MATERIALIZE_COULD_NOT_WRITE_PREFIX}{}{DIAG_VIEW_MATERIALIZE_COULD_NOT_WRITE_MID}{}",
            opts.path,
            panic_detail(payload)
        )),
    }
}

// ── initLhc substrate ────────────────────────────────────────────
// Matching TS index.ts bottom export.
pub use internal::profiles::{
    BUILT_IN_PROFILES, DEFAULT_COMPACT_THRESHOLD, DEFAULT_VISIBILITY, resolve_view_config,
};
