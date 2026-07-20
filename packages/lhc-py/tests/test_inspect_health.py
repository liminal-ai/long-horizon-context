"""Ported from packages/lhc/test/inspect-health.test.ts. Phase 1.

Story 2 (Epic 04), default suite: TC-4.1–4.3 — the inspect health report.
Counts by owner/kind/state assembled entirely from the owners' report
surfaces (AC-4.1), actionable failure detail (AC-4.2), a repair preview
that is reported and never executed (AC-4.3), rebuild visibility bracketing
a drain (AC-4.4), and live queue visibility consistent with the state
counts in the same report (AC-4.5).
"""

from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from typing import Any, Never

import pytest

from lhc import init_lhc, intake_stream, threads
from lhc.messages import MessageReportOpts
from lhc.shared_tech.derivation import SdkConfig
from lhc.shared_tech.errors import OpResult
from lhc.shared_tech.inspect import (
    HealthFailure,
    HealthOwnerCounts,
    HealthOwnerEntry,
    HealthQueue,
    HealthRepairPreview,
    HealthReport,
)
from lhc.threads import NewThreadInput
from lhc.turns import TurnReportOpts
from fixtures import (
    PERMANENT_FAILURE_REASON,
    RATE_LIMIT_FAILURE_REASON,
    TempStore,
    create_inference_callbacks_double,
    expect_read_only,
    mixed_state_variant_thread,
    mutation_in_flight_variant,
    temp_store,
    valid_event,
)


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


def _to_jsonable(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return {k: _to_jsonable(v) for k, v in asdict(value).items()}
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    return value


def _health_value(result: OpResult[HealthReport]) -> HealthReport:
    if not result.ok:
        raise RuntimeError(
            f"expected ok health report: {json.dumps(_to_jsonable(result), separators=(',', ':'))}"
        )
    return result.value


def _counts(*, ready: int = 0, pending: int = 0, failed: int = 0, blocked: int = 0) -> HealthOwnerCounts:
    return HealthOwnerCounts(ready=ready, pending=pending, failed=failed, blocked=blocked)


async def _create_thread(store: TempStore) -> str:
    file_path = store.thread_path()
    created = await threads.new_thread(
        NewThreadInput(file_path=file_path, registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")
    return file_path


class _RefuseCallbacks:
    """InferenceCallbacks whose every operation throws — inspect must not call them."""

    async def smooth_prompt(self, i: object) -> Never:
        raise RuntimeError("inference callbacks must never be called by a read operation")

    async def summarize_tool_result(self, i: object) -> Never:
        raise RuntimeError("inference callbacks must never be called by a read operation")

    async def compress_detailed_turn(self, i: object) -> Never:
        raise RuntimeError("inference callbacks must never be called by a read operation")

    async def summarize_chunk_brief(self, i: object) -> Never:
        raise RuntimeError("inference callbacks must never be called by a read operation")


async def test_the_mixed_state_fixture_reports_exact_counts_and_a_queue_section_consistent_with_them(
    store: TempStore,
) -> None:
    """the mixed-state fixture reports exact counts and a queue section consistent with them"""
    fixture = await mixed_state_variant_thread(store)
    file_path = fixture.file_path
    sdk = fixture.sdk

    health = await expect_read_only(file_path, lambda: sdk.inspect.health({"filePath": file_path}))
    assert health.ok is True
    if not health.ok:
        return
    report = health.value

    assert report.owners == [
        HealthOwnerEntry(
            owner="messages",
            kind="smoothed_prompt",
            counts=_counts(ready=13, pending=1),
        ),
        HealthOwnerEntry(
            owner="messages",
            kind="tool_result_summary",
            counts=_counts(ready=6, failed=2),
        ),
        HealthOwnerEntry(owner="turns", kind="chunk_summary_brief", counts=_counts(ready=3)),
        HealthOwnerEntry(owner="turns", kind="chunk_summary_detailed", counts=_counts(ready=3)),
        HealthOwnerEntry(
            owner="turns",
            kind="detailed_turn_compression",
            counts=_counts(ready=12),
        ),
        HealthOwnerEntry(
            owner="turns",
            kind="pre_detailed_assembly",
            counts=_counts(ready=12, blocked=1),
        ),
        HealthOwnerEntry(
            owner="turns",
            kind="turn_rendering",
            counts=_counts(ready=12, blocked=1),
        ),
    ]

    assert report.queue == HealthQueue(queued=1, claimed=0)
    pending_total = sum(row.counts.pending for row in report.owners)
    assert report.queue.queued + report.queue.claimed == pending_total


async def test_failed_entries_carry_exact_detail_the_preview_is_exactly_the_failed_not_blocked_set(
    store: TempStore,
) -> None:
    """failed entries carry exact detail; the preview is exactly the failed-not-blocked set"""
    fixture = await mixed_state_variant_thread(store)
    file_path = fixture.file_path
    sdk = fixture.sdk
    report = _health_value(await sdk.inspect.health({"filePath": file_path}))

    failed = [
        entry
        for entry in report.failures
        if entry.reason.startswith("rate_limit") or entry.reason.startswith("content_refusal")
    ]
    assert failed == [
        HealthFailure(
            owner="messages",
            subject_kind="message",
            subject_id=fixture.failed_transient_message_id,  # type: ignore[arg-type]
            derivation_type="tool_result_summary",
            reason=RATE_LIMIT_FAILURE_REASON,
        ),
        HealthFailure(
            owner="messages",
            subject_kind="message",
            subject_id=fixture.failed_permanent_message_id,  # type: ignore[arg-type]
            derivation_type="tool_result_summary",
            reason=PERMANENT_FAILURE_REASON,
        ),
    ]

    blocked = [entry for entry in report.failures if entry not in failed]
    assert [
        (entry.owner, entry.subject_kind, entry.subject_id, entry.derivation_type)
        for entry in blocked
    ] == [
        ("turns", "turn", fixture.blocked_turn_id, "pre_detailed_assembly"),
        ("turns", "turn", fixture.blocked_turn_id, "turn_rendering"),
    ]
    for entry in blocked:
        assert len(entry.reason) > 0

    assert report.repair_preview == [
        HealthRepairPreview(
            owner="messages",
            subject_kind="message",
            subject_id=fixture.failed_transient_message_id,  # type: ignore[arg-type]
            derivation_type="tool_result_summary",
        ),
        HealthRepairPreview(
            owner="messages",
            subject_kind="message",
            subject_id=fixture.failed_permanent_message_id,  # type: ignore[arg-type]
            derivation_type="tool_result_summary",
        ),
    ]

    again = _health_value(await sdk.inspect.health({"filePath": file_path}))
    assert again == report


async def test_reports_durable_capture_gap_runtime_note_markers_as_capture_health_failures(
    store: TempStore,
) -> None:
    """reports durable capture-gap runtime_note markers as capture health failures"""
    file_path = await _create_thread(store)
    gap = valid_event(
        "runtime_note",
        {
            "idempotencyKey": "gap-1",
            "actor": "system",
            "harness": "pi",
            "payload": {"text": "capture gap: 1 event(s) rejected - payload mismatch"},
        },
    )
    recorded = await intake_stream.message_events({"filePath": file_path}, [gap])
    assert recorded.ok is True

    reader = init_lhc(
        SdkConfig(inference_callbacks=create_inference_callbacks_double(), mode="manual")
    )
    report = _health_value(
        await expect_read_only(file_path, lambda: reader.inspect.health({"filePath": file_path}))
    )
    assert (
        HealthOwnerEntry(owner="capture", kind="capture_gap", counts=_counts(failed=1))
        in report.owners
    )
    assert (
        HealthFailure(
            owner="capture",
            subject_kind="event",
            subject_id="1",
            derivation_type="capture_gap",
            reason=gap["payload"]["text"],
        )
        in report.failures
    )
    assert report.repair_preview == []


async def test_after_an_edit_the_cascades_cleared_set_is_pending_with_queued_work_after_the_drain_the_same_set_is_ready_nothing_else_moved(
    store: TempStore,
) -> None:
    """after an edit the cascade's cleared set is pending with queued work; after the drain the same set is ready; nothing else moved"""
    fixture = await mutation_in_flight_variant(store)
    file_path = fixture.file_path
    sdk = fixture.sdk

    cleared_keys = sorted(
        f"{target.subject_kind}:{target.subject_id}:{target.derivation_type}"
        for target in fixture.mutation.cleared
    )
    assert cleared_keys == sorted(
        [
            f"message:{fixture.edited_message_id}:smoothed_prompt",
            "turn:t2:turn_rendering",
            "turn:t2:pre_detailed_assembly",
            "turn:t2:detailed_turn_compression",
            "chunk:c1:chunk_summary_detailed",
            "chunk:c1:chunk_summary_brief",
        ]
    )

    before = _health_value(
        await expect_read_only(file_path, lambda: sdk.inspect.health({"filePath": file_path}))
    )
    assert before.owners == [
        HealthOwnerEntry(
            owner="messages",
            kind="smoothed_prompt",
            counts=_counts(ready=11, pending=1),
        ),
        HealthOwnerEntry(owner="messages", kind="tool_result_summary", counts=_counts(ready=8)),
        HealthOwnerEntry(
            owner="turns",
            kind="chunk_summary_brief",
            counts=_counts(ready=2, pending=1),
        ),
        HealthOwnerEntry(
            owner="turns",
            kind="chunk_summary_detailed",
            counts=_counts(ready=2, pending=1),
        ),
        HealthOwnerEntry(
            owner="turns",
            kind="detailed_turn_compression",
            counts=_counts(ready=11, pending=1),
        ),
        HealthOwnerEntry(
            owner="turns",
            kind="pre_detailed_assembly",
            counts=_counts(ready=11, pending=1),
        ),
        HealthOwnerEntry(
            owner="turns",
            kind="turn_rendering",
            counts=_counts(ready=11, pending=1),
        ),
    ]
    assert before.queue == HealthQueue(queued=6, claimed=0)
    assert before.failures == []
    assert before.repair_preview == []

    messages_pending = await sdk.messages.report(
        {"filePath": file_path}, MessageReportOpts(not_ready=True)
    )
    turns_pending = await sdk.turns.report(
        {"filePath": file_path}, TurnReportOpts(not_ready=True)
    )
    assert messages_pending.ok and turns_pending.ok
    if not messages_pending.ok or not turns_pending.ok:
        return
    pending_keys = sorted(
        f"{entry.subject_kind}:{entry.subject_id}:{entry.derivation_type}"
        for entry in [*messages_pending.value, *turns_pending.value]
        if entry.state == "pending"
    )
    assert pending_keys == cleared_keys

    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok is True
    await sdk.drain_settled({"filePath": file_path})

    after = _health_value(await sdk.inspect.health({"filePath": file_path}))
    assert after.owners == [
        HealthOwnerEntry(owner="messages", kind="smoothed_prompt", counts=_counts(ready=12)),
        HealthOwnerEntry(owner="messages", kind="tool_result_summary", counts=_counts(ready=8)),
        HealthOwnerEntry(owner="turns", kind="chunk_summary_brief", counts=_counts(ready=3)),
        HealthOwnerEntry(owner="turns", kind="chunk_summary_detailed", counts=_counts(ready=3)),
        HealthOwnerEntry(
            owner="turns",
            kind="detailed_turn_compression",
            counts=_counts(ready=12),
        ),
        HealthOwnerEntry(owner="turns", kind="pre_detailed_assembly", counts=_counts(ready=12)),
        HealthOwnerEntry(owner="turns", kind="turn_rendering", counts=_counts(ready=12)),
    ]
    assert after.queue == HealthQueue(queued=0, claimed=0)
    assert after.failures == []


async def test_health_succeeds_under_a_throwing_inference_callback_and_calls_no_model_on_the_fixture_sdk(
    store: TempStore,
) -> None:
    """health succeeds under a throwing inference callback and calls no model on the fixture SDK"""
    fixture = await mixed_state_variant_thread(store)
    captured = fixture.double.capture_inputs()

    reader = init_lhc(
        SdkConfig(
            inference_callbacks=_RefuseCallbacks(),  # type: ignore[arg-type]
            mode="manual",
        )
    )
    health = await expect_read_only(
        fixture.file_path,
        lambda: reader.inspect.health({"filePath": fixture.file_path}),
    )
    assert health.ok is True
    assert len(captured) == 0
