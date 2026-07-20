"""Ported from packages/lhc/test/idempotency.test.ts. Phase 1.

Flow 5: idempotent resend (TC-5.1 through TC-5.5, asserted at the event
level — the no-message / no-transition / no-work-item clauses re-assert in
Stories 3-5 as those records exist).
"""

from __future__ import annotations

import json

import pytest

from lhc import EventRecord, intake_stream, threads
from lhc.intake_stream import BatchEventOutcome
from lhc.threads import NewThreadInput
from fixtures import TempStore, conversation_turn, event_batch, open_raw, temp_store, valid_event


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


async def _create_thread(store: TempStore) -> str:
    file_path = store.thread_path()
    created = await threads.new_thread(NewThreadInput(file_path=file_path, registry_path=store.registry_path))
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")
    return file_path


async def _read_back(file_path: str) -> list[EventRecord]:
    result = await intake_stream.list_events({"filePath": file_path})
    if not result.ok:
        raise RuntimeError(f"read-back failed: {result.error.reason}")
    return result.value


# Serializes every row of every table for below-SDK absence assertions.
def _raw_dump(file_path: str) -> str:
    db = open_raw(file_path)
    try:
        tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        dump = ""
        for table in tables:
            dump += json.dumps(db.prepare(f'SELECT * FROM "{table["name"]}"').all(), separators=(",", ":"))
        return dump
    finally:
        db.close()


async def test_tc_5_1_resending_a_fully_recorded_batch_skips_everything_and_changes_nothing(store: TempStore) -> None:
    """TC-5.1: resending a fully recorded batch skips everything and changes nothing"""
    file_path = await _create_thread(store)
    batch = conversation_turn()
    first = await intake_stream.message_events({"filePath": file_path}, batch)
    assert first.ok is True
    if not first.ok:
        return
    assert all(entry.outcome == "recorded" for entry in first.value.events)
    assert first.value.thread_position.last_event_order == 5
    baseline = await _read_back(file_path)

    resend = await intake_stream.message_events({"filePath": file_path}, batch)
    assert resend.ok is True
    if not resend.ok:
        return
    assert len(resend.value.events) == 5
    for index, entry in enumerate(resend.value.events):
        assert entry.outcome == "skipped"
        assert entry.skip_reason == "duplicate_idempotency_key"
        assert entry.idempotency_key == batch[index]["idempotencyKey"]
    assert resend.value.thread_position.last_event_order == 5

    assert await _read_back(file_path) == baseline


async def test_tc_5_2_partial_resend_skips_the_old_records_the_new_and_keeps_the_order_dense(store: TempStore) -> None:
    """TC-5.2: partial resend skips the old, records the new, and keeps the order dense"""
    file_path = await _create_thread(store)
    old = event_batch(["user_prompt", "assistant_text", "tool_call"])
    first = await intake_stream.message_events({"filePath": file_path}, old)
    assert first.ok is True

    fresh = [valid_event("tool_result"), valid_event("turn_end")]
    resend = await intake_stream.message_events({"filePath": file_path}, [*old, *fresh])
    assert resend.ok is True
    if not resend.ok:
        return
    assert [entry.outcome for entry in resend.value.events] == [
        "skipped",
        "skipped",
        "skipped",
        "recorded",
        "recorded",
    ]
    assert resend.value.thread_position.last_event_order == 5

    events = await _read_back(file_path)
    assert [event["eventOrder"] for event in events] == [1, 2, 3, 4, 5]
    assert events[3]["idempotencyKey"] == fresh[0]["idempotencyKey"]
    assert events[4]["idempotencyKey"] == fresh[1]["idempotencyKey"]


async def test_tc_5_3_idempotency_keys_are_scoped_to_the_thread_same_key_records_in_both_threads(store: TempStore) -> None:
    """TC-5.3: idempotency keys are scoped to the thread — same key records in both threads"""
    thread_a = await _create_thread(store)
    thread_b = await _create_thread(store)
    event = valid_event("user_prompt", {"idempotencyKey": "shared-key-1"})

    in_a = await intake_stream.message_events({"filePath": thread_a}, [event])
    in_b = await intake_stream.message_events({"filePath": thread_b}, [event])
    assert in_a.ok is True
    assert in_b.ok is True
    if not in_a.ok or not in_b.ok:
        return
    assert in_a.value.events[0].outcome == "recorded"
    assert in_b.value.events[0].outcome == "recorded"

    assert [e["idempotencyKey"] for e in await _read_back(thread_a)] == ["shared-key-1"]
    assert [e["idempotencyKey"] for e in await _read_back(thread_b)] == ["shared-key-1"]


async def test_tc_5_4_skips_are_inert_no_duplicate_rows_no_order_numbers_consumed_no_transitions_reported(store: TempStore) -> None:
    """TC-5.4: skips are inert — no duplicate rows, no order numbers consumed, no transitions reported"""
    file_path = await _create_thread(store)
    batch = event_batch(["user_prompt", "turn_end"])
    first = await intake_stream.message_events({"filePath": file_path}, batch)
    assert first.ok is True

    resend = await intake_stream.message_events({"filePath": file_path}, batch)
    assert resend.ok is True
    if not resend.ok:
        return
    assert all(entry.outcome == "skipped" for entry in resend.value.events)
    assert resend.value.turn_transitions == []
    assert resend.value.queued_work == []

    # No duplicate event rows: each key appears exactly once below the SDK.
    db = open_raw(file_path)
    try:
        counts = db.prepare(
            "SELECT idempotency_key, COUNT(*) AS n FROM event GROUP BY idempotency_key"
        ).all()
        assert len(counts) == 2
        for row in counts:
            assert int(row["n"]) == 1
    finally:
        db.close()

    # Skips consumed no order numbers: the next recorded event lands at 3.
    next_result = await intake_stream.message_events({"filePath": file_path}, [valid_event("user_prompt")])
    assert next_result.ok is True
    if not next_result.ok:
        return
    assert next_result.value.thread_position.last_event_order == 3
    assert [e["eventOrder"] for e in await _read_back(file_path)] == [1, 2, 3]


async def test_tc_5_5_key_wins_over_content_original_payload_intact_resent_payload_stored_nowhere(store: TempStore) -> None:
    """TC-5.5: key wins over content — original payload intact, resent payload stored nowhere"""
    file_path = await _create_thread(store)
    original = valid_event(
        "user_prompt",
        {"idempotencyKey": "key-K", "payload": {"text": "PAYLOAD-A-ORIGINAL"}},
    )
    first = await intake_stream.message_events({"filePath": file_path}, [original])
    assert first.ok is True

    reused = valid_event(
        "user_prompt",
        {"idempotencyKey": "key-K", "payload": {"text": "PAYLOAD-B-MUST-VANISH"}},
    )
    resend = await intake_stream.message_events({"filePath": file_path}, [reused])
    assert resend.ok is True
    if not resend.ok:
        return
    assert resend.value.events[0] == BatchEventOutcome(
        idempotency_key="key-K",
        outcome="skipped",
        skip_reason="duplicate_idempotency_key",
    )

    events = await _read_back(file_path)
    assert len(events) == 1
    assert events[0]["payload"] == {"text": "PAYLOAD-A-ORIGINAL"}

    # open_raw scan: payload B appears in no table at all.
    dump = _raw_dump(file_path)
    assert "PAYLOAD-A-ORIGINAL" in dump
    assert "PAYLOAD-B-MUST-VANISH" not in dump
