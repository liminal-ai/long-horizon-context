//! Ported from packages/lhc/test/fixtures/corrupt.ts.
//!
//! The one sanctioned below-SDK write surface in the test suite. REAL — raw
//! sqlite writers via [`open_database`] (same seam as [`super::open_raw`]).

use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};

use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::{Db, SqlParam, open_database};

/// Poison-pill bytes: `json_extract` accepts JSON5-ish form so the write
/// stores; strict `JSON.parse` rejects single quotes + trailing comma.
pub const NOT_JSON: &str = "{'unreadable': true,}";

fn open_db(path: &str) -> Db {
    match open_database(path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("corrupt fixture open failed: {}", error.reason),
    }
}

/// Always close (TS `finally`), including when the body panics.
fn with_db<R>(path: &str, body: impl FnOnce(&Db) -> R) -> R {
    let db = open_db(path);
    let result = catch_unwind(AssertUnwindSafe(|| body(&db)));
    db.close();
    match result {
        Ok(value) => value,
        Err(payload) => resume_unwind(payload),
    }
}

/// Inserts a second `status='open'` turn row — a state no public operation
/// can produce (the state machine always closes before opening).
pub fn corrupt_two_open_turns(path: &str) {
    with_db(path, |db| {
        let row = db
            .prepare("SELECT MAX(turn_order) AS max_order FROM turns")
            .get();
        let max_order = row
            .as_ref()
            .and_then(|m| m.get("max_order"))
            .and_then(|v| match v {
                serde_json::Value::Number(n) => n.as_i64(),
                serde_json::Value::Null => None,
                _ => None,
            })
            .unwrap_or(0);
        let next_order = max_order + 1;
        let turn_id = format!("t{next_order}");
        db.prepare(
            "INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order) VALUES (?, ?, 'open', ?)",
        )
        .run(&[
            SqlParam::from(turn_id.as_str()),
            SqlParam::from(next_order),
            SqlParam::from(0i64),
        ]);
    });
}

/// Overwrite one message's block content with bytes strict JSON parsing rejects.
pub fn poison_message_block_json(path: &str, message_id: &str) {
    with_db(path, |db| {
        db.prepare("UPDATE message_block SET content = ? WHERE message_id = ?")
            .run(&[SqlParam::from(NOT_JSON), SqlParam::from(message_id)]);
    });
}

/// Overwrite one message's derived-form metadata with the same poison bytes.
pub fn poison_message_form_json(path: &str, message_id: &str) {
    with_db(path, |db| {
        db.prepare(
            "UPDATE derivation SET metadata = ?
             WHERE subject_kind = 'message' AND subject_id = ?",
        )
        .run(&[SqlParam::from(NOT_JSON), SqlParam::from(message_id)]);
    });
}
