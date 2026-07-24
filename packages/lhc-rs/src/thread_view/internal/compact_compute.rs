//! Ported from packages/lhc/src/thread-view/internal/compact-compute.ts.
//!
//! Shared compact selection: readSelectionInputs, optional chunk-material
//! resolution, selectArrangement, and first-kept message identity. Both
//! previewCompact and compact call this path so compactPoint prediction is
//! exact by construction.

use indexmap::IndexMap;

use super::super::CompactAbortSignal;
use super::render::CompactChunkMaterialSnapshot;
use super::select::{SelectionInputs, SelectionResult};
use crate::shared_tech::errors::OpResult;
use crate::shared_tech::persist::DbReadTransaction;
use crate::shared_tech::storage::Db;
use crate::shared_tech::view::ViewProfile;

/// messageId of the first PI-mappable live message past the compact point.
/// SQL prefix/suffix split around the dynamic `IN (?, …)` placeholders —
/// exact source bytes from compact-compute.ts.
pub(crate) const SQL_FIRST_PI_MAPPABLE_PREFIX: &str = "SELECT m.message_id
       FROM message m
       WHERE m.deleted_at IS NULL
         AND m.source_event_order > ?
         AND m.kind IN (";

pub(crate) const SQL_FIRST_PI_MAPPABLE_SUFFIX: &str = ")
       ORDER BY m.source_event_order
       LIMIT 1";

/// TS compact-stop diagnostics — byte-exact from compact-compute.ts.
pub(crate) const DIAG_COMPACT_STOPPED_DURING_FALLBACK_ASSEMBLY: &str =
    "compact stopped during fallback assembly";
pub(crate) const DIAG_COMPACT_STOPPED_BEFORE_ASSEMBLY: &str = "compact stopped before assembly";

#[derive(Debug, Clone, PartialEq)]
pub struct ArrangementComputeResult {
    pub selection: SelectionResult,
    pub inputs: SelectionInputs,
    pub view_id: String,
    pub first_kept_message_id: Option<String>,
}

/// Opts for [`compute_arrangement`].
///
/// Signal is [`CompactAbortSignal`] (same by-value `{ aborted: bool }` as
/// compact opts) — no duplicate AbortSignal type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputeArrangementOpts {
    pub signal: Option<CompactAbortSignal>,
    pub include_chunk_materials: bool,
}

pub fn compact_stopped(_signal: Option<&CompactAbortSignal>) -> bool {
    todo!("phase 2")
}

/// messageId of the first PI-mappable live message past the compact point.
pub fn first_pi_mappable_message_past(_db: &Db, _compact_point: i64) -> Option<String> {
    todo!("phase 2")
}

fn resolve_chunk_materials(
    _transaction: &DbReadTransaction,
    _inputs: &SelectionInputs,
    _signal: Option<&CompactAbortSignal>,
) -> OpResult<IndexMap<String, CompactChunkMaterialSnapshot>> {
    todo!("phase 2")
}

pub fn compute_arrangement(
    _db: &Db,
    _transaction: &DbReadTransaction,
    _merged: &ViewProfile,
    _opts: &ComputeArrangementOpts,
) -> OpResult<ArrangementComputeResult> {
    todo!("phase 2")
}
