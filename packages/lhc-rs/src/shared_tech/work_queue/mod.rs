//! Ported from packages/lhc/src/shared-tech/work-queue/index.ts.
//! Phase 1 skeleton — types REAL; behavior bodies `todo!("phase 2")`.
//!
//! Durable work-item mechanics: recording, ordered listing, and the enqueue
//! wrapper that makes scheduling structural. The util is domain-blind: it
//! knows item mechanics (owner, kind, sourceRef), while each owning domain
//! supplies the derivation targets and handler meaning.

use std::sync::Arc;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::derivation::{CompletionTx, HandlerDerivationWrite, SubjectKind, WorkHandler};
use super::durable_work::DurableWorkOperation;
use super::persist::DbWriteTransaction;
use super::storage::Db;

/// TS `WorkHandlerMap` = `Partial<Record<WorkKind, WorkHandler>>`.
/// Insertion-ordered (matches JS object key order when iterating registrations).
pub type WorkHandlerMap = IndexMap<WorkKind, WorkHandler>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkOwner {
    Messages,
    Turns,
}

impl WorkOwner {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkOwner::Messages => "messages",
            WorkOwner::Turns => "turns",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkKind {
    PromptSmoothing,
    ToolResultSummary,
    TurnDerivation,
    DetailedTurnCompression,
    ChunkSummaryDetailed,
    ChunkSummaryBrief,
}

impl WorkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkKind::PromptSmoothing => "prompt_smoothing",
            WorkKind::ToolResultSummary => "tool_result_summary",
            WorkKind::TurnDerivation => "turn_derivation",
            WorkKind::DetailedTurnCompression => "detailed_turn_compression",
            WorkKind::ChunkSummaryDetailed => "chunk_summary_detailed",
            WorkKind::ChunkSummaryBrief => "chunk_summary_brief",
        }
    }

    /// Parse a wire `kind` string. Exhaustive over the six snake_case values —
    /// no wildcard success path (unknown strings are `None`).
    pub fn from_wire(s: &str) -> Option<WorkKind> {
        match s {
            "prompt_smoothing" => Some(WorkKind::PromptSmoothing),
            "tool_result_summary" => Some(WorkKind::ToolResultSummary),
            "turn_derivation" => Some(WorkKind::TurnDerivation),
            "detailed_turn_compression" => Some(WorkKind::DetailedTurnCompression),
            "chunk_summary_detailed" => Some(WorkKind::ChunkSummaryDetailed),
            "chunk_summary_brief" => Some(WorkKind::ChunkSummaryBrief),
            _ => None,
        }
    }
}

/// TS `sourceRefKey: "messageId" | "turnId" | "chunkId"` — wire camelCase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SourceRefKey {
    #[serde(rename = "messageId")]
    MessageId,
    #[serde(rename = "turnId")]
    TurnId,
    #[serde(rename = "chunkId")]
    ChunkId,
}

impl SourceRefKey {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceRefKey::MessageId => "messageId",
            SourceRefKey::TurnId => "turnId",
            SourceRefKey::ChunkId => "chunkId",
        }
    }
}

/// Mechanical metadata for one work kind (TS `WORK_KIND_REGISTRY` entry).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkKindRegistryEntry {
    pub owner: WorkOwner,
    pub source_ref_key: SourceRefKey,
}

/// TS `WORK_KIND_REGISTRY: Record<WorkKind, { owner; sourceRefKey }>`.
/// Wave 0: Record over closed vocab → exhaustive-match fn (deterministic_marker).
pub fn work_kind_registry(kind: WorkKind) -> WorkKindRegistryEntry {
    match kind {
        WorkKind::PromptSmoothing => WorkKindRegistryEntry {
            owner: WorkOwner::Messages,
            source_ref_key: SourceRefKey::MessageId,
        },
        WorkKind::ToolResultSummary => WorkKindRegistryEntry {
            owner: WorkOwner::Messages,
            source_ref_key: SourceRefKey::MessageId,
        },
        WorkKind::TurnDerivation => WorkKindRegistryEntry {
            owner: WorkOwner::Turns,
            source_ref_key: SourceRefKey::TurnId,
        },
        WorkKind::DetailedTurnCompression => WorkKindRegistryEntry {
            owner: WorkOwner::Turns,
            source_ref_key: SourceRefKey::TurnId,
        },
        WorkKind::ChunkSummaryDetailed => WorkKindRegistryEntry {
            owner: WorkOwner::Turns,
            source_ref_key: SourceRefKey::ChunkId,
        },
        WorkKind::ChunkSummaryBrief => WorkKindRegistryEntry {
            owner: WorkOwner::Turns,
            source_ref_key: SourceRefKey::ChunkId,
        },
    }
}

/// TS `WorkSourceRef = { messageId } | { turnId } | { chunkId }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WorkSourceRef {
    #[serde(rename_all = "camelCase")]
    Message { message_id: String },
    #[serde(rename_all = "camelCase")]
    Turn { turn_id: String },
    #[serde(rename_all = "camelCase")]
    Chunk { chunk_id: String },
}

/// SDK construction wiring for durable work dispatch.
/// Domains own their handler tables; shared-tech merges them and refuses
/// duplicate kind claims (TS `mapWorkQHandlers`).
pub fn map_work_q_handlers(handler_groups: &[WorkHandlerMap]) -> WorkHandlerMap {
    let mut map = IndexMap::new();
    for handlers in handler_groups {
        for (kind, handler) in handlers {
            if map.contains_key(kind) {
                panic!(
                    "work kind \"{}\" registered by more than one domain",
                    kind.as_str()
                );
            }
            map.insert(*kind, Arc::clone(handler));
        }
    }
    map
}

/// TS `status: "queued"` — the only status written before a drain claims it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemRecordStatus {
    Queued,
}

impl WorkItemRecordStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkItemRecordStatus::Queued => "queued",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemRecord {
    pub work_item_id: String,
    pub owner: WorkOwner,
    pub kind: WorkKind,
    pub source_ref: WorkSourceRef,
    pub status: WorkItemRecordStatus,
    pub queued_at: String,
}

/// Derivations an enqueue schedules work toward (domain-named; util meaning-blind).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueDerivationTarget {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: String,
}

/// Exact JSON object written by `record_item` into `work_item.payload`.
/// All three keys are always present (TS inline object in `recordItem`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordItemPayload {
    source_version: i64,
    operation: DurableWorkOperation,
    derivations: Vec<EnqueueDerivationTarget>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkItemInput {
    pub owner: WorkOwner,
    pub kind: WorkKind,
    pub source_ref: WorkSourceRef,
    pub operation: Option<DurableWorkOperation>,
    /// defaults to 1 — first version of a fresh source
    pub source_version: Option<i64>,
    pub derivations: Option<Vec<EnqueueDerivationTarget>>,
}

fn source_id_of(_source_ref: &WorkSourceRef) -> String {
    todo!("phase 2")
}

/// TS `Pick<EnqueueDerivationTarget | HandlerDerivationWrite, subjectKind|subjectId|derivationType>`.
trait DerivationTargetKeyParts {
    fn subject_kind(&self) -> SubjectKind;
    fn subject_id(&self) -> &str;
    fn derivation_type(&self) -> &str;
}

impl DerivationTargetKeyParts for EnqueueDerivationTarget {
    fn subject_kind(&self) -> SubjectKind {
        self.subject_kind
    }
    fn subject_id(&self) -> &str {
        &self.subject_id
    }
    fn derivation_type(&self) -> &str {
        &self.derivation_type
    }
}

impl DerivationTargetKeyParts for HandlerDerivationWrite {
    fn subject_kind(&self) -> SubjectKind {
        self.subject_kind
    }
    fn subject_id(&self) -> &str {
        &self.subject_id
    }
    fn derivation_type(&self) -> &str {
        &self.derivation_type
    }
}

fn target_key(_target: &impl DerivationTargetKeyParts) -> String {
    todo!("phase 2")
}

/// Deterministic id scoped to source version.
pub fn record_item(_db: &Db, _input: WorkItemInput, _queued_at: &str) -> WorkItemRecord {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq)]
pub struct EnqueueInput {
    pub owner: WorkOwner,
    pub kind: WorkKind,
    pub source_ref: WorkSourceRef,
    pub derivations: Vec<EnqueueDerivationTarget>,
    pub operation: Option<DurableWorkOperation>,
    pub source_version: Option<i64>,
}

/// TS `ImmediateDerivationBoundary` — `exists: false` | `exists: true` + state/version.
#[derive(Debug, Clone, PartialEq)]
pub enum ImmediateDerivationBoundary {
    Missing {
        subject_kind: SubjectKind,
        subject_id: String,
        derivation_type: String,
    },
    Present {
        subject_kind: SubjectKind,
        subject_id: String,
        derivation_type: String,
        state: String,
        source_version: i64,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImmediateClaimInput {
    pub owner: WorkOwner,
    pub kind: WorkKind,
    pub source_ref: WorkSourceRef,
    pub derivations: Vec<EnqueueDerivationTarget>,
    pub expected_derivations: Vec<ImmediateDerivationBoundary>,
    pub operation: Option<DurableWorkOperation>,
    pub source_version: Option<i64>,
}

/// TS `{ now; leaseDurationMs }`.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimTiming {
    pub now: String,
    pub lease_duration_ms: i64,
}

/// TS `ImmediateClaimOutcome` — discriminated on `outcome` (in-memory; no serde).
#[derive(Debug, Clone, PartialEq)]
pub enum ImmediateClaimOutcome {
    Claimed { item: ClaimedWorkItem },
    Expired { item: ClaimedWorkItem },
    Queued { work_item_id: String },
    InFlight { work_item_id: String },
}

/// The one way work is scheduled: work row + pending derivation + poke.
pub fn enqueue(_transaction: &DbWriteTransaction, _input: EnqueueInput) -> WorkItemRecord {
    todo!("phase 2")
}

pub fn create_or_claim_immediate_work_item(
    _db: &Db,
    _input: ImmediateClaimInput,
    _claim_timing: ClaimTiming,
) -> ImmediateClaimOutcome {
    todo!("phase 2")
}

/// TS private `RawWorkItemRow` — listItems SELECT shape (no payload).
struct RawWorkItemRow {
    work_item_id: String,
    owner: String,
    kind: String,
    source_ref: String,
    queued_at: String,
}

/// Claimed row as the drain holds it. `kind` is a plain string — a raw row
/// with an unregistered kind must still be claimable so the drain can land it
/// failed_terminal instead of skipping it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedWorkItem {
    pub work_item_id: String,
    pub owner: WorkOwner,
    pub kind: String,
    pub source_ref: WorkSourceRef,
    pub queued_at: String,
    pub source_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<DurableWorkOperation>,
    pub derivations: Vec<EnqueueDerivationTarget>,
}

/// TS `ClaimOutcome` — discriminated on `outcome` (in-memory; no serde).
#[derive(Debug, Clone, PartialEq)]
pub enum ClaimOutcome {
    Claimed { item: ClaimedWorkItem },
    Expired { item: ClaimedWorkItem },
    Empty,
    InFlight { claim_expires_at: String },
}

struct RawClaimRow {
    work_item_id: String,
    owner: String,
    kind: String,
    source_ref: String,
    queued_at: String,
    payload: String,
}

/// TS private `WorkPayload` — optional fields when reading stored payload JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WorkPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_version: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation: Option<DurableWorkOperation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    derivations: Option<Vec<EnqueueDerivationTarget>>,
}

fn parse_work_payload(_row: &RawClaimRow) -> WorkPayload {
    todo!("phase 2")
}

// IMPORT-CYCLE SEAM (Python): durable_work imports work_queue at load time;
// Phase 2 body lazily calls durable_work::operation_intent.
fn operation_intent_for_row(
    _kind: &str,
    _source_ref: &WorkSourceRef,
) -> Option<DurableWorkOperation> {
    todo!("phase 2")
}

fn to_claimed_item(_row: RawClaimRow) -> ClaimedWorkItem {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteClaimedItem {
    pub work_item_id: String,
}

pub fn delete_claimed_item(_db: &Db, _item: &DeleteClaimedItem) -> bool {
    todo!("phase 2")
}

pub fn claim_next(_db: &Db, _now: &str, _lease_duration_ms: i64) -> ClaimOutcome {
    todo!("phase 2")
}

/// TS `complete` return: `"done" | "stale_discarded" | "lost_lease"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompleteDisposition {
    Done,
    StaleDiscarded,
    LostLease,
}

impl CompleteDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            CompleteDisposition::Done => "done",
            CompleteDisposition::StaleDiscarded => "stale_discarded",
            CompleteDisposition::LostLease => "lost_lease",
        }
    }
}

pub fn complete(
    _db: &Db,
    _item: &ClaimedWorkItem,
    _writes: &[HandlerDerivationWrite],
    _derived_at: &str,
    _on_applied: Option<Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>>,
) -> CompleteDisposition {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq)]
pub struct SupersedeTarget {
    pub kind: WorkKind,
    pub source_ref: WorkSourceRef,
}

pub fn supersede_queued(_db: &Db, _targets: &[SupersedeTarget]) -> Vec<String> {
    todo!("phase 2")
}

pub fn has_live_item(
    _db: &Db,
    _kind: WorkKind,
    _source_ref: &WorkSourceRef,
    _source_version: i64,
) -> bool {
    todo!("phase 2")
}

/// Live items left in the queue; used by drain reporting and owner repair reports.
pub fn count_live_items(_db: &Db) -> i64 {
    todo!("phase 2")
}

/// TS `status: "queued" | "claimed"` on live queue detail rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueLiveStatus {
    Queued,
    Claimed,
}

impl QueueLiveStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            QueueLiveStatus::Queued => "queued",
            QueueLiveStatus::Claimed => "claimed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueDetailRow {
    pub work_item_id: String,
    pub owner: WorkOwner,
    pub kind: String,
    pub source_ref: WorkSourceRef,
    pub status: QueueLiveStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_expires_at: Option<String>,
    pub queued_at: String,
    pub source_version: i64,
}

pub fn queue_detail(_db: &Db) -> Vec<QueueDetailRow> {
    todo!("phase 2")
}

pub fn list_items(_db: &Db, _owner: WorkOwner) -> Vec<WorkItemRecord> {
    todo!("phase 2")
}

/// Mutation-sensitive serde coverage for the private `record_item` write payload.
/// Rust-only (no TS twin) — allowlist as `lib::shared_tech::work_queue::tests::*`.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared_tech::js_json::js_json_stringify_of;

    fn sample_write_payload() -> RecordItemPayload {
        RecordItemPayload {
            source_version: 1,
            operation: DurableWorkOperation::MessagesDerive {
                message_id: "m1".into(),
            },
            derivations: vec![EnqueueDerivationTarget {
                subject_kind: SubjectKind::Message,
                subject_id: "m1".into(),
                derivation_type: "prompt_smoothing".into(),
            }],
        }
    }

    #[test]
    fn record_item_write_payload_requires_source_version_operation_derivations_keys() {
        let bytes = js_json_stringify_of(&sample_write_payload()).expect("stringify");
        let value: serde_json::Value = serde_json::from_str(&bytes).expect("parse");
        let obj = value.as_object().expect("object");
        assert!(
            obj.contains_key("sourceVersion"),
            "missing sourceVersion: {bytes}"
        );
        assert!(obj.contains_key("operation"), "missing operation: {bytes}");
        assert!(
            obj.contains_key("derivations"),
            "missing derivations: {bytes}"
        );
        assert!(
            !obj.contains_key("source_version"),
            "snake_case leak: {bytes}"
        );
    }

    #[test]
    fn record_item_write_payload_serializes_camel_case_bytes() {
        let bytes = js_json_stringify_of(&sample_write_payload()).expect("stringify");
        assert!(
            bytes.contains("\"sourceVersion\":1"),
            "expected camelCase sourceVersion in {bytes}"
        );
        assert!(
            bytes.contains("\"subjectKind\":\"message\""),
            "expected camelCase subjectKind in {bytes}"
        );
        assert!(
            bytes.contains("\"subjectId\":\"m1\""),
            "expected camelCase subjectId in {bytes}"
        );
        assert!(
            bytes.contains("\"derivationType\":\"prompt_smoothing\""),
            "expected camelCase derivationType in {bytes}"
        );
        assert!(
            bytes.contains("\"messageId\":\"m1\""),
            "expected camelCase messageId in {bytes}"
        );
    }

    #[test]
    fn record_item_write_payload_rejects_unknown_subject_kind() {
        let bad = r#"{"sourceVersion":1,"operation":{"operation":"messages.derive","messageId":"m1"},"derivations":[{"subjectKind":"bogus","subjectId":"m1","derivationType":"prompt_smoothing"}]}"#;
        let err = serde_json::from_str::<RecordItemPayload>(bad).expect_err("bogus kind");
        let msg = err.to_string();
        assert!(
            msg.contains("bogus") || msg.contains("SubjectKind") || msg.contains("unknown"),
            "unexpected error: {msg}"
        );
    }
}
