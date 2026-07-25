//! Ported from packages/lhc/src/turns/internal/chunks.ts.
//!
//! Chunk mechanics: placement, close policy, summary enqueues. SQL literals
//! REAL (private — TS module-local).

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_tech::derivation::SubjectKind;
use crate::shared_tech::persist::DbWriteTransaction;
use crate::shared_tech::storage::{Db, SqlParam};
use crate::shared_tech::work_queue::{
    EnqueueDerivationTarget, EnqueueInput, WorkItemRecord, WorkKind, WorkOwner, WorkSourceRef,
    enqueue,
};
use crate::turns::TurnStatus;

const SQL_MEMBER_COUNT: &str = r#"SELECT COUNT(*) AS n FROM chunk_member WHERE chunk_id = ?"#;

const SQL_CLOSE_CHUNK: &str = r#"UPDATE chunk SET status = 'closed' WHERE chunk_id = ?"#;

const SQL_MAX_CHUNK_ORDER: &str = r#"SELECT MAX(chunk_order) AS max_order FROM chunk"#;

const SQL_INSERT_OPEN_CHUNK: &str = r#"INSERT INTO chunk (chunk_id, chunk_order, status, accumulated_projected_tokens)
     VALUES (?, ?, 'open', 0)"#;

const SQL_SELECT_EXISTING_PLACEMENT: &str =
    r#"SELECT chunk_id, member_idx FROM chunk_member WHERE turn_id = ?"#;

const SQL_SELECT_OPEN_CHUNK: &str = r#"SELECT chunk_id, accumulated_projected_tokens FROM chunk
       WHERE status = 'open' ORDER BY chunk_order DESC LIMIT 1"#;

const SQL_INSERT_CHUNK_MEMBER: &str =
    r#"INSERT INTO chunk_member (chunk_id, turn_id, member_idx) VALUES (?, ?, ?)"#;

const SQL_ACCUMULATE_PROJECTED_TOKENS: &str = r#"UPDATE chunk SET accumulated_projected_tokens = accumulated_projected_tokens + ?
     WHERE chunk_id = ?"#;

const SQL_SELECT_CHUNK_STRUCTURE: &str =
    r#"SELECT chunk_id, chunk_order, status FROM chunk ORDER BY chunk_order"#;

const SQL_SELECT_CHUNK_STRUCTURE_MEMBERS: &str = r#"SELECT cm.chunk_id, cm.turn_id FROM chunk_member cm
       JOIN chunk c ON c.chunk_id = cm.chunk_id
       ORDER BY c.chunk_order, cm.member_idx"#;

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

fn map_required_str(row: &Map<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("missing column {key}"))
        .to_string()
}

fn map_required_i64(row: &Map<String, Value>, key: &str) -> i64 {
    match row.get(key) {
        // Reject non-integer REAL/string (no `f as i64` truncate). Integer
        // SQLite INTEGER and valid integer strings keep as_i64 / parse.
        Some(Value::Number(n)) => n
            .as_i64()
            .unwrap_or_else(|| panic!("column {key} not integer")),
        Some(Value::String(s)) => s
            .parse()
            .unwrap_or_else(|_| panic!("column {key} not integer")),
        _ => panic!("missing column {key}"),
    }
}

fn map_optional_i64(row: &Map<String, Value>, key: &str) -> Option<i64> {
    match row.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(
            n.as_i64()
                .unwrap_or_else(|| panic!("column {key} not integer")),
        ),
        Some(Value::String(s)) => Some(
            s.parse()
                .unwrap_or_else(|_| panic!("column {key} not integer")),
        ),
        Some(other) => panic!("column {key} not integer: {other}"),
    }
}

fn turn_status_from_wire(status: &str) -> TurnStatus {
    match status {
        "open" => TurnStatus::Open,
        "closed" => TurnStatus::Closed,
        other => panic!("unknown chunk status from row: {other}"),
    }
}

fn member_count(db: &Db, chunk_id: &str) -> i64 {
    let row = db
        .prepare(SQL_MEMBER_COUNT)
        .get_params(&[SqlParam::from(chunk_id)]);
    match row {
        None => 0,
        Some(map) => map_optional_i64(&map, "n").unwrap_or(0),
    }
}

fn close_chunk(db: &Db, chunk_id: &str) {
    db.prepare(SQL_CLOSE_CHUNK).run(&[SqlParam::from(chunk_id)]);
}

fn open_next_chunk(db: &Db) -> String {
    let row = db.prepare(SQL_MAX_CHUNK_ORDER).get();
    let order = match row {
        None => 0,
        Some(map) => map_optional_i64(&map, "max_order").unwrap_or(0),
    } + 1;
    let chunk_id = format!("c{order}");
    db.prepare(SQL_INSERT_OPEN_CHUNK)
        .run(&[SqlParam::from(chunk_id.as_str()), SqlParam::from(order)]);
    chunk_id
}

// The close policy: when the open chunk's accumulated count plus the incoming
// turn's count would reach the target, equality included, the chunk closes
// holding its current members and the incoming turn opens the next chunk. A
// single turn at or above max closes its own chunk immediately. An empty open
// chunk always accepts the incoming turn; a chunk never closes empty.
pub fn place_turn(
    db: &Db,
    turn_id: &str,
    projected_tokens: i64,
    policy: &ChunkPolicy,
) -> PlacementResult {
    let existing = db
        .prepare(SQL_SELECT_EXISTING_PLACEMENT)
        .get_params(&[SqlParam::from(turn_id)]);
    if let Some(existing) = existing {
        return PlacementResult {
            chunk_id: map_required_str(&existing, "chunk_id"),
            member_idx: map_required_i64(&existing, "member_idx"),
            closed_chunk_ids: Vec::new(),
            already_placed: true,
        };
    }

    let mut closed_chunk_ids: Vec<String> = Vec::new();
    let open_row = db.prepare(SQL_SELECT_OPEN_CHUNK).get();
    let mut open = open_row.map(|row| OpenChunkRow {
        chunk_id: map_required_str(&row, "chunk_id"),
        accumulated_projected_tokens: map_required_i64(&row, "accumulated_projected_tokens"),
    });

    if let Some(open_chunk) = open.take() {
        if member_count(db, &open_chunk.chunk_id) > 0
            && open_chunk.accumulated_projected_tokens + projected_tokens
                >= policy.target_projected_tokens
        {
            // Crossing closes without the incoming turn: the decision weighs
            // accumulated + incoming, and the incoming turn starts the next chunk.
            close_chunk(db, &open_chunk.chunk_id);
            closed_chunk_ids.push(open_chunk.chunk_id);
        } else {
            open = Some(open_chunk);
        }
    }

    let chunk_id = match open {
        Some(open_chunk) => open_chunk.chunk_id,
        None => open_next_chunk(db),
    };
    let member_idx = member_count(db, &chunk_id);
    db.prepare(SQL_INSERT_CHUNK_MEMBER).run(&[
        SqlParam::from(chunk_id.as_str()),
        SqlParam::from(turn_id),
        SqlParam::from(member_idx),
    ]);
    db.prepare(SQL_ACCUMULATE_PROJECTED_TOKENS).run(&[
        SqlParam::from(projected_tokens),
        SqlParam::from(chunk_id.as_str()),
    ]);

    if projected_tokens >= policy.max_projected_tokens {
        // Max rule: the incoming turn alone meets the maximum, so its chunk closes
        // immediately, whatever it holds.
        close_chunk(db, &chunk_id);
        closed_chunk_ids.push(chunk_id.clone());
    }

    PlacementResult {
        chunk_id,
        member_idx,
        closed_chunk_ids,
        already_placed: false,
    }
}

// Closing queues the two summary kinds as independent work items. Both enqueues
// ride the caller's ambient completion transaction.
pub fn enqueue_chunk_summaries(
    transaction: &DbWriteTransaction<'_>,
    chunk_id: &str,
) -> Vec<WorkItemRecord> {
    [WorkKind::ChunkSummaryDetailed, WorkKind::ChunkSummaryBrief]
        .into_iter()
        .map(|kind| {
            enqueue(
                transaction,
                EnqueueInput {
                    owner: WorkOwner::Turns,
                    kind,
                    source_ref: WorkSourceRef::Chunk {
                        chunk_id: chunk_id.to_string(),
                    },
                    derivations: vec![EnqueueDerivationTarget {
                        subject_kind: SubjectKind::Chunk,
                        subject_id: chunk_id.to_string(),
                        derivation_type: kind.as_str().to_string(),
                    }],
                    operation: None,
                    source_version: None,
                },
            )
        })
        .collect()
}

// The chunk structure for compact selection: every chunk in chunk order with
// its raw membership in member order. Membership is NOT filtered by turn
// liveness — references are returned as stored so the consumer can run its
// own referential check (a member pointing at no turn row at all is damage;
// a member pointing at a tombstoned turn is not). This is why it does not
// reuse readChunkRows, whose live-turn join would hide both cases.
pub fn read_chunk_structure(db: &Db) -> Vec<ChunkStructureRow> {
    let chunk_rows = db.prepare(SQL_SELECT_CHUNK_STRUCTURE).all(&[]);
    let member_rows = db.prepare(SQL_SELECT_CHUNK_STRUCTURE_MEMBERS).all(&[]);
    let mut members_by_chunk: IndexMap<String, Vec<String>> = IndexMap::new();
    for row in member_rows {
        let chunk_id = map_required_str(&row, "chunk_id");
        let turn_id = map_required_str(&row, "turn_id");
        members_by_chunk.entry(chunk_id).or_default().push(turn_id);
    }
    chunk_rows
        .into_iter()
        .map(|row| {
            let chunk_id = map_required_str(&row, "chunk_id");
            ChunkStructureRow {
                chunk_id: chunk_id.clone(),
                chunk_order: map_required_i64(&row, "chunk_order"),
                status: turn_status_from_wire(&map_required_str(&row, "status")),
                member_turn_ids: members_by_chunk.get(&chunk_id).cloned().unwrap_or_default(),
            }
        })
        .collect()
}

/// TS `readPlacements` — `Map` → [`IndexMap`].
pub fn read_placements(db: &Db) -> IndexMap<String, ChunkPlacement> {
    let rows = db.prepare(SQL_SELECT_PLACEMENTS).all(&[]);
    let mut by_turn = IndexMap::new();
    for row in rows {
        by_turn.insert(
            map_required_str(&row, "turn_id"),
            ChunkPlacement {
                chunk_id: map_required_str(&row, "chunk_id"),
                member_idx: map_required_i64(&row, "member_idx"),
            },
        );
    }
    by_turn
}
