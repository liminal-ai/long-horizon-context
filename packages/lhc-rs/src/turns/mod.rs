//! Ported from packages/lhc/src/turns/index.ts.
//! Phase 1 PARTIAL stub — TurnRecord / list_turns / sync derive surfaces
//! Wave 1–2 tests call. Full turns surface lands in a later wave.
//! Wave 4 messages suites import `list_chunks` + [`ChunkRecord`] ahead of the
//! turns wave — minimal PARTIAL surface only.

use serde::{Deserialize, Serialize};

use crate::shared_tech::derivation::Derivation;
use crate::shared_tech::errors::{ErrorResult, OpResult};
use crate::threads::ThreadRef;

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

/// TS `TurnDeriveResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnDeriveResult {
    Derived {
        turn_id: String,
        source_version: i64,
    },
    Failed {
        turn_id: String,
        error: ErrorResult,
    },
}

/// Closed chunk derivation vocabulary on a successful `ChunkDeriveResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChunkDeriveDerivationType {
    ChunkSummaryDetailed,
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

/// TS `ChunkDeriveResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum ChunkDeriveResult {
    Derived {
        chunk_id: String,
        derivation_type: ChunkDeriveDerivationType,
        source_version: i64,
    },
    Failed {
        chunk_id: String,
        error: ErrorResult,
    },
}

/// TS `ChunkRecord` — PARTIAL (Wave 4 mutations-delete snapshot).
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

/// TS `listTurns` — PARTIAL stub.
pub async fn list_turns(_thread_ref: ThreadRef) -> OpResult<Vec<TurnRecord>> {
    todo!("phase 2")
}

/// TS `listChunks` — PARTIAL (Wave 4 mutations-delete; full turns wave later).
pub async fn list_chunks(_thread_ref: ThreadRef) -> OpResult<Vec<ChunkRecord>> {
    todo!("phase 2")
}

/// TS `turns.deriveTurn` — PARTIAL stub (Wave 2 work-execution).
pub async fn derive_turn(_thread_ref: ThreadRef, _turn_id: &str) -> OpResult<TurnDeriveResult> {
    todo!("phase 2")
}

/// TS `turns.deriveDetailedChunk` — PARTIAL stub (Wave 2 work-execution).
pub async fn derive_detailed_chunk(
    _thread_ref: ThreadRef,
    _chunk_id: &str,
) -> OpResult<ChunkDeriveResult> {
    todo!("phase 2")
}

/// TS `turns.deriveBriefChunk` — PARTIAL stub (Wave 2 work-execution).
pub async fn derive_brief_chunk(
    _thread_ref: ThreadRef,
    _chunk_id: &str,
) -> OpResult<ChunkDeriveResult> {
    todo!("phase 2")
}
