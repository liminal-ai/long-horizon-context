"""Ported from packages/lhc/src/thread-view/internal/compact-compute.ts. Phase 1 skeleton.

Shared compact selection: readSelectionInputs, optional chunk-material
resolution, selectArrangement, and first-kept message identity. Both
previewCompact and compact call this path so compactPoint prediction is
exact by construction.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Union

from ...shared_tech.errors import OpResult
from ...shared_tech.persist import DbReadTransaction
from ...shared_tech.storage import Database
from ...shared_tech.view import ViewProfile
from .render import CompactChunkMaterialConcat, CompactChunkMaterialReady
from .select import SelectionInputs, SelectionResult

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
    raise NotImplementedError


def first_pi_mappable_message_past(db: Database, compact_point: int) -> str | None:
    raise NotImplementedError


CompactChunkMaterialMapValue = Union[CompactChunkMaterialReady, CompactChunkMaterialConcat]


def _resolve_chunk_materials(
    transaction: DbReadTransaction,
    inputs: SelectionInputs,
    signal: _AbortSignal | None,
) -> OpResult[dict[str, CompactChunkMaterialMapValue]]:
    raise NotImplementedError


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
    raise NotImplementedError
