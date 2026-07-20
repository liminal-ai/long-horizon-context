"""Ported from packages/lhc/src/turns/index.ts. Phase 1 — PARTIAL (Wave 1/2/3 import seam).

Wave 3 adds `create` + TurnStateCorruptionError for the intake pipeline import
seam. Full turns surface lands in Wave 5. Wave 4 tests need `list_chunks` +
`ChunkRecord` as a forward stub so collection stays clean.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Union

from ..shared_tech.derivation import Derivation
from ..shared_tech.errors import ErrorResult, OpResult
from ..shared_tech.work_queue import WorkItemRecord
from ..threads import ThreadRef

if TYPE_CHECKING:
    from ..intake_stream import EventKind
    from ..shared_tech.persist import DbWriteTransaction


@dataclass(frozen=True, slots=True)
class TurnRecord:
    turn_id: str
    turn_order: int
    status: Literal["open", "closed"]
    member_message_ids: list[str]
    opened_at_event_order: int
    closed_at_event_order: int | None = None
    chunk_id: str | None = None
    member_idx: int | None = None
    # Stored turn-owned derivations, attached only when rows exist.
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
    transitions: list[TurnTransition]
    turn_id: str
    queued_work: list[WorkItemRecord]


class TurnStateCorruptionError(Exception):
    error_class: Literal["state_corruption"] = "state_corruption"
    code: Literal["turn_state_corrupt"] = "turn_state_corrupt"


@dataclass(frozen=True, slots=True)
class RecordedTurnEvent:
    event_kind: EventKind
    event_order: int


# Cross-domain surface, called by intake-stream inside the batch transaction.
def create(
    transaction: DbWriteTransaction,
    recorded_event: RecordedTurnEvent,
) -> TurnTransitionOutcome:
    raise NotImplementedError


async def list_turns(thread_ref: ThreadRef) -> OpResult[list[TurnRecord]]:
    raise NotImplementedError


# Returns stored chunk records whatever their derivation states. Derivations
# attach only where rows exist; freshly opened chunks have none.
# Wave 5 owns the body; Wave 4 tests import the signature for collection.
async def list_chunks(thread_ref: ThreadRef) -> OpResult[list[ChunkRecord]]:
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


async def derive_turn(thread_ref: ThreadRef, turn_id: str) -> OpResult[TurnDeriveResult]:
    raise NotImplementedError


async def derive_detailed_chunk(thread_ref: ThreadRef, chunk_id: str) -> OpResult[ChunkDeriveResult]:
    raise NotImplementedError


async def derive_brief_chunk(thread_ref: ThreadRef, chunk_id: str) -> OpResult[ChunkDeriveResult]:
    raise NotImplementedError
