//! Ported from packages/lhc/src/thread-view/internal/compact-compute.ts.
//!
//! Shared compact selection: readSelectionInputs, optional chunk-material
//! resolution, selectArrangement, and first-kept message identity. Both
//! previewCompact and compact call this path so compactPoint prediction is
//! exact by construction.

use indexmap::IndexMap;

use super::super::CompactAbortSignal;
use super::render::CompactChunkMaterialSnapshot;
use super::select::{
    CanonicalCorruptionCode, CanonicalCorruptionError, PI_MAPPABLE_MESSAGE_KINDS, SelectionConfig,
    SelectionInputs, SelectionResult, read_selection_inputs, select_arrangement,
};
use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult};
use crate::shared_tech::persist::DbReadTransaction;
use crate::shared_tech::storage::{Db, SqlParam};
use crate::shared_tech::view::ViewProfile;
use crate::turns::internal::chunk_recovery::CompactChunkMaterial;
use crate::turns::{ChunkDeriveDerivationType, get_chunk_text};

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
    /// Compact point must stay at or behind this event order.
    pub compact_point_upper_bound: Option<i64>,
}

/// Re-read `.aborted` each call so a getter-based / atomic signal stays live
/// (TS `signal?.aborted === true`). Do not snapshot into a local bool.
pub fn compact_stopped(signal: Option<&CompactAbortSignal>) -> bool {
    matches!(signal, Some(s) if s.aborted())
}

/// messageId of the first PI-mappable live message past the compact point.
pub fn first_pi_mappable_message_past(db: &Db, compact_point: i64) -> Option<String> {
    let placeholders = PI_MAPPABLE_MESSAGE_KINDS
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("{SQL_FIRST_PI_MAPPABLE_PREFIX}{placeholders}{SQL_FIRST_PI_MAPPABLE_SUFFIX}");
    let mut params: Vec<SqlParam> = Vec::with_capacity(1 + PI_MAPPABLE_MESSAGE_KINDS.len());
    params.push(SqlParam::from(compact_point));
    for kind in PI_MAPPABLE_MESSAGE_KINDS {
        params.push(SqlParam::from(kind));
    }
    let row = db.prepare(&sql).get_params(&params)?;
    Some(
        row.get("message_id")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("message_id missing"))
            .to_string(),
    )
}

fn corruption_op_err<T>(cause: CanonicalCorruptionError) -> OpResult<T> {
    let code = match cause.code {
        CanonicalCorruptionCode::TurnStateCorrupt => ErrorCode::TurnStateCorrupt,
        CanonicalCorruptionCode::SourceDamaged => ErrorCode::SourceDamaged,
    };
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::StateCorruption,
            code,
            reason: cause.reason,
            event_index: None,
        },
    }
}

fn resolve_chunk_materials(
    transaction: &DbReadTransaction,
    inputs: &SelectionInputs,
    signal: Option<&CompactAbortSignal>,
) -> OpResult<IndexMap<String, CompactChunkMaterialSnapshot>> {
    use super::select::SelectionChunkStatus;

    let mut compact_chunk_materials = IndexMap::new();
    for chunk in &inputs.chunks {
        if chunk.status != SelectionChunkStatus::Closed {
            continue;
        }
        for derivation_type in [
            ChunkDeriveDerivationType::ChunkSummaryDetailed,
            ChunkDeriveDerivationType::ChunkSummaryBrief,
        ] {
            // Abort check point: before each chunk-material fetch (TS loop body).
            if compact_stopped(signal) {
                return OpResult::Err {
                    error: ErrorResult {
                        error_class: ErrorClass::CallerError,
                        code: ErrorCode::CompactStopped,
                        reason: DIAG_COMPACT_STOPPED_DURING_FALLBACK_ASSEMBLY.to_string(),
                        event_index: None,
                    },
                };
            }
            let material = get_chunk_text(transaction, &chunk.chunk_id, Some(derivation_type));
            let mapped = match material {
                CompactChunkMaterial::Blocked { reason } => {
                    return OpResult::Err {
                        error: ErrorResult {
                            error_class: ErrorClass::StateCorruption,
                            code: ErrorCode::SourceDamaged,
                            reason,
                            event_index: None,
                        },
                    };
                }
                CompactChunkMaterial::Ready { content } => {
                    CompactChunkMaterialSnapshot::Ready { content }
                }
                CompactChunkMaterial::Concat { content, reason } => {
                    CompactChunkMaterialSnapshot::Concat { content, reason }
                }
            };
            compact_chunk_materials.insert(
                format!("{}/{}", chunk.chunk_id, derivation_type.as_str()),
                mapped,
            );
        }
    }
    OpResult::Ok {
        value: compact_chunk_materials,
    }
}

pub fn compute_arrangement(
    db: &Db,
    transaction: &DbReadTransaction,
    merged: &ViewProfile,
    opts: &ComputeArrangementOpts,
) -> OpResult<ArrangementComputeResult> {
    // Abort check point: before assembly / selection reads.
    if compact_stopped(opts.signal.as_ref()) {
        return OpResult::Err {
            error: ErrorResult {
                error_class: ErrorClass::CallerError,
                code: ErrorCode::CompactStopped,
                reason: DIAG_COMPACT_STOPPED_BEFORE_ASSEMBLY.to_string(),
                event_index: None,
            },
        };
    }

    let mut inputs = match read_selection_inputs(db) {
        Ok(inputs) => inputs,
        Err(cause) => return corruption_op_err(cause),
    };

    if opts.include_chunk_materials {
        let materials = resolve_chunk_materials(transaction, &inputs, opts.signal.as_ref());
        let materials = match materials {
            OpResult::Ok { value } => value,
            OpResult::Err { error } => return OpResult::Err { error },
        };
        inputs.compact_chunk_materials = Some(materials);
    }

    let selection = match select_arrangement(
        &inputs,
        &SelectionConfig {
            lower_bound: merged.lower_bound,
            percentages: merged.percentages.clone(),
            compact_point_upper_bound: opts.compact_point_upper_bound,
        },
    ) {
        Ok(selection) => selection,
        Err(cause) => return corruption_op_err(cause),
    };

    let view_id = format!("v{}", inputs.max_event_order);
    // At compact point 0 this is the thread's first mappable message (rebuild
    // still needs an anchor). Null only when the thread has no mappable messages.
    let first_kept_message_id = first_pi_mappable_message_past(db, selection.compact_point);

    OpResult::Ok {
        value: ArrangementComputeResult {
            selection,
            inputs,
            view_id,
            first_kept_message_id,
        },
    }
}
