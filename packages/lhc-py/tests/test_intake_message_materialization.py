"""Ported from packages/lhc/test/intake-message-materialization.test.ts. Phase 1.

Story 3 (Flow 2, message materialization half): TC-2.2 through TC-2.5, TC-5.4's
no-duplicate-message clause, and the message materialization rung of the
rollback ladder.
"""

from __future__ import annotations

import pytest

from lhc import EventRecord, intake_stream, messages, threads
from lhc.messages import Block, MessageRecord
from lhc.threads import NewThreadInput
from fixtures import (
    TempStore,
    event_batch,
    open_raw,
    set_intake_walk_hook,
    temp_store,
    valid_event,
)


@pytest.fixture
def store():
    s = temp_store()
    yield s
    set_intake_walk_hook(None)
    s.cleanup()


async def _create_thread(store: TempStore) -> str:
    file_path = store.thread_path()
    created = await threads.new_thread(
        NewThreadInput(file_path=file_path, registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")
    return file_path


async def _read_events(file_path: str) -> list[EventRecord]:
    result = await intake_stream.list_events({"filePath": file_path})
    if not result.ok:
        raise RuntimeError(f"event read-back failed: {result.error.reason}")
    return result.value


async def _read_messages(file_path: str) -> list[MessageRecord]:
    result = await messages.list({"filePath": file_path})
    if not result.ok:
        raise RuntimeError(f"message read-back failed: {result.error.reason}")
    return result.value


async def test_tc_2_2_one_of_each_kind_materializes_six_messages_with_kind_appropriate_blocks_turn_end_stays_event_only(
    store: TempStore,
) -> None:
    """TC-2.2: one of each kind materializes six messages with kind-appropriate blocks; turn_end stays event-only (AC-2.2, AC-2.3)"""
    file_path = await _create_thread(store)
    batch = [
        valid_event("user_prompt", {"payload": {"text": "please summarize the file"}}),
        valid_event("assistant_text", {"payload": {"text": "the file describes turn handling"}}),
        valid_event("assistant_thinking", {"payload": {"text": "the request needs the file first"}}),
        valid_event("runtime_note", {"payload": {"text": "harness reconnected"}}),
        valid_event(
            "tool_call",
            {
                "payload": {
                    "toolCallId": "call-42",
                    "toolName": "read_file",
                    "arguments": {"path": "notes.txt", "offset": 10},
                }
            },
        ),
        valid_event(
            "tool_result",
            {"payload": {"toolCallId": "call-42", "content": "line one\nline two", "isError": False}},
        ),
        valid_event("turn_end"),
    ]

    result = await intake_stream.message_events({"filePath": file_path}, batch)
    assert result.ok is True
    if not result.ok:
        return

    assert [entry.outcome for entry in result.value.events] == ["recorded"] * 7
    assert [entry.message_id for entry in result.value.events] == [
        "m1",
        "m2",
        "m3",
        "m4",
        "m5",
        "m6",
        None,
    ]

    assert [event["eventKind"] for event in await _read_events(file_path)] == [
        "user_prompt",
        "assistant_text",
        "assistant_thinking",
        "runtime_note",
        "tool_call",
        "tool_result",
        "turn_end",
    ]

    materialized = await _read_messages(file_path)
    assert [message.message_id for message in materialized] == ["m1", "m2", "m3", "m4", "m5", "m6"]
    assert [message.source_event_order for message in materialized] == [1, 2, 3, 4, 5, 6]
    assert [message.kind for message in materialized] == [
        "user_prompt",
        "assistant_text",
        "assistant_thinking",
        "runtime_note",
        "tool_call",
        "tool_result",
    ]

    assert materialized[0].blocks == [
        Block(block_type="text", content={"text": "please summarize the file"})
    ]
    assert materialized[1].blocks == [
        Block(block_type="text", content={"text": "the file describes turn handling"})
    ]
    assert materialized[2].blocks == [
        Block(block_type="text", content={"text": "the request needs the file first"})
    ]
    assert materialized[3].blocks == [
        Block(block_type="text", content={"text": "harness reconnected"})
    ]
    assert materialized[4].blocks == [
        Block(
            block_type="tool_call",
            content={
                "toolCallId": "call-42",
                "toolName": "read_file",
                "arguments": {"path": "notes.txt", "offset": 10},
            },
        )
    ]
    assert materialized[5].blocks == [
        Block(
            block_type="tool_result",
            content={"toolCallId": "call-42", "content": "line one\nline two", "isError": False},
        )
    ]

    for message in materialized:
        assert message.turn_id == "t1"


async def test_tc_2_3_identical_content_in_two_threads_yields_identical_token_estimates_every_message_carries_one(
    store: TempStore,
) -> None:
    """TC-2.3: identical content in two threads yields identical token estimates; every message carries one (AC-2.4)"""
    thread_a = await _create_thread(store)
    thread_b = await _create_thread(store)

    def build_batch():
        return [
            valid_event("user_prompt", {"payload": {"text": "estimate me consistently"}}),
            valid_event(
                "tool_call",
                {"payload": {"toolCallId": "c1", "toolName": "search", "arguments": {"query": "same query"}}},
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "c1", "content": "same result content", "isError": False}},
            ),
        ]

    in_a = await intake_stream.message_events({"filePath": thread_a}, build_batch())
    in_b = await intake_stream.message_events({"filePath": thread_b}, build_batch())
    assert in_a.ok is True
    assert in_b.ok is True

    messages_a = await _read_messages(thread_a)
    messages_b = await _read_messages(thread_b)
    assert len(messages_a) == 3
    for message in [*messages_a, *messages_b]:
        assert type(message.token_estimate) is int
        assert message.token_estimate is not None
        assert message.token_estimate > 0
    assert [message.token_estimate for message in messages_a] == [
        message.token_estimate for message in messages_b
    ]


async def test_tc_2_4_a_300kb_tool_result_reads_back_byte_identical_through_the_sdk(store: TempStore) -> None:
    """TC-2.4: a 300KB tool result reads back byte-identical through the SDK (AC-2.5)"""
    file_path = await _create_thread(store)
    big_content = "tool output line δσπ 😀 — verbatim?\n" * 8000
    assert len(big_content.encode("utf-8")) > 300_000

    result = await intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "big-1", "content": big_content, "isError": False}},
            )
        ],
    )
    assert result.ok is True

    events = await _read_events(file_path)
    assert len(events) == 1
    assert events[0]["eventKind"] == "tool_result"
    if events[0]["eventKind"] != "tool_result":
        return
    assert events[0]["payload"]["content"] == big_content

    materialized = await _read_messages(file_path)
    assert len(materialized) == 1
    assert len(materialized[0].blocks) == 1
    block = materialized[0].blocks[0]
    assert block.block_type == "tool_result"
    assert block.content["content"] == big_content
    assert block.content["toolCallId"] == "big-1"


async def test_tc_2_5_actor_and_harness_are_recorded_as_given_and_carried_onto_messages(
    store: TempStore,
) -> None:
    """TC-2.5: actor and harness are recorded as given and carried onto messages (AC-2.6)"""
    file_path = await _create_thread(store)
    batch = [
        valid_event("user_prompt", {"actor": "user:lee", "harness": "pi-extension/1.2"}),
        valid_event("assistant_text", {"actor": "agent:claude", "harness": "claude-code/2.0"}),
    ]
    result = await intake_stream.message_events({"filePath": file_path}, batch)
    assert result.ok is True

    events = await _read_events(file_path)
    assert [[event["actor"], event["harness"]] for event in events] == [
        ["user:lee", "pi-extension/1.2"],
        ["agent:claude", "claude-code/2.0"],
    ]

    materialized = await _read_messages(file_path)
    assert [[message.actor, message.harness] for message in materialized] == [
        ["user:lee", "pi-extension/1.2"],
        ["agent:claude", "claude-code/2.0"],
    ]


async def test_tc_5_4_message_clause_a_skipped_event_creates_no_duplicate_message(store: TempStore) -> None:
    """TC-5.4 (message clause): a skipped event creates no duplicate message (AC-5.4)"""
    file_path = await _create_thread(store)
    batch = event_batch(["user_prompt", "turn_end"])
    first = await intake_stream.message_events({"filePath": file_path}, batch)
    assert first.ok is True
    baseline = await _read_messages(file_path)
    assert len(baseline) == 1

    resend = await intake_stream.message_events({"filePath": file_path}, batch)
    assert resend.ok is True
    if not resend.ok:
        return
    assert all(entry.outcome == "skipped" for entry in resend.value.events)
    assert all(entry.message_id is None for entry in resend.value.events)

    assert await _read_messages(file_path) == baseline

    db = open_raw(file_path)
    try:
        counts = db.prepare(
            "SELECT source_event_order, COUNT(*) AS n FROM message GROUP BY source_event_order"
        ).all()
        assert len(counts) == 1
        assert int(counts[0]["n"]) == 1
    finally:
        db.close()


async def test_architecture_risk_an_induced_message_materialization_failure_rejects_the_whole_batch(
    store: TempStore,
) -> None:
    """architecture-risk: an induced message materialization failure rejects the whole batch — no recorded events without messages"""
    file_path = await _create_thread(store)
    seeded = await intake_stream.message_events({"filePath": file_path}, [valid_event("user_prompt")])
    assert seeded.ok is True
    baseline_events = await _read_events(file_path)
    baseline_messages = await _read_messages(file_path)
    assert len(baseline_events) == 1
    assert len(baseline_messages) == 1

    def _walk_hook(db, event_index):
        if event_index == 0:
            db.exec("DROP TABLE message_block")

    set_intake_walk_hook(_walk_hook)
    result = await intake_stream.message_events(
        {"filePath": file_path}, event_batch(["assistant_text", "assistant_thinking"])
    )
    set_intake_walk_hook(None)
    assert result.ok is False
    if result.ok:
        return
    assert result.error.error_class == "system_error"
    assert result.error.code == "storage_failure"

    assert await _read_events(file_path) == baseline_events
    assert await _read_messages(file_path) == baseline_messages
