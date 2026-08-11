"""R5 — truncation markers use full stored token_estimate (pin 81cd48c compose.ts)."""

from __future__ import annotations

from lhc.shared_tech.derivation import RenderingPartKind
from lhc.shared_tech.tool_result_rendering import truncate_for_fallback
from lhc.turns.internal.compose import (
    ComposeBlock,
    ComposeDerivationRow,
    ComposeMessage,
    compose_derivation_key,
    compose_rendering_input,
)


def _msg(
    message_id: str,
    kind: RenderingPartKind,
    content: dict[str, object],
    token_estimate: int,
) -> ComposeMessage:
    return ComposeMessage(
        message_id=message_id,
        kind=kind,
        token_estimate=token_estimate,
        blocks=[ComposeBlock(block_type=kind, content=content)],
    )


def test_compose_rendering_input_shows_each_truncated_message_full_stored_token_estimate() -> None:
    result = "r" * 700
    messages = [
        _msg(
            "m1",
            "tool_call",
            {
                "toolCallId": "c1",
                "toolName": "exec",
                "arguments": {"cmd": "x" * 700},
            },
            1073,
        ),
        _msg(
            "m2",
            "tool_result",
            {"toolCallId": "c1", "content": result, "isError": False},
            2049,
        ),
    ]
    legacy = truncate_for_fallback(result)
    assert "chars]" in legacy
    derivations = {
        compose_derivation_key("m2", "tool_result_summary"): ComposeDerivationRow(
            state="ready",
            source_version=1,
            content=legacy,
        ),
    }

    composition = compose_rendering_input(messages, derivations)
    assert len(composition.parts) == 1
    text = composition.parts[0].text
    assert "… [truncated — 1073 tok total]" in text
    assert "… [truncated — 2049 tok total]" in text
    assert "chars]" not in text


def test_compose_rendering_input_does_not_annotate_untruncated_tool_messages() -> None:
    messages = [
        _msg(
            "m1",
            "tool_call",
            {"toolCallId": "c1", "toolName": "exec", "arguments": {"cmd": "true"}},
            12,
        ),
        _msg(
            "m2",
            "tool_result",
            {"toolCallId": "c1", "content": "passed", "isError": False},
            3,
        ),
    ]

    composition = compose_rendering_input(messages, {})
    assert "truncated" not in composition.parts[0].text


def test_compose_rendering_input_passes_genuine_inference_summaries_verbatim() -> None:
    raw = "x" * 700
    summary = "model wrote a short summary of the large tool output"
    messages = [
        _msg(
            "m1",
            "tool_call",
            {"toolCallId": "c1", "toolName": "exec", "arguments": {}},
            50,
        ),
        _msg(
            "m2",
            "tool_result",
            {"toolCallId": "c1", "content": raw, "isError": False},
            900,
        ),
    ]
    derivations = {
        compose_derivation_key("m2", "tool_result_summary"): ComposeDerivationRow(
            state="ready",
            source_version=1,
            content=summary,
        ),
    }

    composition = compose_rendering_input(messages, derivations)
    text = composition.parts[0].text
    assert summary in text
    assert "truncated" not in text
