"""Ported from packages/lhc/src/intake-stream/index.ts. Phase 1 — PARTIAL (Wave 1/3 import seam).

Event type surface needed by Wave 1 fixtures/tests. Full intake lands in Wave 3.
Discriminated per-kind payload shapes are real (type definitions).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, NotRequired, TypedDict, Union

from ..shared_tech.errors import OpResult
from ..shared_tech.work_queue import WorkKind, WorkOwner, WorkSourceRef
from ..threads import ThreadRef


class TextPayload(TypedDict):
    text: str


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


class TurnEndPayload(TypedDict):
    pass  # Record<string, never> — closed empty object


class UserPromptEvent(TypedDict):
    eventKind: Literal["user_prompt"]
    idempotencyKey: str
    actor: str  # non-empty
    harness: str  # non-empty
    payload: TextPayload


class AssistantTextEvent(TypedDict):
    eventKind: Literal["assistant_text"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: TextPayload


class AssistantThinkingEvent(TypedDict):
    eventKind: Literal["assistant_thinking"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: TextPayload


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


class AssistantTextEventRecord(TypedDict):
    eventKind: Literal["assistant_text"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: TextPayload
    eventOrder: int
    recordedAt: str


class AssistantThinkingEventRecord(TypedDict):
    eventKind: Literal["assistant_thinking"]
    idempotencyKey: str
    actor: str
    harness: str
    payload: TextPayload
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
    events: list[MessageEventInput] | tuple[MessageEventInput, ...],
) -> OpResult[BatchResult]:
    raise NotImplementedError


async def list_events(thread_ref: ThreadRef) -> OpResult[list[EventRecord]]:
    raise NotImplementedError
