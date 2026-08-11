"""Ported from packages/lhc/test/inference-classification.test.ts. Phase 1.

Model-call failures preserve stable reason classes. safe_call contains
thrown host exceptions as `other` and races the adapter-owned timeout as
`timeout`, so host behavior cannot crash a drain.
"""

from __future__ import annotations

import pytest

from lhc import Derivation, DrainReport, Lhc, init_lhc
from lhc.shared_tech.classify import safe_call
from lhc.shared_tech.inference_types import ModelCall, ModelCallInput
from lhc.threads import NewThreadInput
from fixtures import (
    FAKE_MODEL_PREFIX,
    TempStore,
    canned_responses,
    hanging_call,
    read_derived_forms,
    recording_call,
    scripted_call,
    temp_store,
    throwing_call,
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


# Tiny target (the adapter-suite pattern): each placed turn crosses it, so
# turn 1's chunk closes during the multi-kind drain and the two chunk-summary
# kinds run too.
_CHUNK_POLICY = {"targetProjectedTokens": 5, "maxProjectedTokens": 4400}

_PROBE_INPUT: ModelCallInput = {
    "provider": "prov-probe",
    "model": "model-probe",
    "messages": [{"role": "user", "content": "probe"}],
}


def _inference_sdk(call: ModelCall, timeout_ms: int | None = None) -> Lhc:
    inference: dict[str, object] = {"call": call, "assignments": valid_assignments()}
    if timeout_ms is not None:
        inference["timeoutMs"] = timeout_ms
    return init_lhc(
        {
            "inference": inference,
            "mode": "manual",
            "chunkPolicy": _CHUNK_POLICY,
            "guards": {"detailedTurnCompression": {"tinyTurnTokens": 1}},
        }
    )


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


class _DrainNormallyResult:
    def __init__(self, report: DrainReport, derivations: list[Derivation]) -> None:
        self.report = report
        self.derivations = derivations


# Drains to empty and hands back both the report and the derivations.
async def _drain_normally(sdk: Lhc, file_path: str) -> _DrainNormallyResult:
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok is True
    if not drained.ok:
        raise RuntimeError("drain failed")
    assert drained.value.stopped_because == "empty"
    assert drained.value.remaining == 0
    return _DrainNormallyResult(drained.value, read_derived_forms(file_path))


def _counting_call(inner: ModelCall) -> tuple[ModelCall, list[int]]:
    calls = [0]

    async def call(input: ModelCallInput):
        calls[0] += 1
        return await inner(input)

    return call, calls


async def test_auth_fails_on_the_first_attempt_with_a_stable_kind_led_reason() -> None:
    """auth fails on the first attempt with a stable kind-led reason"""
    call, calls = _counting_call(scripted_call([{"ok": False, "kind": "auth", "message": "invalid api key"}]))
    sdk = _inference_sdk(call)
    result = await _drain_normally(sdk, await _seed_smoothing_only(sdk, _fresh_store()))

    smoothed = next((f for f in result.derivations if f.derivation_type == "smoothed_prompt"), None)
    assert smoothed is not None
    assert smoothed.state == "failed"
    assert smoothed.reason == "auth: invalid api key"
    assert calls[0] == 1
    assert len(result.report.ran) == 1
    assert result.report.ran[0].disposition == "failed_terminal"


async def test_network_fails_on_the_first_attempt_with_a_provider_failure_led_reason() -> None:
    """network fails on the first attempt with a provider_failure-led reason"""
    call, calls = _counting_call(scripted_call([{"ok": False, "kind": "network", "message": "connection reset"}]))
    sdk = _inference_sdk(call)
    result = await _drain_normally(sdk, await _seed_smoothing_only(sdk, _fresh_store()))

    smoothed = next((f for f in result.derivations if f.derivation_type == "smoothed_prompt"), None)
    assert smoothed is not None
    assert smoothed.state == "failed"
    assert (smoothed.reason or "").startswith("provider_failure")
    assert "network" in (smoothed.reason or "")
    assert calls[0] == 1
    assert result.report.ran[0].disposition == "failed_terminal"


async def test_a_hanging_host_classifies_timeout_under_the_adapter_owned_race_and_the_drain_continues() -> None:
    """a hanging host classifies `timeout` under the adapter-owned race and the drain continues"""
    hanging_lane = f"{FAKE_MODEL_PREFIX}smoothed_prompt"
    bundle = recording_call(canned_responses())
    canned = bundle["call"]
    hang = hanging_call()

    async def call(input: ModelCallInput):
        if input.model == hanging_lane:
            return await hang(input)
        return await canned(input)

    sdk = _inference_sdk(call, 50)
    store = _fresh_store()
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(NewThreadInput(file_path=file_path, registry_path=store.registry_path))
    assert created.ok is True
    seeded = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "a prompt whose smoothing hangs"}}),
            valid_event("turn_end"),
        ],
    )
    assert seeded.ok is True

    result = await _drain_normally(sdk, file_path)
    smoothed = next((f for f in result.derivations if f.derivation_type == "smoothed_prompt"), None)
    assert smoothed is not None
    assert smoothed.state == "ready"
    # The drain continued past the hanging lane: the turn's forms landed.
    rendering = next((f for f in result.derivations if f.derivation_type == "turn_rendering"), None)
    assert rendering is not None
    assert rendering.state == "ready"
    compression = next((f for f in result.derivations if f.derivation_type == "detailed_turn_compression"), None)
    assert compression is not None
    assert compression.state == "ready"


async def test_passes_a_structured_success_through_untouched() -> None:
    """passes a structured success through untouched"""
    result = await safe_call(scripted_call([{"ok": True, "text": "plain success"}]), _PROBE_INPUT, 1000)
    assert result == {"ok": True, "text": "plain success"}


async def test_passes_a_structured_failure_through_untouched() -> None:
    """passes a structured failure through untouched"""
    result = await safe_call(
        scripted_call([{"ok": False, "kind": "rate_limit", "message": "throttled"}]),
        _PROBE_INPUT,
        1000,
    )
    assert result == {"ok": False, "kind": "rate_limit", "message": "throttled"}


async def test_classifies_a_thrown_exception_as_other_carrying_the_message() -> None:
    """classifies a thrown exception as `other`, carrying the message"""
    result = await safe_call(throwing_call(Exception("kaboom")), _PROBE_INPUT, 1000)
    assert result.ok is False
    if not result.ok:
        assert result.kind == "other"
        assert "kaboom" in result.message


async def test_classifies_a_synchronously_throwing_host_as_other_the_promise_contract_is_not_trusted() -> None:
    """classifies a synchronously throwing host as `other` (the promise contract is not trusted)"""

    def sync(input: ModelCallInput):
        raise Exception("sync kaboom")

    result = await safe_call(sync, _PROBE_INPUT, 1000)
    assert result.ok is False
    if not result.ok:
        assert result.kind == "other"
        assert "sync kaboom" in result.message


async def test_classifies_a_never_settling_host_as_timeout_after_the_race() -> None:
    """classifies a never-settling host as `timeout` after the race"""
    result = await safe_call(hanging_call(), _PROBE_INPUT, 50)
    assert result.ok is False
    if not result.ok:
        assert result.kind == "timeout"
        assert "50" in result.message


async def test_actual_provider_model_on_a_success_override_assignment_provenance() -> None:
    """actualProvider/actualModel on a success override assignment provenance; prompt stays the assignment's"""
    from lhc.shared_tech.inference_types import ModelCallOk

    async def call(_input: ModelCallInput):
        return ModelCallOk(text="smoothed just fine", actual_provider="prov-actual", actual_model="model-actual")

    sdk = _inference_sdk(call)
    result = await _drain_normally(sdk, await _seed_smoothing_only(sdk, _fresh_store()))

    smoothed = next((f for f in result.derivations if f.derivation_type == "smoothed_prompt"), None)
    assert smoothed is not None
    assert smoothed.state == "ready"
    provenance = smoothed.metadata.provenance
    assert provenance.provider == "prov-actual"
    assert provenance.model == "model-actual"
    assert provenance.prompt == valid_assignments()["smoothed_prompt"].prompt


async def test_absent_actuals_keep_the_assignments_provenance_exactly_as_before() -> None:
    """absent actuals keep the assignment's provenance exactly as before"""
    from lhc.shared_tech.inference_types import ModelCallOk

    async def call(_input: ModelCallInput):
        return ModelCallOk(text="smoothed plainly")

    sdk = _inference_sdk(call)
    result = await _drain_normally(sdk, await _seed_smoothing_only(sdk, _fresh_store()))

    smoothed = next((f for f in result.derivations if f.derivation_type == "smoothed_prompt"), None)
    assert smoothed is not None
    assert smoothed.state == "ready"
    provenance = smoothed.metadata.provenance
    assert provenance.provider == valid_assignments()["smoothed_prompt"].provider
    assert provenance.model == valid_assignments()["smoothed_prompt"].model
