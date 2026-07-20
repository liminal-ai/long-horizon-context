"""Ported from packages/lhc/src/turns/internal/derive.ts. Phase 1 skeleton.

The turns derivation handlers: turn_derivation (deterministic assembly),
detailed_turn_compression (inference over pre_detailed_assembly), and the
two chunk summaries. turn_derivation composes turn_rendering and
pre_detailed_assembly, places the turn from uncompressed assembly tokens,
and enqueues detailed_turn_compression in the same completion transaction.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal, Union

from ...shared_tech.derivation import (
    BriefTargets,
    CompressionTargets,
    HandlerBlocked,
    HandlerDeferred,
    HandlerFailed,
    HandlerOutcome,
    HandlerRunContext,
    RenderingPart,
    RenderingPartKind,
    ResolvedSdkConfig,
    WorkHandler,
    WorkItemRef,
)
from ...shared_tech.durable_work import DurableWorkDispatchResult
from ...shared_tech.errors import ErrorResult
from ...shared_tech.logging import LogEntry
from ...shared_tech.storage import Database
from ...shared_tech.work_queue import (
    EnqueueDerivationTarget,
    WorkKind,
    WorkSourceRef,
)

_SQL_SELECT_THREAD_ID = """SELECT thread_id FROM thread_metadata WHERE id = 1"""

_SQL_SELECT_CLAIMED_WORK_ITEM = """SELECT 1 FROM work_item WHERE work_item_id = ? AND status = 'claimed'"""

_SQL_DELETE_CLAIMED_WORK_ITEM = """DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'"""

_SQL_BEGIN_IMMEDIATE = """BEGIN IMMEDIATE;"""

_SQL_COMMIT = """COMMIT;"""

_SQL_ROLLBACK = """ROLLBACK;"""


def _source_damaged(reason: str) -> HandlerBlocked:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _InferenceFailedReason:
    """TS: inferenceFailed(result: { reason: string })."""

    reason: str


def _inference_failed(result: _InferenceFailedReason) -> HandlerFailed:
    raise NotImplementedError


def _dependency_not_ready(reason: str) -> HandlerFailed:
    raise NotImplementedError


def _rendering_part_label(kind: RenderingPartKind) -> str:
    raise NotImplementedError


def _compose_structured_turn_text(parts: Sequence[RenderingPart]) -> str:
    raise NotImplementedError


def _compose_detailed_chunk_summary(member_projections: Sequence[str]) -> str:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _CompressionTokenTargets:
    input_tokens: int
    target_min_tokens: int
    target_aim_tokens: int
    target_max_tokens: int


def _compression_target_tokens(
    input_tokens: int,
    targets: CompressionTargets | BriefTargets,
) -> _CompressionTokenTargets:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _SizeDispositionBounds:
    target_min_tokens: int
    target_max_tokens: int


def _size_disposition(
    output_tokens: int,
    targets: _SizeDispositionBounds,
) -> Literal["under_min", "over_max", "in_range"]:
    raise NotImplementedError


def _poke_thread_scheduler(db: Database) -> None:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _LogFallbackEntry:
    derivation_type: str
    subject_id: str
    reason: Literal["not_ready", "failed_floor"]
    floor_used: str


def _log_fallback(run: HandlerRunContext, entry: _LogFallbackEntry) -> None:
    raise NotImplementedError


async def _turn_derivation_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome:
    raise NotImplementedError


async def _detailed_turn_compression_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome:
    raise NotImplementedError


# Detailed is deterministic material assembly from stored member compressions.
# Brief is inference-backed and consumes the stored detailed summary for the
# same chunk.
# TS: Extract<HandlerOutcome, { ok: false }> | { ok: true; text; fallbackLogs }
@dataclass(frozen=True, slots=True)
class _DetailedChunkOk:
    text: str
    fallback_logs: list[LogEntry]
    ok: Literal[True] = True


_DetailedChunkComposition = Union[
    HandlerBlocked,
    HandlerFailed,
    HandlerDeferred,
    _DetailedChunkOk,
]


def _compose_detailed_chunk_from_members(db: Database, chunk_id: str) -> _DetailedChunkComposition:
    raise NotImplementedError


# TS: function chunkDetailedHandler(): WorkHandler — zero-arg factory.
def _chunk_detailed_handler() -> WorkHandler:
    raise NotImplementedError


# TS: function chunkBriefHandler(): WorkHandler — zero-arg factory.
def _chunk_brief_handler() -> WorkHandler:
    raise NotImplementedError


# WorkHandler stubs bound into turn_work_handlers. TS initializes those slots
# by calling the factories above; Phase 1 cannot call the factories at import
# time (bodies raise), so these stubs stand in for the returned handlers.
async def _chunk_summary_detailed_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome:
    raise NotImplementedError


async def _chunk_summary_brief_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome:
    raise NotImplementedError


# The domain's handler table, merged into the SDK dispatch map at construction.
# TS: chunk_summary_detailed/brief ← chunkDetailedHandler() / chunkBriefHandler().
turn_work_handlers: dict[WorkKind, WorkHandler] = {
    "turn_derivation": _turn_derivation_handler,
    "detailed_turn_compression": _detailed_turn_compression_handler,
    "chunk_summary_detailed": _chunk_summary_detailed_handler,
    "chunk_summary_brief": _chunk_summary_brief_handler,
}


@dataclass(frozen=True, slots=True)
class _DeferClaimedItem:
    work_item_id: str


@dataclass(frozen=True, slots=True)
class _DeferTransaction:
    db: Database
    on_commit: Callable[[Callable[[], None]], None]


def _defer_claimed_turn_work(
    db: Database,
    item: _DeferClaimedItem,
    on_deferred: Callable[[_DeferTransaction], None],
) -> bool:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _DerivationRowForVersion:
    state: str
    source_version: int


def _source_version_for_derive(rows: Sequence[_DerivationRowForVersion]) -> int:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class TurnOwnedDerived:
    source_version: int
    outcome: Literal["derived"] = "derived"


@dataclass(frozen=True, slots=True)
class TurnOwnedDeriveFailed:
    error: ErrorResult
    outcome: Literal["failed"] = "failed"


TurnOwnedDeriveResult = Union[TurnOwnedDerived, TurnOwnedDeriveFailed]


def _failed(error: ErrorResult) -> TurnOwnedDeriveFailed:
    raise NotImplementedError


def _source_ref_id(source_ref: WorkSourceRef) -> str:
    raise NotImplementedError


def _work_in_flight(
    kind: WorkKind,
    source_ref: WorkSourceRef,
    source_version: int,
) -> TurnOwnedDeriveFailed:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class DeriveTurnOwnedOpts:
    source_version: int | None = None


async def derive_turn_owned_in_open_db(
    db: Database,
    config: ResolvedSdkConfig,
    kind: WorkKind,
    source_ref: WorkSourceRef,
    derivations: Sequence[EnqueueDerivationTarget],
    opts: DeriveTurnOwnedOpts | None = None,
) -> TurnOwnedDeriveResult:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class DispatchTurnOwnedWorkItem:
    work_item_id: str
    kind: WorkKind
    source_ref: WorkSourceRef
    source_version: int
    derivations: Sequence[EnqueueDerivationTarget]


async def dispatch_turn_owned_work(
    run: HandlerRunContext,
    item: DispatchTurnOwnedWorkItem,
) -> DurableWorkDispatchResult:
    raise NotImplementedError
