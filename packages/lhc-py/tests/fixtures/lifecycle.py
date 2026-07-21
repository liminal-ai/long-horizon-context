"""Ported from packages/lhc/test/fixtures/lifecycle.ts. Phase 1.

Pure data (profile, mutation targets, conversation builders) are REAL.
SDK-driving helpers (`create_lifecycle_sdk`, `run_lifecycle`) are skeletons.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from lhc.intake_stream import BatchResult, MessageEventInput
from lhc.messages import EditInput, MessageReportOpts, MutationResult, RemoveInput
from lhc.sdk import Lhc, init_lhc
from lhc.shared_tech.derivation import (
    ChunkPolicyConfig,
    DerivationGuards,
    DerivationReportEntry,
    SdkConfig,
    ToolResultConfig,
)
from lhc.shared_tech.deterministic import create_deterministic_inference_callbacks
from lhc.shared_tech.errors import OpResult
from lhc.shared_tech.inference_types import InferenceConfig
from lhc.shared_tech.inspect import HealthReport, InspectOverview, ViewContentsReport
from lhc.shared_tech.view import (
    CompactReceipt,
    LlmRequestContext,
    PartialViewProfilePercentages,
    SdkViewConfig,
    ViewProfileOverride,
    ViewStatus,
)
from lhc.thread_view import CompactOpts, MaterializeOpts
from lhc.threads import NewThreadResult
from lhc.turns import TurnReportOpts

if TYPE_CHECKING:
    from . import TempStore


# ── the one SDK configuration (AC-5.1) ────────────────────────────


@dataclass(frozen=True, slots=True)
class LifecycleProfilePercentages:
    full: int
    smooth: int
    detailed: int
    brief: int


@dataclass(frozen=True, slots=True)
class LifecycleProfile:
    name: str
    lower_bound: int
    percentages: LifecycleProfilePercentages


LIFECYCLE_PROFILE = LifecycleProfile(
    name="lifecycle",
    lower_bound=400,
    percentages=LifecycleProfilePercentages(full=25, smooth=16, detailed=10, brief=49),
)

_TURN_COUNT = 12
_TOOL_HEAVY_TURNS = frozenset({5, 6, 7, 8})
_TURNS_PER_BATCH = 3


@dataclass(frozen=True, slots=True)
class EditTarget:
    turn_id: str
    kind: str


EDIT_TARGET = EditTarget(turn_id="t12", kind="user_prompt")
EDITED_MESSAGE_TEXT = "turn 12 revised: drop area 12 and re-check area 5 instead"
DELETE_TARGET = EditTarget(turn_id="t10", kind="assistant_text")
DELETED_MESSAGE_TEXT = "findings for area 10"


def _turn_events(turn: int) -> list[MessageEventInput]:
    from . import valid_event

    seq = 0

    def key() -> str:
        nonlocal seq
        seq += 1
        return f"lc-t{turn}-e{seq}"

    events: list[MessageEventInput] = [
        valid_event(
            "user_prompt",
            {"idempotencyKey": key(), "payload": {"text": f"turn {turn}: please investigate area {turn}"}},
        ),
        valid_event(
            "assistant_thinking",
            {"idempotencyKey": key(), "payload": {"text": f"considering what area {turn} contains"}},
        ),
    ]
    if turn in _TOOL_HEAVY_TURNS:
        for run in (1, 2):
            tool_call_id = f"call-lc-{turn}-{run}"
            events.append(
                valid_event(
                    "tool_call",
                    {
                        "idempotencyKey": key(),
                        "payload": {
                            "toolCallId": tool_call_id,
                            "toolName": "read_file",
                            "arguments": {"path": f"area-{turn}/file-{run}.txt"},
                        },
                    },
                )
            )
            events.append(
                valid_event(
                    "tool_result",
                    {
                        "idempotencyKey": key(),
                        "payload": {
                            "toolCallId": tool_call_id,
                            "content": (
                                f"contents of area-{turn}/file-{run}.txt: "
                                f"detail {turn}.{run} with enough text to summarize"
                            ),
                            "isError": False,
                        },
                    },
                )
            )
    events.append(
        valid_event(
            "assistant_text",
            {"idempotencyKey": key(), "payload": {"text": f"findings for area {turn}"}},
        )
    )
    events.append(valid_event("turn_end", {"idempotencyKey": key()}))
    return events


def _intake_batches() -> list[list[MessageEventInput]]:
    batches: list[list[MessageEventInput]] = []
    first = 1
    while first <= _TURN_COUNT:
        batch: list[MessageEventInput] = []
        turn = first
        while turn < first + _TURNS_PER_BATCH and turn <= _TURN_COUNT:
            batch.extend(_turn_events(turn))
            turn += 1
        batches.append(batch)
        first += _TURNS_PER_BATCH
    return batches


@dataclass(frozen=True, slots=True)
class LifecycleDrainPhase:
    settled: Literal[True] = True


@dataclass(frozen=True, slots=True)
class LifecycleInspect1:
    overview: OpResult[InspectOverview]
    view: OpResult[ViewContentsReport]
    health: OpResult[HealthReport]


@dataclass(frozen=True, slots=True)
class LifecycleMutatePhase:
    edited_message_id: str
    deleted_message_id: str
    edit: OpResult[MutationResult]
    delete: OpResult[MutationResult]
    health_after_mutate: OpResult[HealthReport]
    messages_not_ready: OpResult[list[DerivationReportEntry]]
    turns_not_ready: OpResult[list[DerivationReportEntry]]


@dataclass(frozen=True, slots=True)
class LifecycleMaterializeResult:
    written_path: str


@dataclass(frozen=True, slots=True)
class LifecyclePhases:
    create: OpResult[NewThreadResult]
    intake: list[OpResult[BatchResult]]
    drain: LifecycleDrainPhase
    status: OpResult[ViewStatus]
    compact1: OpResult[CompactReceipt]
    llm_context1: OpResult[LlmRequestContext]
    inspect1: LifecycleInspect1
    mutate: LifecycleMutatePhase
    rebuild: LifecycleDrainPhase
    health2: OpResult[HealthReport]
    compact2: OpResult[CompactReceipt]
    llm_context2: OpResult[LlmRequestContext]
    materialize: OpResult[LifecycleMaterializeResult]


LifecycleCheckpoint = Literal["inspect1", "health2", "materialize"]


@dataclass(frozen=True, slots=True)
class LifecycleCheckpointCtx:
    sdk: Lhc
    file_path: str


@dataclass(frozen=True, slots=True)
class LifecycleOptions:
    name: str | None = None
    fresh_sdk_between_groups: bool = False
    on_checkpoint: Callable[[LifecycleCheckpoint, LifecycleCheckpointCtx], Awaitable[None]] | None = None
    inference: InferenceConfig | None = None
    guards: DerivationGuards | None = None


@dataclass(frozen=True, slots=True)
class LifecycleRun:
    file_path: str
    out_path: str
    thread_id: str
    phases: LifecyclePhases


def create_lifecycle_sdk(
    inference: InferenceConfig | None = None,
    guards: DerivationGuards | None = None,
) -> Lhc:
    # Deterministic callbacks injected at construction (the only direct-callback
    # path since the CLI retired), background mode, so a
    # deterministic run never arms a wake timer, the Epic 03 fixture's pinned
    # chunk policy (12 fixed-shape turns cut into 4 chunks, c1–c3 closed), and
    # a named "lifecycle" profile so compact runs profile-addressed (story
    # scope: "compact (profile)") with all three lower bands non-empty on this
    # thread (Epic 03 Story 2's reference gradient).
    # TS: ...(inference !== undefined ? { inference } : { inferenceCallbacks: ... })
    #     ...(guards === undefined ? {} : { guards })
    config = SdkConfig(
        mode="background",
        inference=inference if inference is not None else None,
        inference_callbacks=(
            None if inference is not None else create_deterministic_inference_callbacks()
        ),
        guards=guards if guards is not None else None,
        chunk_policy=ChunkPolicyConfig(target_projected_tokens=90, max_projected_tokens=4400),
        tool_result=ToolResultConfig(
            small_tier_tokens=1, small_target_ratio=0.15, mid_target_ratio=0.04
        ),
        view=SdkViewConfig(
            profiles=[
                ViewProfileOverride(
                    name=LIFECYCLE_PROFILE.name,
                    lower_bound=LIFECYCLE_PROFILE.lower_bound,
                    percentages=PartialViewProfilePercentages(
                        full=LIFECYCLE_PROFILE.percentages.full,
                        smooth=LIFECYCLE_PROFILE.percentages.smooth,
                        detailed=LIFECYCLE_PROFILE.percentages.detailed,
                        brief=LIFECYCLE_PROFILE.percentages.brief,
                    ),
                )
            ],
            # Low threshold so the status checkpoint genuinely recommends the
            # compact the sequence performs next.
            compact_threshold=300,
        ),
    )
    return init_lhc(config)


def _expect_ok(result: OpResult[object], phase: str) -> object:
    if not result.ok:
        raise RuntimeError(
            f"lifecycle {phase} failed: {result.error.code} — {result.error.reason}"
        )
    return result.value


async def run_lifecycle(store: TempStore, opts: LifecycleOptions | None = None) -> LifecycleRun:
    if opts is None:
        opts = LifecycleOptions()
    # TS: opts.name ?? "lifecycle"
    name = "lifecycle" if opts.name is None else opts.name
    file_path = store.thread_path(name)
    out_path = str(Path(store.dir) / f"{name}-session.jsonl")
    ref = {"filePath": file_path}

    sdk = create_lifecycle_sdk(opts.inference, opts.guards)

    def next_group() -> None:
        # The fresh instance is the same configuration assembled again — the
        # continuity proof is that no phase depends on the prior instance's
        # memory, only on the thread file.
        nonlocal sdk
        if opts.fresh_sdk_between_groups:
            sdk = create_lifecycle_sdk(opts.inference, opts.guards)

    async def checkpoint(cp: LifecycleCheckpoint) -> None:
        # TS: if (opts.onCheckpoint !== undefined) await opts.onCheckpoint(...)
        if opts.on_checkpoint is not None:
            await opts.on_checkpoint(cp, LifecycleCheckpointCtx(sdk=sdk, file_path=file_path))

    # ── group 1: create → intake → drain → status ──
    create = await sdk.threads.new_thread(
        {"filePath": file_path, "registryPath": store.registry_path}
    )
    thread_id = _expect_ok(create, "create").thread_id  # type: ignore[union-attr]

    intake: list[OpResult[BatchResult]] = []
    for batch in _intake_batches():
        sent = await sdk.intake_stream.message_events(ref, batch)
        intake.append(sent)
        _expect_ok(sent, "intake")

    # Background drain settles (story scope): the intake pokes scheduled the
    # work; this is the await that lets the scheduler run it to empty.
    await sdk.drain_settled(ref)
    drain = LifecycleDrainPhase(settled=True)

    status = await sdk.thread_view.status(ref)
    _expect_ok(status, "status")

    # ── group 2: compact1 → llmContext1 → inspect1 ──
    next_group()
    compact1 = await sdk.thread_view.compact(ref, CompactOpts(profile=LIFECYCLE_PROFILE.name))
    _expect_ok(compact1, "compact1")
    llm_context1 = await sdk.thread_view.get_llm_request_context(ref)
    _expect_ok(llm_context1, "llmContext1")
    inspect1 = LifecycleInspect1(
        overview=await sdk.inspect.overview(ref),
        view=await sdk.inspect.view(ref),
        health=await sdk.inspect.health(ref),
    )
    _expect_ok(inspect1.overview, "inspect1.overview")
    _expect_ok(inspect1.view, "inspect1.view")
    _expect_ok(inspect1.health, "inspect1.health")
    await checkpoint("inspect1")

    # ── group 3: mutate → rebuild → health2 ──
    next_group()
    listed = _expect_ok(await sdk.messages.list(ref), "mutate.list")  # type: ignore[assignment]
    edit_target = next(
        (
            record
            for record in listed  # type: ignore[union-attr]
            if record.kind == EDIT_TARGET.kind and record.turn_id == EDIT_TARGET.turn_id
        ),
        None,
    )
    delete_target = next(
        (
            record
            for record in listed  # type: ignore[union-attr]
            if record.kind == DELETE_TARGET.kind and record.turn_id == DELETE_TARGET.turn_id
        ),
        None,
    )
    if edit_target is None or delete_target is None:
        raise RuntimeError("lifecycle invariant: edit/delete targets not found in the record")
    # Edit, delete, and the pending-state reads run in one microtask cascade
    # (see module header): the snapshot is taken before the poked background
    # drain starts its first pass.
    edit = await sdk.messages.edit(
        ref,
        EditInput(message_id=edit_target.message_id, content=EDITED_MESSAGE_TEXT),
    )
    _expect_ok(edit, "mutate.edit")
    deleted = await sdk.messages.remove(
        ref, RemoveInput(message_id=delete_target.message_id)
    )
    _expect_ok(deleted, "mutate.delete")
    mutate = LifecycleMutatePhase(
        edited_message_id=edit_target.message_id,
        deleted_message_id=delete_target.message_id,
        edit=edit,
        delete=deleted,
        health_after_mutate=await sdk.inspect.health(ref),
        messages_not_ready=await sdk.messages.report(ref, MessageReportOpts(not_ready=True)),
        turns_not_ready=await sdk.turns.report(ref, TurnReportOpts(not_ready=True)),
    )
    _expect_ok(mutate.health_after_mutate, "mutate.health")
    _expect_ok(mutate.messages_not_ready, "mutate.messagesNotReady")
    _expect_ok(mutate.turns_not_ready, "mutate.turnsNotReady")

    # Rebuild drains: the mutations' pokes already scheduled the cascade
    # rebuilds on THIS instance's scheduler; settle is the production await.
    await sdk.drain_settled(ref)
    rebuild = LifecycleDrainPhase(settled=True)

    health2 = await sdk.inspect.health(ref)
    _expect_ok(health2, "health2")
    await checkpoint("health2")

    # ── group 4: compact2 → llmContext2 → materialize ──
    next_group()
    compact2 = await sdk.thread_view.compact(ref, CompactOpts(profile=LIFECYCLE_PROFILE.name))
    _expect_ok(compact2, "compact2")
    llm_context2 = await sdk.thread_view.get_llm_request_context(ref)
    _expect_ok(llm_context2, "llmContext2")
    materialize = await sdk.thread_view.materialize(ref, MaterializeOpts(path=out_path))
    _expect_ok(materialize, "materialize")
    await checkpoint("materialize")

    return LifecycleRun(
        file_path=file_path,
        out_path=out_path,
        thread_id=thread_id,  # type: ignore[arg-type]
        phases=LifecyclePhases(
            create=create,
            intake=intake,
            drain=drain,
            status=status,
            compact1=compact1,
            llm_context1=llm_context1,
            inspect1=inspect1,
            mutate=mutate,
            rebuild=rebuild,
            health2=health2,
            compact2=compact2,
            llm_context2=llm_context2,
            materialize=materialize,  # type: ignore[arg-type]
        ),
    )
