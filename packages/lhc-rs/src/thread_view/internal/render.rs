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
//! the band stores: one renderer, no drift. The brief ladder additionally caps
//! its fallback rungs ([`brief_fallback_cap_tokens`]): a failed brief must not
//! cost the band what a full uncompressed body costs.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::snapshot::TailMessageRow;
use crate::shared_tech::derivation::{DerivationState, RenderingPartKind};
use crate::shared_tech::js_json::{
    js_json_stringify, js_len, js_slice, js_string_nullish, js_trim_end,
};
use crate::shared_tech::token_counting::estimate_tokens;
use crate::shared_tech::tool_result_rendering::{FALLBACK_TRUNCATION_LIMIT, truncate_for_fallback};
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
/// TS `` `[compression failed: ~${dropped} tokens of content truncated]` `` —
/// the terminal marker a capped brief fallback ends with.
pub(crate) const LITERAL_COMPRESSION_FAILED_PREFIX: &str = "[compression failed: ~";
pub(crate) const LITERAL_COMPRESSION_FAILED_SUFFIX: &str = " tokens of content truncated]";
/// TS `` `${kept}\n${marker(dropped)}` `` — separator before the marker.
pub(crate) const LITERAL_COMPRESSION_FAILED_JOIN: &str = "\n";
pub(crate) const LITERAL_DERIVATION_GAP: &str = "gap";
pub(crate) const LITERAL_DERIVATION_MESSAGE_EXCERPT: &str = "message_excerpt";
pub(crate) const LITERAL_DERIVATION_STORED_MEMBER_CONCAT: &str = "stored_member_concat";
pub(crate) const LITERAL_DERIVATION_TURN_RENDERING: &str = "turn_rendering";
pub(crate) const LITERAL_DERIVATION_DETAILED_TURN_COMPRESSION: &str = "detailed_turn_compression";
pub(crate) const LITERAL_DERIVATION_CHUNK_SUMMARY_DETAILED: &str = "chunk_summary_detailed";
pub(crate) const LITERAL_DERIVATION_CHUNK_SUMMARY_BRIEF: &str = "chunk_summary_brief";
pub(crate) const LITERAL_LADDER_STATE_ABSENT: &str = "absent";
/// select.ts `derivationState` when the derivation is undefined (coverage path).
#[allow(dead_code)] // TS select.ts vocabulary; coverage path may not hit every literal
pub(crate) const LITERAL_DERIVATION_STATE_MISSING: &str = "missing";
/// select.ts coverage fallback marker.
#[allow(dead_code)]
pub(crate) const LITERAL_FALLBACK_COVERAGE_FROM_PRE_DETAILED_ASSEMBLY: &str =
    "coverage-from-pre-detailed-assembly";
/// select.ts / compact coverage derivation type key.
#[allow(dead_code)]
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

pub fn deterministic_truncation(text: &str) -> String {
    truncate_for_fallback(text)
}

fn block_content(message: &TailMessageRow) -> Map<String, Value> {
    message
        .blocks
        .first()
        .map(|b| b.content.clone())
        .unwrap_or_default()
}

fn text_of(message: &TailMessageRow) -> String {
    match block_content(message).get("text") {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

// Anthropic models running with omitted thinking display emit thinking blocks
// whose text is empty, with the encrypted reasoning carried (if at all) in a
// signature. An empty-text, unsigned block carries nothing a model can use,
// and the two serving exits rendered it divergently (standalone [thinking]
// husk vs empty adjacent part). Skip such rows at serve time only — capture
// and derivations keep them.
//
// Signed empty-text blocks ARE useful on the session-view (PI resume) path,
// where thinkingSignature can be round-tripped to the provider. They are NOT
// useful on the text LLM-request path, which can only emit [thinking] fences.
/// True when `assistant_thinking` has empty/whitespace text and no signature.
pub fn is_empty_thinking_husk(message: &TailMessageRow) -> bool {
    if message.kind != RenderingPartKind::AssistantThinking {
        return false;
    }
    let content = block_content(message);
    let has_text = match content.get("text") {
        Some(Value::String(s)) => !s.trim().is_empty(),
        _ => false,
    };
    let signature = content
        .get("signature")
        .or_else(|| content.get("thinkingSignature"));
    let has_signature = match signature {
        Some(Value::String(s)) => !s.is_empty(),
        _ => false,
    };
    !has_text && !has_signature
}

/// True when thinking has non-empty text (the only form the text LLM path can render).
pub fn has_thinking_text(message: &TailMessageRow) -> bool {
    if message.kind != RenderingPartKind::AssistantThinking {
        return false;
    }
    match block_content(message).get("text") {
        Some(Value::String(s)) => !s.trim().is_empty(),
        _ => false,
    }
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
pub fn tool_names_by_call_id(messages: &[TailMessageRow]) -> IndexMap<String, String> {
    let mut names = IndexMap::new();
    for message in messages {
        if message.kind != RenderingPartKind::ToolCall {
            continue;
        }
        let block = block_content(message);
        let call_id = block.get("toolCallId");
        let tool_name = block.get("toolName");
        if let (Some(Value::String(call_id)), Some(Value::String(tool_name))) = (call_id, tool_name)
        {
            names.insert(call_id.clone(), tool_name.clone());
        }
    }
    names
}

fn render_tool_call(message: &TailMessageRow) -> AssembledContextMessage {
    let block = block_content(message);
    let name = match block.get("toolName") {
        Some(Value::String(s)) => s.as_str(),
        _ => LITERAL_UNKNOWN_TOOL,
    };
    // TS `JSON.stringify(block["arguments"] ?? {})` — nullish → `{}`.
    let args = match block.get("arguments") {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(v) => v.clone(),
    };
    AssembledContextMessage {
        role: AssembledContextRole::Assistant,
        content: format!(
            "{LITERAL_TOOL_CALL_PREFIX}{name}{LITERAL_TOOL_CALL_CLOSE_SPACE}{}",
            js_json_stringify(&args)
        ),
        band: None,
    }
}

fn tool_result_raw_content(message: &TailMessageRow) -> String {
    match block_content(message).get("content") {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// Tool-result body for session loading: full ahead of the boundary, truncated at-or-behind.
pub fn tool_result_session_content(message: &TailMessageRow, ctx: &TailRenderContext) -> String {
    let content = tool_result_raw_content(message);
    if message.source_event_order > ctx.boundary_position {
        content
    } else {
        deterministic_truncation(&content)
    }
}

fn render_tool_result(
    message: &TailMessageRow,
    ctx: &TailRenderContext,
) -> AssembledContextMessage {
    let block = block_content(message);
    let name = match block.get("toolCallId") {
        Some(Value::String(call_id)) => ctx
            .tool_name_by_call_id
            .get(call_id)
            .map(String::as_str)
            .unwrap_or(LITERAL_UNKNOWN_TOOL),
        _ => LITERAL_UNKNOWN_TOOL,
    };
    if message.source_event_order > ctx.boundary_position {
        AssembledContextMessage {
            role: AssembledContextRole::User,
            content: format!(
                "{LITERAL_TOOL_RESULT_PREFIX}{name}{LITERAL_TOOL_RESULT_CLOSE}\n{}",
                tool_result_raw_content(message)
            ),
            band: None,
        }
    } else {
        let short = deterministic_truncation(&tool_result_raw_content(message));
        AssembledContextMessage {
            role: AssembledContextRole::User,
            content: format!(
                "{LITERAL_TOOL_RESULT_PREFIX}{name}{LITERAL_TOOL_RESULT_ABRIDGED_MID}\n{short}"
            ),
            band: None,
        }
    }
}

/// One tail message → one assembled message per the mapping table. Each kind is its
/// own arm so a single kind's drift fails its own named test leg.
pub fn render_tail_message(
    message: &TailMessageRow,
    ctx: &TailRenderContext,
) -> AssembledContextMessage {
    match message.kind {
        RenderingPartKind::UserPrompt => AssembledContextMessage {
            role: AssembledContextRole::User,
            content: text_of(message),
            band: None,
        },
        RenderingPartKind::AssistantText => AssembledContextMessage {
            role: AssembledContextRole::Assistant,
            content: text_of(message),
            band: None,
        },
        RenderingPartKind::AssistantThinking => {
            // Included: the tail is full fidelity (bands compress thinking away for
            // older turns); harness-side conversion may re-block or drop.
            AssembledContextMessage {
                role: AssembledContextRole::Assistant,
                content: format!(
                    "{LITERAL_THINKING_OPEN}{}{LITERAL_THINKING_CLOSE}",
                    text_of(message)
                ),
                band: None,
            }
        }
        RenderingPartKind::ToolCall => render_tool_call(message),
        RenderingPartKind::ToolResult => render_tool_result(message, ctx),
        RenderingPartKind::RuntimeNote => AssembledContextMessage {
            role: AssembledContextRole::User,
            content: format!("{LITERAL_RUNTIME_NOTE_PREFIX}{}", text_of(message)),
            band: None,
        },
        RenderingPartKind::ModelChange => {
            let block = message
                .blocks
                .first()
                .map(|b| &b.content)
                .cloned()
                .unwrap_or_default();
            AssembledContextMessage {
                role: AssembledContextRole::User,
                content: format!(
                    "{LITERAL_MODEL_CHANGE_PREFIX}{}{LITERAL_MODEL_CHANGE_ARROW}{}",
                    js_string_nullish(block.get("previousModel")),
                    js_string_nullish(block.get("newModel"))
                ),
                band: None,
            }
        }
        RenderingPartKind::ThinkingLevelChange => {
            let block = message
                .blocks
                .first()
                .map(|b| &b.content)
                .cloned()
                .unwrap_or_default();
            AssembledContextMessage {
                role: AssembledContextRole::User,
                content: format!(
                    "{LITERAL_THINKING_LEVEL_CHANGE_PREFIX}{}{LITERAL_MODEL_CHANGE_ARROW}{}",
                    js_string_nullish(block.get("previousLevel")),
                    js_string_nullish(block.get("newLevel"))
                ),
                band: None,
            }
        }
    }
}

/// One non-empty band to one labeled `user` message: band-marker header, then
/// the snapshot bytes verbatim. Inference APIs reject unknown roles.
pub fn render_band_message(band: Band, rendered_text: &str) -> AssembledContextMessage {
    AssembledContextMessage {
        role: AssembledContextRole::User,
        band: Some(band),
        content: format!(
            "{LITERAL_CONTEXT_PREFIX}{}{LITERAL_CONTEXT_MID}{rendered_text}",
            band.as_str()
        ),
    }
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

fn usable(derivation: Option<&DerivationSnapshot>) -> bool {
    // "Usable" means state = ready.
    matches!(
        derivation,
        Some(DerivationSnapshot {
            state: DerivationState::Ready,
            content: Some(_),
            ..
        })
    )
}

fn ladder_state(derivation: Option<&DerivationSnapshot>) -> String {
    match derivation {
        None => LITERAL_LADDER_STATE_ABSENT.to_string(),
        Some(d) => d.state.as_str().to_string(),
    }
}

/// Smooth (turn) ladder: turn_rendering → detailed_turn_compression →
/// deterministic excerpt of the turn's live messages → gap entry.
pub fn resolve_smooth_representation(
    turn_id: &str,
    lookup: &DerivationLookup,
    excerpt: Option<&str>,
) -> ResolvedRepresentation {
    let rendering = lookup(turn_id, LITERAL_DERIVATION_TURN_RENDERING);
    if usable(rendering.as_ref()) {
        return ResolvedRepresentation {
            derivation_used: LITERAL_DERIVATION_TURN_RENDERING.to_string(),
            body: rendering.unwrap().content.unwrap(),
            degraded: false,
            gap: false,
            degraded_marker: None,
            reason: None,
        };
    }
    let compression = lookup(turn_id, LITERAL_DERIVATION_DETAILED_TURN_COMPRESSION);
    if usable(compression.as_ref()) {
        return ResolvedRepresentation {
            derivation_used: LITERAL_DERIVATION_DETAILED_TURN_COMPRESSION.to_string(),
            body: compression.unwrap().content.unwrap(),
            degraded: true,
            gap: false,
            degraded_marker: Some(LITERAL_FALLBACK_SMOOTH_FROM_COMPRESSION.to_string()),
            reason: None,
        };
    }
    if let Some(excerpt) = excerpt {
        return ResolvedRepresentation {
            derivation_used: LITERAL_DERIVATION_MESSAGE_EXCERPT.to_string(),
            body: deterministic_truncation(excerpt),
            degraded: true,
            gap: false,
            degraded_marker: Some(LITERAL_FALLBACK_SMOOTH_FROM_EXCERPT.to_string()),
            reason: None,
        };
    }
    ResolvedRepresentation {
        derivation_used: LITERAL_DERIVATION_GAP.to_string(),
        body: String::new(),
        degraded: false,
        gap: true,
        degraded_marker: None,
        reason: Some(format!(
            "{DIAG_NO_USABLE_DERIVATION_OPEN}{DIAG_FALLBACK_SMOOTH_TURN_RENDERING_LABEL}{}{DIAG_FALLBACK_SMOOTH_DETAILED_SEP}{}{DIAG_FALLBACK_SMOOTH_NO_LIVE_MESSAGES_CLOSE}",
            ladder_state(rendering.as_ref()),
            ladder_state(compression.as_ref())
        )),
    }
}

/// Detailed (chunk) ladder: chunk_summary_detailed → chunk_summary_brief →
/// concatenated member smooth compressions (truncated, marked) → gap entry.
pub fn resolve_detailed_representation(
    chunk_id: &str,
    lookup: &DerivationLookup,
    material: Option<&CompactChunkMaterialSnapshot>,
) -> ResolvedRepresentation {
    let detailed = lookup(chunk_id, LITERAL_DERIVATION_CHUNK_SUMMARY_DETAILED);
    if usable(detailed.as_ref()) {
        return ResolvedRepresentation {
            derivation_used: LITERAL_DERIVATION_CHUNK_SUMMARY_DETAILED.to_string(),
            body: detailed.unwrap().content.unwrap(),
            degraded: false,
            gap: false,
            degraded_marker: None,
            reason: None,
        };
    }
    if let Some(CompactChunkMaterialSnapshot::Ready { content }) = material {
        return ResolvedRepresentation {
            derivation_used: LITERAL_DERIVATION_CHUNK_SUMMARY_DETAILED.to_string(),
            body: content.clone(),
            degraded: false,
            gap: false,
            degraded_marker: None,
            reason: None,
        };
    }
    if let Some(CompactChunkMaterialSnapshot::Concat { content, reason }) = material {
        return ResolvedRepresentation {
            derivation_used: LITERAL_DERIVATION_STORED_MEMBER_CONCAT.to_string(),
            body: content.clone(),
            degraded: true,
            gap: false,
            degraded_marker: Some(LITERAL_FALLBACK_DETAILED_FROM_STORED_MEMBERS.to_string()),
            reason: Some(reason.clone()),
        };
    }
    ResolvedRepresentation {
        derivation_used: LITERAL_DERIVATION_GAP.to_string(),
        body: String::new(),
        degraded: false,
        gap: true,
        degraded_marker: None,
        reason: Some(format!(
            "{DIAG_NO_USABLE_DERIVATION_OPEN}{DIAG_FALLBACK_DETAILED_LABEL}{}{DIAG_FALLBACK_COMPACT_MATERIAL_ABSENT_CLOSE}",
            ladder_state(detailed.as_ref())
        )),
    }
}

/// The size floor a failed brief may cost: 5% of the brief band's own budget,
/// never below 200 tokens. A brief derivation exists to be small; when it fails
/// the ladder falls back to material sized for a different purpose (member
/// concat, i.e. raw turn text), and an uncompressed fallback that large is what
/// let one chunk consume the band. The floor is on the fallback only — a ready
/// brief is whatever the deriver made it.
pub fn brief_fallback_cap_tokens(brief_band_budget: f64) -> f64 {
    (brief_band_budget * 0.05).max(200.0)
}

/// Character-level shrink priced by the same estimator the fill walk budgets
/// with, so the entry's reported size is its true size: start from the body's
/// own chars-per-token ratio, then step down until the kept text plus its
/// terminal marker prices at or under the cap.
///
/// Character indices are JS `String` indices (UTF-16 code units) via
/// [`js_len`] / [`js_slice`], and `trimEnd` is [`js_trim_end`] — the loop must
/// step identically to the TS reference on every input.
fn cap_fallback_body(body: &str, cap_tokens: f64) -> String {
    let body_tokens = estimate_tokens(body);
    if (body_tokens as f64) <= cap_tokens {
        return body.to_string();
    }
    let marker = |dropped: i64| -> String {
        format!("{LITERAL_COMPRESSION_FAILED_PREFIX}{dropped}{LITERAL_COMPRESSION_FAILED_SUFFIX}")
    };
    let mut keep: i64 =
        (((js_len(body) as f64) / (body_tokens as f64)) * cap_tokens).floor() as i64;
    loop {
        let kept = js_trim_end(&js_slice(body, 0, Some(keep))).to_string();
        let dropped = (body_tokens - estimate_tokens(&kept)).max(0);
        let capped = if kept.is_empty() {
            marker(dropped)
        } else {
            format!("{kept}{LITERAL_COMPRESSION_FAILED_JOIN}{}", marker(dropped))
        };
        if keep == 0 || (estimate_tokens(&capped) as f64) <= cap_tokens {
            return capped;
        }
        keep = (keep - 1).min((keep as f64 * 0.9).floor() as i64).max(0);
    }
}

/// Brief (chunk) ladder: chunk_summary_brief → chunk_summary_detailed
/// truncated → gap entry (no compression rung in this band's ladder). Every
/// fallback rung is capped by the failure floor; the ready rungs never are.
///
/// Rungs, in order: a ready `chunk_summary_brief` derivation (ready — never
/// capped); a `ready` compact chunk-material snapshot, which is a stored ready
/// brief (ready — never capped); a `concat` compact chunk-material snapshot,
/// i.e. raw member text standing in for the failed brief (fallback — capped);
/// the gap entry, whose body is empty (nothing to cap).
pub fn resolve_brief_representation(
    chunk_id: &str,
    lookup: &DerivationLookup,
    brief_band_budget: f64,
    material: Option<&CompactChunkMaterialSnapshot>,
) -> ResolvedRepresentation {
    let brief = lookup(chunk_id, LITERAL_DERIVATION_CHUNK_SUMMARY_BRIEF);
    if usable(brief.as_ref()) {
        return ResolvedRepresentation {
            derivation_used: LITERAL_DERIVATION_CHUNK_SUMMARY_BRIEF.to_string(),
            body: brief.unwrap().content.unwrap(),
            degraded: false,
            gap: false,
            degraded_marker: None,
            reason: None,
        };
    }
    if let Some(CompactChunkMaterialSnapshot::Ready { content }) = material {
        return ResolvedRepresentation {
            derivation_used: LITERAL_DERIVATION_CHUNK_SUMMARY_BRIEF.to_string(),
            body: content.clone(),
            degraded: false,
            gap: false,
            degraded_marker: None,
            reason: None,
        };
    }
    if let Some(CompactChunkMaterialSnapshot::Concat { content, reason }) = material {
        return ResolvedRepresentation {
            derivation_used: LITERAL_DERIVATION_STORED_MEMBER_CONCAT.to_string(),
            body: cap_fallback_body(content, brief_fallback_cap_tokens(brief_band_budget)),
            degraded: true,
            gap: false,
            degraded_marker: Some(LITERAL_FALLBACK_BRIEF_FROM_STORED_MEMBERS.to_string()),
            reason: Some(reason.clone()),
        };
    }
    ResolvedRepresentation {
        derivation_used: LITERAL_DERIVATION_GAP.to_string(),
        body: String::new(),
        degraded: false,
        gap: true,
        degraded_marker: None,
        reason: Some(format!(
            "{DIAG_NO_USABLE_DERIVATION_OPEN}{DIAG_FALLBACK_BRIEF_LABEL}{}{DIAG_FALLBACK_COMPACT_MATERIAL_ABSENT_CLOSE}",
            ladder_state(brief.as_ref())
        )),
    }
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
pub fn excerpt_line(kind: &str, blocks: &[ExcerptBlock]) -> String {
    let content = blocks.first().map(|b| &b.content);
    let empty = Map::new();
    let content = content.unwrap_or(&empty);
    let text = match content.get("text") {
        Some(Value::String(s)) => s.as_str(),
        _ => "",
    };
    match kind {
        "tool_call" => {
            let name = match content.get("toolName") {
                Some(Value::String(s)) => s.as_str(),
                _ => LITERAL_UNKNOWN_TOOL,
            };
            format!("{LITERAL_TOOL_CALL_PREFIX}{name}{LITERAL_TOOL_RESULT_CLOSE}")
        }
        "tool_result" => LITERAL_EXCERPT_TOOL_RESULT.to_string(),
        _ => text.to_string(),
    }
}

/// One selected subject → its band-entry text: any attached inter-turn notes
/// (rule 6: rendered raw with the marker, immediately before the entry), then
/// the representation body, [degraded: …] when a fallback rung rendered, or the
/// gap line as the last rung. select.ts prices exactly this text in the fill
/// walk; the band stores exactly this text.
pub fn render_arrangement_entry(
    subject_kind: ViewSubjectKind,
    _subject_id: &str,
    rep: &ResolvedRepresentation,
    note_texts: &[String],
) -> String {
    let mut lines: Vec<String> = note_texts
        .iter()
        .map(|text| format!("{LITERAL_INTER_TURN_NOTE_PREFIX}{text}"))
        .collect();
    if rep.gap {
        lines.push(format!(
            "{LITERAL_GAP_OPEN}{}{LITERAL_GAP_UNAVAILABLE_MID}{}{LITERAL_TOOL_RESULT_CLOSE}",
            subject_kind.as_str(),
            rep.reason.as_deref().unwrap_or(LITERAL_GAP_UNKNOWN_REASON)
        ));
    } else {
        let marker = if rep.degraded {
            format!(
                "{LITERAL_DEGRADED_PREFIX}{}{LITERAL_DEGRADED_CLOSE}",
                rep.degraded_marker
                    .as_deref()
                    .unwrap_or(rep.derivation_used.as_str())
            )
        } else {
            String::new()
        };
        lines.push(format!("{marker}{}", rep.body));
    }
    lines.join(LITERAL_ARRANGEMENT_ENTRY_JOIN)
}

/// A band's snapshot bytes: its entries oldest-first, blank-line separated.
pub fn assemble_band_text(entry_texts: &[String]) -> String {
    entry_texts.join(LITERAL_BAND_TEXT_JOIN)
}
