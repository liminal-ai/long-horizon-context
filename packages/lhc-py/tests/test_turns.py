"""Ported from packages/lhc/test/turns.test.ts. Phase 1.

Story 4 (Flow 3): turn boundaries through the production walk. TC-3.1
through TC-3.8 (the work-item halves of TC-3.3/TC-3.6 are Story 5's named
debt), TC-4.4's three-way class assertion, TC-5.4's no-transition clause
re-asserted now that turns exist, and the corruption rung of the rollback
ladder. Everything enters through the SDK (the CLI surface retired with Epic 05
Story 1).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from lhc import Derivation, MessageEventInput, intake_stream, messages, threads, turns
from lhc.threads import NewThreadInput
from lhc.turns import TurnRecord, TurnTransition
from fixtures import (
    TempStore,
    corrupt_two_open_turns,
    open_raw,
    temp_store,
    valid_event,
)


@pytest.fixture
def store():
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


async def _send(file_path: str, batch: list[MessageEventInput]):
    result = await intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(f"fixture batch failed: {result.error.reason}")
    return result.value


async def _read_turns(file_path: str) -> list[TurnRecord]:
    result = await turns.list_turns({"filePath": file_path})
    if not result.ok:
        raise RuntimeError(f"turn read-back failed: {result.error.reason}")
    return result.value


# Full logical read-back across every record kind this story owns — the
# rollback ladder's corruption rung compares this whole, not just the error.
async def _read_back(file_path: str):
    events = await intake_stream.list_events({"filePath": file_path})
    projected = await messages.list({"filePath": file_path})
    turn_records = await turns.list_turns({"filePath": file_path})
    if not events.ok or not projected.ok or not turn_records.ok:
        raise RuntimeError("read-back failed")
    return {"events": events.value, "messages": projected.value, "turns": turn_records.value}


def _pending_turn_derivations(turn_id: str) -> list[Derivation]:
    return [
        Derivation(
            subject_kind="turn",
            subject_id=turn_id,
            derivation_type="pre_detailed_assembly",
            state="pending",
            source_version=1,
        ),
        Derivation(
            subject_kind="turn",
            subject_id=turn_id,
            derivation_type="turn_rendering",
            state="pending",
            source_version=1,
        ),
    ]


# ── Flow 3 (SDK): turn boundaries ─────────────────────────────────


async def test_new_thread_creation_initializes_exactly_one_empty_open_turn(store: TempStore) -> None:
    """new thread creation initializes exactly one empty open turn"""
    file_path = await _create_thread(store)
    assert await _read_turns(file_path) == [
        TurnRecord(
            turn_id="t1",
            turn_order=1,
            status="open",
            member_message_ids=[],
            opened_at_event_order=0,
        ),
    ]


async def test_tc_3_1_a_prompt_attaches_to_the_empty_open_turn_and_the_whole_activity_stamps_to_it_ac_3_1_ac_3_2(
    store: TempStore,
) -> None:
    """TC-3.1: a prompt attaches to the empty open turn and the whole activity stamps to it (AC-3.1, AC-3.2)"""
    file_path = await _create_thread(store)
    result = await _send(
        file_path,
        [
            valid_event("user_prompt"),
            valid_event("assistant_text"),
            valid_event("tool_call"),
            valid_event("tool_result"),
        ],
    )
    assert result.turn_transitions == []

    turn_records = await _read_turns(file_path)
    assert turn_records == [
        TurnRecord(
            turn_id="t1",
            turn_order=1,
            status="open",
            member_message_ids=["m1", "m2", "m3", "m4"],
            opened_at_event_order=0,
        ),
    ]

    # Membership is also visible on the members themselves.
    projected = await messages.list({"filePath": file_path})
    assert projected.ok is True
    if not projected.ok:
        return
    assert [message.turn_id for message in projected.value] == ["t1", "t1", "t1", "t1"]


async def test_tc_3_2_a_second_prompt_closes_the_open_turn_and_opens_a_new_one_holding_only_the_prompt_ac_3_3(
    store: TempStore,
) -> None:
    """TC-3.2: a second prompt closes the open turn and opens a new one holding only the prompt (AC-3.3)"""
    file_path = await _create_thread(store)
    await _send(file_path, [valid_event("user_prompt"), valid_event("assistant_text")])

    second = await _send(file_path, [valid_event("user_prompt")])
    assert second.turn_transitions == [
        TurnTransition(action="closed", turn_id="t1"),
        TurnTransition(action="opened", turn_id="t2"),
    ]

    turn_records = await _read_turns(file_path)
    assert turn_records == [
        TurnRecord(
            turn_id="t1",
            turn_order=1,
            status="closed",
            member_message_ids=["m1", "m2"],
            opened_at_event_order=0,
            closed_at_event_order=3,
            derivations=_pending_turn_derivations("t1"),
        ),
        TurnRecord(
            turn_id="t2",
            turn_order=2,
            status="open",
            member_message_ids=["m3"],
            opened_at_event_order=3,
        ),
    ]


async def test_tc_3_3_transition_membership_half_turn_end_closes_a_non_empty_turn_and_opens_the_next_empty_turn_ac_3_4(
    store: TempStore,
) -> None:
    """TC-3.3 (transition + membership half): turn_end closes a non-empty turn and opens the next empty turn (AC-3.4)"""
    file_path = await _create_thread(store)
    result = await _send(
        file_path,
        [
            valid_event("user_prompt"),
            valid_event("assistant_text"),
            valid_event("turn_end"),
        ],
    )
    assert result.turn_transitions == [
        TurnTransition(action="closed", turn_id="t1"),
        TurnTransition(action="opened", turn_id="t2"),
    ]

    turn_records = await _read_turns(file_path)
    assert turn_records == [
        TurnRecord(
            turn_id="t1",
            turn_order=1,
            status="closed",
            member_message_ids=["m1", "m2"],
            opened_at_event_order=0,
            closed_at_event_order=3,
            derivations=_pending_turn_derivations("t1"),
        ),
        TurnRecord(
            turn_id="t2",
            turn_order=2,
            status="open",
            member_message_ids=[],
            opened_at_event_order=3,
        ),
    ]


async def test_tc_3_4_turn_end_on_an_empty_open_turn_is_recorded_but_inert_the_next_prompt_uses_that_turn_ac_3_5(
    store: TempStore,
) -> None:
    """TC-3.4: turn_end on an empty open turn is recorded but inert; the next prompt uses that turn (AC-3.5)"""
    file_path = await _create_thread(store)
    orphan = await _send(file_path, [valid_event("turn_end")])
    assert orphan.turn_transitions == []
    assert orphan.events[0].outcome == "recorded"

    events = await intake_stream.list_events({"filePath": file_path})
    assert events.ok is True
    if not events.ok:
        return
    assert len(events.value) == 1
    assert events.value[0].event_order == 1

    assert await _read_turns(file_path) == [
        TurnRecord(
            turn_id="t1",
            turn_order=1,
            status="open",
            member_message_ids=[],
            opened_at_event_order=0,
        ),
    ]

    next_batch = await _send(file_path, [valid_event("user_prompt")])
    assert next_batch.turn_transitions == []
    assert await _read_turns(file_path) == [
        TurnRecord(
            turn_id="t1",
            turn_order=1,
            status="open",
            member_message_ids=["m2"],
            opened_at_event_order=0,
        ),
    ]


async def test_tc_3_5_post_close_messages_attach_to_the_current_empty_turn_ac_3_7_ac_3_8(
    store: TempStore,
) -> None:
    """TC-3.5: post-close messages attach to the current empty turn (AC-3.7, AC-3.8)"""
    file_path = await _create_thread(store)
    await _send(
        file_path,
        [valid_event("user_prompt"), valid_event("assistant_text"), valid_event("turn_end")],
    )
    closed_before = (await _read_turns(file_path))[0]

    # Post-close, pre-prompt: the message belongs to the open empty turn.
    await _send(file_path, [valid_event("assistant_text")])
    # A new prompt closes that non-empty turn and opens t3.
    await _send(file_path, [valid_event("user_prompt")])

    projected = await messages.list({"filePath": file_path})
    assert projected.ok is True
    if not projected.ok:
        return
    assert [message.turn_id for message in projected.value] == ["t1", "t1", "t2", "t3"]

    turn_records = await _read_turns(file_path)
    # Frozenness is behavioral: the closed turn's full record — members
    # included — is identical after the later activity.
    assert turn_records[0] == closed_before
    assert turn_records[1] == TurnRecord(
        turn_id="t2",
        turn_order=2,
        status="closed",
        member_message_ids=["m4"],
        opened_at_event_order=3,
        closed_at_event_order=5,
        derivations=_pending_turn_derivations("t2"),
    )
    assert turn_records[2] == TurnRecord(
        turn_id="t3",
        turn_order=3,
        status="open",
        member_message_ids=["m5"],
        opened_at_event_order=5,
    )


async def test_tc_3_6_transition_half_implicit_close_behaves_exactly_like_explicit_close_work_parity_is_story_5s(
    store: TempStore,
) -> None:
    """TC-3.6 (transition half): implicit close behaves exactly like explicit close (work parity is Story 5's)"""
    explicit_path = await _create_thread(store)
    await _send(explicit_path, [valid_event("user_prompt"), valid_event("assistant_text")])
    explicit_close = await _send(explicit_path, [valid_event("turn_end")])

    implicit_path = await _create_thread(store)
    await _send(implicit_path, [valid_event("user_prompt"), valid_event("assistant_text")])
    implicit_close = await _send(implicit_path, [valid_event("user_prompt")])

    # Both paths close t1 at event order 3 with the same frozen membership.
    assert explicit_close.turn_transitions[0] == TurnTransition(action="closed", turn_id="t1")
    assert implicit_close.turn_transitions[0] == TurnTransition(action="closed", turn_id="t1")
    explicit_t1 = (await _read_turns(explicit_path))[0]
    implicit_t1 = (await _read_turns(implicit_path))[0]
    assert explicit_t1 == implicit_t1


async def test_tc_3_7_two_open_turns_fail_any_batch_with_turn_state_corrupt_and_the_batch_records_nothing_ac_3_9(
    store: TempStore,
) -> None:
    """TC-3.7: two open turns fail any batch with turn_state_corrupt and the batch records nothing (AC-3.9)"""
    file_path = await _create_thread(store)
    await _send(file_path, [valid_event("user_prompt"), valid_event("assistant_text")])
    corrupt_two_open_turns(file_path)

    # Baseline captured after the corruption: the failed batch must add
    # nothing on top of it — full read-back diff, not just the error code.
    baseline = await _read_back(file_path)

    failed = await intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt"),
            valid_event("assistant_text"),
        ],
    )
    assert failed.ok is False
    if failed.ok:
        return
    assert failed.error.error_class == "state_corruption"
    assert failed.error.code == "turn_state_corrupt"

    # The check fired at state load, before any event was processed: no
    # partial walk preceded detection (architecture-risk timing assertion,
    # the rollback ladder's corruption rung).
    assert await _read_back(file_path) == baseline


async def test_zero_open_turns_fail_any_batch_with_turn_state_corrupt_and_the_batch_records_nothing_ac_3_9(
    store: TempStore,
) -> None:
    """zero open turns fail any batch with turn_state_corrupt and the batch records nothing (AC-3.9)"""
    file_path = await _create_thread(store)
    db = open_raw(file_path)
    try:
        db.prepare(
            "UPDATE turns SET status = 'closed', closed_at_event_order = 0 WHERE status = 'open'"
        ).run()
    finally:
        db.close()
    baseline = await _read_back(file_path)
    failed = await intake_stream.message_events(
        {"filePath": file_path}, [valid_event("assistant_text")]
    )
    assert failed.ok is False
    if failed.ok:
        return
    assert failed.error.error_class == "state_corruption"
    assert failed.error.code == "turn_state_corrupt"
    assert await _read_back(file_path) == baseline


async def test_tc_3_8_one_batch_with_two_prompts_and_a_turn_end_yields_two_closed_turns_with_correct_membership_ac_3_3(
    store: TempStore,
) -> None:
    """TC-3.8: one batch with two prompts and a turn_end yields two closed turns with correct membership (AC-3.3)"""
    file_path = await _create_thread(store)
    result = await _send(
        file_path,
        [
            valid_event("user_prompt"),
            valid_event("assistant_text"),
            valid_event("user_prompt"),
            valid_event("assistant_text"),
            valid_event("turn_end"),
        ],
    )

    # Transitions in occurrence order, per event inside the walk.
    assert result.turn_transitions == [
        TurnTransition(action="closed", turn_id="t1"),
        TurnTransition(action="opened", turn_id="t2"),
        TurnTransition(action="closed", turn_id="t2"),
        TurnTransition(action="opened", turn_id="t3"),
    ]

    assert await _read_turns(file_path) == [
        TurnRecord(
            turn_id="t1",
            turn_order=1,
            status="closed",
            member_message_ids=["m1", "m2"],
            opened_at_event_order=0,
            closed_at_event_order=3,
            derivations=_pending_turn_derivations("t1"),
        ),
        TurnRecord(
            turn_id="t2",
            turn_order=2,
            status="closed",
            member_message_ids=["m3", "m4"],
            opened_at_event_order=3,
            closed_at_event_order=5,
            derivations=_pending_turn_derivations("t2"),
        ),
        TurnRecord(
            turn_id="t3",
            turn_order=3,
            status="open",
            member_message_ids=[],
            opened_at_event_order=5,
        ),
    ]


async def test_tc_5_4_no_transition_clause_resending_recorded_events_causes_no_transition_and_leaves_turn_state_unchanged_ac_5_4(
    store: TempStore,
) -> None:
    """TC-5.4 (no-transition clause): resending recorded events causes no transition and leaves turn state unchanged (AC-5.4)"""
    file_path = await _create_thread(store)
    prompt = valid_event("user_prompt")
    end = valid_event("turn_end")
    await _send(file_path, [prompt, valid_event("assistant_text"), end])
    await _send(file_path, [valid_event("user_prompt")])  # t2 now open
    baseline = await _read_back(file_path)

    # A resent prompt cannot re-close a turn; a resent turn_end cannot close
    # whatever happens to be open now.
    resend = await _send(file_path, [prompt, end])
    assert [entry.outcome for entry in resend.events] == ["skipped", "skipped"]
    assert resend.turn_transitions == []
    assert await _read_back(file_path) == baseline


# ── TC-4.4: three error classes ───────────────────────────────────


async def test_validation_corruption_and_storage_failures_carry_three_distinct_classes_with_stable_codes(
    store: TempStore,
) -> None:
    """validation, corruption, and storage failures carry three distinct classes with stable codes"""
    # Caller leg: a malformed event.
    caller_path = await _create_thread(store)
    bogus: MessageEventInput = {**valid_event("user_prompt"), "eventKind": "bogus"}  # type: ignore[misc]
    caller_leg = await intake_stream.message_events({"filePath": caller_path}, [bogus])
    assert caller_leg.ok is False
    if caller_leg.ok:
        return
    assert caller_leg.error.error_class == "caller_error"
    assert caller_leg.error.code == "invalid_event"

    # Corruption leg: the two-open-turns fixture.
    corrupt_path = await _create_thread(store)
    await _send(corrupt_path, [valid_event("user_prompt")])
    corrupt_two_open_turns(corrupt_path)
    corruption_leg = await intake_stream.message_events(
        {"filePath": corrupt_path}, [valid_event("assistant_text")]
    )
    assert corruption_leg.ok is False
    if corruption_leg.ok:
        return
    assert corruption_leg.error.error_class == "state_corruption"
    assert corruption_leg.error.code == "turn_state_corrupt"

    # System leg: registry creation under a path whose parent is a file.
    blocker = str(Path(store.dir) / "blocker-file")
    Path(blocker).write_text("regular file standing where a directory must be", encoding="utf-8")
    system_leg = await threads.new_thread(
        NewThreadInput(
            file_path=store.thread_path(),
            registry_path=str(Path(blocker) / "registry.sqlite"),
        )
    )
    assert system_leg.ok is False
    if system_leg.ok:
        return
    assert system_leg.error.error_class == "system_error"
    assert system_leg.error.code == "storage_failure"

    # The three classes compared against each other, not pattern-matched
    # individually.
    classes = {
        caller_leg.error.error_class,
        corruption_leg.error.error_class,
        system_leg.error.error_class,
    }
    assert len(classes) == 3
