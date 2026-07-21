"""Ported from packages/lhc/test/inference-routing.test.ts. Phase 1.

Epic 05 Story 2 — TC-1.2 (AC-1.2, AC-1.4): per-call routing through the
inference seam. A recording fake logs every call while a seeded thread
exercises all seven kinds; the assertions inspect the actual serialized
ModelCall input emitted during the drain — never a helper-level intention
(anti-shim). The routing assertions live in the parameterized
seam-conformance helpers so TC-4.3 runs them against the real host
unchanged (DD-13).
"""

from __future__ import annotations

import pytest

from fixtures import (
    DERIVATION_TYPES,
    FAKE_MODEL_PREFIX,
    FAKE_PROVIDER_PREFIX,
    INFERENCE_DERIVATION_TYPES,
    TempStore,
    assert_model_call_contract,
    assert_routing_through_sdk,
    canned_responses,
    probe_input,
    recording_call,
    temp_store,
    valid_assignments,
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


@pytest.mark.skip(
    reason="TC-1.2 exercises per-kind routing through a full seeded drain; mirrors TS it.skip (upstream-deferred test)."
)
async def test_a_seeded_drain_exercises_all_seven_kinds_each_call_carrying_exactly_its_assigned_strings() -> None:
    """a seeded drain exercises all seven kinds, each call carrying exactly its assigned strings"""
    responses = canned_responses()
    bundle = recording_call(responses)
    call, log = bundle["call"], bundle["log"]
    assignments = valid_assignments()
    run = await assert_routing_through_sdk(call, assignments, _fresh_store())
    forms = run["derivations"]

    for kind in INFERENCE_DERIVATION_TYPES:
        lane = [input for input in log if input.model == f"{FAKE_MODEL_PREFIX}{kind}"]
        assert len(lane) > 0
        for input in lane:
            assert input.provider == f"{FAKE_PROVIDER_PREFIX}{kind}"
            assert input.model == assignments[kind].model
        # The landed content is the canned text the kind's lane returned —
        # routing proven end to end, not just at the call log.
        ready = [form for form in forms if form.derivation_type == kind and form.state == "ready"]
        assert len(ready) > 0
        for form in ready:
            assert form.content == responses[kind]
    for kind in DERIVATION_TYPES:
        assert any(form.derivation_type == kind and form.state == "ready" for form in forms)


@pytest.mark.skip(
    reason="TC-1.2 exercises per-kind routing through a full seeded drain; mirrors TS it.skip (upstream-deferred test)."
)
async def test_every_logged_messages_value_is_single_turn_shape() -> None:
    """every logged messages value is single-turn shape: system and user roles, string content (AC-1.2)"""
    bundle = recording_call(canned_responses())
    call, log = bundle["call"], bundle["log"]
    await assert_routing_through_sdk(call, valid_assignments(), _fresh_store())

    assert len(log) > 0
    for input in log:
        assert len(input.messages) > 0
        assert any(message["role"] == "user" for message in input.messages)
        for message in input.messages:
            assert message["role"] in ("system", "user")
            assert isinstance(message["content"], str)


@pytest.mark.skip(
    reason="TC-1.2 exercises per-kind routing through a full seeded drain; mirrors TS it.skip (upstream-deferred test)."
)
async def test_a_three_lane_mixed_config_routes_each_call_by_item_kind_with_no_cross_kind_bleed() -> None:
    """a three-lane mixed config routes each call by item kind with no cross-kind bleed"""
    lanes = {
        "smoothed_prompt": "lane-alpha",
        "tool_result_summary": "lane-beta",
        "detailed_turn_compression": "lane-beta",
        "chunk_summary_brief": "lane-gamma",
    }
    assignments = valid_assignments(
        {
            "smoothed_prompt": {"provider": lanes["smoothed_prompt"]},
            "tool_result_summary": {"provider": lanes["tool_result_summary"]},
            "detailed_turn_compression": {"provider": lanes["detailed_turn_compression"]},
            "chunk_summary_brief": {"provider": lanes["chunk_summary_brief"]},
        }
    )
    responses = canned_responses()
    bundle = recording_call(responses)
    call, log = bundle["call"], bundle["log"]
    run = await assert_routing_through_sdk(call, assignments, _fresh_store())
    forms = run["derivations"]

    for kind in INFERENCE_DERIVATION_TYPES:
        # Models stay unique per kind, so the lane each item actually used is
        # readable from the log: every call for this kind's model must carry
        # this kind's lane provider — no bleed from the other lanes.
        calls = [input for input in log if input.model == assignments[kind].model]
        assert len(calls) > 0
        for input in calls:
            assert input.provider == lanes[kind]
        ready = [form for form in forms if form.derivation_type == kind and form.state == "ready"]
        assert len(ready) > 0
        for form in ready:
            assert form.content == responses[kind]


async def test_assert_model_call_contract_holds_against_recording_call() -> None:
    """assertModelCallContract holds against recordingCall"""
    call = recording_call(canned_responses())["call"]
    await assert_model_call_contract(
        call,
        probe_input(
            {
                "provider": f"{FAKE_PROVIDER_PREFIX}smoothed_prompt",
                "model": f"{FAKE_MODEL_PREFIX}smoothed_prompt",
            }
        ),
    )
