"""Ported from packages/lhc/test/epic-fix-02.test.ts. Phase 1.

Epic 02 Fix Batch 001 — Green-phase regression suite for the canonical
epic review's two blockers (impl-lead ruling epic-fix-001). New file: the
Red-committed suites stay byte-identical except mutations-delete.test.ts
TC-6.2, whose cascade-scope assertion the BLOCK-002b ruling corrects (and
whose manifest hash was re-recorded to bless that one change).

  - EPIC-02-BLOCK-001: per-SDK-instance poke/touch scoping — a manual SDK
    never auto-drains, regardless of construction order, even with a live
    background SDK in the same process on a different thread.
  - EPIC-02-BLOCK-002a/b: the call/result pair is a source dependency — a
    deleted tool_result re-queues its paired tool_call's summary, which
    rebuilds outcome `unknown` because the deleted-read filter excludes the
    dead result; unrelated summaries are untouched.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from typing import Literal

import pytest

from lhc import Lhc, count_live_items, init_lhc, set_scheduler_poke, set_thread_touch, threads
from lhc.messages import RemoveInput
from lhc.shared_tech.derivation import LeaseConfig, SdkConfig
from lhc.threads import NewThreadInput
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
    open_raw,
    read_derived_forms,
    temp_store,
    valid_event,
)
from fixtures.inference_callbacks_double import InferenceCallbacksDouble


@pytest.fixture
def store():
    s = temp_store()
    yield s
    set_scheduler_poke(None)
    set_thread_touch(None)
    s.cleanup()


async def _sleep(ms: float) -> None:
    await asyncio.sleep(ms / 1000)


async def _until(pred: Callable[[], bool], what: str, timeout_ms: float = 3000) -> None:
    start = asyncio.get_running_loop().time()
    while not pred():
        if (asyncio.get_running_loop().time() - start) * 1000 > timeout_ms:
            raise RuntimeError(f"timed out waiting for {what}")
        await _sleep(5)


async def _new_thread(store: TempStore, name: str) -> str:
    created = await threads.new_thread(
        NewThreadInput(file_path=store.thread_path(name), registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(f"thread creation failed: {created.error.reason}")
    return created.value.file_path


def _sdk_for(
    inference_callbacks: InferenceCallbacksDouble,
    mode: Literal["background", "manual"],
) -> Lhc:
    return init_lhc(
        SdkConfig(
            inference_callbacks=inference_callbacks,
            mode=mode,
            lease=LeaseConfig(duration_ms=1000),
        )
    )


def _live_count(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        return count_live_items(db)
    finally:
        db.close()


def _form_key(entry: object) -> str:
    return f"{entry.subject_kind}/{entry.subject_id}/{entry.derivation_type}"  # type: ignore[attr-defined]


async def test_background_then_manual_on_different_threads_the_manual_threads_rows_stay_queued_until_explicit_drain(
    store: TempStore,
) -> None:
    """background-then-manual on different threads: the manual thread's rows stay queued until explicit drain"""
    bg_double = create_inference_callbacks_double()
    sdk_bg = _sdk_for(bg_double, "background")
    man_double = create_inference_callbacks_double()
    sdk_man = _sdk_for(man_double, "manual")

    thread_b = await _new_thread(store, "bg")
    thread_m = await _new_thread(store, "man")

    queued = await sdk_man.intake_stream.message_events(
        {"filePath": thread_m}, [valid_event("user_prompt")]
    )
    assert queued.ok is True

    bg_batch = await sdk_bg.intake_stream.message_events(
        {"filePath": thread_b}, [valid_event("user_prompt")]
    )
    assert bg_batch.ok is True
    await sdk_bg.drain_settled({"filePath": thread_b})

    await _sleep(50)

    assert _live_count(thread_m) == 1
    assert [form.state for form in read_derived_forms(thread_m)] == ["pending"]

    assert _live_count(thread_b) == 0
    assert [form.state for form in read_derived_forms(thread_b)] == ["ready"]

    report = await sdk_man.work.drain({"filePath": thread_m})
    assert report.ok is True
    assert _live_count(thread_m) == 0
    assert [form.state for form in read_derived_forms(thread_m)] == ["ready"]


async def test_manual_then_background_isolates_the_manual_sdk_the_same_way(
    store: TempStore,
) -> None:
    """manual-then-background isolates the manual SDK the same way"""
    man_double = create_inference_callbacks_double()
    sdk_man = _sdk_for(man_double, "manual")
    bg_double = create_inference_callbacks_double()
    sdk_bg = _sdk_for(bg_double, "background")
    assert sdk_bg.scheduler.mode == "background"

    thread_m = await _new_thread(store, "man")
    queued = await sdk_man.intake_stream.message_events(
        {"filePath": thread_m}, [valid_event("user_prompt")]
    )
    assert queued.ok is True

    await _sleep(50)
    assert _live_count(thread_m) == 1
    assert [form.state for form in read_derived_forms(thread_m)] == ["pending"]


async def _tool_run_thread(store: TempStore, sdk: Lhc) -> str:
    file_path = await _new_thread(store, "toolrun")
    batch = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt"),
            valid_event("tool_call"),
            valid_event("tool_result"),
            valid_event("assistant_text"),
            valid_event("turn_end"),
        ],
    )
    assert batch.ok is True
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok is True
    return file_path


async def test_deleting_a_tool_result_drops_only_its_tool_result_summary(
    store: TempStore,
) -> None:
    """deleting a tool_result drops only its tool-result summary"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(double, "manual")
    file_path = await _tool_run_thread(store, sdk)

    before = read_derived_forms(file_path)
    result_before = next(
        (
            form
            for form in before
            if form.subject_id == "m3" and form.derivation_type == "tool_result_summary"
        ),
        None,
    )
    assert result_before is not None
    assert result_before.state == "ready"
    prompt_before = next(
        (
            form
            for form in before
            if form.subject_id == "m1" and form.derivation_type == "smoothed_prompt"
        ),
        None,
    )

    result = await sdk.messages.remove({"filePath": file_path}, RemoveInput(message_id="m3"))
    assert result.ok is True
    if not result.ok:
        return
    assert [_form_key(entry) for entry in result.value.dropped] == [
        "message/m3/tool_result_summary"
    ]

    rebuild = await sdk.work.drain({"filePath": file_path})
    assert rebuild.ok is True
    after = read_derived_forms(file_path)

    prompt_after = next(
        (
            form
            for form in after
            if form.subject_id == "m1" and form.derivation_type == "smoothed_prompt"
        ),
        None,
    )
    assert prompt_after == prompt_before
    assert _live_count(file_path) == 0


async def test_prompt_call_result_call_result_text_call_result_exactly_two_run_parts_sizes_2_and_1(
    store: TempStore,
) -> None:
    """prompt, call, result, call, result, text, call, result → exactly two run parts (sizes 2 and 1)"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(double, "manual")
    file_path = await _new_thread(store, "grouping")

    def call(id_: str):
        return valid_event(
            "tool_call",
            {"payload": {"toolCallId": id_, "toolName": "run_cmd", "arguments": {"id": id_}}},
        )

    def result(id_: str):
        return valid_event(
            "tool_result",
            {"payload": {"toolCallId": id_, "content": f"out {id_}", "isError": False}},
        )

    batch = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "do work"}}),
            call("a"),
            result("a"),
            call("b"),
            result("b"),
            valid_event("assistant_text", {"payload": {"text": "mid-turn note"}}),
            call("c"),
            result("c"),
            valid_event("turn_end"),
        ],
    )
    assert batch.ok is True
    assert (await sdk.work.drain({"filePath": file_path})).ok is True

    rendering = next(
        (
            f
            for f in read_derived_forms(file_path)
            if f.subject_id == "t1" and f.derivation_type == "turn_rendering"
        ),
        None,
    )
    run_text = rendering.content if rendering is not None and rendering.content is not None else ""
    run_headers = [match.group(0) for match in re.finditer(r"\[tool run · [^\]]+\]", run_text)]
    assert len(run_headers) == 2
    assert "2 calls" in run_headers[0]
    assert "1 call" in run_headers[1]
    assert rendering is not None
    assert rendering.metadata is None


async def test_a_mixed_outcome_run_stays_explicit_and_names_the_failure(store: TempStore) -> None:
    """a mixed-outcome run stays explicit and names the failure"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(double, "manual")
    file_path = await _new_thread(store, "mixed")
    batch = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "edit two"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "ok",
                        "toolName": "edit_file",
                        "arguments": {"path": "ok.txt"},
                    },
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "ok",
                        "content": "edited ok.txt",
                        "isError": False,
                    },
                },
            ),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "bad",
                        "toolName": "edit_file",
                        "arguments": {"path": "ro.txt"},
                    },
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "bad",
                        "content": "permission denied",
                        "isError": True,
                    },
                },
            ),
            valid_event("turn_end"),
        ],
    )
    assert batch.ok is True
    assert (await sdk.work.drain({"filePath": file_path})).ok is True

    rendering = next(
        (
            f
            for f in read_derived_forms(file_path)
            if f.subject_id == "t1" and f.derivation_type == "turn_rendering"
        ),
        None,
    )
    run_text = rendering.content if rendering is not None and rendering.content is not None else ""
    assert "[tool run · edit_file · 2 calls · 1 succeeded, 1 failed]" in run_text
    assert rendering is not None
    assert rendering.metadata is None


@pytest.mark.skip(reason="skipped in TS source (it.skip)")
async def test_completing_the_straggler_after_the_delete_discards_as_stale_discarded_tombstone_and_cascade_stand(
    store: TempStore,
) -> None:
    """completing the straggler after the delete discards as stale_discarded; tombstone and cascade stand"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(double, "manual")
    file_path = await _new_thread(store, "straggler")
    batch = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "prompt"}}),
            valid_event(
                "tool_call",
                {"payload": {"toolCallId": "k", "toolName": "run_cmd", "arguments": {}}},
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "k",
                        "content": "ok " * 1500,
                        "isError": False,
                    },
                },
            ),
            valid_event("turn_end"),
        ],
    )
    assert batch.ok is True

    double.delay_kind("tool_result_summary", 400)
    captured = double.capture_inputs()
    drain_promise = asyncio.ensure_future(sdk.work.drain({"filePath": file_path}))
    await _until(
        lambda: any(c.op == "summarizeToolResult" for c in captured),
        "m3's tool_result_summary to be claimed and in-handler",
    )

    deleted = await sdk.messages.remove({"filePath": file_path}, RemoveInput(message_id="m3"))
    assert deleted.ok is True
    if not deleted.ok:
        return
    assert "message/m3/tool_result_summary" in [_form_key(entry) for entry in deleted.value.dropped]

    drained = await drain_promise
    assert drained.ok is True
    if not drained.ok:
        return
    m3_item = next(
        (r for r in drained.value.ran if r.work_item_id == "w-m3-tool_result_summary-v1"),
        None,
    )
    assert m3_item is not None
    assert m3_item.disposition == "stale_discarded"

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    assert "m3" not in [m.message_id for m in listed.value]
    assert not any(f.subject_id == "m3" for f in read_derived_forms(file_path))
    assert _live_count(file_path) == 0
