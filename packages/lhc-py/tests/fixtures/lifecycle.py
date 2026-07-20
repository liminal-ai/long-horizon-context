"""Ported from packages/lhc/test/fixtures/lifecycle.ts. Phase 1.

Pure data (profile, mutation targets, conversation builders) are REAL.
SDK-driving helpers (`create_lifecycle_sdk`, `run_lifecycle`) are skeletons.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from lhc.intake_stream import BatchResult, MessageEventInput
from lhc.messages import MutationResult
from lhc.sdk import Lhc
from lhc.shared_tech.derivation import DerivationGuards, DerivationReportEntry
from lhc.shared_tech.errors import OpResult
from lhc.shared_tech.inference_types import InferenceConfig
from lhc.shared_tech.inspect import HealthReport, InspectOverview, ViewContentsReport
from lhc.shared_tech.view import CompactReceipt, LlmRequestContext, ViewStatus
from lhc.threads import NewThreadResult

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
    raise NotImplementedError


def _expect_ok(result: OpResult[object], phase: str) -> object:
    raise NotImplementedError


async def run_lifecycle(store: TempStore, opts: LifecycleOptions | None = None) -> LifecycleRun:
    raise NotImplementedError
