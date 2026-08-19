"""Ported from packages/lhc/src/intake-stream/index.ts.

Event type surface and public message_events / list_events entry points.
Bodies remain NotImplementedError; pipeline owns the walk.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, NotRequired, TypedDict, Union

from ..shared_tech.errors import OpResult
from ..shared_tech.user_steer import UserSteerPayload
from ..shared_tech.work_queue import WorkKind, WorkOwner, WorkSourceRef
from ..threads import ThreadRef


class TextPayload(TypedDict):
    text: str


# Host-reported model identity for one assistant message fan-out. Needed so a
# resumed PI session can re-stamp provider/api/model and keep signed thinking
# through PI's same-model check (transform-messages). Opaque strings.
# Replay-policy-neutral: SDK accepts/stores/projects/exports verbatim; exact
# identity match / suppression is host work (Hermes leg 2).
class AssistantModelProvenance(TypedDict, total=False):
    provider: str
    model: str
    api: str


# Provider usage is the host's verbatim JSON object for one model call — no
# fixed column set, no interpretation inside LHC (schema v5 / D1, D3).
class AssistantTextPayload(TypedDict):
    text: str
    providerUsage: NotRequired[dict[str, object]]
    provider: NotRequired[str]
    model: NotRequired[str]
    api: NotRequired[str]


# Optional signature is an opaque provider token (Anthropic encrypted
# thinking, OpenAI reasoning item id, etc.). LHC stores and returns it
# verbatim — no interpretation (same posture as providerUsage).
class AssistantThinkingPayload(TypedDict):
    text: str
    signature: NotRequired[str]
    provider: NotRequired[str]
    model: NotRequired[str]
    api: NotRequired[str]


class ModelChangePayload(TypedDict):
    previousModel: str
    newModel: str


class ThinkingLevelChangePayload(TypedDict):
    previousLevel: str
    newLevel: str


class ToolCallPayload(TypedDict):
    toolCallId: str
    toolName: str
    arguments: dict[str, object]


class ToolResultPayload(TypedDict):
    toolCallId: str
    content: str
    isError: NotRequired[bool]


# Host-observed turn outcome/timing on turn_end (schema v5 / D1). All optional;
# empty payload stays valid for hosts that do not report these facts.
class TurnEndPayload(TypedDict, total=False):
    outcome: Literal["completed", "aborted"]
    outcomeReason: str
    startedAt: str
    endedAt: str


class UserPromptEvent(TypedDict):
    eventKind: Literal["user_prompt"]
    idempotencyKey: str
    actor: str  # non-empty
    harness: str  # non-empty
    payload: TextPayload


class UserSteerEvent(TypedDict):
    eventKind: Literal["user_steer"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: UserSteerPayload


class AssistantTextEvent(TypedDict):
    eventKind: Literal["assistant_text"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: AssistantTextPayload


class AssistantThinkingEvent(TypedDict):
    eventKind: Literal["assistant_thinking"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: AssistantThinkingPayload


class RuntimeNoteEvent(TypedDict):
    eventKind: Literal["runtime_note"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: TextPayload


class ModelChangeEvent(TypedDict):
    eventKind: Literal["model_change"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: ModelChangePayload


class ThinkingLevelChangeEvent(TypedDict):
    eventKind: Literal["thinking_level_change"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: ThinkingLevelChangePayload


class ToolCallEvent(TypedDict):
    eventKind: Literal["tool_call"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: ToolCallPayload


class ToolResultEvent(TypedDict):
    eventKind: Literal["tool_result"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: ToolResultPayload


class TurnEndEvent(TypedDict):
    eventKind: Literal["turn_end"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: TurnEndPayload


MessageEventInput = Union[
    UserPromptEvent,
    UserSteerEvent,
    AssistantTextEvent,
    AssistantThinkingEvent,
    RuntimeNoteEvent,
    ModelChangeEvent,
    ThinkingLevelChangeEvent,
    ToolCallEvent,
    ToolResultEvent,
    TurnEndEvent,
]

# Derived, not parallel-maintained: the kind list cannot drift from the union.
EventKind = Literal[
    "user_prompt",
    "user_steer",
    "assistant_text",
    "assistant_thinking",
    "runtime_note",
    "model_change",
    "thinking_level_change",
    "tool_call",
    "tool_result",
    "turn_end",
]


@dataclass(frozen=True, slots=True)
class BatchEventOutcome:
    idempotency_key: str
    outcome: Literal["recorded", "skipped"]
    message_id: str | None = None
    skip_reason: Literal["duplicate_idempotency_key"] | None = None


# NOMINAL-TYPING BOUNDARY: same shape as turns.TurnTransition, but a distinct class —
# dataclass __eq__ requires identical type, so callers comparing across the
# boundary must convert explicitly (tests import the intake twin).
@dataclass(frozen=True, slots=True)
class TurnTransition:
    action: Literal["opened", "closed"]
    turn_id: str


@dataclass(frozen=True, slots=True)
class QueuedWorkItem:
    work_item_id: str
    owner: WorkOwner
    kind: WorkKind
    source_ref: WorkSourceRef


@dataclass(frozen=True, slots=True)
class ThreadPosition:
    last_event_order: int


@dataclass(frozen=True, slots=True)
class BatchResult:
    events: list[BatchEventOutcome]
    turn_transitions: list[TurnTransition]
    queued_work: list[QueuedWorkItem]
    thread_position: ThreadPosition


# Read-back preserves the discrimination: intersecting the input union with
# server fields distributes over its members, so a narrowed eventKind narrows
# the payload on read exactly as it does on write. Python has no TypedDict
# intersection — expand each MessageEventInput member with eventOrder/recordedAt.


class UserPromptEventRecord(TypedDict):
    eventKind: Literal["user_prompt"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: TextPayload
    eventOrder: int
    recordedAt: str


class UserSteerEventRecord(TypedDict):
    eventKind: Literal["user_steer"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: UserSteerPayload
    eventOrder: int
    recordedAt: str


class AssistantTextEventRecord(TypedDict):
    eventKind: Literal["assistant_text"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: AssistantTextPayload
    eventOrder: int
    recordedAt: str


class AssistantThinkingEventRecord(TypedDict):
    eventKind: Literal["assistant_thinking"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: AssistantThinkingPayload
    eventOrder: int
    recordedAt: str


class RuntimeNoteEventRecord(TypedDict):
    eventKind: Literal["runtime_note"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: TextPayload
    eventOrder: int
    recordedAt: str


class ModelChangeEventRecord(TypedDict):
    eventKind: Literal["model_change"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: ModelChangePayload
    eventOrder: int
    recordedAt: str


class ThinkingLevelChangeEventRecord(TypedDict):
    eventKind: Literal["thinking_level_change"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: ThinkingLevelChangePayload
    eventOrder: int
    recordedAt: str


class ToolCallEventRecord(TypedDict):
    eventKind: Literal["tool_call"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: ToolCallPayload
    eventOrder: int
    recordedAt: str


class ToolResultEventRecord(TypedDict):
    eventKind: Literal["tool_result"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: ToolResultPayload
    eventOrder: int
    recordedAt: str


class TurnEndEventRecord(TypedDict):
    eventKind: Literal["turn_end"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: TurnEndPayload
    eventOrder: int
    recordedAt: str


EventRecord = Union[
    UserPromptEventRecord,
    UserSteerEventRecord,
    AssistantTextEventRecord,
    AssistantThinkingEventRecord,
    RuntimeNoteEventRecord,
    ModelChangeEventRecord,
    ThinkingLevelChangeEventRecord,
    ToolCallEventRecord,
    ToolResultEventRecord,
    TurnEndEventRecord,
]


async def message_events(
    thread_ref: ThreadRef,
    events: Sequence[MessageEventInput],
) -> OpResult[BatchResult]:
    from .internal.pipeline import run_message_events

    return await run_message_events(thread_ref, events)


async def list_events(thread_ref: ThreadRef) -> OpResult[list[EventRecord]]:
    from .internal.pipeline import run_list_events

    return await run_list_events(thread_ref)


@dataclass(frozen=True, slots=True)
class RecordedUserSteer:
    steer_id: str
    idempotency_key: str
    event_order: int
    recorded_at: str
    actor: str
    harness: str
    payload: UserSteerPayload
    message_id: str | None


async def find_user_steer(
    thread_ref: ThreadRef, steer_id: str
) -> OpResult[RecordedUserSteer | None]:
    from ..shared_tech.errors import OpErr
    from .internal.steer_lookup import run_find_user_steer
    from .internal.validate import validate_thread_ref

    failure = validate_thread_ref(thread_ref)
    if failure is not None:
        return OpErr(error=failure)
    return await run_find_user_steer(thread_ref, steer_id)
