//! Ported from packages/lhc/src/turns/internal/chunk-recovery.ts. Phase 1 skeleton.
//!
//! Compact-selection material for a chunk. SQL/prompt literals REAL; bodies
//! exact `todo!("phase 2")`. Not a domain/crate-root export surface.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_tech::storage::Db;
use crate::turns::ChunkDeriveDerivationType;

#[allow(dead_code)]
const SQL_CHUNK_EXISTS: &str = r#"SELECT 1 FROM chunk WHERE chunk_id = ?"#;

#[allow(dead_code)]
const SQL_LIVE_CHUNK_MEMBERS: &str = r#"SELECT cm.turn_id FROM chunk_member cm
       JOIN turns t ON t.turn_id = cm.turn_id AND t.deleted_at IS NULL
       WHERE cm.chunk_id = ? ORDER BY cm.member_idx"#;

#[allow(dead_code)]
const SQL_TURN_MESSAGES: &str = r#"SELECT message_id, kind FROM message
     WHERE turn_id = ? AND deleted_at IS NULL ORDER BY source_event_order"#;

#[allow(dead_code)]
const SQL_MESSAGE_BLOCK_CONTENT: &str =
    r#"SELECT content FROM message_block WHERE message_id = ? ORDER BY block_index"#;

#[allow(dead_code)]
const SQL_TURN_STATUS: &str =
    r#"SELECT status, closed_at_event_order FROM turns WHERE turn_id = ?"#;

#[allow(dead_code)]
const SQL_CHUNK_DERIVATION: &str = r#"SELECT state, content, reason FROM derivation
       WHERE subject_kind = 'chunk' AND subject_id = ? AND derivation_type = ?"#;

/// TS `CompactChunkMaterial` — tagged on `kind`. Private to turns (index imports
/// the type for `getChunkText` only; not a crate-root/sdk export).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CompactChunkMaterial {
    #[serde(rename_all = "camelCase")]
    Ready { content: String },
    #[serde(rename_all = "camelCase")]
    Concat { content: String, reason: String },
    #[serde(rename_all = "camelCase")]
    Blocked { reason: String },
}

/// TS `blockText` — open string `kind` (message.kind), so wildcard default OK.
fn block_text(_kind: &str, _content: &Map<String, Value>) -> String {
    todo!("phase 2")
}

fn stored_member_concat(_db: &Db, _chunk_id: &str) -> CompactChunkMaterial {
    todo!("phase 2")
}

pub fn compact_chunk_material_from_stored_members(
    _db: &Db,
    _chunk_id: &str,
    _derivation_type: ChunkDeriveDerivationType,
) -> CompactChunkMaterial {
    todo!("phase 2")
}
