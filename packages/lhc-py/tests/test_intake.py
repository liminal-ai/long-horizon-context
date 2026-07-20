"""Ported from packages/lhc/test/intake.test.ts. Phase 1.

Flow 2 (recording half): TC-2.1, TC-2.8, TC-1.4, and architecture-risk tests.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from lhc import EventRecord, MessageEventInput, intake_stream, threads
from lhc.threads import NewThreadInput
from fixtures import (
    TempStore,
    conversation_turn,
    event_batch,
    open_raw,
    set_intake_clock,
    set_intake_walk_hook,
    temp_store,
    valid_event,
)


@pytest.fixture
def store():
    s = temp_store()
    yield s
    set_intake_walk_hook(None)
    set_intake_clock(None)
    s.cleanup()


async def _create_thread(store: TempStore) -> str:
    file_path = store.thread_path()
    created = await threads.new_thread(
        NewThreadInput(file_path=file_path, registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")
    return file_path


async def _read_back(file_path: str) -> list[EventRecord]:
    result = await intake_stream.list_events({"filePath": file_path})
    if not result.ok:
        raise RuntimeError(f"read-back failed: {result.error.reason}")
    return result.value


async def test_tc_2_1_two_batches_record_in_array_order_with_a_dense_continuing_event_order(
    store: TempStore,
) -> None:
    """TC-2.1: two batches record in array order with a dense, continuing event order"""
    file_path = await _create_thread(store)
    batch_one = event_batch(["user_prompt", "assistant_text", "tool_call"])
    batch_two = event_batch(["tool_result", "runtime_note", "turn_end"])

    first = await intake_stream.message_events({"filePath": file_path}, batch_one)
    assert first.ok is True
    if not first.ok:
        return
    assert [e.outcome for e in first.value.events] == ["recorded", "recorded", "recorded"]
    assert first.value.thread_position.last_event_order == 3

    second = await intake_stream.message_events({"filePath": file_path}, batch_two)
    assert second.ok is True
    if not second.ok:
        return
    assert second.value.thread_position.last_event_order == 6

    events = await _read_back(file_path)
    assert [e["eventOrder"] for e in events] == [1, 2, 3, 4, 5, 6]
    assert [e["eventKind"] for e in events] == [
        "user_prompt",
        "assistant_text",
        "tool_call",
        "tool_result",
        "runtime_note",
        "turn_end",
    ]
    assert [e["idempotencyKey"] for e in events] == [
        e["idempotencyKey"] for e in [*batch_one, *batch_two]
    ]


async def test_tc_2_8_an_empty_batch_is_a_caller_error_and_records_nothing(store: TempStore) -> None:
    """TC-2.8: an empty batch is a caller error and records nothing"""
    file_path = await _create_thread(store)
    result = await intake_stream.message_events({"filePath": file_path}, [])
    assert result.ok is False
    if result.ok:
        return
    assert result.error.error_class == "caller_error"
    assert result.error.code == "empty_batch"
    assert "empty" in result.error.reason

    assert await _read_back(file_path) == []


async def test_tc_1_4_the_same_batch_by_thread_id_and_by_file_path_produces_identical_results_and_read_back(
    store: TempStore,
) -> None:
    """TC-1.4: the same batch by thread id and by file path produces identical results and read-back (closes Story 1's deferral)"""
    recorded_at = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    set_intake_clock(lambda: recorded_at)

    path_a = store.thread_path()
    created_a = await threads.new_thread(
        NewThreadInput(file_path=path_a, registry_path=store.registry_path)
    )
    assert created_a.ok is True
    if not created_a.ok:
        return
    path_b = await _create_thread(store)

    batch = event_batch(["user_prompt", "assistant_text", "tool_call", "turn_end"])
    by_id = await intake_stream.message_events(
        {"threadId": created_a.value.thread_id, "registryPath": store.registry_path},
        batch,
    )
    by_path = await intake_stream.message_events({"filePath": path_b}, batch)
    assert by_id.ok is True
    assert by_path.ok is True
    if not by_id.ok or not by_path.ok:
        return
    assert by_id.value == by_path.value

    read_by_id = await intake_stream.list_events(
        {"threadId": created_a.value.thread_id, "registryPath": store.registry_path}
    )
    assert read_by_id.ok is True
    if not read_by_id.ok:
        return
    read_by_path = await _read_back(path_b)
    assert read_by_id.value == read_by_path

    assert [e["recordedAt"] for e in read_by_id.value] == ["2026-01-01T00:00:00.000Z"] * len(
        read_by_path
    )


async def test_architecture_risk_mid_walk_failure_rolls_the_whole_batch_back_to_baseline(
    store: TempStore,
) -> None:
    """architecture-risk: mid-walk failure rolls the whole batch back to baseline"""
    file_path = await _create_thread(store)
    baseline_batch = event_batch(["user_prompt", "assistant_text"])
    recorded = await intake_stream.message_events({"filePath": file_path}, baseline_batch)
    assert recorded.ok is True
    baseline = await _read_back(file_path)
    assert len(baseline) == 2

    def _walk_hook(db, event_index):
        if event_index == 0:
            db.close()

    set_intake_walk_hook(_walk_hook)
    result = await intake_stream.message_events(
        {"filePath": file_path}, event_batch(["tool_call", "tool_result", "turn_end"])
    )
    set_intake_walk_hook(None)
    assert result.ok is False
    if result.ok:
        return
    assert result.error.error_class == "system_error"
    assert result.error.code == "storage_failure"

    assert await _read_back(file_path) == baseline


async def test_architecture_risk_system_error_rollback_parity_storage_failure_mid_batch_leaves_no_partial_events(
    store: TempStore,
) -> None:
    """architecture-risk: system_error rollback parity — storage failure mid-batch leaves no partial events"""
    file_path = await _create_thread(store)

    def _walk_hook(db, event_index):
        if event_index == 1:
            db.close()

    set_intake_walk_hook(_walk_hook)
    result = await intake_stream.message_events({"filePath": file_path}, conversation_turn())
    set_intake_walk_hook(None)
    assert result.ok is False
    if result.ok:
        return
    assert result.error.error_class == "system_error"
    assert result.error.code == "storage_failure"

    assert await _read_back(file_path) == []
    db = open_raw(file_path)
    try:
        row = db.prepare("SELECT COUNT(*) AS n FROM event").get()
        assert int(row["n"]) == 0
    finally:
        db.close()


async def test_architecture_risk_restart_survival_reopen_sees_the_identical_record(store: TempStore) -> None:
    """architecture-risk: restart survival — reopen sees the identical record"""
    file_path = await _create_thread(store)
    batch = conversation_turn()
    recorded = await intake_stream.message_events({"filePath": file_path}, batch)
    assert recorded.ok is True

    first_read = await _read_back(file_path)
    assert len(first_read) == 5
    second_read = await _read_back(file_path)
    assert second_read == first_read

    db = open_raw(file_path)
    try:
        row = db.prepare("SELECT COUNT(*) AS n FROM event").get()
        assert int(row["n"]) == 5
    finally:
        db.close()


async def test_architecture_risk_a_rejected_batch_takes_no_lock_rejection_succeeds_while_another_connection_holds_the_write_lock(
    store: TempStore,
) -> None:
    """architecture-risk: a rejected batch takes no lock — rejection succeeds while another connection holds the write lock"""
    file_path = await _create_thread(store)
    locker = open_raw(file_path)
    try:
        locker.exec("BEGIN IMMEDIATE;")
        bogus: MessageEventInput = {**valid_event("user_prompt"), "eventKind": "bogus"}  # type: ignore[misc]
        result = await intake_stream.message_events({"filePath": file_path}, [bogus])
        assert result.ok is False
        if not result.ok:
            assert result.error.error_class == "caller_error"
            assert result.error.code == "invalid_event"
        locker.exec("ROLLBACK;")
    finally:
        locker.close()
    assert await _read_back(file_path) == []
