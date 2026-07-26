"""Ported from packages/lhc/test/schema-v5-host-facts.test.ts.

Schema v5 slice: turn-scoped host facts (provider usage, turn outcome,
wall-clock timing). Intake accepts optional payload fields; projection
writes them; turns/messages reads expose them; empty turn_end stays valid.
"""

from __future__ import annotations

import re

import pytest

from lhc import intake_stream, messages, threads, turns
from lhc.shared_tech._jsstr import js_json_dumps
from lhc.threads import NewThreadInput
from fixtures import TempStore, open_raw, temp_store, valid_event


@pytest.fixture
def store() -> TempStore:
    s = temp_store()
    yield s
    s.cleanup()


async def _create_thread(store: TempStore) -> str:
    file_path = store.thread_path()
    created = await threads.new_thread(
        NewThreadInput(file_path=file_path, registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")
    return file_path


async def _send(file_path: str, batch: list[object]):
    result = await intake_stream.message_events({"filePath": file_path}, batch)  # type: ignore[arg-type]
    if not result.ok:
        raise RuntimeError(f"fixture batch failed: {result.error.reason}")
    return result.value


async def test_empty_turn_end_payload_is_still_valid_and_closes_the_turn_without_host_facts(
    store: TempStore,
) -> None:
    """empty turn_end payload is still valid and closes the turn without host facts"""
    file_path = await _create_thread(store)
    result = await _send(
        file_path,
        [
            valid_event("user_prompt"),
            valid_event("assistant_text"),
            valid_event("turn_end"),
        ],
    )
    assert [entry.outcome for entry in result.events] == [
        "recorded",
        "recorded",
        "recorded",
    ]
    assert [(t.action, t.turn_id) for t in result.turn_transitions] == [
        ("closed", "t1"),
        ("opened", "t2"),
    ]

    turn_records = await turns.list_turns({"filePath": file_path})
    assert turn_records.ok is True
    if not turn_records.ok:
        return
    closed = next(turn for turn in turn_records.value if turn.turn_id == "t1")
    assert closed.status == "closed"
    assert closed.closed_at_event_order == 3
    # Absent keys when unknown — None on the dataclass (port convention).
    assert closed.outcome is None
    assert closed.outcome_reason is None
    assert closed.started_at is None
    assert closed.ended_at is None

    db = open_raw(file_path)
    try:
        row = db.prepare(
            "SELECT outcome, outcome_reason, started_at, ended_at FROM turns WHERE turn_id = 't1'"
        ).get()
        assert row is not None
        assert row["outcome"] is None
        assert row["outcome_reason"] is None
        assert row["started_at"] is None
        assert row["ended_at"] is None
    finally:
        db.close()


async def test_turn_end_host_facts_round_trip_intake_storage_turns_list_turns_verbatim(
    store: TempStore,
) -> None:
    """turn_end host facts round-trip intake → storage → turns.listTurns verbatim"""
    file_path = await _create_thread(store)
    host_facts = {
        "outcome": "aborted",
        "outcomeReason": "user cancelled mid-tool",
        "startedAt": "2026-07-01T12:00:00.000Z",
        "endedAt": "2026-07-01T12:00:04.250Z",
    }
    await _send(
        file_path,
        [
            valid_event("user_prompt"),
            valid_event("assistant_text"),
            valid_event("turn_end", {"payload": host_facts}),
        ],
    )

    listed = await turns.list_turns({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    closed = next(turn for turn in listed.value if turn.turn_id == "t1")
    assert closed.status == "closed"
    assert closed.outcome == host_facts["outcome"]
    assert closed.outcome_reason == host_facts["outcomeReason"]
    assert closed.started_at == host_facts["startedAt"]
    assert closed.ended_at == host_facts["endedAt"]

    # Storage holds the same strings; no rewrite, no defaulting.
    db = open_raw(file_path)
    try:
        row = db.prepare(
            "SELECT outcome, outcome_reason, started_at, ended_at FROM turns WHERE turn_id = 't1'"
        ).get()
        assert row == {
            "outcome": host_facts["outcome"],
            "outcome_reason": host_facts["outcomeReason"],
            "started_at": host_facts["startedAt"],
            "ended_at": host_facts["endedAt"],
        }
    finally:
        db.close()

    # Event payload also retains the facts (canonical record).
    events = await intake_stream.list_events({"filePath": file_path})
    assert events.ok is True
    if not events.ok:
        return
    turn_end = next(event for event in events.value if event["eventKind"] == "turn_end")
    assert turn_end["payload"] == host_facts


async def test_assistant_text_provider_usage_round_trips_byte_level_through_list_and_show(
    store: TempStore,
) -> None:
    """assistant_text providerUsage round-trips byte-level through list and show"""
    file_path = await _create_thread(store)
    # Nested, mixed-type shape — not a fixed column set; fidelity is the point.
    provider_usage = {
        "input_tokens": 1204,
        "cached_input_tokens": 900,
        "output_tokens": 88,
        "reasoning_output_tokens": 12,
        "nested": {"cache_write": 0, "provider": "openai-codex"},
    }
    # CRITICAL: compare against js_json_dumps, never json.dumps.
    usage_json = js_json_dumps(provider_usage)

    await _send(
        file_path,
        [
            valid_event("user_prompt"),
            valid_event(
                "assistant_text",
                {"payload": {"text": "done", "providerUsage": provider_usage}},
            ),
            valid_event("turn_end"),
        ],
    )

    listed = await messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    assistant = next(message for message in listed.value if message.kind == "assistant_text")
    assert assistant.provider_usage is not None
    assert js_json_dumps(assistant.provider_usage) == usage_json

    shown = await messages.show({"filePath": file_path}, assistant.message_id)
    assert shown.ok is True
    if not shown.ok:
        return
    assert shown.value.provider_usage is not None
    assert js_json_dumps(shown.value.provider_usage) == usage_json

    db = open_raw(file_path)
    try:
        row = db.prepare(
            "SELECT provider_usage FROM message WHERE message_id = ?"
        ).get(assistant.message_id)
        assert row is not None
        # Stored column is the verbatim JSON string (js_json_dumps bytes).
        assert row["provider_usage"] == usage_json
    finally:
        db.close()


async def test_assistant_text_without_provider_usage_stores_and_reads_as_null_absent(
    store: TempStore,
) -> None:
    """assistant_text without providerUsage stores and reads as NULL / absent"""
    file_path = await _create_thread(store)
    await _send(
        file_path,
        [
            valid_event("user_prompt"),
            valid_event(
                "assistant_text", {"payload": {"text": "no usage attached"}}
            ),
            valid_event("turn_end"),
        ],
    )

    listed = await messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    assistant = next(message for message in listed.value if message.kind == "assistant_text")
    assert assistant.provider_usage is None

    shown = await messages.show({"filePath": file_path}, assistant.message_id)
    assert shown.ok is True
    if not shown.ok:
        return
    assert shown.value.provider_usage is None

    db = open_raw(file_path)
    try:
        row = db.prepare(
            "SELECT provider_usage FROM message WHERE message_id = ?"
        ).get(assistant.message_id)
        assert row is not None
        assert row["provider_usage"] is None
    finally:
        db.close()


async def test_invalid_outcome_value_is_rejected_whole(store: TempStore) -> None:
    """invalid outcome value is rejected whole"""
    file_path = await _create_thread(store)
    result = await intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt"),
            {
                **valid_event("turn_end"),
                "payload": {"outcome": "interrupted"},
            },
        ],
    )
    assert result.ok is False
    if result.ok:
        return
    assert result.error.error_class == "caller_error"
    assert result.error.code == "invalid_event"
    assert result.error.event_index == 1
    assert re.search(r"outcome", result.error.reason)


async def test_unknown_key_in_turn_end_payload_is_rejected(store: TempStore) -> None:
    """unknown key in turn_end payload is rejected"""
    file_path = await _create_thread(store)
    result = await intake_stream.message_events(
        {"filePath": file_path},
        [
            {
                **valid_event("turn_end"),
                "payload": {"surprise": True},
            },
        ],
    )
    assert result.ok is False
    if result.ok:
        return
    assert result.error.error_class == "caller_error"
    assert result.error.code == "invalid_event"
    assert re.search(r"surprise", result.error.reason)


async def test_provider_usage_that_is_not_a_json_object_is_rejected(
    store: TempStore,
) -> None:
    """providerUsage that is not a JSON object is rejected"""
    file_path = await _create_thread(store)
    for bad in ("tokens", 12, True, None, [1, 2]):
        result = await intake_stream.message_events(
            {"filePath": file_path},
            [
                {
                    **valid_event("assistant_text"),
                    "payload": {"text": "hi", "providerUsage": bad},
                },
            ],
        )
        assert result.ok is False
        if result.ok:
            continue
        assert result.error.code == "invalid_event"
        assert re.search(r"providerUsage", result.error.reason)


async def test_outcome_completed_alone_is_valid_and_projects(store: TempStore) -> None:
    """outcome completed alone is valid and projects"""
    file_path = await _create_thread(store)
    await _send(
        file_path,
        [
            valid_event("user_prompt"),
            valid_event("assistant_text"),
            valid_event("turn_end", {"payload": {"outcome": "completed"}}),
        ],
    )
    listed = await turns.list_turns({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    closed = next(turn for turn in listed.value if turn.turn_id == "t1")
    assert closed.status == "closed"
    assert closed.outcome == "completed"
