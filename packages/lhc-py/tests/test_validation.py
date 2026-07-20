"""Ported from packages/lhc/test/validation.test.ts. Phase 1.

Flow 4 (SDK): batch validation and rejection
"""

from __future__ import annotations

from pathlib import Path

import pytest

from lhc import EventRecord, MessageEventInput, ThreadRef, intake_stream, threads
from fixtures import TempStore, conversation_turn, event_batch, temp_store, valid_event


@pytest.fixture
def store() -> TempStore:
    s = temp_store()
    yield s
    s.cleanup()


async def _create_thread(store: TempStore) -> str:
    file_path = store.thread_path()
    created = await threads.new_thread(
        {"filePath": file_path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")
    return file_path


async def _read_back(file_path: str) -> list[EventRecord]:
    result = await intake_stream.list_events({"filePath": file_path})
    if not result.ok:
        raise RuntimeError(f"read-back failed: {result.error.reason}")
    return result.value


async def test_tc_4_1_four_invalidity_categories_each_rejected_whole_with_a_named_reason(
    store: TempStore,
) -> None:
    """TC-4.1: four invalidity categories, each rejected whole with a named reason"""
    file_path = await _create_thread(store)

    unknown_kind = {**valid_event("user_prompt"), "eventKind": "mystery_kind"}
    without_key = {k: v for k, v in valid_event("user_prompt").items() if k != "idempotencyKey"}
    server_field = {**valid_event("user_prompt"), "eventOrder": 7}
    turn_end_with_payload = {**valid_event("turn_end"), "payload": {"text": "should not be here"}}

    cases: list[tuple[list[MessageEventInput], str]] = [
        ([unknown_kind], r"unknown event kind"),  # type: ignore[list-item]
        ([without_key], r"idempotencyKey"),  # type: ignore[list-item]
        ([server_field], r"server-generated.*eventOrder"),  # type: ignore[list-item]
        ([turn_end_with_payload], r"turn_end"),  # type: ignore[list-item]
    ]

    import re

    for batch, reason in cases:
        result = await intake_stream.message_events({"filePath": file_path}, batch)
        assert result.ok is False
        if result.ok:
            continue
        assert result.error.error_class == "caller_error"
        assert result.error.code == "invalid_event"
        assert result.error.event_index == 0
        assert re.search(reason, result.error.reason)

    assert await _read_back(file_path) == []


async def test_tc_4_2_first_failure_names_index_2_valid_earlier_events_did_not_land(
    store: TempStore,
) -> None:
    """TC-4.2: first failure names index 2; the valid earlier events did not land"""
    file_path = await _create_thread(store)
    batch = [
        valid_event("user_prompt"),
        valid_event("assistant_text"),
        valid_event("assistant_thinking", {"actor": ""}),
    ]
    result = await intake_stream.message_events({"filePath": file_path}, batch)
    assert result.ok is False
    if result.ok:
        return
    assert result.error.code == "invalid_event"
    assert result.error.event_index == 2
    assert await _read_back(file_path) == []


async def test_tc_4_3_after_rejection_thread_reads_back_logically_identical_to_baseline(
    store: TempStore,
) -> None:
    """TC-4.3: after a rejection the thread reads back logically identical to its baseline"""
    file_path = await _create_thread(store)
    recorded = await intake_stream.message_events({"filePath": file_path}, conversation_turn())
    assert recorded.ok is True
    baseline = await _read_back(file_path)
    assert len(baseline) == 5

    rejected = await intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt"),
            {**valid_event("turn_end"), "payload": {"oops": 1}},  # type: ignore[list-item]
        ],
    )
    assert rejected.ok is False
    assert await _read_back(file_path) == baseline


async def test_tc_4_4_caller_system_legs_error_classes_separate(store: TempStore) -> None:
    """TC-4.4 (caller/system legs): error classes separate; corruption leg is Story 4's"""
    file_path = await _create_thread(store)

    caller_leg = await intake_stream.message_events(
        {"filePath": file_path},
        [{**valid_event("user_prompt"), "eventKind": "bogus"}],  # type: ignore[list-item]
    )
    assert caller_leg.ok is False
    if caller_leg.ok:
        return
    assert caller_leg.error.error_class == "caller_error"
    assert caller_leg.error.code == "invalid_event"

    blocker = Path(store.dir) / "blocker-file"
    blocker.write_text("regular file standing where a directory must be")
    system_leg = await threads.new_thread(
        {
            "filePath": store.thread_path(),
            "registryPath": str(blocker / "registry.sqlite"),
        }
    )
    assert system_leg.ok is False
    if system_leg.ok:
        return
    assert system_leg.error.error_class == "system_error"
    assert system_leg.error.code == "storage_failure"
    assert caller_leg.error.error_class != system_leg.error.error_class


async def test_tc_4_5_batch_mixing_new_duplicate_and_invalid_rejected_whole(
    store: TempStore,
) -> None:
    """TC-4.5: a batch mixing new, duplicate, and invalid events is rejected whole"""
    file_path = await _create_thread(store)
    original = event_batch(["user_prompt", "assistant_text"])
    recorded = await intake_stream.message_events({"filePath": file_path}, original)
    assert recorded.ok is True
    baseline = await _read_back(file_path)
    assert len(baseline) == 2

    mixed = [
        valid_event("tool_call"),
        original[0],
        {**valid_event("turn_end"), "payload": {"bad": True}},  # type: ignore[list-item]
    ]
    rejected = await intake_stream.message_events({"filePath": file_path}, mixed)
    assert rejected.ok is False
    if rejected.ok:
        return
    assert rejected.error.code == "invalid_event"
    assert rejected.error.event_index == 2
    assert await _read_back(file_path) == baseline


async def test_strictness_unknown_fields_rejected_at_envelope_event_and_payload_levels(
    store: TempStore,
) -> None:
    """strictness supplemental: unknown fields rejected at envelope, event, and payload levels"""
    file_path = await _create_thread(store)

    envelope_probe = await intake_stream.message_events(
        {"filePath": file_path, "surprise": True},  # type: ignore[arg-type]
        [valid_event("user_prompt")],
    )
    assert envelope_probe.ok is False
    if envelope_probe.ok:
        return
    assert envelope_probe.error.code == "invalid_event"
    assert "envelope" in envelope_probe.error.reason

    event_probe = await intake_stream.message_events(
        {"filePath": file_path},
        [{**valid_event("user_prompt"), "surprise": True}],  # type: ignore[list-item]
    )
    assert event_probe.ok is False
    if event_probe.ok:
        return
    assert event_probe.error.code == "invalid_event"
    assert "event" in event_probe.error.reason
    assert "surprise" in event_probe.error.reason

    payload_probe = await intake_stream.message_events(
        {"filePath": file_path},
        [
            {
                **valid_event("user_prompt"),
                "payload": {"text": "hello", "surprise": True},
            },  # type: ignore[list-item]
        ],
    )
    assert payload_probe.ok is False
    if payload_probe.ok:
        return
    assert payload_probe.error.code == "invalid_event"
    assert "payload" in payload_probe.error.reason
    assert "surprise" in payload_probe.error.reason
    assert await _read_back(file_path) == []


async def test_strictness_empty_actor_and_empty_harness_are_rejected(store: TempStore) -> None:
    """strictness supplemental: empty actor and empty harness are rejected"""
    file_path = await _create_thread(store)

    empty_actor = await intake_stream.message_events(
        {"filePath": file_path}, [valid_event("user_prompt", {"actor": ""})]
    )
    assert empty_actor.ok is False
    if empty_actor.ok:
        return
    assert empty_actor.error.code == "invalid_event"
    assert "actor" in empty_actor.error.reason

    empty_harness = await intake_stream.message_events(
        {"filePath": file_path}, [valid_event("user_prompt", {"harness": ""})]
    )
    assert empty_harness.ok is False
    if empty_harness.ok:
        return
    assert empty_harness.error.code == "invalid_event"
    assert "harness" in empty_harness.error.reason
    assert await _read_back(file_path) == []
