//! Ported from packages/lhc/src/thread-view/internal/snapshot.ts.
//!
//! Stored view snapshot reads and the one atomic compact writer. This module
//! reads the snapshot header and bands, the live tail messages after the compact
//! point, and the tail token sum. Direct record/derivation reads are contained
//! to thread-view internals; status derivation counting still goes through the
//! owners' report surfaces in index.ts.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_tech::derivation::RenderingPartKind;
use crate::shared_tech::storage::Db;
use crate::shared_tech::view::{Band, StoredView};

/// TS `BAND_GRADIENT_ORDER` — brief → detailed → smooth.
pub(crate) const BAND_GRADIENT_ORDER: [Band; 3] = [Band::Brief, Band::Detailed, Band::Smooth];

/// TS SQL — exact source bytes.
pub(crate) const SQL_READ_VIEW_SNAPSHOT: &str =
    "SELECT view_id, created_at, compact_point, covered_from, arrangement_json, gaps_json
       FROM thread_view WHERE singleton = 1";

pub(crate) const SQL_READ_VIEW_BANDS: &str =
    "SELECT band, rendered_text, token_count FROM thread_view_band WHERE view_id = ?";

pub(crate) const SQL_READ_STORED_VIEW: &str =
    "SELECT view_id, created_at, compact_point, covered_from, profile_name,
              config_json, arrangement_json, gaps_json, source_state_json
       FROM thread_view WHERE singleton = 1";

pub(crate) const SQL_READ_STORED_VIEW_BANDS: &str =
    "SELECT band, token_count FROM thread_view_band WHERE view_id = ?";

pub(crate) const SQL_READ_TAIL_MESSAGES: &str =
    "SELECT m.message_id, m.source_event_order, m.kind, e.recorded_at, e.idempotency_key FROM message m
       JOIN event e ON e.event_order = m.source_event_order
       WHERE m.deleted_at IS NULL AND m.source_event_order > ?
       ORDER BY m.source_event_order";

pub(crate) const SQL_READ_TAIL_BLOCKS: &str = "SELECT mb.message_id, mb.block_type, mb.content
       FROM message_block mb JOIN message m ON m.message_id = mb.message_id
       WHERE m.deleted_at IS NULL AND m.source_event_order > ?
       ORDER BY m.source_event_order, mb.block_index";

pub(crate) const SQL_READ_THREAD_METADATA: &str =
    "SELECT thread_id, created_at FROM thread_metadata WHERE id = 1";

pub(crate) const SQL_TAIL_TOKEN_SUM: &str =
    "SELECT COALESCE(SUM(token_estimate), 0) AS total FROM message
       WHERE deleted_at IS NULL AND source_event_order > ?";

pub(crate) const SQL_DELETE_THREAD_VIEW: &str = "DELETE FROM thread_view WHERE singleton = 1";

pub(crate) const SQL_INSERT_THREAD_VIEW: &str =
    "INSERT INTO thread_view (singleton, view_id, created_at, compact_point, covered_from,
         profile_name, config_json, arrangement_json, gaps_json, source_state_json)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

pub(crate) const SQL_INSERT_THREAD_VIEW_BAND: &str =
    "INSERT INTO thread_view_band (view_id, band, rendered_text, token_count)
       VALUES (?, ?, ?, ?)";

pub(crate) const SQL_RESET_BOUNDARY: &str =
    "UPDATE view_boundary SET position = ?, updated_at = ? WHERE thread_singleton = 1";

/// TS `db.exec("BEGIN IMMEDIATE;")` — module-local transaction literal.
pub(crate) const SQL_BEGIN_IMMEDIATE: &str = "BEGIN IMMEDIATE;";
/// TS `db.exec("COMMIT;")`.
pub(crate) const SQL_COMMIT: &str = "COMMIT;";
/// TS `db.exec("ROLLBACK;")`.
pub(crate) const SQL_ROLLBACK: &str = "ROLLBACK;";

/// TS private `RawViewRow` — header columns from `SQL_READ_VIEW_SNAPSHOT`.
#[derive(Debug, Clone, PartialEq)]
struct RawViewRow {
    view_id: String,
    created_at: String,
    compact_point: i64,
    covered_from: i64,
    arrangement_json: String,
    gaps_json: String,
}

// ── view snapshot (header + bands) ────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSnapshotBand {
    pub band: Band,
    pub rendered_text: String,
    pub token_count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSnapshot {
    pub view_id: String,
    pub created_at: String,
    pub compact_point: i64,
    pub covered_from: i64,
    pub gap_count: i64,
    pub degraded_count: i64,
    /// Non-empty bands in gradient order (brief → detailed → smooth), the order
    /// the serving assembly prepends them in.
    pub bands: Vec<ViewSnapshotBand>,
}

/// null means no view exists (never compacted): the whole record renders as tail
/// from event 1 through the same serving assembly path, snapshot-absent rather
/// than a separate branch.
pub fn read_view_snapshot(_db: &Db) -> Option<ViewSnapshot> {
    todo!("phase 2")
}

/// The full stored row for `describe`: everything compact wrote, parsed
/// verbatim. Arrangement, gaps, config, source-state provenance, and per-band
/// stored token counts are read from the snapshot, never recomputed.
pub fn read_stored_view(_db: &Db) -> Option<StoredView> {
    todo!("phase 2")
}

// ── tail record reads ─────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailMessageBlock {
    pub block_type: String,
    pub content: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailMessageRow {
    pub message_id: String,
    pub source_event_order: i64,
    pub idempotency_key: Option<String>,
    pub kind: RenderingPartKind,
    /// The source event's recorded_at: materialize's entry timestamp. Generated
    /// fields derive from record times, never write-time clocks.
    pub recorded_at: String,
    pub blocks: Vec<TailMessageBlock>,
}

/// Live messages after the compact point in record order, with their projected
/// blocks. The deleted-read filter is applied here so a deleted message never
/// reaches rendering.
pub fn read_tail_messages(_db: &Db, _compact_point: i64) -> Vec<TailMessageRow> {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadata {
    pub thread_id: String,
    pub created_at: String,
}

/// TS `throw new Error("thread_metadata singleton row missing (creation writes it)")`.
pub(crate) const DIAG_THREAD_METADATA_SINGLETON_MISSING: &str =
    "thread_metadata singleton row missing (creation writes it)";

/// The thread's identity row: materialize's header source. The header id derives
/// from thread id + view created-at; a never-compacted thread's header uses the
/// thread's created-at.
pub fn read_thread_metadata(_db: &Db) -> ThreadMetadata {
    todo!("phase 2")
}

/// The tail's token sum for status: every live message after the compact point,
/// all kinds. This is the same population the serving assembly renders as tail.
pub fn tail_token_sum(_db: &Db, _compact_point: i64) -> i64 {
    todo!("phase 2")
}

// ── the atomic replace ───────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewReplaceBand {
    pub band: Band,
    pub rendered_text: String,
    pub token_count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewReplaceInput {
    pub view_id: String,
    pub created_at: String,
    pub compact_point: i64,
    pub covered_from: i64,
    pub profile_name: Option<String>,
    pub config_json: String,
    pub arrangement_json: String,
    pub gaps_json: String,
    pub source_state_json: String,
    pub bands: Vec<ViewReplaceBand>,
}

/// Compact's one transaction: delete the singleton view row (the FK cascade
/// drops its bands), insert the new header and bands, and reset the boundary
/// to the compact point. All inside one BEGIN IMMEDIATE, so a crash anywhere
/// rolls the whole replace back and the previous view keeps serving. Compact is
/// the writer of view rows and the boundary reset on compact.
pub fn replace_view_snapshot(_db: &Db, _input: &ViewReplaceInput) {
    todo!("phase 2")
}
