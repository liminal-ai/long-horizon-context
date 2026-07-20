"""Ported from packages/lhc/test/tool-result-rendering.test.ts. Phase 1.

Story 2: tool-result rendering
"""

from __future__ import annotations

import json

import pytest

from lhc import BatchResult, DrainReport, InferenceCallbacks, Lhc, MessageEventInput, count_live_items, init_lhc, threads
from lhc.shared_tech.derivation import LeaseConfig, SdkConfig
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
    open_raw,
    read_derived_forms,
    temp_store,
    valid_event,
)


@pytest.fixture
def store() -> TempStore:
    s = temp_store()
    yield s
    s.cleanup()


async def _new_thread(store: TempStore) -> str:
    created = await threads.new_thread(
        {"filePath": store.thread_path(), "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(f"thread creation failed: {created.error.reason}")
    return created.value.file_path


def _sdk_for(inference_callbacks: InferenceCallbacks) -> Lhc:
    return init_lhc(
        SdkConfig(
            inference_callbacks=inference_callbacks,
            mode="manual",
            lease=LeaseConfig(duration_ms=200),
        )
    )


async def _send(sdk: Lhc, file_path: str, batch: list[MessageEventInput]) -> BatchResult:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(f"batch failed: {result.error.reason}")
    return result.value


async def _drain(sdk: Lhc, file_path: str) -> DrainReport:
    result = await sdk.work.drain({"filePath": file_path})
    if not result.ok:
        raise RuntimeError(f"drain failed: {result.error.reason}")
    return result.value


def _form_of(file_path: str, subject_id: str, derivation_type: str):
    return next(
        (
            f
            for f in read_derived_forms(file_path)
            if f.subject_id == subject_id and f.derivation_type == derivation_type
        ),
        None,
    )


def _live_count(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        return count_live_items(db)
    finally:
        db.close()


@pytest.mark.skip(reason="skipped in TS source (it.skip)")
async def test_large_tool_results_queue_work_and_reach_inference(store: TempStore) -> None:
    """large tool results queue work and reach inference"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)
    content = "result-token " * 6000

    batch = await _send(
        sdk,
        file_path,
        [
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "large",
                        "toolName": "read_file",
                        "arguments": {"path": "huge.log"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "large", "content": content, "isError": False}},
            ),
        ],
    )

    assert [item.work_item_id for item in batch.queued_work] == ["w-m2-tool_result_summary-v1"]
    assert _live_count(file_path) == 1
    await _drain(sdk, file_path)

    calls = [entry for entry in captured if entry.op == "summarizeToolResult"]
    assert len(calls) == 1
    inp = calls[0].input
    assert isinstance(inp, dict)
    assert inp["toolName"] == "read_file"
    assert inp["content"] == content
    assert inp["outcome"] == "succeeded"
    assert inp["operationClass"] == "unknown"
    assert inp["responseShape"] == "large_log"
    assert inp["promptMode"] == "large_log"
    assert isinstance(inp["facts"], dict)
    assert inp["facts"]["outcome"] == "succeeded"
    assert inp["facts"]["noOutput"] is False
    assert "guidance" not in inp
    form = _form_of(file_path, "m2", "tool_result_summary")
    assert form is not None
    assert form.state == "ready"
    assert form.metadata is not None
    assert form.metadata.outcome == "succeeded"
    assert "truncated" not in (form.content or "")

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    msg = next((m for m in listed.value if m.message_id == "m2"), None)
    assert msg is not None
    assert msg.blocks[0].content["content"] == content


@pytest.mark.skip(reason="skipped in TS source (it.skip)")
async def test_small_results_pass_through_while_larger_results_classify_before_queued_inference(
    store: TempStore,
) -> None:
    """small results pass through while larger results classify before queued inference"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)

    small = "small-result " * 100
    mid = "mid-result " * 1500
    batch = await _send(
        sdk,
        file_path,
        [
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "small",
                        "toolName": "read",
                        "arguments": {"path": "a.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "small", "content": small, "isError": False}},
            ),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "mid",
                        "toolName": "bash",
                        "arguments": {"command": "rg TODO src"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "mid", "content": mid, "isError": True}},
            ),
        ],
    )

    assert [item.work_item_id for item in batch.queued_work] == [
        "w-m2-tool_result_summary-v1",
        "w-m4-tool_result_summary-v1",
    ]
    report = await _drain(sdk, file_path)
    assert [entry.disposition for entry in report.ran] == ["done", "done"]

    calls = [entry for entry in captured if entry.op == "summarizeToolResult"]
    assert len(calls) == 1
    inp = calls[0].input
    assert isinstance(inp, dict)
    assert inp["toolName"] == "bash"
    assert inp["content"] == mid
    assert inp["outcome"] == "failed"
    assert inp["operationClass"] == "search_or_listing"
    assert inp["responseShape"] == "search_result"
    assert inp["promptMode"] == "search_summary"
    assert isinstance(inp["facts"], dict)
    assert inp["facts"]["command"] == "rg TODO src"
    assert inp["facts"]["outcome"] == "failed"
    assert "guidance" not in inp
    assert _form_of(file_path, "m2", "tool_result_summary") is not None
    assert _form_of(file_path, "m2", "tool_result_summary").content == small  # type: ignore[union-attr]
    assert _form_of(file_path, "m4", "tool_result_summary") is not None
    meta = _form_of(file_path, "m4", "tool_result_summary").metadata  # type: ignore[union-attr]
    assert meta is not None
    assert meta.outcome == "failed"


async def test_tool_call_arguments_render_as_recorded(store: TempStore) -> None:
    """tool-call arguments render as recorded"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "run it"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call",
                        "toolName": "exec",
                        "arguments": {"cmd": "pnpm test"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "call", "content": "passed", "isError": False}},
            ),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path)

    rendering = next(
        (f for f in read_derived_forms(file_path) if f.derivation_type == "turn_rendering"),
        None,
    )
    assert rendering is not None
    # NOTE (Phase 2): JSON.stringify compact form
    assert f'exec({json.dumps({"cmd": "pnpm test"}, separators=(",", ":"))})' in (rendering.content or "")


async def test_tail_tool_call_rendering_preserves_long_recorded_arguments_without_truncation(
    store: TempStore,
) -> None:
    """tail tool-call rendering preserves long recorded arguments without truncation"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)
    cmd = "x" * 240
    args = json.dumps({"cmd": cmd}, separators=(",", ":"))

    await _send(
        sdk,
        file_path,
        [
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "long-call",
                        "toolName": "exec",
                        "arguments": {"cmd": cmd},
                    }
                },
            ),
        ],
    )

    context_read = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert context_read.ok is True
    if not context_read.ok:
        return
    rendered = "\n".join(
        "".join(part.text for part in message.content) for message in context_read.value.messages
    )
    assert f"[tool call · exec] {args}" in rendered
    assert "truncated" not in rendered


@pytest.mark.skip(reason="skipped in TS source (it.skip)")
async def test_terminal_summary_failure_lands_failed_with_reason_while_source_result_remains_intact(
    store: TempStore,
) -> None:
    """terminal summary failure lands failed with reason while the source result remains intact"""
    double = create_inference_callbacks_double()
    double.fail_kind(
        "tool_result_summary",
        99,
        {"reason": "scripted tool summary failure"},
    )
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "fail",
                        "toolName": "read_file",
                        "arguments": {"path": "x"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "fail",
                        "content": "failure target " * 1500,
                        "isError": True,
                    }
                },
            ),
        ],
    )
    report = await _drain(sdk, file_path)
    assert len(report.ran) == 1
    assert report.ran[0].work_item_id == "w-m2-tool_result_summary-v1"
    assert report.ran[0].disposition == "failed_terminal"
    assert report.ran[0].reason == "scripted tool summary failure"
    form = _form_of(file_path, "m2", "tool_result_summary")
    assert form is not None
    assert form.state == "failed"
    assert form.reason == "scripted tool summary failure"

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    msg = next((m for m in listed.value if m.message_id == "m2"), None)
    assert msg is not None
    assert msg.blocks[0].content["content"] == "failure target " * 1500
