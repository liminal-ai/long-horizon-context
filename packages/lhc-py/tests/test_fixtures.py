"""Ported from packages/lhc/test/fixtures.test.ts. Phase 1.

FC-0.4: fixture builders; FC-0.1/FC-0.2: inference callbacks double;
FC-0.1 production seam; FC-0.3/FC-0.6: thread builders.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from lhc import (
    Derivation,
    EventKind,
    InferenceCallbacks,
    InferenceResult,
    init_lhc,
    intake_stream,
    messages,
    turns,
)
from lhc.shared_tech.derivation import DerivationMetadata, InferenceErr, SdkConfig
from fixtures.inference_callbacks_double import CapturedInput
from fixtures import (
    TempStore,
    conversation_turn,
    create_inference_callbacks_double,
    damaged_source_thread,
    event_batch,
    multi_state_thread,
    open_raw,
    read_derived_forms,
    temp_store,
    thread_with_closed_turns,
    thread_with_tool_run,
    valid_event,
)

ALL_KINDS: tuple[EventKind, ...] = (
    "user_prompt",
    "assistant_text",
    "assistant_thinking",
    "runtime_note",
    "model_change",
    "thinking_level_change",
    "tool_call",
    "tool_result",
    "turn_end",
)

GOLDEN_PAYLOAD_KEYS: dict[EventKind, list[str]] = {
    "user_prompt": ["text"],
    "assistant_text": ["text"],
    "assistant_thinking": ["text"],
    "runtime_note": ["text"],
    "model_change": ["previousModel", "newModel"],
    "thinking_level_change": ["previousLevel", "newLevel"],
    "tool_call": ["toolCallId", "toolName", "arguments"],
    "tool_result": ["toolCallId", "content", "isError"],
    "turn_end": [],
}


def test_valid_event_produces_a_golden_shaped_event_for_every_kind() -> None:
    """validEvent produces a golden-shaped event for every kind"""
    for kind in ALL_KINDS:
        event = valid_event(kind)
        assert event["eventKind"] == kind
        assert len(event["idempotencyKey"]) > 0
        assert len(event["actor"]) > 0
        assert len(event["harness"]) > 0
        assert sorted(event["payload"].keys()) == sorted(GOLDEN_PAYLOAD_KEYS[kind])
        assert sorted(event.keys()) == sorted(
            ["actor", "eventKind", "harness", "idempotencyKey", "payload"]
        )


def test_valid_event_applies_overrides_without_changing_the_kind() -> None:
    """validEvent applies overrides without changing the kind"""
    event = valid_event(
        "user_prompt",
        {"actor": "custom-actor", "payload": {"text": "custom prompt"}},
    )
    assert event["eventKind"] == "user_prompt"
    assert event["actor"] == "custom-actor"
    assert event["payload"]["text"] == "custom prompt"


def test_building_an_invalid_kind_payload_pairing_requires_an_explicit_cast() -> None:
    """building an invalid kind/payload pairing requires an explicit cast"""
    forced = valid_event(
        "user_prompt",
        {"payload": {"toolCallId": "x", "toolName": "y", "arguments": {}}},
    )
    assert forced["eventKind"] == "user_prompt"


def test_event_batch_yields_unique_idempotency_keys_in_order() -> None:
    """eventBatch yields unique idempotency keys in order"""
    batch = event_batch(ALL_KINDS)
    assert [e["eventKind"] for e in batch] == list(ALL_KINDS)
    keys = {e["idempotencyKey"] for e in batch}
    assert len(keys) == len(batch)


def test_conversation_turn_is_one_complete_turn() -> None:
    """conversationTurn is one complete turn"""
    assert [e["eventKind"] for e in conversation_turn()] == [
        "user_prompt",
        "assistant_text",
        "tool_call",
        "tool_result",
        "turn_end",
    ]


def test_temp_store_creates_an_isolated_directory_and_cleans_it_up() -> None:
    """tempStore creates an isolated directory and cleans it up"""
    store = temp_store()
    assert Path(store.dir).exists()
    assert store.registry_path.startswith(store.dir)
    a = store.thread_path()
    b = store.thread_path()
    assert a != b
    store.cleanup()
    assert not Path(store.dir).exists()


def test_open_raw_opens_a_real_sqlite_handle_for_below_sdk_assertions() -> None:
    """openRaw opens a real sqlite handle for below-SDK assertions"""
    store = temp_store()
    path = store.thread_path("raw")
    writer = open_raw(path)
    writer.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT)")
    writer.exec("INSERT INTO probe (note) VALUES ('hello')")
    writer.close()
    reader = open_raw(path)
    row = reader.prepare("SELECT note FROM probe WHERE id = 1").get()
    assert row is not None
    assert row["note"] == "hello"
    reader.close()
    store.cleanup()


def _call_all_operations(double: InferenceCallbacks) -> list:
    return [
        double.smooth_prompt({"text": "please smooth this prompt text"}),
        double.summarize_tool_result({"toolName": "read_file", "content": "tool result content"}),
        double.compress_detailed_turn(
            {
                "dialogueText": "the rendering text",
                "inputTokens": 10,
                "targetMinTokens": 4,
                "targetAimTokens": 5,
                "targetMaxTokens": 7,
            }
        ),
        double.summarize_chunk_brief(
            {
                "text": "detailed projection text",
                "inputTokens": 10,
                "targetMinTokens": 1,
                "targetAimTokens": 2,
                "targetMaxTokens": 3,
            }
        ),
    ]


OPERATION_MARKERS = ("smoothed", "toolresult", "projection", "brief")


async def test_fc_0_1_implements_all_operations_with_marked_input_derived_output() -> None:
    """FC-0.1: implements all operations with marked, input-derived output"""
    import asyncio

    results = await asyncio.gather(*_call_all_operations(create_inference_callbacks_double()))
    for index, result in enumerate(results):
        assert result.ok is True
        if not result.ok:
            continue
        assert result.text.startswith(f"{OPERATION_MARKERS[index]}(")
    double = create_inference_callbacks_double()
    a = await double.smooth_prompt({"text": "first input"})
    b = await double.smooth_prompt({"text": "second input"})
    if not a.ok or not b.ok:
        raise RuntimeError("double failed unscripted")
    assert a.text != b.text
    assert "first input" in a.text


async def test_fc_0_2_identical_input_yields_identical_output_across_double_instances() -> None:
    """FC-0.2: identical input yields identical output across double instances; operations are distinguishable"""
    import asyncio

    first = await asyncio.gather(*_call_all_operations(create_inference_callbacks_double()))
    second = await asyncio.gather(*_call_all_operations(create_inference_callbacks_double()))
    assert first == second
    texts = [r.text if r.ok else "" for r in first]
    assert len(set(texts)) == 4
    assert [t[: t.index("(")] for t in texts] == list(OPERATION_MARKERS)


async def test_fc_0_2_fail_next_drives_fail_n_then_succeed() -> None:
    """FC-0.2: failNext drives fail-N-then-succeed"""
    double = create_inference_callbacks_double()
    double.fail_next(2)
    r1 = await double.smooth_prompt({"text": "x"})
    r2 = await double.summarize_chunk_brief(
        {
            "text": "y",
            "inputTokens": 10,
            "targetMinTokens": 1,
            "targetAimTokens": 2,
            "targetMaxTokens": 3,
        }
    )
    r3 = await double.smooth_prompt({"text": "x"})
    assert r1.ok is False
    assert r2.ok is False
    assert r3.ok is True
    fresh = await create_inference_callbacks_double().smooth_prompt({"text": "x"})
    assert r3 == fresh


async def test_fc_0_2_fail_kind_scripts_failure_per_operation() -> None:
    """FC-0.2: failKind scripts failure per operation, by kind alias, without touching other kinds"""
    double = create_inference_callbacks_double()
    double.fail_kind("prompt_smoothing", 99, {"reason": "content refusal"})
    failed = await double.smooth_prompt({"text": "x"})
    assert failed == InferenceErr(reason="content refusal")
    other = await double.summarize_tool_result({"toolName": "t", "content": "c"})
    assert other.ok is True


async def test_fc_0_2_delay_kind_injects_latency_on_the_scripted_operation() -> None:
    """FC-0.2: delayKind injects latency on the scripted operation"""
    import time

    double = create_inference_callbacks_double()
    double.delay_kind("chunk_summary_brief", 40)
    before = time.monotonic()
    result = await double.summarize_chunk_brief(
        {
            "text": "p",
            "inputTokens": 10,
            "targetMinTokens": 1,
            "targetAimTokens": 2,
            "targetMaxTokens": 3,
        }
    )
    elapsed = (time.monotonic() - before) * 1000
    assert result.ok is True
    assert elapsed >= 35


async def test_scripting_and_capture_state_are_per_instance() -> None:
    """scripting and capture state are per-instance — nothing leaks across doubles"""
    scripted = create_inference_callbacks_double()
    clean = create_inference_callbacks_double()
    captured_scripted = scripted.capture_inputs()
    scripted.fail_next(1)
    clean_result = await clean.smooth_prompt({"text": "untouched"})
    assert clean_result.ok is True
    assert len(captured_scripted) == 0
    captured_clean = clean.capture_inputs()
    await clean.compress_detailed_turn(
        {
            "dialogueText": "r",
            "inputTokens": 10,
            "targetMinTokens": 4,
            "targetAimTokens": 5,
            "targetMaxTokens": 7,
        }
    )
    assert captured_clean == [
        CapturedInput(
            op="compressDetailedTurn",
            input={
                "dialogueText": "r",
                "inputTokens": 10,
                "targetMinTokens": 4,
                "targetAimTokens": 5,
                "targetMaxTokens": 7,
            },
        )
    ]
    assert len(captured_scripted) == 0
    scripted_result = await scripted.smooth_prompt({"text": "untouched"})
    assert scripted_result.ok is False
    assert captured_scripted == [
        CapturedInput(op="smoothPrompt", input={"text": "untouched"})
    ]


def test_resolves_config_defaults_centrally_and_carries_injected_inference_callbacks_and_mode() -> None:
    """resolves config defaults centrally and carries the injected inference callbacks and mode"""
    double = create_inference_callbacks_double()
    sdk = init_lhc(SdkConfig(inference_callbacks=double, mode="manual"))
    assert sdk.config.inference_callbacks is double
    assert sdk.config.mode == "manual"
    assert sdk.config.lease.duration_ms == 120000
    assert sdk.config.chunk_policy.target_projected_tokens == 2200
    assert sdk.config.chunk_policy.max_projected_tokens == 4400
    assert sdk.scheduler.mode == "manual"
    # The Epic 01 surfaces ride the assembled SDK.
    assert callable(sdk.threads.new_thread)
    assert callable(sdk.intake_stream.message_events)
    assert callable(sdk.intake_stream.init_lhc)


def test_background_mode_is_a_validated_construction_option() -> None:
    """background mode is a validated construction option (behavior lands in Story 1)"""
    sdk = init_lhc(
        SdkConfig(inference_callbacks=create_inference_callbacks_double(), mode="background")
    )
    assert sdk.scheduler.mode == "background"
    sdk.scheduler.poke("th_x")


def test_rejects_malformed_config_at_construction() -> None:
    """rejects malformed config at construction: bad mode, incomplete callbacks, bad policy values"""
    double = create_inference_callbacks_double()
    with pytest.raises(TypeError, match="mode"):
        init_lhc(SdkConfig(inference_callbacks=double, mode="later"))  # type: ignore[arg-type]
    incomplete = {"smooth_prompt": double.smooth_prompt}
    with pytest.raises(TypeError, match="missing operation"):
        init_lhc(SdkConfig(inference_callbacks=incomplete, mode="manual"))  # type: ignore[arg-type]
    from lhc.shared_tech.derivation import ChunkPolicyConfig

    with pytest.raises(TypeError, match="chunkPolicy"):
        init_lhc(
            SdkConfig(
                inference_callbacks=double,
                mode="manual",
                chunk_policy=ChunkPolicyConfig(
                    target_projected_tokens=4400, max_projected_tokens=2200
                ),
            )
        )


@pytest.fixture
def builder_store() -> TempStore:
    s = temp_store()
    yield s
    s.cleanup()


async def test_thread_with_closed_turns_n_closed_turns_read_back_closed(
    builder_store: TempStore,
) -> None:
    """threadWithClosedTurns: n closed turns read back closed with their members"""
    result = await thread_with_closed_turns(builder_store, 2)
    file_path = result["filePath"]
    turn_ids = result["turnIds"]
    assert turn_ids == ["t1", "t2"]
    listed = await turns.list_turns({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    assert [(t.turn_id, t.status) for t in listed.value] == [
        ("t1", "closed"),
        ("t2", "closed"),
        ("t3", "open"),
    ]
    assert [len(t.member_message_ids) for t in listed.value] == [2, 2, 0]


async def test_thread_with_tool_run_call_result_pair_recorded(builder_store: TempStore) -> None:
    """threadWithToolRun: call+result pair recorded; error and missing-result variants hold their shapes"""
    paired = await thread_with_tool_run(builder_store)
    paired_messages = await messages.list({"filePath": paired["filePath"]})
    assert paired_messages.ok is True
    if not paired_messages.ok:
        return
    assert [m.kind for m in paired_messages.value] == ["user_prompt", "tool_call", "tool_result"]

    errored = await thread_with_tool_run(builder_store, {"isError": True})
    errored_messages = await messages.list({"filePath": errored["filePath"]})
    assert errored_messages.ok is True
    if not errored_messages.ok:
        return
    result_block = errored_messages.value[2].blocks[0]
    assert result_block.content["isError"] is True

    missing = await thread_with_tool_run(builder_store, {"missingResult": True})
    missing_messages = await messages.list({"filePath": missing["filePath"]})
    assert missing_messages.ok is True
    if not missing_messages.ok:
        return
    assert [m.kind for m in missing_messages.value] == ["user_prompt", "tool_call"]


async def test_fc_0_6_multi_state_thread_reads_back_every_claimed_state(
    builder_store: TempStore,
) -> None:
    """FC-0.6: the multi-state thread reads back every claimed state — all four in one file"""
    result = await multi_state_thread(builder_store)
    file_path = result["filePath"]
    expected = result["expected"]
    forms = read_derived_forms(file_path)
    for claim in expected:  # type: ignore[union-attr]
        match = next(
            (
                f
                for f in forms
                if f.subject_kind == claim["subjectKind"]
                and f.subject_id == claim["subjectId"]
                and f.derivation_type == claim["derivationType"]
            ),
            None,
        )
        assert match is not None
        assert match.state == claim["state"]
    states = sorted({f.state for f in forms})
    assert states == ["blocked", "failed", "pending", "ready"]
    for form in forms:
        if form.state == "ready":
            assert form.content is not None
        if form.state in ("failed", "blocked"):
            assert form.reason is not None
            assert form.content is None
        if form.state == "pending":
            assert form.content is None
            assert form.reason is None


async def test_fc_0_3_tool_activity_outcome_lives_in_machine_readable_metadata(
    builder_store: TempStore,
) -> None:
    """FC-0.3: tool-activity outcome lives in machine-readable metadata, never inside content"""
    result = await multi_state_thread(builder_store)
    file_path = result["filePath"]
    tool_form = next(
        (f for f in read_derived_forms(file_path) if f.derivation_type == "tool_result_summary"),
        None,
    )
    assert tool_form is not None
    assert tool_form.metadata == DerivationMetadata(outcome="succeeded")
    assert "succeeded" not in (tool_form.content or "")
    # The shared vocabulary is the compile-time contract both owning domains
    # consume; this read shape is that type.
    typed: Derivation | None = tool_form
    assert typed is not None
    assert typed.state == "ready"


async def test_fc_0_6_damaged_source_thread_reads_back_the_corruption_it_claims(
    builder_store: TempStore,
) -> None:
    """FC-0.6: the damaged-source thread reads back the corruption it claims (Epic 01 definition)"""
    result = await damaged_source_thread(builder_store)
    file_path = result["filePath"]
    turn_id = result["turnId"]
    assert turn_id == "t1"
    db = open_raw(file_path)
    try:
        open_count = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE status = 'open'").get()
        assert open_count is not None
        assert int(open_count["n"]) == 2  # type: ignore[index]
    finally:
        db.close()
    rejected = await intake_stream.message_events(
        {"filePath": file_path}, [valid_event("user_prompt")]
    )
    assert rejected.ok is False
    if rejected.ok:
        return
    assert rejected.error.code == "turn_state_corrupt"
    queue_db = open_raw(file_path)
    try:
        queued = queue_db.prepare(
            "SELECT kind FROM work_item WHERE owner = 'turns' ORDER BY rowid"
        ).all()
        assert [item["kind"] for item in queued] == ["turn_derivation"]
    finally:
        queue_db.close()
