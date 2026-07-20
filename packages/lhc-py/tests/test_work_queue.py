"""Ported from packages/lhc/test/work-queue.test.ts. Phase 1.

Story 5 (Chunk 5): derivation work queueing. TC-2.6 (complete batch
result), TC-2.7/TC-2.9 (message-owned work and its kind gate), the work
halves of TC-3.3/TC-3.6 (Story 4's named debt, paid here), TC-3.8's
two-work-items assertion, TC-5.4's no-work-item clause, and the two
architecture-risk regressions: restart survival extended to work items and
the complete-surface rollback. Work items are asserted below the SDK with
direct queue reads — never through the batch result alone.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timezone

import pytest

from lhc import (
    WORK_KIND_REGISTRY,
    DurableWorkDispatcher,
    MessageEventInput,
    WorkHandler,
    WorkItemRecord,
    WorkOwner,
    create_db_write_transaction,
    intake_stream,
    list_items,
    lookup_work_dispatcher,
    lookup_work_handler,
    map_work_q_handlers,
    messages,
    set_scheduler_poke,
    threads,
    turns,
)
from lhc.intake_stream import BatchEventOutcome, QueuedWorkItem, ThreadPosition, TurnTransition
from lhc.shared_tech.derivation import HandlerOk
from lhc.shared_tech.durable_work import DurableWorkDispatchSettled, MessagesDeriveOperation
from lhc.shared_tech.work_queue import (
    EnqueueDerivationTarget,
    EnqueueInput,
    WorkSourceRefChunk,
    WorkSourceRefMessage,
    WorkSourceRefTurn,
    _WorkKindRegistryEntry,
    enqueue,
)
from lhc.threads import NewThreadInput
from fixtures import (
    TempStore,
    open_raw,
    read_derived_forms,
    set_intake_clock,
    set_intake_walk_hook,
    temp_store,
    valid_event,
)


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()
    # Single teardown finalizer for every seam this file's afterEach blocks
    # reset (TS splits this across two afterEach hooks); folded into one
    # fixture so a Phase 1 NotImplementedError from one reset doesn't collide
    # with another into an ExceptionGroup the gate's classifier can't unwrap.
    set_intake_clock(None)
    set_scheduler_poke(None)
    set_intake_walk_hook(None)


async def _create_thread(store: TempStore) -> str:
    file_path = store.thread_path()
    created = await threads.new_thread(NewThreadInput(file_path=file_path, registry_path=store.registry_path))
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")
    return file_path


async def _send(file_path: str, batch: list[MessageEventInput]):
    result = await intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(f"fixture batch failed: {result.error.reason}")
    return result.value


def _queued_for(file_path: str, owner: WorkOwner) -> list[WorkItemRecord]:
    db = open_raw(file_path)
    try:
        return list_items(db, owner)
    finally:
        db.close()


# Below-SDK count of durable work-item rows: the batch result alone is not
# proof of durability (anti-shim requirement).
def _raw_work_item_count(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        row = db.prepare("SELECT COUNT(*) AS n FROM work_item").get()
        return int(row["n"])
    finally:
        db.close()


# Full logical read-back across every record kind the epic owns — the
# complete-surface rollback regression compares this whole.
async def _read_back(file_path: str) -> dict[str, object]:
    events = await intake_stream.list_events({"filePath": file_path})
    projected = await messages.list({"filePath": file_path})
    turn_records = await turns.list_turns({"filePath": file_path})
    message_work = _queued_for(file_path, "messages")
    turn_work = _queued_for(file_path, "turns")
    if not events.ok or not projected.ok or not turn_records.ok:
        raise RuntimeError("read-back failed")
    return {
        "events": events.value,
        "messages": projected.value,
        "turns": turn_records.value,
        "messageWork": message_work,
        "turnWork": turn_work,
    }


_FIXED_INSTANT = "2026-06-10T12:00:00.000Z"
_FIXED_DATETIME = datetime(2026, 6, 10, 12, 0, 0, tzinfo=timezone.utc)


async def test_tc_2_7_a_prompt_and_a_tool_result_each_durably_queue_their_kind_owner_messages(
    store: TempStore,
) -> None:
    """TC-2.7: a prompt and a tool result each durably queue their kind, owner messages (AC-2.8)"""
    set_intake_clock(lambda: _FIXED_DATETIME)
    file_path = await _create_thread(store)
    result = await _send(file_path, [valid_event("user_prompt"), valid_event("tool_result")])

    # The batch result reports both items with full identity.
    assert QueuedWorkItem(
        work_item_id="w-m1-prompt_smoothing-v1",
        owner="messages",
        kind="prompt_smoothing",
        source_ref=WorkSourceRefMessage(message_id="m1"),
    ) in result.queued_work
    assert QueuedWorkItem(
        work_item_id="w-m2-tool_result_summary-v1",
        owner="messages",
        kind="tool_result_summary",
        source_ref=WorkSourceRefMessage(message_id="m2"),
    ) in result.queued_work

    # Durable read-back through the owning domain: deterministic ids, status
    # queued, queuedAt from the injected clock.
    assert _queued_for(file_path, "messages") == [
        WorkItemRecord(
            work_item_id="w-m1-prompt_smoothing-v1",
            owner="messages",
            kind="prompt_smoothing",
            source_ref=WorkSourceRefMessage(message_id="m1"),
            status="queued",
            queued_at=_FIXED_INSTANT,
        ),
        WorkItemRecord(
            work_item_id="w-m2-tool_result_summary-v1",
            owner="messages",
            kind="tool_result_summary",
            source_ref=WorkSourceRefMessage(message_id="m2"),
            status="queued",
            queued_at=_FIXED_INSTANT,
        ),
    ]

    # The prompt opened a turn that is still open: no turn-owned work yet,
    # and each domain reads back only its own items.
    assert _queued_for(file_path, "turns") == []
    assert _raw_work_item_count(file_path) == 2


async def test_tc_2_9_text_thinking_and_note_messages_queue_nothing_the_kind_gate_is_exact(
    store: TempStore,
) -> None:
    """TC-2.9: text, thinking, and note messages queue nothing — the kind gate is exact (AC-2.8)"""
    file_path = await _create_thread(store)
    result = await _send(
        file_path,
        [
            valid_event("assistant_text"),
            valid_event("assistant_thinking"),
            valid_event("runtime_note"),
        ],
    )
    assert result.queued_work == []
    assert _queued_for(file_path, "messages") == []
    assert _queued_for(file_path, "turns") == []
    assert _raw_work_item_count(file_path) == 0


async def test_tc_2_6_a_mixed_batchs_result_is_complete(store: TempStore) -> None:
    """TC-2.6: a mixed batch's result is complete — outcomes, messageIds, transitions, queuedWork, position (AC-2.7)"""
    file_path = await _create_thread(store)
    original = valid_event("user_prompt")
    await _send(file_path, [original])

    result = await _send(
        file_path,
        [
            original,  # duplicate: skipped
            valid_event("assistant_text"),
            valid_event("turn_end"),
        ],
    )

    assert result.events[0] == BatchEventOutcome(
        idempotency_key=original["idempotencyKey"],
        outcome="skipped",
        skip_reason="duplicate_idempotency_key",
    )
    assert result.events[1].outcome == "recorded"
    assert result.events[1].message_id == "m2"
    assert result.events[2].outcome == "recorded"
    # turn_end produces no message.
    assert result.events[2].message_id is None
    assert result.turn_transitions == [
        TurnTransition(action="closed", turn_id="t1"),
        TurnTransition(action="opened", turn_id="t2"),
    ]
    assert result.queued_work == [
        QueuedWorkItem(
            work_item_id="w-t1-turn_derivation-v1",
            owner="turns",
            kind="turn_derivation",
            source_ref=WorkSourceRefTurn(turn_id="t1"),
        )
    ]
    assert result.thread_position == ThreadPosition(last_event_order=3)


async def test_tc_3_3_work_half_explicit_close_durably_queues_turn_derivation_owner_turns(
    store: TempStore,
) -> None:
    """TC-3.3 (work half): explicit close durably queues w-t1-turn_derivation, owner turns (AC-3.4, AC-3.6)"""
    set_intake_clock(lambda: _FIXED_DATETIME)
    file_path = await _create_thread(store)
    result = await _send(
        file_path,
        [
            valid_event("user_prompt"),
            valid_event("assistant_text"),
            valid_event("turn_end"),
        ],
    )

    assert QueuedWorkItem(
        work_item_id="w-t1-turn_derivation-v1",
        owner="turns",
        kind="turn_derivation",
        source_ref=WorkSourceRefTurn(turn_id="t1"),
    ) in result.queued_work
    assert _queued_for(file_path, "turns") == [
        WorkItemRecord(
            work_item_id="w-t1-turn_derivation-v1",
            owner="turns",
            kind="turn_derivation",
            source_ref=WorkSourceRefTurn(turn_id="t1"),
            status="queued",
            queued_at=_FIXED_INSTANT,
        )
    ]


async def test_tc_3_6_work_half_implicit_close_queues_the_same_work_item_contract(
    store: TempStore,
) -> None:
    """TC-3.6 (work half): implicit close queues the same work-item contract as the explicit path (AC-3.6)"""
    explicit_path = await _create_thread(store)
    await _send(explicit_path, [valid_event("user_prompt"), valid_event("assistant_text")])
    await _send(explicit_path, [valid_event("turn_end")])

    implicit_path = await _create_thread(store)
    await _send(implicit_path, [valid_event("user_prompt"), valid_event("assistant_text")])
    await _send(implicit_path, [valid_event("user_prompt")])

    explicit_items = _queued_for(explicit_path, "turns")
    implicit_items = _queued_for(implicit_path, "turns")
    assert len(explicit_items) == 1

    # Same item contract modulo queuedAt (wall clock differs between runs).
    def contract(items: list[WorkItemRecord]) -> list[WorkItemRecord]:
        return [dataclasses.replace(item, queued_at="") for item in items]

    assert contract(implicit_items) == contract(explicit_items)
    assert contract(explicit_items) == [
        WorkItemRecord(
            work_item_id="w-t1-turn_derivation-v1",
            owner="turns",
            kind="turn_derivation",
            source_ref=WorkSourceRefTurn(turn_id="t1"),
            status="queued",
            queued_at="",
        )
    ]


async def test_tc_3_8_work_count_a_multi_turn_batch_queues_one_turn_derivation_item_per_closed_turn(
    store: TempStore,
) -> None:
    """TC-3.8 (work count): a multi-turn batch queues one turn_derivation item per closed turn (AC-3.6)"""
    file_path = await _create_thread(store)
    await _send(
        file_path,
        [
            valid_event("user_prompt"),
            valid_event("assistant_text"),
            valid_event("user_prompt"),
            valid_event("assistant_text"),
            valid_event("turn_end"),
        ],
    )

    turn_work = _queued_for(file_path, "turns")
    assert [item.work_item_id for item in turn_work] == [
        "w-t1-turn_derivation-v1",
        "w-t2-turn_derivation-v1",
    ]
    assert all(item.kind == "turn_derivation" for item in turn_work)
    assert all(item.status == "queued" for item in turn_work)


async def test_tc_5_4_no_work_item_clause_a_skipped_event_queues_nothing(store: TempStore) -> None:
    """TC-5.4 (no-work-item clause): a skipped event queues nothing (AC-5.4)"""
    file_path = await _create_thread(store)
    prompt = valid_event("user_prompt")
    end = valid_event("turn_end")
    await _send(file_path, [prompt, valid_event("assistant_text"), end])
    await _send(file_path, [valid_event("user_prompt")])  # t2 now open
    baseline = await _read_back(file_path)
    baseline_count = _raw_work_item_count(file_path)

    resend = await _send(file_path, [prompt, end])
    assert [entry.outcome for entry in resend.events] == ["skipped", "skipped"]
    assert resend.queued_work == []
    assert await _read_back(file_path) == baseline
    assert _raw_work_item_count(file_path) == baseline_count


async def test_restart_survival_a_reopened_thread_file_holds_its_work_items_intact(store: TempStore) -> None:
    """restart survival: a reopened thread file holds its work items intact, status queued"""
    file_path = await _create_thread(store)
    await _send(
        file_path,
        [
            valid_event("user_prompt"),
            valid_event("tool_call"),
            valid_event("tool_result"),
            valid_event("turn_end"),
        ],
    )
    before = await _read_back(file_path)
    assert len(before["messageWork"]) == 2
    assert len(before["turnWork"]) == 1

    # Every SDK operation opens and closes its own handle, so a fresh
    # read-back is a real reopen of the real file. The raw scan proves the
    # rows live in the thread file itself — not an in-memory queue.
    db = open_raw(file_path)
    try:
        rows = db.prepare(
            "SELECT work_item_id, status FROM work_item ORDER BY work_item_id"
        ).all()
        assert rows == [
            {"work_item_id": "w-m1-prompt_smoothing-v1", "status": "queued"},
            {"work_item_id": "w-m3-tool_result_summary-v1", "status": "queued"},
            {"work_item_id": "w-t1-turn_derivation-v1", "status": "queued"},
        ]
    finally:
        db.close()
    assert await _read_back(file_path) == before


async def test_complete_surface_rollback_a_rejected_batch_leaves_records_at_baseline(store: TempStore) -> None:
    """complete-surface rollback: a rejected batch leaves events, messages, turns, and work items at baseline (AC-4.6)"""
    file_path = await _create_thread(store)
    await _send(file_path, [valid_event("user_prompt"), valid_event("tool_result"), valid_event("turn_end")])
    baseline = await _read_back(file_path)
    baseline_count = _raw_work_item_count(file_path)

    # A valid prefix that would queue work, then one invalid event: the
    # batch must reject whole and queue nothing.
    bogus_event = {**valid_event("user_prompt"), "eventKind": "bogus"}
    rejected = await intake_stream.message_events(
        {"filePath": file_path},
        [valid_event("user_prompt"), bogus_event],
    )
    assert rejected.ok is False
    if rejected.ok:
        return
    assert rejected.error.code == "invalid_event"

    assert await _read_back(file_path) == baseline
    assert _raw_work_item_count(file_path) == baseline_count


# ── Story 0 (Epic 02): work-kind registry, handler-map assembly, and the
# enqueue wrapper's atomicity. The registry and map are FC-0.4; atomicity is
# Chunk 0's named architecture risk — row + pending form + poke all drop on
# rollback, because every later queue site (intake, cascade, repair) leans
# on that invariant.


# Below-SDK read of derivation rows — enqueue's pending rows are asserted
# durably, not through the batch result.
def _raw_form_rows(file_path: str) -> list[dict[str, str]]:
    db = open_raw(file_path)
    try:
        return db.prepare(
            """SELECT subject_kind || '/' || subject_id || '/' || derivation_type AS key, state
               FROM derivation ORDER BY key"""
        ).all()
    finally:
        db.close()


def test_the_registry_covers_all_six_kinds_with_owner_and_sourceref_semantics() -> None:
    """the registry covers all six kinds with owner and sourceRef semantics per the Work Item contract"""
    assert WORK_KIND_REGISTRY == {
        "prompt_smoothing": _WorkKindRegistryEntry(owner="messages", source_ref_key="messageId"),
        "tool_result_summary": _WorkKindRegistryEntry(owner="messages", source_ref_key="messageId"),
        "turn_derivation": _WorkKindRegistryEntry(owner="turns", source_ref_key="turnId"),
        "detailed_turn_compression": _WorkKindRegistryEntry(owner="turns", source_ref_key="turnId"),
        "chunk_summary_detailed": _WorkKindRegistryEntry(owner="turns", source_ref_key="chunkId"),
        "chunk_summary_brief": _WorkKindRegistryEntry(owner="turns", source_ref_key="chunkId"),
    }


def test_dispatcher_lookup_reports_an_unregistered_kind_as_a_structured_miss() -> None:
    """dispatcher lookup reports an unregistered kind as a structured miss"""

    async def _dispatcher(run, item):
        return DurableWorkDispatchSettled(disposition="done")

    dispatcher: DurableWorkDispatcher = _dispatcher
    found = lookup_work_dispatcher(
        {"messages.derive": dispatcher},
        MessagesDeriveOperation(message_id="m1"),
        "prompt_smoothing",
    )
    assert found.ok is True
    missed = lookup_work_dispatcher({}, MessagesDeriveOperation(message_id="m1"), "bogus_kind")
    assert missed.ok is False
    if missed.ok:
        return
    assert missed.error.error_class == "state_corruption"
    assert missed.error.code == "unknown_work_kind"
    assert "bogus_kind" in missed.error.reason


def test_assembly_merges_per_domain_tables_dispatch_finds_a_handler_and_a_doubly_claimed_kind_is_refused() -> None:
    """assembly merges per-domain tables, dispatch finds a registered handler, and a doubly-claimed kind is refused"""

    async def _handler(run, item):
        return HandlerOk()

    handler: WorkHandler = _handler
    map_ = map_work_q_handlers([{"prompt_smoothing": handler}, {"turn_derivation": handler}])
    found = lookup_work_handler(map_, "prompt_smoothing")
    assert found.ok is True
    if not found.ok:
        return
    assert found.value is handler
    missed = lookup_work_handler(map_, "chunk_summary_brief")
    assert missed.ok is False
    # One owner per kind: a second table claiming the same kind is a wiring
    # bug surfaced at construction.
    with pytest.raises(Exception, match="prompt_smoothing"):
        map_work_q_handlers([{"prompt_smoothing": handler}, {"prompt_smoothing": handler}])


async def test_a_committed_intake_batch_durably_writes_work_rows_pending_forms_and_pokes_once_per_enqueue(
    store: TempStore,
) -> None:
    """a committed intake batch durably writes work rows + pending forms and pokes once per enqueue, after commit"""
    file_path = await _create_thread(store)
    pokes: list[str] = []
    set_scheduler_poke(lambda thread_id: pokes.append(thread_id))

    result = await _send(
        file_path,
        [valid_event("user_prompt"), valid_event("assistant_text"), valid_event("turn_end")],
    )
    # Two enqueues (prompt smoothing + turn derivation) → two pokes, both
    # carrying the thread's resolved id, fired only after COMMIT.
    assert len(pokes) == 2
    assert len(set(pokes)) == 1
    assert pokes[0].startswith("th_")
    assert len(result.queued_work) == 2

    # The pending state rows rode the same transaction (DD-5): one for the
    # prompt's derivation, two for the turn's rendering + pre-detailed assembly.
    assert _raw_form_rows(file_path) == [
        {"key": "message/m1/smoothed_prompt", "state": "pending"},
        {"key": "turn/t1/pre_detailed_assembly", "state": "pending"},
        {"key": "turn/t1/turn_rendering", "state": "pending"},
    ]


async def test_an_induced_rollback_after_enqueue_drops_the_work_row_form_row_and_poke(
    store: TempStore,
) -> None:
    """an induced rollback after enqueue drops the work row, the pending form row, and the poke"""
    file_path = await _create_thread(store)
    pokes: list[str] = []
    set_scheduler_poke(lambda thread_id: pokes.append(thread_id))

    # The prompt's enqueue has already run inside the walk when the hook
    # fires on the second event and rejects the batch (production rollback
    # path, same seam Epic 01's atomicity tests use).
    def _walk_hook(_db, event_index):
        if event_index == 1:
            raise RuntimeError("induced mid-walk failure after enqueue")

    set_intake_walk_hook(_walk_hook)
    rejected = await intake_stream.message_events(
        {"filePath": file_path},
        [valid_event("user_prompt"), valid_event("assistant_text")],
    )
    assert rejected.ok is False

    assert _raw_work_item_count(file_path) == 0
    assert _raw_form_rows(file_path) == []
    assert pokes == []


async def test_enqueue_via_create_db_write_transaction_rollback_drops_effects_commit_lands_them(
    store: TempStore,
) -> None:
    """enqueue via createDbWriteTransaction: rollback drops all three effects; commit lands them and then pokes"""
    file_path = await _create_thread(store)
    pokes: list[str] = []
    set_scheduler_poke(lambda thread_id: pokes.append(thread_id))
    clock = lambda: _FIXED_DATETIME  # noqa: E731

    # Rollback leg: the body enqueues, then throws.
    def _rollback_body(transaction):
        enqueue(
            transaction,
            EnqueueInput(
                owner="turns",
                kind="chunk_summary_brief",
                source_ref=WorkSourceRefChunk(chunk_id="c1"),
                derivations=[
                    EnqueueDerivationTarget(
                        subject_kind="chunk", subject_id="c1", derivation_type="chunk_summary_brief"
                    )
                ],
            ),
        )
        raise RuntimeError("induced rollback")

    with pytest.raises(RuntimeError, match="induced rollback"):
        await create_db_write_transaction({"filePath": file_path}, _rollback_body, clock)
    assert _raw_work_item_count(file_path) == 0
    assert _raw_form_rows(file_path) == []
    assert pokes == []

    # Commit leg: same enqueue, no failure — and the poke fires after the
    # body, not inside it.
    def _commit_body(transaction):
        record = enqueue(
            transaction,
            EnqueueInput(
                owner="turns",
                kind="chunk_summary_brief",
                source_ref=WorkSourceRefChunk(chunk_id="c1"),
                derivations=[
                    EnqueueDerivationTarget(
                        subject_kind="chunk", subject_id="c1", derivation_type="chunk_summary_brief"
                    )
                ],
            ),
        )
        assert pokes == []
        return record

    committed = await create_db_write_transaction({"filePath": file_path}, _commit_body, clock)
    assert committed.ok is True
    if not committed.ok:
        return
    assert committed.value.work_item_id == "w-c1-chunk_summary_brief-v1"
    assert len(pokes) == 1
    assert pokes[0].startswith("th_")
    assert _raw_form_rows(file_path) == [{"key": "chunk/c1/chunk_summary_brief", "state": "pending"}]


async def test_re_enqueueing_at_a_later_source_version_resets_the_form_row_to_pending(
    store: TempStore,
) -> None:
    """re-enqueueing at a later source version resets the form row to pending at that version"""
    file_path = await _create_thread(store)
    clock = lambda: _FIXED_DATETIME  # noqa: E731

    def _initial_body(transaction):
        enqueue(
            transaction,
            EnqueueInput(
                owner="messages",
                kind="prompt_smoothing",
                source_ref=WorkSourceRefMessage(message_id="mx"),
                derivations=[
                    EnqueueDerivationTarget(
                        subject_kind="message", subject_id="mx", derivation_type="smoothed_prompt"
                    )
                ],
            ),
        )

    queued = await create_db_write_transaction({"filePath": file_path}, _initial_body, clock)
    assert queued.ok is True

    # Versioned ids let the replacement coexist with (not collide into)
    # the version-1 item (DD-1/DD-3).
    def _replacement_body(transaction):
        return enqueue(
            transaction,
            EnqueueInput(
                owner="messages",
                kind="prompt_smoothing",
                source_ref=WorkSourceRefMessage(message_id="mx"),
                source_version=2,
                derivations=[
                    EnqueueDerivationTarget(
                        subject_kind="message", subject_id="mx", derivation_type="smoothed_prompt"
                    )
                ],
            ),
        )

    replacement = await create_db_write_transaction({"filePath": file_path}, _replacement_body, clock)
    assert replacement.ok is True
    if not replacement.ok:
        return
    assert replacement.value.work_item_id == "w-mx-prompt_smoothing-v2"
    forms = read_derived_forms(file_path)
    assert len(forms) == 1
    assert forms[0].subject_kind == "message"
    assert forms[0].subject_id == "mx"
    assert forms[0].derivation_type == "smoothed_prompt"
    assert forms[0].state == "pending"
    assert forms[0].source_version == 2
    assert _raw_work_item_count(file_path) == 2
