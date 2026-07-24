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

use std::sync::LazyLock;

use crate::shared_tech::derivation::DerivationReportEntry;
use crate::shared_tech::errors::{ErrorCode, OpResult};
use crate::shared_tech::persist::{DbReadTransaction, DbWriteTransaction};
use crate::shared_tech::storage::Db;
use crate::shared_tech::view::{
    Band, CompactReceipt, CompactRenderedBand, LlmRequestContext, PreviewCompactOutcome,
    PruneReceipt, ResolvedViewConfig, SessionThreadView, StoredView, ViewCompactParams,
    ViewProfile, ViewStatus, ViewStatusDerivation,
};
use crate::threads::ThreadRef;

use internal::profiles::default_resolved_view_config;
use internal::select::ArrangementEntry;

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
/// (no duplicate AbortSignal). Phase 2 must audit live cancellation / getter
/// semantics (re-read `.aborted` each call) before behavior certification —
/// see PORT_STATUS abort-signal ledger note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompactAbortSignal {
    pub aborted: bool,
}

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
    todo!("phase 2")
}

fn thread_not_found<T>(_file_path: &str) -> OpResult<T> {
    todo!("phase 2")
}

fn detail(_cause: &dyn std::fmt::Display) -> String {
    todo!("phase 2")
}

// ── model context ────────────────────────────────────────────────

/// TS `getLlmRequestContext` — PARTIAL stub (Wave 1); full body Phase 2.
pub async fn get_llm_request_context(_ref: ThreadRef) -> OpResult<LlmRequestContext> {
    todo!("phase 2")
}

/// SessionManager-friendly materialization from canonical record data.
pub async fn get_session_thread_view(_ref: ThreadRef) -> OpResult<SessionThreadView> {
    todo!("phase 2")
}

// ── status ───────────────────────────────────────────────────────

/// Derivation counts bucket from one report entry. Ready derivations are healthy
/// and not an operational situation.
fn bucket_derivation(_entries: &[DerivationReportEntry], _counts: &mut ViewStatusDerivation) {
    todo!("phase 2")
}

/// TS `status` — PARTIAL (Wave 4 messages-read DD-6 snapshot; full body later).
pub async fn status(_ref: ThreadRef) -> OpResult<ViewStatus> {
    todo!("phase 2")
}

// ── describe ─────────────────────────────────────────────────────

/// The stored active view row, exposed read-only so inspect never reads
/// thread-view tables directly.
pub async fn describe(_ref: ThreadRef) -> OpResult<Option<StoredView>> {
    todo!("phase 2")
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

fn prune_caller_error<T>(_code: PruneCallerErrorCode, _reason: String) -> OpResult<T> {
    todo!("phase 2")
}

/// Explicit prune input rejects non-integers; default path may return fractional
/// configured `visibility.targetTokens` (no silent round/truncate).
fn validate_prune_target(_target_tokens: Option<f64>) -> OpResult<f64> {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolResultZoneRow {
    source_event_order: i64,
    token_estimate: i64,
}

fn read_zone_tool_results(_db: &Db, _effective_start: i64) -> Vec<ToolResultZoneRow> {
    todo!("phase 2")
}

fn tokens_behind_boundary(_db: &Db, _boundary: i64, _compact_point: i64) -> i64 {
    todo!("phase 2")
}

fn count_pruned_tool_results(
    _db: &Db,
    _previous_boundary: i64,
    _new_boundary: i64,
    _compact_point: i64,
) -> i64 {
    todo!("phase 2")
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

fn build_prune_receipt(_db: &Db, _input: &BuildPruneReceiptInput) -> PruneReceipt {
    todo!("phase 2")
}

fn compute_prune_boundary(
    _rows: &[ToolResultZoneRow],
    _target_tokens: f64,
    _previous_boundary: i64,
) -> i64 {
    todo!("phase 2")
}

fn prune_in_transaction(_transaction: &DbWriteTransaction, _target_tokens: f64) -> PruneReceipt {
    todo!("phase 2")
}

/// Advance the visibility boundary forward so older tool results in the
/// visibility zone render short.
pub async fn prune(_ref: ThreadRef, _params: Option<PruneParams>) -> OpResult<PruneReceipt> {
    todo!("phase 2")
}

// ── compact ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallerErrorCode {
    UnknownProfile,
    InvalidViewConfig,
    CompactStopped,
}

fn caller_error<T>(_code: CallerErrorCode, _reason: String) -> OpResult<T> {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq)]
struct ResolvedCompactCall {
    merged: ViewProfile,
    profile_name: Option<String>,
}

fn resolve_compact_call(_opts: &CompactOpts) -> OpResult<ResolvedCompactCall> {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq)]
struct StoredBandRow {
    band: Band,
    rendered_text: String,
    token_count: i64,
}

fn build_rendered_bands(
    _selection_entries: &[ArrangementEntry],
    _bands: &[StoredBandRow],
) -> Vec<CompactRenderedBand> {
    todo!("phase 2")
}

/// Preview helper for wouldProduceBands.
fn selection_would_write_snapshot(
    _transaction: &DbReadTransaction,
    _compact_point: i64,
    _entries: &[ArrangementEntry],
) -> bool {
    todo!("phase 2")
}

/// TS nested `entriesByBand` inside `compact`.
fn entries_by_band(_entries: &[ArrangementEntry], _band: Band) -> Vec<ArrangementEntry> {
    todo!("phase 2")
}

/// Read-only compact preflight: same selection path as compact, no snapshot write.
pub async fn preview_compact(
    _ref: ThreadRef,
    _opts: CompactOpts,
) -> OpResult<PreviewCompactOutcome> {
    todo!("phase 2")
}

/// TS `compact` — PARTIAL (Wave 5 chunk-compact-recovery); full body Phase 2.
pub async fn compact(_ref: ThreadRef, _opts: CompactOpts) -> OpResult<CompactReceipt> {
    todo!("phase 2")
}

// ── materialize ──────────────────────────────────────────────────

/// PI session-file materialization: run the serving assembly internally, hand
/// the same entry array to the JSONL writer, return the written path.
pub async fn materialize(_ref: ThreadRef, _opts: MaterializeOpts) -> OpResult<MaterializeResult> {
    todo!("phase 2")
}

// ── initLhc substrate ────────────────────────────────────────────
// Matching TS index.ts bottom export.
pub use internal::profiles::{
    BUILT_IN_PROFILES, DEFAULT_COMPACT_THRESHOLD, DEFAULT_VISIBILITY, resolve_view_config,
};
