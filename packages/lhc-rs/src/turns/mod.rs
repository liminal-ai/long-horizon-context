//! Ported from packages/lhc/src/turns/index.ts. Phase 1 skeleton.
//!
//! Full turns surface: types/constants REAL; every behavior body
//! `todo!("phase 2")`. `TurnStructureRow` / `ChunkStructureRow` /
//! `CompactChunkMaterial` stay module-private to the domain (not crate-root
//! exports). `TurnDeriveResult` / `ChunkDeriveResult` follow Wave 4
//! `MessageDeriveResult` wire precedent (custom Serialize field order + tagged
//! Deserialize).

pub mod internal;

use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};

use crate::intake_stream::EventKind;
use crate::shared_tech::derivation::{Derivation, DerivationReportEntry, ResolvedSdkConfig};
use crate::shared_tech::errors::{ErrorResult, OpResult};
use crate::shared_tech::persist::{DbReadTransaction, DbWriteTransaction};
use crate::shared_tech::storage::Db;
use crate::shared_tech::work_queue::WorkItemRecord;
use crate::threads::ThreadRef;

use internal::chunk_recovery::{CompactChunkMaterial, compact_chunk_material_from_stored_members};
use internal::chunks::{ChunkStructureRow, read_chunk_structure};
use internal::store::{
    TurnStructureRow, close_turn, count_turn_members, insert_open_turn, next_turn_order,
    read_turn_structure, select_open_turn_ids,
};

#[allow(unused_imports)]
use crate::shared_tech::context::resolve_instance_config;
#[allow(unused_imports)]
use crate::shared_tech::errors::storage_failure;
#[allow(unused_imports)]
use crate::shared_tech::persist::create_db_read_transaction;
#[allow(unused_imports)]
use crate::threads::{open_thread_database, resolve_thread_ref};
#[allow(unused_imports)] // Phase 2 bodies; mirror TS dependency graph
use internal::derivations::{
    TurnOwnedSubjectKind, TurnReportOptions, read_chunk_rows, read_owned_derivations,
    report_turn_derivations,
};
#[allow(unused_imports)]
use internal::derive::derive_turn_owned_in_open_db;
#[allow(unused_imports)]
use internal::store::read_turns;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Open,
    Closed,
}

impl TurnStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TurnStatus::Open => "open",
            TurnStatus::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRecord {
    pub turn_id: String,
    pub turn_order: i64,
    pub status: TurnStatus,
    pub member_message_ids: Vec<String>,
    pub opened_at_event_order: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_at_event_order: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_idx: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derivations: Option<Vec<Derivation>>,
}

/// TS `ChunkRecord`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkRecord {
    pub chunk_id: String,
    pub chunk_order: i64,
    pub status: TurnStatus,
    pub accumulated_projected_tokens: i64,
    pub member_turn_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derivations: Option<Vec<Derivation>>,
}

/// TS transition action vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnTransitionAction {
    Opened,
    Closed,
}

impl TurnTransitionAction {
    pub fn as_str(self) -> &'static str {
        match self {
            TurnTransitionAction::Opened => "opened",
            TurnTransitionAction::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTransition {
    pub action: TurnTransitionAction,
    pub turn_id: String,
}

/// TS `TurnTransitionOutcome`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTransitionOutcome {
    pub transitions: Vec<TurnTransition>,
    pub turn_id: String,
    pub queued_work: Vec<WorkItemRecord>,
}

/// TS `TurnStateCorruptionError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnStateCorruptionError {
    pub message: String,
}

impl TurnStateCorruptionError {
    pub const ERROR_CLASS: &'static str = "state_corruption";
    pub const CODE: &'static str = "turn_state_corrupt";
}

impl std::fmt::Display for TurnStateCorruptionError {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        todo!("phase 2")
    }
}

impl std::error::Error for TurnStateCorruptionError {}

fn current_open_turn_id(_transaction: &DbWriteTransaction) -> String {
    todo!("phase 2")
}

fn close_turn_and_queue_work(
    _transaction: &DbWriteTransaction,
    _turn_id: &str,
    _event_order: i64,
) -> WorkItemRecord {
    todo!("phase 2")
}

/// TS `RecordedTurnEvent = Pick<EventRecord, "eventKind" | "eventOrder">`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedTurnEvent {
    pub event_kind: EventKind,
    pub event_order: i64,
}

pub fn create(
    _transaction: &DbWriteTransaction,
    _recorded_event: &RecordedTurnEvent,
) -> TurnTransitionOutcome {
    todo!("phase 2")
}

fn thread_not_found<T>(_file_path: &str) -> OpResult<T> {
    todo!("phase 2")
}

/// TS `listTurns`.
pub async fn list_turns(_thread_ref: ThreadRef) -> OpResult<Vec<TurnRecord>> {
    todo!("phase 2")
}

/// TS `listChunks`.
pub async fn list_chunks(_thread_ref: ThreadRef) -> OpResult<Vec<ChunkRecord>> {
    todo!("phase 2")
}

/// Closed chunk derivation vocabulary on a successful `ChunkDeriveResult`
/// and on `getChunkText` / chunk-summary reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ChunkDeriveDerivationType {
    #[serde(rename = "chunk_summary_detailed")]
    ChunkSummaryDetailed,
    #[serde(rename = "chunk_summary_brief")]
    ChunkSummaryBrief,
}

impl ChunkDeriveDerivationType {
    pub fn as_str(self) -> &'static str {
        match self {
            ChunkDeriveDerivationType::ChunkSummaryDetailed => "chunk_summary_detailed",
            ChunkDeriveDerivationType::ChunkSummaryBrief => "chunk_summary_brief",
        }
    }
}

/// TS `getChunkText(transaction, chunkId, derivationType = "chunk_summary_detailed")`.
///
/// Phase 1: `None` represents the omitted third argument (TS default
/// `chunk_summary_detailed`). Phase 2 must apply that default before read.
/// Returns compact material (domain type, not crate-root).
pub fn get_chunk_text(
    _transaction: &DbReadTransaction,
    _chunk_id: &str,
    _derivation_type: Option<ChunkDeriveDerivationType>,
) -> CompactChunkMaterial {
    todo!("phase 2")
}

/// TS `TurnChunkStructure`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnChunkStructure {
    pub turns: Vec<TurnStructureRow>,
    pub chunks: Vec<ChunkStructureRow>,
}

pub fn read_turn_chunk_structure(_db: &Db) -> TurnChunkStructure {
    todo!("phase 2")
}

/// TS `report` opts: `{ notReady?; turnId?; chunkId? }`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TurnReportOpts {
    pub not_ready: Option<bool>,
    pub turn_id: Option<String>,
    pub chunk_id: Option<String>,
}

/// TS `report`.
pub async fn report(
    _thread_ref: ThreadRef,
    _opts: Option<&TurnReportOpts>,
) -> OpResult<Vec<DerivationReportEntry>> {
    todo!("phase 2")
}

/// TS `TurnDeriveResult` — Deserialize stays serde-tagged (`outcome`);
/// Serialize emits TS construction order (`turnId` before `outcome`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum TurnDeriveResult {
    #[serde(rename_all = "camelCase")]
    Derived {
        turn_id: String,
        source_version: i64,
    },
    #[serde(rename_all = "camelCase")]
    Failed { turn_id: String, error: ErrorResult },
}

impl Serialize for TurnDeriveResult {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            TurnDeriveResult::Derived {
                turn_id,
                source_version,
            } => {
                let mut state = serializer.serialize_struct("TurnDeriveResult", 3)?;
                state.serialize_field("turnId", turn_id)?;
                state.serialize_field("outcome", "derived")?;
                state.serialize_field("sourceVersion", source_version)?;
                state.end()
            }
            TurnDeriveResult::Failed { turn_id, error } => {
                let mut state = serializer.serialize_struct("TurnDeriveResult", 3)?;
                state.serialize_field("turnId", turn_id)?;
                state.serialize_field("outcome", "failed")?;
                state.serialize_field("error", error)?;
                state.end()
            }
        }
    }
}

/// TS `ChunkDeriveResult` — Deserialize stays serde-tagged (`outcome`);
/// Serialize emits TS construction order from
/// `{ chunkId, derivationType, ...result }` where `result` inserts
/// `outcome, sourceVersion` → `chunkId, derivationType, outcome, sourceVersion`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ChunkDeriveResult {
    #[serde(rename_all = "camelCase")]
    Derived {
        chunk_id: String,
        derivation_type: ChunkDeriveDerivationType,
        source_version: i64,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        chunk_id: String,
        error: ErrorResult,
    },
}

impl Serialize for ChunkDeriveResult {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            ChunkDeriveResult::Derived {
                chunk_id,
                derivation_type,
                source_version,
            } => {
                let mut state = serializer.serialize_struct("ChunkDeriveResult", 4)?;
                state.serialize_field("chunkId", chunk_id)?;
                state.serialize_field("derivationType", derivation_type)?;
                state.serialize_field("outcome", "derived")?;
                state.serialize_field("sourceVersion", source_version)?;
                state.end()
            }
            ChunkDeriveResult::Failed { chunk_id, error } => {
                let mut state = serializer.serialize_struct("ChunkDeriveResult", 3)?;
                state.serialize_field("chunkId", chunk_id)?;
                state.serialize_field("outcome", "failed")?;
                state.serialize_field("error", error)?;
                state.end()
            }
        }
    }
}

enum ConfigRequiredResult {
    Ok(ResolvedSdkConfig),
    Err { error: ErrorResult },
}

fn config_required(_operation: &str) -> ConfigRequiredResult {
    todo!("phase 2")
}

/// TS `deriveTurn`.
pub async fn derive_turn(_thread_ref: ThreadRef, _turn_id: &str) -> OpResult<TurnDeriveResult> {
    todo!("phase 2")
}

async fn derive_chunk(
    _thread_ref: ThreadRef,
    _chunk_id: &str,
    _derivation_type: ChunkDeriveDerivationType,
) -> OpResult<ChunkDeriveResult> {
    todo!("phase 2")
}

/// TS `deriveDetailedChunk`.
pub async fn derive_detailed_chunk(
    _thread_ref: ThreadRef,
    _chunk_id: &str,
) -> OpResult<ChunkDeriveResult> {
    todo!("phase 2")
}

/// TS `deriveBriefChunk`.
pub async fn derive_brief_chunk(
    _thread_ref: ThreadRef,
    _chunk_id: &str,
) -> OpResult<ChunkDeriveResult> {
    todo!("phase 2")
}

// Keep Phase-2 import graph + private helpers type-referenced without
// calling todo bodies. CompactChunkMaterial / TurnStructureRow /
// ChunkStructureRow stay in `internal::*` (TS index does not name-export them).
const _: fn() = || {
    let _ = select_open_turn_ids as fn(&Db) -> Vec<String>;
    let _ = count_turn_members as fn(&Db, &str) -> i64;
    let _ = next_turn_order as fn(&Db) -> i64;
    let _ = insert_open_turn as fn(&Db, i64, i64) -> String;
    let _ = close_turn as fn(&Db, &str, i64);
    let _ = read_turn_structure as fn(&Db) -> Vec<TurnStructureRow>;
    let _ = read_chunk_structure as fn(&Db) -> Vec<ChunkStructureRow>;
    let _ = compact_chunk_material_from_stored_members
        as fn(&Db, &str, ChunkDeriveDerivationType) -> CompactChunkMaterial;
    let _ = current_open_turn_id;
    let _ = close_turn_and_queue_work;
    let _ = thread_not_found::<()>;
    let _ = config_required;
    let _ = derive_chunk;
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared_tech::errors::{ErrorClass, ErrorCode};
    use crate::shared_tech::js_json::js_json_stringify_of;
    use serde_json::json;

    #[test]
    fn turn_derive_result_derived_wire_shape_round_trips() {
        let v = TurnDeriveResult::Derived {
            turn_id: "t1".into(),
            source_version: 2,
        };
        let wire = serde_json::to_value(&v).unwrap();
        assert_eq!(
            wire,
            json!({
                "turnId": "t1",
                "outcome": "derived",
                "sourceVersion": 2,
            })
        );
        assert_eq!(
            js_json_stringify_of(&v).unwrap(),
            r#"{"turnId":"t1","outcome":"derived","sourceVersion":2}"#
        );
        let back: TurnDeriveResult = serde_json::from_value(wire).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn turn_derive_result_failed_wire_shape_round_trips() {
        let v = TurnDeriveResult::Failed {
            turn_id: "t2".into(),
            error: ErrorResult {
                error_class: ErrorClass::CallerError,
                code: ErrorCode::TurnNotFound,
                reason: "missing".into(),
                event_index: None,
            },
        };
        let wire = serde_json::to_value(&v).unwrap();
        assert_eq!(
            wire,
            json!({
                "turnId": "t2",
                "outcome": "failed",
                "error": {
                    "errorClass": "caller_error",
                    "code": "turn_not_found",
                    "reason": "missing",
                },
            })
        );
        assert_eq!(
            js_json_stringify_of(&v).unwrap(),
            r#"{"turnId":"t2","outcome":"failed","error":{"errorClass":"caller_error","code":"turn_not_found","reason":"missing"}}"#
        );
        let back: TurnDeriveResult = serde_json::from_value(wire).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn chunk_derive_result_derived_wire_shape_round_trips() {
        let v = ChunkDeriveResult::Derived {
            chunk_id: "c1".into(),
            derivation_type: ChunkDeriveDerivationType::ChunkSummaryDetailed,
            source_version: 3,
        };
        let wire = serde_json::to_value(&v).unwrap();
        assert_eq!(
            wire,
            json!({
                "chunkId": "c1",
                "derivationType": "chunk_summary_detailed",
                "outcome": "derived",
                "sourceVersion": 3,
            })
        );
        assert_eq!(
            js_json_stringify_of(&v).unwrap(),
            r#"{"chunkId":"c1","derivationType":"chunk_summary_detailed","outcome":"derived","sourceVersion":3}"#
        );
        let back: ChunkDeriveResult = serde_json::from_value(wire).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn chunk_derive_result_failed_wire_shape_round_trips() {
        let v = ChunkDeriveResult::Failed {
            chunk_id: "c2".into(),
            error: ErrorResult {
                error_class: ErrorClass::SystemError,
                code: ErrorCode::ProviderFailure,
                reason: "boom".into(),
                event_index: None,
            },
        };
        let wire = serde_json::to_value(&v).unwrap();
        assert_eq!(
            wire,
            json!({
                "chunkId": "c2",
                "outcome": "failed",
                "error": {
                    "errorClass": "system_error",
                    "code": "provider_failure",
                    "reason": "boom",
                },
            })
        );
        assert_eq!(
            js_json_stringify_of(&v).unwrap(),
            r#"{"chunkId":"c2","outcome":"failed","error":{"errorClass":"system_error","code":"provider_failure","reason":"boom"}}"#
        );
        let back: ChunkDeriveResult = serde_json::from_value(wire).unwrap();
        assert_eq!(back, v);
    }
}
