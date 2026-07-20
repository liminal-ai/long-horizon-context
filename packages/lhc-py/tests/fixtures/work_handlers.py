"""Ported from packages/lhc/test/fixtures/work-handlers.ts. Phase 1 skeleton.

Story 1's registered test handlers: one per work kind. Work-kind constants and
type surface are real; handler/dispatcher bodies are skeletons.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, TypedDict, Union

from lhc.sdk import Lhc
from lhc.shared_tech.derivation import (
    CompletionTx,
    HandlerDerivationWrite,
    HandlerRunContext,
    InferenceCallbacks,
    InferenceResult,
    WorkHandler,
)
from lhc.shared_tech.durable_work import DurableWorkDispatcherMap
from lhc.shared_tech.work_queue import WorkKind
from .model_call import DerivationType

_WORK_KINDS: tuple[WorkKind, ...] = (
    "prompt_smoothing",
    "tool_result_summary",
    "turn_derivation",
    "detailed_turn_compression",
    "chunk_summary_detailed",
    "chunk_summary_brief",
)


class HandlerStartItem(TypedDict):
    workItemId: str
    kind: str


class TestHandlerHooks(TypedDict, total=False):
    # Fires when a handler begins running an item — i.e. after the item's
    # claim committed and any earlier item's completion landed. The kill and
    # hold runners hang their marker/sleep protocol here.
    onHandlerStart: Callable[[HandlerStartItem], None | Awaitable[None]]


# TS: onApplied receives { db, onCommit } — CompletionTx is the shared-tech name.
OnAppliedFn = Callable[[CompletionTx], None]


@dataclass(frozen=True, slots=True)
class DeriveForTestWorkOk:
    derivations: list[HandlerDerivationWrite]
    ok: Literal[True] = True
    on_applied: OnAppliedFn | None = None


@dataclass(frozen=True, slots=True)
class DeriveForTestWorkErr:
    reason: str
    ok: Literal[False] = False


DeriveForTestWorkResult = Union[DeriveForTestWorkOk, DeriveForTestWorkErr]


@dataclass(frozen=True, slots=True)
class InferenceWriteOk:
    derivations: list[HandlerDerivationWrite]
    ok: Literal[True] = True


@dataclass(frozen=True, slots=True)
class InferenceWriteErr:
    reason: str
    ok: Literal[False] = False


InferenceWriteResult = Union[InferenceWriteOk, InferenceWriteErr]


def test_work_handlers(
    inference_callbacks: InferenceCallbacks,
    hooks: TestHandlerHooks | None = None,
) -> dict[WorkKind, WorkHandler]:
    raise NotImplementedError


async def _derive_for_test_work(
    run: HandlerRunContext,
    kind: WorkKind,
    inference_callbacks: InferenceCallbacks,
    source_id: str,
) -> DeriveForTestWorkResult:
    raise NotImplementedError


def _inference_write(
    subject_kind: Literal["message", "chunk"],
    subject_id: str,
    derivation_type: DerivationType,
    result: InferenceResult,
) -> InferenceWriteResult:
    raise NotImplementedError


def test_work_dispatchers(
    inference_callbacks: InferenceCallbacks,
    hooks: TestHandlerHooks | None = None,
) -> DurableWorkDispatcherMap:
    raise NotImplementedError


def register_test_work_handlers(
    sdk: Lhc,
    inference_callbacks: InferenceCallbacks,
    hooks: TestHandlerHooks | None = None,
) -> None:
    raise NotImplementedError
