"""Ported from packages/lhc/test/derivation-messages.test.ts. Phase 1.

Story 2 (Epic 02): message-level derivation — Flow 2. The three real
handlers (prompt smoothing, tool-call summary, tool-result summary) through
Story 1's drain, mechanical outcome stamping (TC-2.4's identical-text
fixture is the architecture-risk proof that model text never drives the
outcome), the hot-path locality assertion (TC-2.2: intake returns before
any model call), and the AC-2.8 late-result repair with its
control leg. No registerTestWorkHandlers here: every drain dispatches the
production handlers registered by the messages domain at initLhc.
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from lhc import (
    BatchResult,
    DrainReport,
    InferenceCallbacks,
    Lhc,
    MessageEventInput,
    count_live_items,
    init_lhc,
    threads,
)
from lhc.shared_tech.derivation import DerivationMetadata, InferenceOk, LeaseConfig, SdkConfig
from lhc.shared_tech.deterministic import deterministic_text
from lhc.threads import NewThreadInput
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
    open_raw,
    read_derived_forms,
    temp_store,
    thread_with_tool_run,
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
        raise RuntimeError(f"thread creation failed: {created.error.reason}")
    return created.value.file_path


def _manual_sdk(inference_callbacks: InferenceCallbacks) -> Lhc:
    return init_lhc(
        SdkConfig(
            inference_callbacks=inference_callbacks,
            mode="manual",
            lease=LeaseConfig(duration_ms=200),
        )
    )


async def _send(sdk: Lhc, file_path: str, batch: Sequence[MessageEventInput]) -> BatchResult:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(f"batch failed: {result.error.reason}")
    return result.value


async def _drain(sdk: Lhc, file_path: str) -> DrainReport:
    result = await sdk.work.drain({"filePath": file_path})
    if not result.ok:
        raise RuntimeError(f"drain failed: {result.error.reason}")
    return result.value


def _live_count(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        return count_live_items(db)
    finally:
        db.close()


def _form_of(file_path: str, subject_id: str, derivation_type: str):
    return next(
        (
            f
            for f in read_derived_forms(file_path)
            if f.subject_id == subject_id and f.derivation_type == derivation_type
        ),
        None,
    )


async def test_intake_a_prompt_drain_smoothed_form_ready_with_the_doubles_deterministic_output(
    store: TempStore,
) -> None:
    """intake a prompt, drain → smoothed form ready with the double's deterministic output"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)
    text = "please smooth this prompt"
    await _send(sdk, file_path, [valid_event("user_prompt", {"payload": {"text": text}})])

    report = await _drain(sdk, file_path)
    assert len(report.ran) == 1
    assert report.ran[0].work_item_id == "w-m1-prompt_smoothing-v1"
    assert report.ran[0].disposition == "done"

    # Readable alongside the message through the production read surface
    # (02F-001): list carries the stored form on the message record —
    # not a fixture read of derivation.
    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    message = listed.value[0]
    assert message.blocks[0].content["text"] == text
    assert message.derivations is not None
    assert len(message.derivations) == 1
    form = message.derivations[0]
    assert form.subject_kind == "message"
    assert form.subject_id == "m1"
    assert form.derivation_type == "smoothed_prompt"
    assert form.state == "ready"
    # The content is the double's pure function of the prompt text — the
    # production smoothPrompt input shape, nothing else mixed in.
    assert form.content == deterministic_text("smoothPrompt", {"text": text}, text)
    assert form.source_version == 1

    # The raw row agrees with the surfaced read: stored state, not a
    # read-time derivation.
    raw = _form_of(file_path, "m1", "smoothed_prompt")
    assert raw is not None
    assert raw.state == "ready"
    assert raw.content == deterministic_text("smoothPrompt", {"text": text}, text)


async def test_the_batch_reports_no_queued_item_and_no_derivation_row(store: TempStore) -> None:
    """the batch reports no queued item and no derivation row"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)

    batch = await _send(sdk, file_path, [valid_event("tool_call")])
    assert len(captured) == 0
    assert batch.queued_work == []

    report = await _drain(sdk, file_path)
    assert report.ran == []
    assert _form_of(file_path, "m1", "tool_result_summary") is None


@pytest.mark.skip(reason="skipped in TS source (it.skip)")
async def test_a_300kb_result_drains_to_a_bounded_summary_and_reads_back_whole_through_the_epic_01_surface(
    store: TempStore,
) -> None:
    """a 300KB result drains to a bounded summary and reads back whole through the Epic 01 surface"""
    big = "result-bytes " * 24000  # ~300KB
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _manual_sdk(double)
    tool_run = await thread_with_tool_run(store, {"resultContent": big})
    file_path = tool_run["filePath"]

    await _drain(sdk, file_path)
    assert len([entry for entry in captured if entry.op == "summarizeToolResult"]) == 1
    summary = _form_of(file_path, "m3", "tool_result_summary")
    assert summary is not None
    assert summary.state == "ready"
    assert summary.content is not None
    assert summary.content.startswith("toolresult(")
    assert "truncated" not in summary.content
    assert summary.metadata is not None
    assert summary.metadata == DerivationMetadata(outcome="succeeded")

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    result_message = next((m for m in listed.value if m.kind == "tool_result"), None)
    assert result_message is not None
    assert result_message.blocks[0].content["content"] == big


@pytest.mark.skip(reason="skipped in TS source (it.skip)")
async def test_tool_result_summaries_preserve_succeeded_failed_outcome_from_metadata_alone(
    store: TempStore,
) -> None:
    """tool-result summaries preserve succeeded / failed outcome from metadata alone"""
    double = create_inference_callbacks_double()
    constant_text = "the tool output says nothing reliable about status"

    class _Callbacks:
        async def smooth_prompt(self, i):
            return await double.smooth_prompt(i)

        async def summarize_tool_result(self, i):
            return InferenceOk(text=constant_text)

        async def compress_detailed_turn(self, i):
            return await double.compress_detailed_turn(i)

        async def summarize_chunk_brief(self, i):
            return await double.summarize_chunk_brief(i)

    callbacks: InferenceCallbacks = _Callbacks()
    sdk = _manual_sdk(callbacks)

    content = "model text status fixture " * 1500
    ok = await thread_with_tool_run(store, {"resultContent": content})
    errored = await thread_with_tool_run(store, {"resultContent": content, "isError": True})
    for run in (ok, errored):
        await _drain(sdk, run["filePath"])

    summaries = [_form_of(run["filePath"], "m3", "tool_result_summary") for run in (ok, errored)]
    assert [f.state if f else None for f in summaries] == ["ready", "ready"]
    assert [f.content if f else None for f in summaries] == [constant_text, constant_text]
    assert [
        f.metadata.outcome if f is not None and f.metadata is not None else None for f in summaries
    ] == ["succeeded", "failed"]


@pytest.mark.skip(reason="skipped in TS source (it.skip)")
async def test_the_captured_tool_result_summary_input_carries_classification_and_outcome(
    store: TempStore,
) -> None:
    """the captured tool-result summary input carries classification and outcome"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _manual_sdk(double)
    content = "src/file.ts:1:TODO\n" * 1200
    tool_run = await thread_with_tool_run(store, {"resultContent": content})
    file_path = tool_run["filePath"]

    await _drain(sdk, file_path)
    inputs = [entry for entry in captured if entry.op == "summarizeToolResult"]
    assert len(inputs) == 1
    inp = inputs[0].input
    assert isinstance(inp, dict)
    # TS toEqual — exact key membership (no extras); targetTokens is any Number.
    assert set(inp.keys()) == {
        "toolName",
        "content",
        "outcome",
        "targetTokens",
        "operationClass",
        "responseShape",
        "promptMode",
        "facts",
    }
    assert inp["toolName"] == "read_file"
    assert inp["content"] == content
    assert inp["outcome"] == "succeeded"
    assert type(inp["targetTokens"]) in (int, float)
    assert inp["operationClass"] == "unknown"
    assert inp["responseShape"] == "search_result"
    assert inp["promptMode"] == "search_summary"
    assert isinstance(inp["facts"], dict)
    assert inp["facts"]["outcome"] == "succeeded"
    assert "guidance" not in inp


async def test_smoothing_failure_lands_failed_with_the_inference_callback_reason_read_back_is_unaffected(
    store: TempStore,
) -> None:
    """smoothing failure lands failed with the inference callback reason; read-back is unaffected"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)
    text = "this prompt will never smooth"
    await _send(sdk, file_path, [valid_event("user_prompt", {"payload": {"text": text}})])

    double.fail_kind("prompt_smoothing", 99, {"reason": "scripted failure (smoothPrompt)"})
    report = await _drain(sdk, file_path)
    assert len(report.ran) == 1
    assert report.ran[0].work_item_id == "w-m1-prompt_smoothing-v1"
    assert report.ran[0].disposition == "failed_terminal"
    assert report.ran[0].reason == "scripted failure (smoothPrompt)"

    form = _form_of(file_path, "m1", "smoothed_prompt")
    assert form is not None
    assert form.state == "failed"
    assert form.reason == "scripted failure (smoothPrompt)"
    assert form.content is None

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    assert len(listed.value) == 1
    assert listed.value[0].blocks[0].content["text"] == text


async def test_message_source_damage_lands_blocked_rather_than_failed(store: TempStore) -> None:
    """message source damage lands blocked rather than failed"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)
    await _send(sdk, file_path, [valid_event("user_prompt")])

    db = open_raw(file_path)
    try:
        db.prepare(
            "UPDATE message_block SET content = '{}' WHERE message_id = 'm1' AND block_index = 0"
        ).run()
    finally:
        db.close()

    report = await _drain(sdk, file_path)
    assert len(report.ran) == 1
    assert report.ran[0].work_item_id == "w-m1-prompt_smoothing-v1"
    assert report.ran[0].disposition == "failed_terminal"
    assert report.ran[0].reason == "source_damaged: prompt m1 has no text block"
    form = _form_of(file_path, "m1", "smoothed_prompt")
    assert form is not None
    assert form.state == "blocked"
    assert form.reason == "source_damaged: prompt m1 has no text block"


async def test_assistant_text_a_runtime_note_and_assistant_thinking_no_items_no_derivation_rows_an_empty_drain(
    store: TempStore,
) -> None:
    """assistant text, a runtime note, and assistant thinking: no items, no derivation rows, an empty drain"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)

    # assistant_thinking joins the no-derivable-form kinds (Fix 3.2 coverage):
    # like assistant text and runtime notes it queues no work and carries no
    # derivation state row.
    batch = await _send(
        sdk,
        file_path,
        [
            valid_event("assistant_text"),
            valid_event("runtime_note"),
            valid_event("assistant_thinking"),
        ],
    )
    assert batch.queued_work == []
    assert _live_count(file_path) == 0

    report = await _drain(sdk, file_path)
    assert report.ran == []
    assert report.stopped_because == "empty"
    assert read_derived_forms(file_path) == []


async def test_tool_calls_create_no_work_item_or_derivation_row(store: TempStore) -> None:
    """tool calls create no work item or derivation row"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)

    batch = await _send(sdk, file_path, [valid_event("tool_call"), valid_event("tool_result")])
    assert [item.kind for item in batch.queued_work] == ["tool_result_summary"]

    await _drain(sdk, file_path)
    assert [f.derivation_type for f in read_derived_forms(file_path)] == ["tool_result_summary"]
    assert _live_count(file_path) == 0
