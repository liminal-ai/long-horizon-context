//! Ported from packages/lhc/src/shared-tech/inspect.ts. Phase 1 skeleton.
//!
//! Inspect report shapes. Inspect is a pure consumer: these shapes carry other
//! domains' surface output composed into counts and summaries; nothing here is
//! re-derived or re-interpreted beyond the owners' reported states.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::view::{Band, ViewSubjectKind};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectOverviewThread {
    pub id: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<IndexMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectOverviewEventsSpan {
    pub first: i64,
    pub last: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectOverviewEvents {
    pub count: i64,
    /// span null means count 0: absent pieces report as zeros/nulls.
    pub span: Option<InspectOverviewEventsSpan>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectOverviewMessages {
    /// Deleted messages appear only in `deleted`: excluded from visible, byKind,
    /// and visibleTokens. Event counts above are unaffected because the record
    /// retains everything.
    pub visible: i64,
    /// Insertion-ordered kind → count (report JSON order is observable).
    pub by_kind: IndexMap<String, i64>,
    pub deleted: i64,
    pub visible_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectOverviewTurns {
    pub open: i64,
    pub closed: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectOverviewChunks {
    pub count: i64,
    pub unchunked_turns: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectOverviewDerivation {
    /// Counts by operational state across both owners' report surfaces; ready
    /// included, unlike ViewStatus, which reports situations only.
    pub ready: i64,
    pub pending: i64,
    pub failed: i64,
    pub blocked: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectOverviewView {
    /// Active-view summary, or null when never compacted.
    pub view_id: String,
    pub created_at: String,
    pub compact_point: i64,
    pub covered_from: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectOverviewVisibility {
    pub boundary_position: i64,
    pub zone_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectOverview {
    pub thread: InspectOverviewThread,
    pub events: InspectOverviewEvents,
    pub messages: InspectOverviewMessages,
    pub turns: InspectOverviewTurns,
    pub chunks: InspectOverviewChunks,
    pub derivation: InspectOverviewDerivation,
    pub view: Option<InspectOverviewView>,
    pub visibility: InspectOverviewVisibility,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContentsMetaConfig {
    /// Token-count target — unified with ViewProfile / StoredViewConfig → i64.
    pub lower_bound: i64,
    /// Insertion-ordered band shares.
    pub percentages: IndexMap<String, i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContentsMeta {
    pub view_id: String,
    pub created_at: String,
    pub profile: Option<String>,
    pub config: ViewContentsMetaConfig,
    pub compact_point: i64,
    pub covered_from: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContentsBandEntry {
    pub subject_kind: ViewSubjectKind,
    pub subject_id: String,
    pub derivation_used: String,
    pub degraded: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContentsBand {
    pub band: Band,
    pub entries: Vec<ViewContentsBandEntry>,
    pub stored_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContentsGap {
    pub band: Band,
    pub subject_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContentsTail {
    /// as served
    pub message_count: i64,
    pub tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContentsLoadCost {
    /// loadCost totals what model context serves now: band and tail tokens are
    /// both measured over served messages with the shared estimator, so equality
    /// with an independent context read is structural. The stored per-band counts
    /// stay reported above; they price the snapshot bytes without the served
    /// band-marker header, so they are describe's truth, not the serving cost.
    pub band_tokens: i64,
    pub tail_tokens: i64,
    /// = model context
    pub total: i64,
}

/// Provenance verbatim; null on a never-compacted thread because no compact
/// ever recorded what it saw, and inventing zeros would fabricate provenance.
/// Nested type → state → count (TS declared flat; runtime persists nested —
/// same judgment as StoredViewSourceState).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContentsSourceState {
    pub max_event_order: i64,
    /// Nested type → state → count; both levels insertion-ordered.
    pub derivation_counts: IndexMap<String, IndexMap<String, i64>>,
}

/// View-contents report shape served by `inspect.view`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContentsReport {
    pub meta: Option<ViewContentsMeta>,
    pub bands: Vec<ViewContentsBand>,
    pub gaps: Vec<ViewContentsGap>,
    pub tail: ViewContentsTail,
    pub load_cost: ViewContentsLoadCost,
    pub source_state: Option<ViewContentsSourceState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthOwner {
    Capture,
    Messages,
    Turns,
}

impl HealthOwner {
    pub fn as_str(self) -> &'static str {
        match self {
            HealthOwner::Capture => "capture",
            HealthOwner::Messages => "messages",
            HealthOwner::Turns => "turns",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthOwnerCounts {
    pub ready: i64,
    pub pending: i64,
    pub failed: i64,
    pub blocked: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthOwnerEntry {
    pub owner: HealthOwner,
    pub kind: String,
    pub counts: HealthOwnerCounts,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthFailure {
    pub owner: String,
    pub subject_kind: String,
    pub subject_id: String,
    pub derivation_type: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthRepairPreview {
    pub owner: String,
    pub subject_kind: String,
    pub subject_id: String,
    pub derivation_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthQueue {
    pub queued: i64,
    pub claimed: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    /// Counts by owner, derivation kind, and operational state, assembled entirely
    /// from the owners' report surfaces.
    pub owners: Vec<HealthOwnerEntry>,
    /// Actionable failure detail: enough to decide and target a requeue without
    /// raw SQL.
    pub failures: Vec<HealthFailure>,
    /// What a requeue pass would touch: failed and not blocked, reported, never
    /// executed.
    pub repair_preview: Vec<HealthRepairPreview>,
    /// Live queue visibility from the owners' queue detail, counted per report
    /// entry so the section is consistent by construction with the pending state
    /// counts in the same report.
    pub queue: HealthQueue,
}
