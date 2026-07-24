//! Ported from packages/lhc/src/turns/internal/chunks.ts. Phase 1 skeleton.
//!
//! Chunk mechanics: placement, close policy, summary enqueues. SQL literals
//! REAL (private — TS module-local); bodies exact `todo!("phase 2")`.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::shared_tech::persist::DbWriteTransaction;
use crate::shared_tech::storage::Db;
use crate::shared_tech::work_queue::WorkItemRecord;
use crate::turns::TurnStatus;

#[allow(dead_code)]
const SQL_MEMBER_COUNT: &str = r#"SELECT COUNT(*) AS n FROM chunk_member WHERE chunk_id = ?"#;

#[allow(dead_code)]
const SQL_CLOSE_CHUNK: &str = r#"UPDATE chunk SET status = 'closed' WHERE chunk_id = ?"#;

#[allow(dead_code)]
const SQL_MAX_CHUNK_ORDER: &str = r#"SELECT MAX(chunk_order) AS max_order FROM chunk"#;

#[allow(dead_code)]
const SQL_INSERT_OPEN_CHUNK: &str = r#"INSERT INTO chunk (chunk_id, chunk_order, status, accumulated_projected_tokens)
     VALUES (?, ?, 'open', 0)"#;

#[allow(dead_code)]
const SQL_SELECT_EXISTING_PLACEMENT: &str =
    r#"SELECT chunk_id, member_idx FROM chunk_member WHERE turn_id = ?"#;

#[allow(dead_code)]
const SQL_SELECT_OPEN_CHUNK: &str = r#"SELECT chunk_id, accumulated_projected_tokens FROM chunk
       WHERE status = 'open' ORDER BY chunk_order DESC LIMIT 1"#;

#[allow(dead_code)]
const SQL_INSERT_CHUNK_MEMBER: &str =
    r#"INSERT INTO chunk_member (chunk_id, turn_id, member_idx) VALUES (?, ?, ?)"#;

#[allow(dead_code)]
const SQL_ACCUMULATE_PROJECTED_TOKENS: &str = r#"UPDATE chunk SET accumulated_projected_tokens = accumulated_projected_tokens + ?
     WHERE chunk_id = ?"#;

#[allow(dead_code)]
const SQL_SELECT_CHUNK_STRUCTURE: &str =
    r#"SELECT chunk_id, chunk_order, status FROM chunk ORDER BY chunk_order"#;

#[allow(dead_code)]
const SQL_SELECT_CHUNK_STRUCTURE_MEMBERS: &str = r#"SELECT cm.chunk_id, cm.turn_id FROM chunk_member cm
       JOIN chunk c ON c.chunk_id = cm.chunk_id
       ORDER BY c.chunk_order, cm.member_idx"#;

#[allow(dead_code)]
const SQL_SELECT_PLACEMENTS: &str = r#"SELECT turn_id, chunk_id, member_idx FROM chunk_member"#;

/// TS `ChunkPolicy`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkPolicy {
    pub target_projected_tokens: i64,
    pub max_projected_tokens: i64,
}

/// TS `PlacementResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct PlacementResult {
    pub chunk_id: String,
    pub member_idx: i64,
    /// Chunks closed by this placement, in close order.
    pub closed_chunk_ids: Vec<String>,
    pub already_placed: bool,
}

/// TS private `OpenChunkRow`.
#[derive(Debug, Clone, PartialEq)]
struct OpenChunkRow {
    chunk_id: String,
    accumulated_projected_tokens: i64,
}

/// TS `ChunkStructureRow` — module-local in TS; pub for [`crate::turns::TurnChunkStructure`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkStructureRow {
    pub chunk_id: String,
    pub chunk_order: i64,
    pub status: TurnStatus,
    pub member_turn_ids: Vec<String>,
}

/// Placement read-back value: `{ chunkId, memberIdx }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkPlacement {
    pub chunk_id: String,
    pub member_idx: i64,
}

fn member_count(_db: &Db, _chunk_id: &str) -> i64 {
    todo!("phase 2")
}

fn close_chunk(_db: &Db, _chunk_id: &str) {
    todo!("phase 2")
}

fn open_next_chunk(_db: &Db) -> String {
    todo!("phase 2")
}

pub fn place_turn(
    _db: &Db,
    _turn_id: &str,
    _projected_tokens: i64,
    _policy: &ChunkPolicy,
) -> PlacementResult {
    todo!("phase 2")
}

pub fn enqueue_chunk_summaries(
    _transaction: &DbWriteTransaction,
    _chunk_id: &str,
) -> Vec<WorkItemRecord> {
    todo!("phase 2")
}

pub fn read_chunk_structure(_db: &Db) -> Vec<ChunkStructureRow> {
    todo!("phase 2")
}

/// TS `readPlacements` — `Map` → [`IndexMap`].
pub fn read_placements(_db: &Db) -> IndexMap<String, ChunkPlacement> {
    todo!("phase 2")
}
