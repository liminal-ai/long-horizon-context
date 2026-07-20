"""Ported from packages/lhc/test/work-execution.test.ts. Phase 1.

Story 1 (Epic 02): queue execution and drain — Flow 1, in-process half.
Claim/lease mechanics, queue-order dispatch, terminal dispositions (reported
then deleted, DD-1), unknown-kind handling, both host modes, and coalesced
background scheduling. The cross-process legs (TC-1.3 kill, TC-1.4 claim
exclusion, CLI parity) live in cli-process-work.test.ts (not ported here).
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Sequence
from datetime import datetime, timezone
from typing import Literal

import pytest

from lhc import (
    Derivation,
    DrainReport,
    DurableWorkDispatcher,
    HandlerDerivationWrite,
    InferenceCallbacks,
    InferenceResult,
    Lhc,
    MessageEventInput,
    apply_derivation_success,
    count_live_items,
    init_lhc,
    intake_stream,
    queue_detail,
    register_testing_work,
    set_scheduler_poke,
    set_thread_touch,
    threads,
)
from lhc.shared_tech.durable_work import DerivationAttempt
from lhc.threads import NewThreadInput
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
    open_raw,
    read_derived_forms,
    register_test_work_handlers,
    temp_store,
    valid_event,
)


async def _sleep(ms: float) -> None:
    await asyncio.sleep(ms / 1000)


async def _until(pred, what: str, timeout_ms: float = 3000) -> None:
    start = time.monotonic()
    while not pred():
        if (time.monotonic() - start) * 1000 > timeout_ms:
            raise RuntimeError(f"timed out waiting for {what}")
        await _sleep(5)


@pytest.fixture
def store():
    s = temp_store()
    yield s
    # Background-mode SDKs install process-wide seams at construction; tests
    # must not leak them into each other.
    set_scheduler_poke(None)
    set_thread_touch(None)
    s.cleanup()


async def _new_thread(store: TempStore) -> dict[str, str]:
    created = await threads.new_thread(
        NewThreadInput(file_path=store.thread_path(), registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(f"thread creation failed: {created.error.reason}")
    return {"threadId": created.value.thread_id, "filePath": created.value.file_path}


async def _send(sdk: Lhc, file_path: str, batch: Sequence[MessageEventInput]) -> None:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(f"batch failed: {result.error.reason}")


def _manual_sdk(double: InferenceCallbacks, clock=None) -> Lhc:
    sdk = init_lhc(
        {
            "inferenceCallbacks": double,
            "mode": "manual",
            "clock": clock if clock is not None else (lambda: datetime.now(timezone.utc)),
            "lease": {"durationMs": 200},
            "guards": {"detailedTurnCompression": {"tinyTurnTokens": 1}},
        }
    )
    register_test_work_handlers(sdk, double)
    return sdk


async def _drain(sdk: Lhc, file_path: str, max_items: int | None = None) -> DrainReport:
    opts = {"maxItems": max_items} if max_items is not None else None
    result = await sdk.work.drain({"filePath": file_path}, opts)
    if not result.ok:
        raise RuntimeError(f"drain failed: {result.error.reason}")
    return result.value


def _live_count(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        return count_live_items(db)
    finally:
        db.close()


def _live_detail(file_path: str):
    db = open_raw(file_path)
    try:
        return queue_detail(db)
    finally:
        db.close()


def _claim_head_work_item(file_path: str, expires_at: str) -> None:
    db = open_raw(file_path)
    try:
        db.exec("BEGIN IMMEDIATE;")
        try:
            claimed_at = datetime.fromtimestamp(
                datetime.fromisoformat(expires_at.replace("Z", "+00:00")).timestamp() - 1, tz=timezone.utc
            ).isoformat().replace("+00:00", "Z")
            changed = db.prepare(
                """UPDATE work_item
                   SET status = 'claimed',
                       claimed_at = ?,
                       claim_expires_at = ?
                   WHERE work_item_id = (
                     SELECT work_item_id FROM work_item
                     WHERE status IN ('queued', 'claimed')
                     ORDER BY rowid LIMIT 1
                   )"""
            ).run(claimed_at, expires_at)
            if int(changed.changes) != 1:
                raise RuntimeError(f"expected to claim exactly one work item, changed {changed.changes}")
            db.exec("COMMIT;")
        except Exception:
            db.exec("ROLLBACK;")
            raise
    finally:
        db.close()


def _set_head_claim_expiry(file_path: str, expires_at: str | None) -> None:
    db = open_raw(file_path)
    try:
        changed = db.prepare(
            """UPDATE work_item
               SET claim_expires_at = ?
               WHERE work_item_id = (
                 SELECT work_item_id FROM work_item
                 WHERE status = 'claimed'
                 ORDER BY rowid LIMIT 1
               )"""
        ).run(expires_at)
        if int(changed.changes) != 1:
            raise RuntimeError(f"expected to update exactly one claimed work item, changed {changed.changes}")
    finally:
        db.close()


def _delete_work_item(file_path: str, work_item_id: str) -> None:
    db = open_raw(file_path)
    try:
        db.prepare("DELETE FROM work_item WHERE work_item_id = ?").run(work_item_id)
    finally:
        db.close()


def _set_ready_derivation(
    file_path: str,
    target: dict[str, str],
    content: str,
    source_version: int,
) -> None:
    db = open_raw(file_path)
    try:
        changed = db.prepare(
            """UPDATE derivation
               SET state = 'ready', content = ?, reason = NULL, metadata = NULL,
                   gaps = NULL, derived_at = ?, source_version = ?
               WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?"""
        ).run(
            content,
            "2026-06-10T12:00:01.000Z",
            source_version,
            target["subjectKind"],
            target["subjectId"],
            target["derivationType"],
        )
        if int(changed.changes) != 1:
            raise RuntimeError(f"expected to update one derivation, changed {changed.changes}")
    finally:
        db.close()


def _insert_abandoned_chunk_summary(file_path: str, chunk_id: str, derivation_type: str) -> None:
    db = open_raw(file_path)
    try:
        db.prepare(
            """INSERT INTO chunk (chunk_id, chunk_order, status, accumulated_projected_tokens)
               VALUES (?, 1, 'closed', 0)"""
        ).run(chunk_id)
        db.prepare(
            """INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
               VALUES ('chunk', ?, ?, 'pending', 1)"""
        ).run(chunk_id, derivation_type)
    finally:
        db.close()


# ── TC-1.1: a drain runs queued items one at a time, in queue order, and
# reports each disposition ──────────────────────────────────────────────


async def test_tc_1_1_three_items_across_both_owners_run_in_order_rows_deleted_at_terminal_transition_derived_at_monotone(
    store: TempStore,
) -> None:
    """TC-1.1: three items across both owners run in order; rows are deleted at terminal transition; derivedAt is monotone"""
    double = create_inference_callbacks_double()
    tick = 0
    base = datetime(2026, 6, 10, 12, 0, 0, tzinfo=timezone.utc)

    def clock() -> datetime:
        nonlocal tick
        value = base.timestamp() + tick
        tick += 1
        return datetime.fromtimestamp(value, tz=timezone.utc)

    sdk = _manual_sdk(double, clock=clock)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt"),
            valid_event("tool_call"),
            valid_event("tool_result"),
            valid_event("turn_end"),
        ],
    )
    assert _live_count(file_path) == 3

    report = await _drain(sdk, file_path)
    # Queue order across owners: m1's smoothing, m3's result summary, then
    # the turn derivation queued at close — never reordered.
    assert [entry.work_item_id for entry in report.ran] == [
        "w-m1-prompt_smoothing-v1",
        "w-m3-tool_result_summary-v1",
        "w-t1-turn_derivation-v1",
        "w-t1-detailed_turn_compression-v1",
    ]
    assert [entry.disposition for entry in report.ran] == ["done", "done", "done", "done"]
    assert report.stopped_because == "empty"
    assert report.remaining == 0

    # DD-1 storage contract: terminal rows are gone — the report is the only
    # place the dispositions exist (raw zero-row read).
    assert _live_count(file_path) == 0
    db = open_raw(file_path)
    try:
        row = db.prepare("SELECT COUNT(*) AS n FROM work_item").get()
        assert row is not None
        assert int(row["n"]) == 0
    finally:
        db.close()

    # Artifacts landed in run order: derivedAt strictly monotone with the
    # injected clock from m1 to m3 to the turn's forms.
    forms = read_derived_forms(file_path)
    assert [form.state for form in forms] == ["ready", "ready", "ready", "ready", "ready"]

    def at(subject_id: str, derivation_type: str) -> float:
        row = next(
            (f for f in forms if f.subject_id == subject_id and f.derivation_type == derivation_type), None
        )
        if row is None or row.derived_at is None:
            raise RuntimeError(f"no derivedAt for {subject_id}/{derivation_type}")
        return datetime.fromisoformat(row.derived_at.replace("Z", "+00:00")).timestamp()

    assert at("m1", "smoothed_prompt") < at("m3", "tool_result_summary")
    assert at("m3", "tool_result_summary") < at("t1", "turn_rendering")
    assert at("t1", "pre_detailed_assembly") == at("t1", "turn_rendering")
    assert at("t1", "turn_rendering") < at("t1", "detailed_turn_compression")


# ── TC-1.2 / AC-1.2: mid-drain queueing coalesces into at most one further
# pass ────────────────────────────────────────────────────────────────────


async def test_tc_1_2_a_burst_of_two_more_batches_during_a_slow_in_flight_drain_yields_exactly_two_passes_and_all_artifacts(
    store: TempStore,
) -> None:
    """TC-1.2 / AC-1.2: a burst of two more batches during a slow in-flight drain yields exactly two passes and all artifacts"""
    double = create_inference_callbacks_double()
    double.delay_kind("prompt_smoothing", 100)
    sdk = init_lhc({"inferenceCallbacks": double, "mode": "background", "lease": {"durationMs": 1000}})
    register_test_work_handlers(sdk, double)
    thread = await _new_thread(store)
    thread_id, file_path = thread["threadId"], thread["filePath"]

    await _send(sdk, file_path, [valid_event("user_prompt", {"payload": {"text": "batch A"}})])
    # Let the poked drain start (it defers one macrotask), then queue two
    # more batches while item A's slow handler is in flight.
    await _sleep(10)
    await _send(sdk, file_path, [valid_event("user_prompt", {"payload": {"text": "batch B"}})])
    await _send(sdk, file_path, [valid_event("user_prompt", {"payload": {"text": "batch C"}})])

    await sdk.drain_settled({"filePath": file_path})

    # Everything queued mid-drain was processed before the cycle ended…
    assert _live_count(file_path) == 0
    smoothed = [form for form in read_derived_forms(file_path) if form.derivation_type == "smoothed_prompt"]
    assert [form.state for form in smoothed] == ["ready", "ready", "ready"]
    # …and the burst coalesced: one initial pass plus exactly one follow-up,
    # not one pass per poke (the cost model is the assertion).
    assert sdk.scheduler.test_pass_count(thread_id) == 2


# ── TC-1.5 / AC-1.5, AC-1.6: background mode — queueing is sufficient;
# first touch catches up ──────────────────────────────────────────────────


async def test_tc_1_5_an_intake_batch_is_processed_with_no_drain_call_drain_settled_is_the_completion_signal(
    store: TempStore,
) -> None:
    """TC-1.5 / AC-1.5, AC-1.6: an intake batch is processed with no drain call; drainSettled is the completion signal"""
    double = create_inference_callbacks_double()
    sdk = init_lhc({"inferenceCallbacks": double, "mode": "background", "lease": {"durationMs": 1000}})
    register_test_work_handlers(sdk, double)
    thread = await _new_thread(store)
    file_path = thread["filePath"]

    await _send(sdk, file_path, [valid_event("user_prompt"), valid_event("turn_end")])
    await sdk.drain_settled({"filePath": file_path})

    forms = read_derived_forms(file_path)
    assert sorted(f"{form.subject_id}/{form.derivation_type}/{form.state}" for form in forms) == [
        "m1/smoothed_prompt/ready",
        "t1/detailed_turn_compression/ready",
        "t1/pre_detailed_assembly/ready",
        "t1/turn_rendering/ready",
    ]
    assert _live_count(file_path) == 0


async def test_sync_derive_queued_behind_an_older_head_wakes_the_background_scheduler(store: TempStore) -> None:
    """TC-1.5 / AC-1.5, AC-1.6: sync derive queued behind an older head wakes the background scheduler"""
    double = create_inference_callbacks_double()
    background = init_lhc({"inferenceCallbacks": double, "mode": "background", "lease": {"durationMs": 1000}})
    register_test_work_handlers(background, double)
    manual = _manual_sdk(double)
    thread = await _new_thread(store)
    thread_id, file_path = thread["threadId"], thread["filePath"]

    touched = await background.logging.write({"filePath": file_path}, {"level": "info", "message": "touch empty thread"})
    assert touched.ok is True
    await background.drain_settled({"filePath": file_path})

    await _send(
        manual,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "first prompt"}}),
            valid_event("assistant_text", {"payload": {"text": "first answer"}}),
            valid_event("turn_end"),
            valid_event("user_prompt", {"payload": {"text": "second prompt"}}),
            valid_event("assistant_text", {"payload": {"text": "second answer"}}),
            valid_event("turn_end"),
        ],
    )
    db = open_raw(file_path)
    try:
        db.prepare("DELETE FROM work_item WHERE kind = 'prompt_smoothing'").run()
        db.prepare("DELETE FROM work_item WHERE work_item_id = 'w-t2-turn_derivation-v1'").run()
    finally:
        db.close()

    queued = await background.turns.derive_turn({"filePath": file_path}, "t2")
    assert queued.ok is True
    if not queued.ok:
        return
    assert queued.value.turn_id == "t2"
    assert queued.value.outcome == "failed"
    assert queued.value.error.error_class == "caller_error"
    assert queued.value.error.code == "derivation_work_in_flight"

    await background.drain_settled({"filePath": file_path})

    assert background.scheduler.test_pass_count(thread_id) > 0
    assert _live_count(file_path) == 0
    assert sorted(
        (form.derivation_type, form.state) for form in read_derived_forms(file_path) if form.subject_id == "t2"
    ) == [
        ("detailed_turn_compression", "ready"),
        ("pre_detailed_assembly", "ready"),
        ("turn_rendering", "ready"),
    ]


async def test_reopening_a_thread_with_leftover_queued_rows_recovers_them_when_the_process_engages_message_reads_stay_pure(
    store: TempStore,
) -> None:
    """TC-1.5 / AC-1.5, AC-1.6: reopening a thread with leftover queued rows recovers them when the process engages — message reads stay pure (Epic 04 DD-6)"""
    # Build the leftover state with no background scheduler installed: rows
    # accumulate exactly as a dead process would have left them.
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    seeded = await intake_stream.message_events({"filePath": file_path}, [valid_event("user_prompt"), valid_event("turn_end")])
    assert seeded.ok is True
    assert _live_count(file_path) == 2

    double = create_inference_callbacks_double()
    sdk = init_lhc({"inferenceCallbacks": double, "mode": "background", "lease": {"durationMs": 1000}})
    register_test_work_handlers(sdk, double)

    # First touch of the thread in this process lifetime is a read. Message
    # list/show are read-only (Epic 04 DD-6, SV-01-001): like thread-view's
    # model-context/status before them, they suppress the open announcement,
    # so the read schedules no first-touch catch-up — the leftover rows stay
    # exactly as the dead process left them, and no model call fires off a
    # read.
    read = await sdk.messages.list({"filePath": file_path})
    assert read.ok is True
    await sdk.drain_settled({"filePath": file_path})
    assert _live_count(file_path) == 2

    # Recovery arrives the moment the process engages the thread through a
    # non-read path — here an explicit drain (an intake or any write touches
    # the same way). The leftover work catches up to ready.
    recovered = await sdk.work.drain({"filePath": file_path})
    assert recovered.ok is True
    await sdk.drain_settled({"filePath": file_path})

    assert _live_count(file_path) == 0
    states = [form.state for form in read_derived_forms(file_path)]
    assert states == ["ready", "ready", "ready", "ready"]


async def test_first_touch_catch_up_fails_an_expired_claimed_head_and_drains_the_item_behind_it(
    store: TempStore,
) -> None:
    """TC-1.5 / AC-1.5, AC-1.6: first-touch catch-up fails an expired claimed head and drains the item behind it"""
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    seeded = await intake_stream.message_events({"filePath": file_path}, [valid_event("user_prompt"), valid_event("turn_end")])
    assert seeded.ok is True

    expires_at = datetime.fromtimestamp(time.time() + 0.035, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    _claim_head_work_item(file_path, expires_at)
    detail = _live_detail(file_path)
    assert detail[0].work_item_id == "w-m1-prompt_smoothing-v1"
    assert detail[0].status == "claimed"
    assert detail[0].claim_expires_at == expires_at

    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = init_lhc({"inferenceCallbacks": double, "mode": "background", "lease": {"durationMs": 1000}})
    register_test_work_handlers(sdk, double)

    touched = await sdk.logging.write(
        {"filePath": file_path}, {"level": "info", "message": "touch thread for claimed-item catch-up"}
    )
    assert touched.ok is True

    await sdk.drain_settled({"filePath": file_path})

    assert len([entry for entry in captured if entry.op == "smoothPrompt"]) == 0
    assert [f"{form.subject_id}/{form.derivation_type}/{form.state}" for form in read_derived_forms(file_path)] == [
        "m1/smoothed_prompt/failed",
        "t1/detailed_turn_compression/ready",
        "t1/pre_detailed_assembly/ready",
        "t1/turn_rendering/ready",
    ]
    assert _live_count(file_path) == 0


@pytest.mark.parametrize("label,claim_expires_at", [("null", None), ("invalid", "not-a-date")])
async def test_a_claimed_head_with_claim_expires_at_is_failed_immediately(
    store: TempStore, label: str, claim_expires_at: str | None
) -> None:
    """TC-1.5 / AC-1.5, AC-1.6: a claimed head with $label claim_expires_at is failed immediately"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(sdk, file_path, [valid_event("user_prompt")])

    _claim_head_work_item(file_path, "2026-06-10T12:05:00.000Z")
    _set_head_claim_expiry(file_path, claim_expires_at)

    report = await _drain(sdk, file_path)
    assert len(report.ran) == 1
    assert report.ran[0].work_item_id == "w-m1-prompt_smoothing-v1"
    assert report.ran[0].disposition == "failed_terminal"
    assert report.ran[0].reason == "claim_expired"
    assert report.stopped_because == "empty"
    assert report.claim_expires_at is None
    assert _live_count(file_path) == 0
    forms = read_derived_forms(file_path)
    assert forms[0].state == "failed"
    assert forms[0].reason == "claim_expired"


# ── TC-1.6 / AC-1.7: manual mode — rows accumulate durably and run only
# when drain is invoked ────────────────────────────────────────────────────


async def test_tc_1_6_queued_work_sits_until_work_drain_artifacts_land_after(store: TempStore) -> None:
    """TC-1.6 / AC-1.7: queued work sits until work.drain; artifacts land after"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(sdk, file_path, [valid_event("user_prompt")])

    await _sleep(100)
    assert _live_count(file_path) == 1
    assert _live_detail(file_path)[0].status == "queued"
    assert [form.state for form in read_derived_forms(file_path)] == ["pending"]

    report = await _drain(sdk, file_path)
    assert len(report.ran) == 1
    assert report.ran[0].disposition == "done"
    assert [form.state for form in read_derived_forms(file_path)] == ["ready"]
    assert _live_count(file_path) == 0


# ── TC-1.7 / AC-1.8: an unregistered kind lands failed_terminal with a
# stable reason and the drain continues ────────────────────────────────────


async def test_tc_1_7_a_bogus_kind_row_ahead_of_a_valid_item_fails_with_unknown_work_kind_the_valid_item_still_runs(
    store: TempStore,
) -> None:
    """TC-1.7 / AC-1.8: a bogus-kind row ahead of a valid item fails with unknown_work_kind; the valid item still runs"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    thread = await _new_thread(store)
    file_path = thread["filePath"]

    # Raw current-shape row with an unregistered kind, queued ahead of any valid work.
    db = open_raw(file_path)
    try:
        db.prepare(
            """INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
               VALUES ('w-mX-bogus_kind-v1', 'messages', 'bogus_kind', '{"messageId":"mX"}', 'queued',
                       '2026-06-10T11:00:00.000Z', '{"sourceVersion":1,"derivations":[]}')"""
        ).run()
    finally:
        db.close()
    await _send(sdk, file_path, [valid_event("user_prompt")])

    report = await _drain(sdk, file_path)
    assert len(report.ran) == 2
    assert report.ran[0].work_item_id == "w-mX-bogus_kind-v1"
    assert report.ran[0].disposition == "failed_terminal"
    assert report.ran[0].reason == "unknown_work_kind"
    assert report.ran[1].work_item_id == "w-m1-prompt_smoothing-v1"
    assert report.ran[1].disposition == "done"
    assert report.stopped_because == "empty"
    assert _live_count(file_path) == 0
    smoothed = next((f for f in read_derived_forms(file_path) if f.subject_id == "m1"), None)
    assert smoothed is not None
    assert smoothed.state == "ready"


# ── TC-1.8 / AC-1.9: failed work is terminal and the drain continues ──────


async def test_tc_1_8_the_first_failure_marks_failed_deletes_the_row_and_runs_the_next_item_immediately(
    store: TempStore,
) -> None:
    """TC-1.8 / AC-1.9: the first failure marks failed, deletes the row, and runs the next item immediately"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(sdk, file_path, [valid_event("user_prompt"), valid_event("turn_end")])

    double.fail_kind("prompt_smoothing", 99, {"reason": "scripted failure (smoothPrompt)"})
    report = await _drain(sdk, file_path)
    assert len(report.ran) == 3
    assert report.ran[0].work_item_id == "w-m1-prompt_smoothing-v1"
    assert report.ran[0].disposition == "failed_terminal"
    assert report.ran[0].reason == "scripted failure (smoothPrompt)"
    assert report.ran[1].work_item_id == "w-t1-turn_derivation-v1"
    assert report.ran[1].disposition == "done"
    assert report.ran[2].work_item_id == "w-t1-detailed_turn_compression-v1"
    assert report.ran[2].disposition == "done"

    forms = read_derived_forms(file_path)
    failed = next((f for f in forms if f.derivation_type == "smoothed_prompt"), None)
    assert failed is not None
    assert failed.state == "failed"
    assert failed.reason == "scripted failure (smoothPrompt)"
    rendering = next((f for f in forms if f.derivation_type == "turn_rendering"), None)
    assert rendering is not None
    assert rendering.state == "ready"
    assert _live_count(file_path) == 0


async def test_tc_1_8_max_items_stops_the_drain_with_max_items_and_reports_the_remainder(store: TempStore) -> None:
    """TC-1.8 / AC-1.9: maxItems stops the drain with max_items and reports the remainder"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt"),
            valid_event("tool_call"),
            valid_event("tool_result"),
            valid_event("turn_end"),
        ],
    )

    report = await _drain(sdk, file_path, max_items=1)
    assert len(report.ran) == 1
    assert report.stopped_because == "max_items"
    assert report.remaining == 2
    assert _live_count(file_path) == 2


# ── claim ownership fencing ─────────────────────────────────────────────


class _Scripted:
    __slots__ = ("content", "mismatched_write")

    def __init__(self, content: str, mismatched_write: bool = False) -> None:
        self.content = content
        self.mismatched_write = mismatched_write


def _deferred_message_sdk(now: dict[str, float]):
    sdk = init_lhc(
        {
            "inferenceCallbacks": create_inference_callbacks_double(),
            "mode": "manual",
            "clock": lambda: datetime.fromtimestamp(now["ms"] / 1000, tz=timezone.utc),
            "lease": {"durationMs": 50},
        }
    )
    runs: list[dict] = []

    async def dispatcher(run, item):
        future: asyncio.Future = asyncio.get_event_loop().create_future()

        def resolve(scripted: _Scripted) -> None:
            writes = (
                [
                    HandlerDerivationWrite(
                        subject_kind="message",
                        subject_id="m1",
                        derivation_type="tool_result_summary",
                        content=scripted.content,
                    )
                ]
                if scripted.mismatched_write
                else [
                    HandlerDerivationWrite(
                        subject_kind="message",
                        subject_id="m1",
                        derivation_type="smoothed_prompt",
                        content=scripted.content,
                    )
                ]
            )
            disposition = apply_derivation_success(
                run.open_db(),
                DerivationAttempt(
                    source_version=item.source_version,
                    derivations=item.derivations,
                    work_item_id=item.work_item_id,
                ),
                writes,
                run.clock().isoformat().replace("+00:00", "Z"),
            )
            future.set_result({"disposition": disposition})

        runs.append({"item": item, "resolve": resolve})
        return await future

    dispatcher_ref: DurableWorkDispatcher = dispatcher
    register_testing_work(sdk, {"dispatchers": {"messages.derive": dispatcher_ref}})
    return sdk, runs


async def test_an_expired_claim_is_failed_without_rerunning_it_and_its_late_completion_cannot_write(
    store: TempStore,
) -> None:
    """claim ownership fencing: an expired claim is failed without rerunning it, and its late completion cannot write"""
    now = {"ms": datetime(2026, 6, 10, 12, 0, 0, tzinfo=timezone.utc).timestamp() * 1000}
    sdk, runs = _deferred_message_sdk(now)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(sdk, file_path, [valid_event("user_prompt")])

    older_drain = asyncio.ensure_future(_drain(sdk, file_path))
    await _until(lambda: len(runs) == 1, "older claim")

    now["ms"] += 100
    cleanup_report = await _drain(sdk, file_path)
    assert len(cleanup_report.ran) == 1
    assert cleanup_report.ran[0].disposition == "failed_terminal"
    assert cleanup_report.ran[0].reason == "claim_expired"
    assert len(runs) == 1

    runs[0]["resolve"](_Scripted(content="stale completion", mismatched_write=True))
    older_report = await older_drain
    assert older_report.ran[0].disposition == "lost_lease"

    form = next(
        (entry for entry in read_derived_forms(file_path) if entry.derivation_type == "smoothed_prompt"), None
    )
    assert form is not None
    assert form.state == "failed"
    assert form.reason == "claim_expired"
    assert _live_count(file_path) == 0


# ── completion exactness ──────────────────────────────────────────────────


async def test_a_queued_turn_derivation_success_missing_one_expected_write_rolls_back_and_leaves_the_item_live(
    store: TempStore,
) -> None:
    """completion exactness: a queued turn_derivation success missing one expected write rolls back and leaves the item live"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)

    async def dispatcher(run, item):
        disposition = apply_derivation_success(
            run.open_db(),
            DerivationAttempt(
                source_version=item.source_version,
                derivations=item.derivations,
                work_item_id=item.work_item_id,
            ),
            [
                HandlerDerivationWrite(
                    subject_kind="turn",
                    subject_id="t1",
                    derivation_type="turn_rendering",
                    content="partial rendering",
                )
            ],
            run.clock().isoformat().replace("+00:00", "Z"),
        )
        return {"disposition": disposition}

    dispatcher_ref: DurableWorkDispatcher = dispatcher
    register_testing_work(sdk, {"dispatchers": {"turns.deriveTurn": dispatcher_ref}})
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(sdk, file_path, [valid_event("user_prompt"), valid_event("turn_end")])
    await _drain(sdk, file_path, max_items=1)

    failed = await sdk.work.drain({"filePath": file_path})
    assert failed.ok is False
    if failed.ok:
        return
    assert failed.error.error_class == "state_corruption"
    assert failed.error.code == "derivation_completion_mismatch"
    assert "derivation_completion_mismatch" in failed.error.reason

    forms = [form for form in read_derived_forms(file_path) if form.subject_id == "t1"]
    assert sorted((form.derivation_type, form.state, form.content) for form in forms) == [
        ("pre_detailed_assembly", "pending", None),
        ("turn_rendering", "pending", None),
    ]
    detail = _live_detail(file_path)
    assert len(detail) == 1
    assert detail[0].work_item_id == "w-t1-turn_derivation-v1"
    assert detail[0].status == "claimed"

    db = open_raw(file_path)
    try:
        members = db.prepare("SELECT COUNT(*) AS n FROM chunk_member WHERE turn_id = 't1'").get()
        summaries = db.prepare("SELECT COUNT(*) AS n FROM work_item WHERE kind LIKE 'chunk_summary_%'").get()
        assert members is not None and int(members["n"]) == 0
        assert summaries is not None and int(summaries["n"]) == 0
    finally:
        db.close()


async def test_a_stale_queued_terminal_failure_deletes_owned_work_without_stamping_the_newer_derivation(
    store: TempStore,
) -> None:
    """completion exactness: a stale queued terminal failure deletes owned work without stamping the newer derivation"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(sdk, file_path, [valid_event("user_prompt")])
    db = open_raw(file_path)
    try:
        db.prepare(
            """UPDATE derivation
               SET source_version = 2
               WHERE subject_kind = 'message' AND subject_id = 'm1' AND derivation_type = 'smoothed_prompt'"""
        ).run()
    finally:
        db.close()

    double.fail_kind("prompt_smoothing", 1, {"reason": "stale terminal failure"})
    report = await _drain(sdk, file_path)
    assert report.ran[0].work_item_id == "w-m1-prompt_smoothing-v1"
    assert report.ran[0].disposition == "failed_terminal"
    assert report.ran[0].reason == "stale terminal failure"
    assert _live_count(file_path) == 0
    forms = read_derived_forms(file_path)
    assert len(forms) == 1
    assert forms[0].subject_id == "m1"
    assert forms[0].derivation_type == "smoothed_prompt"
    assert forms[0].state == "pending"
    assert forms[0].source_version == 2
    assert forms[0].reason is None


async def test_a_queued_terminal_failure_that_hits_only_part_of_its_targets_rolls_back_and_leaves_the_item_live(
    store: TempStore,
) -> None:
    """completion exactness: a queued terminal failure that hits only part of its targets rolls back and leaves the item live"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(sdk, file_path, [valid_event("user_prompt"), valid_event("turn_end")])
    await _drain(sdk, file_path, max_items=1)

    db = open_raw(file_path)
    try:
        db.prepare(
            """UPDATE derivation
               SET source_version = 2
               WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'pre_detailed_assembly'"""
        ).run()
    finally:
        db.close()

    async def dispatcher(run, item):
        disposition = apply_derivation_success(
            run.open_db(),
            DerivationAttempt(
                source_version=item.source_version,
                derivations=item.derivations,
                work_item_id=item.work_item_id,
            ),
            [
                HandlerDerivationWrite(
                    subject_kind="turn",
                    subject_id="t1",
                    derivation_type="turn_rendering",
                    content="partial rendering",
                )
            ],
            run.clock().isoformat().replace("+00:00", "Z"),
        )
        return {"disposition": disposition}

    dispatcher_ref: DurableWorkDispatcher = dispatcher
    register_testing_work(sdk, {"dispatchers": {"turns.deriveTurn": dispatcher_ref}})

    failed = await sdk.work.drain({"filePath": file_path})
    assert failed.ok is False
    if failed.ok:
        return
    assert failed.error.error_class == "state_corruption"
    assert failed.error.code == "derivation_completion_mismatch"
    assert "derivation completion target mismatch" in failed.error.reason

    forms = [form for form in read_derived_forms(file_path) if form.subject_id == "t1"]
    assert sorted(
        (form.derivation_type, form.state, form.reason, form.source_version) for form in forms
    ) == [
        ("pre_detailed_assembly", "pending", None, 2),
        ("turn_rendering", "pending", None, 1),
    ]
    detail = _live_detail(file_path)
    assert len(detail) == 1
    assert detail[0].work_item_id == "w-t1-turn_derivation-v1"
    assert detail[0].status == "claimed"


async def test_an_extra_handler_write_target_fails_closed_before_any_completion_write_lands(
    store: TempStore,
) -> None:
    """completion exactness: an extra handler write target fails closed before any completion write lands"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)

    async def dispatcher(run, item):
        disposition = apply_derivation_success(
            run.open_db(),
            DerivationAttempt(
                source_version=item.source_version,
                derivations=item.derivations,
                work_item_id=item.work_item_id,
            ),
            [
                HandlerDerivationWrite(
                    subject_kind="message",
                    subject_id="m1",
                    derivation_type="smoothed_prompt",
                    content="expected write",
                ),
                HandlerDerivationWrite(
                    subject_kind="message",
                    subject_id="m1",
                    derivation_type="tool_result_summary",
                    content="extra write",
                ),
            ],
            run.clock().isoformat().replace("+00:00", "Z"),
        )
        return {"disposition": disposition}

    dispatcher_ref: DurableWorkDispatcher = dispatcher
    register_testing_work(sdk, {"dispatchers": {"messages.derive": dispatcher_ref}})
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(sdk, file_path, [valid_event("user_prompt")])

    failed = await sdk.work.drain({"filePath": file_path})
    assert failed.ok is False
    if failed.ok:
        return
    assert failed.error.error_class == "state_corruption"
    assert failed.error.code == "derivation_completion_mismatch"
    assert "derivation_completion_mismatch" in failed.error.reason
    forms = read_derived_forms(file_path)
    assert len(forms) == 1
    assert forms[0].subject_id == "m1"
    assert forms[0].derivation_type == "smoothed_prompt"
    assert forms[0].state == "pending"
    detail = _live_detail(file_path)
    assert len(detail) == 1
    assert detail[0].work_item_id == "w-m1-prompt_smoothing-v1"
    assert detail[0].status == "claimed"


# ── sync derive collision policy ───────────────────────────────────────────


async def test_messages_derive_is_a_bounded_inline_attempt_and_does_not_consume_queued_work(
    store: TempStore,
) -> None:
    """sync derive collision policy: messages.derive is a bounded inline attempt and does not consume queued work"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(sdk, file_path, [valid_event("user_prompt")])

    result = await sdk.messages.derive({"filePath": file_path}, ["m1"])

    assert result.ok is True
    if not result.ok:
        return
    entry = result.value[0]
    assert entry.message_id == "m1"
    assert entry.outcome == "failed"
    assert entry.error.error_class == "caller_error"
    assert entry.error.code == "derivation_work_in_flight"
    detail = _live_detail(file_path)
    assert len(detail) == 1
    assert detail[0].work_item_id == "w-m1-prompt_smoothing-v1"
    assert detail[0].status == "queued"
    forms = read_derived_forms(file_path)
    assert forms[0].state == "pending"
    assert forms[0].source_version == 1


async def test_messages_derive_attempts_once_and_leaves_no_queued_work_on_failure(store: TempStore) -> None:
    """sync derive collision policy: messages.derive attempts once and leaves no queued work on failure"""
    double = create_inference_callbacks_double()
    double.fail_kind("prompt_smoothing", 1, {"reason": "timeout: inline attempt"})
    sdk = _manual_sdk(double)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(sdk, file_path, [valid_event("user_prompt")])
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")

    result = await sdk.messages.derive({"filePath": file_path}, ["m1"])

    assert result.ok is True
    if not result.ok:
        return
    entry = result.value[0]
    assert entry.message_id == "m1"
    assert entry.outcome == "failed"
    assert entry.error.error_class == "system_error"
    assert entry.error.code == "provider_failure"
    assert entry.error.reason == "timeout: inline attempt"
    assert _live_detail(file_path) == []
    forms = read_derived_forms(file_path)
    assert forms[0].state == "pending"
    assert forms[0].source_version == 1


async def test_messages_derive_writes_ready_when_no_live_work_owns_the_derivation(store: TempStore) -> None:
    """sync derive collision policy: messages.derive writes ready when no live work owns the derivation"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(sdk, file_path, [valid_event("user_prompt")])
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")

    result = await sdk.messages.derive({"filePath": file_path}, ["m1"])

    assert result.ok is True
    if not result.ok:
        return
    assert len(result.value) == 1
    assert result.value[0].message_id == "m1"
    assert result.value[0].outcome == "derived"
    assert result.value[0].derivation_type == "smoothed_prompt"
    assert result.value[0].source_version == 1
    forms = read_derived_forms(file_path)
    assert forms[0].state == "ready"
    assert _live_count(file_path) == 0


async def test_messages_derive_accepts_same_version_ready_races_without_overwriting_them(
    store: TempStore,
) -> None:
    """sync derive collision policy: messages.derive accepts same-version ready races without overwriting them"""
    file_path_box: dict[str, str] = {"filePath": ""}
    base = create_inference_callbacks_double()

    class _RaceCallbacks:
        async def smooth_prompt(self, i):
            _set_ready_derivation(
                file_path_box["filePath"],
                {"subjectKind": "message", "subjectId": "m1", "derivationType": "smoothed_prompt"},
                "competing ready value",
                1,
            )
            return {"ok": True, "text": "late inline value"}

        async def summarize_tool_result(self, i):
            return await base.summarize_tool_result(i)

        async def compress_detailed_turn(self, i):
            return await base.compress_detailed_turn(i)

        async def summarize_chunk_brief(self, i):
            return await base.summarize_chunk_brief(i)

    callbacks: InferenceCallbacks = _RaceCallbacks()
    sdk = _manual_sdk(callbacks)
    thread = await _new_thread(store)
    file_path_box["filePath"] = thread["filePath"]
    file_path = file_path_box["filePath"]
    await _send(sdk, file_path, [valid_event("user_prompt")])
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")

    result = await sdk.messages.derive({"filePath": file_path}, ["m1"])

    assert result.ok is True
    if not result.ok:
        return
    assert len(result.value) == 1
    assert result.value[0].message_id == "m1"
    assert result.value[0].outcome == "derived"
    assert result.value[0].derivation_type == "smoothed_prompt"
    assert result.value[0].source_version == 1
    forms = read_derived_forms(file_path)
    assert forms[0].state == "ready"
    assert forms[0].content == "competing ready value"


async def test_messages_derive_refuses_when_the_derivation_advances_after_its_initial_read(
    store: TempStore,
) -> None:
    """sync derive collision policy: messages.derive refuses when the derivation advances after its initial read"""
    file_path_box: dict[str, str] = {"filePath": ""}
    base = create_inference_callbacks_double()

    class _RaceCallbacks:
        async def smooth_prompt(self, i):
            _set_ready_derivation(
                file_path_box["filePath"],
                {"subjectKind": "message", "subjectId": "m1", "derivationType": "smoothed_prompt"},
                "newer completion",
                2,
            )
            return {"ok": True, "text": "stale inline completion"}

        async def summarize_tool_result(self, i):
            return await base.summarize_tool_result(i)

        async def compress_detailed_turn(self, i):
            return await base.compress_detailed_turn(i)

        async def summarize_chunk_brief(self, i):
            return await base.summarize_chunk_brief(i)

    callbacks: InferenceCallbacks = _RaceCallbacks()
    sdk = _manual_sdk(callbacks)
    thread = await _new_thread(store)
    file_path_box["filePath"] = thread["filePath"]
    file_path = file_path_box["filePath"]
    await _send(sdk, file_path, [valid_event("user_prompt")])
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")

    raced = await sdk.messages.derive({"filePath": file_path}, ["m1"])

    assert raced.ok is True
    if not raced.ok:
        return
    assert len(raced.value) == 1
    entry = raced.value[0]
    assert entry.message_id == "m1"
    assert entry.outcome == "failed"
    assert entry.error.error_class == "caller_error"
    assert entry.error.code == "derivation_work_in_flight"
    forms = read_derived_forms(file_path)
    assert len(forms) == 1
    assert forms[0].subject_id == "m1"
    assert forms[0].derivation_type == "smoothed_prompt"
    assert forms[0].state == "ready"
    assert forms[0].content == "newer completion"
    assert forms[0].source_version == 2
    assert [item.work_item_id for item in _live_detail(file_path)] == []


async def test_turns_derive_turn_refuses_an_abandoned_later_turn_while_older_turn_derivation_work_is_queued(
    store: TempStore,
) -> None:
    """sync derive collision policy: turns.deriveTurn refuses an abandoned later turn while older turn_derivation work is queued"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "first prompt"}}),
            valid_event("assistant_text", {"payload": {"text": "first answer"}}),
            valid_event("turn_end"),
            valid_event("user_prompt", {"payload": {"text": "second prompt"}}),
            valid_event("assistant_text", {"payload": {"text": "second answer"}}),
            valid_event("turn_end"),
        ],
    )
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")
    db = open_raw(file_path)
    try:
        db.prepare("DELETE FROM work_item WHERE kind = 'prompt_smoothing'").run()
    finally:
        db.close()
    _delete_work_item(file_path, "w-t2-turn_derivation-v1")

    refused = await sdk.turns.derive_turn({"filePath": file_path}, "t2")

    assert refused.ok is True
    if not refused.ok:
        return
    assert refused.value.turn_id == "t2"
    assert refused.value.outcome == "failed"
    assert refused.value.error.error_class == "caller_error"
    assert refused.value.error.code == "derivation_work_in_flight"
    detail = _live_detail(file_path)
    assert len(detail) == 2
    assert detail[0].work_item_id == "w-t1-turn_derivation-v1"
    assert detail[0].status == "queued"
    assert detail[1].work_item_id == "w-t2-turn_derivation-v1"
    assert detail[1].status == "queued"
    assert sorted(
        (form.derivation_type, form.state, form.source_version)
        for form in read_derived_forms(file_path)
        if form.subject_id == "t2"
    ) == [
        ("pre_detailed_assembly", "pending", 1),
        ("turn_rendering", "pending", 1),
    ]


async def test_turns_derive_turn_refuses_an_exact_head_when_one_of_its_two_derivations_advances_before_claim(
    store: TempStore,
) -> None:
    """sync derive collision policy: turns.deriveTurn refuses an exact head when one of its two derivations advances before claim"""
    advance_on_clock = {"value": False}
    file_path_box: dict[str, str] = {"filePath": ""}
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()

    def clock() -> datetime:
        if advance_on_clock["value"]:
            advance_on_clock["value"] = False
            _set_ready_derivation(
                file_path_box["filePath"],
                {"subjectKind": "turn", "subjectId": "t1", "derivationType": "pre_detailed_assembly"},
                "newer assembly",
                2,
            )
        return datetime(2026, 6, 10, 12, 0, 0, tzinfo=timezone.utc)

    sdk = _manual_sdk(double, clock=clock)
    thread = await _new_thread(store)
    file_path_box["filePath"] = thread["filePath"]
    file_path = file_path_box["filePath"]
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "turn boundary"}}),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")

    advance_on_clock["value"] = True
    raced = await sdk.turns.derive_turn({"filePath": file_path}, "t1")

    assert raced.ok is True
    if not raced.ok:
        return
    assert raced.value.turn_id == "t1"
    assert raced.value.outcome == "failed"
    assert raced.value.error.error_class == "caller_error"
    assert raced.value.error.code == "derivation_work_in_flight"
    assert len(captured) == 0
    detail = _live_detail(file_path)
    assert len(detail) == 1
    assert detail[0].work_item_id == "w-t1-turn_derivation-v1"
    assert detail[0].status == "queued"
    assert sorted(
        (form.derivation_type, form.state, form.content, form.source_version)
        for form in read_derived_forms(file_path)
        if form.subject_id == "t1"
    ) == [
        ("pre_detailed_assembly", "ready", "newer assembly", 2),
        ("turn_rendering", "pending", None, 1),
    ]


async def test_two_concurrent_messages_derive_calls_are_inline_attempts_fenced_by_the_derivation_row(
    store: TempStore,
) -> None:
    """sync derive collision policy: two concurrent messages.derive calls are inline attempts fenced by the derivation row"""
    base = create_inference_callbacks_double()
    smooth_calls: list[dict] = []

    class _DeferredCallbacks:
        async def smooth_prompt(self, i):
            future: asyncio.Future = asyncio.get_event_loop().create_future()
            smooth_calls.append({"resolve": lambda result: future.set_result(result)})
            return await future

        async def summarize_tool_result(self, i):
            return await base.summarize_tool_result(i)

        async def compress_detailed_turn(self, i):
            return await base.compress_detailed_turn(i)

        async def summarize_chunk_brief(self, i):
            return await base.summarize_chunk_brief(i)

    callbacks: InferenceCallbacks = _DeferredCallbacks()
    sdk = _manual_sdk(callbacks)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(sdk, file_path, [valid_event("user_prompt", {"payload": {"text": "claim me"}})])
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")

    first = asyncio.ensure_future(sdk.messages.derive({"filePath": file_path}, ["m1"]))
    await _until(lambda: len(smooth_calls) == 1, "first inline message derive attempt")
    second = asyncio.ensure_future(sdk.messages.derive({"filePath": file_path}, ["m1"]))
    await _until(lambda: len(smooth_calls) == 2, "second inline message derive attempt")
    smooth_calls[0]["resolve"]({"ok": True, "text": "first inline completion"})
    first_result = await first
    smooth_calls[1]["resolve"]({"ok": True, "text": "second inline completion"})
    second_result = await second

    assert first_result.ok is True
    assert second_result.ok is True
    if not first_result.ok or not second_result.ok:
        return
    assert len(first_result.value) == 1
    assert first_result.value[0].message_id == "m1"
    assert first_result.value[0].outcome == "derived"
    assert first_result.value[0].derivation_type == "smoothed_prompt"
    assert first_result.value[0].source_version == 1
    assert len(second_result.value) == 1
    assert second_result.value[0].message_id == "m1"
    assert second_result.value[0].outcome == "derived"
    assert second_result.value[0].derivation_type == "smoothed_prompt"
    assert second_result.value[0].source_version == 1
    forms = read_derived_forms(file_path)
    assert len(forms) == 1
    assert forms[0].subject_id == "m1"
    assert forms[0].derivation_type == "smoothed_prompt"
    assert forms[0].state == "ready"
    assert forms[0].content == "first inline completion"
    assert _live_count(file_path) == 0


async def test_two_concurrent_turns_derive_turn_calls_share_the_durable_claim(store: TempStore) -> None:
    """sync derive collision policy: two concurrent turns.deriveTurn calls share the durable claim"""
    base = create_inference_callbacks_double()
    compression_calls: list[dict] = []

    class _DeferredCallbacks:
        async def smooth_prompt(self, i):
            return await base.smooth_prompt(i)

        async def summarize_tool_result(self, i):
            return await base.summarize_tool_result(i)

        async def compress_detailed_turn(self, i):
            future: asyncio.Future = asyncio.get_event_loop().create_future()
            compression_calls.append({"resolve": lambda result: future.set_result(result)})
            return await future

        async def summarize_chunk_brief(self, i):
            return await base.summarize_chunk_brief(i)

    callbacks: InferenceCallbacks = _DeferredCallbacks()
    sdk = _manual_sdk(callbacks)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "turn claim"}}),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path, max_items=2)
    _delete_work_item(file_path, "w-t1-detailed_turn_compression-v1")

    first = asyncio.ensure_future(sdk.turns.derive_turn({"filePath": file_path}, "t1"))
    await _until(lambda: len(compression_calls) == 1, "first sync turn derive claim")
    second = await sdk.turns.derive_turn({"filePath": file_path}, "t1")
    compression_calls[0]["resolve"]({"ok": True, "text": "owned turn compression"})
    owned = await first

    assert second.ok is True
    assert owned.ok is True
    if not second.ok or not owned.ok:
        return
    assert second.value.turn_id == "t1"
    assert second.value.outcome == "failed"
    assert second.value.error.error_class == "caller_error"
    assert second.value.error.code == "derivation_work_in_flight"
    assert owned.value.turn_id == "t1"
    assert owned.value.outcome == "derived"
    assert owned.value.source_version == 2
    turn_forms = [form for form in read_derived_forms(file_path) if form.subject_id == "t1"]
    compression = next((form for form in turn_forms if form.derivation_type == "detailed_turn_compression"), None)
    assert compression is not None
    assert compression.state == "ready"
    assert compression.content == "owned turn compression"
    assert [
        item for item in _live_detail(file_path) if item.work_item_id == "w-t1-turn_derivation-v1"
    ] == []


async def test_two_concurrent_turns_derive_brief_chunk_calls_share_the_durable_claim(store: TempStore) -> None:
    """sync derive collision policy: two concurrent turns.deriveBriefChunk calls share the durable claim"""
    base = create_inference_callbacks_double()
    brief_calls: list[dict] = []

    class _DeferredCallbacks:
        async def smooth_prompt(self, i):
            return await base.smooth_prompt(i)

        async def summarize_tool_result(self, i):
            return await base.summarize_tool_result(i)

        async def compress_detailed_turn(self, i):
            return await base.compress_detailed_turn(i)

        async def summarize_chunk_brief(self, i):
            future: asyncio.Future = asyncio.get_event_loop().create_future()
            brief_calls.append({"resolve": lambda result: future.set_result(result)})
            return await future

    callbacks: InferenceCallbacks = _DeferredCallbacks()
    sdk = _manual_sdk(callbacks)
    thread = await _new_thread(store)
    file_path = thread["filePath"]
    _insert_abandoned_chunk_summary(file_path, "c1", "chunk_summary_brief")
    db = open_raw(file_path)
    try:
        db.prepare(
            """INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, content, source_version)
               VALUES ('chunk', 'c1', 'chunk_summary_detailed', 'ready', 'owned detailed input', 1)"""
        ).run()
    finally:
        db.close()

    first = asyncio.ensure_future(sdk.turns.derive_brief_chunk({"filePath": file_path}, "c1"))
    await _until(lambda: len(brief_calls) == 1, "first sync chunk derive claim")
    second = await sdk.turns.derive_brief_chunk({"filePath": file_path}, "c1")
    brief_calls[0]["resolve"]({"ok": True, "text": "owned chunk brief"})
    owned = await first

    assert second.ok is True
    assert owned.ok is True
    if not second.ok or not owned.ok:
        return
    assert second.value.chunk_id == "c1"
    assert second.value.outcome == "failed"
    assert second.value.error.error_class == "caller_error"
    assert second.value.error.code == "derivation_work_in_flight"
    assert owned.value.chunk_id == "c1"
    assert owned.value.outcome == "derived"
    assert owned.value.derivation_type == "chunk_summary_brief"
    assert owned.value.source_version == 1
    briefs = [form for form in read_derived_forms(file_path) if form.derivation_type == "chunk_summary_brief"]
    assert len(briefs) == 1
    assert briefs[0].subject_kind == "chunk"
    assert briefs[0].subject_id == "c1"
    assert briefs[0].state == "ready"
    assert briefs[0].content == "owned chunk brief"
    assert _live_count(file_path) == 0
