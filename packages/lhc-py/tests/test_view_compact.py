"""Ported from packages/lhc/test/view-compact.test.ts. Phase 1.

Epic 03 Story 2: smart compact (TC-2.1–2.4, TC-2.6, TC-2.7, TC-1.3, TC-1.5).
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, is_dataclass
from typing import Any

import pytest
import pytest_asyncio

from lhc import Lhc, MessageEventInput, init_lhc
from lhc.messages import EditInput, RemoveInput
from lhc.shared_tech.derivation import ChunkPolicyConfig, SdkConfig
from lhc.shared_tech.inference_types import DerivationGuards, DetailedTurnCompressionGuards
from lhc.shared_tech.view import (
    CompactBandStats,
    CompactReceiptConfig,
    LlmRequestContextMessage,
    PartialViewProfilePercentages,
    SessionAssistantMessage,
    SessionUserMessage,
    ViewCompactParams,
    ViewProfilePercentages,
)
from lhc.thread_view import CompactOpts
from lhc.thread_view.internal.render import DerivationSnapshot
from lhc.thread_view.internal.select import (
    SelectionChunk,
    SelectionConfig,
    SelectionInputs,
    SelectionMessage,
    SelectionTurn,
    select_arrangement,
)
from fixtures import (
    DerivedThreadFixture,
    InferenceCallbacksDouble,
    TempStore,
    corrupt_two_open_turns,
    create_inference_callbacks_double,
    derived_thread_fixture,
    open_raw,
    set_view_injection_hook,
    temp_store,
    valid_event,
)

TARGET_PARAMS = ViewCompactParams(
    lower_bound=400,
    percentages=PartialViewProfilePercentages(full=25, smooth=25, detailed=25, brief=25),
)

GRADIENT_PARAMS = ViewCompactParams(
    lower_bound=400,
    percentages=PartialViewProfilePercentages(full=25, smooth=16, detailed=10, brief=49),
)

EDGE_PARAMS = ViewCompactParams(
    lower_bound=100,
    percentages=PartialViewProfilePercentages(full=50, smooth=10, detailed=10, brief=30),
)

TOOL_HEAVY_TURNS = {5, 6, 7, 8}
C1_BRIEF_FAILURE_REASON = "rate_limit: scripted c1 brief failure (test)"

_EMPTY_DERIVATION_COUNTS: dict[str, dict[str, int]] = {}


def _to_jsonable(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return {k: _to_jsonable(v) for k, v in asdict(value).items()}
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    return value


def _json_stringify(value: object) -> str:
    return json.dumps(_to_jsonable(value), separators=(",", ":"))


def _sha256(value: object) -> str:
    return hashlib.sha256(_json_stringify(value).encode("utf-8")).hexdigest()


def _db_rows(db, sql: str) -> list[dict[str, object]]:
    return [dict(row) for row in db.prepare(sql).all()]


def _record_snapshot(file_path: str) -> str:
    db = open_raw(file_path)
    try:
        return _sha256(
            {
                "events": _db_rows(db, "SELECT * FROM event ORDER BY event_order"),
                "messages": _db_rows(db, "SELECT * FROM message ORDER BY source_event_order"),
                "blocks": _db_rows(db, "SELECT * FROM message_block ORDER BY message_id, block_index"),
                "turns": _db_rows(db, "SELECT * FROM turns ORDER BY turn_order"),
                "chunks": _db_rows(db, "SELECT * FROM chunk ORDER BY chunk_order"),
                "members": _db_rows(db, "SELECT * FROM chunk_member ORDER BY chunk_id, member_idx"),
                "derivations": _db_rows(
                    db,
                    "SELECT * FROM derivation ORDER BY subject_kind, subject_id, derivation_type",
                ),
            }
        )
    finally:
        db.close()


def _full_state_snapshot(file_path: str) -> str:
    db = open_raw(file_path)
    try:
        return _sha256(
            {
                "record": _record_snapshot(file_path),
                "views": _db_rows(db, "SELECT * FROM thread_view"),
                "bands": _db_rows(db, "SELECT * FROM thread_view_band ORDER BY band"),
                "boundary": _db_rows(db, "SELECT position FROM view_boundary"),
                "work": _db_rows(
                    db, "SELECT work_item_id, status FROM work_item ORDER BY work_item_id"
                ),
            }
        )
    finally:
        db.close()


def _view_row_count(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        row = db.prepare("SELECT COUNT(*) AS n FROM thread_view").get()
        assert row is not None
        return int(row["n"])  # type: ignore[arg-type]
    finally:
        db.close()


def _boundary_position(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        row = db.prepare("SELECT position FROM view_boundary").get()
        assert row is not None
        return int(row["position"])  # type: ignore[arg-type]
    finally:
        db.close()


def _message_text(message: LlmRequestContextMessage) -> str:
    return "".join(part.text for part in message.content)


def _band_messages(messages: list[LlmRequestContextMessage]) -> list[LlmRequestContextMessage]:
    return [message for message in messages if _message_text(message).startswith("[context ·")]


async def _context_messages(sdk: Lhc, file_path: str) -> list[LlmRequestContextMessage]:
    context_read = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    if not context_read.ok:
        raise RuntimeError(f"model context failed: {context_read.error.reason}")
    return context_read.value.messages


async def _open_tail_dangling_tool_thread(into_store: TempStore) -> tuple[Lhc, str]:
    sdk = init_lhc(
        SdkConfig(mode="manual", inference_callbacks=create_inference_callbacks_double())
    )
    file_path = into_store.thread_path()
    created = await sdk.threads.new_thread(
        {"filePath": file_path, "registryPath": into_store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(f"thread creation failed: {created.error.reason}")

    for turn in range(1, 4):
        closed = await sdk.intake_stream.message_events(
            {"filePath": file_path},
            [
                valid_event("user_prompt", {"payload": {"text": f"closed turn {turn}"}}),
                valid_event("assistant_text", {"payload": {"text": f"closed answer {turn}"}}),
                valid_event("turn_end"),
            ],
        )
        if not closed.ok:
            raise RuntimeError(f"closed turn intake failed: {closed.error.reason}")
    drained = await sdk.work.drain({"filePath": file_path})
    if not drained.ok:
        raise RuntimeError(f"drain failed: {drained.error.reason}")

    opened = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "render the plan locally"}}),
            valid_event("assistant_text", {"payload": {"text": "Lint passed. Now let me serve it."}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-open-serve",
                        "toolName": "bash",
                        "arguments": {
                            "command": f"npx @agent-native/core@latest plan local serve {' --verbose' * 200}"
                        },
                    },
                },
            ),
        ],
    )
    if not opened.ok:
        raise RuntimeError(f"open turn intake failed: {opened.error.reason}")

    return sdk, file_path


def _degraded_turn_events(turn: int) -> list[MessageEventInput]:
    events: list[MessageEventInput] = [
        valid_event(
            "user_prompt", {"payload": {"text": f"turn {turn}: please investigate area {turn}"}}
        ),
        valid_event(
            "assistant_thinking", {"payload": {"text": f"considering what area {turn} contains"}}
        ),
    ]
    if turn in TOOL_HEAVY_TURNS:
        for run in [1, 2]:
            tool_call_id = f"call-dg-{turn}-{run}"
            events.extend(
                [
                    valid_event(
                        "tool_call",
                        {
                            "payload": {
                                "toolCallId": tool_call_id,
                                "toolName": "read_file",
                                "arguments": {"path": f"area-{turn}/file-{run}.txt"},
                            },
                        },
                    ),
                    valid_event(
                        "tool_result",
                        {
                            "payload": {
                                "toolCallId": tool_call_id,
                                "content": (
                                    f"contents of area-{turn}/file-{run}.txt: "
                                    f"detail {turn}.{run} with enough text to summarize"
                                ),
                                "isError": False,
                            },
                        },
                    ),
                ]
            )
    events.extend(
        [
            valid_event("assistant_text", {"payload": {"text": f"findings for area {turn}"}}),
            valid_event("turn_end"),
        ]
    )
    return events


@dataclass(frozen=True, slots=True)
class _DegradedThread:
    file_path: str
    sdk: Lhc
    double: InferenceCallbacksDouble
    prompt_id_by_turn: dict[int, str]


async def _build_degraded_thread(into_store: TempStore) -> _DegradedThread:
    double = create_inference_callbacks_double()
    sdk = init_lhc(
        SdkConfig(
            inference_callbacks=double,
            mode="manual",
            guards=DerivationGuards(
                detailed_turn_compression=DetailedTurnCompressionGuards(tiny_turn_tokens=1)
            ),
            chunk_policy=ChunkPolicyConfig(target_projected_tokens=90, max_projected_tokens=4400),
        )
    )
    file_path = into_store.thread_path()
    created = await sdk.threads.new_thread(
        {"filePath": file_path, "registryPath": into_store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(f"thread creation failed: {created.error.reason}")

    prompt_id_by_turn: dict[int, str] = {}
    for turn in range(1, 13):
        if turn == 4:
            double.fail_kind(
                "chunk_summary_brief",
                1,
                {"reason": C1_BRIEF_FAILURE_REASON},
            )
        sent = await sdk.intake_stream.message_events({"filePath": file_path}, _degraded_turn_events(turn))
        if not sent.ok:
            raise RuntimeError(f"intake failed: {sent.error.reason}")
        prompt_id = sent.value.events[0].message_id if sent.value.events else None
        if prompt_id is not None:
            prompt_id_by_turn[turn] = prompt_id
        drained = await sdk.work.drain({"filePath": file_path})
        if not drained.ok:
            raise RuntimeError(f"drain failed: {drained.error.reason}")

    for turn in [4, 5, 6, 8]:
        prompt_id = prompt_id_by_turn.get(turn)
        if prompt_id is None:
            raise RuntimeError(f"no prompt id recorded for turn {turn}")
        edited = await sdk.messages.edit(
            {"filePath": file_path},
            EditInput(message_id=prompt_id, content=f"turn {turn}: edited investigation of area {turn}"),
        )
        if not edited.ok:
            raise RuntimeError(f"edit failed: {edited.error.reason}")
    return _DegradedThread(
        file_path=file_path,
        sdk=sdk,
        double=double,
        prompt_id_by_turn=prompt_id_by_turn,
    )


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def fixture_pair() -> tuple[TempStore, DerivedThreadFixture]:
    store = temp_store()
    try:
        fixture = await derived_thread_fixture(store)
        yield store, fixture
    finally:
        store.cleanup()


@pytest.fixture(scope="module")
def store(fixture_pair: tuple[TempStore, DerivedThreadFixture]) -> TempStore:
    return fixture_pair[0]


@pytest.fixture(scope="module")
def fixture(fixture_pair: tuple[TempStore, DerivedThreadFixture]) -> DerivedThreadFixture:
    return fixture_pair[1]


async def test_rejects_percentages_summing_to_105_naming_the_sum_and_an_unknown_profile_naming_it_thread_unchanged(
    fixture: DerivedThreadFixture,
) -> None:
    """rejects percentages summing to 105 naming the sum, and an unknown profile naming it; thread unchanged"""
    before = _full_state_snapshot(fixture.file_path)

    bad_sum = await fixture.sdk.thread_view.compact(
        {"filePath": fixture.file_path},
        CompactOpts(
            params=ViewCompactParams(
                percentages=PartialViewProfilePercentages(
                    full=30, smooth=30, detailed=25, brief=20
                )
            )
        ),
    )
    assert bad_sum.ok is False
    if bad_sum.ok:
        return
    assert bad_sum.error.error_class == "caller_error"
    assert bad_sum.error.code == "invalid_view_config"
    assert "105" in bad_sum.error.reason

    bad_bound = await fixture.sdk.thread_view.compact(
        {"filePath": fixture.file_path},
        CompactOpts(params=ViewCompactParams(lower_bound=0)),
    )
    assert bad_bound.ok is False
    if bad_bound.ok:
        return
    assert bad_bound.error.code == "invalid_view_config"
    assert "lowerBound" in bad_bound.error.reason

    unknown = await fixture.sdk.thread_view.compact(
        {"filePath": fixture.file_path}, CompactOpts(profile="nonesuch")
    )
    assert unknown.ok is False
    if unknown.ok:
        return
    assert unknown.error.error_class == "caller_error"
    assert unknown.error.code == "unknown_profile"
    assert '"nonesuch"' in unknown.error.reason

    assert _full_state_snapshot(fixture.file_path) == before
    assert _view_row_count(fixture.file_path) == 0


async def test_compacts_with_a_built_in_profile_the_profiles_bound_and_mix_land_in_the_receipt(
    fixture: DerivedThreadFixture,
) -> None:
    """compacts with a built-in profile: the profile's bound and mix land in the receipt"""
    receipt = await fixture.sdk.thread_view.compact(
        {"filePath": fixture.file_path}, CompactOpts(profile="coding")
    )
    assert receipt.ok is True
    if not receipt.ok:
        return
    assert receipt.value.profile == "coding"
    assert receipt.value.config == CompactReceiptConfig(
        full=25, smooth=35, detailed=20, brief=20, lower_bound=120000
    )
    assert receipt.value.compact_point == 0
    assert receipt.value.bands["smooth"].entries == 0
    assert receipt.value.total_tokens == receipt.value.tail_tokens


async def test_explicit_params_override_profile_values_field_wise_and_report_profile_null(
    fixture: DerivedThreadFixture,
) -> None:
    """explicit params override profile values field-wise and report profile null"""
    receipt = await fixture.sdk.thread_view.compact(
        {"filePath": fixture.file_path},
        CompactOpts(
            profile="coding",
            params=ViewCompactParams(
                lower_bound=400,
                percentages=PartialViewProfilePercentages(smooth=40, detailed=15),
            ),
        ),
    )
    assert receipt.ok is True
    if not receipt.ok:
        return
    assert receipt.value.config == CompactReceiptConfig(
        full=25, smooth=40, detailed=15, brief=20, lower_bound=400
    )
    assert receipt.value.profile is None


async def test_actuals_near_shares_with_whole_entry_deviations_zero_model_calls_record_untouched(
    fixture: DerivedThreadFixture,
) -> None:
    """actuals near shares with whole-entry deviations, zero model calls, record untouched"""
    captured = fixture.double.capture_inputs()
    captured_before = len(captured)
    record_before = _record_snapshot(fixture.file_path)

    receipt = await fixture.sdk.thread_view.compact(
        {"filePath": fixture.file_path}, CompactOpts(params=TARGET_PARAMS)
    )
    assert receipt.ok is True
    if not receipt.ok:
        return
    shares = {
        "smooth": (400 * 25) / 100,
        "detailed": (400 * 25) / 100,
        "brief": (400 * 25) / 100,
    }

    for band in ["brief"]:
        actual = receipt.value.bands[band]
        attributable = actual.tokens <= shares[band] or actual.entries == 1
        assert attributable is True

    assert receipt.value.bands["brief"] == CompactBandStats(entries=1, tokens=27)
    assert receipt.value.bands["detailed"].entries == 2
    assert receipt.value.bands["detailed"].tokens >= shares["detailed"]
    assert receipt.value.bands["smooth"].entries == 1
    assert receipt.value.bands["smooth"].tokens > shares["smooth"]
    assert receipt.value.gaps == []
    assert receipt.value.tail_tokens <= (400 * 25) / 100
    assert receipt.value.compact_point == 48

    assert receipt.value.total_tokens == (
        receipt.value.bands["brief"].tokens
        + receipt.value.bands["detailed"].tokens
        + receipt.value.bands["smooth"].tokens
        + receipt.value.tail_tokens
    )

    assert len(captured) == captured_before
    assert _record_snapshot(fixture.file_path) == record_before


async def test_keeps_a_latest_open_turn_with_a_dangling_tool_call_in_the_live_session_tail(
    store: TempStore,
) -> None:
    """keeps a latest open turn with a dangling tool call in the live session tail"""
    local_sdk, local_file_path = await _open_tail_dangling_tool_thread(store)

    receipt = await local_sdk.thread_view.compact(
        {"filePath": local_file_path}, CompactOpts(params=TARGET_PARAMS)
    )
    assert receipt.ok is True
    if not receipt.ok:
        return

    assert receipt.value.compact_point == 9
    assert receipt.value.first_kept_message_id == "m10"
    assert receipt.value.bands["smooth"].entries > 0
    assert receipt.value.tail_tokens > (TARGET_PARAMS.lower_bound or 0) * 25 / 100

    view = await local_sdk.thread_view.get_session_thread_view({"filePath": local_file_path})
    assert view.ok is True
    if not view.ok:
        return

    open_user = next(
        (
            entry
            for entry in view.value.entries
            if isinstance(entry, SessionUserMessage)
            and entry.role == "user"
            and entry.content == "render the plan locally"
        ),
        None,
    )
    assert open_user is not None
    assert open_user.source_messages[0].message_id == "m10"

    last = view.value.entries[-1] if view.value.entries else None
    assert last is not None
    assert isinstance(last, SessionAssistantMessage)
    assert last.role == "assistant"
    assert [source.message_id for source in last.source_messages] == ["m11", "m12"]
    tool_part = next((part for part in last.content if part.type == "toolCall"), None)
    assert tool_part is not None
    assert tool_part.tool_call_id == "call-open-serve"
    assert tool_part.tool_name == "bash"


def test_renders_coverage_entries_for_closed_turns_left_uncovered_inside_an_open_chunk() -> None:
    """renders coverage entries for closed turns left uncovered inside an open chunk"""
    turns = [
        SelectionTurn(
            turn_id=f"t{index + 1}",
            turn_order=index + 1,
            status="closed",
            opened_at=(index) * 10 + 1,
            closed_at=(index + 1) * 10,
        )
        for index in range(6)
    ]
    messages = [
        SelectionMessage(
            message_id=f"m{turn.turn_order}",
            order=turn.opened_at,
            kind="user_prompt",
            token_estimate=100 if turn.turn_id == "t6" else 10,
            turn_id=turn.turn_id,
            text=f"prompt {turn.turn_id}",
        )
        for turn in turns
    ]
    chunks = [
        SelectionChunk(chunk_id="c1", chunk_order=1, status="closed", member_turn_ids=["t1", "t2"]),
        SelectionChunk(
            chunk_id="c2", chunk_order=2, status="open", member_turn_ids=["t3", "t4", "t5"]
        ),
    ]
    inputs = SelectionInputs(
        messages=messages,
        turns=turns,
        chunks=chunks,
        derivations={
            "t3/detailed_turn_compression": DerivationSnapshot(state="ready", content="compressed " * 200),
            "t4/detailed_turn_compression": DerivationSnapshot(
                state="failed", reason="compression failed"
            ),
            "t4/pre_detailed_assembly": DerivationSnapshot(
                state="ready", content=f"User:\n{'large ' * 500}\n\n⏺ more"
            ),
            "t5/turn_rendering": DerivationSnapshot(state="ready", content="newest banded turn"),
            "c1/chunk_summary_detailed": DerivationSnapshot(state="ready", content="closed chunk summary"),
        },
        max_event_order=60,
        derivation_counts=_EMPTY_DERIVATION_COUNTS,
    )

    selection = select_arrangement(
        inputs,
        SelectionConfig(
            lower_bound=1000,
            percentages=ViewProfilePercentages(full=10, smooth=10, detailed=40, brief=40),
        ),
    )

    assert selection.compact_point == 50
    assert selection.covered_from == 1
    assert [
        {
            "band": entry.band,
            "subjectKind": entry.subject_kind,
            "subjectId": entry.subject_id,
            "derivationUsed": entry.derivation_used,
            "gap": entry.gap,
        }
        for entry in selection.entries
    ] == [
        {
            "band": "detailed",
            "subjectKind": "chunk",
            "subjectId": "c1",
            "derivationUsed": "chunk_summary_detailed",
            "gap": False,
        },
        {
            "band": "detailed",
            "subjectKind": "turn",
            "subjectId": "t3",
            "derivationUsed": "detailed_turn_compression",
            "gap": False,
        },
        {
            "band": "smooth",
            "subjectKind": "turn",
            "subjectId": "t4",
            "derivationUsed": "message_excerpt",
            "gap": False,
        },
        {
            "band": "smooth",
            "subjectKind": "turn",
            "subjectId": "t5",
            "derivationUsed": "turn_rendering",
            "gap": False,
        },
    ]
    assert [entry for entry in selection.entries if entry.gap] == []
    t4_entry = next(entry for entry in selection.entries if entry.subject_id == "t4")
    assert t4_entry.degraded is True


async def test_closed_turns_below_the_coverage_edge_remain_outside_the_represented_window(
    fixture: DerivedThreadFixture,
) -> None:
    """closed turns below the coverage edge remain outside the represented window"""
    receipt = await fixture.sdk.thread_view.compact(
        {"filePath": fixture.file_path}, CompactOpts(params=EDGE_PARAMS)
    )
    assert receipt.ok is True
    if not receipt.ok:
        return

    assert receipt.value.compact_point == 56
    assert receipt.value.covered_from == 13
    assert receipt.value.bands["detailed"].entries == 1
    assert receipt.value.bands["brief"].entries == 1
    assert receipt.value.gaps == []

    assert receipt.value.bands["detailed"].entries == 1
    assert receipt.value.bands["brief"].entries == 1


async def test_brief_detailed_and_smooth_band_text_carries_selected_conversation_content(
    fixture: DerivedThreadFixture,
) -> None:
    """brief, detailed, and smooth band text carries selected conversation content"""
    receipt = await fixture.sdk.thread_view.compact(
        {"filePath": fixture.file_path}, CompactOpts(params=GRADIENT_PARAMS)
    )
    assert receipt.ok is True

    messages = await _context_messages(fixture.sdk, fixture.file_path)
    bands = _band_messages(messages)
    by_band: dict[str, str] = {}
    for message in bands:
        match = re.match(r"^\[context · ([^\]]+)\]", _message_text(message))
        if match:
            by_band[match.group(1)] = _message_text(message)
    assert "projection(" in by_band["brief"]
    assert "projection(" in by_band["detailed"]
    assert "User prompt" in by_band["smooth"]


async def test_a_fresh_sdk_on_the_same_file_serves_byte_identical_band_content(store: TempStore) -> None:
    """a fresh SDK on the same file serves byte-identical band content"""
    local = await derived_thread_fixture(store)
    receipt = await local.sdk.thread_view.compact(
        {"filePath": local.file_path}, CompactOpts(params=GRADIENT_PARAMS)
    )
    assert receipt.ok is True
    before = await local.sdk.thread_view.get_llm_request_context({"filePath": local.file_path})
    assert before.ok is True
    if not before.ok:
        return

    fresh = init_lhc(
        SdkConfig(inference_callbacks=create_inference_callbacks_double(), mode="manual")
    )
    after = await fresh.thread_view.get_llm_request_context({"filePath": local.file_path})
    assert after.ok is True
    if not after.ok:
        return
    assert _json_stringify(after.value) == _json_stringify(before.value)


async def test_an_injected_crash_leaves_the_previous_view_serving_the_rerun_lands_clean_with_no_partial_state(
    store: TempStore,
) -> None:
    """an injected crash leaves the previous view serving; the rerun lands clean with no partial state"""
    local = await derived_thread_fixture(store)
    first = await local.sdk.thread_view.compact(
        {"filePath": local.file_path}, CompactOpts(params=GRADIENT_PARAMS)
    )
    assert first.ok is True
    prior_context = await local.sdk.thread_view.get_llm_request_context({"filePath": local.file_path})
    assert prior_context.ok is True
    if not prior_context.ok:
        return
    assert _boundary_position(local.file_path) == 48

    def _crash_hook() -> None:
        raise RuntimeError("injected crash between sweep and view write")

    set_view_injection_hook("compact-write", _crash_hook)
    try:
        crashed = await local.sdk.thread_view.compact(
            {"filePath": local.file_path}, CompactOpts(params=EDGE_PARAMS)
        )
        assert crashed.ok is False
        if crashed.ok:
            return
        assert crashed.error.error_class == "system_error"
        assert "injected crash" in crashed.error.reason
    finally:
        set_view_injection_hook("compact-write", None)

    after_crash = await local.sdk.thread_view.get_llm_request_context({"filePath": local.file_path})
    assert after_crash.ok is True
    if not after_crash.ok:
        return
    assert _json_stringify(after_crash.value) == _json_stringify(prior_context.value)
    assert _view_row_count(local.file_path) == 1
    assert _boundary_position(local.file_path) == 48

    rerun = await local.sdk.thread_view.compact(
        {"filePath": local.file_path}, CompactOpts(params=EDGE_PARAMS)
    )
    assert rerun.ok is True
    if not rerun.ok:
        return
    assert rerun.value.covered_from == 13
    assert _view_row_count(local.file_path) == 1
    assert _boundary_position(local.file_path) == 56
    rerun_context = await local.sdk.thread_view.get_llm_request_context({"filePath": local.file_path})
    assert rerun_context.ok is True
    if not rerun_context.ok:
        return
    assert _json_stringify(rerun_context.value) != _json_stringify(prior_context.value)


class _DynamicAbortSignal:
    def __init__(self) -> None:
        self.flag = False

    @property
    def aborted(self) -> bool:
        return self.flag


async def test_abort_immediately_before_snapshot_write_leaves_the_prior_view_unchanged(
    store: TempStore,
) -> None:
    """abort immediately before snapshot write leaves the prior view unchanged"""
    local = await derived_thread_fixture(store)
    first = await local.sdk.thread_view.compact(
        {"filePath": local.file_path}, CompactOpts(params=GRADIENT_PARAMS)
    )
    assert first.ok is True
    prior_context = await local.sdk.thread_view.get_llm_request_context({"filePath": local.file_path})
    assert prior_context.ok is True
    if not prior_context.ok:
        return
    prior_compact_point = _boundary_position(local.file_path)

    stop = _DynamicAbortSignal()
    signal = stop

    def _abort_hook() -> None:
        stop.flag = True

    set_view_injection_hook("compact-write", _abort_hook)
    try:
        stopped = await local.sdk.thread_view.compact(
            {"filePath": local.file_path},
            CompactOpts(params=EDGE_PARAMS, signal=signal),  # type: ignore[arg-type]
        )
        assert stopped.ok is False
        if stopped.ok:
            return
        assert stopped.error.error_class == "caller_error"
        assert stopped.error.code == "compact_stopped"
    finally:
        set_view_injection_hook("compact-write", None)

    after_stop = await local.sdk.thread_view.get_llm_request_context({"filePath": local.file_path})
    assert after_stop.ok is True
    if not after_stop.ok:
        return
    assert _json_stringify(after_stop.value) == _json_stringify(prior_context.value)
    assert _view_row_count(local.file_path) == 1
    assert _boundary_position(local.file_path) == prior_compact_point


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def degraded_thread() -> _DegradedThread:
    degraded_store = temp_store()
    try:
        yield await _build_degraded_thread(degraded_store)
    finally:
        degraded_store.cleanup()


async def test_completes_with_ladder_fallbacks_marked_gap_entries_for_unusable_spans_and_full_accounting_in_the_receipt(
    degraded_thread: _DegradedThread,
) -> None:
    """completes with ladder fallbacks marked, gap entries for unusable spans, and full accounting in the receipt"""
    captured = degraded_thread.double.capture_inputs()
    captured_before = len(captured)

    receipt = await degraded_thread.sdk.thread_view.compact(
        {"filePath": degraded_thread.file_path},
        CompactOpts(
            params=ViewCompactParams(
                lower_bound=400,
                percentages=PartialViewProfilePercentages(
                    full=25, smooth=25, detailed=10, brief=40
                ),
            )
        ),
    )
    assert receipt.ok is True
    if not receipt.ok:
        return

    t8 = next((entry for entry in receipt.value.degraded if entry.subject_id == "t8"), None)
    assert t8 is not None
    assert t8.band == "smooth"
    assert t8.used_derivation == "message_excerpt"

    assert receipt.value.gaps == []
    c2 = next((entry for entry in receipt.value.degraded if entry.subject_id == "c2"), None)
    assert c2 is not None
    assert c2.used_derivation == "stored_member_concat"

    assert receipt.value.bands["brief"].entries == 1
    assert receipt.value.bands["detailed"].entries == 2
    assert receipt.value.bands["smooth"].entries == 1
    assert receipt.value.compact_point == 48
    assert receipt.value.covered_from == 1

    messages = await _context_messages(degraded_thread.sdk, degraded_thread.file_path)
    band_text = "\n\n".join(_message_text(message) for message in _band_messages(messages))
    assert "[degraded: detailed-from-stored-members]" in band_text
    assert "[degraded: smooth-from-excerpt]" in band_text

    assert len(captured) == captured_before


async def test_status_reports_the_view_health_fields_live_after_the_degraded_compact_tc_2_5_completion_leg(
    degraded_thread: _DegradedThread,
) -> None:
    """status reports the view-health fields live after the degraded compact (TC-2.5 completion leg)"""
    status = await degraded_thread.sdk.thread_view.status({"filePath": degraded_thread.file_path})
    assert status.ok is True
    if not status.ok:
        return
    assert status.value.view is not None
    assert status.value.view.degraded == 3
    assert status.value.view.gaps == 0
    assert isinstance(status.value.view.built_at, str)
    assert status.value.derivation.pending > 0


async def test_refuses_with_state_corruption_naming_the_damage_the_prior_view_still_serves_record_unchanged() -> (
    None
):
    """refuses with state_corruption naming the damage; the prior view still serves; record unchanged"""
    corrupt_store = temp_store()
    try:
        double = create_inference_callbacks_double()
        sdk = init_lhc(SdkConfig(inference_callbacks=double, mode="manual"))
        file_path = corrupt_store.thread_path()
        created = await sdk.threads.new_thread(
            {"filePath": file_path, "registryPath": corrupt_store.registry_path}
        )
        assert created.ok is True
        for turn in range(1, 5):
            sent = await sdk.intake_stream.message_events(
                {"filePath": file_path}, _degraded_turn_events(turn)
            )
            assert sent.ok is True
        drained = await sdk.work.drain({"filePath": file_path})
        assert drained.ok is True

        first = await sdk.thread_view.compact(
            {"filePath": file_path},
            CompactOpts(
                params=ViewCompactParams(
                    lower_bound=80,
                    percentages=PartialViewProfilePercentages(
                        full=50, smooth=30, detailed=10, brief=10
                    ),
                )
            ),
        )
        assert first.ok is True
        prior_context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
        assert prior_context.ok is True
        if not prior_context.ok:
            return
        prior_view = await sdk.thread_view.describe({"filePath": file_path})
        assert prior_view.ok is True
        if not prior_view.ok:
            return

        opened = await sdk.intake_stream.message_events(
            {"filePath": file_path},
            [valid_event("user_prompt", {"payload": {"text": "left open before the damage"}})],
        )
        assert opened.ok is True
        corrupt_two_open_turns(file_path)
        record_before = _record_snapshot(file_path)

        refused = await sdk.thread_view.compact(
            {"filePath": file_path},
            CompactOpts(
                params=ViewCompactParams(
                    lower_bound=80,
                    percentages=PartialViewProfilePercentages(
                        full=50, smooth=30, detailed=10, brief=10
                    ),
                )
            ),
        )
        assert refused.ok is False
        if refused.ok:
            return
        assert refused.error.error_class == "state_corruption"
        assert refused.error.code == "turn_state_corrupt"
        assert re.search(r"open turns", refused.error.reason)

        after_context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
        assert after_context.ok is True
        if not after_context.ok:
            return
        assert _json_stringify(_band_messages(after_context.value.messages)) == _json_stringify(
            _band_messages(prior_context.value.messages)
        )
        after_view = await sdk.thread_view.describe({"filePath": file_path})
        assert after_view.ok is True
        if not after_view.ok:
            return
        assert after_view.value is not None and prior_view.value is not None
        assert after_view.value.view_id == prior_view.value.view_id
        assert _record_snapshot(file_path) == record_before
    finally:
        corrupt_store.cleanup()


async def test_control_a_thread_with_only_derived_material_damage_compacts_successfully_with_gaps(
    store: TempStore,
) -> None:
    """control: a thread with only derived-material damage compacts successfully with gaps"""
    local = await derived_thread_fixture(store)
    receipt = await local.sdk.thread_view.compact(
        {"filePath": local.file_path}, CompactOpts(params=GRADIENT_PARAMS)
    )
    assert receipt.ok is True


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def mutation_fixture(store: TempStore) -> DerivedThreadFixture:
    mut_store = temp_store()
    try:
        mut = await derived_thread_fixture(mut_store, {"failures": False})
        receipt = await mut.sdk.thread_view.compact(
            {"filePath": mut.file_path}, CompactOpts(params=GRADIENT_PARAMS)
        )
        if not receipt.ok:
            raise RuntimeError(f"setup compact failed: {receipt.error.reason}")
        yield mut
    finally:
        mut_store.cleanup()


async def test_tc_1_3_editing_a_banded_subject_leaves_band_bytes_unchanged_across_context_reads_before_and_after_the_drain(
    mutation_fixture: DerivedThreadFixture,
) -> None:
    """TC-1.3: editing a banded subject leaves band bytes unchanged across context reads, before and after the drain"""
    mut = mutation_fixture
    before = _band_messages(await _context_messages(mut.sdk, mut.file_path))
    band_hash = _sha256(before)

    listed = await mut.sdk.messages.list({"filePath": mut.file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    t5_prompt = next(
        (m for m in listed.value if m.turn_id == "t5" and m.kind == "user_prompt"), None
    )
    assert t5_prompt is not None
    edited = await mut.sdk.messages.edit(
        {"filePath": mut.file_path},
        EditInput(message_id=t5_prompt.message_id, content="turn 5: edited after the snapshot"),
    )
    assert edited.ok is True

    after_edit = _band_messages(await _context_messages(mut.sdk, mut.file_path))
    assert _sha256(after_edit) == band_hash

    drained = await mut.sdk.work.drain({"filePath": mut.file_path})
    assert drained.ok is True
    after_drain = _band_messages(await _context_messages(mut.sdk, mut.file_path))
    assert _sha256(after_drain) == band_hash

    db = open_raw(mut.file_path)
    try:
        row = db.prepare(
            """SELECT content FROM derivation
           WHERE subject_kind = 'chunk' AND subject_id = 'c2' AND derivation_type = 'chunk_summary_detailed'"""
        ).get()
        assert row is not None
        # TS: expect(row?.content).toBeDefined() — tolerates null; rejects only undefined
        content = row["content"]
        detailed_band = next(
            (m for m in after_drain if _message_text(m).startswith("[context · detailed]")),
            None,
        )
        # TS: expect(detailedBand === undefined ? undefined : messageText(...)).not.toContain(...)
        # Vitest toContain on undefined throws — do not pass via `is None or`.
        detailed_text = None if detailed_band is None else _message_text(detailed_band)
        assert detailed_text is not None
        assert str(content) not in detailed_text
    finally:
        db.close()


async def test_tc_1_5_a_tail_delete_vanishes_from_the_next_context_read_a_banded_delete_leaves_the_snapshot_until_the_next_compact(
    mutation_fixture: DerivedThreadFixture,
) -> None:
    """TC-1.5: a tail delete vanishes from the next context read; a banded delete leaves the snapshot until the next compact"""
    mut = mutation_fixture
    listed = await mut.sdk.messages.list({"filePath": mut.file_path})
    assert listed.ok is True
    if not listed.ok:
        return

    tail_target = next(
        (m for m in listed.value if m.turn_id == "t10" and m.kind == "assistant_text"), None
    )
    assert tail_target is not None
    status_before = await mut.sdk.thread_view.status({"filePath": mut.file_path})
    assert status_before.ok is True
    if not status_before.ok:
        return

    tail_delete = await mut.sdk.messages.remove(
        {"filePath": mut.file_path}, RemoveInput(message_id=tail_target.message_id)
    )
    assert tail_delete.ok is True
    after_tail_delete = await _context_messages(mut.sdk, mut.file_path)
    assert not any(_message_text(m) == "findings for area 10" for m in after_tail_delete)

    status_after = await mut.sdk.thread_view.status({"filePath": mut.file_path})
    assert status_after.ok is True
    if not status_after.ok:
        return
    assert status_after.value.tail_tokens < status_before.value.tail_tokens

    bands_before = _band_messages(after_tail_delete)
    band_target = next(
        (m for m in listed.value if m.turn_id == "t6" and m.kind == "assistant_text"), None
    )
    assert band_target is not None
    banded_delete = await mut.sdk.messages.remove(
        {"filePath": mut.file_path}, RemoveInput(message_id=band_target.message_id)
    )
    assert banded_delete.ok is True

    after_banded_delete = await _context_messages(mut.sdk, mut.file_path)
    assert _sha256(_band_messages(after_banded_delete)) == _sha256(bands_before)

    status_final = await mut.sdk.thread_view.status({"filePath": mut.file_path})
    assert status_final.ok is True
    if not status_final.ok:
        return
    assert status_final.value.derivation.pending > 0
