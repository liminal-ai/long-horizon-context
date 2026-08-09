"""Ported from packages/lhc/src/messages/internal/project.ts.

Event to message + typed blocks. Verbatim means payload fields are copied
into block content untouched: nothing here trims, normalizes, splits, or
summarizes.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from ...shared_tech._jsstr import js_json_dumps
from ...shared_tech.token_counting import estimate_tokens

# Runtime import (not TYPE_CHECKING): Phase 2 bodies construct these records.
# Safe because the parent __init__ defines them BEFORE importing this module
# (see the IMPORT-ORDER CONSTRAINT note there).
from .. import Block, RecordedEvent


@dataclass(frozen=True, slots=True)
class ProjectedMessage:
    blocks: list[Block]
    token_estimate: int


def _copy_optional_string(
    content: dict[str, object], payload: object, key: str
) -> None:
    """Verbatim optional string: present only when the payload key is set."""
    if not isinstance(payload, dict) or key not in payload:
        return
    value = payload[key]
    if value is not None:
        content[key] = value


# turn_end is recorded in the event order but produces no message.
def project_event(event: RecordedEvent) -> ProjectedMessage | None:
    kind = event["eventKind"]
    payload = event["payload"]
    if kind in ("user_prompt", "runtime_note"):
        text = payload["text"]
        return ProjectedMessage(
            blocks=[Block(block_type="text", content={"text": text})],
            token_estimate=estimate_tokens(text),
        )
    if kind == "assistant_text":
        # providerUsage rides the event payload and is stored as a message
        # column (not a block) — projection leaves text + optional provenance.
        text = payload["text"]
        content: dict[str, object] = {"text": text}
        _copy_optional_string(content, payload, "provider")
        _copy_optional_string(content, payload, "model")
        _copy_optional_string(content, payload, "api")
        return ProjectedMessage(
            blocks=[Block(block_type="text", content=content)],
            token_estimate=estimate_tokens(text),
        )
    if kind == "assistant_thinking":
        # Verbatim payload copy: text always; signature + model identity when sent.
        text = payload["text"]
        content = {"text": text}
        _copy_optional_string(content, payload, "signature")
        _copy_optional_string(content, payload, "provider")
        _copy_optional_string(content, payload, "model")
        _copy_optional_string(content, payload, "api")
        # Count signature bytes too — when served back to the provider they sit in
        # the live context window (the fable live-vs-LHC token gap).
        signature = content.get("signature")
        if isinstance(signature, str) and signature != "":
            estimate_source = f"{text}{signature}"
        else:
            estimate_source = text
        return ProjectedMessage(
            blocks=[Block(block_type="text", content=content)],
            token_estimate=estimate_tokens(estimate_source),
        )
    if kind == "model_change":
        previous_model = payload["previousModel"]
        new_model = payload["newModel"]
        return ProjectedMessage(
            blocks=[
                Block(
                    block_type="model_change",
                    content={
                        "previousModel": previous_model,
                        "newModel": new_model,
                    },
                )
            ],
            token_estimate=estimate_tokens(f"{previous_model} {new_model}"),
        )
    if kind == "thinking_level_change":
        previous_level = payload["previousLevel"]
        new_level = payload["newLevel"]
        return ProjectedMessage(
            blocks=[
                Block(
                    block_type="thinking_level_change",
                    content={
                        "previousLevel": previous_level,
                        "newLevel": new_level,
                    },
                )
            ],
            token_estimate=estimate_tokens(f"{previous_level} {new_level}"),
        )
    if kind == "tool_call":
        arguments = payload["arguments"]
        serialized_arguments = js_json_dumps(arguments)
        return ProjectedMessage(
            blocks=[
                Block(
                    block_type="tool_call",
                    content={
                        "toolCallId": payload["toolCallId"],
                        "toolName": payload["toolName"],
                        "arguments": arguments,
                    },
                )
            ],
            token_estimate=estimate_tokens(serialized_arguments),
        )
    if kind == "tool_result":
        content = payload["content"]
        return ProjectedMessage(
            blocks=[
                Block(
                    block_type="tool_result",
                    content={
                        "toolCallId": payload["toolCallId"],
                        "content": content,
                        "isError": (
                            payload["isError"]
                            if payload.get("isError") is not None
                            else False
                        ),
                    },
                )
            ],
            token_estimate=estimate_tokens(content),
        )
    if kind == "turn_end":
        return None
    raise ValueError(f"unknown event kind {kind}")
