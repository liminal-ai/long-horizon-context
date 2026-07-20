"""Ported from packages/lhc/test/chunk-brief-from-detailed.test.ts. Phase 1.

Story 5: chunk_summary_brief from detailed material.
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import asdict, is_dataclass
from typing import Any, Literal, TypedDict

import pytest

from lhc import DrainReport, InferenceCallbacks, Lhc, MessageEventInput, init_lhc, queue_detail, threads
from lhc.sdk import DrainOpts
from lhc.shared_tech.derivation import (
    ChunkPolicyConfig,
    DerivationState,
    LeaseConfig,
    SdkConfig,
)
from lhc.shared_tech.inference_types import DerivationGuards, DetailedTurnCompressionGuards
from lhc.shared_tech.token_counting import estimate_tokens
from lhc.threads import NewThreadInput
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
    open_raw,
    read_derived_forms,
    set_form_state,
    temp_store,
    valid_event,
)
from fixtures.threads import FormStateUpdate

_SELF_CHUNK = ChunkPolicyConfig(target_projected_tokens=1, max_projected_tokens=1)

# node:sqlite SQLInputValue stand-in (null | number | string | Uint8Array).
SqlInputValue = int | float | str | bytes | None

ChunkSummaryDerivationType = Literal["chunk_summary_detailed", "chunk_summary_brief"]


# NOTE (Phase 2): Partial<SdkConfig> — TypedDict total=False is the stand-in;
# cannot express TS structural Partial without inventing a DSL.
class _SdkConfigPartial(TypedDict, total=False):
    mode: Literal["background", "manual"]
    inference_callbacks: InferenceCallbacks
    lease: LeaseConfig
    guards: DerivationGuards
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
        "guards": DerivationGuards(
            detailed_turn_compression=DetailedTurnCompressionGuards(tiny_turn_tokens=1)
        ),
        "chunk_policy": _SELF_CHUNK,
    }
    if overrides:
        fields.update(overrides)
    return init_lhc(SdkConfig(**fields))  # type: ignore[arg-type]


async def _send(sdk: Lhc, file_path: str, batch: Sequence[MessageEventInput]) -> None:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(result.error.reason)


async def _drain(sdk: Lhc, file_path: str, opts: DrainOpts | None = None) -> DrainReport:
    result = await sdk.work.drain({"filePath": file_path}, opts)
    if not result.ok:
        raise RuntimeError(result.error.reason)
    return result.value


async def _send_prompt_turn(sdk: Lhc, file_path: str, prompt: str, answer: str) -> None:
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": prompt}}),
            valid_event("assistant_text", {"payload": {"text": answer}}),
            valid_event("turn_end"),
        ],
    )


def _exec_sql(file_path: str, sql: str, *params: SqlInputValue) -> None:
    db = open_raw(file_path)
    try:
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
    update: FormStateUpdate = {"state": state}
    if "content" in opts:
        update["content"] = opts["content"]
    if "reason" in opts:
        update["reason"] = opts["reason"]
    set_form_state(
        file_path,
        {"subjectKind": "chunk", "subjectId": chunk_id, "derivationType": derivation_type},
        update,
    )


def _enqueue_chunk_summary_work(
    file_path: str,
    work_item_id: str,
    chunk_id: str,
    derivation_type: ChunkSummaryDerivationType,
    source_version: int = 1,
) -> None:
    _exec_sql(
        file_path,
        """INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
     VALUES (?, 'turns', ?, ?, 'queued', '2026-06-22T00:00:00.000Z', ?)""",
        work_item_id,
        derivation_type,
        json.dumps({"chunkId": chunk_id}, separators=(",", ":")),
        json.dumps(
            {
                "sourceVersion": source_version,
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


async def _seed_closed_chunk(sdk: Lhc, file_path: str) -> None:
    await _send_prompt_turn(sdk, file_path, "brief source prompt", "brief source answer")
    await _drain(sdk, file_path)


def _js_round(value: float) -> int:
    """JS Math.round for non-negative values: floor(x + 0.5)."""
    return math.floor(value + 0.5)


def _target_input_for(text: str) -> dict[str, object]:
    input_tokens = estimate_tokens(text)
    return {
        "text": text,
        "inputTokens": input_tokens,
        "targetMinTokens": max(1, _js_round(input_tokens * 0.08)),
        "targetAimTokens": max(1, _js_round(input_tokens * 0.12)),
        "targetMaxTokens": max(1, _js_round(input_tokens * 0.2)),
    }


def _to_jsonable(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return {k: _to_jsonable(v) for k, v in asdict(value).items()}
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    return value


async def test_sends_detailed_text_and_concrete_targets_to_the_model_then_records_sizedisposition(
    store: TempStore,
) -> None:
    """sends detailed text and concrete targets to the model, then records sizeDisposition"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)
    await _seed_closed_chunk(sdk, file_path)
    detailed_text = "seeded detailed text; not the member compression"
    member_form = _form_of(file_path, "t1", "detailed_turn_compression")
    member_compression = (
        member_form.content if member_form is not None and member_form.content is not None else ""
    )
    assert member_compression != detailed_text

    _set_chunk_summary_state(
        file_path, "c1", "chunk_summary_detailed", "ready", {"content": detailed_text}
    )
    _set_chunk_summary_state(file_path, "c1", "chunk_summary_brief", "pending")

    derived = await sdk.turns.derive_brief_chunk({"filePath": file_path}, "c1")

    assert derived.ok is True
    if not derived.ok:
        return
    # expect.objectContaining
    assert derived.value.chunk_id == "c1"
    assert derived.value.derivation_type == "chunk_summary_brief"
    assert derived.value.outcome == "derived"
    expected_input = _target_input_for(detailed_text)
    brief_entries = [entry for entry in captured if entry.op == "summarizeChunkBrief"]
    brief_input = brief_entries[-1].input if brief_entries else None
    assert brief_input == expected_input
    assert member_compression not in json.dumps(_to_jsonable(brief_input), separators=(",", ":"))
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "ready"
    assert brief.metadata is not None
    assert isinstance(brief.metadata.size_disposition, str)


async def test_defers_behind_live_detailed_work_without_writing_detailed_directly(
    store: TempStore,
) -> None:
    """defers behind live detailed work without writing detailed directly"""
    sdk = _sdk_for(create_inference_callbacks_double())
    file_path = await _new_thread(store)
    await _seed_closed_chunk(sdk, file_path)
    _set_chunk_summary_state(file_path, "c1", "chunk_summary_detailed", "pending")
    _set_chunk_summary_state(file_path, "c1", "chunk_summary_brief", "pending")
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_brief-v1", "c1", "chunk_summary_brief"
    )
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_detailed-v1", "c1", "chunk_summary_detailed"
    )

    await _drain(sdk, file_path, {"maxItems": 1})

    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.state == "pending"
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "pending"
    brief_row = next(
        (row for row in _live_queue(file_path) if row.work_item_id == "w-c1-chunk_summary_brief-v1"),
        None,
    )
    assert brief_row is not None
    assert brief_row.status == "queued"
    assert (
        next(
            (
                row
                for row in _live_queue(file_path)
                if row.work_item_id == "w-c1-chunk_summary_detailed-v1"
            ),
            None,
        )
        is not None
    )
    assert len([row for row in _live_queue(file_path) if row.kind == "chunk_summary_brief"]) == 1

    await _drain(sdk, file_path)

    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.state == "ready"
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "ready"


async def test_schedules_detailed_work_before_requeued_brief_when_no_detailed_work_is_live(
    store: TempStore,
) -> None:
    """schedules detailed work before requeued brief when no detailed work is live"""
    sdk = _sdk_for(create_inference_callbacks_double())
    file_path = await _new_thread(store)
    await _seed_closed_chunk(sdk, file_path)
    _set_chunk_summary_state(file_path, "c1", "chunk_summary_detailed", "pending")
    _set_chunk_summary_state(file_path, "c1", "chunk_summary_brief", "pending")
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_brief-v1", "c1", "chunk_summary_brief"
    )

    await _drain(sdk, file_path, {"maxItems": 1})

    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.state == "pending"
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "pending"
    brief_row = next(
        (row for row in _live_queue(file_path) if row.work_item_id == "w-c1-chunk_summary_brief-v1"),
        None,
    )
    assert brief_row is not None
    assert brief_row.status == "queued"
    assert (
        next(
            (
                row
                for row in _live_queue(file_path)
                if row.work_item_id == "w-c1-chunk_summary_detailed-v1"
            ),
            None,
        )
        is not None
    )
    assert len([row for row in _live_queue(file_path) if row.kind == "chunk_summary_brief"]) == 1

    await _drain(sdk, file_path)

    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.state == "ready"
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "ready"


async def test_uses_the_current_brief_source_version_when_the_detailed_row_is_missing(
    store: TempStore,
) -> None:
    """uses the current brief source version when the detailed row is missing"""
    sdk = _sdk_for(create_inference_callbacks_double())
    file_path = await _new_thread(store)
    await _seed_closed_chunk(sdk, file_path)
    _exec_sql(
        file_path,
        """DELETE FROM derivation
       WHERE subject_kind = 'chunk' AND subject_id = 'c1' AND derivation_type = 'chunk_summary_detailed'""",
    )
    _exec_sql(
        file_path,
        """UPDATE derivation SET state = 'pending', content = NULL, reason = NULL, metadata = NULL, source_version = 3
       WHERE subject_kind = 'chunk' AND subject_id = 'c1' AND derivation_type = 'chunk_summary_brief'""",
    )
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_brief-v3", "c1", "chunk_summary_brief", 3
    )

    await _drain(sdk, file_path, {"maxItems": 1})

    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.source_version == 3
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.source_version == 3
    detailed_row = next(
        (
            row
            for row in _live_queue(file_path)
            if row.work_item_id == "w-c1-chunk_summary_detailed-v3"
        ),
        None,
    )
    assert detailed_row is not None
    assert detailed_row.source_version == 3
    assert detailed_row.status == "queued"
    brief_row = next(
        (row for row in _live_queue(file_path) if row.work_item_id == "w-c1-chunk_summary_brief-v3"),
        None,
    )
    assert brief_row is not None
    assert brief_row.source_version == 3
    assert brief_row.status == "queued"


async def test_keeps_detailed_pending_when_its_member_projection_is_pending(store: TempStore) -> None:
    """keeps detailed pending when its member projection is pending"""
    sdk = _sdk_for(create_inference_callbacks_double())
    file_path = await _new_thread(store)
    await _seed_closed_chunk(sdk, file_path)
    _set_chunk_summary_state(file_path, "c1", "chunk_summary_detailed", "pending")
    _set_chunk_summary_state(file_path, "c1", "chunk_summary_brief", "pending")
    set_form_state(
        file_path,
        {
            "subjectKind": "turn",
            "subjectId": "t1",
            "derivationType": "detailed_turn_compression",
        },
        {"state": "pending"},
    )
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_brief-v1", "c1", "chunk_summary_brief"
    )

    await _drain(sdk, file_path, {"maxItems": 1})

    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.state == "pending"
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "pending"
    brief_row = next(
        (row for row in _live_queue(file_path) if row.work_item_id == "w-c1-chunk_summary_brief-v1"),
        None,
    )
    assert brief_row is not None
    assert brief_row.status == "queued"

    await _drain(sdk, file_path, {"maxItems": 1})

    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.state == "failed"
    assert "member_projection_not_ready" in (detailed.reason or "")
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "pending"
    assert (
        next(
            (
                row
                for row in _live_queue(file_path)
                if row.work_item_id == "w-c1-chunk_summary_detailed-v1"
            ),
            None,
        )
        is None
    )


async def test_blocks_when_detailed_is_blocked_or_failed(store: TempStore) -> None:
    """blocks when detailed is blocked or failed"""
    sdk = _sdk_for(create_inference_callbacks_double())
    file_path = await _new_thread(store)
    await _seed_closed_chunk(sdk, file_path)

    _set_chunk_summary_state(
        file_path, "c1", "chunk_summary_detailed", "blocked", {"reason": "source damaged"}
    )
    _set_chunk_summary_state(file_path, "c1", "chunk_summary_brief", "pending")
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_brief-v1", "c1", "chunk_summary_brief"
    )
    await _drain(sdk, file_path, {"maxItems": 1})
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "blocked"
    assert "source_damaged" in (brief.reason or "")

    _set_chunk_summary_state(
        file_path, "c1", "chunk_summary_detailed", "failed", {"reason": "detailed failed"}
    )
    _set_chunk_summary_state(file_path, "c1", "chunk_summary_brief", "pending")
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_brief-v2", "c1", "chunk_summary_brief"
    )
    await _drain(sdk, file_path, {"maxItems": 1})
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "blocked"
    assert "source_damaged" in (brief.reason or "")
