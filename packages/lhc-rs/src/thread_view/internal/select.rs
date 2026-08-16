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
//!
//! Band crossing: smooth and detailed stop at the first entry that does not
//! fit and hand the remainder down to the next band ([`BandCrossing::Stop`]).
//! Brief is the last band — there is no lower band to catch the remainder — so
//! it skips a crossing entry and continues to older candidates
//! ([`BandCrossing::Skip`]). One unrepresentable entry must never end
//! processing of everything older. Passed-over candidates are reported in
//! [`SelectionResult::skipped`] only when older entries were selected after
//! them; trailing ones are the ordinary window edge and stay quiet.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::exact_i64::f64_to_exact_i64;
use super::render::{
    CompactChunkMaterialSnapshot, DerivationLookup, DerivationSnapshot, ExcerptBlock,
    ResolvedRepresentation, excerpt_line, render_arrangement_entry, resolve_brief_representation,
    resolve_detailed_representation, resolve_smooth_representation,
};
use crate::messages::read_live_messages;
use crate::shared_tech::derivation::DerivationState;
use crate::shared_tech::storage::Db;
use crate::shared_tech::token_counting::estimate_tokens;
use crate::shared_tech::view::{Band, ViewProfilePercentages, ViewSubjectKind};
use crate::turns::{TurnStatus, read_turn_chunk_structure};

/// TS SQL — exact source bytes (subject_kind required for empty-chunk filter).
pub(crate) const SQL_DERIVATION_ROWS: &str =
    "SELECT subject_kind, subject_id, derivation_type, state, content, reason FROM derivation";

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
    /// Chunks with no live (non-tombstoned) member turns — dropped at install.
    pub empty_chunk_ids: Vec<String>,
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

/// A candidate the last band's walk passed over as too large: no entry at all,
/// a hole in the same coverage window a gap entry marks.
#[derive(Debug, Clone, PartialEq)]
pub struct SkippedEntry {
    pub band: Band,
    pub subject_id: String,
    pub tokens: i64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SelectionResult {
    pub compact_point: i64,
    /// Oldest event order any included entry represents. Formula unchanged by
    /// the skip walk — it now simply extends past a skipped entry's hole to the
    /// older entries selected behind it.
    pub covered_from: i64,
    /// Gradient order (brief → detailed → smooth), oldest-first within band —
    /// the order the bands render and the arrangement persists.
    pub entries: Vec<ArrangementEntry>,
    /// Candidates the last band's walk skipped, newest-first, with the trailing
    /// window edge trimmed.
    pub skipped: Vec<SkippedEntry>,
}

fn map_required_str(row: &serde_json::Map<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("missing column {key}"))
        .to_string()
}

fn map_optional_str(row: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    match row.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => panic!("column {key} not text: {other}"),
    }
}

fn map_required_i64(row: &serde_json::Map<String, Value>, key: &str) -> i64 {
    match row.get(key) {
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                return i;
            }
            if let Some(f) = n.as_f64() {
                return f64_to_exact_i64(f).unwrap_or_else(|| panic!("column {key} not integer"));
            }
            panic!("column {key} not integer");
        }
        Some(Value::String(s)) => s
            .parse()
            .unwrap_or_else(|_| panic!("column {key} not integer")),
        _ => panic!("missing column {key}"),
    }
}

fn derivation_state_from_wire(state: &str) -> DerivationState {
    match state {
        "pending" => DerivationState::Pending,
        "ready" => DerivationState::Ready,
        "failed" => DerivationState::Failed,
        "blocked" => DerivationState::Blocked,
        other => panic!("unknown derivation state from row: {other}"),
    }
}

fn selection_turn_status(status: TurnStatus) -> SelectionTurnStatus {
    match status {
        TurnStatus::Open => SelectionTurnStatus::Open,
        TurnStatus::Closed => SelectionTurnStatus::Closed,
    }
}

fn selection_chunk_status(status: TurnStatus) -> SelectionChunkStatus {
    match status {
        TurnStatus::Open => SelectionChunkStatus::Open,
        TurnStatus::Closed => SelectionChunkStatus::Closed,
    }
}

// ── reads (corruption check lives here, pre-transaction) ─────────

pub fn read_selection_inputs(db: &Db) -> Result<SelectionInputs, CanonicalCorruptionError> {
    // Message, turn, and chunk material comes from the owner domains, not direct
    // SQL against their tables (bad-code-log: domain-boundary leakage). The
    // owners return source-faithful structure — turns carry the deleted flag,
    // chunks carry raw membership — so thread-view keeps ownership of the
    // source-state corruption policy below. The derivation and event-aggregate
    // reads stay here as thread-view's own selection inputs.
    let structure = read_turn_chunk_structure(db);
    // Referential checks compare against every turn row (a tombstoned turn is
    // a legitimate reference target, not damage); the selection walk itself
    // sees live turns only.
    let turn_ids: HashSet<String> = structure
        .turns
        .iter()
        .map(|row| row.turn_id.clone())
        .collect();
    let turns: Vec<SelectionTurn> = structure
        .turns
        .iter()
        .filter(|row| !row.deleted)
        .map(|row| SelectionTurn {
            turn_id: row.turn_id.clone(),
            turn_order: row.turn_order,
            status: selection_turn_status(row.status),
            opened_at: row.opened_at_event_order,
            closed_at: row.closed_at_event_order,
        })
        .collect();

    // Canonical damage the walk cannot select across: the turn-state invariant
    // (at most one open turn, open turns carry no close), and referential damage
    // between chunk/message rows and their turns.
    let open_turns: Vec<&SelectionTurn> = turns
        .iter()
        .filter(|turn| turn.status == SelectionTurnStatus::Open)
        .collect();
    if open_turns.len() > 1 {
        let open_ids = open_turns
            .iter()
            .map(|turn| turn.turn_id.as_str())
            .collect::<Vec<_>>()
            .join(DIAG_LIST_JOIN_COMMA_SPACE);
        return Err(CanonicalCorruptionError::new(
            CanonicalCorruptionCode::TurnStateCorrupt,
            format!(
                "{}{}{}{}{}",
                DIAG_CANONICAL_TURN_STATE_CORRUPT_OPEN_TURNS_PREFIX,
                open_turns.len(),
                DIAG_CANONICAL_TURN_STATE_CORRUPT_OPEN_TURNS_MID,
                open_ids,
                DIAG_CANONICAL_TURN_STATE_CORRUPT_OPEN_TURNS_SUFFIX,
            ),
        ));
    }
    for turn in &turns {
        if turn.status == SelectionTurnStatus::Closed && turn.closed_at.is_none() {
            return Err(CanonicalCorruptionError::new(
                CanonicalCorruptionCode::SourceDamaged,
                format!(
                    "{}{}{}",
                    DIAG_CANONICAL_CLOSED_TURN_NO_BOUNDARY_PREFIX,
                    turn.turn_id,
                    DIAG_CANONICAL_CLOSED_TURN_NO_BOUNDARY_SUFFIX,
                ),
            ));
        }
    }

    let mut messages: Vec<SelectionMessage> = Vec::new();
    for record in read_live_messages(db) {
        let turn_id = record.turn_id.clone();
        if !turn_ids.contains(&turn_id) {
            return Err(CanonicalCorruptionError::new(
                CanonicalCorruptionCode::SourceDamaged,
                format!(
                    "{}{}{}{}",
                    DIAG_CANONICAL_MESSAGE_MISSING_TURN_PREFIX,
                    record.message_id,
                    DIAG_CANONICAL_MESSAGE_MISSING_TURN_MID,
                    turn_id,
                ),
            ));
        }
        let blocks: Vec<ExcerptBlock> = record
            .blocks
            .iter()
            .map(|block| ExcerptBlock {
                block_type: block.block_type.as_str().to_string(),
                content: block.content.clone(),
            })
            .collect();
        messages.push(SelectionMessage {
            message_id: record.message_id,
            order: record.source_event_order,
            kind: record.kind.as_str().to_string(),
            token_estimate: record.token_estimate,
            turn_id,
            text: excerpt_line(record.kind.as_str(), &blocks),
        });
    }

    let live_turn_ids: std::collections::HashSet<String> =
        turns.iter().map(|t| t.turn_id.clone()).collect();
    let mut empty_chunk_ids: Vec<String> = Vec::new();
    let mut chunks: Vec<SelectionChunk> = Vec::new();
    for row in &structure.chunks {
        for member_turn_id in &row.member_turn_ids {
            if !turn_ids.contains(member_turn_id) {
                return Err(CanonicalCorruptionError::new(
                    CanonicalCorruptionCode::SourceDamaged,
                    format!(
                        "{}{}{}{}",
                        DIAG_CANONICAL_CHUNK_MISSING_TURN_PREFIX,
                        row.chunk_id,
                        DIAG_CANONICAL_CHUNK_MISSING_TURN_MID,
                        member_turn_id,
                    ),
                ));
            }
        }
        if !row
            .member_turn_ids
            .iter()
            .any(|turn_id| live_turn_ids.contains(turn_id))
        {
            empty_chunk_ids.push(row.chunk_id.clone());
            continue;
        }
        chunks.push(SelectionChunk {
            chunk_id: row.chunk_id.clone(),
            chunk_order: row.chunk_order,
            status: selection_chunk_status(row.status),
            member_turn_ids: row.member_turn_ids.clone(),
        });
    }

    let empty_chunk_set: std::collections::HashSet<&str> =
        empty_chunk_ids.iter().map(|s| s.as_str()).collect();
    // Full derivation scan (TS order) for snapshots + counts with empty-chunk filter.
    // When empty_chunk_ids is empty, counts match historical GROUP BY fixtures;
    // when non-empty, filtered types/states are omitted from both maps.
    let derivation_rows = db.prepare(SQL_DERIVATION_ROWS).all(&[]);
    let mut derivations: IndexMap<String, DerivationSnapshot> = IndexMap::new();
    let mut derivation_counts: IndexMap<String, IndexMap<String, i64>> = IndexMap::new();
    for row in derivation_rows {
        let subject_kind = map_required_str(&row, "subject_kind");
        let subject_id = map_required_str(&row, "subject_id");
        if subject_kind == "chunk" && empty_chunk_set.contains(subject_id.as_str()) {
            continue;
        }
        let derivation_type = map_required_str(&row, "derivation_type");
        let state_wire = map_required_str(&row, "state");
        let state = derivation_state_from_wire(&state_wire);
        let entry = derivation_counts
            .entry(derivation_type.clone())
            .or_default();
        *entry.entry(state_wire).or_insert(0) += 1;
        if subject_kind != "turn" && subject_kind != "chunk" {
            continue;
        }
        let mut snapshot = DerivationSnapshot {
            state,
            content: None,
            reason: None,
        };
        if let Some(content) = map_optional_str(&row, "content") {
            snapshot.content = Some(content);
        }
        if let Some(reason) = map_optional_str(&row, "reason") {
            snapshot.reason = Some(reason);
        }
        derivations.insert(format!("{subject_id}/{derivation_type}"), snapshot);
    }

    // Prefer GROUP BY count order when no empty chunks (byte-stable with fixtures).
    // Empty-chunk filter requires the scan-built map above.
    let derivation_counts = if empty_chunk_ids.is_empty() {
        let count_rows = db.prepare(SQL_DERIVATION_COUNTS).all(&[]);
        let mut from_group: IndexMap<String, IndexMap<String, i64>> = IndexMap::new();
        for row in count_rows {
            let dtype = map_required_str(&row, "derivation_type");
            let state = map_required_str(&row, "state");
            let n = map_required_i64(&row, "n");
            let entry = from_group.entry(dtype).or_default();
            entry.insert(state, n);
        }
        from_group
    } else {
        derivation_counts
    };

    let max_row = db
        .prepare(SQL_MAX_EVENT_ORDER)
        .get()
        .expect("COALESCE(MAX(...), 0) always returns a row");
    let max_event_order = map_required_i64(&max_row, "m");

    Ok(SelectionInputs {
        messages,
        turns,
        chunks,
        derivations,
        compact_chunk_materials: None,
        max_event_order,
        derivation_counts,
        empty_chunk_ids,
    })
}

// ── the pure walk ─────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionConfig {
    /// Amendment I: TS `number` (fractional-capable).
    pub lower_bound: f64,
    pub percentages: ViewProfilePercentages,
}

/// Message kinds that can anchor a host session rebuild past the compact point.
/// Excludes runtime_note (and any future non-mappable kinds). Shared with the
/// first-kept-message lookup in compact-compute so "empty tail" means the same
/// thing in both places.
pub const PI_MAPPABLE_MESSAGE_KINDS: [&str; 8] = [
    "user_prompt",
    "assistant_text",
    "assistant_thinking",
    "tool_call",
    "tool_result",
    "model_change",
    "thinking_level_change",
    "compact_continuation_marker",
];


/// TS `band: "detailed" | "brief"` accepted by `buildChunkEntry`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChunkEntryBand {
    Detailed,
    Brief,
}

impl ChunkEntryBand {
    fn as_str(self) -> &'static str {
        match self {
            ChunkEntryBand::Detailed => "detailed",
            ChunkEntryBand::Brief => "brief",
        }
    }

    fn to_band(self) -> Band {
        match self {
            ChunkEntryBand::Detailed => Band::Detailed,
            ChunkEntryBand::Brief => Band::Brief,
        }
    }
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
/// `entry did not fit the remaining ${band} budget (${tokens} tokens from
/// ${derivationUsed}); skipped so older entries could be selected` — the
/// reason a last-band skip reports (reference wording, select.ts).
pub(crate) const DIAG_SKIPPED_TOO_LARGE_PREFIX: &str = "entry did not fit the remaining ";
pub(crate) const DIAG_SKIPPED_TOO_LARGE_MID_BUDGET: &str = " budget (";
pub(crate) const DIAG_SKIPPED_TOO_LARGE_MID_FROM: &str = " tokens from ";
pub(crate) const DIAG_SKIPPED_TOO_LARGE_SUFFIX: &str =
    "); skipped so older entries could be selected";
/// `detailed_turn_compression ${state}` (coverage degraded reason)
pub(crate) const DIAG_COVERAGE_DETAILED_TURN_COMPRESSION_PREFIX: &str =
    "detailed_turn_compression ";
/// `closed turn before compact point was not represented by selected bands (detailed_turn_compression: ${…}, pre_detailed_assembly: ${…})`
pub(crate) const DIAG_COVERAGE_GAP_REASON_PREFIX: &str = "closed turn before compact point was not represented by selected bands (detailed_turn_compression: ";
pub(crate) const DIAG_COVERAGE_GAP_REASON_MID: &str = ", pre_detailed_assembly: ";
pub(crate) const DIAG_COVERAGE_GAP_REASON_CLOSE: &str = ")";

/// Amendment I — `fullSideTokens` is the float budget-line split (TS `number`);
/// do not truncate before comparing to the smooth side.
fn straddling_turn_stays_in_full(full_side_tokens: f64, turn_tokens: i64) -> bool {
    let smooth_side_tokens = turn_tokens as f64 - full_side_tokens;
    full_side_tokens >= smooth_side_tokens
}

/// TS nested `lookup` inside `selectArrangement`.
fn lookup(
    derivations: &IndexMap<String, DerivationSnapshot>,
    subject_id: &str,
    derivation_type: &str,
) -> Option<DerivationSnapshot> {
    derivations
        .get(&format!("{subject_id}/{derivation_type}"))
        .cloned()
}

/// TS nested `chunkMaterial` inside `selectArrangement`.
fn chunk_material(
    inputs: &SelectionInputs,
    chunk_id: &str,
    derivation_type: ChunkMaterialDerivation,
) -> Option<CompactChunkMaterialSnapshot> {
    inputs
        .compact_chunk_materials
        .as_ref()?
        .get(&format!("{chunk_id}/{}", derivation_type.as_str()))
        .cloned()
}

/// TS nested `budget` inside `selectArrangement` (private — not a test surface).
fn budget(lower_bound: f64, share: f64) -> f64 {
    (lower_bound * share) / 100.0
}

/// TS nested `previousClose` inside `snapCompactPoint`.
fn previous_close(closed_turns: &[SelectionTurn], turn: &SelectionTurn) -> i64 {
    let previous = closed_turns
        .iter()
        .rfind(|t| t.turn_order < turn.turn_order);
    previous.and_then(|t| t.closed_at).unwrap_or(0)
}

/// TS nested `byRecordOrder` inside `selectArrangement`.
fn by_record_order(a: &ArrangementEntry, b: &ArrangementEntry) -> std::cmp::Ordering {
    a.start_order.cmp(&b.start_order)
}

fn snap_compact_point(
    oldest_taken: &SelectionMessage,
    turns_by_id: &HashMap<String, SelectionTurn>,
    closed_turns: &[SelectionTurn],
    messages: &[SelectionMessage],
    messages_by_turn: &HashMap<String, Vec<SelectionMessage>>,
    full_budget: f64,
) -> Result<i64, CanonicalCorruptionError> {
    let candidate = turns_by_id.get(&oldest_taken.turn_id);
    let Some(candidate) = candidate else {
        return Err(CanonicalCorruptionError::new(
            CanonicalCorruptionCode::SourceDamaged,
            format!(
                "{}{}{}{}",
                DIAG_CANONICAL_MESSAGE_MISSING_TURN_PREFIX,
                oldest_taken.message_id,
                DIAG_CANONICAL_MESSAGE_MISSING_TURN_MID,
                oldest_taken.turn_id,
            ),
        ));
    };
    if candidate.status == SelectionTurnStatus::Open {
        // Open-turn messages are tail regardless of budget; the tail begins at
        // the open turn's start.
        return Ok(previous_close(closed_turns, candidate));
    }
    // Fully covered down to the turn's start ⇒ the tail begins at this turn.
    if oldest_taken.order <= turn_start_order(candidate, messages_by_turn) {
        return Ok(previous_close(closed_turns, candidate));
    }

    // A partially-covered closed turn straddles the full-budget line. Keep it
    // whole in full when evicting it would leave no live tail; otherwise round
    // toward the side holding at least half of the turn's tokens (ties stay in
    // full). The split is at the exact budget line, even when that line falls
    // inside the crossing message's estimate.
    let candidate_messages = messages_by_turn
        .get(&candidate.turn_id)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let turn_tokens: i64 = candidate_messages
        .iter()
        .map(|message| message.token_estimate)
        .sum();
    let newer_tokens: i64 = messages
        .iter()
        .filter(|message| {
            candidate
                .closed_at
                .is_some_and(|closed_at| message.order > closed_at)
        })
        .map(|message| message.token_estimate)
        .sum();
    // Amendment I: keep the float budget-line operand. TS Math.max(0, Math.min(
    // turnTokens, …)) — composed min/max, NOT clamp: clamp panics when a
    // corrupt negative token sum makes max < min; TS yields 0 (phase-2 review P3).
    let full_side_tokens = (full_budget - newer_tokens as f64)
        .min(turn_tokens as f64)
        .max(0.0);
    if straddling_turn_stays_in_full(full_side_tokens, turn_tokens) {
        return Ok(previous_close(closed_turns, candidate));
    }
    Ok(candidate.closed_at.unwrap_or(0))
}

fn turn_start_order(
    turn: &SelectionTurn,
    messages_by_turn: &HashMap<String, Vec<SelectionMessage>>,
) -> i64 {
    let candidates = messages_by_turn
        .get(&turn.turn_id)
        .map(|list| list.iter().map(|message| message.order).collect::<Vec<_>>())
        .unwrap_or_default();
    if candidates.is_empty() {
        turn.opened_at
    } else {
        candidates.into_iter().min().expect("non-empty")
    }
}

fn build_turn_entry(
    turn: &SelectionTurn,
    messages_by_turn: &HashMap<String, Vec<SelectionMessage>>,
    lookup: &DerivationLookup,
) -> ArrangementEntry {
    let turn_messages = messages_by_turn
        .get(&turn.turn_id)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let excerpt = if turn_messages.is_empty() {
        None
    } else {
        Some(
            turn_messages
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        )
    };
    let rep = resolve_smooth_representation(turn.turn_id.as_str(), lookup, excerpt.as_deref());
    let text =
        render_arrangement_entry(ViewSubjectKind::Turn, turn.turn_id.as_str(), &rep, &[], &[]);
    ArrangementEntry {
        band: Band::Smooth,
        subject_kind: ViewSubjectKind::Turn,
        subject_id: turn.turn_id.clone(),
        derivation_used: rep.derivation_used,
        degraded: rep.degraded,
        gap: rep.gap,
        reason: rep.reason,
        start_order: turn_start_order(turn, messages_by_turn),
        tokens: estimate_tokens(&text),
        text,
    }
}

fn build_chunk_entry(
    chunk: &SelectionChunk,
    band: ChunkEntryBand,
    compact_point: i64,
    turns_by_id: &HashMap<String, SelectionTurn>,
    lookup: &DerivationLookup,
    // The brief band's own budget, threaded from the caller's budget
    // computation so the brief ladder can price its failure floor against it.
    brief_band_budget: f64,
    material: Option<&CompactChunkMaterialSnapshot>,
) -> ArrangementEntry {
    let rep = match band {
        ChunkEntryBand::Detailed => {
            resolve_detailed_representation(chunk.chunk_id.as_str(), lookup, material)
        }
        ChunkEntryBand::Brief => resolve_brief_representation(
            chunk.chunk_id.as_str(),
            lookup,
            brief_band_budget,
            material,
        ),
    };
    let text = render_arrangement_entry(
        ViewSubjectKind::Chunk,
        chunk.chunk_id.as_str(),
        &rep,
        &[],
        &chunk.member_turn_ids,
    );
    // Signature has no messages_by_turn; without live messages the start falls
    // back to each member's open boundary (same as empty-message turnStartOrder).
    // select_arrangement overwrites start_order with the message-aware minimum.
    let member_starts: Vec<i64> = chunk
        .member_turn_ids
        .iter()
        .filter_map(|turn_id| turns_by_id.get(turn_id))
        .map(|turn| turn.opened_at)
        .collect();
    let start_order = if member_starts.is_empty() {
        compact_point
    } else {
        member_starts.into_iter().min().expect("non-empty")
    };
    let _ = band.as_str();
    ArrangementEntry {
        band: band.to_band(),
        subject_kind: ViewSubjectKind::Chunk,
        subject_id: chunk.chunk_id.clone(),
        derivation_used: rep.derivation_used,
        degraded: rep.degraded,
        gap: rep.gap,
        reason: rep.reason,
        start_order,
        tokens: estimate_tokens(&text),
        text,
    }
}

/// What a band's fill walk does with a candidate that crosses its budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BandCrossing {
    /// Stop the walk and hand the crossing candidate (and everything older)
    /// down to the next band. Smooth and detailed — a lower band catches them.
    Stop,
    /// Pass the candidate over and keep walking to older candidates. The last
    /// band only: no lower band exists, so stopping would silently drop every
    /// older candidate however small its own entry.
    Skip,
}

struct FillBandResult<T> {
    included: Vec<ArrangementEntry>,
    rest: Vec<T>,
    /// [`BandCrossing::Skip`] only, and only for candidates with older
    /// candidates included behind them.
    skipped: Vec<SkippedEntry>,
}

fn fill_band<T, F>(
    candidates: &[T],
    band_budget: f64,
    crossing: BandCrossing,
    build: F,
) -> FillBandResult<T>
where
    T: Clone,
    F: Fn(&T) -> ArrangementEntry,
{
    let mut included: Vec<ArrangementEntry> = Vec::new();
    let mut sum: i64 = 0;
    let mut skipped: Vec<SkippedEntry> = Vec::new();
    // Passed-over candidates are held here until an older candidate is
    // included: a run of skips with nothing older behind it is the ordinary
    // full-band window edge, not a hole, and is dropped at the walk's end.
    let mut pending: Vec<SkippedEntry> = Vec::new();
    for (i, candidate) in candidates.iter().enumerate() {
        let entry = build(candidate);
        if (sum as f64) + (entry.tokens as f64) <= band_budget {
            sum += entry.tokens;
            included.push(entry);
            skipped.append(&mut pending);
            continue;
        }
        if included.is_empty() {
            // Force-include: a band never renders empty because its first
            // candidate alone crosses. In Skip mode the forced entry still
            // counts against the budget, which it has now wholly consumed —
            // the walk exits rather than skipping every older candidate.
            sum += entry.tokens;
            included.push(entry);
            skipped.append(&mut pending);
            // The forced entry crossed an empty band, so it has by definition
            // consumed the whole budget — the walk exits in both modes.
            debug_assert!((sum as f64) > band_budget);
            return FillBandResult {
                included,
                rest: candidates[i + 1..].to_vec(),
                skipped,
            };
        }
        if crossing == BandCrossing::Skip {
            pending.push(SkippedEntry {
                band: entry.band,
                subject_id: entry.subject_id.clone(),
                tokens: entry.tokens,
                reason: format!(
                    "{DIAG_SKIPPED_TOO_LARGE_PREFIX}{}{DIAG_SKIPPED_TOO_LARGE_MID_BUDGET}{}{DIAG_SKIPPED_TOO_LARGE_MID_FROM}{}{DIAG_SKIPPED_TOO_LARGE_SUFFIX}",
                    entry.band.as_str(),
                    entry.tokens,
                    entry.derivation_used
                ),
            });
            continue;
        }
        return FillBandResult {
            included,
            rest: candidates[i..].to_vec(),
            skipped,
        };
    }
    FillBandResult {
        included,
        rest: Vec::new(),
        skipped,
    }
}

fn ready_content(derivation: Option<&DerivationSnapshot>) -> Option<String> {
    match derivation {
        Some(d) if d.state == DerivationState::Ready => d.content.clone(),
        _ => None,
    }
}

fn derivation_state(derivation: Option<&DerivationSnapshot>) -> String {
    match derivation {
        None => "missing".to_string(),
        Some(d) => d.state.as_str().to_string(),
    }
}

fn build_coverage_entry(
    turn: &SelectionTurn,
    messages_by_turn: &HashMap<String, Vec<SelectionMessage>>,
    lookup: &DerivationLookup,
) -> ArrangementEntry {
    let compression = lookup(turn.turn_id.as_str(), "detailed_turn_compression");
    let assembly = lookup(turn.turn_id.as_str(), "pre_detailed_assembly");
    let compression_content = ready_content(compression.as_ref());
    let assembly_content = ready_content(assembly.as_ref());
    let rep = if let Some(body) = compression_content {
        ResolvedRepresentation {
            derivation_used: "detailed_turn_compression".to_string(),
            body,
            degraded: false,
            gap: false,
            degraded_marker: None,
            reason: None,
        }
    } else if let Some(body) = assembly_content {
        ResolvedRepresentation {
            derivation_used: "pre_detailed_assembly".to_string(),
            body,
            degraded: true,
            gap: false,
            degraded_marker: Some("coverage-from-pre-detailed-assembly".to_string()),
            reason: Some(format!(
                "{}{}",
                DIAG_COVERAGE_DETAILED_TURN_COMPRESSION_PREFIX,
                derivation_state(compression.as_ref()),
            )),
        }
    } else {
        ResolvedRepresentation {
            derivation_used: "gap".to_string(),
            body: String::new(),
            degraded: false,
            gap: true,
            degraded_marker: None,
            reason: Some(format!(
                "{}{}{}{}{}",
                DIAG_COVERAGE_GAP_REASON_PREFIX,
                derivation_state(compression.as_ref()),
                DIAG_COVERAGE_GAP_REASON_MID,
                derivation_state(assembly.as_ref()),
                DIAG_COVERAGE_GAP_REASON_CLOSE,
            )),
        }
    };
    let text =
        render_arrangement_entry(ViewSubjectKind::Turn, turn.turn_id.as_str(), &rep, &[], &[]);
    ArrangementEntry {
        band: Band::Detailed,
        subject_kind: ViewSubjectKind::Turn,
        subject_id: turn.turn_id.clone(),
        derivation_used: rep.derivation_used,
        degraded: rep.degraded,
        gap: rep.gap,
        reason: rep.reason,
        start_order: turn_start_order(turn, messages_by_turn),
        tokens: estimate_tokens(&text),
        text,
    }
}

/// TS `selectArrangement` — throws `CanonicalCorruptionError` on damaged source;
/// Rust returns [`Result`].
pub fn select_arrangement(
    inputs: &SelectionInputs,
    config: &SelectionConfig,
) -> Result<SelectionResult, CanonicalCorruptionError> {
    let messages = &inputs.messages;
    let turns = &inputs.turns;
    let chunks = &inputs.chunks;
    // DerivationLookup is `dyn Fn + 'static`; own the map so the closure does not
    // borrow `inputs` (render.rs alias has no lifetime parameter).
    let derivations = Arc::new(inputs.derivations.clone());
    let lookup_fn = {
        let derivations = Arc::clone(&derivations);
        move |subject_id: &str, derivation_type: &str| -> Option<DerivationSnapshot> {
            lookup(&derivations, subject_id, derivation_type)
        }
    };

    let turns_by_id: HashMap<String, SelectionTurn> = turns
        .iter()
        .map(|turn| (turn.turn_id.clone(), turn.clone()))
        .collect();
    let mut messages_by_turn: HashMap<String, Vec<SelectionMessage>> = HashMap::new();
    for message in messages {
        messages_by_turn
            .entry(message.turn_id.clone())
            .or_default()
            .push(message.clone());
    }

    // Rule 1 — compact point: messages newest-first until the estimate sum
    // first reaches the full share; the point snaps to a turn boundary so the
    // tail never begins mid-turn. Open-turn messages always land in the tail.
    let full_budget = budget(config.lower_bound, config.percentages.full);
    let closed_turns: Vec<SelectionTurn> = turns
        .iter()
        .filter(|turn| turn.status == SelectionTurnStatus::Closed)
        .cloned()
        .collect();
    let mut compact_point: i64 = 0;
    if !closed_turns.is_empty() && !messages.is_empty() {
        let mut sum: i64 = 0;
        let mut crossing: Option<&SelectionMessage> = None;
        for message in messages.iter().rev() {
            sum += message.token_estimate;
            if (sum as f64) >= full_budget {
                crossing = Some(message);
                break;
            }
        }
        // Budget never reached ⇒ the whole record fits the full share:
        // everything is tail, no bands.
        compact_point = match crossing {
            None => 0,
            Some(oldest_taken) => snap_compact_point(
                oldest_taken,
                &turns_by_id,
                &closed_turns,
                messages,
                &messages_by_turn,
                full_budget,
            )?,
        };
    }

    // Band candidates: closed turns wholly behind the compact point. Rule 5 is
    // structural here — chunked or not, a banded turn is a smooth candidate
    // (bands are defined by representation, not strict time strata).
    let banded_turns: Vec<SelectionTurn> = closed_turns
        .iter()
        .filter(|turn| {
            turn.closed_at
                .is_some_and(|closed_at| closed_at <= compact_point)
        })
        .cloned()
        .collect();
    let banded_turn_ids: HashSet<String> = banded_turns
        .iter()
        .map(|turn| turn.turn_id.clone())
        .collect();

    // Rule 2 + 5 — smooth band: banded closed turns newest-first, chunked or
    // not (rule 5 is structural: a closed-but-unchunked turn is a turn, takes
    // the smooth representation, and consumes this budget).
    let smooth_candidates: Vec<SelectionTurn> = banded_turns.iter().rev().cloned().collect();
    let brief_budget = budget(config.lower_bound, config.percentages.brief);
    let smooth = fill_band(
        &smooth_candidates,
        budget(config.lower_bound, config.percentages.smooth),
        BandCrossing::Stop,
        |turn| build_turn_entry(turn, &messages_by_turn, &lookup_fn),
    );
    let oldest_smooth_order = smooth.included.iter().fold(f64::INFINITY, |oldest, entry| {
        let turn_order = turns_by_id
            .get(&entry.subject_id)
            .map(|turn| turn.turn_order as f64)
            .unwrap_or(f64::INFINITY);
        oldest.min(turn_order)
    });

    // Rules 3–4 — chunk candidacy: chunks entirely older than the smooth
    // band's coverage, with the pinned tie-breaker doing the deciding — chunk
    // coverage is its NEWEST member turn, which must sit behind the compact
    // point and be older than the smooth band's oldest included turn.
    let chunk_candidates: Vec<SelectionChunk> = chunks
        .iter()
        .filter(|chunk| chunk.status == SelectionChunkStatus::Closed)
        .filter(|chunk| {
            let live_members: Vec<&SelectionTurn> = chunk
                .member_turn_ids
                .iter()
                .filter_map(|turn_id| turns_by_id.get(turn_id))
                .collect();
            if live_members.is_empty() {
                return false; // fully tombstoned membership
            }
            let newest_member = live_members.iter().fold(live_members[0], |newest, turn| {
                if turn.turn_order > newest.turn_order {
                    turn
                } else {
                    newest
                }
            });
            banded_turn_ids.contains(&newest_member.turn_id)
                && (newest_member.turn_order as f64) < oldest_smooth_order
        })
        .rev()
        .cloned()
        .collect(); // newest-first

    // Rule 3 — detailed: same fill rule against its share.
    let detailed = fill_band(
        &chunk_candidates,
        budget(config.lower_bound, config.percentages.detailed),
        BandCrossing::Stop,
        |chunk| {
            let material = chunk_material(
                inputs,
                &chunk.chunk_id,
                ChunkMaterialDerivation::ChunkSummaryDetailed,
            );
            // Faithful member start: turnStartOrder, not opened_at alone.
            let member_starts: Vec<i64> = chunk
                .member_turn_ids
                .iter()
                .filter_map(|turn_id| turns_by_id.get(turn_id))
                .map(|turn| turn_start_order(turn, &messages_by_turn))
                .collect();
            let mut entry = build_chunk_entry(
                chunk,
                ChunkEntryBand::Detailed,
                compact_point,
                &turns_by_id,
                &lookup_fn,
                brief_budget,
                material.as_ref(),
            );
            entry.start_order = if member_starts.is_empty() {
                compact_point
            } else {
                member_starts.into_iter().min().expect("non-empty")
            };
            entry
        },
    );
    // Rule 4 — brief: the remaining chunks, same fill rule against its share.
    // Brief is the last band, so a crossing chunk is skipped and the walk
    // continues to older candidates rather than ending the band there.
    let brief = fill_band(&detailed.rest, brief_budget, BandCrossing::Skip, |chunk| {
        let material = chunk_material(
            inputs,
            &chunk.chunk_id,
            ChunkMaterialDerivation::ChunkSummaryBrief,
        );
        let member_starts: Vec<i64> = chunk
            .member_turn_ids
            .iter()
            .filter_map(|turn_id| turns_by_id.get(turn_id))
            .map(|turn| turn_start_order(turn, &messages_by_turn))
            .collect();
        let mut entry = build_chunk_entry(
            chunk,
            ChunkEntryBand::Brief,
            compact_point,
            &turns_by_id,
            &lookup_fn,
            brief_budget,
            material.as_ref(),
        );
        entry.start_order = if member_starts.is_empty() {
            compact_point
        } else {
            member_starts.into_iter().min().expect("non-empty")
        };
        entry
    });

    let selected_entries: Vec<&ArrangementEntry> = brief
        .included
        .iter()
        .chain(detailed.included.iter())
        .chain(smooth.included.iter())
        .collect();

    // Coverage invariant: every closed turn behind the compact point must be
    // represented by a selected turn, represented by a selected chunk's
    // membership, or explicitly surfaced as a smooth gap. This catches the
    // normal open-chunk shape where older closed turns are too old for smooth
    // but cannot be represented by their still-open chunk.
    let mut covered_turn_ids: HashSet<String> = HashSet::new();
    let chunks_by_id: HashMap<String, &SelectionChunk> = chunks
        .iter()
        .map(|chunk| (chunk.chunk_id.clone(), chunk))
        .collect();
    let mut oldest_selected_turn_order = f64::INFINITY;
    for entry in &selected_entries {
        if entry.subject_kind == ViewSubjectKind::Turn {
            covered_turn_ids.insert(entry.subject_id.clone());
            if let Some(turn) = turns_by_id.get(&entry.subject_id) {
                oldest_selected_turn_order = oldest_selected_turn_order.min(turn.turn_order as f64);
            }
            continue;
        }
        let chunk = chunks_by_id.get(&entry.subject_id);
        for turn_id in chunk.map(|c| c.member_turn_ids.as_slice()).unwrap_or(&[]) {
            if let Some(turn) = turns_by_id.get(turn_id)
                && banded_turn_ids.contains(turn_id)
            {
                covered_turn_ids.insert(turn_id.clone());
                oldest_selected_turn_order = oldest_selected_turn_order.min(turn.turn_order as f64);
            }
        }
    }

    // A skipped chunk's member turns are covered by its gap note, not by an
    // entry. Count them as covered so the coverage machinery does not resurrect
    // the hole as unbudgeted per-turn detailed material — the whole point of
    // the skip was that this subject does not fit.
    for skip in &brief.skipped {
        let chunk = chunks_by_id.get(&skip.subject_id);
        for turn_id in chunk.map(|c| c.member_turn_ids.as_slice()).unwrap_or(&[]) {
            if banded_turn_ids.contains(turn_id) {
                covered_turn_ids.insert(turn_id.clone());
            }
        }
    }

    let coverage_gaps: Vec<ArrangementEntry> = banded_turns
        .iter()
        .filter(|turn| {
            (turn.turn_order as f64) >= oldest_selected_turn_order
                && !covered_turn_ids.contains(&turn.turn_id)
        })
        .map(|turn| build_coverage_entry(turn, &messages_by_turn, &lookup_fn))
        .collect();

    let mut brief_sorted = brief.included;
    brief_sorted.sort_by(by_record_order);
    let mut detailed_sorted = detailed.included;
    detailed_sorted.extend(coverage_gaps);
    detailed_sorted.sort_by(by_record_order);
    let mut smooth_sorted = smooth.included;
    smooth_sorted.sort_by(by_record_order);

    let entries: Vec<ArrangementEntry> = brief_sorted
        .into_iter()
        .chain(detailed_sorted)
        .chain(smooth_sorted)
        .collect();

    let covered_from = if entries.is_empty() {
        compact_point
    } else {
        entries
            .iter()
            .map(|entry| entry.start_order)
            .min()
            .expect("non-empty")
    };

    Ok(SelectionResult {
        compact_point,
        covered_from,
        entries,
        skipped: brief.skipped,
    })
}
