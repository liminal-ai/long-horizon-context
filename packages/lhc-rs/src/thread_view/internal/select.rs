//! Ported from packages/lhc/src/thread-view/internal/select.ts.
//!
//! Band selection: compact point, smooth/detailed/brief fills, unchunked turns,
//! the coverage edge (covered_from), and
//! canonical-corruption detection. Two halves, deliberately split:
//!
//!   - readSelectionInputs: the record/derivation reads, with the corruption check
//!     in the reads, before any transaction opens. A refusal here means nothing
//!     was written, so the prior view is trivially intact. Never moved inside
//!     the transaction.
//!   - selectArrangement: a pure function over those inputs. No DB handle, no
//!     clock, no inference: same inputs, same arrangement.
//!
//! Tie-breakers: inclusion thresholds are <=; walks are newest-first everywhere;
//! chunk coverage is decided by the chunk's newest
//! member turn. Entry costs are the tokens of the rendered entry text itself,
//! so the budgeted tokens are the stored tokens — no second estimate.

use std::collections::HashMap;
use std::sync::LazyLock;

use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};

use super::render::{CompactChunkMaterialSnapshot, DerivationLookup, DerivationSnapshot};
use crate::shared_tech::storage::Db;
use crate::shared_tech::view::{Band, ViewProfilePercentages, ViewSubjectKind};

/// TS SQL — exact source bytes.
pub(crate) const SQL_DERIVATION_ROWS: &str =
    "SELECT subject_id, derivation_type, state, content, reason FROM derivation
       WHERE subject_kind IN ('turn', 'chunk')";

pub(crate) const SQL_MAX_EVENT_ORDER: &str = "SELECT COALESCE(MAX(event_order), 0) AS m FROM event";

pub(crate) const SQL_DERIVATION_COUNTS: &str =
    "SELECT derivation_type, state, COUNT(*) AS n FROM derivation GROUP BY derivation_type, state";

/// Canonical source state needed to identify or read the compacted span is
/// damaged: compact refuses with state_corruption. Derived-material damage never
/// raises this; it degrades through the ladders instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanonicalCorruptionCode {
    TurnStateCorrupt,
    SourceDamaged,
}

impl CanonicalCorruptionCode {
    pub fn as_str(self) -> &'static str {
        match self {
            CanonicalCorruptionCode::TurnStateCorrupt => "turn_state_corrupt",
            CanonicalCorruptionCode::SourceDamaged => "source_damaged",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalCorruptionError {
    pub code: CanonicalCorruptionCode,
    pub reason: String,
}

impl CanonicalCorruptionError {
    pub fn new(code: CanonicalCorruptionCode, reason: impl Into<String>) -> Self {
        Self {
            code,
            reason: reason.into(),
        }
    }
}

impl std::fmt::Display for CanonicalCorruptionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.reason)
    }
}

impl std::error::Error for CanonicalCorruptionError {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionMessage {
    pub message_id: String,
    /// source_event_order
    pub order: i64,
    pub kind: String,
    pub token_estimate: i64,
    pub turn_id: String,
    /// excerpt/note line (render.excerptLine)
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectionTurnStatus {
    Open,
    Closed,
}

impl SelectionTurnStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SelectionTurnStatus::Open => "open",
            SelectionTurnStatus::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionTurn {
    pub turn_id: String,
    pub turn_order: i64,
    pub status: SelectionTurnStatus,
    pub opened_at: i64,
    pub closed_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectionChunkStatus {
    Open,
    Closed,
}

impl SelectionChunkStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SelectionChunkStatus::Open => "open",
            SelectionChunkStatus::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionChunk {
    pub chunk_id: String,
    pub chunk_order: i64,
    pub status: SelectionChunkStatus,
    /// member order
    pub member_turn_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SelectionInputs {
    /// live only, ascending order
    pub messages: Vec<SelectionMessage>,
    /// ascending turnOrder
    pub turns: Vec<SelectionTurn>,
    /// ascending chunkOrder
    pub chunks: Vec<SelectionChunk>,
    /// `${subjectId}/${derivationType}` (turn/chunk subjects) — TS `Map` → IndexMap.
    pub derivations: IndexMap<String, DerivationSnapshot>,
    pub compact_chunk_materials: Option<IndexMap<String, CompactChunkMaterialSnapshot>>,
    pub max_event_order: i64,
    /// derivation type → state → count — TS nested `Record`/`Map` → IndexMap.
    pub derivation_counts: IndexMap<String, IndexMap<String, i64>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangementEntry {
    pub band: Band,
    pub subject_kind: ViewSubjectKind,
    pub subject_id: String,
    pub derivation_used: String,
    pub degraded: bool,
    pub gap: bool,
    /// gap entries
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// oldest event order the entry represents (notes included)
    pub start_order: i64,
    /// rendered entry text (the band stores this verbatim)
    pub text: String,
    pub tokens: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SelectionResult {
    pub compact_point: i64,
    pub covered_from: i64,
    /// Gradient order (brief → detailed → smooth), oldest-first within band —
    /// the order the bands render and the arrangement persists.
    pub entries: Vec<ArrangementEntry>,
}

/// ── reads (corruption check lives here, pre-transaction) ─────────

pub fn read_selection_inputs(_db: &Db) -> Result<SelectionInputs, CanonicalCorruptionError> {
    todo!("phase 2")
}

/// ── the pure walk ─────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionConfig {
    pub lower_bound: i64,
    pub percentages: ViewProfilePercentages,
}

/// Message kinds that can anchor a host session rebuild past the compact point.
/// Excludes runtime_note (and any future non-mappable kinds). Shared with the
/// first-kept-message lookup in compact-compute so "empty tail" means the same
/// thing in both places.
pub const PI_MAPPABLE_MESSAGE_KINDS: [&str; 7] = [
    "user_prompt",
    "assistant_text",
    "assistant_thinking",
    "tool_call",
    "tool_result",
    "model_change",
    "thinking_level_change",
];

/// TS `PI_MAPPABLE_KIND_SET` — insertion-ordered [`IndexSet`] collected directly
/// from [`PI_MAPPABLE_MESSAGE_KINDS`] (TS `Set` preserves declared order).
pub(crate) static PI_MAPPABLE_KIND_SET: LazyLock<IndexSet<&'static str>> =
    LazyLock::new(|| PI_MAPPABLE_MESSAGE_KINDS.into_iter().collect());

/// TS `band: "detailed" | "brief"` accepted by `buildChunkEntry`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChunkEntryBand {
    Detailed,
    Brief,
}

/// TS `chunkMaterial` derivationType: `"chunk_summary_detailed" | "chunk_summary_brief"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChunkMaterialDerivation {
    ChunkSummaryDetailed,
    ChunkSummaryBrief,
}

impl ChunkMaterialDerivation {
    fn as_str(self) -> &'static str {
        match self {
            ChunkMaterialDerivation::ChunkSummaryDetailed => "chunk_summary_detailed",
            ChunkMaterialDerivation::ChunkSummaryBrief => "chunk_summary_brief",
        }
    }
}

// ── canonical-corruption / coverage-gap diagnostics (select.ts) ───

/// Shared `.join(", ")` separator (open-turn ids).
pub(crate) const DIAG_LIST_JOIN_COMMA_SPACE: &str = ", ";

/// `canonical turn state corrupt: ${n} open turns (${ids}); the compacted span cannot be identified`
pub(crate) const DIAG_CANONICAL_TURN_STATE_CORRUPT_OPEN_TURNS_PREFIX: &str =
    "canonical turn state corrupt: ";
pub(crate) const DIAG_CANONICAL_TURN_STATE_CORRUPT_OPEN_TURNS_MID: &str = " open turns (";
pub(crate) const DIAG_CANONICAL_TURN_STATE_CORRUPT_OPEN_TURNS_SUFFIX: &str =
    "); the compacted span cannot be identified";
/// `canonical turn state corrupt: closed turn ${id} carries no close boundary`
pub(crate) const DIAG_CANONICAL_CLOSED_TURN_NO_BOUNDARY_PREFIX: &str =
    "canonical turn state corrupt: closed turn ";
pub(crate) const DIAG_CANONICAL_CLOSED_TURN_NO_BOUNDARY_SUFFIX: &str = " carries no close boundary";
/// `canonical record corrupt: message ${id} references missing turn ${turnId}`
pub(crate) const DIAG_CANONICAL_MESSAGE_MISSING_TURN_PREFIX: &str =
    "canonical record corrupt: message ";
pub(crate) const DIAG_CANONICAL_MESSAGE_MISSING_TURN_MID: &str = " references missing turn ";
/// `canonical record corrupt: chunk ${id} membership references missing turn ${turnId}`
pub(crate) const DIAG_CANONICAL_CHUNK_MISSING_TURN_PREFIX: &str =
    "canonical record corrupt: chunk ";
pub(crate) const DIAG_CANONICAL_CHUNK_MISSING_TURN_MID: &str =
    " membership references missing turn ";
/// `detailed_turn_compression ${state}` (coverage degraded reason)
pub(crate) const DIAG_COVERAGE_DETAILED_TURN_COMPRESSION_PREFIX: &str =
    "detailed_turn_compression ";
/// `closed turn before compact point was not represented by selected bands (detailed_turn_compression: ${…}, pre_detailed_assembly: ${…})`
pub(crate) const DIAG_COVERAGE_GAP_REASON_PREFIX: &str = "closed turn before compact point was not represented by selected bands (detailed_turn_compression: ";
pub(crate) const DIAG_COVERAGE_GAP_REASON_MID: &str = ", pre_detailed_assembly: ";
pub(crate) const DIAG_COVERAGE_GAP_REASON_CLOSE: &str = ")";

fn straddling_turn_stays_in_full(
    _full_side_tokens: i64,
    _turn_tokens: i64,
    _eviction_would_empty_full: bool,
) -> bool {
    todo!("phase 2")
}

/// TS nested `lookup` inside `selectArrangement`.
fn lookup(
    _derivations: &IndexMap<String, DerivationSnapshot>,
    _subject_id: &str,
    _derivation_type: &str,
) -> Option<DerivationSnapshot> {
    todo!("phase 2")
}

/// TS nested `chunkMaterial` inside `selectArrangement`.
fn chunk_material(
    _inputs: &SelectionInputs,
    _chunk_id: &str,
    _derivation_type: ChunkMaterialDerivation,
) -> Option<CompactChunkMaterialSnapshot> {
    todo!("phase 2")
}

/// TS nested `budget` inside `selectArrangement`.
fn budget(_lower_bound: i64, _share: i64) -> f64 {
    todo!("phase 2")
}

/// TS nested `previousClose` inside `snapCompactPoint`.
fn previous_close(_closed_turns: &[SelectionTurn], _turn: &SelectionTurn) -> i64 {
    todo!("phase 2")
}

/// TS nested `byRecordOrder` inside `selectArrangement`.
fn by_record_order(_a: &ArrangementEntry, _b: &ArrangementEntry) -> std::cmp::Ordering {
    todo!("phase 2")
}

fn snap_compact_point(
    _oldest_taken: &SelectionMessage,
    _turns_by_id: &HashMap<String, SelectionTurn>,
    _closed_turns: &[SelectionTurn],
    _messages: &[SelectionMessage],
    _messages_by_turn: &HashMap<String, Vec<SelectionMessage>>,
    _full_budget: f64,
) -> Result<i64, CanonicalCorruptionError> {
    todo!("phase 2")
}

fn turn_start_order(
    _turn: &SelectionTurn,
    _messages_by_turn: &HashMap<String, Vec<SelectionMessage>>,
) -> i64 {
    todo!("phase 2")
}

fn build_turn_entry(
    _turn: &SelectionTurn,
    _messages_by_turn: &HashMap<String, Vec<SelectionMessage>>,
    _lookup: &DerivationLookup,
) -> ArrangementEntry {
    todo!("phase 2")
}

fn build_chunk_entry(
    _chunk: &SelectionChunk,
    _band: ChunkEntryBand,
    _compact_point: i64,
    _turns_by_id: &HashMap<String, SelectionTurn>,
    _lookup: &DerivationLookup,
    _material: Option<&CompactChunkMaterialSnapshot>,
) -> ArrangementEntry {
    todo!("phase 2")
}

struct FillBandResult<T> {
    included: Vec<ArrangementEntry>,
    rest: Vec<T>,
}

fn fill_band<T, F>(_candidates: &[T], _band_budget: f64, _build: F) -> FillBandResult<T>
where
    T: Clone,
    F: Fn(&T) -> ArrangementEntry,
{
    todo!("phase 2")
}

fn ready_content(_derivation: Option<&DerivationSnapshot>) -> Option<String> {
    todo!("phase 2")
}

fn derivation_state(_derivation: Option<&DerivationSnapshot>) -> String {
    todo!("phase 2")
}

fn build_coverage_entry(
    _turn: &SelectionTurn,
    _messages_by_turn: &HashMap<String, Vec<SelectionMessage>>,
    _lookup: &DerivationLookup,
) -> ArrangementEntry {
    todo!("phase 2")
}

/// TS `selectArrangement` — throws `CanonicalCorruptionError` on damaged source;
/// Rust returns [`Result`].
pub fn select_arrangement(
    _inputs: &SelectionInputs,
    _config: &SelectionConfig,
) -> Result<SelectionResult, CanonicalCorruptionError> {
    todo!("phase 2")
}
