"""Ported from packages/lhc/src/intake-stream/internal/validate.ts.

Pure, whole-batch, three-layer closed validation. Effect Schema bindings are
represented as closed TypedDict declarations (decoded-JSON data shapes) per
Wave 3 fix-round ruling; decode bodies implement the closed three-layer validation.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
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
@dataclass(frozen=True, slots=True)
class _ParseError:
    path: tuple[str, ...]
    message: str


def _first_issue(error: _ParseError) -> str:
    if not error.path:
        return error.message
    return f'"{".".join(error.path)}" {error.message}'


def _actual(value: object) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (int, float)) and type(value) is not bool:
        return str(value)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _type_label(kind: str) -> str:
    # Effect ArrayFormatter type labels for the Expected { readonly ... } shape.
    if kind == "nonempty":
        return "minLength(1)"
    if kind == "string":
        return "string"
    if kind == "boolean":
        return "boolean"
    if kind == "record":
        return "{ readonly [x: string]: unknown }"
    if kind == "unknown":
        return "unknown"
    if kind == "event_kind":
        return '"user_prompt"'
    return kind


def _expected_shape(fields: tuple[tuple[str, str, bool], ...]) -> str:
    parts: list[str] = []
    for name, kind, optional in fields:
        label = _type_label(kind)
        if optional:
            parts.append(f"readonly {name}?: {label} | undefined")
        else:
            parts.append(f"readonly {name}: {label}")
    return "{ " + "; ".join(parts) + " }"


def _struct_issue(
    value: object,
    fields: tuple[tuple[str, str, bool], ...],
) -> _ParseError | None:
    expected = " | ".join(f'"{name}"' for name, _, _ in fields)
    if not isinstance(value, dict):
        return _ParseError((), f"Expected {_expected_shape(fields)}, actual {_actual(value)}")

    allowed = {name for name, _, _ in fields}
    for name in value:
        if name not in allowed:
            return _ParseError((str(name),), f"is unexpected, expected: {expected}")

    for name, kind, optional in fields:
        if name not in value:
            if not optional:
                return _ParseError((name,), "is missing")
            continue
        item = value[name]
        if kind == "string":
            if not isinstance(item, str):
                return _ParseError((name,), f"Expected string, actual {_actual(item)}")
        elif kind == "nonempty":
            if not isinstance(item, str):
                return _ParseError((name,), f"Expected string, actual {_actual(item)}")
            if item == "":
                return _ParseError(
                    (name,),
                    'Expected a string at least 1 character(s) long, actual ""',
                )
        elif kind == "boolean":
            if type(item) is not bool:
                return _ParseError((name,), f"Expected boolean, actual {_actual(item)}")
        elif kind == "record":
            if not isinstance(item, dict):
                return _ParseError(
                    (name,),
                    f"Expected {{ readonly [x: string]: unknown }}, actual {_actual(item)}",
                )
        elif kind == "event_kind":
            if not isinstance(item, str) or item not in EVENT_KINDS:
                return _ParseError(
                    (name,),
                    f'Expected "user_prompt", actual {_actual(item)}',
                )
        elif kind == "unknown":
            continue

    return None


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
    if schema is _ThreadRefByIdSchema:
        issue = _struct_issue(
            value,
            (("threadId", "nonempty", False), ("registryPath", "string", True)),
        )
    elif schema is _ThreadRefByPathSchema:
        issue = _struct_issue(value, (("filePath", "nonempty", False),))
    elif schema is _EventEnvelopeSchema:
        # payload is Schema.Unknown: required key when present is never typed,
        # and a missing key is tolerated (presence checked after decode).
        issue = _struct_issue(
            value,
            (
                ("eventKind", "event_kind", False),
                ("idempotencyKey", "nonempty", False),
                ("actor", "nonempty", False),
                ("harness", "nonempty", False),
                ("payload", "unknown", True),
            ),
        )
    elif schema is _TextPayloadSchema:
        issue = _struct_issue(value, (("text", "string", False),))
    elif schema is _ModelChangePayloadSchema:
        issue = _struct_issue(
            value,
            (("previousModel", "nonempty", False), ("newModel", "nonempty", False)),
        )
    elif schema is _ThinkingLevelChangePayloadSchema:
        issue = _struct_issue(
            value,
            (("previousLevel", "nonempty", False), ("newLevel", "nonempty", False)),
        )
    elif schema is _ToolCallPayloadSchema:
        issue = _struct_issue(
            value,
            (
                ("toolCallId", "nonempty", False),
                ("toolName", "nonempty", False),
                ("arguments", "record", False),
            ),
        )
    else:
        issue = _struct_issue(
            value,
            (
                ("toolCallId", "nonempty", False),
                ("content", "string", False),
                ("isError", "boolean", True),
            ),
        )
    return _first_issue(issue) if issue is not None else None


def _caller_error(reason: str, event_index: int | None = None) -> ErrorResult:
    return ErrorResult(
        error_class="caller_error",
        code="invalid_event",
        reason=reason,
        event_index=event_index,
    )


# Envelope-level: the thread reference must decode against the closed union.
# Returns None when valid. Effect Union with errors:"first" reports the first
# member's issue — mirror by always surfacing the by-id branch failure text
# when neither member decodes.
def validate_thread_ref(ref: object) -> ErrorResult | None:
    by_id = _decode_issue(_ThreadRefByIdSchema, ref)
    if by_id is None:
        return None
    if _decode_issue(_ThreadRefByPathSchema, ref) is None:
        return None
    return _caller_error(f"envelope: invalid thread reference — {by_id}")


# Whole-batch validation: array order, first failure wins. Returns None
# when every event is valid.
def validate_events(events: object) -> ErrorResult | None:
    if not isinstance(events, (list, tuple)):
        return _caller_error("envelope: events must be a JSON array")
    if len(events) == 0:
        return ErrorResult(
            error_class="caller_error",
            code="empty_batch",
            reason="envelope: events array is empty; a batch must carry at least one event",
        )
    for index, event in enumerate(events):
        failure = _validate_one_event(event, index)
        if failure is not None:
            return failure
    return None


def _validate_one_event(event: object, index: int) -> ErrorResult | None:
    if not isinstance(event, dict):
        return _caller_error("event: each event must be a JSON object", index)

    for field in _SERVER_GENERATED_FIELDS:
        if field in event:
            return _caller_error(
                f'event: server-generated field "{field}" must not be supplied by the caller',
                index,
            )

    kind = event.get("eventKind")
    if isinstance(kind, str) and kind not in EVENT_KINDS:
        return _caller_error(f'event: unknown event kind "{kind}"', index)

    issue = _decode_issue(_EventEnvelopeSchema, event)
    if issue is not None:
        return _caller_error(f"event: {issue}", index)

    # Schema.Unknown tolerates a missing payload key; presence is layer 3.
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return _caller_error("event: payload must be a JSON object", index)

    if kind == "turn_end":
        if payload:
            first_key = next(iter(payload))
            return _caller_error(
                f'payload: turn_end events carry an empty payload; found field "{first_key}"',
                index,
            )
        return None

    payload_schema: type[
        _TextPayloadSchema
        | _ModelChangePayloadSchema
        | _ThinkingLevelChangePayloadSchema
        | _ToolCallPayloadSchema
        | _ToolResultPayloadSchema
    ]
    if kind == "tool_call":
        payload_schema = _ToolCallPayloadSchema
    elif kind == "tool_result":
        payload_schema = _ToolResultPayloadSchema
    elif kind == "model_change":
        payload_schema = _ModelChangePayloadSchema
    elif kind == "thinking_level_change":
        payload_schema = _ThinkingLevelChangePayloadSchema
    else:
        payload_schema = _TextPayloadSchema
    issue = _decode_issue(payload_schema, payload)
    if issue is not None:
        return _caller_error(f"payload: {issue}", index)
    return None
