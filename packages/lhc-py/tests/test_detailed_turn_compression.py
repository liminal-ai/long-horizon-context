"""Ported from packages/lhc/test/detailed-turn-compression.test.ts. Phase 1.

Story 3: detailed turn compression.
"""

from __future__ import annotations

import copy
import math
from collections.abc import Sequence
from typing import Literal, TypedDict

import pytest

from lhc import BatchResult, InferenceCallbacks, Lhc, MessageEventInput, init_lhc, threads
from lhc.shared_tech.scheduler import DrainOpts
from lhc.shared_tech.derivation import (
    CompressDetailedTurnInput,
    InferenceOk,
    LeaseConfig,
    SdkConfig,
)
from lhc.shared_tech.inference_types import (
    DerivationGuards,
    DetailedTurnCompressionGuards,
    InferenceConfig,
    ModelCall,
    ModelCallInput,
    ModelCallOk,
    ModelCallResult,
)
from lhc.shared_tech.logging import DerivationLogQuery, LogQuery
from lhc.shared_tech.token_counting import estimate_tokens
from lhc.threads import NewThreadInput
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
    open_raw,
    read_chunks,
    read_derived_forms,
    temp_store,
    valid_event,
)


class _CapturedCompress(TypedDict):
    op: Literal["compressDetailedTurn"]
    input: CompressDetailedTurnInput


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


def _token_text(min_tokens: int) -> str:
    text = ""
    while estimate_tokens(text) < min_tokens:
        text += "compressionword "
    return text.strip()


async def _new_thread(store: TempStore) -> str:
    created = await threads.new_thread(
        NewThreadInput(file_path=store.thread_path(), registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(f"thread creation failed: {created.error.reason}")
    return created.value.file_path


def _sdk_for(
    inference_callbacks: InferenceCallbacks,
    *,
    guards: DerivationGuards | None = None,
) -> Lhc:
    return init_lhc(
        SdkConfig(
            inference_callbacks=inference_callbacks,
            mode="manual",
            lease=LeaseConfig(duration_ms=200),
            guards=guards,
        )
    )


async def _send(sdk: Lhc, file_path: str, batch: Sequence[MessageEventInput]) -> BatchResult:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(f"batch failed: {result.error.reason}")
    return result.value


async def _send_turn(sdk: Lhc, file_path: str, prompt: str, answer: str) -> None:
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": prompt}}),
            valid_event("assistant_text", {"payload": {"text": answer}}),
            valid_event("turn_end"),
        ],
    )


async def _drain(sdk: Lhc, file_path: str, opts: DrainOpts | None = None):
    result = await sdk.work.drain({"filePath": file_path}, opts)
    if not result.ok:
        raise RuntimeError(result.error.reason)
    return result.value


def _js_round(value: float) -> int:
    """JS Math.round for non-negative values: floor(x + 0.5)."""
    return math.floor(value + 0.5)


def _form_of(file_path: str, subject_id: str, derivation_type: str):
    return next(
        (
            f
            for f in read_derived_forms(file_path)
            if f.subject_id == subject_id and f.derivation_type == derivation_type
        ),
        None,
    )


def _recording_model_call(text: str) -> tuple[ModelCall, list[ModelCallInput]]:
    log: list[ModelCallInput] = []

    async def call(input: ModelCallInput) -> ModelCallResult:
        log.append(copy.deepcopy(input))
        return ModelCallOk(text=text)

    return call, log


async def test_stores_tiny_turns_as_detailed_turn_compression_without_calling_compression_inference(
    store: TempStore,
) -> None:
    """stores tiny turns as detailed_turn_compression without calling compression inference"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _sdk_for(
        double,
        guards=DerivationGuards(
            detailed_turn_compression=DetailedTurnCompressionGuards(tiny_turn_tokens=1000)
        ),
    )
    file_path = await _new_thread(store)

    await _send_turn(sdk, file_path, "tiny turn", "short answer")
    await _drain(sdk, file_path)

    assembly = _form_of(file_path, "t1", "pre_detailed_assembly")
    compression = _form_of(file_path, "t1", "detailed_turn_compression")
    assert [entry for entry in captured if entry.op == "compressDetailedTurn"] == []
    assert assembly is not None
    assert assembly.state == "ready"
    assert compression is not None
    assert compression.state == "ready"
    assert compression.content == assembly.content
    assert compression.metadata is None or compression.metadata.size_disposition is None


async def test_composes_pre_detailed_assembly_from_dialog_only_in_user_assistant_sections(
    store: TempStore,
) -> None:
    """composes pre_detailed_assembly from dialog only in User/Assistant sections"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(
        double,
        guards=DerivationGuards(
            detailed_turn_compression=DetailedTurnCompressionGuards(tiny_turn_tokens=1000)
        ),
    )
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "read runtime state"}}),
            valid_event("assistant_thinking", {"payload": {"text": "planning the read"}}),
            valid_event("assistant_text", {"payload": {"text": "I will inspect it"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-1",
                        "toolName": "read_file",
                        "arguments": {"path": "state.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "call-1", "content": "state is ready", "isError": False}},
            ),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path)

    assembly_form = _form_of(file_path, "t1", "pre_detailed_assembly")
    assembly = assembly_form.content if assembly_form is not None and assembly_form.content is not None else ""
    assert "User:\n" in assembly
    assert "read runtime state" in assembly
    assert "⏺ I will inspect it" in assembly
    assert "planning the read" not in assembly
    assert "read_file" not in assembly
    assert "state is ready" not in assembly
    assert "[1]" not in assembly


async def test_item_1_writes_deterministic_derivations_and_enqueues_detailed_turn_compression(
    store: TempStore,
) -> None:
    """item 1 writes deterministic derivations and enqueues detailed_turn_compression"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(
        double,
        guards=DerivationGuards(
            detailed_turn_compression=DetailedTurnCompressionGuards(tiny_turn_tokens=1)
        ),
    )
    file_path = await _new_thread(store)

    await _send_turn(sdk, file_path, "two item flow", _token_text(120))
    partial = await _drain(sdk, file_path, {"maxItems": 2})
    assert any(
        entry.work_item_id == "w-t1-turn_derivation-v1" and entry.disposition == "done"
        for entry in partial.ran
    )

    rendering = _form_of(file_path, "t1", "turn_rendering")
    assert rendering is not None
    assert rendering.state == "ready"
    assembly = _form_of(file_path, "t1", "pre_detailed_assembly")
    assert assembly is not None
    assert assembly.state == "ready"
    compression = _form_of(file_path, "t1", "detailed_turn_compression")
    assert compression is not None
    assert compression.state == "pending"

    db = open_raw(file_path)
    try:
        queued = db.prepare(
            "SELECT kind, status FROM work_item WHERE work_item_id = 'w-t1-detailed_turn_compression-v1'"
        ).get()
        assert queued is not None
        assert queued["kind"] == "detailed_turn_compression"
        assert queued["status"] == "queued"
    finally:
        db.close()

    await _drain(sdk, file_path, {"maxItems": 1})
    ready = _form_of(file_path, "t1", "detailed_turn_compression")
    assert ready is not None
    assert ready.state == "ready"


async def test_renders_structured_turn_text_with_message_kind_markers_in_record_order(
    store: TempStore,
) -> None:
    """renders structured turn text with message-kind markers in record order"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(
        double,
        guards=DerivationGuards(
            detailed_turn_compression=DetailedTurnCompressionGuards(tiny_turn_tokens=1000)
        ),
    )
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "read runtime state"}}),
            valid_event("assistant_text", {"payload": {"text": "I will inspect it"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-1",
                        "toolName": "read_file",
                        "arguments": {"path": "state.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "call-1", "content": "state is ready", "isError": False}},
            ),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path)

    rendering_form = _form_of(file_path, "t1", "turn_rendering")
    rendering = (
        rendering_form.content
        if rendering_form is not None and rendering_form.content is not None
        else ""
    )
    assert rendering.index("User prompt\n") < rendering.index("Assistant response\n")
    assert rendering.index("Assistant response\n") < rendering.index(
        "Tool call [outcome: succeeded]\n"
    )
    assert "read_file" in rendering
    assert "state is ready" in rendering


async def test_passes_concrete_target_tokens_to_compression_and_records_size_disposition(
    store: TempStore,
) -> None:
    """passes concrete target tokens to compression and records size disposition"""
    double = create_inference_callbacks_double()
    captured: list[_CapturedCompress] = []
    output = _token_text(90)

    class _Callbacks:
        async def smooth_prompt(self, input):
            return await double.smooth_prompt(input)

        async def summarize_tool_result(self, input):
            return await double.summarize_tool_result(input)

        async def compress_detailed_turn(self, input):
            captured.append({"op": "compressDetailedTurn", "input": copy.deepcopy(input)})
            return InferenceOk(text=output)

        async def summarize_chunk_brief(self, input):
            return await double.summarize_chunk_brief(input)

    sdk = _sdk_for(_Callbacks())  # type: ignore[arg-type]
    file_path = await _new_thread(store)

    await _send_turn(sdk, file_path, "target ratios", _token_text(300))
    await _drain(sdk, file_path)

    call_entry = next((entry for entry in captured if entry["op"] == "compressDetailedTurn"), None)
    call = call_entry["input"] if call_entry is not None else None
    assert call is not None
    assert "User:\n" in call["dialogueText"]
    assert "target ratios" in call["dialogueText"]
    assert "⏺ " in call["dialogueText"]
    assert "[1] User prompt" not in call["dialogueText"]
    assert call["inputTokens"] == estimate_tokens(call["dialogueText"])
    assert call["targetMinTokens"] == max(1, _js_round(call["inputTokens"] * 0.35))
    assert call["targetAimTokens"] == max(1, _js_round(call["inputTokens"] * 0.5))
    assert call["targetMaxTokens"] == max(1, _js_round(call["inputTokens"] * 0.65))
    compression = _form_of(file_path, "t1", "detailed_turn_compression")
    assert compression is not None
    assert compression.state == "ready"
    assert compression.content == output
    # TS toMatchObject — named fields only; extras allowed
    assert compression.metadata is not None
    assert compression.metadata.size_disposition == "under_min"


async def test_uses_the_tuned_prompt_as_the_default_for_model_call_hosts(store: TempStore) -> None:
    """uses the tuned prompt as the default for model-call hosts"""
    call, host_log = _recording_model_call(_token_text(120))
    sdk = init_lhc(
        SdkConfig(
            mode="manual",
            inference=InferenceConfig(call=call),
            guards=DerivationGuards(
                detailed_turn_compression=DetailedTurnCompressionGuards(tiny_turn_tokens=1)
            ),
            lease=LeaseConfig(duration_ms=200),
        )
    )
    file_path = await _new_thread(store)

    await _send_turn(sdk, file_path, "target ratios", "assistant answer with enough content")
    await _drain(sdk, file_path)

    compression = _form_of(file_path, "t1", "detailed_turn_compression")
    assert compression is not None
    assert compression.state == "ready"
    # expect.objectContaining on metadata.provenance.prompt — named keys, allow extras.
    assert compression.metadata is not None
    assert compression.metadata.provenance is not None
    assert compression.metadata.provenance.prompt == "detailed-turn-compression-v3"
    rendered = host_log[-1] if host_log else None
    prompt_text = (
        "\n".join(message["content"] for message in rendered.messages) if rendered is not None else ""
    )
    assert "<instructions-for-summarizing>" in prompt_text
    assert "<content-for-summarizing>" in prompt_text
    assert "targetting approximately 20%-30%" in prompt_text

    derivation_log = await sdk.logging.query_derivation_log(
        {"filePath": file_path},
        DerivationLogQuery(subject_id="t1", derivation_type="detailed_turn_compression"),
    )
    assert derivation_log.ok is True
    if not derivation_log.ok:
        return
    succeeded = next(
        (entry for entry in derivation_log.value if entry.event_kind == "inference_succeeded"),
        None,
    )
    # expect.objectContaining — named keys, allow extras on the log entry.
    assert succeeded is not None
    assert succeeded.event_kind == "inference_succeeded"
    payload = succeeded.payload
    assert isinstance(payload, dict)
    provenance = payload.get("provenance")
    assert isinstance(provenance, dict)
    assert isinstance(provenance.get("provider"), str)
    assert isinstance(provenance.get("model"), str)
    assert provenance.get("prompt") == "detailed-turn-compression-v3"
    assert payload.get("requestMessages") == (rendered.messages if rendered is not None else None)
    assert payload.get("rawResponse") == _token_text(120)


async def test_compression_failure_logs_requestmessages_on_inference_failed(store: TempStore) -> None:
    """compression failure logs requestMessages on inference_failed"""
    log: list[ModelCallInput] = []

    async def call(input: ModelCallInput) -> ModelCallResult:
        log.append(copy.deepcopy(input))
        return ModelCallOk(text="   ")

    sdk = init_lhc(
        SdkConfig(
            mode="manual",
            inference=InferenceConfig(call=call),
            guards=DerivationGuards(
                detailed_turn_compression=DetailedTurnCompressionGuards(tiny_turn_tokens=1)
            ),
            lease=LeaseConfig(duration_ms=200),
        )
    )
    file_path = await _new_thread(store)

    await _send_turn(sdk, file_path, "observable failure", _token_text(120))
    await _drain(sdk, file_path)

    derivation_log = await sdk.logging.query_derivation_log(
        {"filePath": file_path},
        DerivationLogQuery(subject_id="t1", derivation_type="detailed_turn_compression"),
    )
    assert derivation_log.ok is True
    if not derivation_log.ok:
        return
    failed = next(
        (entry for entry in derivation_log.value if entry.event_kind == "inference_failed"),
        None,
    )
    compression_call = log[-1] if log else None
    assert failed is not None
    assert failed.event_kind == "inference_failed"
    payload = failed.payload
    assert isinstance(payload, dict)
    assert (
        payload.get("reason")
        == "provider_failure: empty_output: model returned empty or whitespace-only text"
    )
    assert payload.get("requestMessages") == (
        compression_call.messages if compression_call is not None else None
    )


async def test_the_first_compression_failure_lands_ready_with_the_pre_detailed_assembly_fallback(
    store: TempStore,
) -> None:
    """the first compression failure lands ready with the pre_detailed_assembly fallback"""
    double = create_inference_callbacks_double()
    double.fail_kind(
        "detailed_turn_compression",
        99,
        {"reason": "provider_failure: empty_output: model returned empty or whitespace-only text"},
    )
    sdk = _sdk_for(
        double,
        guards=DerivationGuards(
            detailed_turn_compression=DetailedTurnCompressionGuards(tiny_turn_tokens=1)
        ),
    )
    file_path = await _new_thread(store)

    await _send_turn(sdk, file_path, "fallback compression", _token_text(120))
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok is True
    if not drained.ok:
        return
    assert any(
        entry.work_item_id == "w-t1-detailed_turn_compression-v1" and entry.disposition == "done"
        for entry in drained.value.ran
    )

    assembly = _form_of(file_path, "t1", "pre_detailed_assembly")
    compression = _form_of(file_path, "t1", "detailed_turn_compression")
    rendering = _form_of(file_path, "t1", "turn_rendering")
    assert rendering is not None
    assert rendering.state == "ready"
    assert assembly is not None
    assert assembly.state == "ready"
    assert compression is not None
    assert compression.state == "ready"
    assert compression.content == assembly.content
    # TS toMatchObject — named fields only; extras allowed
    assert compression.metadata is not None
    assert compression.metadata.fallback_floor == "pre_detailed_assembly"
    assert compression.metadata.fallback_used is True
    assert compression.metadata.inference_attempted is True
    assert compression.metadata.inference_succeeded is False
    assert (
        compression.metadata.last_error
        == "provider_failure: empty_output: model returned empty or whitespace-only text"
    )

    derivation_log = await sdk.logging.query_derivation_log(
        {"filePath": file_path},
        DerivationLogQuery(subject_id="t1", derivation_type="detailed_turn_compression"),
    )
    assert derivation_log.ok is True
    if not derivation_log.ok:
        return
    event_kinds = [entry.event_kind for entry in derivation_log.value]
    assert "inference_failed" in event_kinds
    assert "fallback_applied" in event_kinds
    failed_events = [entry for entry in derivation_log.value if entry.event_kind == "inference_failed"]
    fallback_event = next(
        (entry for entry in derivation_log.value if entry.event_kind == "fallback_applied"),
        None,
    )
    assert len(failed_events) == 1
    assert "empty_output" in str(failed_events[-1].payload.get("reason", ""))
    assert fallback_event is not None
    assert isinstance(fallback_event.payload, dict)
    assert fallback_event.payload.get("fallbackFloor") == "pre_detailed_assembly"
    assert "empty_output" in str(fallback_event.payload.get("reason", ""))

    chunks = read_chunks(file_path)
    assert any(member["turnId"] == "t1" for member in chunks["members"])

    logs = await sdk.logging.query(
        {"filePath": file_path},
        LogQuery(
            derivation_type="detailed_turn_compression",
            subject_id="t1",
            level="warning",
        ),
    )
    assert logs.ok is True
    if not logs.ok:
        return
    # toEqual([objectContaining(...)]) — exact length 1, named keys, allow extras.
    assert len(logs.value) == 1
    assert logs.value[0].message == "turn compression fallback used"
    assert (
        logs.value[0].reason
        == "provider_failure: empty_output: model returned empty or whitespace-only text"
    )
    assert logs.value[0].floor_used == "pre_detailed_assembly"
