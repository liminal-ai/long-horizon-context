//! Ported from packages/lhc/src/turns/index.ts.
//! Phase 1 PARTIAL stub — TurnRecord / list_turns that Wave 1 fixtures.test calls.
//!
//! Deleted Wave 1 invents: `ChunkRecord` / `list_chunks` — not required by
//! Wave 1 suites (chunks surface is a later wave).

use serde::{Deserialize, Serialize};

use crate::shared_tech::derivation::Derivation;
use crate::shared_tech::errors::OpResult;
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

/// TS `listTurns` — PARTIAL stub.
pub async fn list_turns(_thread_ref: ThreadRef) -> OpResult<Vec<TurnRecord>> {
    todo!("phase 2")
}
