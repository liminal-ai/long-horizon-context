"""Ported from packages/lhc/src/intake-stream/internal/validate.ts. Phase 1 skeleton.

Pure, whole-batch, three-layer closed validation. Effect Schema bindings are
represented as closed TypedDict declarations (decoded-JSON data shapes) per
Wave 3 fix-round ruling; decode bodies stay NotImplementedError until Phase 2.
"""

from __future__ import annotations

from typing import Literal, NotRequired, TypedDict, Union

from ...shared_tech.errors import ErrorResult

EVENT_KINDS: tuple[
    Literal["user_prompt"],
    Literal["assistant_text"],
    Literal["assistant_thinking"],
    Literal["runtime_note"],
    Literal["model_change"],
    Literal["thinking_level_change"],
    Literal["tool_call"],
    Literal["tool_result"],
    Literal["turn_end"],
] = (
    "user_prompt",
    "assistant_text",
    "assistant_thinking",
    "runtime_note",
    "model_change",
    "thinking_level_change",
    "tool_call",
    "tool_result",
    "turn_end",
)

# Denied by name with their own reason string: the old MVP's
# silent-root-field-drop bug class gets named when it appears.
_SERVER_GENERATED_FIELDS: tuple[str, ...] = (
    "eventOrder",
    "recordedAt",
    "threadEventId",
    "schemaVersion",
)

# TS: const DECODE_OPTIONS = { onExcessProperty: "error", errors: "first" } as const;
_DECODE_OPTIONS: dict[str, str] = {"onExcessProperty": "error", "errors": "first"}

# NOTE (Phase 2): `_NonEmptyString` is Effect `Schema.String.pipe(Schema.minLength(1))`.
# No Python equivalent without inventing a validation DSL — leave unbound.

# ── Layer 1 — envelope: thread reference shape, closed ─────────────
# NOTE (Phase 2): Effect Schema.Union decode order + NonEmptyString minLength(1)
# + onExcessProperty:"error" closedness are not expressed by TypedDict alone.


class _ThreadRefByIdSchema(TypedDict):
    threadId: str
    registryPath: NotRequired[str]


class _ThreadRefByPathSchema(TypedDict):
    filePath: str


_ThreadRefSchema = Union[_ThreadRefByIdSchema, _ThreadRefByPathSchema]

# ── Layer 2 — event object: the five required fields, closed ───────
# NOTE (Phase 2): payload is Schema.Unknown in TS (presence checked below);
# onExcessProperty:"error" closedness is not expressed by TypedDict alone.


class _EventEnvelopeSchema(TypedDict):
    eventKind: Literal[
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
    idempotencyKey: str
    actor: str
    harness: str
    payload: object


# ── Layer 3 — per-kind payload, closed ─────────────────────────────
# NOTE (Phase 2): NonEmptyString minLength(1) and onExcessProperty closedness
# are not expressed by TypedDict alone.


class _TextPayloadSchema(TypedDict):
    text: str


class _ModelChangePayloadSchema(TypedDict):
    previousModel: str
    newModel: str


class _ThinkingLevelChangePayloadSchema(TypedDict):
    previousLevel: str
    newLevel: str


class _ToolCallPayloadSchema(TypedDict):
    toolCallId: str
    toolName: str
    arguments: dict[str, object]


class _ToolResultPayloadSchema(TypedDict):
    toolCallId: str
    content: str
    isError: NotRequired[bool]


# NOTE (Phase 2): Effect `ParseResult.ParseError` has no Python counterpart.
# Closest stand-in: the structured decode failure object Phase 2 will produce.
_ParseError = object


def _first_issue(error: _ParseError) -> str:
    raise NotImplementedError


def _decode_issue(
    schema: (
        type[_ThreadRefByIdSchema]
        | type[_ThreadRefByPathSchema]
        | type[_EventEnvelopeSchema]
        | type[_TextPayloadSchema]
        | type[_ModelChangePayloadSchema]
        | type[_ThinkingLevelChangePayloadSchema]
        | type[_ToolCallPayloadSchema]
        | type[_ToolResultPayloadSchema]
    ),
    value: object,
) -> str | None:
    raise NotImplementedError


def _caller_error(reason: str, event_index: int | None = None) -> ErrorResult:
    raise NotImplementedError


# Envelope-level: the thread reference must decode against the closed union.
# Returns None when valid.
def validate_thread_ref(ref: object) -> ErrorResult | None:
    raise NotImplementedError


# Whole-batch validation: array order, first failure wins. Returns None
# when every event is valid.
def validate_events(events: object) -> ErrorResult | None:
    raise NotImplementedError


def _validate_one_event(event: object, index: int) -> ErrorResult | None:
    raise NotImplementedError
