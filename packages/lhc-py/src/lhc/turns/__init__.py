"""Ported from packages/lhc/src/turns/index.ts. Phase 1 skeleton.

Full turns surface: create/list/report/derive plus structure and compact
material reads. Internal modules own store/compose/chunks/derivations/derive;
this package re-exports the public API and private index helpers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Union

from ..shared_tech.derivation import Derivation, DerivationReportEntry, ResolvedSdkConfig
from ..shared_tech.errors import ErrorResult, OpErr, OpResult
from ..shared_tech.storage import Database
from ..shared_tech.work_queue import WorkItemRecord
from ..threads import ThreadRef
from .internal.chunk_recovery import (
    CompactChunkBlocked,
    CompactChunkConcat,
    CompactChunkMaterial,
    CompactChunkReady,
)
from .internal.chunks import ChunkStructureRow
from .internal.store import TurnStructureRow

if TYPE_CHECKING:
    from ..intake_stream import EventKind
    from ..shared_tech.persist import DbReadTransaction, DbWriteTransaction


@dataclass(frozen=True, slots=True)
class TurnRecord:
    turn_id: str
    turn_order: int
    status: Literal["open", "closed"]
    member_message_ids: list[str]
    opened_at_event_order: int
    closed_at_event_order: int | None = None
    # Present once the turn's derivation placed it in a chunk. Stored values
    # read back; reads never recompute placement.
    chunk_id: str | None = None
    member_idx: int | None = None
    # Stored turn-owned derivations, attached only when rows exist. Reads
    # return stored state verbatim and never block on derivation readiness.
    derivations: list[Derivation] | None = None


@dataclass(frozen=True, slots=True)
class ChunkRecord:
    chunk_id: str
    chunk_order: int
    status: Literal["open", "closed"]
    accumulated_projected_tokens: int
    member_turn_ids: list[str]
    derivations: list[Derivation] | None = None


@dataclass(frozen=True, slots=True)
class TurnTransition:
    action: Literal["opened", "closed"]
    turn_id: str


@dataclass(frozen=True, slots=True)
class TurnTransitionOutcome:
    # Transitions in occurrence order: a close_then_open reports the close
    # first, then the open, exactly as the batch result surfaces them.
    transitions: list[TurnTransition]
    # The open turn after the transition; this is the membership stamp for
    # message-producing events.
    turn_id: str
    # Work queued by this transition: one turn_derivation item per closed
    # turn. Empty when nothing closed.
    queued_work: list[WorkItemRecord]


class TurnStateCorruptionError(Exception):
    error_class: Literal["state_corruption"] = "state_corruption"
    code: Literal["turn_state_corrupt"] = "turn_state_corrupt"


def _current_open_turn_id(transaction: DbWriteTransaction) -> str:
    raise NotImplementedError


# Closing a turn durably queues that turn's derivation work in the same
# transaction: the close update and the work item commit or roll back together.
def _close_turn_and_queue_work(
    transaction: DbWriteTransaction,
    turn_id: str,
    event_order: int,
) -> WorkItemRecord:
    raise NotImplementedError


# Cross-domain surface, called by intake-stream inside the batch transaction
# for every recorded event. Synchronous and throwing by design, like
# messages.create: a turn-storage failure rejects the whole batch.
@dataclass(frozen=True, slots=True)
class RecordedTurnEvent:
    event_kind: EventKind
    event_order: int


def create(
    transaction: DbWriteTransaction,
    recorded_event: RecordedTurnEvent,
) -> TurnTransitionOutcome:
    raise NotImplementedError


def _thread_not_found(file_path: str) -> OpErr:
    raise NotImplementedError


async def list_turns(thread_ref: ThreadRef) -> OpResult[list[TurnRecord]]:
    raise NotImplementedError


# Returns stored chunk records whatever their derivation states. Derivations
# attach only where rows exist; freshly opened chunks have none.
async def list_chunks(thread_ref: ThreadRef) -> OpResult[list[ChunkRecord]]:
    raise NotImplementedError


def get_chunk_text(
    transaction: DbReadTransaction,
    chunk_id: str,
    derivation_type: Literal["chunk_summary_detailed", "chunk_summary_brief"] = "chunk_summary_detailed",
) -> CompactChunkMaterial:
    raise NotImplementedError


# In-transaction read for coordinators that already hold an open thread
# handle (thread-view's compact selection): the turn and chunk structure on
# the caller's handle, so thread-view asks the turns owner for turn ordering,
# boundaries, and chunk membership instead of reading the turn/chunk tables
# itself. Turns carry the deleted flag and chunks carry raw (unvalidated)
# membership so the consumer keeps ownership of the source-state corruption
# policy; it never sees the live-only shapes list_turns/list_chunks return.
@dataclass(frozen=True, slots=True)
class TurnChunkStructure:
    turns: list[TurnStructureRow]
    chunks: list[ChunkStructureRow]


def read_turn_chunk_structure(db: Database) -> TurnChunkStructure:
    raise NotImplementedError


# ── report and repair ─────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class TurnReportOpts:
    not_ready: bool | None = None
    turn_id: str | None = None
    chunk_id: str | None = None


# This owner's repair report: every turn- and chunk-owned derivation's durable
# state joined with live queue detail in one query. Needs no inference;
# reads degrade, never block.
async def report(
    thread_ref: ThreadRef,
    opts: TurnReportOpts | None = None,
) -> OpResult[list[DerivationReportEntry]]:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class TurnDerived:
    turn_id: str
    source_version: int
    outcome: Literal["derived"] = "derived"


@dataclass(frozen=True, slots=True)
class TurnDeriveFailed:
    turn_id: str
    error: ErrorResult
    outcome: Literal["failed"] = "failed"


TurnDeriveResult = Union[TurnDerived, TurnDeriveFailed]


@dataclass(frozen=True, slots=True)
class ChunkDerived:
    chunk_id: str
    derivation_type: Literal["chunk_summary_detailed", "chunk_summary_brief"]
    source_version: int
    outcome: Literal["derived"] = "derived"


@dataclass(frozen=True, slots=True)
class ChunkDeriveFailed:
    chunk_id: str
    error: ErrorResult
    outcome: Literal["failed"] = "failed"


ChunkDeriveResult = Union[ChunkDerived, ChunkDeriveFailed]


@dataclass(frozen=True, slots=True)
class _ConfigRequiredError:
    error: ErrorResult


_ConfigRequiredResult = Union[ResolvedSdkConfig, _ConfigRequiredError]


def _config_required(operation: str) -> _ConfigRequiredResult:
    raise NotImplementedError


async def derive_turn(thread_ref: ThreadRef, turn_id: str) -> OpResult[TurnDeriveResult]:
    raise NotImplementedError


async def _derive_chunk(
    thread_ref: ThreadRef,
    chunk_id: str,
    derivation_type: Literal["chunk_summary_detailed", "chunk_summary_brief"],
) -> OpResult[ChunkDeriveResult]:
    raise NotImplementedError


async def derive_detailed_chunk(thread_ref: ThreadRef, chunk_id: str) -> OpResult[ChunkDeriveResult]:
    raise NotImplementedError


async def derive_brief_chunk(thread_ref: ThreadRef, chunk_id: str) -> OpResult[ChunkDeriveResult]:
    raise NotImplementedError


__all__ = [
    "ChunkDeriveFailed",
    "ChunkDeriveResult",
    "ChunkDerived",
    "ChunkRecord",
    "RecordedTurnEvent",
    "TurnChunkStructure",
    "TurnDeriveFailed",
    "TurnDeriveResult",
    "TurnDerived",
    "TurnRecord",
    "TurnReportOpts",
    "TurnStateCorruptionError",
    "TurnTransition",
    "TurnTransitionOutcome",
    "create",
    "derive_brief_chunk",
    "derive_detailed_chunk",
    "derive_turn",
    "get_chunk_text",
    "list_chunks",
    "list_turns",
    "read_turn_chunk_structure",
    "report",
]
