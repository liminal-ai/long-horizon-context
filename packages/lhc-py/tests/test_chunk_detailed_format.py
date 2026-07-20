"""Ported from packages/lhc/test/chunk-detailed-format.test.ts. Phase 1.

Story 4: chunk_summary_detailed concatenation format.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Literal, TypedDict

import pytest

from lhc import DrainReport, InferenceCallbacks, InferenceResult, Lhc, MessageEventInput, init_lhc, queue_detail, threads
from lhc.sdk import DrainOpts
from lhc.shared_tech.derivation import (
    ChunkPolicyConfig,
    InferenceOk,
    LeaseConfig,
    SdkConfig,
)
from lhc.shared_tech.deterministic import deterministic_text
from lhc.shared_tech.inference_types import DerivationGuards, DetailedTurnCompressionGuards
from lhc.shared_tech.logging import LogQuery
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
_FIXED_PROJECTION = "fixed projected turn text"

# node:sqlite SQLInputValue stand-in.
SqlInputValue = int | float | str | bytes | None

ChunkSummaryDerivationType = Literal["chunk_summary_detailed", "chunk_summary_brief"]


# NOTE (Phase 2): Partial<SdkConfig> — TypedDict total=False stand-in.
class _SdkConfigPartial(TypedDict, total=False):
    mode: Literal["background", "manual"]
    inference_callbacks: InferenceCallbacks
    lease: LeaseConfig
    guards: DerivationGuards
    chunk_policy: ChunkPolicyConfig


# TS setCompressionState update shape.
class _CompressionStateUpdate(TypedDict, total=False):
    state: Literal["pending", "failed", "blocked"]
    reason: str
    content: str


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


def _smoothed_prompt(text: str) -> str:
    return deterministic_text("smoothPrompt", {"text": text}, text)


def _dialogue_assembly_text(prompt: str, answer: str) -> str:
    return f"User:\n{_smoothed_prompt(prompt)}\n\n⏺ {answer}"


def _assembly_tokens(prompt: str, answer: str) -> int:
    return estimate_tokens(_dialogue_assembly_text(prompt, answer))


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


def _with_scripted_projection(
    base: InferenceCallbacks, projection: str = _FIXED_PROJECTION
) -> InferenceCallbacks:
    class _Callbacks:
        async def smooth_prompt(self, input):
            return await base.smooth_prompt(input)

        async def summarize_tool_result(self, input):
            return await base.summarize_tool_result(input)

        async def compress_detailed_turn(self, input) -> InferenceResult:
            return InferenceOk(text=projection)

        async def summarize_chunk_brief(self, input):
            return await base.summarize_chunk_brief(input)

    return _Callbacks()  # type: ignore[return-value]


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


async def _send_tool_turn(sdk: Lhc, file_path: str) -> None:
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "read the project plan"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "tool-a",
                        "toolName": "read_file",
                        "arguments": {"path": "docs/plan.md"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "tool-a", "content": "plan contents", "isError": False}},
            ),
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


def _enqueue_chunk_summary_work(
    file_path: str,
    work_item_id: str,
    chunk_id: str,
    derivation_type: ChunkSummaryDerivationType,
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


def _reset_chunk_summary(
    file_path: str,
    chunk_id: str,
    derivation_type: ChunkSummaryDerivationType,
) -> None:
    set_form_state(
        file_path,
        {"subjectKind": "chunk", "subjectId": chunk_id, "derivationType": derivation_type},
        {"state": "pending"},
    )


def _set_compression_state(
    file_path: str,
    turn_id: str,
    update: _CompressionStateUpdate,
) -> None:
    form_update: FormStateUpdate = {"state": update["state"]}
    if "reason" in update:
        form_update["reason"] = update["reason"]
    if "content" in update:
        form_update["content"] = update["content"]
    set_form_state(
        file_path,
        {
            "subjectKind": "turn",
            "subjectId": turn_id,
            "derivationType": "detailed_turn_compression",
        },
        form_update,
    )


async def test_derives_blank_line_separated_member_text_in_order_without_a_detailed_model_call(
    store: TempStore,
) -> None:
    """derives blank-line-separated member text in order without a detailed model call"""
    double = create_inference_callbacks_double()
    per_turn_tokens = _assembly_tokens("first prompt", "first answer")
    sdk = _sdk_for(
        _with_scripted_projection(double),
        {
            "chunk_policy": ChunkPolicyConfig(
                target_projected_tokens=4 * per_turn_tokens, max_projected_tokens=999999
            )
        },
    )
    file_path = await _new_thread(store)

    await _send_prompt_turn(sdk, file_path, "first prompt", "first answer")
    await _send_prompt_turn(sdk, file_path, "second prompt", "second answer")
    await _send_prompt_turn(sdk, file_path, "third prompt", "third answer")
    await _send_prompt_turn(sdk, file_path, "fourth prompt", "fourth answer")
    await _drain(sdk, file_path)

    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    detailed_text = detailed.content if detailed is not None else None

    assert detailed_text == f"{_FIXED_PROJECTION}\n\n{_FIXED_PROJECTION}\n\n{_FIXED_PROJECTION}"
    assert detailed_text is not None
    assert " | " not in detailed_text


async def test_detailed_assembly_is_compression_text_only_no_receipt_block_no_tool_argument_leak(
    store: TempStore,
) -> None:
    """detailed assembly is compression text only — no receipt block, no tool argument leak"""
    double = create_inference_callbacks_double()
    per_turn_tokens = _assembly_tokens("plain prompt", "plain answer")
    tool_turn_tokens = estimate_tokens(f"User:\n{_smoothed_prompt('read the project plan')}")
    placement_tokens = max(per_turn_tokens, tool_turn_tokens)
    sdk = _sdk_for(
        _with_scripted_projection(double),
        {
            "chunk_policy": ChunkPolicyConfig(
                target_projected_tokens=2 * placement_tokens, max_projected_tokens=999999
            )
        },
    )
    file_path = await _new_thread(store)
    await _send_tool_turn(sdk, file_path)
    await _send_prompt_turn(sdk, file_path, "plain prompt", "plain answer")
    await _send_prompt_turn(sdk, file_path, "closing prompt", "closing answer")

    await _drain(sdk, file_path)

    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.content == f"{_FIXED_PROJECTION}\n\n{_FIXED_PROJECTION}"
    assert "[receipts" not in (detailed.content or "")
    assert '({"' not in (detailed.content or "")
    assert "docs/plan.md" not in (detailed.content or "")
    rendering = _form_of(file_path, "t1", "turn_rendering")
    assert rendering is not None
    assert "tool run · read_file · 1 call · 1 succeeded" in (rendering.content or "")
    assert rendering.metadata is None


async def test_uses_ready_pre_detailed_assembly_as_the_floor_for_failed_detailed_members_and_logs_the_fallback(
    store: TempStore,
) -> None:
    """uses ready pre_detailed_assembly as the floor for failed detailed members and logs the fallback"""
    sdk = _sdk_for(create_inference_callbacks_double())
    file_path = await _new_thread(store)
    await _send_prompt_turn(sdk, file_path, "floor prompt", "floor answer")
    await _drain(sdk, file_path)
    assembly_form = _form_of(file_path, "t1", "pre_detailed_assembly")
    assembly = assembly_form.content if assembly_form is not None else None
    assert assembly is not None

    _set_compression_state(file_path, "t1", {"state": "failed", "reason": "scripted compression failure"})
    _reset_chunk_summary(file_path, "c1", "chunk_summary_detailed")
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_detailed-v1", "c1", "chunk_summary_detailed"
    )

    report = await _drain(sdk, file_path, {"maxItems": 1})

    assert [(entry.work_item_id, entry.disposition) for entry in report.ran] == [
        ("w-c1-chunk_summary_detailed-v1", "done"),
    ]
    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.state == "ready"
    assert detailed.content == assembly
    logs = await sdk.logging.query(
        {"filePath": file_path},
        LogQuery(derivation_type="chunk_summary_detailed", subject_id="c1"),
    )
    assert logs.ok is True
    if not logs.ok:
        return
    assert any(
        entry.reason == "failed_floor" and entry.floor_used == "t1" and entry.level == "warning"
        for entry in logs.value
    )


async def test_does_not_log_failed_floor_fallback_when_completion_is_stale_discarded(
    store: TempStore,
) -> None:
    """does not log failed-floor fallback when completion is stale-discarded"""
    sdk = _sdk_for(create_inference_callbacks_double())
    file_path = await _new_thread(store)
    await _send_prompt_turn(sdk, file_path, "stale floor prompt", "stale floor answer")
    await _drain(sdk, file_path)

    _set_compression_state(file_path, "t1", {"state": "failed", "reason": "scripted compression failure"})
    _reset_chunk_summary(file_path, "c1", "chunk_summary_detailed")
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_detailed-v1", "c1", "chunk_summary_detailed"
    )
    _exec_sql(
        file_path,
        """UPDATE derivation SET source_version = 2
       WHERE subject_kind = 'chunk' AND subject_id = 'c1' AND derivation_type = 'chunk_summary_detailed'""",
    )

    report = await _drain(sdk, file_path, {"maxItems": 1})

    assert [(entry.work_item_id, entry.disposition) for entry in report.ran] == [
        ("w-c1-chunk_summary_detailed-v1", "stale_discarded"),
    ]
    logs = await sdk.logging.query(
        {"filePath": file_path},
        LogQuery(derivation_type="chunk_summary_detailed", subject_id="c1"),
    )
    assert logs.ok is True
    if not logs.ok:
        return
    assert logs.value == []


async def test_requeues_pending_members_and_blocks_blocked_members(store: TempStore) -> None:
    """requeues pending members and blocks blocked members"""
    sdk = _sdk_for(create_inference_callbacks_double())
    file_path = await _new_thread(store)
    await _send_prompt_turn(sdk, file_path, "pending prompt", "pending answer")
    await _send_prompt_turn(sdk, file_path, "blocked prompt", "blocked answer")
    await _drain(sdk, file_path)

    _set_compression_state(file_path, "t1", {"state": "pending"})
    _reset_chunk_summary(file_path, "c1", "chunk_summary_detailed")
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_detailed-v1", "c1", "chunk_summary_detailed"
    )
    await _drain(sdk, file_path, {"maxItems": 1})

    detailed_c1 = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed_c1 is not None
    assert detailed_c1.state == "failed"
    assert "member_projection_not_ready" in (detailed_c1.reason or "")
    assert (
        next(
            (row for row in _live_queue(file_path) if row.work_item_id == "w-c1-chunk_summary_detailed-v1"),
            None,
        )
        is None
    )

    _set_compression_state(file_path, "t2", {"state": "blocked", "reason": "source damaged"})
    _reset_chunk_summary(file_path, "c2", "chunk_summary_detailed")
    _enqueue_chunk_summary_work(
        file_path, "w-c2-chunk_summary_detailed-v1", "c2", "chunk_summary_detailed"
    )
    await _drain(sdk, file_path, {"maxItems": 1})

    detailed_c2 = _form_of(file_path, "c2", "chunk_summary_detailed")
    assert detailed_c2 is not None
    assert detailed_c2.state == "blocked"
    assert "source_damaged" in (detailed_c2.reason or "")


async def test_brief_consumes_the_detailed_summary_when_detailed_uses_a_failed_member_floor(
    store: TempStore,
) -> None:
    """brief consumes the detailed summary when detailed uses a failed-member floor"""
    sdk = _sdk_for(create_inference_callbacks_double())
    file_path = await _new_thread(store)
    await _send_prompt_turn(sdk, file_path, "brief floor prompt", "brief floor answer")
    await _drain(sdk, file_path)

    _set_compression_state(file_path, "t1", {"state": "failed", "reason": "scripted compression failure"})
    _reset_chunk_summary(file_path, "c1", "chunk_summary_detailed")
    _reset_chunk_summary(file_path, "c1", "chunk_summary_brief")
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_detailed-v1", "c1", "chunk_summary_detailed"
    )
    _enqueue_chunk_summary_work(
        file_path, "w-c1-chunk_summary_brief-v1", "c1", "chunk_summary_brief"
    )

    await _drain(sdk, file_path, {"maxItems": 2})

    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.state == "ready"
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "ready"
    assert brief.metadata is not None
    assert brief.metadata.size_disposition is not None
    assert (
        next(
            (row for row in _live_queue(file_path) if row.work_item_id == "w-c1-chunk_summary_brief-v1"),
            None,
        )
        is None
    )


async def test_produces_byte_identical_detailed_output_for_identical_input(store: TempStore) -> None:
    """produces byte-identical detailed output for identical input"""

    async def build() -> str:
        double = create_inference_callbacks_double()
        projected_tokens = estimate_tokens(_FIXED_PROJECTION)
        sdk = _sdk_for(
            _with_scripted_projection(double),
            {
                "chunk_policy": ChunkPolicyConfig(
                    target_projected_tokens=3 * projected_tokens, max_projected_tokens=999999
                )
            },
        )
        file_path = await _new_thread(store)
        await _send_prompt_turn(sdk, file_path, "same first prompt", "same first answer")
        await _send_prompt_turn(sdk, file_path, "same second prompt", "same second answer")
        await _send_prompt_turn(sdk, file_path, "same closing prompt", "same closing answer")
        await _drain(sdk, file_path)
        form = _form_of(file_path, "c1", "chunk_summary_detailed")
        return form.content if form is not None and form.content is not None else ""

    assert await build() == await build()
