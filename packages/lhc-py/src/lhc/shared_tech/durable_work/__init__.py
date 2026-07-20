"""Ported from packages/lhc/src/shared-tech/durable-work/index.ts. Phase 1 skeleton.

Durable work dispatch: operation intents, derivation completion transactions,
and the handler runner used by domain dispatchers.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Literal, Union

from ..derivation import (
    CompletionTx,
    HandlerDerivationWrite,
    HandlerOutcome,
    HandlerRunContext,
    ResolvedSdkConfig,
    SubjectKind,
)
from ..storage import Database
from ..work_queue import EnqueueDerivationTarget, WorkKind, WorkSourceRef


@dataclass(frozen=True, slots=True)
class MessagesDeriveOperation:
    message_id: str
    operation: Literal["messages.derive"] = "messages.derive"


@dataclass(frozen=True, slots=True)
class TurnsDeriveTurnOperation:
    turn_id: str
    operation: Literal["turns.deriveTurn"] = "turns.deriveTurn"


@dataclass(frozen=True, slots=True)
class TurnsDeriveDetailedTurnCompressionOperation:
    turn_id: str
    operation: Literal["turns.deriveDetailedTurnCompression"] = "turns.deriveDetailedTurnCompression"


@dataclass(frozen=True, slots=True)
class TurnsDeriveDetailedChunkOperation:
    chunk_id: str
    operation: Literal["turns.deriveDetailedChunk"] = "turns.deriveDetailedChunk"


@dataclass(frozen=True, slots=True)
class TurnsDeriveBriefChunkOperation:
    chunk_id: str
    operation: Literal["turns.deriveBriefChunk"] = "turns.deriveBriefChunk"


DurableWorkOperation = Union[
    MessagesDeriveOperation,
    TurnsDeriveTurnOperation,
    TurnsDeriveDetailedTurnCompressionOperation,
    TurnsDeriveDetailedChunkOperation,
    TurnsDeriveBriefChunkOperation,
]

DurableWorkOperationName = Literal[
    "messages.derive",
    "turns.deriveTurn",
    "turns.deriveDetailedTurnCompression",
    "turns.deriveDetailedChunk",
    "turns.deriveBriefChunk",
]


@dataclass(frozen=True, slots=True)
class DerivationAttempt:
    source_version: int
    derivations: Sequence[EnqueueDerivationTarget]
    work_item_id: str | None = None


@dataclass(frozen=True, slots=True)
class DurableWorkDispatchSettled:
    disposition: Literal["done", "stale_discarded", "lost_lease"]


@dataclass(frozen=True, slots=True)
class DurableWorkDispatchFailed:
    reason: str
    disposition: Literal["failed"] = "failed"


@dataclass(frozen=True, slots=True)
class DurableWorkDispatchBlocked:
    reason: str
    disposition: Literal["blocked"] = "blocked"


DurableWorkDispatchResult = Union[
    DurableWorkDispatchSettled,
    DurableWorkDispatchFailed,
    DurableWorkDispatchBlocked,
]


@dataclass(frozen=True, slots=True)
class DurableWorkDispatcherItem:
    work_item_id: str
    kind: str
    source_ref: WorkSourceRef
    source_version: int
    derivations: Sequence[EnqueueDerivationTarget]
    operation: DurableWorkOperation


DurableWorkDispatcher = Callable[
    [HandlerRunContext, DurableWorkDispatcherItem],
    Awaitable[DurableWorkDispatchResult],
]

# TS: Partial<Record<DurableWorkOperation["operation"], DurableWorkDispatcher>>
DurableWorkDispatcherMap = dict[DurableWorkOperationName, DurableWorkDispatcher]


class DerivationCompletionError(Exception):
    error_class: Literal["state_corruption"] = "state_corruption"
    code: Literal["derivation_completion_mismatch"] = "derivation_completion_mismatch"

    def __init__(self, detail: str) -> None:
        super().__init__(f"derivation_completion_mismatch: {detail}")


def _target_key(
    target: EnqueueDerivationTarget | HandlerDerivationWrite,
) -> str:
    raise NotImplementedError


def assert_exact_derivation_writes(
    expected: Sequence[EnqueueDerivationTarget],
    writes: Sequence[HandlerDerivationWrite],
) -> None:
    raise NotImplementedError


def operation_intent(kind: WorkKind, source_ref: WorkSourceRef) -> DurableWorkOperation:
    raise NotImplementedError


def write_pending_derivations(
    db: Database,
    derivations: Sequence[EnqueueDerivationTarget],
    source_version: int,
) -> None:
    raise NotImplementedError


def apply_derivation_success(
    db: Database,
    attempt: DerivationAttempt,
    writes: Sequence[HandlerDerivationWrite],
    derived_at: str,
    on_applied: Callable[[CompletionTx], None] | None = None,
) -> Literal["done", "stale_discarded", "lost_lease"]:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class DerivationTerminalFailure:
    reason: str
    state: Literal["failed", "blocked"]
    now: str


def apply_derivation_terminal_failure(
    db: Database,
    attempt: DerivationAttempt,
    failure: DerivationTerminalFailure,
) -> Literal["done", "lost_lease"]:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class RunWorkHandlerCallItem:
    work_item_id: str
    kind: str
    source_ref: dict[str, str]


@dataclass(frozen=True, slots=True)
class RunWorkHandlerItem:
    work_item_id: str
    kind: str
    source_ref: WorkSourceRef


@dataclass(frozen=True, slots=True)
class HandlerRunIdentity:
    thread_id: str
    file_path: str


async def run_work_handler(
    db: Database,
    config: ResolvedSdkConfig,
    handler: Callable[
        [HandlerRunContext, RunWorkHandlerCallItem],
        Awaitable[HandlerOutcome],
    ],
    item: RunWorkHandlerItem,
    identity: HandlerRunIdentity | None = None,
) -> HandlerOutcome:
    raise NotImplementedError


def derivation_target(
    subject_kind: SubjectKind,
    subject_id: str,
    derivation_type: str,
) -> EnqueueDerivationTarget:
    raise NotImplementedError
