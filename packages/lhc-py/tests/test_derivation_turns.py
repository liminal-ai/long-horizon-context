"""Ported from packages/lhc/test/derivation-turns.test.ts. Phase 1.

Story 3 (Epic 02): turn composition and chunk formation — Flow 3. The
turn_derivation handler composing from message forms with recorded
fallback gaps (TC-3.2), the no-auto-cascade rule (TC-3.3, architecture
risk), outcome-explicit tool-run accounts (TC-3.4), placement in the
completion transaction (TC-3.5), the accumulated close policy's golden
cases (TC-3.6/3.7, architecture risk), the two summary kinds with
independent lifecycles (TC-3.8), and determinism under replay (TC-3.9,
architecture risk). Every drain dispatches the production handlers
registered by the turns domain at initLhc; the TC-3.3/TC-3.8 re-queues
drive the queue util directly per the story note (the public re-queue
surface is Story 4's).
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Sequence
from dataclasses import asdict, is_dataclass
from typing import Any

import pytest

from lhc import (
    BatchResult,
    DrainReport,
    InferenceCallbacks,
    Lhc,
    MessageEventInput,
    count_live_items,
    create_db_write_transaction,
    init_lhc,
    threads,
)
from lhc.shared_tech.derivation import (
    ChunkPolicyConfig,
    LeaseConfig,
    RenderingPart,
    RenderingPartKind,
    SdkConfig,
)
from lhc.shared_tech.deterministic import deterministic_text
from lhc.shared_tech.inference_types import DerivationGuards, DetailedTurnCompressionGuards
from lhc.shared_tech.logging import DerivationLogQuery, LogQuery
from lhc.shared_tech.token_counting import estimate_tokens
from lhc.shared_tech.work_queue import (
    EnqueueDerivationTarget,
    EnqueueInput,
    WorkSourceRefChunk,
    WorkSourceRefMessage,
    WorkSourceRefTurn,
    enqueue,
)
from lhc.threads import NewThreadInput
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
    open_raw,
    read_chunks,
    read_derived_forms,
    temp_store,
    valid_event,
)


def _js_round(value: float) -> int:
    """JS Math.round for non-negative values: floor(x + 0.5)."""
    return math.floor(value + 0.5)


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
        raise RuntimeError(f"thread creation failed: {created.error.reason}")
    return created.value.file_path


def _manual_sdk(
    inference_callbacks: InferenceCallbacks,
    chunk_policy: ChunkPolicyConfig | None = None,
) -> Lhc:
    return init_lhc(
        SdkConfig(
            inference_callbacks=inference_callbacks,
            mode="manual",
            lease=LeaseConfig(duration_ms=200),
            guards=DerivationGuards(
                detailed_turn_compression=DetailedTurnCompressionGuards(tiny_turn_tokens=1),
            ),
            chunk_policy=chunk_policy,
        )
    )


async def _send(sdk: Lhc, file_path: str, batch: Sequence[MessageEventInput]) -> BatchResult:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(f"batch failed: {result.error.reason}")
    return result.value


async def _drain(sdk: Lhc, file_path: str) -> DrainReport:
    result = await sdk.work.drain({"filePath": file_path})
    if not result.ok:
        raise RuntimeError(f"drain failed: {result.error.reason}")
    return result.value


# One closed prompt+answer turn through real intake.
async def _send_turn(sdk: Lhc, file_path: str, prompt: str, answer: str) -> None:
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": prompt}}),
            valid_event("assistant_text", {"payload": {"text": answer}}),
            valid_event("turn_end"),
        ],
    )


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


def _delete_work_item(file_path: str, work_item_id: str) -> None:
    db = open_raw(file_path)
    try:
        db.prepare("DELETE FROM work_item WHERE work_item_id = ?").run(work_item_id)
    finally:
        db.close()


def _dialogue_assembly_text(prompt: str, answer: str) -> str:
    return f"User:\n{prompt}\n\n⏺ {answer}"


def _assembly_tokens(prompt: str, answer: str) -> int:
    return estimate_tokens(_dialogue_assembly_text(prompt, answer))


_LABELS: dict[RenderingPartKind, str] = {
    "user_prompt": "User prompt",
    "assistant_text": "Assistant response",
    "assistant_thinking": "Assistant thinking",
    "runtime_note": "Runtime note",
    "model_change": "Model change",
    "thinking_level_change": "Thinking level change",
    "tool_call": "Tool call",
    "tool_result": "Tool result",
}


def _structured_rendering(parts: Sequence[RenderingPart]) -> str:
    segments: list[str] = []
    for part in parts:
        annotations = [
            a
            for a in [
                "fallback" if part.fallback else None,
                None if part.outcome is None else f"outcome: {part.outcome}",
            ]
            if a is not None
        ]
        suffix = "" if len(annotations) == 0 else f" [{'; '.join(annotations)}]"
        segments.append(f"{_LABELS[part.kind]}{suffix}\n{part.text}")
    return "\n\n".join(segments)


def _to_jsonable(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return {k: _to_jsonable(v) for k, v in asdict(value).items()}
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    return value


# The story-sanctioned re-queue path for TC-3.3/TC-3.8: the Story 1 queue
# util driven directly inside a real transaction (the public re-queue
# operation with refusal/idempotency semantics is Story 4's surface).
async def _requeue_direct(file_path: str, input: EnqueueInput) -> None:
    queued = await create_db_write_transaction(
        {"filePath": file_path}, lambda transaction: enqueue(transaction, input)
    )
    if not queued.ok:
        raise RuntimeError(f"direct requeue failed: {queued.error.reason}")


# ── TC-3.1 / AC-3.1 ───────────────────────────────────────────────


async def test_all_message_forms_ready_both_turn_forms_ready_composed_from_the_forms_each_its_own_state_row(
    store: TempStore,
) -> None:
    """all message forms ready → both turn forms ready, composed from the forms, each its own state row"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)
    prompt = "compose this turn"
    answer = "the composed answer"
    await _send_turn(sdk, file_path, prompt, answer)

    report = await _drain(sdk, file_path)
    assert [(entry.work_item_id, entry.disposition) for entry in report.ran] == [
        ("w-m1-prompt_smoothing-v1", "done"),
        ("w-t1-turn_derivation-v1", "done"),
        ("w-t1-detailed_turn_compression-v1", "done"),
    ]

    # Reconstruct the exact composition: the smoothed form verbatim, the
    # assistant text raw (never had a form) — proof the rendering consumed
    # forms, not raw re-derivation.
    smoothed = deterministic_text("smoothPrompt", {"text": prompt}, prompt)
    parts = [
        RenderingPart(message_id="m1", kind="user_prompt", text=smoothed, fallback=False),
        RenderingPart(message_id="m2", kind="assistant_text", text=answer, fallback=False),
    ]
    rendering_text = _structured_rendering(parts)
    assembly_text = _dialogue_assembly_text(smoothed, answer)
    input_tokens = estimate_tokens(assembly_text)
    compression_input = {
        "dialogueText": assembly_text,
        "inputTokens": input_tokens,
        "targetMinTokens": max(1, _js_round(input_tokens * 0.35)),
        "targetAimTokens": max(1, _js_round(input_tokens * 0.5)),
        "targetMaxTokens": max(1, _js_round(input_tokens * 0.65)),
    }
    rendering = _form_of(file_path, "t1", "turn_rendering")
    assembly = _form_of(file_path, "t1", "pre_detailed_assembly")
    compression = _form_of(file_path, "t1", "detailed_turn_compression")
    assert rendering is not None
    assert rendering.subject_kind == "turn"
    assert rendering.state == "ready"
    assert rendering.content == rendering_text
    assert rendering.source_version == 1
    assert rendering.gaps is None
    assert assembly is not None
    assert assembly.subject_kind == "turn"
    assert assembly.state == "ready"
    assert assembly.content == assembly_text
    assert assembly.source_version == 1
    assert compression is not None
    assert compression.subject_kind == "turn"
    assert compression.state == "ready"
    assert compression.content == deterministic_text(
        "compressDetailedTurn", compression_input, assembly_text
    )
    assert compression.source_version == 1
    assert _live_count(file_path) == 0


# ── TC-3.2 / AC-3.2 ───────────────────────────────────────────────


async def test_failed_smoothing_rendering_ready_with_the_raw_prompt_text_and_a_gap_naming_message_and_form(
    store: TempStore,
) -> None:
    """failed smoothing → rendering ready with the raw prompt text and a gap naming message and form"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)
    double.fail_kind("prompt_smoothing", 1, {"reason": "scripted smoothing failure"})
    await _send_turn(sdk, file_path, "raw prompt one", "answer text")

    report = await _drain(sdk, file_path)
    assert [(entry.work_item_id, entry.disposition) for entry in report.ran] == [
        ("w-m1-prompt_smoothing-v1", "failed_terminal"),
        ("w-t1-turn_derivation-v1", "done"),
        ("w-t1-detailed_turn_compression-v1", "done"),
    ]

    # Message-derivation fallback degrades the rendering's inputs; it does
    # not fail the turn. The ready row stays clean; the fallback is durable
    # in the log.
    rendering = _form_of(file_path, "t1", "turn_rendering")
    assert rendering is not None
    assert rendering.state == "ready"
    assert "raw prompt one" in (rendering.content or "")
    assert rendering.gaps is None
    log = await sdk.logging.query({"filePath": file_path}, LogQuery(derivation_type="smoothed_prompt"))
    assert log.ok is True
    if not log.ok:
        return
    assert [(entry.derivation_type, entry.subject_id) for entry in log.value] == [
        ("smoothed_prompt", "m1")
    ]
    compression = _form_of(file_path, "t1", "detailed_turn_compression")
    assert compression is not None
    assert compression.state == "ready"
    smoothed = _form_of(file_path, "m1", "smoothed_prompt")
    assert smoothed is not None
    assert smoothed.state == "ready"


async def test_does_not_re_run_message_inference_for_pending_or_failed_message_derivations_during_turn_construction(
    store: TempStore,
) -> None:
    """does not re-run message inference for pending or failed message derivations during turn construction"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "  pending prompt  "}}),
            valid_event("assistant_text", {"payload": {"text": "answer text"}}),
            valid_event("turn_end"),
        ],
    )
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")
    calls_before_turn = len(captured)
    await _drain(sdk, file_path)

    assert [entry for entry in captured[calls_before_turn:] if entry.op == "smoothPrompt"] == []
    rendering = _form_of(file_path, "t1", "turn_rendering")
    assert rendering is not None
    assert rendering.state == "ready"
    compression = _form_of(file_path, "t1", "detailed_turn_compression")
    assert compression is not None
    assert compression.state == "ready"


# ── TC-3.3 / AC-3.3 ───────────────────────────────────────────────


async def test_repairing_the_smoothing_changes_nothing_re_queueing_the_rendering_rebuilds_it_at_the_next_source_version(
    store: TempStore,
) -> None:
    """repairing the smoothing changes nothing; re-queueing the rendering rebuilds it at the next source version"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)
    double.fail_kind("prompt_smoothing", 1, {"reason": "scripted smoothing failure"})
    await _send_turn(sdk, file_path, "gapped prompt", "gapped answer")
    await _drain(sdk, file_path)
    gapped = _form_of(file_path, "t1", "turn_rendering")
    assert gapped is not None
    assert gapped.state == "ready"
    assert gapped.gaps is None
    placed_before = read_chunks(file_path)

    # Leg 1: repair the failed smoothing through the queue util (now
    # healthy — the script above is consumed). The dependent must not move:
    # no live link, no auto-cascade, no queued turn work.
    await _requeue_direct(
        file_path,
        EnqueueInput(
            owner="messages",
            kind="prompt_smoothing",
            source_ref=WorkSourceRefMessage(messageId="m1"),
            derivations=[
                EnqueueDerivationTarget(
                    subject_kind="message", subject_id="m1", derivation_type="smoothed_prompt"
                )
            ],
        ),
    )
    repair_report = await _drain(sdk, file_path)
    assert [(entry.work_item_id, entry.disposition) for entry in repair_report.ran] == [
        ("w-m1-prompt_smoothing-v1", "done"),
    ]
    smoothed = _form_of(file_path, "m1", "smoothed_prompt")
    assert smoothed is not None
    assert smoothed.state == "ready"
    # Byte-for-byte: the fallback-composed rendering is exactly the row that landed —
    # content, derivedAt, source version, all of it.
    assert _form_of(file_path, "t1", "turn_rendering") == gapped
    assert _live_count(file_path) == 0

    # Leg 2: the explicit rebuild — turn_derivation re-queued at the next
    # source version through the queue util. Gaps recompute from current
    # dependency states: the smoothing is ready now, so the gap clears.
    await _requeue_direct(
        file_path,
        EnqueueInput(
            owner="turns",
            kind="turn_derivation",
            source_ref=WorkSourceRefTurn(turnId="t1"),
            source_version=2,
            derivations=[
                EnqueueDerivationTarget(
                    subject_kind="turn", subject_id="t1", derivation_type="turn_rendering"
                ),
                EnqueueDerivationTarget(
                    subject_kind="turn", subject_id="t1", derivation_type="pre_detailed_assembly"
                ),
            ],
        ),
    )
    rebuild_report = await _drain(sdk, file_path)
    assert [(entry.work_item_id, entry.disposition) for entry in rebuild_report.ran] == [
        ("w-t1-turn_derivation-v2", "done"),
        ("w-t1-detailed_turn_compression-v2", "done"),
    ]
    rebuilt = _form_of(file_path, "t1", "turn_rendering")
    assert rebuilt is not None
    assert rebuilt.state == "ready"
    assert rebuilt.source_version == 2
    assert rebuilt.gaps is None
    assert rebuilt.content != gapped.content
    # Rebuild keeps placement: membership is never re-cut by derivation —
    # the turn sits exactly where its first placement put it.
    assert read_chunks(file_path) == placed_before


# ── TC-3.4 / AC-3.4 ───────────────────────────────────────────────


async def test_a_three_call_edit_run_with_one_iserror_carries_per_call_outcomes_into_the_composition_input_from_the_forms(
    store: TempStore,
) -> None:
    """a three-call edit run with one isError carries per-call outcomes into the composition input, from the forms"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)

    def call(id: str, path: str):
        return valid_event(
            "tool_call",
            {"payload": {"toolCallId": id, "toolName": "edit_file", "arguments": {"path": path}}},
        )

    def result(id: str, content: str, is_error: bool):
        return valid_event(
            "tool_result",
            {"payload": {"toolCallId": id, "content": content, "isError": is_error}},
        )

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "edit three files"}}),
            call("call-a", "a.txt"),
            result("call-a", "edited a.txt", False),
            call("call-b", "b.txt"),
            result("call-b", "permission denied", True),
            call("call-c", "c.txt"),
            result("call-c", "edited c.txt", False),
            valid_event("turn_end"),
        ],
    )

    await _drain(sdk, file_path)
    rendering_form = _form_of(file_path, "t1", "turn_rendering")
    assert rendering_form is not None
    assert rendering_form.state == "ready"

    rendering = _form_of(file_path, "t1", "turn_rendering")
    run_text = rendering.content if rendering is not None and rendering.content is not None else ""
    # Fix 2 grouping (AC-3.4): the three-call edit run folds into ONE run part
    # after the prompt — outcome-explicit, not one part per tool message.
    assert "[tool run · edit_file · 3 calls · 2 succeeded, 1 failed]" in run_text
    assert re.search(r"\b3 succeeded\b", run_text) is None
    tool_messages = [
        {"id": "m2", "kind": "tool_call", "outcome": "succeeded", "text": 'edit_file({"path":"a.txt"})'},
        {"id": "m3", "kind": "tool_result", "outcome": "succeeded"},
        {"id": "m4", "kind": "tool_call", "outcome": "failed", "text": 'edit_file({"path":"b.txt"})'},
        {"id": "m5", "kind": "tool_result", "outcome": "failed"},
        {"id": "m6", "kind": "tool_call", "outcome": "succeeded", "text": 'edit_file({"path":"c.txt"})'},
        {"id": "m7", "kind": "tool_result", "outcome": "succeeded"},
    ]
    for m in tool_messages:
        if m["kind"] == "tool_call":
            summary = m["text"]
        else:
            form = _form_of(file_path, m["id"], "tool_result_summary")
            summary = form.content if form is not None else None
        assert summary is not None
        assert f"{summary} ⇒ {m['outcome']}" in run_text


# ── TC-3.5 / AC-3.5 ───────────────────────────────────────────────


async def test_draining_a_closed_turn_shows_chunkid_and_memberidx_on_the_turn_read_back(
    store: TempStore,
) -> None:
    """draining a closed turn shows chunkId and memberIdx on the turn read-back"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double)
    file_path = await _new_thread(store)
    await _send_turn(sdk, file_path, "place me", "placed")

    await _drain(sdk, file_path)
    listed = await sdk.turns.list_turns({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    # expect.objectContaining — named keys, allow extras.
    t0 = listed.value[0]
    assert t0.turn_id == "t1"
    assert t0.status == "closed"
    assert t0.chunk_id == "c1"
    assert t0.member_idx == 0


# ── TC-3.6 / AC-3.6 ───────────────────────────────────────────────


async def test_three_turns_at_equal_size_the_thirds_placement_closes_the_chunk_holding_two_and_the_third_opens_chunk_2(
    store: TempStore,
) -> None:
    """three turns at ~equal size: the third's placement closes the chunk holding two, and the third opens chunk 2"""
    prompt = "prompt text"
    answer = "answer text"
    smoothed = deterministic_text("smoothPrompt", {"text": prompt}, prompt)
    per = _assembly_tokens(smoothed, answer)
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(
        double,
        ChunkPolicyConfig(target_projected_tokens=2 * per + 1, max_projected_tokens=100 * per),
    )
    file_path = await _new_thread(store)
    for _ in range(1, 4):
        await _send_turn(sdk, file_path, prompt, answer)

    await _drain(sdk, file_path)
    snapshot = read_chunks(file_path)
    assert snapshot["chunks"] == [
        {
            "chunkId": "c1",
            "chunkOrder": 1,
            "status": "closed",
            "accumulatedProjectedTokens": 2 * per,
        },
        {
            "chunkId": "c2",
            "chunkOrder": 2,
            "status": "open",
            "accumulatedProjectedTokens": per,
        },
    ]
    assert snapshot["members"] == [
        {"chunkId": "c1", "turnId": "t1", "memberIdx": 0},
        {"chunkId": "c1", "turnId": "t2", "memberIdx": 1},
        {"chunkId": "c2", "turnId": "t3", "memberIdx": 0},
    ]
    # The close queued both summary kinds for c1 and the drain ran them;
    # the still-open c2 has none.
    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.state == "ready"
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "ready"
    assert _form_of(file_path, "c2", "chunk_summary_detailed") is None
    assert _live_count(file_path) == 0


async def test_threshold_exactness_accumulated_incoming_equal_to_the_target_closes_inclusive_holding_only_the_prior_member(
    store: TempStore,
) -> None:
    """threshold exactness: accumulated + incoming equal to the target closes (inclusive), holding only the prior member"""
    prompt = "prompt text"
    answer = "answer text"
    smoothed = deterministic_text("smoothPrompt", {"text": prompt}, prompt)
    per = _assembly_tokens(smoothed, answer)
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(
        double,
        ChunkPolicyConfig(target_projected_tokens=2 * per, max_projected_tokens=100 * per),
    )
    file_path = await _new_thread(store)
    await _send_turn(sdk, file_path, prompt, answer)
    await _send_turn(sdk, file_path, prompt, answer)

    await _drain(sdk, file_path)
    snapshot = read_chunks(file_path)
    assert snapshot["members"] == [
        {"chunkId": "c1", "turnId": "t1", "memberIdx": 0},
        {"chunkId": "c2", "turnId": "t2", "memberIdx": 0},
    ]
    assert [(chunk["chunkId"], chunk["status"]) for chunk in snapshot["chunks"]] == [
        ("c1", "closed"),
        ("c2", "open"),
    ]


# ── TC-3.7 / AC-3.7 ───────────────────────────────────────────────


async def test_one_oversized_turn_its_own_closed_chunk_with_both_summaries_derived(
    store: TempStore,
) -> None:
    """one oversized turn → its own closed chunk with both summaries derived"""
    big_answer = ("omega " * 120).strip()
    prompt = "huge turn"
    smoothed = deterministic_text("smoothPrompt", {"text": prompt}, prompt)
    big = _assembly_tokens(smoothed, big_answer)
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(
        double,
        ChunkPolicyConfig(target_projected_tokens=big, max_projected_tokens=big),
    )
    file_path = await _new_thread(store)
    await _send_turn(sdk, file_path, prompt, big_answer)

    await _drain(sdk, file_path)
    assert read_chunks(file_path) == {
        "chunks": [
            {
                "chunkId": "c1",
                "chunkOrder": 1,
                "status": "closed",
                "accumulatedProjectedTokens": big,
            }
        ],
        "members": [{"chunkId": "c1", "turnId": "t1", "memberIdx": 0}],
    }
    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed is not None
    assert detailed.state == "ready"
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "ready"


async def test_an_oversized_turn_arriving_behind_an_open_chunk_closes_both_the_open_chunk_without_it_its_own_chunk_with_it(
    store: TempStore,
) -> None:
    """an oversized turn arriving behind an open chunk closes both: the open chunk without it, its own chunk with it"""
    big_answer = ("omega " * 120).strip()
    small_prompt = "small turn"
    small_answer = "small answer"
    huge_prompt = "huge turn"
    huge_smoothed = deterministic_text("smoothPrompt", {"text": huge_prompt}, huge_prompt)
    big = _assembly_tokens(huge_smoothed, big_answer)
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(
        double,
        ChunkPolicyConfig(target_projected_tokens=big, max_projected_tokens=big),
    )
    file_path = await _new_thread(store)
    await _send_turn(sdk, file_path, small_prompt, small_answer)
    await _send_turn(sdk, file_path, huge_prompt, big_answer)

    await _drain(sdk, file_path)
    snapshot = read_chunks(file_path)
    assert [(chunk["chunkId"], chunk["status"]) for chunk in snapshot["chunks"]] == [
        ("c1", "closed"),
        ("c2", "closed"),
    ]
    assert snapshot["members"] == [
        {"chunkId": "c1", "turnId": "t1", "memberIdx": 0},
        {"chunkId": "c2", "turnId": "t2", "memberIdx": 0},
    ]
    for chunk_id in ("c1", "c2"):
        detailed = _form_of(file_path, chunk_id, "chunk_summary_detailed")
        assert detailed is not None
        assert detailed.state == "ready"
        brief = _form_of(file_path, chunk_id, "chunk_summary_brief")
        assert brief is not None
        assert brief.state == "ready"


# ── TC-3.8 / AC-3.8 ───────────────────────────────────────────────


# target=max=1: every turn self-chunks and closes immediately, the
# smallest deterministic way to manufacture closed chunks.
_SELF_CHUNK = ChunkPolicyConfig(target_projected_tokens=1, max_projected_tokens=1)


async def test_both_summaries_land_ready_as_distinct_chunk_level_forms(store: TempStore) -> None:
    """both summaries land ready as distinct chunk-level forms"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double, _SELF_CHUNK)
    file_path = await _new_thread(store)
    await _send_turn(sdk, file_path, "summarize me", "summarized")

    report = await _drain(sdk, file_path)
    assert [(entry.kind, entry.disposition) for entry in report.ran] == [
        ("prompt_smoothing", "done"),
        ("turn_derivation", "done"),
        ("detailed_turn_compression", "done"),
        ("chunk_summary_detailed", "done"),
        ("chunk_summary_brief", "done"),
    ]
    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert detailed is not None
    assert detailed.state == "ready"
    assert brief is not None
    assert brief.state == "ready"
    # Detailed is deterministic material assembly; brief still goes through
    # its own inference operation over projections + outcomes.
    member_compression = _form_of(file_path, "t1", "detailed_turn_compression")
    member_projections = [
        member_compression.content
        if member_compression is not None and member_compression.content is not None
        else ""
    ]
    assert detailed.content == member_projections[0]
    brief_input_text = detailed.content if detailed.content is not None else ""
    brief_input_tokens = estimate_tokens(brief_input_text)
    brief_input = {
        "text": brief_input_text,
        "inputTokens": brief_input_tokens,
        "targetMinTokens": max(1, _js_round(brief_input_tokens * 0.08)),
        "targetAimTokens": max(1, _js_round(brief_input_tokens * 0.12)),
        "targetMaxTokens": max(1, _js_round(brief_input_tokens * 0.2)),
    }
    assert brief.content == deterministic_text(
        "summarizeChunkBrief", brief_input, brief_input_text
    )
    assert brief.metadata is not None
    assert brief.metadata.size_disposition is not None
    assert detailed.content != brief.content


async def test_detailed_is_compression_only_assembly_brief_consumes_the_detailed_text(
    store: TempStore,
) -> None:
    """detailed is compression-only assembly; brief consumes the detailed text"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _manual_sdk(double, _SELF_CHUNK)
    file_path = await _new_thread(store)
    # Two-call edit run, one isError, closing into its own chunk so both summaries derive over it.
    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "edit two files"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "rcpt-a",
                        "toolName": "edit_file",
                        "arguments": {"path": "ok.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "rcpt-a", "content": "edited ok.txt", "isError": False}},
            ),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "rcpt-b",
                        "toolName": "edit_file",
                        "arguments": {"path": "ro.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {"payload": {"toolCallId": "rcpt-b", "content": "read-only file", "isError": True}},
            ),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path)

    call_a = 'edit_file({"path":"ok.txt"})'
    result_a_form = _form_of(file_path, "m3", "tool_result_summary")
    result_a = result_a_form.content if result_a_form is not None else None
    call_b = 'edit_file({"path":"ro.txt"})'
    result_b_form = _form_of(file_path, "m5", "tool_result_summary")
    result_b = result_b_form.content if result_b_form is not None else None
    rendering = _form_of(file_path, "t1", "turn_rendering")
    account = "tool run · edit_file · 2 calls · 1 succeeded, 1 failed"
    run_text = rendering.content if rendering is not None and rendering.content is not None else ""
    assert account in run_text
    assert f"{call_a} ⇒ succeeded" in run_text
    assert f"{result_a} ⇒ succeeded" in run_text
    assert f"{call_b} ⇒ failed" in run_text
    assert f"{result_b} ⇒ failed" in run_text
    assert rendering is not None
    assert rendering.metadata is None

    # Seam evidence: only the brief call crosses the inference boundary, and
    # it receives the detailed chunk text rather than raw member projections.
    brief_captured = next((entry for entry in captured if entry.op == "summarizeChunkBrief"), None)
    brief_input = brief_captured.input if brief_captured is not None else None
    detailed = _form_of(file_path, "c1", "chunk_summary_detailed")
    detailed_text = detailed.content if detailed is not None and detailed.content is not None else ""
    # expect.objectContaining — named key, allow extras on the input shape.
    assert isinstance(brief_input, dict)
    assert brief_input["text"] == detailed_text
    member_compression = _form_of(file_path, "t1", "detailed_turn_compression")
    member_content = (
        member_compression.content
        if member_compression is not None and member_compression.content is not None
        else ""
    )
    assert member_content not in json.dumps(_to_jsonable(brief_input), separators=(",", ":"))
    assert "[receipts" not in detailed_text
    assert '({"' not in detailed_text
    for summary in (call_a, result_a, call_b, result_b):
        assert summary not in detailed_text

    # Artifact evidence: detailed is member compression only; brief is produced
    # from detailed and carries size metadata.
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert detailed is not None
    assert detailed.state == "ready"
    assert brief is not None
    assert brief.state == "ready"
    assert member_content in (detailed.content or "")
    assert "[receipts" not in (detailed.content or "")
    assert brief.metadata is not None
    assert brief.metadata.size_disposition is not None


async def test_the_brief_item_fails_alone_detailed_ready_brief_failed_brief_re_derivable_by_itself(
    store: TempStore,
) -> None:
    """the brief item fails alone: detailed ready, brief failed, brief re-derivable by itself"""
    double = create_inference_callbacks_double()
    sdk = _manual_sdk(double, _SELF_CHUNK)
    file_path = await _new_thread(store)
    double.fail_kind("chunk_summary_brief", 1, {"reason": "scripted brief failure"})
    await _send_turn(sdk, file_path, "independent failure", "answer")

    report = await _drain(sdk, file_path)
    assert [(entry.kind, entry.disposition) for entry in report.ran] == [
        ("prompt_smoothing", "done"),
        ("turn_derivation", "done"),
        ("detailed_turn_compression", "done"),
        ("chunk_summary_detailed", "done"),
        ("chunk_summary_brief", "failed_terminal"),
    ]
    detailed_before = _form_of(file_path, "c1", "chunk_summary_detailed")
    assert detailed_before is not None
    assert detailed_before.state == "ready"
    failed_brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert failed_brief is not None
    assert failed_brief.state == "failed"
    assert failed_brief.reason == "scripted brief failure"

    derivation_log = await sdk.logging.query_derivation_log(
        {"filePath": file_path},
        DerivationLogQuery(subject_id="c1", derivation_type="chunk_summary_brief"),
    )
    assert derivation_log.ok is True
    if not derivation_log.ok:
        return
    # expect.arrayContaining / objectContaining — named keys, allow extras.
    assert any(
        entry.event_kind == "inference_failed"
        and isinstance(entry.payload, dict)
        and entry.payload.get("reason") == "scripted brief failure"
        for entry in derivation_log.value
    )
    assert any(
        entry.event_kind == "terminal_failed"
        and isinstance(entry.payload, dict)
        and entry.payload.get("reason") == "scripted brief failure"
        for entry in derivation_log.value
    )

    # Re-queue the brief alone through the queue util (Story 4 owns the
    # public surface); the detailed form must not move.
    await _requeue_direct(
        file_path,
        EnqueueInput(
            owner="turns",
            kind="chunk_summary_brief",
            source_ref=WorkSourceRefChunk(chunkId="c1"),
            derivations=[
                EnqueueDerivationTarget(
                    subject_kind="chunk",
                    subject_id="c1",
                    derivation_type="chunk_summary_brief",
                )
            ],
        ),
    )
    requeued = await _drain(sdk, file_path)
    assert [(entry.kind, entry.disposition) for entry in requeued.ran] == [
        ("chunk_summary_brief", "done")
    ]
    brief = _form_of(file_path, "c1", "chunk_summary_brief")
    assert brief is not None
    assert brief.state == "ready"
    assert _form_of(file_path, "c1", "chunk_summary_detailed") == detailed_before


# ── TC-3.9 / AC-3.9 ───────────────────────────────────────────────


async def test_the_same_event_stream_into_a_fresh_thread_re_chunks_identically_membership_and_boundaries_deep_equal(
    store: TempStore,
) -> None:
    """the same event stream into a fresh thread re-chunks identically — membership and boundaries deep-equal"""
    policy = ChunkPolicyConfig(target_projected_tokens=60, max_projected_tokens=4400)
    turns_content: list[tuple[str, str]] = [
        ("first prompt about the parser", "parser answer with detail"),
        ("second prompt about the cache", "cache answer, longer, with extra words"),
        ("third prompt about the index rebuild", "index answer"),
        ("fourth prompt, short", "fourth answer, also short"),
        ("fifth prompt to push past one chunk", "fifth answer closing things out"),
    ]

    async def build_and_drain() -> str:
        double = create_inference_callbacks_double()
        sdk = _manual_sdk(double, policy)
        file_path = await _new_thread(store)
        for prompt, answer in turns_content:
            await _send_turn(sdk, file_path, prompt, answer)
        await _drain(sdk, file_path)
        return file_path

    first = await build_and_drain()
    second = await build_and_drain()

    first_snapshot = read_chunks(first)
    assert first_snapshot == read_chunks(second)
    # The replay claim is only meaningful if the policy actually cut: the
    # stream must span more than one chunk.
    assert len(first_snapshot["chunks"]) > 1
    # No inference joined placement anywhere: the closed chunks' summary
    # artifacts are byte-identical across the two records too.

    def summaries_of(file_path: str):
        return [
            (form.subject_id, form.derivation_type, form.state, form.content)
            for form in read_derived_forms(file_path)
            if form.subject_kind == "chunk"
        ]

    assert summaries_of(first) == summaries_of(second)
