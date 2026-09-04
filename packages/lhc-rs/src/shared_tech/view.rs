//! Ported from packages/lhc/src/shared-tech/view.ts. Phase 1 skeleton.
//!
//! Shared thread-view vocabulary. Shared so CLI, SDK, and tests import one
//! home; the thread-view domain owns behavior, this module owns only shapes.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Band {
    Brief,
    Detailed,
    Smooth,
}

impl Band {
    pub fn as_str(self) -> &'static str {
        match self {
            Band::Brief => "brief",
            Band::Detailed => "detailed",
            Band::Smooth => "smooth",
        }
    }
}

/// Arrangement / gap subject kinds on a stored view — subset of derivation
/// SubjectKind (chunk | turn only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewSubjectKind {
    Chunk,
    Turn,
}

impl ViewSubjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ViewSubjectKind::Chunk => "chunk",
            ViewSubjectKind::Turn => "turn",
        }
    }
}

/// Amendment I — TS `number` band shares (fractional-capable).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewProfilePercentages {
    pub full: f64,
    pub smooth: f64,
    pub detailed: f64,
    pub brief: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewProfile {
    pub name: String,
    /// Target assembled size; whole-entry fills may land under or over because
    /// the bound is a target, not a cap. Amendment I: TS `number` (fractional).
    pub lower_bound: f64,
    /// Band shares of the lower bound; must sum to 100.
    pub percentages: ViewProfilePercentages,
    /// Newest-closed-turn protection (turn parts, Flow 5): the fraction of the
    /// lower bound the newest closed turn may cost and still be kept full,
    /// after the active turn's minimum verbatim tail is reserved. 0 disables.
    pub newest_closed_protection: f64,
}

/// Partial\<ViewProfile\["percentages"\]\> — each band share individually optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialViewProfilePercentages {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smooth: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detailed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brief: Option<f64>,
}

/// A user profile entry as configured: a full profile under a new name, or a
/// field-wise override of a built-in merged by name. A partial entry
/// whose name matches no built-in has nothing to merge over and is rejected at
/// construction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewProfileOverride {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lower_bound: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percentages: Option<PartialViewProfilePercentages>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest_closed_protection: Option<f64>,
}

/// Compact-time explicit parameters: field-wise overrides of the base profile,
/// down to single band percentages — the same depth the CLI's per-band flags
/// override at.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewCompactParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lower_bound: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percentages: Option<PartialViewProfilePercentages>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest_closed_protection: Option<f64>,
}

/// Visibility-boundary budgets: max > target, both positive. Intake no longer
/// advances the boundary automatically; the budgets still shape status and any
/// future explicit pressure policy that reads the visibility zone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibilityBudgets {
    /// TS `number` — positive finite; may be fractional.
    pub max_tokens: f64,
    /// TS `number` — positive finite; may be fractional.
    pub target_tokens: f64,
}

/// Partial\<VisibilityBudgets\> — every field optional at SdkViewConfig.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialVisibilityBudgets {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_tokens: Option<f64>,
}

// ── SDK assembly config ──────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkViewConfig {
    /// merged over built-ins by name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profiles: Option<Vec<ViewProfileOverride>>,
    /// defaults: 64000 / 32000
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<PartialVisibilityBudgets>,
    /// status trigger; default 160000 — TS `number` (positive finite).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_threshold: Option<f64>,
}

/// Every optional filled by initLhc's central defaults; profiles resolved
/// to complete, validated entries keyed by name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedViewConfig {
    /// Insertion-ordered — profile merge/iteration order matches host config order.
    pub profiles: IndexMap<String, ViewProfile>,
    pub visibility: VisibilityBudgets,
    pub compact_threshold: f64,
}

// ── model-context / status shapes (the product crossing to the harness) ────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LlmRequestContextPartType {
    Text,
}

impl LlmRequestContextPartType {
    pub fn as_str(self) -> &'static str {
        match self {
            LlmRequestContextPartType::Text => "text",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmRequestContextPart {
    #[serde(rename = "type")]
    pub type_: LlmRequestContextPartType,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LlmRequestContextRole {
    User,
    Assistant,
}

impl LlmRequestContextRole {
    pub fn as_str(self) -> &'static str {
        match self {
            LlmRequestContextRole::User => "user",
            LlmRequestContextRole::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmRequestContextMessage {
    pub role: LlmRequestContextRole,
    pub content: Vec<LlmRequestContextPart>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmRequestContext {
    pub thread_id: String,
    pub messages: Vec<LlmRequestContextMessage>,
}

// PI SessionManager-friendly message shapes built from canonical LHC record
// data. The host maps these to its session append API.

/// LHC's three part kinds, or the API's name for a block LHC holds verbatim
/// (redacted_thinking, server_tool_use, the server-side *_tool_result
/// blocks); those carry the block itself in `block`. TS
/// `"text" | "thinking" | "toolCall" | ApiBlockType` (`text` / `thinking`
/// spell the same in both sets).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionAssistantPartType {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "thinking")]
    Thinking,
    #[serde(rename = "toolCall")]
    ToolCall,
    #[serde(rename = "image")]
    Image,
    #[serde(rename = "document")]
    Document,
    #[serde(rename = "tool_use")]
    ToolUse,
    #[serde(rename = "tool_result")]
    ToolResult,
    #[serde(rename = "redacted_thinking")]
    RedactedThinking,
    #[serde(rename = "server_tool_use")]
    ServerToolUse,
    #[serde(rename = "web_search_tool_result")]
    WebSearchToolResult,
    #[serde(rename = "web_fetch_tool_result")]
    WebFetchToolResult,
    #[serde(rename = "code_execution_tool_result")]
    CodeExecutionToolResult,
    #[serde(rename = "bash_code_execution_tool_result")]
    BashCodeExecutionToolResult,
    #[serde(rename = "text_editor_code_execution_tool_result")]
    TextEditorCodeExecutionToolResult,
    #[serde(rename = "tool_search_tool_result")]
    ToolSearchToolResult,
    #[serde(rename = "search_result")]
    SearchResult,
    #[serde(rename = "container_upload")]
    ContainerUpload,
    #[serde(rename = "tool_reference")]
    ToolReference,
}

impl SessionAssistantPartType {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionAssistantPartType::Text => "text",
            SessionAssistantPartType::Thinking => "thinking",
            SessionAssistantPartType::ToolCall => "toolCall",
            SessionAssistantPartType::Image => "image",
            SessionAssistantPartType::Document => "document",
            SessionAssistantPartType::ToolUse => "tool_use",
            SessionAssistantPartType::ToolResult => "tool_result",
            SessionAssistantPartType::RedactedThinking => "redacted_thinking",
            SessionAssistantPartType::ServerToolUse => "server_tool_use",
            SessionAssistantPartType::WebSearchToolResult => "web_search_tool_result",
            SessionAssistantPartType::WebFetchToolResult => "web_fetch_tool_result",
            SessionAssistantPartType::CodeExecutionToolResult => "code_execution_tool_result",
            SessionAssistantPartType::BashCodeExecutionToolResult => {
                "bash_code_execution_tool_result"
            }
            SessionAssistantPartType::TextEditorCodeExecutionToolResult => {
                "text_editor_code_execution_tool_result"
            }
            SessionAssistantPartType::ToolSearchToolResult => "tool_search_tool_result",
            SessionAssistantPartType::SearchResult => "search_result",
            SessionAssistantPartType::ContainerUpload => "container_upload",
            SessionAssistantPartType::ToolReference => "tool_reference",
        }
    }

    const API_NAMED: [SessionAssistantPartType; 18] = [
        SessionAssistantPartType::Text,
        SessionAssistantPartType::Thinking,
        SessionAssistantPartType::Image,
        SessionAssistantPartType::Document,
        SessionAssistantPartType::ToolUse,
        SessionAssistantPartType::ToolResult,
        SessionAssistantPartType::RedactedThinking,
        SessionAssistantPartType::ServerToolUse,
        SessionAssistantPartType::WebSearchToolResult,
        SessionAssistantPartType::WebFetchToolResult,
        SessionAssistantPartType::CodeExecutionToolResult,
        SessionAssistantPartType::BashCodeExecutionToolResult,
        SessionAssistantPartType::TextEditorCodeExecutionToolResult,
        SessionAssistantPartType::ToolSearchToolResult,
        SessionAssistantPartType::SearchResult,
        SessionAssistantPartType::ContainerUpload,
        SessionAssistantPartType::ToolReference,
        SessionAssistantPartType::ToolCall,
    ];

    /// The part type spelled by a Messages API block `type` name.
    pub fn from_api_type(name: &str) -> Option<SessionAssistantPartType> {
        SessionAssistantPartType::API_NAMED
            .into_iter()
            .find(|t| t.as_str() == name && *t != SessionAssistantPartType::ToolCall)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAssistantPart {
    #[serde(rename = "type")]
    pub type_: SessionAssistantPartType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// Opaque provider thinking token (PI `thinkingSignature`). Round-tripped only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<serde_json::Map<String, serde_json::Value>>,
    /// The Messages API block, blob payloads inlined (base64 back in place).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionThreadViewEntrySource {
    pub message_id: String,
    pub idempotency_key: Option<String>,
}

/// TS `SessionUserMessage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUserMessage {
    /// Text-shaped content: the text blocks, with a placeholder where each non-text block sits.
    pub content: String,
    /// Present when the prompt carried blocks beyond text: the full Messages API
    /// content array in order, blob payloads inlined. Hosts that replay the real
    /// blocks use this; hosts that only speak text use `content`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<serde_json::Map<String, serde_json::Value>>>,
    pub source_messages: Vec<SessionThreadViewEntrySource>,
}

/// TS `SessionAssistantMessage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAssistantMessage {
    pub content: Vec<SessionAssistantPart>,
    /// One row per grouped LHC message, in part order.
    pub source_messages: Vec<SessionThreadViewEntrySource>,
    /// Host-captured model identity for PI same-model signature replay.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
}

/// TS `SessionToolResultMessage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionToolResultMessage {
    pub tool_call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Text-shaped content (placeholders for non-text blocks); abridged at or behind the boundary.
    pub content: String,
    /// The result's Messages API content array with blob payloads inlined, only
    /// ahead of the boundary (an abridged result is text).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<serde_json::Map<String, serde_json::Value>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    pub source_messages: Vec<SessionThreadViewEntrySource>,
}

/// Message arms of SessionThreadViewEntry — discriminated by `role`
/// (`"user"` | `"assistant"` | `"toolResult"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role")]
pub enum SessionThreadViewMessage {
    #[serde(rename = "user")]
    User(SessionUserMessage),
    #[serde(rename = "assistant")]
    Assistant(SessionAssistantMessage),
    #[serde(rename = "toolResult")]
    ToolResult(SessionToolResultMessage),
}

/// TS `SessionModelChangeEntry` — `kind: "model_change"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelChangeEntry {
    pub provider: String,
    pub model_id: String,
    pub source_messages: Vec<SessionThreadViewEntrySource>,
}

/// TS `SessionThinkingLevelChangeEntry` — `kind: "thinking_level_change"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionThinkingLevelChangeEntry {
    pub level: String,
    pub source_messages: Vec<SessionThreadViewEntrySource>,
}

/// Runtime-change arms — serde-tagged on `kind` with byte-exact discriminants
/// matching TS (`"model_change"`, `"thinking_level_change"`).
///
/// Thin tagged wrapper over the TS-named entry structs (not a separate invention).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum SessionThreadViewRuntimeEntry {
    #[serde(rename = "model_change")]
    ModelChange(SessionModelChangeEntry),
    #[serde(rename = "thinking_level_change")]
    ThinkingLevelChange(SessionThinkingLevelChangeEntry),
}

/// TS SessionThreadViewEntry — mixed tag fields (`role` vs `kind`).
/// Untagged outer; Runtime tried first so `kind` discriminants win over `role`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SessionThreadViewEntry {
    Runtime(SessionThreadViewRuntimeEntry),
    Message(SessionThreadViewMessage),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionThreadView {
    pub thread_id: String,
    pub entries: Vec<SessionThreadViewEntry>,
}

/// One part's step range, in host step indices (turn parts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartRange {
    pub from_step: i64,
    pub to_step: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredViewArrangementEntry {
    pub band: Band,
    pub subject_kind: ViewSubjectKind,
    pub subject_id: String,
    pub derivation_used: String,
    pub degraded: bool,
    /// Present only on a part entry (turn parts): the contiguous step range of
    /// the single transition turn this entry renders. Its presence in the
    /// installed view is what makes that turn unsettled; absence everywhere
    /// means every served turn is whole.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part: Option<PartRange>,
}

/// Host metadata surface (turn parts, AC-7.1): the deterministic,
/// inference-free reads a host's pressure decision needs. `active_turn` comes
/// from the record (the open turn and its host-supplied step indices);
/// `unsettled_turn` comes from the installed view (a turn served as parts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMetadata {
    pub active_turn: Option<HostMetadataActiveTurn>,
    pub unsettled_turn: Option<HostMetadataUnsettledTurn>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMetadataActiveTurn {
    pub turn_id: String,
    /// Sum of stored member token estimates.
    pub estimated_tokens: i64,
    /// Leading run of complete steps (every tool_call paired inside its step).
    pub complete_steps: i64,
    /// Newest admissible split point as an ORDINAL k — the number of leading
    /// steps a part may cover (1..completeSteps−1), not a host step index — or
    /// None when no split is admissible: fewer than two complete steps, or the
    /// turn is not splittable (a member with no step index, or inconsistent
    /// indices). The receipt's splitPoint.stepIndex is the host index instead.
    pub last_step_edge: Option<i64>,
    pub splittable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMetadataUnsettledTurn {
    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredViewGap {
    pub band: Band,
    pub subject_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredViewConfig {
    /// Token-count target (Amendment I: TS `number`, fractional-capable).
    pub lower_bound: f64,
    /// `Record<string, number>` — insertion-ordered (JSON.stringify contract).
    pub percentages: IndexMap<String, f64>,
    /// Placement provenance (turn parts): the protection fraction the walk
    /// ran under. Optional for views written before it existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest_closed_protection: Option<f64>,
}

/// Judgment: TS declares `derivationCounts: Record<string, number>`
/// (view.ts:160) but the compact snapshot persists nested
/// type→state→count maps. Follow lhc-py's nested shape for round-trip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredViewSourceState {
    pub max_event_order: i64,
    /// Nested type → state → count; both levels insertion-ordered.
    pub derivation_counts: IndexMap<String, IndexMap<String, i64>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredViewBand {
    pub band: Band,
    pub stored_tokens: i64,
}

/// The stored active view row as `threadView.describe` exposes it: snapshot
/// fields verbatim — arrangement, gaps, config, source-state provenance, and
/// per-band stored token counts — never recomputed, never repaired. Absent view
/// means describe returns ok/null, mirroring status's never-compacted behavior.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredView {
    pub view_id: String,
    pub created_at: String,
    pub compact_point: i64,
    pub covered_from: i64,
    /// null when explicit params overrode a named base at compact (the stored
    /// config carries the resolved truth either way).
    pub profile_name: Option<String>,
    pub config: StoredViewConfig,
    /// Every selected entry in served order, gap entries included (they are
    /// arrangement rows too; `gaps` carries their reasons).
    pub arrangement: Vec<StoredViewArrangementEntry>,
    pub gaps: Vec<StoredViewGap>,
    /// What the compact saw, stored verbatim.
    pub source_state: StoredViewSourceState,
    /// Non-empty bands in gradient order with their stored token counts.
    pub bands: Vec<StoredViewBand>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewStatusDerivation {
    pub pending: i64,
    pub failed: i64,
    pub blocked: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewStatusView {
    pub degraded: i64,
    pub gaps: i64,
    pub built_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewStatusVisibility {
    pub boundary_position: i64,
    pub zone_tokens: i64,
    /// From configured visibility.maxTokens (TS `number`, may be fractional).
    pub max_tokens: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewStatus {
    pub tail_tokens: i64,
    /// From configured compactThreshold (TS `number`, may be fractional).
    pub threshold: f64,
    pub compact_recommended: bool,
    pub derivation: ViewStatusDerivation,
    pub view: Option<ViewStatusView>,
    pub visibility: ViewStatusVisibility,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneReceipt {
    pub previous_boundary: i64,
    pub new_boundary: i64,
    pub compact_point: i64,
    /// Validated integer prune target, or configured visibility.targetTokens
    /// (which may be fractional) on the default path — TS `number`.
    pub target_tokens: f64,
    pub tool_results_pruned: i64,
    pub tokens_behind_boundary: i64,
    pub zone_tokens_before: i64,
    pub zone_tokens_after: i64,
    pub no_op: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCompactResult {
    pub compact_point: i64,
    pub would_produce_bands: bool,
    pub tail_tokens: i64,
    pub first_kept_message_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum PreviewCompactOutcome {
    #[serde(rename = "ok")]
    Ok { preview: PreviewCompactResult },
    #[serde(rename = "error")]
    Error { reason: String },
}

// ── receipts ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactBandStats {
    pub entries: i64,
    pub tokens: i64,
}

/// `Record<Band, { entries, tokens }>` — closed Band set as named fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CompactReceiptBands {
    pub brief: CompactBandStats,
    pub detailed: CompactBandStats,
    pub smooth: CompactBandStats,
}

/// ViewProfile percentages & { lowerBound }. Amendment I: all five are `f64`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactReceiptConfig {
    pub full: f64,
    pub smooth: f64,
    pub detailed: f64,
    pub brief: f64,
    pub lower_bound: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest_closed_protection: Option<f64>,
}

/// Turn parts (receipt): one served part.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptPart {
    pub turn_id: String,
    pub from_step: i64,
    pub to_step: i64,
}

/// (turn, step) precision (AC-1.7): `step_index` is the HOST step index of
/// the newest step inside the served parts (the last part's toStep), not the
/// ordinal k that HostMetadata.lastStepEdge reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitPoint {
    pub turn_id: String,
    pub step_index: i64,
}

/// The whole construction that settled a previously split turn: the stored
/// rendering row it used, or the composed-in-walk marker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SettleConstruction {
    Stored {
        subject_id: String,
        derivation_type: String,
        source_version: i64,
    },
    ComposedInWalk {
        turn_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettledTurn {
    pub turn_id: String,
    pub construction: SettleConstruction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProtectedRepresentation {
    Full,
    WholeRendering,
}

impl ProtectedRepresentation {
    pub fn as_str(self) -> &'static str {
        match self {
            ProtectedRepresentation::Full => "full",
            ProtectedRepresentation::WholeRendering => "whole_rendering",
        }
    }
}

/// Newest-closed-turn placement (Flow 5): kept full (verbatim) within the
/// protection bound, or served by its whole deterministic rendering — never
/// an excerpt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedTurn {
    pub turn_id: String,
    pub representation: ProtectedRepresentation,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactDegradedEntry {
    pub band: Band,
    pub subject_id: String,
    pub used_derivation: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactGapEntry {
    pub band: Band,
    pub subject_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactWarningDerivationType {
    ChunkSummaryDetailed,
    ChunkSummaryBrief,
}

impl CompactWarningDerivationType {
    pub fn as_str(self) -> &'static str {
        match self {
            CompactWarningDerivationType::ChunkSummaryDetailed => "chunk_summary_detailed",
            CompactWarningDerivationType::ChunkSummaryBrief => "chunk_summary_brief",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactWarning {
    pub band: Band,
    pub subject_id: String,
    pub derivation_type: CompactWarningDerivationType,
    pub reason: String,
}

/// Canonical record the compact walk could not place. The raw row is retained.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SkippedRecord {
    OrphanedMessage {
        message_id: String,
        turn_id: String,
        reason: String,
    },
    DanglingChunkMember {
        chunk_id: String,
        turn_id: String,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactRenderedBand {
    pub band: Band,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactReceipt {
    pub view_id: String,
    pub profile: Option<String>,
    pub config: CompactReceiptConfig,
    pub bands: CompactReceiptBands,
    pub tail_tokens: i64,
    /// The assembled view's actual total (band tokens + tail tokens) against
    /// the configured lower bound — a target, not a cap: whole-entry fills may
    /// land under it, indivisible entries over it.
    pub total_tokens: i64,
    pub covered_from: i64,
    pub compact_point: i64,
    pub degraded: Vec<CompactDegradedEntry>,
    pub gaps: Vec<CompactGapEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<CompactWarning>>,
    pub skipped_records: Vec<SkippedRecord>,
    pub rendered_bands: Vec<CompactRenderedBand>,
    pub first_kept_message_id: Option<String>,
    /// Turn parts (present only when the installed view serves parts).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<ReceiptPart>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split_point: Option<SplitPoint>,
    /// Present when this compact settled a previously split turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled: Option<SettledTurn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protected_turn: Option<ProtectedTurn>,
}
