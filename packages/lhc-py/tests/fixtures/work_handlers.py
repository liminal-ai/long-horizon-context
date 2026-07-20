"""Ported from packages/lhc/test/fixtures/work-handlers.ts. Phase 1 skeleton.

Story 1's registered test handlers: one per work kind. Work-kind constants and
type surface are real; handler/dispatcher bodies are skeletons.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal, TypedDict, Union

from lhc.sdk import Lhc, register_testing_work
from lhc.shared_tech.derivation import (
    CompletionTx,
    HandlerDerivationWrite,
    HandlerBlocked,
    HandlerFailed,
    HandlerOk,
    HandlerRunContext,
    InferenceCallbacks,
    InferenceResult,
    WorkHandler,
)
from lhc.shared_tech.deterministic import deterministic_text
from lhc.shared_tech.durable_work import (
    DerivationAttempt,
    DurableWorkDispatchBlocked,
    DurableWorkDispatchFailed,
    DurableWorkDispatcher,
    DurableWorkDispatcherItem,
    DurableWorkDispatcherMap,
    DurableWorkDispatchSettled,
    apply_derivation_success,
)
from lhc.shared_tech.persist import DbWriteTransaction
from lhc.shared_tech.work_queue import (
    EnqueueDerivationTarget,
    EnqueueInput,
    WorkKind,
    enqueue,
)
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


# TS fixture names: `testWorkHandlers` / `testWorkDispatchers`. Renamed with
# `make_` prefix so pytest does not collect these factories as tests if the
# module is imported into a test file.
def make_test_work_handlers(
    inference_callbacks: InferenceCallbacks,
    hooks: TestHandlerHooks | None = None,
) -> dict[WorkKind, WorkHandler]:
    hooks = hooks or {}
    handlers: dict[WorkKind, WorkHandler] = {}

    def make_handler(kind: WorkKind) -> WorkHandler:
        async def handler(run: HandlerRunContext, item):
            on_start = hooks.get("onHandlerStart")
            if on_start is not None:
                started = on_start(
                    {"workItemId": item["workItemId"], "kind": item["kind"]}
                )
                if inspect.isawaitable(started):
                    await started
            source_ref = item["sourceRef"]
            _sid_candidates = (
                source_ref.get("messageId"),
                source_ref.get("turnId"),
                source_ref.get("chunkId"),
            )
            source_id = next(
                (v for v in _sid_candidates if v is not None), None
            )
            if source_id is None:
                return HandlerFailed(reason="test handler: unrecognized sourceRef")
            derived = await _derive_for_test_work(
                run, kind, inference_callbacks, source_id
            )
            if not derived.ok:
                return HandlerFailed(reason=derived.reason)
            return HandlerOk(
                derivations=derived.derivations,
                on_applied=derived.on_applied,
            )

        return handler

    for kind in _WORK_KINDS:
        handlers[kind] = make_handler(kind)
    return handlers


async def _derive_for_test_work(
    run: HandlerRunContext,
    kind: WorkKind,
    inference_callbacks: InferenceCallbacks,
    source_id: str,
) -> DeriveForTestWorkResult:
    if kind == "prompt_smoothing":
        result = _inference_write(
            "message",
            source_id,
            "smoothed_prompt",
            await inference_callbacks.smooth_prompt({"text": f"prompt:{source_id}"}),
        )
        return (
            DeriveForTestWorkOk(derivations=result.derivations)
            if result.ok
            else DeriveForTestWorkErr(reason=result.reason)
        )
    if kind == "tool_result_summary":
        result = _inference_write(
            "message",
            source_id,
            "tool_result_summary",
            await inference_callbacks.summarize_tool_result(
                {"toolName": "fixture", "content": f"result:{source_id}"}
            ),
        )
        return (
            DeriveForTestWorkOk(derivations=result.derivations)
            if result.ok
            else DeriveForTestWorkErr(reason=result.reason)
        )
    if kind == "turn_derivation":
        rendering_input = {
            "parts": [
                {
                    "messageId": source_id,
                    "kind": "user_prompt",
                    "text": f"turn:{source_id}",
                    "fallback": False,
                }
            ]
        }
        rendering_text = deterministic_text(
            "compressDetailedTurn", rendering_input, f"turn:{source_id}"
        )
        assembly_text = f"User:\nturn:{source_id}\n\n⏺ findings for {source_id}"

        class _OnCommitAdapter:
            def __init__(self, tx: CompletionTx) -> None:
                self._tx = tx

            def add(self, operation: Callable[[], None]) -> None:
                self._tx.on_commit(operation)

        def on_applied(tx: CompletionTx) -> None:
            enqueue(
                DbWriteTransaction(
                    db=tx.db,
                    thread_id=run.thread_id,
                    file_path=run.file_path,
                    clock=run.clock,
                    post_commit_hook=_OnCommitAdapter(tx),
                    poke=lambda _thread_id: None,
                ),
                EnqueueInput(
                    owner="turns",
                    kind="detailed_turn_compression",
                    source_ref={"turnId": source_id},
                    source_version=1,
                    derivations=[
                        EnqueueDerivationTarget(
                            subject_kind="turn",
                            subject_id=source_id,
                            derivation_type="detailed_turn_compression",
                        )
                    ],
                ),
            )

        return DeriveForTestWorkOk(
            derivations=[
                HandlerDerivationWrite(
                    subject_kind="turn",
                    subject_id=source_id,
                    derivation_type="turn_rendering",
                    content=rendering_text,
                ),
                HandlerDerivationWrite(
                    subject_kind="turn",
                    subject_id=source_id,
                    derivation_type="pre_detailed_assembly",
                    content=assembly_text,
                ),
            ],
            on_applied=on_applied,
        )
    if kind == "detailed_turn_compression":
        assembly_text = f"User:\nturn:{source_id}\n\n⏺ findings for {source_id}"
        compression = await inference_callbacks.compress_detailed_turn(
            {
                "dialogueText": assembly_text,
                "inputTokens": 10,
                "targetMinTokens": 4,
                "targetAimTokens": 5,
                "targetMaxTokens": 7,
            }
        )
        if not compression.ok:
            return DeriveForTestWorkErr(reason=compression.reason)
        return DeriveForTestWorkOk(
            derivations=[
                HandlerDerivationWrite(
                    subject_kind="turn",
                    subject_id=source_id,
                    derivation_type="detailed_turn_compression",
                    content=compression.text,
                )
            ]
        )
    if kind == "chunk_summary_detailed":
        input = {"memberProjections": [f"chunk:{source_id}"]}
        return DeriveForTestWorkOk(
            derivations=[
                HandlerDerivationWrite(
                    subject_kind="chunk",
                    subject_id=source_id,
                    derivation_type="chunk_summary_detailed",
                    content=deterministic_text(
                        "summarizeChunkBrief",
                        input,
                        " | ".join(input["memberProjections"]),
                    ),
                )
            ]
        )
    if kind == "chunk_summary_brief":
        result = _inference_write(
            "chunk",
            source_id,
            "chunk_summary_brief",
            await inference_callbacks.summarize_chunk_brief(
                {
                    "text": f"chunk:{source_id}",
                    "inputTokens": 10,
                    "targetMinTokens": 1,
                    "targetAimTokens": 2,
                    "targetMaxTokens": 3,
                }
            ),
        )
        return (
            DeriveForTestWorkOk(derivations=result.derivations)
            if result.ok
            else DeriveForTestWorkErr(reason=result.reason)
        )
    return DeriveForTestWorkErr(reason=f"test handler: unsupported work kind {kind}")


def _inference_write(
    subject_kind: Literal["message", "chunk"],
    subject_id: str,
    derivation_type: DerivationType,
    result: InferenceResult,
) -> InferenceWriteResult:
    if not result.ok:
        return InferenceWriteErr(reason=result.reason)
    return InferenceWriteOk(
        derivations=[
            HandlerDerivationWrite(
                subject_kind=subject_kind,
                subject_id=subject_id,
                derivation_type=derivation_type,
                content=result.text,
            )
        ]
    )


def make_test_work_dispatchers(
    inference_callbacks: InferenceCallbacks,
    hooks: TestHandlerHooks | None = None,
) -> DurableWorkDispatcherMap:
    handlers = make_test_work_handlers(inference_callbacks, hooks)

    def wrap(kind: WorkKind) -> DurableWorkDispatcher:
        async def dispatcher(run: HandlerRunContext, item: DurableWorkDispatcherItem):
            handler = handlers.get(kind)
            if handler is None:
                return DurableWorkDispatchFailed(reason="missing_test_handler")
            outcome = await handler(
                run,
                {
                    "workItemId": item.work_item_id,
                    "kind": kind,
                    "sourceRef": item.source_ref,
                },
            )
            if outcome.ok:
                disposition = apply_derivation_success(
                    run.open_db(),
                    DerivationAttempt(
                        source_version=item.source_version,
                        derivations=item.derivations,
                        work_item_id=item.work_item_id,
                    ),
                    outcome.derivations or [],
                    _iso_millis(run.clock()),
                    outcome.on_applied,
                )
                return DurableWorkDispatchSettled(disposition=disposition)
            if getattr(outcome, "deferred", False):
                return DurableWorkDispatchFailed(
                    reason="unsupported_deferred_test_handler"
                )
            if getattr(outcome, "blocked", False):
                return DurableWorkDispatchBlocked(reason=outcome.reason)
            return DurableWorkDispatchFailed(reason=outcome.reason)

        return dispatcher

    async def wrap_from_item(
        run: HandlerRunContext, item: DurableWorkDispatcherItem
    ):
        if item.kind not in handlers:
            return DurableWorkDispatchFailed(reason="missing_test_handler")
        return await wrap(item.kind)(run, item)  # type: ignore[arg-type]

    return {
        "messages.derive": wrap_from_item,
        "turns.deriveTurn": wrap("turn_derivation"),
        "turns.deriveDetailedTurnCompression": wrap("detailed_turn_compression"),
        "turns.deriveDetailedChunk": wrap("chunk_summary_detailed"),
        "turns.deriveBriefChunk": wrap("chunk_summary_brief"),
    }


def register_test_work_handlers(
    sdk: Lhc,
    inference_callbacks: InferenceCallbacks,
    hooks: TestHandlerHooks | None = None,
) -> None:
    register_testing_work(
        sdk,
        {
            "handlers": make_test_work_handlers(inference_callbacks, hooks),
            "dispatchers": make_test_work_dispatchers(inference_callbacks, hooks),
        },
    )


def _iso_millis(clock: Callable[[], datetime]) -> str:
    value = clock()
    utc = value.astimezone(timezone.utc)
    milliseconds = utc.microsecond // 1000
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{milliseconds:03d}Z"
