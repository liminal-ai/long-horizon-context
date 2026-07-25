//! Ported from packages/lhc/src/thread-view/internal/boundary.ts.
//!
//! Visibility boundary. The boundary is a source event order shared with the
//! compact point's coordinate system; tool results at-or-behind it render short.
//! Compact resets it inside compact's own transaction.

use serde_json::Value;

use super::exact_i64::f64_to_exact_i64;
use crate::shared_tech::storage::{Db, SqlParam};

/// TS SQL — exact source bytes.
pub(crate) const SQL_READ_BOUNDARY_POSITION: &str =
    "SELECT position FROM view_boundary WHERE thread_singleton = 1";

/// TS SQL — exact source bytes (including newlines/indent).
pub(crate) const SQL_VISIBILITY_ZONE_TOKENS: &str =
    "SELECT COALESCE(SUM(token_estimate), 0) AS zone FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL
         AND source_event_order > ? AND source_event_order > ?";

/// TS `throw new Error("view_boundary singleton row missing (thread creation seeds it)")`.
pub(crate) const DIAG_VIEW_BOUNDARY_SINGLETON_MISSING: &str =
    "view_boundary singleton row missing (thread creation seeds it)";

fn map_required_i64(row: &serde_json::Map<String, Value>, key: &str) -> i64 {
    match row.get(key) {
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                return i;
            }
            if let Some(f) = n.as_f64() {
                return f64_to_exact_i64(f).unwrap_or_else(|| panic!("column {key} not integer"));
            }
            panic!("column {key} not integer");
        }
        Some(Value::String(s)) => s
            .parse::<i64>()
            .unwrap_or_else(|_| panic!("column {key} not integer")),
        _ => panic!("missing column {key}"),
    }
}

/// The singleton row is seeded at thread creation (position 0, everything full).
/// A missing row is a damaged thread file, surfaced as a throw for the
/// operation boundary's storage_failure wrap.
pub fn read_boundary_position(db: &Db) -> i64 {
    let row = db.prepare(SQL_READ_BOUNDARY_POSITION).get();
    let Some(row) = row else {
        panic!("{DIAG_VIEW_BOUNDARY_SINGLETON_MISSING}");
    };
    map_required_i64(&row, "position")
}

/// The visibility zone's token sum: live (deleted-filtered) tool results ahead
/// of both the boundary position and the compact point, one indexed query.
pub fn visibility_zone_tokens(db: &Db, position: i64, compact_point: i64) -> i64 {
    let row = db
        .prepare(SQL_VISIBILITY_ZONE_TOKENS)
        .get_params(&[SqlParam::from(position), SqlParam::from(compact_point)]);
    // COALESCE always yields a row under node:sqlite / our adapter.
    match row {
        Some(row) => map_required_i64(&row, "zone"),
        None => 0,
    }
}
