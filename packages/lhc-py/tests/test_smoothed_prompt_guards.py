"""Ported from packages/lhc/test/smoothed-prompt-guards.test.ts. Phase 1."""

from __future__ import annotations

import copy

import pytest

from lhc import Lhc, count_live_items, init_lhc, messages, threads
from lhc.shared_tech.derivation import LeaseConfig, SdkConfig
from lhc.shared_tech.inference_types import (
    DerivationGuards,
    InferenceConfig,
    ModelCall,
    ModelCallInput,
    ModelCallOk,
    ModelCallResult,
    SmoothedPromptGuards,
)
from lhc.shared_tech.logging import LogQuery
from lhc.shared_tech.token_counting import estimate_tokens
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


def _token_text(min_tokens: int) -> str:
    text = ""
    while estimate_tokens(text) < min_tokens:
        text += "guardword "
    return text.strip()


def _recording_model_call(text: str) -> tuple[ModelCall, list[ModelCallInput]]:
    log: list[ModelCallInput] = []

    async def call(input: ModelCallInput) -> ModelCallResult:
        log.append(copy.deepcopy(input))
        return ModelCallOk(text=text)

    return call, log


def _sdk_with_model_call(
    model_text: str,
    *,
    guards: DerivationGuards | None = None,
) -> tuple[Lhc, list[ModelCallInput]]:
    call, log = _recording_model_call(model_text)
    return (
        init_lhc(
            SdkConfig(
                mode="manual",
                inference=InferenceConfig(call=call),
                lease=LeaseConfig(duration_ms=200),
                guards=guards,
            )
        ),
        log,
    )


async def _new_thread(store: TempStore) -> str:
    created = await threads.new_thread(
        NewThreadInput(file_path=store.thread_path(), registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(created.error.reason)
    return created.value.file_path


async def _send_prompt(sdk: Lhc, file_path: str, text: str) -> None:
    result = await sdk.intake_stream.message_events(
        {"filePath": file_path}, [valid_event("user_prompt", {"payload": {"text": text}})]
    )
    if not result.ok:
        raise RuntimeError(result.error.reason)


async def _send_closed_turn(sdk: Lhc, file_path: str, text: str) -> None:
    result = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": text}}),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    if not result.ok:
        raise RuntimeError(result.error.reason)


async def _drain(sdk: Lhc, file_path: str) -> None:
    drained = await sdk.work.drain({"filePath": file_path})
    if not drained.ok:
        raise RuntimeError(drained.error.reason)


def _derivation(file_path: str):
    return next(
        (
            row
            for row in read_derived_forms(file_path)
            if row.subject_id == "m1" and row.derivation_type == "smoothed_prompt"
        ),
        None,
    )


def _live_work_count(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        return count_live_items(db)
    finally:
        db.close()


def _delete_work_item(file_path: str, work_item_id: str) -> None:
    db = open_raw(file_path)
    try:
        db.prepare("DELETE FROM work_item WHERE work_item_id = ?").run(work_item_id)
    finally:
        db.close()


async def test_uses_the_default_700_token_cap_and_stores_the_cleaned_floor_as_ready_without_inference(
    store: TempStore,
) -> None:
    """uses the default 700-token cap and stores the cleaned floor as ready without inference"""
    prompt = _token_text(900)
    model_text = _token_text(200)
    sdk, log = _sdk_with_model_call(model_text)
    file_path = await _new_thread(store)

    await _send_prompt(sdk, file_path, prompt)
    await _drain(sdk, file_path)

    assert sdk.config.guards.smoothed_prompt.max_inference_tokens == 700
    assert len(log) == 0
    deriv = _derivation(file_path)
    assert deriv is not None
    assert deriv.state == "ready"
    assert deriv.content == sdk.messages.clean_prompt(prompt)
    assert deriv.metadata is None
    assert _live_work_count(file_path) == 0


async def test_respects_a_custom_cap_from_top_level_sdkconfig_guards(store: TempStore) -> None:
    """respects a custom cap from top-level SdkConfig.guards"""
    prompt = _token_text(600)
    sdk, log = _sdk_with_model_call(
        _token_text(200),
        guards=DerivationGuards(smoothed_prompt=SmoothedPromptGuards(max_inference_tokens=500)),
    )
    file_path = await _new_thread(store)

    await _send_prompt(sdk, file_path, prompt)
    await _drain(sdk, file_path)

    assert sdk.config.guards.smoothed_prompt.max_inference_tokens == 500
    assert len(log) == 0
    deriv = _derivation(file_path)
    assert deriv is not None
    assert deriv.state == "ready"
    assert deriv.content == sdk.messages.clean_prompt(prompt)
    assert _live_work_count(file_path) == 0


async def test_runs_inference_when_the_prompt_is_below_the_configured_cap(store: TempStore) -> None:
    """runs inference when the prompt is below the configured cap"""
    prompt = _token_text(600)
    model_text = _token_text(200)
    sdk, log = _sdk_with_model_call(
        model_text,
        guards=DerivationGuards(smoothed_prompt=SmoothedPromptGuards(max_inference_tokens=1000)),
    )
    file_path = await _new_thread(store)

    await _send_prompt(sdk, file_path, prompt)
    await _drain(sdk, file_path)

    assert len(log) == 1
    deriv = _derivation(file_path)
    assert deriv is not None
    assert deriv.state == "ready"
    assert deriv.content == model_text


async def test_discards_suspiciously_short_smoothing_output_stores_discard_metadata_and_logs_a_warning(
    store: TempStore,
) -> None:
    """discards suspiciously short smoothing output, stores discard metadata, and logs a warning"""
    prompt = _token_text(500)
    short_model_text = _token_text(50)
    assert estimate_tokens(short_model_text) < 0.15 * estimate_tokens(messages.clean_prompt(prompt))
    sdk, log = _sdk_with_model_call(short_model_text)
    file_path = await _new_thread(store)

    await _send_prompt(sdk, file_path, prompt)
    await _drain(sdk, file_path)

    assert len(log) == 1
    deriv = _derivation(file_path)
    assert deriv is not None
    assert deriv.state == "ready"
    assert deriv.content == sdk.messages.clean_prompt(prompt)
    assert deriv.metadata is not None
    assert deriv.metadata.discard_reason == "suspicious_output_ratio"
    assert _live_work_count(file_path) == 0

    logs = await sdk.logging.query(
        {"filePath": file_path},
        LogQuery(level="warning", derivation_type="smoothed_prompt", subject_id="m1"),
    )
    assert logs.ok is True
    if not logs.ok:
        return
    assert len(logs.value) == 1
    assert logs.value[0].level == "warning"
    assert logs.value[0].reason == "suspicious_output_ratio"
    assert logs.value[0].floor_used == sdk.messages.clean_prompt(prompt)


async def test_resolves_guard_defaults_for_direct_callback_hosts(store: TempStore) -> None:
    """resolves guard defaults for direct-callback hosts"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = init_lhc(
        SdkConfig(
            mode="manual",
            inference_callbacks=double,
            lease=LeaseConfig(duration_ms=200),
        )
    )
    file_path = await _new_thread(store)
    prompt = _token_text(900)

    await _send_prompt(sdk, file_path, prompt)
    await _drain(sdk, file_path)

    assert sdk.config.guards.smoothed_prompt.max_inference_tokens == 700
    assert [entry for entry in captured if entry.op == "smoothPrompt"] == []
    deriv = _derivation(file_path)
    assert deriv is not None
    assert deriv.state == "ready"
    assert deriv.content == sdk.messages.clean_prompt(prompt)


async def test_turn_construction_uses_the_guard_cap_for_pending_prompt_smoothing(
    store: TempStore,
) -> None:
    """turn construction uses the guard cap for pending prompt smoothing"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = init_lhc(
        SdkConfig(
            mode="manual",
            inference_callbacks=double,
            lease=LeaseConfig(duration_ms=200),
        )
    )
    file_path = await _new_thread(store)
    prompt = _token_text(900)

    await _send_closed_turn(sdk, file_path, prompt)
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")
    derived = await sdk.turns.derive_turn({"filePath": file_path}, "t1")

    assert derived.ok is True
    assert [entry for entry in captured if entry.op == "smoothPrompt"] == []
    deriv = _derivation(file_path)
    assert deriv is not None
    assert deriv.state == "ready"
    assert deriv.content == sdk.messages.clean_prompt(prompt)
    assert _live_work_count(file_path) == 0


async def test_turn_construction_preserves_an_already_ready_smoothed_prompt_without_calling_smoothing_inference(
    store: TempStore,
) -> None:
    """turn construction preserves an already-ready smoothed_prompt without calling smoothing inference"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = init_lhc(
        SdkConfig(
            mode="manual",
            inference_callbacks=double,
            lease=LeaseConfig(duration_ms=200),
        )
    )
    file_path = await _new_thread(store)
    prompt = _token_text(500)

    await _send_closed_turn(sdk, file_path, prompt)
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")
    db = open_raw(file_path)
    try:
        db.prepare(
            """UPDATE derivation
         SET state = 'ready', content = ?, reason = NULL, metadata = NULL, derived_at = ?
         WHERE subject_kind = 'message'
           AND subject_id = 'm1'
           AND derivation_type = 'smoothed_prompt'"""
        ).run("competing ready value", "2026-06-22T12:00:00.000Z")
    finally:
        db.close()
    calls_before_turn = len(captured)
    derived = await sdk.turns.derive_turn({"filePath": file_path}, "t1")

    assert derived.ok is True
    assert [
        entry for entry in captured[calls_before_turn:] if entry.op == "smoothPrompt"
    ] == []
    deriv = _derivation(file_path)
    assert deriv is not None
    assert deriv.state == "ready"
    assert deriv.content == "competing ready value"
    assert deriv.metadata is None
    logs = await sdk.logging.query(
        {"filePath": file_path},
        LogQuery(level="warning", derivation_type="smoothed_prompt", subject_id="m1"),
    )
    assert logs.ok is True
    if not logs.ok:
        return
    assert logs.value == []


async def test_stores_a_bracketed_marker_prompt_verbatim_without_calling_inference(
    store: TempStore,
) -> None:
    """stores a bracketed marker prompt verbatim without calling inference"""
    sdk, log = _sdk_with_model_call("should never be produced")
    file_path = await _new_thread(store)

    await _send_prompt(sdk, file_path, "[Request interrupted by user]")
    await _drain(sdk, file_path)

    assert len(log) == 0
    deriv = _derivation(file_path)
    assert deriv is not None
    assert deriv.state == "ready"
    assert deriv.content == "[Request interrupted by user]"
    assert deriv.metadata is None
    assert _live_work_count(file_path) == 0


async def test_skips_inference_for_a_marker_with_surrounding_whitespace(store: TempStore) -> None:
    """skips inference for a marker with surrounding whitespace"""
    sdk, log = _sdk_with_model_call("should never be produced")
    file_path = await _new_thread(store)

    await _send_prompt(sdk, file_path, "  [Request interrupted by user for tool use]\n")
    await _drain(sdk, file_path)

    assert len(log) == 0
    deriv = _derivation(file_path)
    assert deriv is not None
    assert deriv.state == "ready"
    assert deriv.content == "[Request interrupted by user for tool use]"


async def test_still_smooths_a_prompt_that_merely_contains_brackets(store: TempStore) -> None:
    """still smooths a prompt that merely contains brackets"""
    model_text = "please fix the flaky test in ci.yml"
    sdk, log = _sdk_with_model_call(model_text)
    file_path = await _new_thread(store)

    await _send_prompt(
        sdk,
        file_path,
        "please fix the [flaky] test in ci.yml, it keeps failing intermittently on main",
    )
    await _drain(sdk, file_path)

    assert len(log) == 1
    deriv = _derivation(file_path)
    assert deriv is not None
    assert deriv.state == "ready"
    assert deriv.content == model_text


async def test_still_smooths_when_brackets_wrap_more_than_eighty_characters(
    store: TempStore,
) -> None:
    """still smooths when brackets wrap more than eighty characters"""
    inner = "x" * 100
    model_text = "long bracketed content smoothed"
    sdk, log = _sdk_with_model_call(model_text)
    file_path = await _new_thread(store)

    await _send_prompt(sdk, file_path, f"[{inner}]")
    await _drain(sdk, file_path)

    assert len(log) == 1
    deriv = _derivation(file_path)
    assert deriv is not None
    assert deriv.state == "ready"
    assert deriv.content == model_text
