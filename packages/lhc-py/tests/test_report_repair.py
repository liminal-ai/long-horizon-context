"""Ported from packages/lhc/test/report-repair.test.ts. Phase 1.

Story 4 (Epic 02): derivation state, report, and repair — Flow 4. The
four-state lifecycle proven on forms the pipeline landed for real
(TC-4.1), exact owner scoping and the
exact not-ready set (TC-4.3), explicit re-queue through the owning
surfaces landing ready with the failure cleared (TC-4.4, background mode
proving the poke), requeue idempotency against live work (TC-4.5), the
blocked-source path with its refusal carrying the stored damage reason
(TC-4.6, architecture risk), and degrade-don't-block reads with every
non-ready state present at once (TC-4.7, architecture risk).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

import pytest

from lhc import (
    BatchResult,
    DrainReport,
    InferenceCallbacks,
    Lhc,
    MessageEventInput,
    count_live_items,
    init_lhc,
    queue_detail,
    set_scheduler_poke,
    set_thread_touch,
    threads,
)
from lhc.messages import MessageDerived, MessageNotDerivable, MessageReportOpts
from lhc.shared_tech.derivation import (
    ChunkPolicyConfig,
    DerivationReportEntry,
    LeaseConfig,
    SdkConfig,
)
from lhc.shared_tech.errors import ErrorResult
from lhc.threads import NewThreadInput
from lhc.turns import TurnDerived, TurnDeriveFailed, TurnReportOpts
from fixtures import (
    GAPPED_SMOOTHING_REASON,
    TempStore,
    corrupt_two_open_turns,
    create_inference_callbacks_double,
    damaged_source_thread,
    gapped_rendering_thread,
    open_raw,
    read_derived_forms,
    temp_store,
    valid_event,
)
from fixtures.inference_callbacks_double import InferenceCallbacksDouble


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
) -> Lhc:
    return init_lhc(
        SdkConfig(
            inference_callbacks=inference_callbacks,
            mode="manual",
            lease=LeaseConfig(duration_ms=200),
            chunk_policy=chunk_policy,
            clock=clock,
        )
    )


async def _send(sdk: Lhc, file_path: str, batch: Sequence[MessageEventInput]) -> BatchResult:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(f"batch failed: {result.error.reason}")
    return result.value


async def _drain(sdk: Lhc, file_path: str, opts: dict | None = None) -> DrainReport:
    result = await sdk.work.drain({"filePath": file_path}, opts)
    if not result.ok:
        raise RuntimeError(f"drain failed: {result.error.reason}")
    return result.value


def _form_of(file_path: str, subject_id: str, derivation_type: str):
    return next(
        (
            f
            for f in read_derived_forms(file_path)
            if f.subject_id == subject_id and f.derivation_type == derivation_type
        ),
        None,
    )


def _live_count(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        return count_live_items(db)
    finally:
        db.close()


def _raw_detail(file_path: str):
    db = open_raw(file_path)
    try:
        return queue_detail(db)
    finally:
        db.close()


def _entry_of(
    entries: Sequence[DerivationReportEntry],
    subject_id: str,
    derivation_type: str,
) -> DerivationReportEntry | None:
    return next(
        (
            entry
            for entry in entries
            if entry.subject_id == subject_id and entry.derivation_type == derivation_type
        ),
        None,
    )


async def _report_of(
    sdk: Lhc,
    file_path: str,
    owner: Literal["messages", "turns"],
    opts: MessageReportOpts | TurnReportOpts | None = None,
) -> list[DerivationReportEntry]:
    if owner == "messages":
        result = await sdk.messages.report({"filePath": file_path}, opts)  # type: ignore[arg-type]
    else:
        result = await sdk.turns.report({"filePath": file_path}, opts)  # type: ignore[arg-type]
    if not result.ok:
        raise RuntimeError(f"{owner} report failed: {result.error.reason}")
    return result.value


_MIXED_FAILED_REASON = "provider_failure: scripted failure"


@dataclass(frozen=True, slots=True)
class _MixedStateThread:
    sdk: Lhc
    double: InferenceCallbacksDouble
    file_path: str
    drain_report: DrainReport


async def _mixed_state_thread(store: TempStore) -> _MixedStateThread:
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)
    double.fail_kind("prompt_smoothing", 1, {"reason": _MIXED_FAILED_REASON})
    await _send(
        sdk,
        file_path,
        [valid_event("user_prompt", {"payload": {"text": "first prompt"}}), valid_event("turn_end")],
    )
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "second prompt"}}),
            valid_event("turn_end"),
        ],
    )
    await _send(
        sdk,
        file_path,
        [valid_event("user_prompt", {"payload": {"text": "third prompt, left open"}})],
    )
    corrupt_two_open_turns(file_path)
    drain_report = await _drain(sdk, file_path, {"maxItems": 4})
    return _MixedStateThread(sdk=sdk, double=double, file_path=file_path, drain_report=drain_report)


async def test_ready_failed_via_attempt_pending_via_unprocessed_queue_and_blocked_via_damage_land_and_read_back_failed_carries_the_stable_reason(
    store: TempStore,
) -> None:
    """ready, failed-via-attempt, pending-via-unprocessed-queue, and blocked-via-damage land and read back; failed carries the stable reason"""
    mixed = await _mixed_state_thread(store)
    sdk = mixed.sdk
    file_path = mixed.file_path
    drain_report = mixed.drain_report

    assert [(entry.work_item_id, entry.disposition) for entry in drain_report.ran] == [
        ("w-m1-prompt_smoothing-v1", "failed_terminal"),
        ("w-t1-turn_derivation-v1", "failed_terminal"),
        ("w-m3-prompt_smoothing-v1", "done"),
        ("w-t2-turn_derivation-v1", "failed_terminal"),
    ]
    assert drain_report.stopped_because == "max_items"
    assert drain_report.remaining == 1

    message_entries = await _report_of(sdk, file_path, "messages")
    turn_entries = await _report_of(sdk, file_path, "turns")

    failed = _entry_of(message_entries, "m1", "smoothed_prompt")
    assert failed is not None
    assert failed.state == "failed"
    assert failed.reason == _MIXED_FAILED_REASON
    assert failed.metadata is None

    assert _entry_of(message_entries, "m3", "smoothed_prompt") is not None
    assert _entry_of(message_entries, "m3", "smoothed_prompt").state == "ready"  # type: ignore[union-attr]
    assert _entry_of(message_entries, "m5", "smoothed_prompt") is not None
    assert _entry_of(message_entries, "m5", "smoothed_prompt").state == "pending"  # type: ignore[union-attr]
    rendering = _entry_of(turn_entries, "t1", "turn_rendering")
    assert rendering is not None
    assert rendering.state == "blocked"
    assert rendering.reason is not None
    assert "source_damaged" in rendering.reason

    for entry in [*message_entries, *turn_entries]:
        assert entry.state in ("pending", "ready", "failed", "blocked")


async def test_each_owner_reports_only_its_own_forms_not_ready_returns_exactly_the_failed_pending_blocked_set(
    store: TempStore,
) -> None:
    """each owner reports only its own forms; notReady returns exactly the failed+pending+blocked set"""
    mixed = await _mixed_state_thread(store)
    sdk = mixed.sdk
    file_path = mixed.file_path

    message_entries = await _report_of(sdk, file_path, "messages")
    assert all(entry.subject_kind == "message" for entry in message_entries)
    assert [(entry.subject_id, entry.state) for entry in message_entries] == [
        ("m1", "failed"),
        ("m3", "ready"),
        ("m5", "pending"),
    ]

    turn_entries = await _report_of(sdk, file_path, "turns")
    assert all(entry.subject_kind in ("turn", "chunk") for entry in turn_entries)
    assert [
        (entry.subject_id, entry.derivation_type, entry.state) for entry in turn_entries
    ] == [
        ("t1", "pre_detailed_assembly", "blocked"),
        ("t1", "turn_rendering", "blocked"),
        ("t2", "pre_detailed_assembly", "blocked"),
        ("t2", "turn_rendering", "blocked"),
    ]

    not_ready_messages = await _report_of(
        sdk, file_path, "messages", MessageReportOpts(not_ready=True)
    )
    assert [(entry.subject_id, entry.state) for entry in not_ready_messages] == [
        ("m1", "failed"),
        ("m5", "pending"),
    ]
    not_ready_turns = await _report_of(
        sdk, file_path, "turns", TurnReportOpts(not_ready=True)
    )
    assert len(not_ready_turns) == 4
    assert all(entry.state == "blocked" for entry in not_ready_turns)

    one_message = await sdk.messages.report(
        {"filePath": file_path}, MessageReportOpts(message_id="m1")
    )
    assert one_message.ok is True
    assert [entry.subject_id for entry in one_message.value] == ["m1"]
    one_turn = await sdk.turns.report({"filePath": file_path}, TurnReportOpts(turn_id="t2"))
    assert one_turn.ok is True
    assert [entry.subject_id for entry in one_turn.value] == ["t2", "t2"]


async def test_chunk_summaries_report_under_the_turns_owner_never_under_messages(
    store: TempStore,
) -> None:
    """chunk summaries report under the turns owner, never under messages"""
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
            valid_event("user_prompt", {"payload": {"text": "chunk one prompt"}}),
            valid_event("assistant_text", {"payload": {"text": "chunk one answer"}}),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path)
    double.fail_kind(
        "chunk_summary_brief", 1, {"reason": "provider_failure: scripted brief failure"}
    )
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "chunk two prompt"}}),
            valid_event("assistant_text", {"payload": {"text": "chunk two answer"}}),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path)

    turn_entries = await _report_of(sdk, file_path, "turns")
    chunk_entries = [entry for entry in turn_entries if entry.subject_kind == "chunk"]
    assert [
        (entry.subject_id, entry.derivation_type, entry.state) for entry in chunk_entries
    ] == [
        ("c1", "chunk_summary_brief", "ready"),
        ("c1", "chunk_summary_detailed", "ready"),
        ("c2", "chunk_summary_brief", "failed"),
        ("c2", "chunk_summary_detailed", "ready"),
    ]

    not_ready = await _report_of(sdk, file_path, "turns", TurnReportOpts(not_ready=True))
    assert [(entry.subject_id, entry.derivation_type, entry.state) for entry in not_ready] == [
        ("c2", "chunk_summary_brief", "failed"),
    ]

    message_entries = await _report_of(sdk, file_path, "messages")
    assert all(entry.subject_kind == "message" for entry in message_entries)
    assert not any(entry.subject_kind == "message" for entry in turn_entries)

    one_chunk = await sdk.turns.report({"filePath": file_path}, TurnReportOpts(chunk_id="c2"))
    assert one_chunk.ok is True
    assert [(entry.subject_id, entry.derivation_type) for entry in one_chunk.value] == [
        ("c2", "chunk_summary_brief"),
        ("c2", "chunk_summary_detailed"),
    ]


async def test_messages_derive_repairs_a_failed_smoothing_synchronously(store: TempStore) -> None:
    """messages.derive repairs a failed smoothing synchronously"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    gapped = await gapped_rendering_thread(store, sdk, double)
    file_path = gapped["filePath"]
    message_id = gapped["messageId"]

    assert _live_count(file_path) == 0
    before = _form_of(file_path, message_id, "smoothed_prompt")
    assert before is not None
    assert before.state == "failed"
    assert before.reason == GAPPED_SMOOTHING_REASON

    derived = await sdk.messages.derive({"filePath": file_path}, [message_id])
    assert derived.ok is True
    if not derived.ok:
        return
    assert derived.value == [
        MessageDerived(
            message_id=message_id,
            outcome="derived",
            derivation_type="smoothed_prompt",
            source_version=2,
        )
    ]

    repaired = _form_of(file_path, message_id, "smoothed_prompt")
    assert repaired is not None
    assert repaired.state == "ready"
    assert repaired.source_version == 2
    assert repaired.content is not None
    assert "smoothed(" in repaired.content
    assert repaired.reason is None
    assert repaired.metadata is not None
    assert repaired.metadata.inference_attempted is True
    assert repaired.metadata.inference_succeeded is True
    assert _live_count(file_path) == 0

    entries = await _report_of(sdk, file_path, "messages")
    entry = _entry_of(entries, message_id, "smoothed_prompt")
    assert entry is not None
    assert entry.state == "ready"
    assert entry.source_version == 2


async def test_turns_derive_turn_rebuilds_a_fallback_composed_rendering_at_the_next_source_version(
    store: TempStore,
) -> None:
    """turns.deriveTurn rebuilds a fallback-composed rendering at the next source version"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    gapped = await gapped_rendering_thread(store, sdk, double)
    file_path = gapped["filePath"]
    message_id = gapped["messageId"]
    turn_id = gapped["turnId"]
    before_repair = _form_of(file_path, turn_id, "turn_rendering")

    repair_smoothing = await sdk.messages.derive({"filePath": file_path}, [message_id])
    assert repair_smoothing.ok is True
    assert _form_of(file_path, message_id, "smoothed_prompt") is not None
    assert _form_of(file_path, message_id, "smoothed_prompt").state == "ready"  # type: ignore[union-attr]
    assert _form_of(file_path, turn_id, "turn_rendering") == before_repair

    rebuild = await sdk.turns.derive_turn({"filePath": file_path}, turn_id)
    assert rebuild.ok is True
    if not rebuild.ok:
        return
    assert rebuild.value == TurnDerived(turn_id=turn_id, outcome="derived", source_version=2)
    assert _live_count(file_path) == 0
    rebuilt = _form_of(file_path, turn_id, "turn_rendering")
    assert rebuilt is not None
    assert rebuilt.state == "ready"
    assert rebuilt.source_version == 2
    assert rebuilt.gaps is None
    compression = _form_of(file_path, turn_id, "detailed_turn_compression")
    assert compression is not None
    assert compression.state == "ready"
    assert compression.source_version == 2


async def test_derives_derivable_messages_and_reports_non_derivable_messages_without_queue_exposure(
    store: TempStore,
) -> None:
    """derives derivable messages and reports non-derivable messages without queue exposure"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    gapped = await gapped_rendering_thread(store, sdk, double)
    file_path = gapped["filePath"]
    message_id = gapped["messageId"]

    derived = await sdk.messages.derive({"filePath": file_path}, [message_id, "m2"])
    assert derived.ok is True
    if not derived.ok:
        return
    assert derived.value == [
        MessageDerived(
            message_id=message_id,
            outcome="derived",
            derivation_type="smoothed_prompt",
            source_version=2,
        ),
        MessageNotDerivable(message_id="m2", outcome="not_derivable"),
    ]
    assert _form_of(file_path, message_id, "smoothed_prompt") is not None
    assert _form_of(file_path, message_id, "smoothed_prompt").state == "ready"  # type: ignore[union-attr]
    assert _raw_detail(file_path) == []
    smoothings = [
        form
        for form in read_derived_forms(file_path)
        if form.subject_id == message_id and form.derivation_type == "smoothed_prompt"
    ]
    assert len(smoothings) == 1


async def test_turns_derive_turn_lands_synchronous_source_damage_as_blocked_rather_than_failed(
    store: TempStore,
) -> None:
    """turns.deriveTurn lands synchronous source damage as blocked rather than failed"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)
    await _send(sdk, file_path, [valid_event("user_prompt"), valid_event("turn_end")])
    await _drain(sdk, file_path)

    corrupt_two_open_turns(file_path)
    result = await sdk.turns.derive_turn({"filePath": file_path}, "t1")
    assert result.ok is True
    if not result.ok:
        return
    assert result.value.outcome == "failed"
    assert result.value.turn_id == "t1"
    assert result.value.error.code == "provider_failure"  # type: ignore[union-attr]
    assert "source_damaged" in result.value.error.reason  # type: ignore[union-attr]

    rendering = _form_of(file_path, "t1", "turn_rendering")
    assert rendering is not None
    assert rendering.state == "blocked"
    assert rendering.source_version == 2
    assert rendering.reason is not None
    assert "source_damaged" in rendering.reason
    assembly = _form_of(file_path, "t1", "pre_detailed_assembly")
    assert assembly is not None
    assert assembly.state == "blocked"
    assert assembly.source_version == 2
    assert assembly.reason is not None
    assert "source_damaged" in assembly.reason
    assert _live_count(file_path) == 0


async def test_a_turn_derivation_over_the_two_open_turns_corruption_blocks_naming_the_damage_blocked_is_not_failed_derive_is_refused(
    store: TempStore,
) -> None:
    """a turn derivation over the two-open-turns corruption blocks naming the damage; blocked is not failed — derive is refused"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    damaged = await damaged_source_thread(store)
    file_path = damaged["filePath"]
    turn_id = damaged["turnId"]

    report = await _drain(sdk, file_path)
    assert [(entry.work_item_id, entry.disposition) for entry in report.ran] == [
        ("w-m1-prompt_smoothing-v1", "done"),
        ("w-t1-turn_derivation-v1", "failed_terminal"),
        ("w-m4-prompt_smoothing-v1", "done"),
    ]
    assert report.ran[1].reason is not None
    assert "source_damaged" in report.ran[1].reason
    assert _live_count(file_path) == 0

    rendering = _form_of(file_path, turn_id, "turn_rendering")
    assert rendering is not None
    assert rendering.state == "blocked"
    assert rendering.reason is not None
    assert "source_damaged" in rendering.reason
    assert "open" in rendering.reason
    assert _form_of(file_path, turn_id, "pre_detailed_assembly") is not None
    assert _form_of(file_path, turn_id, "pre_detailed_assembly").state == "blocked"  # type: ignore[union-attr]
    assert _form_of(file_path, turn_id, "detailed_turn_compression") is None

    not_ready = await _report_of(sdk, file_path, "turns", TurnReportOpts(not_ready=True))
    assert [(entry.subject_id, entry.derivation_type, entry.state) for entry in not_ready] == [
        ("t1", "pre_detailed_assembly", "blocked"),
        ("t1", "turn_rendering", "blocked"),
    ]

    refused = await sdk.turns.derive_turn({"filePath": file_path}, turn_id)
    assert refused.ok is True
    if not refused.ok:
        return
    assert refused.value == TurnDeriveFailed(
        turn_id=turn_id,
        error=ErrorResult(
            code="source_damaged",
            error_class="state_corruption",
            reason=rendering.reason,
        ),
    )

    assert _live_count(file_path) == 0
    assert _form_of(file_path, turn_id, "turn_rendering") == rendering


async def test_with_every_non_ready_state_present_at_once_message_and_turn_reads_return_full_records_with_states_attached_and_zero_errors(
    store: TempStore,
) -> None:
    """with every non-ready state present at once, message and turn reads return full records with states attached and zero errors"""
    mixed = await _mixed_state_thread(store)
    sdk = mixed.sdk
    file_path = mixed.file_path

    messages_read = await sdk.messages.list({"filePath": file_path})
    assert messages_read.ok is True
    if not messages_read.ok:
        return
    assert [record.message_id for record in messages_read.value] == ["m1", "m3", "m5"]
    form_states = {
        record.message_id: (
            [form.state for form in record.derivations] if record.derivations is not None else None
        )
        for record in messages_read.value
    }
    assert form_states["m1"] == ["failed"]
    assert form_states["m3"] == ["ready"]
    assert form_states["m5"] == ["pending"]

    turns_read = await sdk.turns.list_turns({"filePath": file_path})
    assert turns_read.ok is True
    if not turns_read.ok:
        return
    assert [record.turn_id for record in turns_read.value] == ["t1", "t2", "t3", "t4"]
    first = turns_read.value[0]
    assert first.turn_id == "t1"
    assert first.status == "closed"
    assert first.member_message_ids == ["m1"]

    turn_form_states = {
        record.turn_id: (
            [(form.derivation_type, form.state) for form in record.derivations]
            if record.derivations is not None
            else None
        )
        for record in turns_read.value
    }
    assert turn_form_states["t1"] == [
        ("pre_detailed_assembly", "blocked"),
        ("turn_rendering", "blocked"),
    ]
    assert turn_form_states["t2"] == [
        ("pre_detailed_assembly", "blocked"),
        ("turn_rendering", "blocked"),
    ]
    assert turn_form_states["t3"] is None
    assert turn_form_states["t4"] is None

    events_read = await sdk.intake_stream.list_events({"filePath": file_path})
    assert events_read.ok is True


async def test_chunk_reads_return_records_with_summary_form_states_attached_including_non_ready_ones(
    store: TempStore,
) -> None:
    """chunk reads return records with summary-form states attached, including non-ready ones"""
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
            valid_event("user_prompt", {"payload": {"text": "chunk read prompt one"}}),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path)
    double.fail_kind(
        "chunk_summary_brief", 1, {"reason": "provider_failure: scripted brief failure"}
    )
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "chunk read prompt two"}}),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path)

    chunks_read = await sdk.turns.list_chunks({"filePath": file_path})
    assert chunks_read.ok is True
    if not chunks_read.ok:
        return
    assert [(record.chunk_id, record.status) for record in chunks_read.value] == [
        ("c1", "closed"),
        ("c2", "closed"),
    ]
    assert chunks_read.value[0].member_turn_ids == ["t1"]
    chunk_form_states = [
        (
            [(form.derivation_type, form.state) for form in record.derivations]
            if record.derivations is not None
            else None
        )
        for record in chunks_read.value
    ]
    assert chunk_form_states == [
        [
            ("chunk_summary_brief", "ready"),
            ("chunk_summary_detailed", "ready"),
        ],
        [
            ("chunk_summary_brief", "failed"),
            ("chunk_summary_detailed", "ready"),
        ],
    ]
    failed_brief = next(
        (
            form
            for form in (chunks_read.value[1].derivations or [])
            if form.derivation_type == "chunk_summary_brief"
        ),
        None,
    )
    assert failed_brief is not None
    assert failed_brief.reason == "provider_failure: scripted brief failure"
