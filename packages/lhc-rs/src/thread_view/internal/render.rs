//! Ported from packages/lhc/src/thread-view/internal/render.ts.
//!
//! Tail and band formatting: the tail mapping table, short/full tool-result
//! selection by boundary position, and the deterministic at-or-behind-boundary
//! truncation rule. Pure functions over read state by design: no DB handle, no
//! inference, no clock.
//!
//! The band-entry side includes degrade ladders, gap entries as the last rung,
//! the [degraded: ...] and [inter-turn note] markers, and band-text assembly.
//! select.ts consumes the same entry renderer to price
//! entries during the fill walk, so the tokens the walk budgets are the tokens
//! the band stores: one renderer, no drift.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::snapshot::TailMessageRow;
use crate::shared_tech::derivation::DerivationState;
use crate::shared_tech::tool_result_rendering::FALLBACK_TRUNCATION_LIMIT;
use crate::shared_tech::view::{Band, ViewSubjectKind};

/// Deterministic abbreviation: a fixed prefix plus an exact tail marker, a pure
/// function of the input string alone. Restated here, byte-identical to
/// turns/internal/compose.ts's truncateForFallback, because cross-domain
/// internals may not be imported. TS imports truncateForFallback from shared-tech;
/// Phase 2 bodies call it via deterministic_truncation.
pub const ABBREVIATION_LIMIT: usize = FALLBACK_TRUNCATION_LIMIT;

// ── render / diagnostic literals (byte-exact from TS) ─────────────

pub(crate) const LITERAL_UNKNOWN_TOOL: &str = "unknown_tool";
pub(crate) const LITERAL_TOOL_CALL_PREFIX: &str = "[tool call · ";
/// TS `` `[tool call · ${name}] ${args}` `` — delimiter after the closing bracket.
pub(crate) const LITERAL_TOOL_CALL_CLOSE_SPACE: &str = "] ";
pub(crate) const LITERAL_TOOL_RESULT_PREFIX: &str = "[tool result · ";
pub(crate) const LITERAL_TOOL_RESULT_ABRIDGED_MID: &str = " · abridged]";
pub(crate) const LITERAL_TOOL_RESULT_CLOSE: &str = "]";
pub(crate) const LITERAL_THINKING_OPEN: &str = "[thinking]\n";
pub(crate) const LITERAL_THINKING_CLOSE: &str = "\n[/thinking]";
pub(crate) const LITERAL_RUNTIME_NOTE_PREFIX: &str = "[runtime note] ";
pub(crate) const LITERAL_MODEL_CHANGE_PREFIX: &str = "[model change] ";
pub(crate) const LITERAL_MODEL_CHANGE_ARROW: &str = " -> ";
pub(crate) const LITERAL_THINKING_LEVEL_CHANGE_PREFIX: &str = "[thinking level change] ";
pub(crate) const LITERAL_CONTEXT_PREFIX: &str = "[context · ";
pub(crate) const LITERAL_CONTEXT_MID: &str = "]\n";
pub(crate) const LITERAL_INTER_TURN_NOTE_PREFIX: &str = "[inter-turn note] ";
pub(crate) const LITERAL_DEGRADED_PREFIX: &str = "[degraded: ";
pub(crate) const LITERAL_DEGRADED_CLOSE: &str = "]\n";
/// TS gap line `` `[${subjectKind} unavailable: …]` `` opening bracket.
pub(crate) const LITERAL_GAP_OPEN: &str = "[";
pub(crate) const LITERAL_GAP_UNAVAILABLE_MID: &str = " unavailable: ";
pub(crate) const LITERAL_GAP_UNKNOWN_REASON: &str = "unknown";
/// TS `lines.join("\n")` in `renderArrangementEntry`.
pub(crate) const LITERAL_ARRANGEMENT_ENTRY_JOIN: &str = "\n";
/// TS `entryTexts.join("\n\n")` in `assembleBandText`.
pub(crate) const LITERAL_BAND_TEXT_JOIN: &str = "\n\n";
pub(crate) const LITERAL_EXCERPT_TOOL_RESULT: &str = "[tool result]";
pub(crate) const LITERAL_FALLBACK_SMOOTH_FROM_COMPRESSION: &str = "smooth-from-compression";
pub(crate) const LITERAL_FALLBACK_SMOOTH_FROM_EXCERPT: &str = "smooth-from-excerpt";
pub(crate) const LITERAL_FALLBACK_DETAILED_FROM_STORED_MEMBERS: &str =
    "detailed-from-stored-members";
pub(crate) const LITERAL_FALLBACK_BRIEF_FROM_STORED_MEMBERS: &str = "brief-from-stored-members";
pub(crate) const LITERAL_DERIVATION_GAP: &str = "gap";
pub(crate) const LITERAL_DERIVATION_MESSAGE_EXCERPT: &str = "message_excerpt";
pub(crate) const LITERAL_DERIVATION_STORED_MEMBER_CONCAT: &str = "stored_member_concat";
pub(crate) const LITERAL_DERIVATION_TURN_RENDERING: &str = "turn_rendering";
pub(crate) const LITERAL_DERIVATION_DETAILED_TURN_COMPRESSION: &str = "detailed_turn_compression";
pub(crate) const LITERAL_DERIVATION_CHUNK_SUMMARY_DETAILED: &str = "chunk_summary_detailed";
pub(crate) const LITERAL_DERIVATION_CHUNK_SUMMARY_BRIEF: &str = "chunk_summary_brief";
pub(crate) const LITERAL_LADDER_STATE_ABSENT: &str = "absent";
/// select.ts `derivationState` when the derivation is undefined (coverage path).
pub(crate) const LITERAL_DERIVATION_STATE_MISSING: &str = "missing";
/// select.ts coverage fallback marker.
pub(crate) const LITERAL_FALLBACK_COVERAGE_FROM_PRE_DETAILED_ASSEMBLY: &str =
    "coverage-from-pre-detailed-assembly";
/// select.ts / compact coverage derivation type key.
pub(crate) const LITERAL_DERIVATION_PRE_DETAILED_ASSEMBLY: &str = "pre_detailed_assembly";

// ── complete fallback-reason templates (render.ts gap rungs) ──────
// Dynamic ladder states are inserted; static pieces are byte-exact.

/// `no usable derivation (turn_rendering: ${…}, detailed_turn_compression: ${…}, no live messages)`
pub(crate) const DIAG_NO_USABLE_DERIVATION_OPEN: &str = "no usable derivation (";
pub(crate) const DIAG_FALLBACK_SMOOTH_TURN_RENDERING_LABEL: &str = "turn_rendering: ";
pub(crate) const DIAG_FALLBACK_SMOOTH_DETAILED_SEP: &str = ", detailed_turn_compression: ";
pub(crate) const DIAG_FALLBACK_SMOOTH_NO_LIVE_MESSAGES_CLOSE: &str = ", no live messages)";

/// `no usable derivation (chunk_summary_detailed: ${…}, compact material absent)`
pub(crate) const DIAG_FALLBACK_DETAILED_LABEL: &str = "chunk_summary_detailed: ";
pub(crate) const DIAG_FALLBACK_COMPACT_MATERIAL_ABSENT_CLOSE: &str = ", compact material absent)";

/// `no usable derivation (chunk_summary_brief: ${…}, compact material absent)`
pub(crate) const DIAG_FALLBACK_BRIEF_LABEL: &str = "chunk_summary_brief: ";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssembledContextRole {
    User,
    Assistant,
}

impl AssembledContextRole {
    pub fn as_str(self) -> &'static str {
        match self {
            AssembledContextRole::User => "user",
            AssembledContextRole::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssembledContextMessage {
    pub role: AssembledContextRole,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub band: Option<Band>,
}

pub fn deterministic_truncation(_text: &str) -> String {
    todo!("phase 2")
}

fn block_content(_message: &TailMessageRow) -> Map<String, Value> {
    todo!("phase 2")
}

fn text_of(_message: &TailMessageRow) -> String {
    todo!("phase 2")
}

/// What the tail renderer needs beyond the message itself: the boundary
/// position (short/full selection) and the call-id → tool-name pairing
/// (results carry only their call id).
#[derive(Debug, Clone, PartialEq)]
pub struct TailRenderContext {
    pub boundary_position: i64,
    /// TS `Map` — insertion-ordered ([`IndexMap`]).
    pub tool_name_by_call_id: IndexMap<String, String>,
}

/// The call-id → tool-name map from the messages in hand. Pairing within the
/// tail is structurally sufficient: the compact point snaps to a turn start,
/// so a tail result's call is never behind it.
pub fn tool_names_by_call_id(_messages: &[TailMessageRow]) -> IndexMap<String, String> {
    todo!("phase 2")
}

fn render_tool_call(_message: &TailMessageRow) -> AssembledContextMessage {
    todo!("phase 2")
}

fn tool_result_raw_content(_message: &TailMessageRow) -> String {
    todo!("phase 2")
}

/// Tool-result body for session loading: full ahead of the boundary, truncated at-or-behind.
pub fn tool_result_session_content(_message: &TailMessageRow, _ctx: &TailRenderContext) -> String {
    todo!("phase 2")
}

fn render_tool_result(
    _message: &TailMessageRow,
    _ctx: &TailRenderContext,
) -> AssembledContextMessage {
    todo!("phase 2")
}

/// One tail message → one assembled message per the mapping table. Each kind is its
/// own arm so a single kind's drift fails its own named test leg.
pub fn render_tail_message(
    _message: &TailMessageRow,
    _ctx: &TailRenderContext,
) -> AssembledContextMessage {
    todo!("phase 2")
}

/// One non-empty band to one labeled `user` message: band-marker header, then
/// the snapshot bytes verbatim. Inference APIs reject unknown roles.
pub fn render_band_message(_band: Band, _rendered_text: &str) -> AssembledContextMessage {
    todo!("phase 2")
}

// ── band entries: degrade ladders, gaps, keys ────────────────────

/// One derivation's stored state as the ladder reads it (a read shape for
/// Derivation: the resolvers never write, never re-derive).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivationSnapshot {
    pub state: DerivationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// TS compact chunk material snapshot — tagged on `kind`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum CompactChunkMaterialSnapshot {
    #[serde(rename = "ready", rename_all = "camelCase")]
    Ready { content: String },
    #[serde(rename = "concat", rename_all = "camelCase")]
    Concat { content: String, reason: String },
}

/// TS `DerivationLookup`.
pub type DerivationLookup = dyn Fn(&str, &str) -> Option<DerivationSnapshot>;

/// A subject's resolved representation: which rung of its ladder renders.
/// `derivation_used` is the arrangement/receipt vocabulary; `degraded_marker` is the
/// rendered [degraded: …] text for fallback rungs.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedRepresentation {
    pub derivation_used: String,
    pub body: String,
    pub degraded: bool,
    pub gap: bool,
    pub degraded_marker: Option<String>,
    pub reason: Option<String>,
}

fn usable(_derivation: Option<&DerivationSnapshot>) -> bool {
    todo!("phase 2")
}

fn ladder_state(_derivation: Option<&DerivationSnapshot>) -> String {
    todo!("phase 2")
}

/// Smooth (turn) ladder: turn_rendering → detailed_turn_compression →
/// deterministic excerpt of the turn's live messages → gap entry.
pub fn resolve_smooth_representation(
    _turn_id: &str,
    _lookup: &DerivationLookup,
    _excerpt: Option<&str>,
) -> ResolvedRepresentation {
    todo!("phase 2")
}

/// Detailed (chunk) ladder: chunk_summary_detailed → chunk_summary_brief →
/// concatenated member smooth compressions (truncated, marked) → gap entry.
pub fn resolve_detailed_representation(
    _chunk_id: &str,
    _lookup: &DerivationLookup,
    _material: Option<&CompactChunkMaterialSnapshot>,
) -> ResolvedRepresentation {
    todo!("phase 2")
}

/// Brief (chunk) ladder: chunk_summary_brief → chunk_summary_detailed
/// truncated → gap entry (no compression rung in this band's ladder).
pub fn resolve_brief_representation(
    _chunk_id: &str,
    _lookup: &DerivationLookup,
    _material: Option<&CompactChunkMaterialSnapshot>,
) -> ResolvedRepresentation {
    todo!("phase 2")
}

/// TS inline `{ blockType: string; content: Record<string, unknown> }` —
/// required fields required (not invented defaults).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcerptBlock {
    pub block_type: String,
    pub content: Map<String, Value>,
}

/// The per-message line an excerpt or note renders — a compact, deterministic
/// excerpt of the raw record (last-rung fallback, not the tail mapping).
pub fn excerpt_line(_kind: &str, _blocks: &[ExcerptBlock]) -> String {
    todo!("phase 2")
}

/// One selected subject → its band-entry text: any attached inter-turn notes
/// (rule 6: rendered raw with the marker, immediately before the entry), then
/// the representation body, [degraded: …] when a fallback rung rendered, or the
/// gap line as the last rung. select.ts prices exactly this text in the fill
/// walk; the band stores exactly this text.
pub fn render_arrangement_entry(
    _subject_kind: ViewSubjectKind,
    _subject_id: &str,
    _rep: &ResolvedRepresentation,
    _note_texts: &[String],
) -> String {
    todo!("phase 2")
}

/// A band's snapshot bytes: its entries oldest-first, blank-line separated.
pub fn assemble_band_text(_entry_texts: &[String]) -> String {
    todo!("phase 2")
}
