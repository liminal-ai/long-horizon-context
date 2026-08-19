"""Closed Python parity fixture for the frozen LIM-113 user_steer contract."""

from __future__ import annotations

import json

import pytest

from lhc import (
    USER_STEER_IDEMPOTENCY_PREFIX,
    USER_STEER_PAYLOAD_VERSION,
    USER_STEER_RENDERING_LABEL,
    create_deterministic_inference_callbacks,
    init_lhc,
    intake_stream,
    messages,
    retrieval,
    user_steer_idempotency_key,
)
from lhc.intake_stream.internal.steer_lookup import USER_STEER_LOOKUP_SQL
from lhc.intake_stream.internal.validate import EVENT_KINDS
from lhc.shared_tech.view import SessionUserMessage
from lhc.thread_view.internal.select import PI_MAPPABLE_MESSAGE_KINDS
from fixtures import TempStore, open_raw, temp_store, valid_event

STEER_TEXT = "actually — stop after the second file and report what you have"


@pytest.fixture
def store():
    value = temp_store()
    yield value
    value.cleanup()


@pytest.fixture
async def sdk_path(store: TempStore):
    sdk = init_lhc(
        {
            "mode": "manual",
            "inferenceCallbacks": create_deterministic_inference_callbacks(),
        }
    )
    path = store.thread_path()
    made = await sdk.threads.new_thread(
        {"filePath": path, "registryPath": store.registry_path}
    )
    assert made.ok
    return sdk, path


def steer(steer_id: str, text: str = STEER_TEXT):
    return valid_event(
        "user_steer",
        {"payload": {"version": 1, "steerId": steer_id, "text": text}},
    )


async def record(path: str, events):
    return await intake_stream.message_events({"filePath": path}, events)


async def record_ok(path: str, events):
    result = await record(path, events)
    assert result.ok, result.error.reason if not result.ok else ""
    return result.value


async def test_contract_shape_and_closed_validation(sdk_path) -> None:
    _, path = sdk_path
    assert "user_steer" in EVENT_KINDS
    assert USER_STEER_PAYLOAD_VERSION == 1
    assert USER_STEER_IDEMPOTENCY_PREFIX == "lhc.user_steer:"
    assert user_steer_idempotency_key("s7") == "lhc.user_steer:s7"
    await record_ok(path, [valid_event("user_prompt"), steer("s1")])
    listed = await intake_stream.list_events({"filePath": path})
    assert listed.ok
    saved = next(event for event in listed.value if event["eventKind"] == "user_steer")
    assert saved["payload"] == {"version": 1, "steerId": "s1", "text": STEER_TEXT}
    assert saved["idempotencyKey"] == "lhc.user_steer:s1"


@pytest.mark.parametrize(
    "payload",
    [
        {"version": 1, "steerId": "s1", "text": STEER_TEXT, "queuePosition": 3},
        {"version": 2, "steerId": "s1", "text": STEER_TEXT},
        {"version": 1, "steerId": "", "text": STEER_TEXT},
        {"version": 1, "steerId": "s1", "text": ""},
    ],
)
async def test_rejects_invalid_closed_payloads(sdk_path, payload) -> None:
    _, path = sdk_path
    event = steer("s1")
    event["payload"] = payload
    event["idempotencyKey"] = user_steer_idempotency_key(str(payload["steerId"]))
    result = await record(path, [event])
    assert not result.ok
    assert result.error.error_class == "caller_error"
    assert result.error.code == "invalid_event"


async def test_rejects_noncanonical_key_and_reserved_namespace_squatters(
    sdk_path,
) -> None:
    _, path = sdk_path
    bad = steer("s1")
    bad["idempotencyKey"] = "host-queue-item-9"
    mismatch = await record(path, [bad])
    assert not mismatch.ok and "lhc.user_steer:s1" in mismatch.error.reason
    for kind in (
        "user_prompt",
        "assistant_text",
        "assistant_thinking",
        "runtime_note",
        "model_change",
        "thinking_level_change",
        "tool_call",
        "tool_result",
        "turn_end",
    ):
        squatter = valid_event(kind, {"idempotencyKey": "lhc.user_steer:s7"})
        refused = await record(path, [squatter])
        assert not refused.ok
        assert refused.error.event_index == 0
    listed = await intake_stream.list_events({"filePath": path})
    assert listed.ok and listed.value == []


async def test_projection_membership_and_no_derivation_work(sdk_path) -> None:
    sdk, path = sdk_path
    first = await record_ok(path, [valid_event("user_prompt"), steer("s1")])
    assert first.turn_transitions == []
    assert len(first.queued_work) == 1
    assert first.queued_work[0].source_ref == {"messageId": "m1"}
    listed = await messages.list({"filePath": path})
    assert listed.ok
    item = next(message for message in listed.value if message.kind == "user_steer")
    assert item.blocks[0].block_type == "user_steer"
    assert item.blocks[0].content == {"version": 1, "steerId": "s1", "text": STEER_TEXT}
    assert item.derivations is None
    turns = await sdk.turns.list_turns({"filePath": path})
    assert turns.ok and len(turns.value) == 1 and turns.value[0].status == "open"
    assert turns.value[0].member_message_ids == ["m1", "m2"]


async def test_requires_an_active_user_prompt_and_rolls_back_mid_batch(
    sdk_path,
) -> None:
    _, path = sdk_path
    idle = await record(path, [steer("idle")])
    assert not idle.ok and idle.error.event_index == 0
    mid = await record(path, [valid_event("runtime_note"), steer("s1")])
    assert not mid.ok and mid.error.event_index == 1
    listed = await intake_stream.list_events({"filePath": path})
    assert listed.ok and listed.value == []


async def test_prompt_steer_same_batch_and_prompt_after_steer_boundary(
    sdk_path,
) -> None:
    sdk, path = sdk_path
    joined = await record_ok(path, [valid_event("user_prompt"), steer("s1")])
    assert joined.turn_transitions == []
    next_prompt = await record_ok(path, [valid_event("user_prompt")])
    assert [item.action for item in next_prompt.turn_transitions] == [
        "closed",
        "opened",
    ]
    turns = await sdk.turns.list_turns({"filePath": path})
    assert turns.ok and len(turns.value) == 2
    assert turns.value[0].member_message_ids == ["m1", "m2"]


async def test_identical_replay_dedups_but_conflicting_replay_refuses(sdk_path) -> None:
    _, path = sdk_path
    await record_ok(path, [valid_event("user_prompt"), steer("s1")])
    duplicate = steer("s1")
    duplicate["payload"] = {"text": STEER_TEXT, "steerId": "s1", "version": 1}
    same = await record_ok(path, [duplicate])
    assert same.events[0].outcome == "skipped"
    changed = await record(path, [steer("s1", "changed")])
    assert not changed.ok and "different payload" in changed.error.reason
    listed = await intake_stream.list_events({"filePath": path})
    assert listed.ok
    assert [e["eventKind"] for e in listed.value].count("user_steer") == 1


async def test_in_batch_conflict_is_atomic(sdk_path) -> None:
    _, path = sdk_path
    result = await record(
        path,
        [valid_event("user_prompt"), steer("s1"), steer("s1", "changed")],
    )
    assert not result.ok and result.error.event_index == 2
    listed = await intake_stream.list_events({"filePath": path})
    assert listed.ok and listed.value == []


async def test_generic_duplicate_contract_outside_namespace_is_unchanged(
    sdk_path,
) -> None:
    _, path = sdk_path
    first = valid_event("user_prompt", {"idempotencyKey": "generic"})
    await record_ok(path, [first])
    changed = valid_event(
        "assistant_text",
        {"idempotencyKey": "generic", "payload": {"text": "different"}},
    )
    result = await record_ok(path, [changed])
    assert result.events[0].outcome == "skipped"


async def test_turn_end_empty_turn_and_harness_only_turn_refuse_steering(
    sdk_path,
) -> None:
    _, path = sdk_path
    await record_ok(
        path, [valid_event("user_prompt"), steer("s1"), valid_event("turn_end")]
    )
    after_end = await record(path, [steer("s2")])
    assert not after_end.ok
    await record_ok(path, [valid_event("runtime_note")])
    harness_only = await record(path, [steer("s3")])
    assert not harness_only.ok


async def test_tool_order_rendering_retrieval_and_model_views(sdk_path) -> None:
    sdk, path = sdk_path
    await record_ok(
        path,
        [
            valid_event("user_prompt"),
            valid_event("tool_call"),
            valid_event("tool_result"),
            steer("s1"),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-2",
                        "toolName": "next",
                        "arguments": {},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "call-2",
                        "content": "second",
                        "isError": False,
                    }
                },
            ),
            valid_event("turn_end"),
        ],
    )
    await sdk.work.drain({"filePath": path})
    turns = await retrieval.get_turns({"filePath": path}, ["t1"])
    assert turns.ok
    text = turns.value.served[0].text
    assert text.count(STEER_TEXT) == 1
    assert USER_STEER_RENDERING_LABEL in text
    assert (
        text.index("contents of notes.txt")
        < text.index(STEER_TEXT)
        < text.index("second")
    )
    found_message = await retrieval.get_messages({"filePath": path}, ["m4"])
    assert found_message.ok and found_message.value.served[0].text == STEER_TEXT
    context = await sdk.thread_view.get_llm_request_context({"filePath": path})
    assert context.ok
    assert any(
        message.role == "user" and message.content[0].text == STEER_TEXT
        for message in context.value.messages
    )


async def test_typed_session_source_and_prompt_shape(sdk_path) -> None:
    sdk, path = sdk_path
    await record_ok(
        path, [valid_event("user_prompt"), valid_event("assistant_text"), steer("s7")]
    )
    view = await sdk.thread_view.get_session_thread_view({"filePath": path})
    assert view.ok
    prompt = view.value.entries[0]
    steer_entry = view.value.entries[2]
    assert isinstance(prompt, SessionUserMessage) and prompt.source is None
    assert isinstance(steer_entry, SessionUserMessage)
    assert steer_entry.content == STEER_TEXT
    assert steer_entry.source is not None
    assert steer_entry.source.kind == "user_steer"
    assert steer_entry.source.version == 1
    assert steer_entry.source.steer_id == "s7"
    assert steer_entry.source_messages[0].idempotency_key == "lhc.user_steer:s7"
    assert "user_steer" in PI_MAPPABLE_MESSAGE_KINDS


async def test_damaged_or_unknown_session_source_refuses_without_fabrication(
    sdk_path,
) -> None:
    sdk, path = sdk_path
    await record_ok(path, [valid_event("user_prompt"), steer("s7")])
    db = open_raw(path)
    db.prepare(
        "UPDATE message_block SET content = ? WHERE message_id = 'm2' AND block_index = 0"
    ).run(json.dumps({"version": 2, "steerId": "s7", "text": STEER_TEXT}))
    db.close()
    view = await sdk.thread_view.get_session_thread_view({"filePath": path})
    assert not view.ok
    assert view.error.error_class == "state_corruption"
    assert view.error.code == "source_damaged"


async def test_find_user_steer_exact_absent_deleted_and_indexed(sdk_path) -> None:
    sdk, path = sdk_path
    await record_ok(path, [valid_event("user_prompt"), steer("s1")])
    found = await sdk.intake_stream.find_user_steer({"filePath": path}, "s1")
    assert found.ok and found.value is not None
    assert found.value.steer_id == "s1"
    assert found.value.idempotency_key == "lhc.user_steer:s1"
    assert found.value.event_order == 2
    assert found.value.message_id == "m2"
    assert found.value.payload == {"version": 1, "steerId": "s1", "text": STEER_TEXT}
    missing = await sdk.intake_stream.find_user_steer({"filePath": path}, "missing")
    assert missing.ok and missing.value is None
    db = open_raw(path)
    plan = db.prepare(f"EXPLAIN QUERY PLAN {USER_STEER_LOOKUP_SQL}").all(
        "lhc.user_steer:s1"
    )
    details = " ".join(str(row["detail"]).upper() for row in plan)
    assert "SEARCH E USING INDEX" in details and "SCAN E" not in details
    db.prepare(
        "UPDATE message SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE message_id = 'm2'"
    ).run()
    db.close()
    deleted = await sdk.intake_stream.find_user_steer({"filePath": path}, "s1")
    assert deleted.ok and deleted.value is not None and deleted.value.message_id is None


async def test_many_steers_resolve_individually(sdk_path) -> None:
    sdk, path = sdk_path
    await record_ok(
        path,
        [
            valid_event("user_prompt"),
            *[steer(f"s{i}", f"steer {i}") for i in range(25)],
        ],
    )
    found = await sdk.intake_stream.find_user_steer({"filePath": path}, "s17")
    assert found.ok and found.value is not None
    assert found.value.payload["text"] == "steer 17"
