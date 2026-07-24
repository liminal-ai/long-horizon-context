//! Ported from packages/lhc/src/thread-view/internal/boundary.ts.
//!
//! Visibility boundary. The boundary is a source event order shared with the
//! compact point's coordinate system; tool results at-or-behind it render short.
//! Compact resets it inside compact's own transaction.

use crate::shared_tech::storage::Db;

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

/// The singleton row is seeded at thread creation (position 0, everything full).
/// A missing row is a damaged thread file, surfaced as a throw for the
/// operation boundary's storage_failure wrap.
pub fn read_boundary_position(_db: &Db) -> i64 {
    todo!("phase 2")
}

/// The visibility zone's token sum: live (deleted-filtered) tool results ahead
/// of both the boundary position and the compact point, one indexed query.
pub fn visibility_zone_tokens(_db: &Db, _position: i64, _compact_point: i64) -> i64 {
    todo!("phase 2")
}
