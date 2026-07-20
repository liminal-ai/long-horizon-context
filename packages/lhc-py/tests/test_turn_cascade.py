"""Ported from packages/lhc/test/turn-cascade.test.ts. Phase 1."""

from __future__ import annotations

import json
from collections.abc import Sequence

import pytest

from lhc import (
    InferenceCallbacks,
    Lhc,
    MessageEventInput,
    count_live_items,
    init_lhc,
    queue_detail,
    threads,
)
from lhc.shared_tech.derivation import LeaseConfig, SdkConfig
from lhc.shared_tech.inference_types import DerivationGuards, DetailedTurnCompressionGuards, SmoothedPromptGuards
from lhc.shared_tech.logging import LogQuery
from lhc.shared_tech.tool_result_rendering import truncate_for_fallback
from lhc.threads import NewThreadInput
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
    open_raw,
    read_derived_forms,
    temp_store,
    valid_event,
)


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


async def _new_thread(store: TempStore) -> str:
    created = await threads.new_thread(
        NewThreadInput(file_path=store.thread_path(), registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(created.error.reason)
    return created.value.file_path


def _sdk_for(inference_callbacks: InferenceCallbacks, **overrides) -> Lhc:
    guards_override = overrides.pop("guards", None)
    base_guards = DerivationGuards(
        detailed_turn_compression=DetailedTurnCompressionGuards(tiny_turn_tokens=1),
    )
    if guards_override is not None:
        # Merge like TS spread: overrides.guards overlays defaults, with
        # detailedTurnCompression.tinyTurnTokens still defaulting to 1.
        smoothed = guards_override.smoothed_prompt
        tool_result = guards_override.tool_result_summary
        detailed = guards_override.detailed_turn_compression
        tiny = detailed.tiny_turn_tokens if detailed is not None and detailed.tiny_turn_tokens is not None else 1
        guards = DerivationGuards(
            smoothed_prompt=smoothed,
            tool_result_summary=tool_result,
            detailed_turn_compression=DetailedTurnCompressionGuards(tiny_turn_tokens=tiny),
        )
    else:
        guards = base_guards
    return init_lhc(
        SdkConfig(
            inference_callbacks=inference_callbacks,
            mode="manual",
            lease=LeaseConfig(duration_ms=200),
            guards=guards,
            **overrides,
        )
    )


async def _send(sdk: Lhc, file_path: str, batch: Sequence[MessageEventInput]) -> None:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(result.error.reason)


async def _drain(sdk: Lhc, file_path: str, opts: dict | None = None) -> None:
    result = await sdk.work.drain({"filePath": file_path}, opts)
    if not result.ok:
        raise RuntimeError(result.error.reason)


def _form_of(file_path: str, subject_id: str, derivation_type: str):
    return next(
        (
            form
            for form in read_derived_forms(file_path)
            if form.subject_id == subject_id and form.derivation_type == derivation_type
        ),
        None,
    )


# turn_rendering is deterministic (AC-6.3): the rendering is the joined part
# texts, stored as the turn_rendering derivation. The composition tests read
# it back here instead of capturing a model call.
def _rendering_content(file_path: str) -> str:
    form = next(
        (f for f in read_derived_forms(file_path) if f.derivation_type == "turn_rendering"),
        None,
    )
    return form.content if form is not None and form.content is not None else ""


def _rendering_bodies(file_path: str) -> list[str]:
    return [
        "\n".join(part.split("\n")[1:])
        for part in _rendering_content(file_path).split("\n\n")
    ]


def _exec_sql(file_path: str, sql: str, *params: object) -> None:
    db = open_raw(file_path)
    try:
        db.prepare(sql).run(*params)
    finally:
        db.close()


def _delete_work_item(file_path: str, work_item_id: str) -> None:
    _exec_sql(file_path, "DELETE FROM work_item WHERE work_item_id = ?", work_item_id)


async def test_uses_ready_derivations_directly_and_writes_no_fallback_log(store: TempStore) -> None:
    """uses ready derivations directly and writes no fallback log"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "ready prompt"}}),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path)

    smoothed = _form_of(file_path, "m1", "smoothed_prompt")
    smoothed_content = smoothed.content if smoothed is not None else None
    # turn_rendering is deterministic; its first segment is the ready smoothed prompt.
    assert _rendering_bodies(file_path)[0] == smoothed_content

    logs = await sdk.logging.query({"filePath": file_path}, LogQuery(reason="not_ready"))
    assert logs.ok is True
    if not logs.ok:
        return
    assert logs.value == []


async def test_falls_pending_derivations_to_deterministic_floors_when_re_derivation_does_not_complete(
    store: TempStore,
) -> None:
    """falls pending derivations to deterministic floors when re-derivation does not complete"""
    double = create_inference_callbacks_double()
    double.fail_kind("smoothed_prompt", 1, {"reason": "recovery unavailable"})
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "  pending    prompt because i asked  "}}),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")

    await _drain(sdk, file_path)

    # The rendering falls back to the prompt floor (smoothed not ready), so its
    # first segment is the deterministic floor text.
    assert _rendering_bodies(file_path)[0] == "pending prompt because I asked"
    form = _form_of(file_path, "m1", "smoothed_prompt")
    assert form is not None
    assert form.state == "ready"
    assert form.content == "pending prompt because I asked"

    logs = await sdk.logging.query(
        {"filePath": file_path}, LogQuery(derivation_type="smoothed_prompt")
    )
    assert logs.ok is True
    if not logs.ok:
        return
    assert [(entry.subject_id, entry.reason, entry.floor_used) for entry in logs.value] == [
        ("m1", "not_ready", "pending prompt because I asked")
    ]


async def test_falls_back_to_original_prompt_source_when_the_deterministic_floor_is_unavailable(
    store: TempStore,
) -> None:
    """falls back to original prompt source when the deterministic floor is unavailable"""
    double = create_inference_callbacks_double()
    double.fail_kind("smoothed_prompt", 1, {"reason": "recovery unavailable"})
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)
    original = " \t\n  "

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": original}}),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")

    await _drain(sdk, file_path)

    assert _rendering_bodies(file_path)[0] == original
    form = _form_of(file_path, "m1", "smoothed_prompt")
    assert form is not None
    assert form.state == "ready"
    assert form.content == original


async def test_falls_failed_derivations_through_the_same_floor_path_when_re_derivation_does_not_complete(
    store: TempStore,
) -> None:
    """falls failed derivations through the same floor path when re-derivation does not complete"""
    double = create_inference_callbacks_double()
    double.fail_kind("smoothed_prompt", 1, {"reason": "recovery unavailable"})
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "  failed    prompt because i asked  "}}),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")
    _exec_sql(
        file_path,
        """UPDATE derivation SET state = 'failed', reason = 'terminal'
       WHERE subject_id = ? AND derivation_type = 'smoothed_prompt'""",
        "m1",
    )

    await _drain(sdk, file_path)

    assert _rendering_bodies(file_path)[0] == "failed prompt because I asked"
    form = _form_of(file_path, "m1", "smoothed_prompt")
    assert form is not None
    assert form.state == "ready"
    assert form.content == "failed prompt because I asked"


async def test_uses_deterministic_floors_for_failed_message_derivations_without_calling_message_inference(
    store: TempStore,
) -> None:
    """uses deterministic floors for failed message derivations without calling message inference"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "  recover    me  "}}),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")
    _exec_sql(
        file_path,
        """UPDATE derivation SET state = 'failed', reason = 'terminal'
       WHERE subject_id = ? AND derivation_type = 'smoothed_prompt'""",
        "m1",
    )
    calls_before_turn = len(captured)

    await _drain(sdk, file_path)

    assert [entry for entry in captured[calls_before_turn:] if entry.op == "smoothPrompt"] == []
    assert _rendering_bodies(file_path)[0] == "recover me"
    form = _form_of(file_path, "m1", "smoothed_prompt")
    assert form is not None
    assert form.state == "ready"
    assert form.content == "recover me"
    assert form.reason is None
    logs = await sdk.logging.query(
        {"filePath": file_path}, LogQuery(derivation_type="smoothed_prompt")
    )
    assert logs.ok is True
    if not logs.ok:
        return
    assert [(entry.subject_id, entry.reason) for entry in logs.value] == [("m1", "failed_floor")]


async def test_does_not_overwrite_an_already_ready_message_derivation_when_composing_the_turn(
    store: TempStore,
) -> None:
    """does not overwrite an already-ready message derivation when composing the turn"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "  race    prompt because i asked  "}}),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path, {"maxItems": 1})
    _exec_sql(
        file_path,
        """UPDATE derivation
       SET state = 'ready', content = ?, reason = NULL, derived_at = ?
       WHERE subject_id = ? AND derivation_type = 'smoothed_prompt'""",
        "real worker output",
        "2026-01-01T00:00:00.000Z",
        "m1",
    )

    derived = await sdk.turns.derive_turn({"filePath": file_path}, "t1")
    assert derived.ok is True
    assert _rendering_bodies(file_path)[0] == "real worker output"
    form = _form_of(file_path, "m1", "smoothed_prompt")
    assert form is not None
    assert form.state == "ready"
    assert form.content == "real worker output"


async def test_renders_assistant_text_thinking_and_runtime_notes_verbatim_in_record_order(
    store: TempStore,
) -> None:
    """renders assistant text, thinking, and runtime notes verbatim in record order"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "order check"}}),
            valid_event("assistant_text", {"payload": {"text": "first answer"}}),
            valid_event("assistant_thinking", {"payload": {"text": "thinking exactly"}}),
            valid_event("runtime_note", {"payload": {"text": "runtime changed exactly"}}),
            valid_event("assistant_text", {"payload": {"text": "second answer"}}),
            valid_event("turn_end"),
        ],
    )

    await _drain(sdk, file_path)

    # turn_rendering is the parts' text joined in record order; thinking and
    # runtime notes render verbatim, in position, between the answer texts.
    smoothed = _form_of(file_path, "m1", "smoothed_prompt")
    smoothed_content = smoothed.content if smoothed is not None else None
    assert _rendering_bodies(file_path) == [
        smoothed_content,
        "first answer",
        "thinking exactly",
        "runtime changed exactly",
        "second answer",
    ]


async def test_floors_small_tool_result_summaries_without_calling_message_inference_during_turn_construction(
    store: TempStore,
) -> None:
    """floors small tool-result summaries without calling message inference during turn construction"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)
    content = "tool-output"

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "summarize tool"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call",
                        "toolName": "read_file",
                        "arguments": {"path": "large.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "call", "content": content, "isError": False}},
            ),
            valid_event("turn_end"),
        ],
    )
    _delete_work_item(file_path, "w-m3-tool_result_summary-v1")
    calls_before_turn = len(captured)

    await _drain(sdk, file_path)

    assert [
        entry for entry in captured[calls_before_turn:] if entry.op == "summarizeToolResult"
    ] == []
    floored = truncate_for_fallback(content)
    assert floored in _rendering_content(file_path)
    form = _form_of(file_path, "m3", "tool_result_summary")
    assert form is not None
    assert form.state == "ready"
    assert form.content == floored


async def test_floors_over_large_failed_tool_result_summaries_with_deterministic_truncation_and_no_turn_time_inference(
    store: TempStore,
) -> None:
    """floors over-large failed tool-result summaries with deterministic truncation and no turn-time inference"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)
    content = "large-result-token " * 6000

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "summarize the large result"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call",
                        "toolName": "read_file",
                        "arguments": {"path": "huge.log"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "call", "content": content, "isError": False}},
            ),
            valid_event("turn_end"),
        ],
    )
    _exec_sql(
        file_path,
        """UPDATE derivation
       SET state = 'failed', content = NULL, reason = 'scripted failure'
       WHERE subject_kind = 'message'
         AND subject_id = 'm3'
         AND derivation_type = 'tool_result_summary'""",
    )
    _delete_work_item(file_path, "w-m3-tool_result_summary-v1")
    calls_before_turn = len(captured)

    await _drain(sdk, file_path)

    assert [
        entry for entry in captured[calls_before_turn:] if entry.op == "summarizeToolResult"
    ] == []
    floored = _form_of(file_path, "m3", "tool_result_summary")
    assert floored is not None
    assert floored.state == "ready"
    assert floored.content is not None
    assert "large-result-token" in floored.content
    assert len(floored.content) < len(content)
    assert floored.content in _rendering_content(file_path)
    assert "[fallback; outcome: succeeded]" in _rendering_content(file_path)


async def test_floors_failed_tool_result_summaries_during_turn_construction_without_re_running_classification_inference(
    store: TempStore,
) -> None:
    """floors failed tool-result summaries during turn construction without re-running classification inference"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)
    content = "search-hit " * 1500

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "summarize search output"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call",
                        "toolName": "bash",
                        "arguments": {"command": "rg TODO src"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "call", "content": content, "isError": True}},
            ),
            valid_event("turn_end"),
        ],
    )
    _delete_work_item(file_path, "w-m3-tool_result_summary-v1")
    calls_before_turn = len(captured)

    await _drain(sdk, file_path)

    assert [
        entry for entry in captured[calls_before_turn:] if entry.op == "summarizeToolResult"
    ] == []
    floored = _form_of(file_path, "m3", "tool_result_summary")
    assert floored is not None
    assert floored.state == "ready"
    assert floored.content is not None
    assert "search-hit" in floored.content
    assert len(floored.content) < len(content)
    assert floored.content in _rendering_content(file_path)
    assert "[fallback; outcome: failed]" in _rendering_content(file_path)


async def test_recovers_over_cap_prompts_with_deterministic_cleaned_text_and_no_smoothing_model_call(
    store: TempStore,
) -> None:
    """recovers over-cap prompts with deterministic cleaned text and no smoothing model call"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _sdk_for(
        double,
        guards=DerivationGuards(smoothed_prompt=SmoothedPromptGuards(max_inference_tokens=1)),
    )
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event(
                "user_prompt",
                {"payload": {"text": "  please    fix this because i asked  "}},
            ),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")

    await _drain(sdk, file_path)

    assert [entry for entry in captured if entry.op == "smoothPrompt"] == []
    form = _form_of(file_path, "m1", "smoothed_prompt")
    assert form is not None
    assert form.state == "ready"
    assert form.content == "please fix this because I asked"


async def test_logs_fallback_when_a_message_derivation_row_is_absent(store: TempStore) -> None:
    """logs fallback when a message derivation row is absent"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "summarize the missing row"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call",
                        "toolName": "read_file",
                        "arguments": {"path": "missing.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "call", "content": "rowless output", "isError": False}},
            ),
            valid_event("turn_end"),
        ],
    )
    _delete_work_item(file_path, "w-m3-tool_result_summary-v1")
    _exec_sql(
        file_path,
        """DELETE FROM derivation
       WHERE subject_kind = 'message'
         AND subject_id = 'm3'
         AND derivation_type = 'tool_result_summary'""",
    )

    await _drain(sdk, file_path)

    queried = await sdk.logging.query(
        {"filePath": file_path}, LogQuery(derivation_type="tool_result_summary")
    )
    assert queried.ok is True
    if not queried.ok:
        return
    assert len(queried.value) == 1
    assert queried.value[0].level == "warning"
    assert queried.value[0].message == "derivation fallback used"
    assert queried.value[0].derivation_type == "tool_result_summary"
    assert queried.value[0].subject_id == "m3"
    assert queried.value[0].reason == "not_ready"
    assert queried.value[0].floor_used == "rowless output"
    form = _form_of(file_path, "m3", "tool_result_summary")
    assert form is not None
    assert form.state == "ready"
    assert form.content == "rowless output"


async def test_constructs_a_turn_with_every_component_present_when_multiple_derivations_are_not_ready(
    store: TempStore,
) -> None:
    """constructs a turn with every component present when multiple derivations are not ready"""
    double = create_inference_callbacks_double()
    double.fail_kind("smoothed_prompt", 1, {"reason": "recovery unavailable"})
    double.fail_kind("tool_result_summary", 1, {"reason": "recovery unavailable"})
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event(
                "user_prompt", {"payload": {"text": "  multi    fallback because i asked  "}}
            ),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call",
                        "toolName": "read_file",
                        "arguments": {"path": "multi.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "call", "content": "tool-output", "isError": False}},
            ),
            valid_event("assistant_text", {"payload": {"text": "answer after tool"}}),
            valid_event("turn_end"),
        ],
    )
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")
    _delete_work_item(file_path, "w-m3-tool_result_summary-v1")

    await _drain(sdk, file_path)

    # The rendering carries the prompt floor, the tool run (call args + result
    # floor), and the assistant text — verifying the composed content without
    # an inference-callback capture (turn_rendering is deterministic, AC-6.3).
    rendering = _rendering_content(file_path)
    assert "multi fallback because I asked" in rendering
    assert 'read_file({"path":"multi.txt"})' in rendering
    assert "tool-output" in rendering
    assert "answer after tool" in rendering
    form_m1 = _form_of(file_path, "m1", "smoothed_prompt")
    assert form_m1 is not None
    assert form_m1.state == "ready"
    assert form_m1.content == "multi fallback because I asked"
    form_m3 = _form_of(file_path, "m3", "tool_result_summary")
    assert form_m3 is not None
    assert form_m3.state == "ready"
    assert form_m3.content == "tool-output"


async def test_leaves_derivation_rows_untouched_when_live_work_exists_but_still_renders_a_floor(
    store: TempStore,
) -> None:
    """leaves derivation rows untouched when live work exists but still renders a floor"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "  live    work because i asked  "}}),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")
    _exec_sql(
        file_path,
        """INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
       VALUES (?, 'messages', 'prompt_smoothing', ?, 'queued', ?, ?)""",
        "w-m1-prompt_smoothing-v1-live",
        json.dumps({"messageId": "m1"}, separators=(",", ":")),
        "2026-01-01T00:00:00.000Z",
        json.dumps(
            {
                "sourceVersion": 1,
                "derivations": [
                    {
                        "subjectKind": "message",
                        "subjectId": "m1",
                        "derivationType": "smoothed_prompt",
                    }
                ],
            },
            separators=(",", ":"),
        ),
    )

    await _drain(sdk, file_path, {"maxItems": 1})

    assert _rendering_bodies(file_path)[0] == "live work because I asked"
    form = _form_of(file_path, "m1", "smoothed_prompt")
    assert form is not None
    assert form.state == "pending"

    db = open_raw(file_path)
    try:
        assert count_live_items(db) == 2
        assert queue_detail(db)[0].work_item_id == "w-m1-prompt_smoothing-v1-live"
    finally:
        db.close()
