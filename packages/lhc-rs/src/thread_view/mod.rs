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
use std::time::SystemTime;

use futures::FutureExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::compact_continuation::has_forced_boundary_history;
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
use crate::shared_tech::sha256::sha256_hex;
use crate::shared_tech::storage::{Db, SqlParam};
use crate::shared_tech::time::system_time_to_iso;
use crate::shared_tech::token_counting::estimate_tokens;
use crate::shared_tech::view::{
    Band, CompactBandStats, CompactDegradedEntry, CompactGapEntry, CompactReceipt,
    CompactReceiptBands, CompactReceiptConfig, CompactRenderedBand, CompactWarning,
    CompactWarningDerivationType, HostMetadata, LlmRequestContext, LlmRequestContextMessage,
    LlmRequestContextPart, LlmRequestContextPartType, LlmRequestContextRole, PreviewCompactOutcome,
    PreviewCompactResult, PruneReceipt, ResolvedViewConfig, SessionThreadView, SkippedRecord,
    StoredView, StoredViewSourceState, ViewCompactParams, ViewProfile, ViewProfilePercentages,
    ViewStatus, ViewStatusDerivation, ViewStatusView, ViewStatusVisibility, ViewSubjectKind,
};
use crate::threads::{ThreadRef, open_thread_database, resolve_thread_ref};
use crate::turns;

use internal::assemble::assemble_view;
use internal::boundary::{read_boundary_position, visibility_zone_tokens};
use internal::compact_compute::{ComputeArrangementOpts, compact_stopped, compute_arrangement};
use internal::host_metadata::read_host_metadata;
use internal::materialize::{
    MaterializeEntry, MaterializeInput, path_resolve, write_pi_session_file,
};
use internal::profiles::{default_resolved_view_config, profile_violation};
pub use internal::protected_boundary::ProtectedBoundaryPreview;
use internal::protected_boundary::{ProtectedBoundaryOpts, preview_protected_visibility_boundary};
use internal::render::{
    AssembledContextRole, LITERAL_DERIVATION_STORED_MEMBER_CONCAT, assemble_band_text,
};
use internal::seam::{ViewInjectionPoint, fire_view_injection, fire_view_injection_with_db};
use internal::select::{ArrangementEntry, SelectionResult, SkippedEntry};
use internal::session_view::build_session_thread_view;
use internal::snapshot::{
    ViewReplaceBand, ViewReplaceInput, read_stored_view, read_thread_metadata, read_view_snapshot,
    replace_view_snapshot_with, tail_token_sum,
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
// Mirrors TS inventory; prepare/install paths surface their own prefixes today.
#[allow(dead_code)]
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
    /// Compact point must stay at or behind this event order (protected-pair
    /// tail preservation).
    pub compact_point_upper_bound: Option<i64>,
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

/// Host metadata: the pressure-decision reads (turn parts, AC-7.1). Read-only.
/// The host's seam assertion (turn parts, AC-7.4): the four facts the
/// forced-boundary runtime already takes. Core cannot observe capture in
/// flight; asserting these truthfully is the host's obligation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MidTurnSeamAssertion {
    pub model_response_complete: bool,
    pub requested_tools_settled: bool,
    pub capture_flushed: bool,
    pub before_next_provider_request: bool,
}

impl MidTurnSeamAssertion {
    fn settled(self) -> bool {
        self.model_response_complete
            && self.requested_tools_settled
            && self.capture_flushed
            && self.before_next_provider_request
    }
}

/// TS `MidTurnCompactOptions`. `seam` is `Option` so an absent assertion is
/// expressible (TS: the field missing) and refused the same way as a false one.
#[derive(Debug, Clone, Default)]
pub struct MidTurnCompactOptions {
    pub seam: Option<MidTurnSeamAssertion>,
    pub profile: Option<String>,
    pub params: Option<ViewCompactParams>,
    pub signal: Option<CompactAbortSignal>,
    pub created_at: Option<String>,
}

/// TS reason text — byte-exact.
pub(crate) const DIAG_UNSETTLED_CAPTURE_SEAM: &str = "mid-turn compact requires a settled capture seam: the host must assert modelResponseComplete, requestedToolsSettled, captureFlushed, and beforeNextProviderRequest";
pub(crate) const DIAG_FORCED_BOUNDARY_THREAD: &str = "mid-turn compact refused: this thread is on the forced-boundary path and is never served parts";

/// Mid-turn compact (turn parts, Flow 7): the ordinary prepare → install
/// compact, invoked by a host between steps. Not a third algorithm state — the
/// bounded plan splits and settles whenever it runs; this entry point adds
/// only the two typed refusals the host contract needs before any assembly:
/// an unsettled seam (AC-7.4) and a thread on the forced-boundary path
/// (AC-7.3). Refusals touch nothing.
pub async fn mid_turn_compact(
    ref_: ThreadRef,
    opts: MidTurnCompactOptions,
) -> OpResult<CompactReceipt> {
    if !opts.seam.is_some_and(MidTurnSeamAssertion::settled) {
        return OpResult::Err {
            error: ErrorResult {
                error_class: ErrorClass::CallerError,
                code: ErrorCode::UnsettledCaptureSeam,
                reason: DIAG_UNSETTLED_CAPTURE_SEAM.to_string(),
                event_index: None,
            },
        };
    }
    let resolved = resolve_thread_ref(ref_.clone()).await;
    let OpResult::Ok { value: resolved } = resolved else {
        return match resolved {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };
    if !Path::new(&resolved.file_path).exists() {
        return thread_not_found(&resolved.file_path);
    }
    let forced = AssertUnwindSafe(create_db_read_transaction(
        ref_.clone(),
        move |transaction| Box::pin(async move { has_forced_boundary_history(transaction.db) }),
    ))
    .catch_unwind()
    .await;
    let forced = match forced {
        Ok(OpResult::Ok { value }) => value,
        Ok(OpResult::Err { error }) => return OpResult::Err { error },
        Err(payload) => {
            return storage_failure(&format!(
                "view midTurnCompact failed: {}",
                panic_detail(payload)
            ));
        }
    };
    if forced {
        return OpResult::Err {
            error: ErrorResult {
                error_class: ErrorClass::CallerError,
                code: ErrorCode::ForcedBoundaryThread,
                reason: DIAG_FORCED_BOUNDARY_THREAD.to_string(),
                event_index: None,
            },
        };
    }
    let prepared = prepare_compact(
        ref_.clone(),
        CompactOpts {
            profile: opts.profile,
            params: opts.params,
            signal: opts.signal.clone(),
            compact_point_upper_bound: None,
        },
    )
    .await;
    let OpResult::Ok { value: prepared } = prepared else {
        return match prepared {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };
    install_prepared_compact(
        ref_,
        prepared,
        InstallPreparedOptions {
            signal: opts.signal,
            created_at: opts.created_at,
            allowed_marker_idempotency_key: None,
            visibility_boundary: None,
            expected_previous_boundary: None,
        },
    )
    .await
}

pub async fn host_metadata(ref_: ThreadRef) -> OpResult<HostMetadata> {
    let result = AssertUnwindSafe(create_db_read_transaction(ref_, move |transaction| {
        Box::pin(async move { read_host_metadata(transaction.db) })
    }))
    .catch_unwind()
    .await;
    match result {
        Ok(OpResult::Ok { value }) => OpResult::Ok { value },
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(payload) => storage_failure(&format!(
            "host metadata read failed: {}",
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
        newest_closed_protection: opts
            .params
            .as_ref()
            .and_then(|p| p.newest_closed_protection)
            .unwrap_or(base.newest_closed_protection),
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
pub struct StoredBandRow {
    pub band: Band,
    pub rendered_text: String,
    pub token_count: i64,
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
                if let Some(part) = entry.part {
                    let mut range = Map::new();
                    range.insert("fromStep".into(), Value::from(part.from_step));
                    range.insert("toStep".into(), Value::from(part.to_step));
                    obj.insert("part".into(), Value::Object(range));
                }
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
                    compact_point_upper_bound: None,
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
fn stored_view_config_json(
    lower_bound: f64,
    percentages: &ViewProfilePercentages,
    newest_closed_protection: f64,
) -> String {
    let mut config_obj = Map::new();
    config_obj.insert("lowerBound".into(), js_number_value(lower_bound));
    config_obj.insert("percentages".into(), percentages_json(percentages));
    config_obj.insert(
        "newestClosedProtection".into(),
        js_number_value(newest_closed_protection),
    );
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
        newest_closed_protection: Some(merged.newest_closed_protection),
    }
}

// ── prepared compact / install (LIM-61 / LIM-63A) ─────────────────

/// Source-state fingerprint for install validation (TS `PreparedCompactSourceState`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedCompactSourceState {
    pub max_event_order: i64,
    /// SHA-256 hex of relevant derivation rows.
    pub derivation_digest: String,
    /// SHA-256 hex of durable source messages/blocks used by bands + tail.
    pub tail_digest: String,
    /// SHA-256 hex of turn/chunk placement used by selection.
    pub structure_digest: String,
    pub installed_view_id: Option<String>,
    pub compact_point: i64,
}

/// In-memory prepared compact snapshot (TS `PreparedCompact`). No durable write.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedCompact {
    pub selection: SelectionResult,
    pub empty_chunk_ids: Vec<String>,
    pub max_event_order: i64,
    pub derivation_counts: indexmap::IndexMap<String, indexmap::IndexMap<String, i64>>,
    pub source_state: PreparedCompactSourceState,
    pub selected_source_turn_ids: Vec<String>,
    pub view_id: String,
    pub first_kept_message_id: Option<String>,
    pub profile_name: Option<String>,
    pub merged: ViewProfile,
    pub bands: Vec<StoredBandRow>,
    pub warnings: Vec<CompactWarning>,
    pub degraded: Vec<CompactDegradedEntry>,
    pub gaps: Vec<CompactGapEntry>,
    pub skipped_records: Vec<SkippedRecord>,
    /// Selection constraint this compact was prepared under; reused when
    /// install-time drift forces a fresh recompute.
    pub compact_point_upper_bound: Option<i64>,
}

/// TS `InstallPreparedOptions`.
#[derive(Debug, Clone, Default)]
pub struct InstallPreparedOptions {
    pub signal: Option<CompactAbortSignal>,
    pub created_at: Option<String>,
    /// When set, allow exactly one additional marker event after prepare.
    pub allowed_marker_idempotency_key: Option<String>,
    /// Atomic visibility-boundary advance installed with the prepared view.
    /// Must be >= compact point and >= current boundary (monotonic). When
    /// omitted, compact reset writes boundary = compactPoint (historical).
    pub visibility_boundary: Option<i64>,
    /// Expected current boundary at install time. When set, install refuses if
    /// the durable boundary drifted since prepare/preview.
    pub expected_previous_boundary: Option<i64>,
}

/// Resolve every turn id whose messages feed prepared band text.
pub fn selected_source_turn_ids_from_selection(
    db: &Db,
    selection: &SelectionResult,
) -> Vec<String> {
    let mut turn_ids = std::collections::BTreeSet::new();
    for entry in &selection.entries {
        if entry.subject_kind == ViewSubjectKind::Turn {
            turn_ids.insert(entry.subject_id.clone());
            continue;
        }
        let members = db
            .prepare("SELECT turn_id FROM chunk_member WHERE chunk_id = ? ORDER BY member_idx")
            .all(&[SqlParam::from(entry.subject_id.as_str())]);
        for m in members {
            if let Some(tid) = m.get("turn_id").and_then(|v| v.as_str()) {
                turn_ids.insert(tid.to_string());
            }
        }
    }
    turn_ids.into_iter().collect()
}

/// Build a source-state fingerprint for install validation.
pub fn read_prepared_source_state(
    db: &Db,
    compact_point: i64,
    selected_source_turn_ids: &[String],
    exclude_message_ids: Option<&std::collections::HashSet<String>>,
) -> PreparedCompactSourceState {
    let max_row = db
        .prepare("SELECT COALESCE(MAX(event_order), 0) AS m FROM event")
        .get()
        .expect("max event order");
    let max_event_order = max_row.get("m").and_then(|v| v.as_i64()).unwrap_or(0);
    let exclude = exclude_message_ids.cloned().unwrap_or_default();
    let selected_turns: Vec<String> = {
        let mut v = selected_source_turn_ids.to_vec();
        v.sort();
        v
    };
    const SELECTED_TURN_BATCH_SIZE: usize = 400;

    let derivation_rows = db.prepare(
        r#"SELECT subject_kind, subject_id, derivation_type, state, content, reason, source_version, metadata
       FROM derivation
       ORDER BY subject_kind, subject_id, derivation_type"#,
    ).all(&[]);
    let derivation_payload: Vec<Value> = derivation_rows
        .iter()
        .map(|r| {
            json!({
                "k": r.get("subject_kind").and_then(|v| v.as_str()).unwrap_or(""),
                "id": r.get("subject_id").and_then(|v| v.as_str()).unwrap_or(""),
                "t": r.get("derivation_type").and_then(|v| v.as_str()).unwrap_or(""),
                "s": r.get("state").and_then(|v| v.as_str()).unwrap_or(""),
                "c": r.get("content").cloned().unwrap_or(Value::Null),
                "r": r.get("reason").cloned().unwrap_or(Value::Null),
                "v": r.get("source_version").and_then(|v| v.as_i64()).unwrap_or(0),
                "m": r.get("metadata").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    let derivation_digest = sha256_hex(&js_json_stringify(&Value::Array(derivation_payload)));

    let mut message_rows: std::collections::HashMap<String, Map<String, Value>> =
        std::collections::HashMap::new();
    let mut block_rows: std::collections::HashMap<(String, i64), Map<String, Value>> =
        std::collections::HashMap::new();
    let mut collect = |where_clause: &str, bind: &[SqlParam]| {
        for row in db
            .prepare(&format!(
                r#"SELECT m.message_id, m.kind, m.source_event_order, m.turn_id, m.deleted_at, m.token_estimate
       FROM message m
       WHERE {where_clause}"#
            ))
            .all(bind)
        {
            let id = row
                .get("message_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            message_rows.insert(id, row);
        }
        for row in db
            .prepare(&format!(
                r#"SELECT mb.message_id, mb.block_index, mb.block_type, mb.content
       FROM message_block mb
       JOIN message m ON m.message_id = mb.message_id
       WHERE {where_clause}"#
            ))
            .all(bind)
        {
            let id = row
                .get("message_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let index = row.get("block_index").and_then(|v| v.as_i64()).unwrap_or(0);
            block_rows.insert((id, index), row);
        }
    };

    if selected_turns.is_empty() {
        collect(
            "m.source_event_order > ? OR m.turn_id IN (SELECT turn_id FROM chunk_member)",
            &[SqlParam::from(compact_point)],
        );
    } else {
        collect("m.source_event_order > ?", &[SqlParam::from(compact_point)]);
        for batch in selected_turns.chunks(SELECTED_TURN_BATCH_SIZE) {
            let placeholders = batch.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            let bind: Vec<SqlParam> = batch
                .iter()
                .map(|turn_id| SqlParam::from(turn_id.as_str()))
                .collect();
            collect(&format!("m.turn_id IN ({placeholders})"), &bind);
        }
    }

    // Restore the former single-query ordering after union/dedup so batching
    // cannot perturb the digest bytes.
    let mut source_messages: Vec<Map<String, Value>> = message_rows.into_values().collect();
    source_messages.sort_by(|a, b| {
        let ao = a
            .get("source_event_order")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let bo = b
            .get("source_event_order")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        ao.cmp(&bo).then_with(|| {
            a.get("message_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .cmp(b.get("message_id").and_then(|v| v.as_str()).unwrap_or(""))
        })
    });
    let message_order: std::collections::HashMap<String, i64> = source_messages
        .iter()
        .map(|row| {
            (
                row.get("message_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                row.get("source_event_order")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
            )
        })
        .collect();
    let mut source_blocks: Vec<Map<String, Value>> = block_rows.into_values().collect();
    source_blocks.sort_by(|a, b| {
        let aid = a.get("message_id").and_then(|v| v.as_str()).unwrap_or("");
        let bid = b.get("message_id").and_then(|v| v.as_str()).unwrap_or("");
        message_order
            .get(aid)
            .unwrap_or(&0)
            .cmp(message_order.get(bid).unwrap_or(&0))
            .then_with(|| aid.cmp(bid))
            .then_with(|| {
                a.get("block_index")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0)
                    .cmp(&b.get("block_index").and_then(|v| v.as_i64()).unwrap_or(0))
            })
    });

    let filtered_messages: Vec<Value> = source_messages
        .iter()
        .filter(|m| {
            m.get("message_id")
                .and_then(|v| v.as_str())
                .map(|id| !exclude.contains(id))
                .unwrap_or(true)
        })
        .map(|m| {
            json!({
                "id": m.get("message_id").and_then(|v| v.as_str()).unwrap_or(""),
                "kind": m.get("kind").and_then(|v| v.as_str()).unwrap_or(""),
                "order": m.get("source_event_order").and_then(|v| v.as_i64()).unwrap_or(0),
                "turn": m.get("turn_id").and_then(|v| v.as_str()).unwrap_or(""),
                "deleted": m.get("deleted_at").cloned().unwrap_or(Value::Null),
                "tokens": m.get("token_estimate").and_then(|v| v.as_i64()).unwrap_or(0),
            })
        })
        .collect();
    let filtered_blocks: Vec<Value> = source_blocks
        .iter()
        .filter(|b| {
            b.get("message_id")
                .and_then(|v| v.as_str())
                .map(|id| !exclude.contains(id))
                .unwrap_or(true)
        })
        .map(|b| {
            json!({
                "id": b.get("message_id").and_then(|v| v.as_str()).unwrap_or(""),
                "i": b.get("block_index").and_then(|v| v.as_i64()).unwrap_or(0),
                "t": b.get("block_type").and_then(|v| v.as_str()).unwrap_or(""),
                "c": b.get("content").and_then(|v| v.as_str()).unwrap_or(""),
            })
        })
        .collect();
    let tail_digest = sha256_hex(&js_json_stringify(&json!({
        "messages": filtered_messages,
        "blocks": filtered_blocks,
    })));

    let turn_rows = db
        .prepare(
            r#"SELECT turn_id, turn_order, status, opened_at_event_order, closed_at_event_order
       FROM turns ORDER BY turn_order"#,
        )
        .all(&[]);
    let chunk_rows = db
        .prepare("SELECT chunk_id, chunk_order, status FROM chunk ORDER BY chunk_order")
        .all(&[]);
    let member_rows = db
        .prepare(
            "SELECT chunk_id, turn_id, member_idx FROM chunk_member ORDER BY chunk_id, member_idx",
        )
        .all(&[]);
    let boundary = db
        .prepare("SELECT position FROM view_boundary WHERE thread_singleton = 1")
        .get();
    // Open-turn step edges are structure: they decide where the walk may split.
    // Closed turns are already fingerprinted by their close; only the open turn's
    // step indices can still move a split point between prepare and install.
    let open_turn_ids: Vec<String> = turn_rows
        .iter()
        .filter(|t| t.get("status").and_then(|v| v.as_str()) == Some("open"))
        .filter_map(|t| {
            t.get("turn_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .collect();
    let step_rows: Vec<Map<String, Value>> = if open_turn_ids.is_empty() {
        Vec::new()
    } else {
        let placeholders = open_turn_ids
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(", ");
        let params: Vec<SqlParam> = open_turn_ids
            .iter()
            .map(|id| SqlParam::from(id.as_str()))
            .collect();
        db.prepare(&format!(
            "SELECT message_id, step_index FROM message
             WHERE deleted_at IS NULL AND turn_id IN ({placeholders})
             ORDER BY source_event_order"
        ))
        .all(&params)
    };
    let structure_digest = sha256_hex(&js_json_stringify(&json!({
        "turns": turn_rows.iter().map(|t| json!({
            "id": t.get("turn_id").and_then(|v| v.as_str()).unwrap_or(""),
            "o": t.get("turn_order").and_then(|v| v.as_i64()).unwrap_or(0),
            "s": t.get("status").and_then(|v| v.as_str()).unwrap_or(""),
            "open": t.get("opened_at_event_order").and_then(|v| v.as_i64()).unwrap_or(0),
            "close": t.get("closed_at_event_order").cloned().unwrap_or(Value::Null),
        })).collect::<Vec<_>>(),
        "chunks": chunk_rows.iter().map(|c| json!({
            "id": c.get("chunk_id").and_then(|v| v.as_str()).unwrap_or(""),
            "o": c.get("chunk_order").and_then(|v| v.as_i64()).unwrap_or(0),
            "s": c.get("status").and_then(|v| v.as_str()).unwrap_or(""),
        })).collect::<Vec<_>>(),
        "members": member_rows.iter().map(|m| json!({
            "c": m.get("chunk_id").and_then(|v| v.as_str()).unwrap_or(""),
            "t": m.get("turn_id").and_then(|v| v.as_str()).unwrap_or(""),
            "i": m.get("member_idx").and_then(|v| v.as_i64()).unwrap_or(0),
        })).collect::<Vec<_>>(),
        "boundary": boundary.as_ref().and_then(|b| b.get("position")).and_then(|v| v.as_i64()).unwrap_or(0),
        "steps": step_rows.iter().map(|r| json!([
            r.get("message_id").and_then(|v| v.as_str()).unwrap_or(""),
            r.get("step_index").cloned().unwrap_or(Value::Null),
        ])).collect::<Vec<_>>(),
    })));

    let view = read_view_snapshot(db);
    PreparedCompactSourceState {
        max_event_order,
        derivation_digest,
        tail_digest,
        structure_digest,
        installed_view_id: view.map(|v| v.view_id),
        compact_point,
    }
}

/// Validate prepared source state against current durable state.
pub fn validate_prepared_source_state(
    db: &Db,
    prepared: &PreparedCompact,
    allowed_marker_idempotency_key: Option<&str>,
) -> Result<(), String> {
    let selected = if prepared.selected_source_turn_ids.is_empty() {
        selected_source_turn_ids_from_selection(db, &prepared.selection)
    } else {
        prepared.selected_source_turn_ids.clone()
    };
    let current =
        read_prepared_source_state(db, prepared.source_state.compact_point, &selected, None);
    let prev = &prepared.source_state;

    if current.installed_view_id != prev.installed_view_id {
        return Err("serving view changed since prepare".into());
    }
    if current.structure_digest != prev.structure_digest {
        return Err("turn/chunk structure changed since prepare".into());
    }
    if current.derivation_digest != prev.derivation_digest {
        return Err("derivation content/state changed since prepare".into());
    }

    let Some(marker_key) = allowed_marker_idempotency_key else {
        if current.max_event_order != prev.max_event_order {
            return Err(format!(
                "event order advanced {}→{} since prepare",
                prev.max_event_order, current.max_event_order
            ));
        }
        if current.tail_digest != prev.tail_digest {
            return Err("tail message/block content changed since prepare".into());
        }
        return Ok(());
    };

    if current.max_event_order < prev.max_event_order {
        return Err("event order regressed since prepare".into());
    }
    if current.max_event_order == prev.max_event_order {
        if current.tail_digest != prev.tail_digest {
            return Err(
                "source message/block content changed since prepare without event advance".into(),
            );
        }
        return Ok(());
    }
    if current.max_event_order != prev.max_event_order + 1 {
        return Err(format!(
            "expected at most one event advance for marker, got {}→{}",
            prev.max_event_order, current.max_event_order
        ));
    }
    let new_event = db
        .prepare("SELECT event_order, event_kind, idempotency_key FROM event WHERE event_order = ?")
        .get_params(&[SqlParam::from(current.max_event_order)]);
    let Some(new_event) = new_event else {
        return Err("new event row missing after order advance".into());
    };
    let event_kind = new_event
        .get("event_kind")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if event_kind != "compact_continuation_marker" {
        return Err(format!(
            "expected compact_continuation_marker, got {event_kind}"
        ));
    }
    let idem = new_event
        .get("idempotency_key")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if idem != marker_key {
        return Err(format!(
            "marker idempotency key mismatch (expected {marker_key})"
        ));
    }
    let marker_message = db
        .prepare(
            r#"SELECT message_id FROM message
       WHERE source_event_order = ? AND kind = 'compact_continuation_marker'"#,
        )
        .get_params(&[SqlParam::from(current.max_event_order)]);
    let Some(marker_message) = marker_message else {
        return Err("marker message row missing for advanced event".into());
    };
    let marker_id = marker_message
        .get("message_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut exclude = std::collections::HashSet::new();
    exclude.insert(marker_id);
    let without_marker = read_prepared_source_state(
        db,
        prepared.source_state.compact_point,
        &selected,
        Some(&exclude),
    );
    if without_marker.tail_digest != prev.tail_digest {
        return Err(
            "source message/block content changed beyond the expected continuation marker".into(),
        );
    }
    Ok(())
}

fn build_prepared_from_arrangement(
    db: &Db,
    selection: SelectionResult,
    empty_chunk_ids: Vec<String>,
    max_event_order: i64,
    derivation_counts: indexmap::IndexMap<String, indexmap::IndexMap<String, i64>>,
    skipped_records: Vec<SkippedRecord>,
    view_id: String,
    first_kept_message_id: Option<String>,
    profile_name: Option<String>,
    merged: ViewProfile,
    compact_point_upper_bound: Option<i64>,
) -> PreparedCompact {
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

    let selected_source_turn_ids = selected_source_turn_ids_from_selection(db, &selection);
    let source_state =
        read_prepared_source_state(db, selection.compact_point, &selected_source_turn_ids, None);
    let gaps = gap_notes(&selection.entries, &selection.skipped);
    let degraded = selection
        .entries
        .iter()
        .filter(|entry| entry.degraded)
        .map(|entry| CompactDegradedEntry {
            band: entry.band,
            subject_id: entry.subject_id.clone(),
            used_derivation: entry.derivation_used.clone(),
        })
        .collect();

    PreparedCompact {
        selection,
        empty_chunk_ids,
        max_event_order,
        derivation_counts,
        source_state,
        selected_source_turn_ids,
        view_id,
        first_kept_message_id,
        profile_name,
        merged,
        bands,
        warnings,
        degraded,
        gaps,
        skipped_records,
        compact_point_upper_bound,
    }
}

/// TS `assemblePreparedCompact`: compute the arrangement against the open
/// database and build the prepared snapshot. No write, no log; the same
/// assembly serves `prepare_compact` and the install-time drift recompute.
fn assemble_prepared_compact(
    db: &Db,
    file_path: &str,
    merged: &ViewProfile,
    profile_name: Option<String>,
    signal: Option<CompactAbortSignal>,
    compact_point_upper_bound: Option<i64>,
) -> OpResult<PreparedCompact> {
    let thread_id = read_thread_metadata(db).thread_id;
    let transaction = DbReadTransaction {
        db,
        file_path: file_path.to_string(),
        thread_id,
    };
    let computed = compute_arrangement(
        db,
        &transaction,
        merged,
        &ComputeArrangementOpts {
            signal,
            include_chunk_materials: true,
            compact_point_upper_bound,
        },
    );
    let OpResult::Ok { value: computed } = computed else {
        return match computed {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };
    OpResult::Ok {
        value: build_prepared_from_arrangement(
            db,
            computed.selection,
            computed.source_state.empty_chunk_ids,
            computed.source_state.max_event_order,
            computed.source_state.derivation_counts,
            computed.source_state.skipped_records,
            computed.view_id,
            computed.first_kept_message_id,
            profile_name,
            merged.clone(),
            compact_point_upper_bound,
        ),
    }
}

/// TS `logPreparedDiagnostics`: the prepared snapshot's warnings and skipped
/// canonical records, written to the thread log.
fn log_prepared_diagnostics(db: &Db, file_path: &str, prepared: &PreparedCompact) {
    let thread_id = read_thread_metadata(db).thread_id;
    let transaction = DbReadTransaction {
        db,
        file_path: file_path.to_string(),
        thread_id,
    };
    for warning in &prepared.warnings {
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
    for skipped in &prepared.skipped_records {
        let (subject_id, reason) = match skipped {
            SkippedRecord::OrphanedMessage {
                message_id, reason, ..
            } => (message_id.clone(), reason.clone()),
            SkippedRecord::DanglingChunkMember {
                chunk_id, reason, ..
            } => (chunk_id.clone(), reason.clone()),
        };
        write_log(
            DbTransaction::Read(&transaction),
            &LogEntry {
                level: LogLevel::Warning,
                message: "compact skipped an unplaceable canonical record".to_string(),
                derivation_type: None,
                subject_id: Some(subject_id),
                reason: Some(reason),
                floor_used: None,
            },
        );
    }
}

/// Carries a failed in-transaction recompute out through the replace's
/// rollback (TS `RecomputeFailedError`).
struct RecomputeFailed(ErrorResult);

/// The snapshot rows one prepared compact installs.
fn replace_input_for(
    prepared: &PreparedCompact,
    created_at: &str,
    proposed_boundary: Option<i64>,
) -> ViewReplaceInput {
    let placeholder_source = StoredViewSourceState {
        max_event_order: prepared.max_event_order,
        derivation_counts: prepared.derivation_counts.clone(),
    };
    ViewReplaceInput {
        view_id: prepared.view_id.clone(),
        created_at: created_at.to_string(),
        compact_point: prepared.selection.compact_point,
        covered_from: prepared.selection.covered_from,
        profile_name: prepared.profile_name.clone(),
        config_json: stored_view_config_json(
            prepared.merged.lower_bound,
            &prepared.merged.percentages,
            prepared.merged.newest_closed_protection,
        ),
        arrangement_json: js_json_stringify(&arrangement_json_value(&prepared.selection.entries)),
        gaps_json: js_json_stringify(&gaps_json_value(
            &prepared.selection.entries,
            &prepared.selection.skipped,
        )),
        source_state_json: js_json_stringify(
            &serde_json::to_value(&placeholder_source).unwrap_or(Value::Null),
        ),
        serves_parts: prepared
            .selection
            .entries
            .iter()
            .any(|entry| entry.part.is_some()),
        bands: prepared
            .bands
            .iter()
            .map(|b| ViewReplaceBand {
                band: b.band,
                rendered_text: b.rendered_text.clone(),
                token_count: b.token_count,
            })
            .collect(),
        visibility_boundary: proposed_boundary,
    }
}

/// Assemble a compact without writing the serving view (TS `prepareCompact`).
pub async fn prepare_compact(ref_: ThreadRef, opts: CompactOpts) -> OpResult<PreparedCompact> {
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

    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let prepared = assemble_prepared_compact(
            &db,
            &file_path,
            &merged,
            profile_name,
            opts.signal.clone(),
            opts.compact_point_upper_bound,
        );
        let OpResult::Ok { value: prepared } = prepared else {
            return match prepared {
                OpResult::Err { error } => OpResult::Err { error },
                OpResult::Ok { .. } => unreachable!(),
            };
        };
        log_prepared_diagnostics(&db, &file_path, &prepared);
        OpResult::Ok { value: prepared }
    }));

    db.close();

    match outcome {
        Ok(result) => result,
        Err(payload) => storage_failure(&format!(
            "view prepareCompact failed: {}",
            panic_detail(payload)
        )),
    }
}

/// Atomically install a previously prepared compact snapshot (TS `installPreparedCompact`).
pub async fn install_prepared_compact(
    ref_: ThreadRef,
    prepared: PreparedCompact,
    opts: InstallPreparedOptions,
) -> OpResult<CompactReceipt> {
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

    let opened = open_thread_database(&file_path);
    let OpResult::Ok { value: db } = opened else {
        return match opened {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };

    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
        fire_view_injection(ViewInjectionPoint::CompactWrite);

        if compact_stopped(opts.signal.as_ref()) {
            return caller_error(
                CallerErrorCode::CompactStopped,
                DIAG_COMPACT_STOPPED_BEFORE_SNAPSHOT_WRITE.to_string(),
            );
        }

        let created_at = opts.created_at.clone().unwrap_or_else(|| {
            system_time_to_iso(
                resolve_instance_config()
                    .map(|c| (c.clock)())
                    .unwrap_or_else(SystemTime::now),
            )
        });
        let proposed_boundary = opts.visibility_boundary;
        let expected_previous_boundary = opts.expected_previous_boundary;
        // Drift between prepare and install — a new serving view, appended
        // events, changed turn/chunk structure, finished derivations, edited
        // source content — never refuses the install and never installs the
        // stale snapshot: the compact is reassembled against durable state
        // inside the install transaction and that is written instead (TS
        // `preparedStateDrift` → `assemblePreparedCompact`). The
        // compact-continuation path validates its own marker-tolerant
        // fingerprint and is unchanged here.
        let mut recomputed: Option<PreparedCompact> = None;
        let mut before = |db: &Db, input: &mut ViewReplaceInput| {
            // Inside BEGIN IMMEDIATE — atomic with replace (TS install seam).
            // Background derivation or re-derivation does not invalidate this
            // coherent prepared snapshot. Later compacts can use newer material.
            fire_view_injection_with_db(ViewInjectionPoint::CompactInstallBeforeValidate, db);
            // A pinned visibility boundary that has since moved is drift like
            // any other (TS `preparedStateDrift`): recompute against the current
            // boundary, never refuse. A proposal behind the current boundary or
            // the compact point is not an error either — the snapshot write
            // resolves it forward to max(proposed, current, compact point).
            let boundary_moved = matches!(
                expected_previous_boundary,
                Some(expected) if read_boundary_position(db) != expected
            );
            if boundary_moved
                || (opts.allowed_marker_idempotency_key.is_none()
                    && validate_prepared_source_state(db, &prepared, None).is_err())
            {
                let fresh = assemble_prepared_compact(
                    db,
                    &file_path,
                    &prepared.merged,
                    prepared.profile_name.clone(),
                    opts.signal.clone(),
                    prepared.compact_point_upper_bound,
                );
                match fresh {
                    OpResult::Ok { value } => {
                        *input = replace_input_for(&value, &created_at, proposed_boundary);
                        recomputed = Some(value);
                    }
                    OpResult::Err { error } => std::panic::panic_any(RecomputeFailed(error)),
                }
            }
            let active = recomputed.as_ref().unwrap_or(&prepared);
            let _ = turns::drop_unreadable_chunks(db, &active.empty_chunk_ids);
        };

        let install_result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            replace_view_snapshot_with(
                &db,
                &replace_input_for(&prepared, &created_at, proposed_boundary),
                Some(&mut before),
            )
        }));

        match install_result {
            Ok(()) => {}
            Err(payload) => {
                // A recompute that could not produce a view (an aborted compact,
                // a read failure) surfaces as itself, with the prior view still
                // serving.
                if let Some(failed) = payload.downcast_ref::<RecomputeFailed>() {
                    return OpResult::Err {
                        error: failed.0.clone(),
                    };
                }
                let detail = panic_detail(payload);
                if let Some(reason) = detail.strip_prefix("stale_prepared_compact:") {
                    return OpResult::Err {
                        error: ErrorResult {
                            error_class: ErrorClass::CallerError,
                            code: ErrorCode::StalePreparedCompact,
                            reason: format!("prepared compact is stale: {reason}"),
                            event_index: None,
                        },
                    };
                }
                panic!("{detail}");
            }
        }
        let installed = match recomputed {
            Some(fresh) => {
                log_prepared_diagnostics(&db, &file_path, &fresh);
                fresh
            }
            None => prepared,
        };

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
            let stored = installed.bands.iter().find(|row| row.band == band);
            let stats = CompactBandStats {
                entries: entries_by_band(&installed.selection.entries, band).len() as i64,
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
        let tail_tokens = tail_token_sum(&db, installed.selection.compact_point);
        let rendered_bands = build_rendered_bands(&installed.selection.entries, &installed.bands);
        OpResult::Ok {
            value: CompactReceipt {
                view_id: installed.view_id.clone(),
                profile: installed.profile_name.clone(),
                config: compact_receipt_config(&installed.merged),
                bands: band_report.clone(),
                tail_tokens,
                total_tokens: band_report.brief.tokens
                    + band_report.detailed.tokens
                    + band_report.smooth.tokens
                    + tail_tokens,
                covered_from: installed.selection.covered_from,
                compact_point: installed.selection.compact_point,
                degraded: installed.degraded.clone(),
                gaps: installed.gaps.clone(),
                warnings: Some(installed.warnings.clone()),
                skipped_records: installed.skipped_records.clone(),
                rendered_bands,
                first_kept_message_id: installed.first_kept_message_id.clone(),
                parts: installed.selection.parts.clone(),
                split_point: installed.selection.split_point.clone(),
                settled: installed.selection.settled.clone(),
                protected_turn: installed.selection.protected_turn.clone(),
            },
        }
    }));

    db.close();

    match outcome {
        Ok(result) => result,
        Err(payload) => {
            let detail = panic_detail(payload);
            if let Some(reason) = detail.strip_prefix("stale_prepared_compact:") {
                return OpResult::Err {
                    error: ErrorResult {
                        error_class: ErrorClass::CallerError,
                        code: ErrorCode::StalePreparedCompact,
                        reason: format!("prepared compact is stale: {reason}"),
                        event_index: None,
                    },
                };
            }
            storage_failure(&format!("view installPreparedCompact failed: {detail}"))
        }
    }
}

/// Read-only protected visibility-boundary preview. Never mutates durable state.
/// Protected results are accounted at full size; only older unprotected
/// tool_result rows are eligible; boundary never moves backward and stays
/// strictly before the earliest protected result event.
pub async fn preview_protected_boundary(
    ref_: ThreadRef,
    protected_tool_call_ids: Vec<String>,
    opts: ProtectedBoundaryOpts,
) -> OpResult<ProtectedBoundaryPreview> {
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
    let read = AssertUnwindSafe(create_db_read_transaction(
        ThreadRef::file_path(file_path.clone()),
        move |transaction| {
            let ids = protected_tool_call_ids.clone();
            let opts = opts.clone();
            Box::pin(
                async move { preview_protected_visibility_boundary(transaction.db, &ids, &opts) },
            )
        },
    ))
    .catch_unwind()
    .await;
    match read {
        Ok(result) => result,
        Err(payload) => storage_failure(&format!(
            "view previewProtectedBoundary failed: {}",
            panic_detail(payload)
        )),
    }
}

/// TS `compact` — PARTIAL (Wave 5 chunk-compact-recovery); full body Phase 2.
pub async fn compact(ref_: ThreadRef, opts: CompactOpts) -> OpResult<CompactReceipt> {
    let prepared = prepare_compact(ref_.clone(), opts.clone()).await;
    let OpResult::Ok { value: prepared } = prepared else {
        return match prepared {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };
    let install_opts = InstallPreparedOptions {
        visibility_boundary: None,
        expected_previous_boundary: None,
        signal: opts.signal,
        created_at: None,
        allowed_marker_idempotency_key: None,
    };
    install_prepared_compact(ref_, prepared, install_opts).await
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
    BUILT_IN_PROFILES, DEFAULT_COMPACT_THRESHOLD, DEFAULT_NEWEST_CLOSED_PROTECTION,
    DEFAULT_VISIBILITY, resolve_view_config,
};
