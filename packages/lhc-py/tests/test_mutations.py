"""Ported from packages/lhc/test/mutations.test.ts. Phase 1.

Story 5 (Epic 02): messages.edit and the mutation cascade — Flow 5's edit
half. One synchronous transaction carries the content change, the token
re-stamp, and the full dependent-chain clear-and-requeue (TC-5.1), with
induced-failure atomicity proving a failing cascade step rolls back the
content change too (architecture risk). Cascade reach is proven in both
directions — exactly the chain cleared, everything outside it byte-stable
including source versions (TC-5.2, architecture risk). Post-return no
pre-edit derivation is ready and replacements sit queued at the new source
version, with superseded queued ids reported and their rows gone (TC-5.3).
TC-5.4 is the epic's named architecture-risk test: a claimed pre-edit item
held across the edit by the delayed double completes after the post-edit
rebuild is queued, discards on the source-version mismatch as
stale_discarded, and the post-edit artifact stands. Refusals (open turn,
missing id, deleted target through the filtered view) change nothing
(TC-5.5). The CLI parity leg of TC-5.6 lives in
cli-process-mutations.test.ts (process suite).
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Sequence

import pytest

from lhc import (
    DrainReport,
    InferenceCallbacks,
    Lhc,
    MessageEventInput,
    init_lhc,
    messages,
    queue_detail,
    set_scheduler_poke,
    set_thread_touch,
    threads,
)
from lhc.messages import Block, EditInput, MutationQueuedWork, MutationResult
from lhc.shared_tech.derivation import ChunkPolicyConfig, LeaseConfig, SdkConfig
from lhc.shared_tech.deterministic import deterministic_text
from lhc.shared_tech.errors import OpResult
from lhc.shared_tech.token_counting import estimate_tokens
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


# One closed prompt+answer turn (m1 prompt, t1), drained ready. Under the
# default chunk policy t1's chunk stays open, so no chunk summary rows exist.
async def _ready_turn_thread(sdk: Lhc, store: TempStore) -> str:
    file_path = await _new_thread(store)
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "original prompt"}}),
            valid_event("assistant_text", {"payload": {"text": "the original answer"}}),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path)
    return file_path


# The full mutation read-back surface in one snapshot: record, forms, queue.
async def _snapshot(file_path: str) -> object:
    return {
        "messages": _unwrap(await messages.list({"filePath": file_path})),
        "derivations": read_derived_forms(file_path),
        "queue": _raw_detail(file_path),
    }


async def _until(cond, what: str, timeout_ms: float = 5000) -> None:
    start = time.monotonic()
    while not cond():
        if (time.monotonic() - start) * 1000 > timeout_ms:
            raise RuntimeError(f"timed out waiting for {what}")
        await asyncio.sleep(0.005)


async def test_changes_the_record_in_the_edits_transaction_and_names_cleared_forms_and_queued_items(
    store: TempStore,
) -> None:
    """changes the record in the edit's transaction and names cleared forms and queued items"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _ready_turn_thread(sdk, store)

    result = await messages.edit(
        {"filePath": file_path}, EditInput(message_id="m1", content="edited prompt")
    )
    assert result.ok is True
    if not result.ok:
        return
    assert result.value.changed.message_ids == ["m1"]
    assert result.value.changed.turn_ids == []
    assert result.value.dropped == []
    # The chain above m1: its own smoothing and t1's two forms. t1's chunk is
    # still open — no summary rows exist, so none are named.
    assert sorted(_clear_key(c) for c in result.value.cleared) == sorted(
        [
            "message/m1/smoothed_prompt",
            "turn/t1/detailed_turn_compression",
            "turn/t1/pre_detailed_assembly",
            "turn/t1/turn_rendering",
        ]
    )
    assert sorted(result.value.queued, key=lambda a: a.work_item_id) == [
        MutationQueuedWork(work_item_id="w-m1-prompt_smoothing-v2", kind="prompt_smoothing"),
        MutationQueuedWork(
            work_item_id="w-t1-detailed_turn_compression-v2", kind="detailed_turn_compression"
        ),
        MutationQueuedWork(work_item_id="w-t1-turn_derivation-v2", kind="turn_derivation"),
    ]
    assert result.value.superseded == []

    # Synchronous, before any drain: content, blocks, and the re-stamped
    # estimate read back changed.
    listed = _unwrap(await messages.list({"filePath": file_path}))
    assert isinstance(listed, list)
    m1 = next((record for record in listed if record.message_id == "m1"), None)
    assert m1 is not None
    assert m1.blocks == [Block(block_type="text", content={"text": "edited prompt"})]
    assert m1.token_estimate == estimate_tokens("edited prompt")

    # The queued rebuilds run through the normal drain and derive from the
    # edited content.
    await _drain(sdk, file_path)
    smoothing = next(
        (
            form
            for form in read_derived_forms(file_path)
            if form.subject_id == "m1" and form.derivation_type == "smoothed_prompt"
        ),
        None,
    )
    assert smoothing is not None
    assert smoothing.state == "ready"
    assert smoothing.content == deterministic_text(
        "smoothPrompt", {"text": "edited prompt"}, "edited prompt"
    )


async def test_induced_cascade_failure_rolls_back_the_content_change_too_atomicity_architecture_risk(
    store: TempStore,
) -> None:
    """induced cascade failure rolls back the content change too (atomicity, architecture risk)"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _ready_turn_thread(sdk, store)

    # Plant a claimed row at the exact id the cascade's replacement enqueue
    # will insert. Supersede only deletes queued rows, so the insert hits a
    # primary-key conflict mid-cascade — after the content apply — and the
    # transaction must roll back whole.
    db = open_raw(file_path)
    db.prepare(
        """INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
       VALUES (?, 'messages', 'prompt_smoothing', ?, 'claimed', ?, ?)"""
    ).run(
        "w-m1-prompt_smoothing-v2",
        json.dumps({"messageId": "m1"}, separators=(",", ":")),
        "2026-06-11T00:00:00.000Z",
        json.dumps({"sourceVersion": 2, "derivations": []}, separators=(",", ":")),
    )
    db.close()

    before = await _snapshot(file_path)
    result = await messages.edit(
        {"filePath": file_path}, EditInput(message_id="m1", content="edited prompt")
    )
    assert result.ok is False
    if result.ok:
        return
    assert result.error.code == "storage_failure"
    # Nothing changed: not the message content, not the estimate, not a
    # single form state or source version, not the queue.
    assert await _snapshot(file_path) == before


async def test_clears_exactly_the_edited_messages_chain_the_second_chunks_forms_are_byte_stable(
    store: TempStore,
) -> None:
    """clears exactly the edited message's chain; the second chunk's forms are byte-stable"""
    double = create_inference_callbacks_double()
    # max=1: every turn's compression meets the maximum, so each turn forms
    # its own immediately closed chunk — two chunks, both with summaries.
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
    # Fixture sanity: both chunks closed with every form ready.
    assert sorted(_clear_key(form) for form in before) == sorted(
        [
            "message/m1/smoothed_prompt",
            "message/m4/smoothed_prompt",
            "turn/t1/detailed_turn_compression",
            "turn/t1/pre_detailed_assembly",
            "turn/t1/turn_rendering",
            "turn/t2/detailed_turn_compression",
            "turn/t2/pre_detailed_assembly",
            "turn/t2/turn_rendering",
            "chunk/c1/chunk_summary_brief",
            "chunk/c1/chunk_summary_detailed",
            "chunk/c2/chunk_summary_brief",
            "chunk/c2/chunk_summary_detailed",
        ]
    )
    assert all(form.state == "ready" for form in before)

    result = await messages.edit(
        {"filePath": file_path}, EditInput(message_id="m1", content="rewritten first prompt")
    )
    assert result.ok is True
    if not result.ok:
        return

    # The cleared set is exactly the chain: m1's forms, t1's two, c1's two.
    assert sorted(_clear_key(c) for c in result.value.cleared) == sorted(
        [
            "message/m1/smoothed_prompt",
            "turn/t1/detailed_turn_compression",
            "turn/t1/pre_detailed_assembly",
            "turn/t1/turn_rendering",
            "chunk/c1/chunk_summary_brief",
            "chunk/c1/chunk_summary_detailed",
        ]
    )

    # The untouched-set half: every form outside the chain — chunk 2's
    # summaries, t2's forms, m4's smoothing — deep-equal their pre-edit rows,
    # state and source version included.
    cleared_set = {_clear_key(c) for c in result.value.cleared}
    after = read_derived_forms(file_path)
    assert [form for form in after if _clear_key(form) not in cleared_set] == [
        form for form in before if _clear_key(form) not in cleared_set
    ]
    # And the cleared half sits pending at the bumped version.
    for form in [candidate for candidate in after if _clear_key(candidate) in cleared_set]:
        assert form.state == "pending"
        assert form.source_version == 2
        assert form.content is None


async def test_clears_to_pending_with_version_scoped_replacement_ids_and_a_second_edit_supersedes_the_still_queued_first_wave(
    store: TempStore,
) -> None:
    """clears to pending with version-scoped replacement ids, and a second edit supersedes the still-queued first wave"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(
        double,
        chunk_policy=ChunkPolicyConfig(target_projected_tokens=1, max_projected_tokens=1),
    )
    file_path = await _new_thread(store)
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "original prompt"}}),
            valid_event("assistant_text", {"payload": {"text": "the answer"}}),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path)
    assert all(form.state == "ready" for form in read_derived_forms(file_path))

    first_wave_ids = [
        "w-c1-chunk_summary_brief-v2",
        "w-c1-chunk_summary_detailed-v2",
        "w-m1-prompt_smoothing-v2",
        "w-t1-detailed_turn_compression-v2",
        "w-t1-turn_derivation-v2",
    ]

    # Edit while everything is ready: every dependent form leaves ready in
    # the edit's transaction, replacement items carry the new source version
    # in their ids and payloads, and nothing was queued to supersede.
    first = await messages.edit(
        {"filePath": file_path}, EditInput(message_id="m1", content="first edit")
    )
    assert first.ok is True
    if not first.ok:
        return
    assert first.value.superseded == []
    assert sorted(item.work_item_id for item in first.value.queued) == first_wave_ids
    forms_after_first = read_derived_forms(file_path)
    assert all(form.state == "pending" for form in forms_after_first)
    assert all(form.source_version == 2 for form in forms_after_first)
    queue_after_first = _raw_detail(file_path)
    assert sorted(row.work_item_id for row in queue_after_first) == first_wave_ids
    assert all(row.status == "queued" and row.source_version == 2 for row in queue_after_first)

    # Second edit before any drain: the still-queued first wave is
    # supersede-deleted in the cascade transaction and reported; the queue
    # holds only the v3 replacements.
    second = await messages.edit(
        {"filePath": file_path}, EditInput(message_id="m1", content="second edit")
    )
    assert second.ok is True
    if not second.ok:
        return
    assert sorted(second.value.superseded) == first_wave_ids
    queue_after_second = _raw_detail(file_path)
    assert sorted(row.work_item_id for row in queue_after_second) == [
        "w-c1-chunk_summary_brief-v3",
        "w-c1-chunk_summary_detailed-v3",
        "w-m1-prompt_smoothing-v3",
        "w-t1-detailed_turn_compression-v3",
        "w-t1-turn_derivation-v3",
    ]
    assert all(
        form.state == "pending" and form.source_version == 3
        for form in read_derived_forms(file_path)
    )

    # And the drain rebuilds the whole chain from the second edit's content.
    await _drain(sdk, file_path)
    smoothing = next(
        (
            form
            for form in read_derived_forms(file_path)
            if form.subject_id == "m1" and form.derivation_type == "smoothed_prompt"
        ),
        None,
    )
    assert smoothing is not None
    assert smoothing.state == "ready"
    assert smoothing.content == deterministic_text(
        "smoothPrompt", {"text": "second edit"}, "second edit"
    )


async def test_a_claimed_pre_edit_item_completing_after_the_edit_discards_as_stale_discarded_the_post_edit_artifact_wins(
    store: TempStore,
) -> None:
    """a claimed pre-edit item completing after the edit discards as stale_discarded; the post-edit artifact wins"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "original prompt"}}),
            valid_event("turn_end"),
        ],
    )

    # Hold the old-content smoothing in flight: the drain claims it, the
    # handler awaits the delayed double, and the edit lands inside that
    # window — a real claimed old-version item held across the edit, not a
    # simulated version poke.
    double.delay_kind("prompt_smoothing", 400)
    captured = double.capture_inputs()
    drain_promise = asyncio.create_task(sdk.work.drain({"filePath": file_path}))
    await _until(
        lambda: any(call.op == "smoothPrompt" for call in captured),
        "the old-content smoothing to be claimed and in-handler",
    )

    edited = await messages.edit(
        {"filePath": file_path}, EditInput(message_id="m1", content="edited prompt")
    )
    assert edited.ok is True
    if not edited.ok:
        return
    # The still-queued turn derivation behind the claimed head was
    # superseded; the claimed item was left to the version check.
    assert edited.value.superseded == ["w-t1-turn_derivation-v1"]

    # Old claimed item and post-edit replacement coexist — ids include the
    # source version, so they never collide.
    mid = _raw_detail(file_path)
    assert [(row.work_item_id, row.status) for row in mid] == [
        ("w-m1-prompt_smoothing-v1", "claimed"),
        ("w-m1-prompt_smoothing-v2", "queued"),
        ("w-t1-turn_derivation-v2", "queued"),
    ]

    # Let both complete. The straggler's completion is a normal completion
    # reported stale_discarded — not an error — and the drain
    # continues into the replacement work.
    drained = await drain_promise
    assert drained.ok is True
    if not drained.ok:
        return
    assert [(entry.work_item_id, entry.disposition) for entry in drained.value.ran] == [
        ("w-m1-prompt_smoothing-v1", "stale_discarded"),
        ("w-m1-prompt_smoothing-v2", "done"),
        ("w-t1-turn_derivation-v2", "done"),
        ("w-t1-detailed_turn_compression-v2", "done"),
    ]

    # Exactly one ready smoothing row, derived from the post-edit content at
    # the post-edit source version — regardless of completion order.
    rows = [
        form
        for form in read_derived_forms(file_path)
        if form.subject_id == "m1" and form.derivation_type == "smoothed_prompt"
    ]
    assert len(rows) == 1
    assert rows[0].state == "ready"
    assert rows[0].source_version == 2
    assert rows[0].content == deterministic_text(
        "smoothPrompt", {"text": "edited prompt"}, "edited prompt"
    )
    assert _raw_detail(file_path) == []


async def test_refuses_open_turn_missing_and_deleted_targets_read_back_identical_after_each(
    store: TempStore,
) -> None:
    """refuses open-turn, missing, and deleted targets; read-back identical after each"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)
    # m1 in closed t1; m3 in open t2.
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "closed prompt"}}),
            valid_event("turn_end"),
            valid_event("user_prompt", {"payload": {"text": "open prompt"}}),
        ],
    )
    before = await _snapshot(file_path)

    open_turn = await messages.edit(
        {"filePath": file_path}, EditInput(message_id="m3", content="nope")
    )
    assert open_turn.ok is False
    if open_turn.ok:
        return
    assert open_turn.error.error_class == "caller_error"
    assert open_turn.error.code == "turn_open"
    assert await _snapshot(file_path) == before

    missing = await messages.edit(
        {"filePath": file_path}, EditInput(message_id="m99", content="nope")
    )
    assert missing.ok is False
    if missing.ok:
        return
    assert missing.error.error_class == "caller_error"
    assert missing.error.code == "message_not_found"
    assert await _snapshot(file_path) == before

    # A deleted target reads as message_not_found through the filtered view
    # — never a distinct error. (deleted_at stamped below the SDK: the
    # delete operation itself is Story 6.)
    db = open_raw(file_path)
    db.prepare("UPDATE message SET deleted_at = ? WHERE message_id = 'm1'").run(
        "2026-06-11T00:00:00.000Z"
    )
    db.close()
    after_stamp = await _snapshot(file_path)
    deleted = await messages.edit(
        {"filePath": file_path}, EditInput(message_id="m1", content="nope")
    )
    assert deleted.ok is False
    if deleted.ok:
        return
    assert deleted.error.code == "message_not_found"
    assert await _snapshot(file_path) == after_stamp


async def test_refuses_an_open_turn_target_under_the_closed_turn_boundary_read_back_unchanged(
    store: TempStore,
) -> None:
    """refuses an open-turn target under the closed-turn boundary; read-back unchanged"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)
    # A note before any prompt attaches to the initialized open turn. It
    # exists and is not deleted; the open-turn boundary refuses the edit.
    await _send(
        sdk,
        file_path,
        [valid_event("runtime_note", {"payload": {"text": "a note before any turn"}})],
    )
    listed = _unwrap(await messages.list({"filePath": file_path}))
    assert isinstance(listed, list)
    m1 = next((record for record in listed if record.message_id == "m1"), None)
    assert m1 is not None
    assert m1.turn_id == "t1"

    before = await _snapshot(file_path)
    open_turn = await messages.edit(
        {"filePath": file_path}, EditInput(message_id="m1", content="nope")
    )
    assert open_turn.ok is False
    if open_turn.ok:
        return
    assert open_turn.error.error_class == "caller_error"
    assert open_turn.error.code == "turn_open"
    assert await _snapshot(file_path) == before


async def test_the_cascades_enqueue_pokes_ride_the_commit_rebuilds_run_with_no_further_call(
    store: TempStore,
) -> None:
    """the cascade's enqueue pokes ride the commit; rebuilds run with no further call"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double, mode="background")
    file_path = await _new_thread(store)
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "original prompt"}}),
            valid_event("assistant_text", {"payload": {"text": "the answer"}}),
            valid_event("turn_end"),
        ],
    )
    await sdk.drain_settled({"filePath": file_path})
    assert all(form.state == "ready" for form in read_derived_forms(file_path))

    result: OpResult[MutationResult] = await messages.edit(
        {"filePath": file_path}, EditInput(message_id="m1", content="edited prompt")
    )
    assert result.ok is True
    await sdk.drain_settled({"filePath": file_path})

    smoothing = next(
        (
            form
            for form in read_derived_forms(file_path)
            if form.subject_id == "m1" and form.derivation_type == "smoothed_prompt"
        ),
        None,
    )
    assert smoothing is not None
    assert smoothing.state == "ready"
    assert smoothing.source_version == 2
    assert smoothing.content == deterministic_text(
        "smoothPrompt", {"text": "edited prompt"}, "edited prompt"
    )
    assert _raw_detail(file_path) == []
