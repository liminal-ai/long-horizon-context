"""Ported from packages/lhc/test/inference-adapter.test.ts. Phase 1.

Epic 05 Story 3 — TC-2.1 (AC-2.1, AC-2.2, AC-2.5) and TC-2.3 (AC-2.4): the
real adapter behind the unchanged Epic 02 seam. A seeded thread drains all
seven kinds to ready with the fake host's canned content; the same seeding
drained under deterministic inference callbacks proves the handlers unchanged
(equivalence, AC-2.1). The canned text for the tool lanes deliberately
claims the wrong outcome — the stamped outcome must come from the record,
never model prose (architecture risk: adapter parses model output).
Empty or whitespace-only success text is a failure, never a ready form.
"""

from __future__ import annotations

import re

import pytest

from lhc import Derivation, Lhc, create_deterministic_inference_callbacks, init_lhc
from lhc.shared_tech.inference_types import ModelCall, ModelCallInput
from lhc.threads import NewThreadInput
from fixtures import (
    DERIVATION_TYPES,
    INFERENCE_DERIVATION_TYPES,
    DerivationType,
    TempStore,
    canned_responses,
    read_derived_forms,
    recording_call,
    scripted_call,
    temp_store,
    valid_assignments,
    valid_event,
)

_stores: list[TempStore] = []


@pytest.fixture(autouse=True)
def _cleanup_stores():
    yield
    while _stores:
        _stores.pop().cleanup()


def _fresh_store() -> TempStore:
    store = temp_store()
    _stores.append(store)
    return store


# Tiny target: each placed turn crosses it, so turn 1's chunk closes during
# the drain and the two chunk-summary kinds run too.
_CHUNK_POLICY = {"targetProjectedTokens": 5, "maxProjectedTokens": 4400}

_MARKER_PATTERN = re.compile(r"^(smoothed|toolcall|toolresult|rendering|projection|detailed|brief)\(")


# The adversarial canned set: the tool lanes' text claims failure while the
# record's tool result carries isError: false. A stored outcome agreeing
# with this prose would prove the adapter (or a handler) parsed model output
# for mechanical facts.
def _adversarial_responses() -> dict[DerivationType, str]:
    responses = dict(canned_responses())
    responses["tool_result_summary"] = "error: the tool produced nothing and the run failed"
    return responses


# Turn 1 carries a clean tool run (smoothing, both tool summaries, rendering,
# compression); turn 2 exists so turn 1's chunk closes under the tiny target
# policy and both chunk summaries enqueue.
async def _seed_seven_kinds(sdk: Lhc, store: TempStore) -> str:
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(NewThreadInput(file_path=file_path, registry_path=store.registry_path))
    assert created.ok is True
    result = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "please inspect the fixture file"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-adapter-1",
                        "toolName": "read_file",
                        "arguments": {"path": "fixture.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "call-adapter-1",
                        "content": "contents of fixture.txt " * 1500,
                        "isError": False,
                    }
                },
            ),
            valid_event("assistant_text", {"payload": {"text": "the fixture file holds fixture text"}}),
            valid_event("turn_end"),
            valid_event("user_prompt", {"payload": {"text": "thanks, now summarize it"}}),
            valid_event("assistant_text", {"payload": {"text": "summarized"}}),
            valid_event("turn_end"),
        ],
    )
    assert result.ok is True
    return file_path


async def _drain_all(sdk: Lhc, file_path: str) -> list[Derivation]:
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok is True
    if drained.ok:
        assert drained.value.stopped_because == "empty"
        assert drained.value.remaining == 0
    return read_derived_forms(file_path)


# One prompt, no turn_end: exactly one work item (prompt_smoothing) queues,
# so a scripted call's entries map one-to-one onto smoothing attempts.
async def _seed_smoothing_only(sdk: Lhc, store: TempStore) -> str:
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(NewThreadInput(file_path=file_path, registry_path=store.registry_path))
    assert created.ok is True
    result = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [valid_event("user_prompt", {"payload": {"text": "only a prompt to smooth"}})],
    )
    assert result.ok is True
    return file_path


def _inference_sdk(call: ModelCall) -> tuple[Lhc, dict]:
    assignments = valid_assignments()
    sdk = init_lhc(
        {
            "inference": {"call": call, "assignments": assignments},
            "mode": "manual",
            "chunkPolicy": _CHUNK_POLICY,
            "guards": {"detailedTurnCompression": {"tinyTurnTokens": 1}},
        }
    )
    return sdk, assignments


@pytest.mark.skip(
    reason="TC-2.1 exercises the real adapter end to end; Wave 5 lands the turn/chunk handlers this needs."
)
async def test_a_seeded_drain_lands_every_kind_ready_with_its_lanes_canned_content_and_assignment_provenance() -> None:
    """a seeded drain lands every kind ready with its lane's canned content and assignment provenance"""
    responses = _adversarial_responses()
    call = recording_call(responses)["call"]
    sdk, assignments = _inference_sdk(call)
    forms = await _drain_all(sdk, await _seed_seven_kinds(sdk, _fresh_store()))

    for kind in DERIVATION_TYPES:
        ready = [form for form in forms if form.derivation_type == kind and form.state == "ready"]
        assert len(ready) > 0
    for kind in INFERENCE_DERIVATION_TYPES:
        ready = [form for form in forms if form.derivation_type == kind and form.state == "ready"]
        for form in ready:
            # Content is the canned response, shaped — and provenance is the
            # assignment's three config-known strings, never authored from text.
            assert form.content == responses[kind]
            assert form.metadata is not None
            assert form.metadata.provenance == {
                "provider": assignments[kind].provider,
                "model": assignments[kind].model,
                "prompt": assignments[kind].prompt,
            }


@pytest.mark.skip(
    reason="TC-2.1 exercises the real adapter end to end; Wave 5 lands the turn/chunk handlers this needs."
)
async def test_outcomes_are_stamped_from_the_record_disagreeing_with_the_adversarial_canned_text() -> None:
    """outcomes are stamped from the record, disagreeing with the adversarial canned text"""
    responses = _adversarial_responses()
    call = recording_call(responses)["call"]
    sdk, _assignments = _inference_sdk(call)
    forms = await _drain_all(sdk, await _seed_seven_kinds(sdk, _fresh_store()))

    # The record's tool result has isError: false, so the tool-result summary
    # must stamp "succeeded" even though its landed content claims failure.
    form = next(
        (row for row in forms if row.derivation_type == "tool_result_summary" and row.state == "ready"), None
    )
    assert form is not None
    assert form.metadata is not None
    assert form.metadata.outcome == "succeeded"
    assert form.content is not None
    assert "failed" in form.content
    rendering = next(
        (
            row
            for row in forms
            if row.subject_id == "t1" and row.derivation_type == "turn_rendering" and row.state == "ready"
        ),
        None,
    )
    assert rendering is not None
    assert rendering.content is not None
    assert "⇒ succeeded" in rendering.content


@pytest.mark.skip(
    reason="TC-2.1 exercises the real adapter end to end; Wave 5 lands the turn/chunk handlers this needs."
)
async def test_handler_equivalence_deterministic_inference_callbacks_land_the_same_rows() -> None:
    """handler equivalence: deterministic inference callbacks land the same rows with marker content and no provenance"""
    call = recording_call(_adversarial_responses())["call"]
    adapter_sdk, _assignments = _inference_sdk(call)
    adapter_forms = await _drain_all(adapter_sdk, await _seed_seven_kinds(adapter_sdk, _fresh_store()))

    deterministic_sdk = init_lhc(
        {
            "inferenceCallbacks": create_deterministic_inference_callbacks(),
            "mode": "manual",
            "chunkPolicy": _CHUNK_POLICY,
            "guards": {"detailedTurnCompression": {"tinyTurnTokens": 1}},
        }
    )
    deterministic_forms = await _drain_all(
        deterministic_sdk, await _seed_seven_kinds(deterministic_sdk, _fresh_store())
    )

    # Same handler code, same record: the same form rows, subjects, and
    # states land through both inference paths (message/turn/chunk ids are
    # deterministic functions of the event order).
    def row_key(derivation: Derivation) -> str:
        return f"{derivation.subject_kind}|{derivation.subject_id}|{derivation.derivation_type}|{derivation.state}"

    # Anti-vacuous guard: [] == [] would green a no-op implementation.
    assert len(deterministic_forms) > 0
    assert sorted(row_key(f) for f in deterministic_forms) == sorted(row_key(f) for f in adapter_forms)

    for form in deterministic_forms:
        assert form.state == "ready"
        if form.derivation_type in INFERENCE_DERIVATION_TYPES:
            assert form.content is not None
            assert _MARKER_PATTERN.match(form.content)
        # Deterministic inference callbacks never set provenance (AC-2.5).
        assert form.metadata is None or form.metadata.provenance is None
    for form in adapter_forms:
        assert form.content is None or not _MARKER_PATTERN.match(form.content)


async def test_a_whitespace_only_success_fails_on_the_first_attempt_as_empty_output() -> None:
    """a whitespace-only success fails on the first attempt as empty_output"""
    calls = 0
    script = scripted_call([{"ok": True, "text": "  "}])
    log: list[ModelCallInput] = []

    async def call(input: ModelCallInput):
        nonlocal calls
        calls += 1
        log.append(dict(input))
        return await script(input)

    sdk, _assignments = _inference_sdk(call)
    file_path = await _seed_smoothing_only(sdk, _fresh_store())
    forms = await _drain_all(sdk, file_path)

    smoothed = next((form for form in forms if form.derivation_type == "smoothed_prompt"), None)
    assert smoothed is not None
    assert smoothed.state == "failed"
    assert smoothed.reason is not None
    assert "empty_output" in smoothed.reason
    assert calls == 1

    derivation_log = await sdk.logging.query_derivation_log(
        {"filePath": file_path},
        {"subjectId": "m1", "derivationType": "smoothed_prompt"},
    )
    assert derivation_log.ok is True
    if not derivation_log.ok:
        return
    failed = next((entry for entry in derivation_log.value if entry.event_kind == "inference_failed"), None)
    assert failed is not None
    assert failed.event_kind == "inference_failed"
    assert "empty_output" in failed.payload["reason"]
    assert failed.payload["requestMessages"] == log[0]["messages"]


async def test_success_text_is_shaped_surrounding_whitespace_never_reaches_the_form_content() -> None:
    """success text is shaped: surrounding whitespace never reaches the form content"""
    sdk, _assignments = _inference_sdk(scripted_call([{"ok": True, "text": "\n  shaped result text  \n"}]))
    forms = await _drain_all(sdk, await _seed_smoothing_only(sdk, _fresh_store()))

    smoothed = next((form for form in forms if form.derivation_type == "smoothed_prompt"), None)
    assert smoothed is not None
    assert smoothed.state == "ready"
    assert smoothed.content == "shaped result text"
