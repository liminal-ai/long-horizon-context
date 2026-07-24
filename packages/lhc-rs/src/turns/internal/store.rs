//! Ported from packages/lhc/src/turns/internal/store.ts.
//!
//! Turn row operations. Wave 3 implements the intake write/read helpers
//! (`select_open_turn_ids`, `count_turn_members`, `next_turn_order`,
//! `insert_open_turn`, `close_turn`). Listing/structure reads stay Phase 2.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_tech::storage::{Db, SqlParam};
use crate::turns::{TurnRecord, TurnStatus};

const SQL_SELECT_OPEN_TURN_IDS: &str =
    "SELECT turn_id FROM turns WHERE status = 'open' ORDER BY turn_order";

const SQL_COUNT_TURN_MEMBERS: &str =
    "SELECT COUNT(*) AS n FROM message WHERE turn_id = ? AND deleted_at IS NULL";

const SQL_NEXT_TURN_ORDER: &str = "SELECT MAX(turn_order) AS max_order FROM turns";

const SQL_INSERT_OPEN_TURN: &str = r#"INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order)
     VALUES (?, ?, 'open', ?)"#;

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
#[allow(dead_code)]
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

fn map_required_str(row: &Map<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("missing column {key}"))
        .to_string()
}

fn map_optional_i64(row: &Map<String, Value>, key: &str) -> Option<i64> {
    match row.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(
            n.as_i64()
                .or_else(|| n.as_f64().map(|f| f as i64))
                .unwrap_or_else(|| panic!("column {key} not integer")),
        ),
        Some(Value::String(s)) => Some(
            s.parse()
                .unwrap_or_else(|_| panic!("column {key} not integer")),
        ),
        Some(other) => panic!("column {key} not integer: {other}"),
    }
}

pub fn select_open_turn_ids(db: &Db) -> Vec<String> {
    db.prepare(SQL_SELECT_OPEN_TURN_IDS)
        .all(&[])
        .into_iter()
        .map(|row| map_required_str(&row, "turn_id"))
        .collect()
}

pub fn count_turn_members(db: &Db, turn_id: &str) -> i64 {
    let row = db
        .prepare(SQL_COUNT_TURN_MEMBERS)
        .get_params(&[SqlParam::from(turn_id)]);
    match row {
        None => 0,
        Some(map) => map_optional_i64(&map, "n").unwrap_or(0),
    }
}

pub fn next_turn_order(db: &Db) -> i64 {
    let row = db.prepare(SQL_NEXT_TURN_ORDER).get();
    let max_order = match row {
        None => 0,
        Some(map) => map_optional_i64(&map, "max_order").unwrap_or(0),
    };
    max_order + 1
}

pub fn insert_open_turn(db: &Db, turn_order: i64, opened_at_event_order: i64) -> String {
    let turn_id = format!("t{turn_order}");
    db.prepare(SQL_INSERT_OPEN_TURN).run(&[
        SqlParam::from(turn_id.as_str()),
        SqlParam::from(turn_order),
        SqlParam::from(opened_at_event_order),
    ]);
    turn_id
}

pub fn close_turn(db: &Db, turn_id: &str, closed_at_event_order: i64) {
    db.prepare(SQL_CLOSE_TURN).run(&[
        SqlParam::from(closed_at_event_order),
        SqlParam::from(turn_id),
    ]);
}

pub fn read_turns(_db: &Db) -> Vec<TurnRecord> {
    todo!("phase 2")
}

pub fn read_turn_structure(_db: &Db) -> Vec<TurnStructureRow> {
    todo!("phase 2")
}
