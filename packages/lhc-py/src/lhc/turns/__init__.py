"""Ported from packages/lhc/src/turns/index.ts. Phase 1 skeleton.

Full turns surface: create/list/report/derive plus structure and compact
material reads. Internal modules own store/compose/chunks/derivations/derive;
this package re-exports the public API and private index helpers.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Union

from ..shared_tech.derivation import Derivation, DerivationReportEntry, ResolvedSdkConfig
from ..shared_tech.errors import ErrorResult, OpErr, OpResult
from ..shared_tech.storage import Database
from ..shared_tech.work_queue import (
    EnqueueDerivationTarget,
    EnqueueInput,
    WorkItemRecord,
    enqueue,
)
from ..threads import ThreadRef
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

# IMPORT-ORDER CONSTRAINT: the internal modules below construct the record
# types defined above via runtime `from .. import ...` while this package is
# still partially initialized. The record definitions MUST stay above these
# imports — reordering breaks every import of this package.
from .internal.chunk_recovery import (
    CompactChunkBlocked,
    CompactChunkConcat,
    CompactChunkMaterial,
    CompactChunkReady,
)
from .internal.chunks import ChunkStructureRow
from .internal.store import (
    TurnStructureRow,
    close_turn,
    count_turn_members,
    insert_open_turn,
    next_turn_order,
    select_open_turn_ids,
)

if TYPE_CHECKING:
    from ..intake_stream import EventKind
    from ..shared_tech.persist import DbReadTransaction, DbWriteTransaction




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
    open_turn_ids = select_open_turn_ids(transaction.db)
    if len(open_turn_ids) != 1:
        joined = ", ".join(open_turn_ids)
        raise TurnStateCorruptionError(
            f"thread has {len(open_turn_ids)} open turns ({joined}); the invariant is exactly one"
        )
    return open_turn_ids[0]


# Closing a turn durably queues that turn's derivation work in the same
# transaction: the close update and the work item commit or roll back together.
def _close_turn_and_queue_work(
    transaction: DbWriteTransaction,
    turn_id: str,
    event_order: int,
) -> WorkItemRecord:
    close_turn(transaction.db, turn_id, event_order)
    return enqueue(
        transaction,
        EnqueueInput(
            owner="turns",
            kind="turn_derivation",
            source_ref={"turnId": turn_id},
            derivations=[
                EnqueueDerivationTarget(
                    subject_kind="turn",
                    subject_id=turn_id,
                    derivation_type="turn_rendering",
                ),
                EnqueueDerivationTarget(
                    subject_kind="turn",
                    subject_id=turn_id,
                    derivation_type="pre_detailed_assembly",
                ),
            ],
        ),
    )


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
    open_turn_id = _current_open_turn_id(transaction)
    has_members = count_turn_members(transaction.db, open_turn_id) > 0
    if recorded_event.event_kind == "turn_end":
        if not has_members:
            return TurnTransitionOutcome(
                transitions=[],
                turn_id=open_turn_id,
                queued_work=[],
            )
        item = _close_turn_and_queue_work(
            transaction, open_turn_id, recorded_event.event_order
        )
        turn_id = insert_open_turn(
            transaction.db,
            next_turn_order(transaction.db),
            recorded_event.event_order,
        )
        return TurnTransitionOutcome(
            transitions=[
                TurnTransition(action="closed", turn_id=open_turn_id),
                TurnTransition(action="opened", turn_id=turn_id),
            ],
            turn_id=turn_id,
            queued_work=[item],
        )
    if recorded_event.event_kind == "user_prompt" and has_members:
        item = _close_turn_and_queue_work(
            transaction, open_turn_id, recorded_event.event_order
        )
        turn_id = insert_open_turn(
            transaction.db,
            next_turn_order(transaction.db),
            recorded_event.event_order,
        )
        return TurnTransitionOutcome(
            transitions=[
                TurnTransition(action="closed", turn_id=open_turn_id),
                TurnTransition(action="opened", turn_id=turn_id),
            ],
            turn_id=turn_id,
            queued_work=[item],
        )
    return TurnTransitionOutcome(
        transitions=[],
        turn_id=open_turn_id,
        queued_work=[],
    )


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
    from ..shared_tech.context import resolve_instance_config

    config = resolve_instance_config()
    if config is not None:
        return config
    return _ConfigRequiredError(
        error=ErrorResult(
            error_class="caller_error",
            code="inference_unavailable",
            reason=f"{operation} requires an initialized LHC SDK inference configuration",
        )
    )


async def derive_turn(thread_ref: ThreadRef, turn_id: str) -> OpResult[TurnDeriveResult]:
    from ..shared_tech.errors import OpOk, storage_failure
    from ..threads import open_thread_database, resolve_thread_ref
    from .internal.derive import derive_turn_owned_in_open_db

    config = _config_required("turns.deriveTurn")
    if isinstance(config, _ConfigRequiredError):
        return OpErr(error=config.error)
    resolved = await resolve_thread_ref(thread_ref)
    if not resolved.ok:
        return resolved
    file_path = resolved.value.file_path
    if not Path(file_path).exists():
        return OpErr(
            error=ErrorResult(
                error_class="caller_error",
                code="thread_not_found",
                reason=f"no thread file exists at {file_path}",
            )
        )
    opened = open_thread_database(file_path)
    if not opened.ok:
        return opened
    db = opened.value
    try:
        assembly_result = await derive_turn_owned_in_open_db(
            db,
            config,
            "turn_derivation",
            {"turnId": turn_id},
            [
                EnqueueDerivationTarget(
                    subject_kind="turn",
                    subject_id=turn_id,
                    derivation_type="turn_rendering",
                ),
                EnqueueDerivationTarget(
                    subject_kind="turn",
                    subject_id=turn_id,
                    derivation_type="pre_detailed_assembly",
                ),
            ],
        )
        if assembly_result.outcome == "failed":
            return OpOk(TurnDeriveFailed(turn_id=turn_id, error=assembly_result.error))
        result = await derive_turn_owned_in_open_db(
            db,
            config,
            "detailed_turn_compression",
            {"turnId": turn_id},
            [
                EnqueueDerivationTarget(
                    subject_kind="turn",
                    subject_id=turn_id,
                    derivation_type="detailed_turn_compression",
                )
            ],
        )
        if result.outcome == "failed":
            return OpOk(TurnDeriveFailed(turn_id=turn_id, error=result.error))
        return OpOk(TurnDerived(turn_id=turn_id, source_version=result.source_version))
    except BaseException as cause:
        return storage_failure(f"derive failed: {cause}")
    finally:
        db.close()


async def _derive_chunk(
    thread_ref: ThreadRef,
    chunk_id: str,
    derivation_type: Literal["chunk_summary_detailed", "chunk_summary_brief"],
) -> OpResult[ChunkDeriveResult]:
    from ..shared_tech.errors import OpOk, storage_failure
    from ..threads import open_thread_database, resolve_thread_ref
    from .internal.derive import derive_turn_owned_in_open_db

    operation = (
        "turns.deriveDetailedChunk"
        if derivation_type == "chunk_summary_detailed"
        else "turns.deriveBriefChunk"
    )
    config = _config_required(operation)
    if isinstance(config, _ConfigRequiredError):
        return OpErr(error=config.error)
    resolved = await resolve_thread_ref(thread_ref)
    if not resolved.ok:
        return resolved
    file_path = resolved.value.file_path
    if not Path(file_path).exists():
        return OpErr(
            error=ErrorResult(
                error_class="caller_error",
                code="thread_not_found",
                reason=f"no thread file exists at {file_path}",
            )
        )
    opened = open_thread_database(file_path)
    if not opened.ok:
        return opened
    db = opened.value
    try:
        result = await derive_turn_owned_in_open_db(
            db,
            config,
            derivation_type,
            {"chunkId": chunk_id},
            [
                EnqueueDerivationTarget(
                    subject_kind="chunk",
                    subject_id=chunk_id,
                    derivation_type=derivation_type,
                )
            ],
        )
        if result.outcome == "failed":
            return OpOk(ChunkDeriveFailed(chunk_id=chunk_id, error=result.error))
        return OpOk(
            ChunkDerived(
                chunk_id=chunk_id,
                derivation_type=derivation_type,
                source_version=result.source_version,
            )
        )
    except BaseException as cause:
        return storage_failure(f"derive failed: {cause}")
    finally:
        db.close()


async def derive_detailed_chunk(thread_ref: ThreadRef, chunk_id: str) -> OpResult[ChunkDeriveResult]:
    return await _derive_chunk(thread_ref, chunk_id, "chunk_summary_detailed")


async def derive_brief_chunk(thread_ref: ThreadRef, chunk_id: str) -> OpResult[ChunkDeriveResult]:
    return await _derive_chunk(thread_ref, chunk_id, "chunk_summary_brief")


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
