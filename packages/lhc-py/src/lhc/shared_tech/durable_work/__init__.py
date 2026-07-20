"""Ported from packages/lhc/src/shared-tech/durable-work. Phase 1 — ◐ PARTIAL.

Faithful subset needed by sdk.py's surface types; Wave 2 completes this module
from durable-work/index.ts (DerivationAttempt, operationIntent, the remaining
surface). Definitions below are faithful — extend, don't reshape.
"""

from __future__ import annotations

from typing import Awaitable, Callable, Literal, TypedDict, Union

from ..derivation import HandlerRunContext
from ..work_queue import EnqueueDerivationTarget, WorkSourceRef


class _OpMessagesDerive(TypedDict):
    operation: Literal["messages.derive"]
    messageId: str


class _OpTurnsDeriveTurn(TypedDict):
    operation: Literal["turns.deriveTurn"]
    turnId: str


class _OpTurnsDeriveDetailedTurnCompression(TypedDict):
    operation: Literal["turns.deriveDetailedTurnCompression"]
    turnId: str


class _OpTurnsDeriveDetailedChunk(TypedDict):
    operation: Literal["turns.deriveDetailedChunk"]
    chunkId: str


class _OpTurnsDeriveBriefChunk(TypedDict):
    operation: Literal["turns.deriveBriefChunk"]
    chunkId: str


DurableWorkOperation = Union[
    _OpMessagesDerive,
    _OpTurnsDeriveTurn,
    _OpTurnsDeriveDetailedTurnCompression,
    _OpTurnsDeriveDetailedChunk,
    _OpTurnsDeriveBriefChunk,
]


class _DispatchDone(TypedDict):
    disposition: Literal["done", "stale_discarded", "lost_lease"]


class _DispatchFailed(TypedDict):
    disposition: Literal["failed"]
    reason: str


class _DispatchBlocked(TypedDict):
    disposition: Literal["blocked"]
    reason: str


DurableWorkDispatchResult = Union[_DispatchDone, _DispatchFailed, _DispatchBlocked]


class DurableWorkDispatcherItem(TypedDict):
    workItemId: str
    kind: str
    sourceRef: WorkSourceRef
    sourceVersion: int
    derivations: tuple[EnqueueDerivationTarget, ...]
    operation: DurableWorkOperation


DurableWorkDispatcher = Callable[
    [HandlerRunContext, DurableWorkDispatcherItem],
    Awaitable[DurableWorkDispatchResult],
]

# TS: Partial<Record<DurableWorkOperation["operation"], DurableWorkDispatcher>>
# — keys are the five operation literals; Python has no Partial<Record<...>>,
# so a dict keyed by the operation strings is the faithful shape.
DurableWorkDispatcherMap = dict[str, DurableWorkDispatcher]
