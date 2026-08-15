//! Ported from packages/lhc/src/thread-view/internal/snapshot.ts.
//!
//! Stored view snapshot reads and the one atomic compact writer. This module
//! reads the snapshot header and bands, the live tail messages after the compact
//! point, and the tail token sum. Direct record/derivation reads are contained
//! to thread-view internals; status derivation counting still goes through the
//! owners' report surfaces in index.ts.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::exact_i64::f64_to_exact_i64;
use crate::shared_tech::derivation::RenderingPartKind;
use crate::shared_tech::storage::{Db, SqlParam};
use crate::shared_tech::view::{
    Band, StoredView, StoredViewArrangementEntry, StoredViewBand, StoredViewConfig, StoredViewGap,
    StoredViewSourceState,
};

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

fn map_required_str(row: &Map<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("missing column {key}"))
        .to_string()
}

/// Exact integer domain only — Amendment I keeps event orders / compact points /
/// token counts / derivation counts as integers. Fractional or non-finite
/// numbers are corruption (never `as i64` truncate). Integral JSON/SQLite
/// reals (`1.0`) are accepted when exactly representable in `i64`.
///
/// Note: `i64::MAX as f64` rounds to `2^63`, so an upper bound of
/// `<= i64::MAX as f64` would incorrectly accept `9223372036854775808.0` and
/// saturate on cast. Shared conversion: [`super::exact_i64::f64_to_exact_i64`].
fn require_exact_i64(value: &Value, label: &str) -> i64 {
    match value {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return i;
            }
            if let Some(f) = n.as_f64() {
                return f64_to_exact_i64(f).unwrap_or_else(|| panic!("{label} must be an integer"));
            }
            panic!("{label} must be an integer");
        }
        Value::String(s) => s
            .parse::<i64>()
            .unwrap_or_else(|_| panic!("{label} must be an integer")),
        _ => panic!("{label} must be an integer"),
    }
}

fn map_required_i64(row: &Map<String, Value>, key: &str) -> i64 {
    match row.get(key) {
        Some(v) => require_exact_i64(v, &format!("column {key}")),
        None => panic!("missing column {key}"),
    }
}

fn map_optional_str(row: &Map<String, Value>, key: &str) -> Option<String> {
    match row.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => panic!("column {key} not text: {other}"),
    }
}

fn rendering_part_kind_from_wire(kind: &str) -> RenderingPartKind {
    match kind {
        "user_prompt" => RenderingPartKind::UserPrompt,
        "assistant_text" => RenderingPartKind::AssistantText,
        "assistant_thinking" => RenderingPartKind::AssistantThinking,
        "runtime_note" => RenderingPartKind::RuntimeNote,
        "model_change" => RenderingPartKind::ModelChange,
        "thinking_level_change" => RenderingPartKind::ThinkingLevelChange,
        "tool_call" => RenderingPartKind::ToolCall,
        "tool_result" => RenderingPartKind::ToolResult,
        "compact_continuation_marker" => RenderingPartKind::CompactContinuationMarker,
        other => panic!("unknown message kind from row: {other}"),
    }
}

/// Amendment I — parse `StoredViewConfig` with `f64` leaves verbatim.
/// Never int()-truncate `lowerBound` / percentage values.
fn parse_stored_config(json: &str) -> StoredViewConfig {
    let raw: Value = serde_json::from_str(json).unwrap_or_else(|err| panic!("{err}"));
    let obj = raw
        .as_object()
        .unwrap_or_else(|| panic!("config_json must be an object"));
    let lower_bound = obj
        .get("lowerBound")
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("config.lowerBound must be a number"));
    let percentages_raw = obj
        .get("percentages")
        .and_then(Value::as_object)
        .unwrap_or_else(|| panic!("config.percentages must be an object"));
    let mut percentages = indexmap::IndexMap::new();
    for (key, value) in percentages_raw {
        let n = value
            .as_f64()
            .unwrap_or_else(|| panic!("config.percentages.{key} must be a number"));
        percentages.insert(key.clone(), n);
    }
    StoredViewConfig {
        lower_bound,
        percentages,
    }
}

/// Nested type → state → count map, persisted verbatim from SelectionInputs.
/// Never flatten/sum to a single count per derivation type.
fn parse_stored_source_state(json: &str) -> StoredViewSourceState {
    let raw: Value = serde_json::from_str(json).unwrap_or_else(|err| panic!("{err}"));
    let obj = raw
        .as_object()
        .unwrap_or_else(|| panic!("source_state_json must be an object"));
    let max_event_order = obj
        .get("maxEventOrder")
        .map(|v| require_exact_i64(v, "sourceState.maxEventOrder"))
        .unwrap_or_else(|| panic!("sourceState.maxEventOrder must be an integer"));
    let counts_raw = obj
        .get("derivationCounts")
        .and_then(Value::as_object)
        .unwrap_or_else(|| panic!("sourceState.derivationCounts must be an object"));
    let mut derivation_counts = indexmap::IndexMap::new();
    for (type_key, state_map_val) in counts_raw {
        let state_map = state_map_val.as_object().unwrap_or_else(|| {
            panic!(
                "sourceState.derivationCounts.{type_key} must be a nested state→count object \
                 (never a flattened number)"
            )
        });
        let mut inner = indexmap::IndexMap::new();
        for (state_key, count_val) in state_map {
            let count = require_exact_i64(
                count_val,
                &format!("sourceState.derivationCounts.{type_key}.{state_key}"),
            );
            inner.insert(state_key.clone(), count);
        }
        derivation_counts.insert(type_key.clone(), inner);
    }
    StoredViewSourceState {
        max_event_order,
        derivation_counts,
    }
}

fn parse_stored_arrangement(json: &str) -> Vec<StoredViewArrangementEntry> {
    serde_json::from_str(json).unwrap_or_else(|err| panic!("{err}"))
}

fn parse_stored_gaps(json: &str) -> Vec<StoredViewGap> {
    serde_json::from_str(json).unwrap_or_else(|err| panic!("{err}"))
}

/// null means no view exists (never compacted): the whole record renders as tail
/// from event 1 through the same serving assembly path, snapshot-absent rather
/// than a separate branch.
pub fn read_view_snapshot(db: &Db) -> Option<ViewSnapshot> {
    let header_row = db.prepare(SQL_READ_VIEW_SNAPSHOT).get()?;
    let header = RawViewRow {
        view_id: map_required_str(&header_row, "view_id"),
        created_at: map_required_str(&header_row, "created_at"),
        compact_point: map_required_i64(&header_row, "compact_point"),
        covered_from: map_required_i64(&header_row, "covered_from"),
        arrangement_json: map_required_str(&header_row, "arrangement_json"),
        gaps_json: map_required_str(&header_row, "gaps_json"),
    };

    let arrangement: Value =
        serde_json::from_str(&header.arrangement_json).unwrap_or_else(|err| panic!("{err}"));
    let gaps: Value = serde_json::from_str(&header.gaps_json).unwrap_or_else(|err| panic!("{err}"));
    let arrangement_arr = arrangement
        .as_array()
        .unwrap_or_else(|| panic!("arrangement_json must be an array"));
    let gaps_arr = gaps
        .as_array()
        .unwrap_or_else(|| panic!("gaps_json must be an array"));

    let band_rows = db
        .prepare(SQL_READ_VIEW_BANDS)
        .all(&[SqlParam::from(header.view_id.as_str())]);
    let by_band: HashMap<String, Map<String, Value>> = band_rows
        .into_iter()
        .map(|row| (map_required_str(&row, "band"), row))
        .collect();

    let bands: Vec<ViewSnapshotBand> = BAND_GRADIENT_ORDER
        .into_iter()
        .filter_map(|band| {
            let row = by_band.get(band.as_str())?;
            Some(ViewSnapshotBand {
                band,
                rendered_text: map_required_str(row, "rendered_text"),
                token_count: map_required_i64(row, "token_count"),
            })
        })
        .collect();

    let degraded_count = arrangement_arr
        .iter()
        .filter(|entry| entry.get("degraded") == Some(&Value::Bool(true)))
        .count() as i64;

    Some(ViewSnapshot {
        view_id: header.view_id,
        created_at: header.created_at,
        compact_point: header.compact_point,
        covered_from: header.covered_from,
        gap_count: gaps_arr.len() as i64,
        degraded_count,
        bands,
    })
}

/// The full stored row for `describe`: everything compact wrote, parsed
/// verbatim. Arrangement, gaps, config, source-state provenance, and per-band
/// stored token counts are read from the snapshot, never recomputed.
pub fn read_stored_view(db: &Db) -> Option<StoredView> {
    let header = db.prepare(SQL_READ_STORED_VIEW).get()?;
    let view_id = map_required_str(&header, "view_id");

    let band_rows = db
        .prepare(SQL_READ_STORED_VIEW_BANDS)
        .all(&[SqlParam::from(view_id.as_str())]);
    let by_band: HashMap<String, Map<String, Value>> = band_rows
        .into_iter()
        .map(|row| (map_required_str(&row, "band"), row))
        .collect();

    let bands: Vec<StoredViewBand> = BAND_GRADIENT_ORDER
        .into_iter()
        .filter_map(|band| {
            let row = by_band.get(band.as_str())?;
            Some(StoredViewBand {
                band,
                stored_tokens: map_required_i64(row, "token_count"),
            })
        })
        .collect();

    Some(StoredView {
        view_id,
        created_at: map_required_str(&header, "created_at"),
        compact_point: map_required_i64(&header, "compact_point"),
        covered_from: map_required_i64(&header, "covered_from"),
        profile_name: map_optional_str(&header, "profile_name"),
        // Amendment I: f64 leaves via as_f64 — never int-truncate.
        config: parse_stored_config(&map_required_str(&header, "config_json")),
        arrangement: parse_stored_arrangement(&map_required_str(&header, "arrangement_json")),
        gaps: parse_stored_gaps(&map_required_str(&header, "gaps_json")),
        // Nested type→state→count; reject flattened numbers.
        source_state: parse_stored_source_state(&map_required_str(&header, "source_state_json")),
        bands,
    })
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
pub fn read_tail_messages(db: &Db, compact_point: i64) -> Vec<TailMessageRow> {
    let message_rows = db
        .prepare(SQL_READ_TAIL_MESSAGES)
        .all(&[SqlParam::from(compact_point)]);
    let block_rows = db
        .prepare(SQL_READ_TAIL_BLOCKS)
        .all(&[SqlParam::from(compact_point)]);

    let mut blocks_by_message: HashMap<String, Vec<TailMessageBlock>> = HashMap::new();
    for row in block_rows {
        let message_id = map_required_str(&row, "message_id");
        let content_raw = map_required_str(&row, "content");
        let parsed: Value =
            serde_json::from_str(&content_raw).unwrap_or_else(|err| panic!("{err}"));
        let content = match parsed {
            Value::Object(map) => map,
            other => panic!("message_block.content must be an object, got {other}"),
        };
        blocks_by_message
            .entry(message_id)
            .or_default()
            .push(TailMessageBlock {
                block_type: map_required_str(&row, "block_type"),
                content,
            });
    }

    message_rows
        .into_iter()
        .map(|row| {
            let message_id = map_required_str(&row, "message_id");
            TailMessageRow {
                message_id: message_id.clone(),
                source_event_order: map_required_i64(&row, "source_event_order"),
                idempotency_key: map_optional_str(&row, "idempotency_key"),
                kind: rendering_part_kind_from_wire(&map_required_str(&row, "kind")),
                recorded_at: map_required_str(&row, "recorded_at"),
                blocks: blocks_by_message.remove(&message_id).unwrap_or_default(),
            }
        })
        .collect()
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
pub fn read_thread_metadata(db: &Db) -> ThreadMetadata {
    let row = db.prepare(SQL_READ_THREAD_METADATA).get();
    let Some(row) = row else {
        panic!("{DIAG_THREAD_METADATA_SINGLETON_MISSING}");
    };
    ThreadMetadata {
        thread_id: map_required_str(&row, "thread_id"),
        created_at: map_required_str(&row, "created_at"),
    }
}

/// The tail's token sum for status: every live message after the compact point,
/// all kinds. This is the same population the serving assembly renders as tail.
pub fn tail_token_sum(db: &Db, compact_point: i64) -> i64 {
    let row = db
        .prepare(SQL_TAIL_TOKEN_SUM)
        .get_params(&[SqlParam::from(compact_point)])
        .unwrap_or_else(|| panic!("tail token sum row missing"));
    map_required_i64(&row, "total")
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
    /// Visibility boundary written in the same transaction as the view replace.
    /// Defaults to compact_point (historical compact reset). Protected-escalation
    /// installs may advance to a higher proposed boundary atomically.
    pub visibility_boundary: Option<i64>,
}

/// Compact's one transaction: delete the singleton view row (the FK cascade
/// drops its bands), insert the new header and bands, and reset the boundary
/// to the compact point. All inside one BEGIN IMMEDIATE, so a crash anywhere
/// rolls the whole replace back and the previous view keeps serving. Compact is
/// the writer of view rows and the boundary reset on compact.
///
/// `config_json` / `arrangement_json` / `gaps_json` / `source_state_json` are
/// stored verbatim (callers must produce them via `js_json`); this path never
/// re-parses or rewrites those blobs.
///
/// `before_replace` may return a source_state_json override computed after
/// in-transaction validation (e.g. post-marker digests). When it returns
/// `Some(String)`, that value is written; otherwise `input.source_state_json`
/// is used.
pub fn replace_view_snapshot(db: &Db, input: &ViewReplaceInput) {
    replace_view_snapshot_with(db, input, None)
}

/// Like [`replace_view_snapshot`], with an optional in-transaction
/// `before_replace` callback (TS `beforeReplace`).
pub fn replace_view_snapshot_with(
    db: &Db,
    input: &ViewReplaceInput,
    before_replace: Option<&mut dyn FnMut(&Db) -> Option<String>>,
) {
    db.exec(SQL_BEGIN_IMMEDIATE);
    let result = catch_unwind(AssertUnwindSafe(|| {
        let source_state_json = match before_replace {
            Some(cb) => cb(db).unwrap_or_else(|| input.source_state_json.clone()),
            None => input.source_state_json.clone(),
        };
        db.prepare(SQL_DELETE_THREAD_VIEW).run(&[]);
        db.prepare(SQL_INSERT_THREAD_VIEW).run(&[
            SqlParam::from(input.view_id.as_str()),
            SqlParam::from(input.created_at.as_str()),
            SqlParam::from(input.compact_point),
            SqlParam::from(input.covered_from),
            SqlParam::from(input.profile_name.as_deref()),
            SqlParam::from(input.config_json.as_str()),
            SqlParam::from(input.arrangement_json.as_str()),
            SqlParam::from(input.gaps_json.as_str()),
            SqlParam::from(source_state_json.as_str()),
        ]);
        let insert_band = db.prepare(SQL_INSERT_THREAD_VIEW_BAND);
        for band in &input.bands {
            insert_band.run(&[
                SqlParam::from(input.view_id.as_str()),
                SqlParam::from(band.band.as_str()),
                SqlParam::from(band.rendered_text.as_str()),
                SqlParam::from(band.token_count),
            ]);
        }
        let boundary_position = input.visibility_boundary.unwrap_or(input.compact_point);
        if boundary_position < input.compact_point {
            panic!(
                "visibility boundary {boundary_position} would land behind compact point {}",
                input.compact_point
            );
        }
        db.prepare(SQL_RESET_BOUNDARY).run(&[
            SqlParam::from(boundary_position),
            SqlParam::from(input.created_at.as_str()),
        ]);
        db.exec(SQL_COMMIT);
    }));
    match result {
        Ok(()) => {}
        Err(cause) => {
            // TS: `db.exec("ROLLBACK;"); throw cause;` — ROLLBACK errors are not
            // swallowed; a post-COMMIT ROLLBACK failure replaces the original.
            db.exec(SQL_ROLLBACK);
            resume_unwind(cause);
        }
    }
}
