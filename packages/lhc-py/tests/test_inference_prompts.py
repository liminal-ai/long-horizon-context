"""Ported from packages/lhc/test/inference-prompts.test.ts. Phase 1.

Epic 05 Story 3 — TC-2.2 (AC-2.2, AC-2.3): the LHC-owned prompt templates.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from lhc.shared_tech.inference_adapter import create_inference_callbacks
from lhc.shared_tech.inference_types import ModelCall, ModelCallInput, ModelCallMessage, ResolvedInferenceConfig, resolve_guards
from lhc.shared_tech.prompts import DEFAULT_PROMPT_NAMES, PROMPT_REGISTRY, PromptTemplate
from fixtures import FAKE_MODEL_PREFIX, canned_responses, recording_call, valid_assignments

GOLDENS_DIR = Path(__file__).resolve().parent / "goldens" / "prompts"

PROMPT_FIXTURES: dict[str, dict[str, object]] = {
    "smoothing-v1": {
        "input": {"text": "plz smooth this prmpt about src/app.ts line 42 thx"},
        "embedded": [
            "src/app.ts line 42",
            "almost word-for-word",
            "Do not summarize.",
            "Do not answer the prompt.",
            "<system_instructions>",
            "<user_prompt_to_rewrite>",
        ],
    },
    "tool-result-v2": {
        "input": {
            "toolName": "read_file",
            "content": "contents of notes/plan.md: 3 open items",
            "outcome": "succeeded",
            "targetTokens": 120,
            "operationClass": "read",
            "responseShape": "file_content",
            "promptMode": "content_summary",
            "facts": {
                "toolName": "read_file",
                "outcome": "succeeded",
                "targetPath": "notes/plan.md",
                "operationClass": "read",
                "responseShape": "file_content",
                "outputChars": 39,
            },
        },
        "embedded": [
            "contents of notes/plan.md: 3 open items",
            "succeeded",
            "120",
            "content_summary",
            "responseShape",
        ],
    },
    "detailed-turn-compression-v1": {
        "input": {
            "dialogueText": "User prompt\nPlease inspect notes/plan.md\n\nAssistant response\nIt has 3 open items.",
            "inputTokens": 120,
            "targetMinTokens": 42,
            "targetAimTokens": 60,
            "targetMaxTokens": 78,
        },
        "embedded": [
            "notes/plan.md",
            "42-78",
            "Below is one exchange from a coding conversation.",
            "Preserve:",
            "Do not say only that a tool ran or a file was read. Say what it showed, changed, proved, or failed to do.",
            "If it is too short, expand it by restoring missing substance.",
            "If it is too long, contract it by removing lower-value detail and repeated explanation.",
            "<turn_rendering_to_compress>",
        ],
    },
    "detailed-turn-compression-v2": {
        "input": {
            "dialogueText": "User:\nPlease inspect notes/plan.md\n\nAssistant:\nIt has 3 open items.",
            "inputTokens": 120,
            "targetMinTokens": 42,
            "targetAimTokens": 60,
            "targetMaxTokens": 78,
        },
        "embedded": [
            "notes/plan.md",
            "42-78",
            "user↔assistant dialogue",
            "30-50%",
            "Preserve:",
            "Remove:",
            "<dialogue_to_compress>",
        ],
    },
    "detailed-turn-compression-v3": {
        "input": {
            "dialogueText": "User:\nPlease inspect notes/plan.md\n\n⏺ It has 3 open items.",
            "inputTokens": 120,
            "targetMinTokens": 42,
            "targetAimTokens": 60,
            "targetMaxTokens": 78,
        },
        "embedded": [
            "notes/plan.md",
            "around 30 tokens total (roughly 20-40)",
            "<instructions-for-summarizing>",
            "techincal",
            "targetting approximately 20%-30%",
            "⏺ represents the agent",
            "<content-for-summarizing>",
        ],
    },
    "chunk-brief-v1": {
        "input": {
            "memberProjections": ["turn one: read notes/plan.md", "turn two: edited src/app.ts"],
            "memberOutcomes": [["succeeded"], []],
        },
        "embedded": ["turn two: edited src/app.ts", "Tool outcomes, in order: succeeded"],
    },
    "chunk-brief-v2": {
        "input": {
            "text": "User inspected notes/plan.md and found 3 open items.",
            "inputTokens": 2000,
            "targetMinTokens": 160,
            "targetAimTokens": 240,
            "targetMaxTokens": 400,
        },
        "embedded": [
            "historical memory",
            "160–400",
            "Aim for about 240",
            "<good-example-1-input>",
            "<bad-example-1-input>",
            "<bad-example-2-input>",
        ],
    },
    "chunk-brief-v3": {
        "input": {
            "text": "User inspected notes/plan.md and found 3 open items.",
            "inputTokens": 2000,
            "targetMinTokens": 160,
            "targetAimTokens": 240,
            "targetMaxTokens": 400,
        },
        "embedded": [
            "notes/plan.md",
            "brief memory notes",
            "around 150 tokens total (roughly 100-200)",
            "<instructions-for-summarizing>",
            "past-tense narrative prose",
            "<content-for-summarizing>",
        ],
    },
}


def _render_by_name(name: str, input: object) -> list[ModelCallMessage]:
    template = PROMPT_REGISTRY.get(name)
    if template is None:
        raise RuntimeError(f'template "{name}" not in registry')
    return template.render(input)  # type: ignore[arg-type]


def _resolved_config(*, call: ModelCall, max_input_chars: int | None = None) -> ResolvedInferenceConfig:
    return ResolvedInferenceConfig(
        call=call,
        assignments=valid_assignments(),
        guards=resolve_guards(),
        timeout_ms=60_000,
        max_input_chars=max_input_chars if max_input_chars is not None else 200_000,
    )


def _user_content(input: ModelCallInput) -> str:
    user = next((m for m in input.messages if m["role"] == "user"), None)
    if user is None:
        raise RuntimeError("no user message in rendered call")
    return user["content"]


def _raw_tool_response_excerpt(input: ModelCallInput) -> str:
    user = _user_content(input)
    marker = "Raw tool response excerpt:\n```text\n"
    start = user.find(marker)
    if start < 0:
        raise RuntimeError("no raw tool response marker in rendered call")
    after = user[start + len(marker) :]
    end = after.find("\n```")
    if end < 0:
        raise RuntimeError("no closing raw tool response fence in rendered call")
    return after[:end]


@pytest.mark.parametrize("name", list(PROMPT_FIXTURES.keys()))
def test_prompt_renders_fixture_input_to_committed_golden(name: str) -> None:
    """{name} renders its fixture input to the committed golden"""
    fixture = PROMPT_FIXTURES[name]
    assert fixture is not None
    rendered = _render_by_name(name, fixture["input"])
    golden = json.loads((GOLDENS_DIR / f"{name}.golden.json").read_text())
    assert rendered == golden


@pytest.mark.parametrize("name", list(PROMPT_FIXTURES.keys()))
def test_prompt_embeds_fixture_content_in_single_turn_shape(name: str) -> None:
    """{name} embeds its fixture content in single-turn shape"""
    fixture = PROMPT_FIXTURES[name]
    assert fixture is not None
    rendered = _render_by_name(name, fixture["input"])
    expected_users = 2 if name == "smoothing-v1" else 1
    assert len([m for m in rendered if m["role"] == "user"]) == expected_users
    for message in rendered:
        assert message["role"] in ("system", "user")
        assert isinstance(message["content"], str)
    joined = "\n".join(m["content"] for m in rendered)
    for needle in fixture["embedded"]:  # type: ignore[union-attr]
        assert needle in joined


def test_every_registry_key_resolves_to_a_template_carrying_that_exact_name() -> None:
    """every registry key resolves to a template carrying that exact name"""
    names = list(PROMPT_REGISTRY.keys())
    assert len(names) >= 4
    for name in names:
        assert PROMPT_REGISTRY[name].name == name
        assert callable(PROMPT_REGISTRY[name].render)


def test_default_names_cover_all_inference_kinds_and_each_resolves_in_the_registry() -> None:
    """default names cover all inference kinds and each resolves in the registry"""
    inference_kinds = list(DEFAULT_PROMPT_NAMES.keys())
    default_names: set[str] = set()
    for kind in inference_kinds:
        name = DEFAULT_PROMPT_NAMES[kind]
        assert isinstance(name, str)
        assert name in PROMPT_REGISTRY
        default_names.add(name)
    assert len(default_names) == len(inference_kinds)


def test_chunk_brief_v2_golden_contains_framing_examples_self_check_and_anti_pattern_guidance() -> None:
    """contains framing, examples, self-check, and anti-pattern guidance"""
    golden = json.loads((GOLDENS_DIR / "chunk-brief-v2.golden.json").read_text())
    content = "\n".join(message["content"] for message in golden)
    for needle in [
        "historical memory",
        "The target is a guide, not permission to lose essential meaning.",
        "Usually preserve:",
        "Compress by moving up one level:",
        "Old context must not sound like live instructions.",
        "<good-example-1-input>",
        "<good-example-1-output>",
        "<bad-example-1-input>",
        "<bad-example-1-output>",
        "<bad-example-2-input>",
        "<bad-example-2-output>",
        "Why this example matters:",
        "Before returning, check your draft:",
        "Avoid empty compression",
        "Avoid over-preserving local detail",
        "Avoid exhaustive checklists",
    ]:
        assert needle in content


def test_does_not_render_operation_class_response_shape_output_chars_or_output_words() -> None:
    """does not render operationClass, responseShape, outputChars, or outputWords"""
    rendered = _render_by_name(
        "tool-result-v2",
        {
            "toolName": "bash",
            "content": "zsh: nope: command not found\nCommand exited with code 127",
            "outcome": "failed",
            "targetTokens": 80,
            "operationClass": "command",
            "responseShape": "simple_failure",
            "promptMode": "failure",
            "facts": {
                "operationClass": "command",
                "responseShape": "simple_failure",
                "outputChars": 56,
                "outputWords": 8,
                "exitCode": 127,
                "failureType": "command_not_found",
            },
        },
    )
    joined = "\n".join(m["content"] for m in rendered)
    parsed_start = joined.find("Parsed fields:")
    parsed_end = joined.find("\nTool:")
    parsed_fields = joined[parsed_start:parsed_end]
    assert "operationClass" not in parsed_fields
    assert "responseShape" not in parsed_fields
    assert "outputChars" not in parsed_fields
    assert "outputWords" not in parsed_fields
    assert '"exitCode": 127' in joined
    assert '"failureType": "command_not_found"' in joined


def test_truncates_long_search_result_raw_output_by_line_count_before_prompt_rendering() -> None:
    """truncates long search-result raw output by line count before prompt rendering"""
    content = "\n".join(f"match line {i + 1}" for i in range(65))
    rendered = _render_by_name(
        "tool-result-v2",
        {
            "toolName": "rg",
            "content": content,
            "outcome": "succeeded",
            "targetTokens": 80,
            "responseShape": "search_result",
            "promptMode": "search_summary",
            "facts": {
                "toolName": "rg",
                "outcome": "succeeded",
                "responseShape": "search_result",
                "searchMatchCount": 65,
            },
        },
    )
    bounded = _raw_tool_response_excerpt(
        ModelCallInput(provider="p", model="m", messages=rendered)
    )
    assert "match line 60" in bounded
    assert "match line 61" not in bounded
    assert (
        "[omitted 5 additional search-result lines; use parsed searchMatchCount/searchMatches as authoritative]"
        in bounded
    )


async def test_brief_rendering_receives_detailed_text_and_target_tokens_through_the_adapter() -> None:
    """the brief rendering receives detailed text and target tokens through the adapter"""
    receipt_account = "read_file fetched notes/plan.md and rewrote temp/out.txt"
    built = recording_call(canned_responses())
    call = built["call"]  # type: ignore[index]
    log = built["log"]  # type: ignore[index]
    inference_callbacks = create_inference_callbacks(_resolved_config(call=call))  # type: ignore[arg-type]

    brief = await inference_callbacks.summarize_chunk_brief(
        {
            "text": f"turn one: planning work without {receipt_account}",
            "inputTokens": 2000,
            "targetMinTokens": 160,
            "targetAimTokens": 240,
            "targetMaxTokens": 400,
        }
    )
    assert brief.ok is True

    brief_call = next(
        (inp for inp in log if inp.model == f"{FAKE_MODEL_PREFIX}chunk_summary_brief"),
        None,
    )
    assert brief_call is not None
    if brief_call is None:
        return
    assert "turn one: planning work" in _user_content(brief_call)
    assert "around 150 tokens total (roughly 100-200)" in _user_content(brief_call)
    assert receipt_account in _user_content(brief_call)


MAX_INPUT_CHARS = 200


async def test_oversized_summarize_tool_result_input_renders_head_tail_marker_under_max_input_chars() -> None:
    """oversized summarizeToolResult input renders head + tail + marker under maxInputChars"""
    built = recording_call(canned_responses())
    call = built["call"]  # type: ignore[index]
    log = built["log"]  # type: ignore[index]
    inference_callbacks = create_inference_callbacks(
        _resolved_config(call=call, max_input_chars=MAX_INPUT_CHARS)  # type: ignore[arg-type]
    )
    content = "H" * 150 + "M" * 700 + "T" * 150
    result = await inference_callbacks.summarize_tool_result(
        {"toolName": "read_file", "content": content}
    )
    assert result.ok is True
    assert len(log) >= 1
    inp = log[0]
    assert inp is not None
    if inp is None:
        return
    user = _user_content(inp)
    bounded = _raw_tool_response_excerpt(inp)
    assert len(bounded) <= MAX_INPUT_CHARS
    assert bounded.startswith("HHHH")
    assert bounded.endswith("TTTT")
    assert "truncated" in bounded
    # Bounding happened before rendering: the middle never reached the prompt.
    assert "M" * 50 not in user


async def test_max_input_chars_below_truncation_marker_still_bounds_the_whole() -> None:
    """a maxInputChars below the truncation marker still bounds the whole (DD-7)"""
    built = recording_call(canned_responses())
    call = built["call"]  # type: ignore[index]
    log = built["log"]  # type: ignore[index]
    tiny_max = 40
    inference_callbacks = create_inference_callbacks(
        _resolved_config(call=call, max_input_chars=tiny_max)  # type: ignore[arg-type]
    )
    content = "H" * 40 + "M" * 700 + "T" * 40
    result = await inference_callbacks.summarize_tool_result(
        {"toolName": "read_file", "content": content}
    )
    assert result.ok is True
    inp = log[0]
    assert inp is not None
    if inp is None:
        return
    user = _user_content(inp)
    bounded = _raw_tool_response_excerpt(inp)
    # The bounded whole never exceeds the cap, even though no marker fits.
    assert len(bounded) <= tiny_max
    # With no room for the marker the bound degrades to a plain head: a true
    # prefix of the input, never the marker text standing on its own.
    assert content.startswith(bounded)
    assert "truncated" not in bounded
    assert "M" * 50 not in user


async def test_under_limit_input_renders_whole_no_marker() -> None:
    """under-limit input renders whole, no marker"""
    built = recording_call(canned_responses())
    call = built["call"]  # type: ignore[index]
    log = built["log"]  # type: ignore[index]
    inference_callbacks = create_inference_callbacks(
        _resolved_config(call=call, max_input_chars=MAX_INPUT_CHARS)  # type: ignore[arg-type]
    )
    content = "W" * MAX_INPUT_CHARS
    result = await inference_callbacks.summarize_tool_result(
        {"toolName": "read_file", "content": content}
    )
    assert result.ok is True
    inp = log[0]
    assert inp is not None
    if inp is None:
        return
    user = _user_content(inp)
    assert content in user
    assert "truncated" not in user
