"""Ported from packages/lhc/test/chunk-compact-recovery.test.ts. Phase 1.

Story 4: chunk derivation and compact recovery.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Literal, TypedDict

import pytest

from lhc import InferenceCallbacks, Lhc, MessageEventInput, init_lhc, queue_detail, threads
from lhc.sdk import DrainOpts
from lhc.shared_tech.derivation import ChunkPolicyConfig, DerivationState, LeaseConfig, SdkConfig
from lhc.shared_tech.logging import LogQuery
from lhc.shared_tech.view import (
    CompactWarning,
    PartialViewProfilePercentages,
    ViewCompactParams,
)
from lhc.thread_view import CompactAbortSignal, CompactOpts
from lhc.threads import NewThreadInput
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
    open_raw,
    read_derived_forms,
    temp_store,
    valid_event,
)

# node:sqlite SQLInputValue stand-in.
SqlInputValue = int | float | str | bytes | None

ChunkSummaryDerivationType = Literal["chunk_summary_detailed", "chunk_summary_brief"]


# NOTE (Phase 2): Partial<SdkConfig> — TypedDict total=False stand-in.
class _SdkConfigPartial(TypedDict, total=False):
    mode: Literal["background", "manual"]
    inference_callbacks: InferenceCallbacks
    lease: LeaseConfig
    chunk_policy: ChunkPolicyConfig


class _ChunkSummaryStateOpts(TypedDict, total=False):
    content: str
    reason: str


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


async def _new_thread(store: TempStore) -> str:
    created = await threads.new_thread(
        NewThreadInput(file_path=store.thread_path(), registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(created.error.reason)
    return created.value.file_path


def _sdk_for(
    inference_callbacks: InferenceCallbacks,
    overrides: _SdkConfigPartial | None = None,
) -> Lhc:
    fields: dict[str, object] = {
        "inference_callbacks": inference_callbacks,
        "mode": "manual",
        "lease": LeaseConfig(duration_ms=200),
        "chunk_policy": ChunkPolicyConfig(target_projected_tokens=1, max_projected_tokens=999999),
    }
    if overrides:
        fields.update(overrides)
    return init_lhc(SdkConfig(**fields))  # type: ignore[arg-type]


async def _send(sdk: Lhc, file_path: str, batch: Sequence[MessageEventInput]) -> None:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(result.error.reason)


async def _drain(sdk: Lhc, file_path: str, opts: DrainOpts | None = None) -> None:
    result = await sdk.work.drain({"filePath": file_path}, opts)
    if not result.ok:
        raise RuntimeError(result.error.reason)


def _exec_sql(file_path: str, sql: str, *params: SqlInputValue) -> None:
    db = open_raw(file_path)
    try:
        db.prepare(sql).run(*params)
    finally:
        db.close()


def _exec_corrupt_sql(file_path: str, sql: str, *params: SqlInputValue) -> None:
    db = open_raw(file_path)
    try:
        db.exec("PRAGMA foreign_keys = OFF;")
        db.prepare(sql).run(*params)
    finally:
        db.close()


def _form_of(file_path: str, subject_id: str, derivation_type: str):
    return next(
        (
            form
            for form in read_derived_forms(file_path)
            if form.subject_id == subject_id and form.derivation_type == derivation_type
        ),
        None,
    )


def _live_queue(file_path: str):
    db = open_raw(file_path)
    try:
        return queue_detail(db)
    finally:
        db.close()


def _set_chunk_summary_state(
    file_path: str,
    chunk_id: str,
    derivation_type: ChunkSummaryDerivationType,
    state: DerivationState,
    opts: _ChunkSummaryStateOpts | None = None,
) -> None:
    opts = opts or {}
    _exec_sql(
        file_path,
        """UPDATE derivation SET state = ?, content = ?, reason = ? 
     WHERE subject_kind = 'chunk' AND subject_id = ? AND derivation_type = ?""",
        state,
        opts.get("content"),
        opts.get("reason"),
        chunk_id,
        derivation_type,
    )


def _delete_work_for(file_path: str, kind: str, chunk_id: str) -> None:
    _exec_sql(
        file_path,
        "DELETE FROM work_item WHERE kind = ? AND json_extract(source_ref, '$.chunkId') = ?",
        kind,
        chunk_id,
    )


def _enqueue_chunk_summary_work(
    file_path: str,
    work_item_id: str,
    chunk_id: str,
    derivation_type: Literal["chunk_summary_detailed", "chunk_summary_brief"],
) -> None:
    _exec_sql(
        file_path,
        """INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
     VALUES (?, 'turns', ?, ?, 'queued', '2026-06-15T00:00:00.000Z', ?)""",
        work_item_id,
        derivation_type,
        json.dumps({"chunkId": chunk_id}, separators=(",", ":")),
        json.dumps(
            {
                "sourceVersion": 1,
                "derivations": [
                    {
                        "subjectKind": "chunk",
                        "subjectId": chunk_id,
                        "derivationType": derivation_type,
                    }
                ],
            },
            separators=(",", ":"),
        ),
    )


async def _seed_four_closed_turns(sdk: Lhc, file_path: str) -> None:
    for i in range(1, 5):
        await _send(
            sdk,
            file_path,
            [
                valid_event("user_prompt", {"payload": {"text": f"prompt {i}"}}),
                valid_event("assistant_text", {"payload": {"text": f"answer {i}"}}),
                valid_event("turn_end"),
            ],
        )
    await _drain(sdk, file_path)


def _compact_params() -> ViewCompactParams:
    return ViewCompactParams(
        lower_bound=120,
        percentages=PartialViewProfilePercentages(full=10, smooth=10, detailed=70, brief=10),
    )


async def test_queues_detailed_and_brief_chunk_summaries_as_independent_work_items_and_states(
    store: TempStore,
) -> None:
    """queues detailed and brief chunk summaries as independent work items and states"""
    double = create_inference_callbacks_double()
    double.fail_kind("chunk_summary_brief", 1, {"reason": "timeout: scripted brief failure"})
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)

    await _seed_four_closed_turns(sdk, file_path)

    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.state == "ready"
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "failed"
    assert brief.reason == "timeout: scripted brief failure"


async def test_compacts_not_ready_chunk_summaries_through_stored_member_concat_with_zero_model_calls(
    store: TempStore,
) -> None:
    """compacts not-ready chunk summaries through stored-member concat with zero model calls"""
    sdk = _sdk_for(create_inference_callbacks_double())
    file_path = await _new_thread(store)
    await _seed_four_closed_turns(sdk, file_path)
    _set_chunk_summary_state(
        file_path,
        "c1",
        "chunk_summary_detailed",
        "failed",
        {"reason": "timeout: old summary failed"},
    )
    _delete_work_for(file_path, "chunk_summary_detailed", "c1")

    spy = create_inference_callbacks_double()
    captured = spy.capture_inputs()
    compact_sdk = _sdk_for(spy)
    compacted = await compact_sdk.thread_view.compact(
        {"filePath": file_path},
        CompactOpts(params=_compact_params()),
    )

    assert compacted.ok is True
    if not compacted.ok:
        return
    assert captured == []
    assert compacted.value.warnings is not None
    assert (
        CompactWarning(
            band="detailed",
            subject_id="c1",
            derivation_type="chunk_summary_detailed",
            reason="failed_floor",
        )
        in compacted.value.warnings
    )
    context_read = await compact_sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert context_read.ok is True
    if not context_read.ok:
        return
    detailed_msg = next(
        (
            message
            for message in context_read.value.messages
            if any(part.text.startswith("[context · detailed]") for part in message.content)
        ),
        None,
    )
    detailed_text = (
        "".join(part.text for part in detailed_msg.content) if detailed_msg is not None else None
    )
    assert detailed_text is not None
    assert "[degraded: detailed-from-stored-members]" in detailed_text
    assert "prompt 1\nanswer 1" in detailed_text
    assert "unavailable" not in detailed_text

    logs = await compact_sdk.logging.query(
        {"filePath": file_path},
        LogQuery(derivation_type="chunk_summary_detailed", subject_id="c1"),
    )
    assert logs.ok is True
    if not logs.ok:
        return
    assert logs.value[0].level == "warning"
    assert logs.value[0].reason == "failed_floor"
    assert logs.value[0].floor_used == "stored_member_concat"


async def test_halts_compact_before_fallback_assembly_when_stop_is_requested(
    store: TempStore,
) -> None:
    """halts compact before fallback assembly when stop is requested"""
    sdk = _sdk_for(create_inference_callbacks_double())
    file_path = await _new_thread(store)
    await _seed_four_closed_turns(sdk, file_path)
    _set_chunk_summary_state(file_path, "c1", "chunk_summary_detailed", "pending")
    _delete_work_for(file_path, "chunk_summary_detailed", "c1")

    stopped = await sdk.thread_view.compact(
        {"filePath": file_path},
        CompactOpts(signal=CompactAbortSignal(aborted=True), params=_compact_params()),
    )

    assert stopped.ok is False
    if stopped.ok:
        return
    assert stopped.error.error_class == "caller_error"
    assert stopped.error.code == "compact_stopped"
    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.state == "pending"


async def test_refuses_compact_when_canonical_member_source_is_corrupt(store: TempStore) -> None:
    """refuses compact when canonical member source is corrupt"""
    sdk = _sdk_for(create_inference_callbacks_double())
    file_path = await _new_thread(store)
    await _seed_four_closed_turns(sdk, file_path)
    _set_chunk_summary_state(file_path, "c1", "chunk_summary_detailed", "pending")
    _delete_work_for(file_path, "chunk_summary_detailed", "c1")
    _exec_corrupt_sql(file_path, "DELETE FROM turns WHERE turn_id = 't1'")

    compacted = await sdk.thread_view.compact(
        {"filePath": file_path},
        CompactOpts(params=_compact_params()),
    )

    assert compacted.ok is False
    if compacted.ok:
        return
    assert compacted.error.error_class == "state_corruption"


async def test_background_chunk_summary_work_requeues_on_not_ready_member_projection(
    store: TempStore,
) -> None:
    """background chunk summary work requeues on not-ready member projection"""
    sdk = _sdk_for(create_inference_callbacks_double())
    file_path = await _new_thread(store)
    await _seed_four_closed_turns(sdk, file_path)
    _set_chunk_summary_state(file_path, "c1", "chunk_summary_detailed", "pending")
    _exec_sql(
        file_path,
        """UPDATE derivation SET state = 'pending', content = NULL
       WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'detailed_turn_compression'""",
    )
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_detailed-v99", "c1", "chunk_summary_detailed"
    )

    await _drain(sdk, file_path, {"maxItems": 1})

    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.state == "failed"
    assert "member_projection_not_ready" in (detailed.reason or "")
    item = next(
        (row for row in _live_queue(file_path) if row.work_item_id == "w-c1-chunk_summary_detailed-v99"),
        None,
    )
    assert item is None


async def test_background_chunk_summaries_block_when_a_chunk_member_references_a_missing_turn(
    store: TempStore,
) -> None:
    """background chunk summaries block when a chunk member references a missing turn"""
    sdk = _sdk_for(create_inference_callbacks_double())
    file_path = await _new_thread(store)
    await _seed_four_closed_turns(sdk, file_path)
    _set_chunk_summary_state(file_path, "c1", "chunk_summary_detailed", "pending")
    _set_chunk_summary_state(file_path, "c1", "chunk_summary_brief", "pending")
    _exec_corrupt_sql(file_path, "DELETE FROM turns WHERE turn_id = 't1'")
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_detailed-v98", "c1", "chunk_summary_detailed"
    )
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_brief-v98", "c1", "chunk_summary_brief"
    )

    await _drain(sdk, file_path, {"maxItems": 2})

    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.state == "blocked"
    assert "source_damaged" in (detailed.reason or "")
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "blocked"
    assert "source_damaged" in (brief.reason or "")
