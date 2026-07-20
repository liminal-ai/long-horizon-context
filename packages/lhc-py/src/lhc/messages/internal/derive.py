"""Ported from packages/lhc/src/messages/internal/derive.ts. Phase 1 skeleton.

Synchronous message-owned derivation and durable-work dispatch for the
messages domain.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Union

from ...shared_tech.derivation import (
    CompletionTx,
    HandlerDerivationWrite,
    HandlerRunContext,
)
from ...shared_tech.durable_work import DurableWorkDispatchResult
from ...shared_tech.errors import ErrorResult
from ...shared_tech.work_queue import EnqueueDerivationTarget, WorkKind

if TYPE_CHECKING:
    from .. import MessageKind

_SQL_INSERT_DERIVATION_READY = (
    """INSERT OR IGNORE INTO derivation
             (subject_kind, subject_id, derivation_type, state, content, metadata, gaps, source_version, derived_at)
           VALUES ('message', ?, ?, 'ready', ?, ?, ?, ?, ?)"""
)

_SQL_UPDATE_DERIVATION_READY = (
    """UPDATE derivation
           SET state = 'ready', content = ?, reason = NULL, metadata = ?,
               gaps = ?, derived_at = ?, source_version = ?
           WHERE subject_kind = 'message' AND subject_id = ? AND derivation_type = ?
             AND state = ? AND source_version = ?"""
)


@dataclass(frozen=True, slots=True)
class MessageDerived:
    message_id: str
    derivation_type: Literal["smoothed_prompt", "tool_result_summary"]
    source_version: int
    outcome: Literal["derived"] = "derived"


@dataclass(frozen=True, slots=True)
class MessageNotDerivable:
    message_id: str
    outcome: Literal["not_derivable"] = "not_derivable"


@dataclass(frozen=True, slots=True)
class MessageDeriveFailed:
    message_id: str
    error: ErrorResult
    outcome: Literal["failed"] = "failed"


MessageDeriveResult = Union[MessageDerived, MessageNotDerivable, MessageDeriveFailed]


def _failed_derive(message_id: str, error: ErrorResult) -> MessageDeriveResult:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _DerivationForKind:
    work_kind: WorkKind
    derivation_type: Literal["smoothed_prompt", "tool_result_summary"]


def _derivation_for_kind(kind: MessageKind) -> _DerivationForKind | None:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _DerivationRowForVersion:
    source_version: int
    state: str


def _source_version_for_derive(row: _DerivationRowForVersion | None) -> int:
    raise NotImplementedError


def _provider_failure(message_id: str, reason: str) -> MessageDeriveResult:
    raise NotImplementedError


def _work_in_flight(message_id: str, work_kind: WorkKind, source_version: int) -> MessageDeriveResult:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _AppliedRecoveredWrite:
    applied: bool
    live_work: bool


def _apply_recovered_message_write(
    run: HandlerRunContext,
    work_kind: WorkKind,
    message_id: str,
    expected: _DerivationRowForVersion | None,
    source_version: int,
    write: HandlerDerivationWrite,
    on_applied: Callable[[CompletionTx], None] | None = None,
) -> _AppliedRecoveredWrite:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class DeriveMessageInThreadOpts:
    source_version: int | None = None


async def derive_message_in_thread(
    run: HandlerRunContext,
    message_id: str,
    opts: DeriveMessageInThreadOpts | None = None,
) -> MessageDeriveResult:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class MessageDerivationFloorRecovery:
    message_id: str
    derivation_type: Literal["smoothed_prompt", "tool_result_summary"]
    content: str
    source_version: int


@dataclass(frozen=True, slots=True)
class MessageDerivationFloorResult:
    persisted: bool


def write_message_derivation_floor_in_thread(
    run: HandlerRunContext,
    recovery: MessageDerivationFloorRecovery,
) -> MessageDerivationFloorResult:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class DispatchMessageDeriveWorkItem:
    work_item_id: str
    source_version: int
    derivations: Sequence[EnqueueDerivationTarget]


async def dispatch_message_derive_work(
    run: HandlerRunContext,
    item: DispatchMessageDeriveWorkItem,
) -> DurableWorkDispatchResult:
    raise NotImplementedError
