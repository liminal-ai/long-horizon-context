"""Ported from packages/lhc/src/thread-view/internal/compact-compute.ts. Phase 1 skeleton.

Shared compact selection: readSelectionInputs, optional chunk-material
resolution, selectArrangement, and first-kept message identity. Both
previewCompact and compact call this path so compactPoint prediction is
exact by construction.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Union

from ...shared_tech.errors import ErrorResult, OpErr, OpOk, OpResult
from ...shared_tech.persist import DbReadTransaction
from ...shared_tech.storage import Database
from ...shared_tech.view import ViewProfile
from .render import CompactChunkMaterialConcat, CompactChunkMaterialReady
from .select import (
    CanonicalCorruptionError,
    PI_MAPPABLE_MESSAGE_KINDS,
    SelectionConfig,
    SelectionInputs,
    SelectionResult,
    read_selection_inputs,
    select_arrangement,
)

# messageId of the first PI-mappable live message past the compact point.
_SQL_FIRST_PI_MAPPABLE_PREFIX = (
    """SELECT m.message_id
       FROM message m
       WHERE m.deleted_at IS NULL
         AND m.source_event_order > ?
         AND m.kind IN ("""
)

_SQL_FIRST_PI_MAPPABLE_SUFFIX = """)
       ORDER BY m.source_event_order
       LIMIT 1"""


@dataclass(frozen=True, slots=True)
class ArrangementComputeResult:
    selection: SelectionResult
    inputs: SelectionInputs
    view_id: str
    first_kept_message_id: str | None


@dataclass(frozen=True, slots=True)
class _AbortSignal:
    """TS `{ aborted: boolean }` — dot-accessed shape (not a Protocol).

    Public CompactAbortSignal is the same shape. Tests that need a live getter
    (TS `get aborted()`) may pass a dynamic-property object; Phase 1 only
    reads `.aborted` at runtime.
    """

    aborted: bool


def compact_stopped(signal: _AbortSignal | None) -> bool:
    # Re-read `.aborted` each call so a getter-based signal stays live (TS
    # `signal?.aborted === true`). Do not snapshot into a local bool.
    return signal is not None and signal.aborted is True


def first_pi_mappable_message_past(db: Database, compact_point: int) -> str | None:
    placeholders = ", ".join("?" for _ in PI_MAPPABLE_MESSAGE_KINDS)
    row = db.prepare(
        _SQL_FIRST_PI_MAPPABLE_PREFIX + placeholders + _SQL_FIRST_PI_MAPPABLE_SUFFIX
    ).get(compact_point, *PI_MAPPABLE_MESSAGE_KINDS)
    if row is None:
        return None
    message_id = row["message_id"]
    return str(message_id) if message_id is not None else None


CompactChunkMaterialMapValue = Union[CompactChunkMaterialReady, CompactChunkMaterialConcat]


def _resolve_chunk_materials(
    transaction: DbReadTransaction,
    inputs: SelectionInputs,
    signal: _AbortSignal | None,
) -> OpResult[dict[str, CompactChunkMaterialMapValue]]:
    from ...turns import get_chunk_text

    compact_chunk_materials: dict[str, CompactChunkMaterialMapValue] = {}
    for chunk in inputs.chunks:
        if chunk.status != "closed":
            continue
        for derivation_type in ("chunk_summary_detailed", "chunk_summary_brief"):
            if compact_stopped(signal):
                return OpErr(
                    error=ErrorResult(
                        error_class="caller_error",
                        code="compact_stopped",
                        reason="compact stopped during fallback assembly",
                    )
                )
            material = get_chunk_text(transaction, chunk.chunk_id, derivation_type)
            if material.kind == "blocked":
                return OpErr(
                    error=ErrorResult(
                        error_class="state_corruption",
                        code="source_damaged",
                        reason=material.reason,
                    )
                )
            # Nominal boundary: turns CompactChunk* → render CompactChunkMaterial*
            if material.kind == "ready":
                mapped: CompactChunkMaterialMapValue = CompactChunkMaterialReady(
                    content=material.content
                )
            else:
                mapped = CompactChunkMaterialConcat(
                    content=material.content, reason=material.reason
                )
            compact_chunk_materials[f"{chunk.chunk_id}/{derivation_type}"] = mapped
    return OpOk(compact_chunk_materials)


@dataclass(frozen=True, slots=True)
class ComputeArrangementOpts:
    """TS `{ signal?; includeChunkMaterials }` — include_chunk_materials required."""

    include_chunk_materials: bool
    signal: _AbortSignal | None = None


def compute_arrangement(
    db: Database,
    transaction: DbReadTransaction,
    merged: ViewProfile,
    opts: ComputeArrangementOpts,
) -> OpResult[ArrangementComputeResult]:
    if compact_stopped(opts.signal):
        return OpErr(
            error=ErrorResult(
                error_class="caller_error",
                code="compact_stopped",
                reason="compact stopped before assembly",
            )
        )

    try:
        inputs = read_selection_inputs(db)
    except CanonicalCorruptionError as cause:
        return OpErr(
            error=ErrorResult(
                error_class="state_corruption",
                code=cause.code,
                reason=str(cause),
            )
        )

    if opts.include_chunk_materials:
        materials = _resolve_chunk_materials(transaction, inputs, opts.signal)
        if not materials.ok:
            return materials
        inputs = replace(inputs, compact_chunk_materials=materials.value)

    selection = select_arrangement(
        inputs,
        SelectionConfig(
            lower_bound=merged.lower_bound,
            percentages=merged.percentages,
        ),
    )
    view_id = f"v{inputs.max_event_order}"
    # At compact point 0 this is the thread's first mappable message (rebuild
    # still needs an anchor). Null only when the thread has no mappable messages.
    first_kept_message_id = first_pi_mappable_message_past(db, selection.compact_point)

    return OpOk(
        ArrangementComputeResult(
            selection=selection,
            inputs=inputs,
            view_id=view_id,
            first_kept_message_id=first_kept_message_id,
        )
    )
