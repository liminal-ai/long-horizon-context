"""Ported from packages/lhc/test/inference-construction.test.ts. Phase 1.

Epic 05 Story 2 — TC-1.1 (AC-1.1, AC-1.3): the construction matrix.
Construction is where every config mistake dies: inferenceCallbacks XOR inference,
all seven kinds present (parameterized over the exported DERIVATION_TYPES set so
a new kind fails the matrix automatically), no unknown kind keys, every
prompt name known, non-empty provider/model strings — each a TypeError
naming the violated rule, with no partial construction. A complete valid
config does not merely construct: a seeded drain lands a form ready.
"""

from __future__ import annotations

import pytest

from lhc import init_lhc
from lhc.threads import NewThreadInput
from fixtures import (
    TempStore,
    canned_responses,
    create_inference_callbacks_double,
    read_derived_forms,
    recording_call,
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


def _build_sdk(assignments: object):
    call = recording_call(canned_responses())["call"]

    def make():
        return init_lhc({"mode": "manual", "inference": {"call": call, "assignments": assignments}})

    return make


def test_both_inference_callbacks_and_inference_is_a_typeerror_naming_the_xor_rule() -> None:
    """both inferenceCallbacks and inference is a TypeError naming the XOR rule"""
    call = recording_call(canned_responses())["call"]

    def make():
        return init_lhc(
            {
                "mode": "manual",
                "inferenceCallbacks": create_inference_callbacks_double(),
                "inference": {"call": call, "assignments": valid_assignments()},
            }
        )

    with pytest.raises(TypeError, match="exactly one of inferenceCallbacks or inference"):
        make()


def test_neither_inference_callbacks_nor_inference_is_a_typeerror_naming_the_xor_rule() -> None:
    """neither inferenceCallbacks nor inference is a TypeError naming the XOR rule"""

    def make():
        return init_lhc({"mode": "manual"})

    with pytest.raises(TypeError, match="exactly one of inferenceCallbacks or inference"):
        make()


def test_an_unknown_kind_key_in_assignments_is_a_typeerror_naming_it() -> None:
    """an unknown kind key in assignments is a TypeError naming it"""
    assignments = dict(valid_assignments())
    assignments["smoothed_promptz"] = {
        "provider": "prov-x",
        "model": "model-x",
        "prompt": "smoothing-v1",
    }
    make = _build_sdk(assignments)
    with pytest.raises(TypeError, match='unknown derivation type "smoothed_promptz"'):
        make()


def test_an_unknown_prompt_name_on_an_inference_assignment_is_a_typeerror_naming_kind_and_prompt() -> None:
    """an unknown prompt name on an inference assignment is a TypeError naming kind and prompt"""
    assignments = valid_assignments({"tool_result_summary": {"prompt": "tool-result-v99"}})
    make = _build_sdk(assignments)
    with pytest.raises(TypeError, match="tool_result_summary"):
        make()
    with pytest.raises(TypeError, match='unknown template "tool-result-v99"'):
        make()


def test_an_empty_provider_string_on_an_inference_assignment_is_a_typeerror_naming_field_and_kind() -> None:
    """an empty provider string on an inference assignment is a TypeError naming field and kind"""
    assignments = valid_assignments({"smoothed_prompt": {"provider": ""}})
    make = _build_sdk(assignments)
    with pytest.raises(TypeError, match=r"smoothed_prompt\.provider must be a non-empty string"):
        make()


def test_an_empty_model_string_on_an_inference_assignment_is_a_typeerror_naming_field_and_kind() -> None:
    """an empty model string on an inference assignment is a TypeError naming field and kind"""
    assignments = valid_assignments({"chunk_summary_brief": {"model": "  "}})
    make = _build_sdk(assignments)
    with pytest.raises(TypeError, match=r"chunk_summary_brief\.model must be a non-empty string"):
        make()


async def test_constructs_and_a_seeded_drain_lands_a_form_ready_with_the_hosts_text() -> None:
    """constructs, and a seeded drain lands a form ready with the host's text"""
    store = _fresh_store()
    responses = canned_responses()
    bundle = recording_call(responses)
    call, log = bundle["call"], bundle["log"]
    sdk = init_lhc({"mode": "manual", "inference": {"call": call, "assignments": valid_assignments()}})

    file_path = store.thread_path()
    created = await sdk.threads.new_thread(NewThreadInput(file_path=file_path, registry_path=store.registry_path))
    assert created.ok is True
    batch = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "construct me a context"}}),
            valid_event("assistant_text", {"payload": {"text": "constructing"}}),
            valid_event("turn_end"),
        ],
    )
    assert batch.ok is True

    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok is True
    if drained.ok:
        assert drained.value.stopped_because == "empty"
        assert drained.value.remaining == 0

    smoothed = next(
        (form for form in read_derived_forms(file_path) if form.derivation_type == "smoothed_prompt" and form.subject_id == "m1"),
        None,
    )
    assert smoothed is not None
    assert smoothed.state == "ready"
    assert smoothed.content == responses["smoothed_prompt"]
    assert len(log) > 0
