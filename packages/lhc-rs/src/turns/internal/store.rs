//! Ported from packages/lhc/src/turns/internal/store.ts. Phase 1 skeleton.
//!
//! Turn row operations. SQL literals REAL (private — TS module-local); bodies
//! exact `todo!("phase 2")`.

use serde::{Deserialize, Serialize};

use crate::shared_tech::storage::Db;
use crate::turns::{TurnRecord, TurnStatus};

#[allow(dead_code)]
const SQL_SELECT_OPEN_TURN_IDS: &str =
    "SELECT turn_id FROM turns WHERE status = 'open' ORDER BY turn_order";

#[allow(dead_code)]
const SQL_COUNT_TURN_MEMBERS: &str =
    "SELECT COUNT(*) AS n FROM message WHERE turn_id = ? AND deleted_at IS NULL";

#[allow(dead_code)]
const SQL_NEXT_TURN_ORDER: &str = "SELECT MAX(turn_order) AS max_order FROM turns";

#[allow(dead_code)]
const SQL_INSERT_OPEN_TURN: &str = r#"INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order)
     VALUES (?, ?, 'open', ?)"#;

#[allow(dead_code)]
const SQL_CLOSE_TURN: &str = "UPDATE turns SET status = 'closed', closed_at_event_order = ? WHERE turn_id = ? AND status = 'open'";

#[allow(dead_code)]
const SQL_SELECT_TURN_MEMBERS: &str = r#"SELECT message_id, turn_id FROM message
       WHERE turn_id IS NOT NULL AND deleted_at IS NULL ORDER BY source_event_order"#;

#[allow(dead_code)]
const SQL_SELECT_TURNS_LIVE: &str = r#"SELECT turn_id, turn_order, status, opened_at_event_order, closed_at_event_order
       FROM turns WHERE deleted_at IS NULL ORDER BY turn_order"#;

#[allow(dead_code)]
const SQL_SELECT_TURN_STRUCTURE: &str = r#"SELECT turn_id, turn_order, status, opened_at_event_order, closed_at_event_order, deleted_at
       FROM turns ORDER BY turn_order"#;

/// TS private `RawTurnRow` shape (SQL column names).
#[derive(Debug, Clone, PartialEq)]
struct RawTurnRow {
    turn_id: String,
    turn_order: i64,
    status: String,
    opened_at_event_order: i64,
    closed_at_event_order: Option<i64>,
}

/// TS `TurnStructureRow` — module-local in TS; pub for [`crate::turns::TurnChunkStructure`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStructureRow {
    pub turn_id: String,
    pub turn_order: i64,
    pub status: TurnStatus,
    pub opened_at_event_order: i64,
    pub closed_at_event_order: Option<i64>,
    pub deleted: bool,
}

pub fn select_open_turn_ids(_db: &Db) -> Vec<String> {
    todo!("phase 2")
}

pub fn count_turn_members(_db: &Db, _turn_id: &str) -> i64 {
    todo!("phase 2")
}

pub fn next_turn_order(_db: &Db) -> i64 {
    todo!("phase 2")
}

pub fn insert_open_turn(_db: &Db, _turn_order: i64, _opened_at_event_order: i64) -> String {
    todo!("phase 2")
}

pub fn close_turn(_db: &Db, _turn_id: &str, _closed_at_event_order: i64) {
    todo!("phase 2")
}

pub fn read_turns(_db: &Db) -> Vec<TurnRecord> {
    todo!("phase 2")
}

pub fn read_turn_structure(_db: &Db) -> Vec<TurnStructureRow> {
    todo!("phase 2")
}
