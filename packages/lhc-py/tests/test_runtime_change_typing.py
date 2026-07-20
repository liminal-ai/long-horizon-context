"""Ported from packages/lhc/test/runtime-change-typing.test.ts. Phase 1.

Story 5: runtime-change typing
"""

from __future__ import annotations

import pytest

from lhc import InferenceCallbacks, Lhc, MessageEventInput, init_lhc, messages, threads
from lhc.messages import Block
from lhc.shared_tech.derivation import LeaseConfig, SdkConfig
from lhc.shared_tech.inference_types import DerivationGuards, DetailedTurnCompressionGuards
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
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
        raise RuntimeError(created.error.reason)
    return created.value.file_path


def _sdk_for(inference_callbacks: InferenceCallbacks) -> Lhc:
    return init_lhc(
        SdkConfig(
            inference_callbacks=inference_callbacks,
            mode="manual",
            lease=LeaseConfig(duration_ms=200),
            guards=DerivationGuards(
                detailed_turn_compression=DetailedTurnCompressionGuards(tiny_turn_tokens=1)
            ),
        )
    )


async def _send(file_path: str, batch: list[MessageEventInput]) -> None:
    sdk = _sdk_for(create_inference_callbacks_double())
    result = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(result.error.reason)


async def test_projects_model_changes_as_typed_model_change_blocks(store: TempStore) -> None:
    """projects model changes as typed model_change blocks"""
    file_path = await _new_thread(store)

    await _send(
        file_path,
        [
            valid_event(
                "model_change",
                {"payload": {"previousModel": "gpt-5", "newModel": "gpt-5.1"}},
            ),
        ],
    )

    listed = await messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    assert len(listed.value) == 1
    assert listed.value[0].kind == "model_change"
    assert listed.value[0].blocks == [
        Block(
            block_type="model_change",
            content={"previousModel": "gpt-5", "newModel": "gpt-5.1"},
        )
    ]


async def test_projects_thinking_level_changes_as_typed_thinking_level_change_blocks(
    store: TempStore,
) -> None:
    """projects thinking-level changes as typed thinking_level_change blocks"""
    file_path = await _new_thread(store)

    await _send(
        file_path,
        [
            valid_event(
                "thinking_level_change",
                {"payload": {"previousLevel": "medium", "newLevel": "high"}},
            ),
        ],
    )

    listed = await messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    assert len(listed.value) == 1
    assert listed.value[0].kind == "thinking_level_change"
    assert listed.value[0].blocks == [
        Block(
            block_type="thinking_level_change",
            content={"previousLevel": "medium", "newLevel": "high"},
        )
    ]


async def test_places_typed_runtime_change_blocks_verbatim_in_constructed_turns_in_stream_order(
    store: TempStore,
) -> None:
    """places typed runtime-change blocks verbatim in constructed turns in stream order"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)
    model_block = {"previousModel": "gpt-5", "newModel": "gpt-5.1"}
    thinking_block = {"previousLevel": "medium", "newLevel": "high"}

    intake = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "runtime order"}}),
            valid_event("model_change", {"payload": model_block}),
            valid_event("thinking_level_change", {"payload": thinking_block}),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    assert intake.ok is True
    if not intake.ok:
        return

    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok is True
    if not drained.ok:
        return

    # turn_rendering keeps full texture in stream order; compression reads
    # the dialog-register pre_detailed_assembly instead.
    rendering = next(
        (
            form.content
            for form in read_derived_forms(file_path)
            if form.subject_id == "t1" and form.derivation_type == "turn_rendering"
        ),
        None,
    )
    segments = (rendering or "").split("\n\n")
    assert len(segments) == 4
    assert f"model_change {model_block['previousModel']} -> {model_block['newModel']}" in segments[1]
    assert (
        f"thinking_level_change {thinking_block['previousLevel']} -> {thinking_block['newLevel']}"
        in segments[2]
    )
    assert "answer" in segments[3]

    compression = next((entry for entry in captured if entry.op == "compressDetailedTurn"), None)
    assembly_text = ""
    if compression is not None and isinstance(compression.input, dict):
        assembly_text = str(compression.input.get("dialogueText") or "")
    assert "User:" in assembly_text
    assert "⏺ " in assembly_text
    assert "model_change" not in assembly_text
