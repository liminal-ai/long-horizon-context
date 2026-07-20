"""Ported from packages/lhc/test/mutations-delete.test.ts. Phase 1.

Story 6 (Epic 02): messages.remove — Flow 6.
Thread-view-level removal with the event log intact: a deleted message
leaves reads and its turn's membership while its source events stay in
the Epic 01 read-back (TC-6.1); its own forms drop while the turn and
chunk clear and re-queue for minus-one composition, the cascade stopping
exactly at the chunk (TC-6.2). Prompt protection refuses whole-turn removal
in this slice (TC-6.3). Refusals — open turn, missing id, double
delete through the filtered view — are stable and change nothing
(TC-6.7). The CLI parity leg (TC-6.8) lives in
cli-process-mutations-delete.test.ts (process suite).
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from lhc import (
    DrainReport,
    InferenceCallbacks,
    Lhc,
    MessageEventInput,
    init_lhc,
    intake_stream,
    messages,
    queue_detail,
    set_scheduler_poke,
    set_thread_touch,
    threads,
    turns,
)
from lhc.messages import RemoveInput
from lhc.shared_tech.derivation import ChunkPolicyConfig, LeaseConfig, SdkConfig
from lhc.shared_tech.errors import OpResult
from lhc.shared_tech.inference_types import DerivationGuards, DetailedTurnCompressionGuards
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
    set_scheduler_poke(None)
    set_thread_touch(None)


async def _new_thread(store: TempStore) -> str:
    created = await threads.new_thread(
        NewThreadInput(file_path=store.thread_path(), registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(f"thread creation failed: {created.error.reason}")
    return created.value.file_path


def _manual_sdk(
    inference_callbacks: InferenceCallbacks,
    *,
    chunk_policy: ChunkPolicyConfig | None = None,
    clock=None,
    mode: str = "manual",
) -> Lhc:
    return init_lhc(
        SdkConfig(
            inference_callbacks=inference_callbacks,
            mode=mode,  # type: ignore[arg-type]
            lease=LeaseConfig(duration_ms=5000),
            guards=DerivationGuards(
                detailed_turn_compression=DetailedTurnCompressionGuards(tiny_turn_tokens=1)
            ),
            chunk_policy=chunk_policy,
            clock=clock,
        )
    )


async def _send(sdk: Lhc, file_path: str, batch: Sequence[MessageEventInput]) -> None:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(f"batch failed: {result.error.reason}")


async def _drain(sdk: Lhc, file_path: str) -> DrainReport:
    result = await sdk.work.drain({"filePath": file_path})
    if not result.ok:
        raise RuntimeError(f"drain failed: {result.error.reason}")
    return result.value


def _raw_detail(file_path: str):
    db = open_raw(file_path)
    try:
        return queue_detail(db)
    finally:
        db.close()


def _clear_key(entry) -> str:
    return f"{entry.subject_kind}/{entry.subject_id}/{entry.derivation_type}"


def _unwrap(result: OpResult[object]) -> object:
    if not result.ok:
        raise RuntimeError(f"expected ok result, got {result.error.code}")
    return result.value


# The full mutation read-back surface in one snapshot — record, membership,
# chunks, events, forms, queue — for refusal-changes-nothing assertions.
async def _snapshot(file_path: str) -> object:
    return {
        "messages": _unwrap(await messages.list({"filePath": file_path})),
        "turns": _unwrap(await turns.list_turns({"filePath": file_path})),
        "chunks": _unwrap(await turns.list_chunks({"filePath": file_path})),
        "events": _unwrap(await intake_stream.list_events({"filePath": file_path})),
        "derivations": read_derived_forms(file_path),
        "queue": _raw_detail(file_path),
    }


# One closed turn carrying a full tool run — m1 prompt, m2 tool_call,
# m3 tool_result, m4 assistant_text — drained ready. Under the default
# chunk policy t1's chunk stays open, so no chunk summary rows exist.
async def _tool_run_thread(sdk: Lhc, store: TempStore) -> str:
    file_path = await _new_thread(store)
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "use the tool"}}),
            valid_event("tool_call"),
            valid_event("tool_result"),
            valid_event("assistant_text", {"payload": {"text": "tool run done"}}),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path)
    return file_path


async def test_deleting_a_tool_result_message_removes_it_from_message_reads_and_turn_membership_not_from_event_read_back(
    store: TempStore,
) -> None:
    """deleting a tool-result message removes it from message reads and turn membership, not from event read-back"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _tool_run_thread(sdk, store)
    events_before = _unwrap(await intake_stream.list_events({"filePath": file_path}))

    result = await messages.remove({"filePath": file_path}, RemoveInput(message_id="m3"))
    assert result.ok is True
    if not result.ok:
        return
    assert result.value.changed.message_ids == ["m3"]
    assert result.value.changed.turn_ids == []

    # Message reads exclude the deleted record.
    records = _unwrap(await messages.list({"filePath": file_path}))
    assert isinstance(records, list)
    assert [record.message_id for record in records] == ["m1", "m2", "m4"]

    # Turn membership shrinks in place — the turn row and its boundaries
    # untouched, the deleted member filtered out.
    turn_records = _unwrap(await turns.list_turns({"filePath": file_path}))
    assert isinstance(turn_records, list)
    assert len(turn_records) == 2
    assert turn_records[0].member_message_ids == ["m1", "m2", "m4"]

    # The audit surface is deliberately unfiltered: every source event,
    # byte-identical, including the deleted message's.
    assert _unwrap(await intake_stream.list_events({"filePath": file_path})) == events_before
    assert isinstance(events_before, list)
    assert any(event["eventKind"] == "tool_result" for event in events_before)


async def test_the_deleted_messages_forms_are_gone_its_turn_and_chunk_re_queue_chunk_2_is_byte_stable(
    store: TempStore,
) -> None:
    """the deleted message's forms are gone, its turn and chunk re-queue, chunk 2 is byte-stable"""
    double = create_inference_callbacks_double()
    # max=1: every turn forms its own immediately closed chunk — two
    # chunks, both with summaries (the TC-5.2 reach fixture).
    sdk = _manual_sdk(
        double,
        chunk_policy=ChunkPolicyConfig(target_projected_tokens=1, max_projected_tokens=1),
    )
    file_path = await _new_thread(store)
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "first prompt"}}),
            valid_event("tool_call"),
            valid_event("tool_result"),
            valid_event("assistant_text", {"payload": {"text": "first answer"}}),
            valid_event("turn_end"),
        ],
    )
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "second prompt"}}),
            valid_event("assistant_text", {"payload": {"text": "second answer"}}),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path)
    before = read_derived_forms(file_path)
    assert all(form.state == "ready" for form in before)

    result = await messages.remove({"filePath": file_path}, RemoveInput(message_id="m3"))
    assert result.ok is True
    if not result.ok:
        return

    # The subject's own forms drop; the chain above clears. Tool calls render
    # as recorded and have no summary row to clear or requeue.
    assert [_clear_key(d) for d in result.value.dropped] == ["message/m3/tool_result_summary"]
    assert sorted(_clear_key(c) for c in result.value.cleared) == sorted(
        [
            "turn/t1/detailed_turn_compression",
            "turn/t1/pre_detailed_assembly",
            "turn/t1/turn_rendering",
            "chunk/c1/chunk_summary_brief",
            "chunk/c1/chunk_summary_detailed",
        ]
    )
    assert sorted(item.work_item_id for item in result.value.queued) == [
        "w-c1-chunk_summary_brief-v2",
        "w-c1-chunk_summary_detailed-v2",
        "w-t1-detailed_turn_compression-v2",
        "w-t1-turn_derivation-v2",
    ]

    # Dropped means rows removed — no ghost row in any state.
    after = read_derived_forms(file_path)
    assert not any(form.subject_id == "m3" for form in after)
    # The cleared half sits pending at the bumped version and queued.
    cleared_set = {_clear_key(c) for c in result.value.cleared}
    for form in [candidate for candidate in after if _clear_key(candidate) in cleared_set]:
        assert form.state == "pending"
        assert form.source_version == 2
    # Everything else — m1's message form, t2's forms, chunk 2's summaries —
    # deep-equals its pre-delete row, source version included.
    assert [form for form in after if _clear_key(form) not in cleared_set] == [
        form
        for form in before
        if _clear_key(form) not in cleared_set and form.subject_id != "m3"
    ]

    # The rebuild re-derives the affected turn: turn_rendering is deterministic
    # (AC-6.3), so the proof it re-ran is a compressDetailedTurn call carrying the
    # re-rendered text (the live-members-only filter is exercised by the ready
    # check above and m3's absence throughout).
    captured = double.capture_inputs()
    await _drain(sdk, file_path)
    assert all(form.state == "ready" for form in read_derived_forms(file_path))
    assert any(call.op == "compressDetailedTurn" for call in captured)


async def test_deleting_a_turn_initiating_prompt_is_refused_naming_the_turn_nothing_changes(
    store: TempStore,
) -> None:
    """deleting a turn-initiating prompt is refused naming the turn; nothing changes"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _tool_run_thread(sdk, store)
    before = await _snapshot(file_path)

    result = await messages.remove({"filePath": file_path}, RemoveInput(message_id="m1"))
    assert result.ok is False
    if result.ok:
        return
    assert result.error.error_class == "caller_error"
    assert result.error.code == "message_initiates_turn"
    assert "t1" in result.error.reason
    assert "whole turn is not supported" in result.error.reason

    assert await _snapshot(file_path) == before


async def test_open_turn_target_bogus_id_and_a_second_delete_of_the_same_id_refuse_with_stable_codes_the_record_is_identical_after_each(
    store: TempStore,
) -> None:
    """open-turn target, bogus id, and a second delete of the same id refuse with stable codes; the record is identical after each"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)
    # t1 closed {m1 prompt, m2 answer}; t2 open {m4 prompt}.
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "closed prompt"}}),
            valid_event("assistant_text", {"payload": {"text": "closed answer"}}),
            valid_event("turn_end"),
            valid_event("user_prompt", {"payload": {"text": "open prompt"}}),
        ],
    )
    await _drain(sdk, file_path)
    before = await _snapshot(file_path)

    # Open-turn message: refused under the closed-turn boundary.
    open_turn = await messages.remove({"filePath": file_path}, RemoveInput(message_id="m4"))
    assert open_turn.ok is False
    if open_turn.ok:
        return
    assert open_turn.error.error_class == "caller_error"
    assert open_turn.error.code == "turn_open"
    assert await _snapshot(file_path) == before

    # Unknown id.
    missing = await messages.remove({"filePath": file_path}, RemoveInput(message_id="m99"))
    assert missing.ok is False
    if missing.ok:
        return
    assert missing.error.code == "message_not_found"
    assert await _snapshot(file_path) == before

    # Double delete: the first succeeds; the second reads the filtered view
    # and refuses as message_not_found — a refusal, not a silent success,
    # and not a tombstone-aware error branch.
    first_delete = await messages.remove({"filePath": file_path}, RemoveInput(message_id="m2"))
    assert first_delete.ok is True
    after_delete = await _snapshot(file_path)
    second_delete = await messages.remove({"filePath": file_path}, RemoveInput(message_id="m2"))
    assert second_delete.ok is False
    if second_delete.ok:
        return
    assert second_delete.error.error_class == "caller_error"
    assert second_delete.error.code == "message_not_found"
    assert await _snapshot(file_path) == after_delete


async def test_the_cascades_enqueue_pokes_ride_the_commit_the_minus_one_rebuild_runs_with_no_further_call(
    store: TempStore,
) -> None:
    """the cascade's enqueue pokes ride the commit; the minus-one rebuild runs with no further call"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double, mode="background")
    file_path = await _new_thread(store)
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "the prompt"}}),
            valid_event("tool_call"),
            valid_event("tool_result"),
            valid_event("turn_end"),
        ],
    )
    await sdk.drain_settled({"filePath": file_path})
    assert all(form.state == "ready" for form in read_derived_forms(file_path))

    result = await messages.remove({"filePath": file_path}, RemoveInput(message_id="m3"))
    assert result.ok is True
    await sdk.drain_settled({"filePath": file_path})

    turn_forms = [form for form in read_derived_forms(file_path) if form.subject_id == "t1"]
    assert len(turn_forms) == 3
    assert all(form.state == "ready" and form.source_version == 2 for form in turn_forms)
    assert _raw_detail(file_path) == []
