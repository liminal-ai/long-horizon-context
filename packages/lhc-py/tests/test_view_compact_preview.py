"""Ported from packages/lhc/test/view-compact-preview.test.ts. Phase 1.

Story 0 / TC-5.1c: previewCompact shares computeArrangement with compact.
"""

from __future__ import annotations

import json
import re

import pytest
import pytest_asyncio

from lhc import Lhc, MessageEventInput, count_live_items, create_deterministic_inference_callbacks, init_lhc
from lhc.shared_tech.derivation import SdkConfig
from lhc.shared_tech.view import (
    PartialViewProfilePercentages,
    PreviewCompactOk,
    PreviewCompactResult,
    ViewCompactParams,
)
from lhc.thread_view import CompactOpts
from fixtures import (
    DerivedThreadFixture,
    TempStore,
    create_inference_callbacks_double,
    derived_thread_fixture,
    event_batch,
    open_raw,
    temp_store,
    valid_event,
)

pytestmark = pytest.mark.asyncio(loop_scope="module")

TARGET_PARAMS = ViewCompactParams(
    lower_bound=400,
    percentages=PartialViewProfilePercentages(full=25, smooth=25, detailed=25, brief=25),
)

GRADIENT_PARAMS = ViewCompactParams(
    lower_bound=400,
    percentages=PartialViewProfilePercentages(full=25, smooth=16, detailed=10, brief=49),
)

ALL_FITS_PARAMS = ViewCompactParams(
    lower_bound=1_000_000,
    percentages=PartialViewProfilePercentages(full=25, smooth=25, detailed=25, brief=25),
)

NEAR_NO_OP_PARAMS = ViewCompactParams(
    lower_bound=50,
    percentages=PartialViewProfilePercentages(full=10, smooth=10, detailed=10, brief=70),
)


def _view_row_count(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        row = db.prepare("SELECT COUNT(*) AS n FROM thread_view").get()
        assert row is not None
        return int(row["n"])  # type: ignore[arg-type]
    finally:
        db.close()


def _live_count(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        return count_live_items(db)
    finally:
        db.close()


def _stored_arrangement_subject_ids(file_path: str) -> list[str]:
    db = open_raw(file_path)
    try:
        row = db.prepare(
            "SELECT arrangement_json FROM thread_view WHERE singleton = 1"
        ).get()
        if row is None:
            return []
        arrangement = json.loads(str(row["arrangement_json"]))
        return [entry["subjectId"] for entry in arrangement]
    finally:
        db.close()


async def _preview_and_compact(
    target: Lhc,
    file_path: str,
    params: ViewCompactParams,
) -> tuple[object, object]:
    preview = await target.thread_view.preview_compact({"filePath": file_path}, CompactOpts(params=params))
    compact = await target.thread_view.compact({"filePath": file_path}, CompactOpts(params=params))
    return preview, compact


async def _new_manual_sdk(store: TempStore) -> tuple[Lhc, str]:
    sdk = init_lhc(
        SdkConfig(mode="manual", inference_callbacks=create_deterministic_inference_callbacks())
    )
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(
        {"filePath": file_path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(created.error.reason)
    return sdk, file_path


def _ok_preview(preview) -> PreviewCompactResult:
    assert preview.ok is True
    if not preview.ok:
        raise RuntimeError(preview.error.reason)
    assert preview.value.kind == "ok"
    assert isinstance(preview.value, PreviewCompactOk)
    return preview.value.preview


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


async def test_all_fits_three_closed_turns_under_full_budget_compactpoint_0(store: TempStore) -> None:
    """all-fits: three closed turns under full budget → compactPoint 0"""
    sdk, file_path = await _new_manual_sdk(store)
    for _ in range(3):
        captured = await sdk.intake_stream.message_events(
            {"filePath": file_path},
            event_batch(["user_prompt", "assistant_text", "turn_end"]),
        )
        assert captured.ok is True

    preview, compact = await _preview_and_compact(sdk, file_path, ALL_FITS_PARAMS)
    preview_result = _ok_preview(preview)
    assert compact.ok is True
    if not compact.ok:
        return

    assert preview_result.compact_point == 0
    assert preview_result.would_produce_bands is False
    assert preview_result.first_kept_message_id == "m1"
    assert compact.value.compact_point == 0
    assert compact.value.first_kept_message_id == "m1"
    assert preview_result.compact_point == compact.value.compact_point


async def test_over_budget_derived_fixture_compactpoint_snaps_to_turn_t8_close_event_order_48(
    store: TempStore,
) -> None:
    """over-budget derived fixture → compactPoint snaps to turn t8 close (event order 48)"""
    local = await derived_thread_fixture(store)
    preview, compact = await _preview_and_compact(local.sdk, local.file_path, TARGET_PARAMS)
    preview_result = _ok_preview(preview)
    assert compact.ok is True
    if not compact.ok:
        return

    assert preview_result.compact_point == 48
    assert preview_result.would_produce_bands is True
    assert compact.value.compact_point == 48
    assert preview_result.compact_point == compact.value.compact_point

    db = open_raw(local.file_path)
    try:
        turn = db.prepare(
            "SELECT closed_at_event_order FROM turns WHERE turn_id = 't8'"
        ).get()
        assert turn is not None
        assert preview_result.compact_point == int(turn["closed_at_event_order"])  # type: ignore[arg-type]
    finally:
        db.close()


async def test_near_no_op_one_small_brief_band_compactpoint_9_at_turn_t3_close_wouldproducebands_true(
    store: TempStore,
) -> None:
    """near-no-op: one small brief band → compactPoint 9 at turn t3 close, wouldProduceBands true"""
    sdk, file_path = await _new_manual_sdk(store)
    batch: list[MessageEventInput] = []
    for turn in range(1, 5):
        batch.extend(
            [
                valid_event("user_prompt", {"payload": {"text": f"brief turn {turn}"}}),
                valid_event("assistant_text", {"payload": {"text": f"ok {turn}"}}),
                valid_event("turn_end"),
            ]
        )
    captured = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    assert captured.ok is True
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok is True

    preview, compact = await _preview_and_compact(sdk, file_path, NEAR_NO_OP_PARAMS)
    preview_result = _ok_preview(preview)
    assert compact.ok is True
    if not compact.ok:
        return

    assert preview_result.compact_point == 9
    assert preview_result.would_produce_bands is True
    assert preview_result.first_kept_message_id == "m10"
    assert compact.value.compact_point == 9
    assert preview_result.compact_point == compact.value.compact_point

    db = open_raw(file_path)
    try:
        turn = db.prepare(
            "SELECT closed_at_event_order FROM turns WHERE turn_id = 't3'"
        ).get()
        assert turn is not None
        assert preview_result.compact_point == int(turn["closed_at_event_order"])  # type: ignore[arg-type]
    finally:
        db.close()


async def test_tc_5_1c_preview_compactpoint_matches_compact_on_the_derived_fixture(
    fixture: DerivedThreadFixture,
) -> None:
    """TC-5.1c: preview compactPoint matches compact on the derived fixture"""
    preview, compact = await _preview_and_compact(fixture.sdk, fixture.file_path, TARGET_PARAMS)
    assert preview.ok is True
    assert compact.ok is True
    if not preview.ok or not compact.ok:
        return
    assert preview.value.kind == "ok"
    assert isinstance(preview.value, PreviewCompactOk)
    assert preview.value.preview.compact_point == compact.value.compact_point
    assert preview.value.preview.would_produce_bands == (compact.value.compact_point > 0)
    assert preview.value.preview.first_kept_message_id == compact.value.first_kept_message_id


async def test_tc_5_6b_re_compact_may_move_compact_point_backward_preview_and_compact_stay_coherent(
    store: TempStore,
) -> None:
    """TC-5.6b: re-compact may move compact point backward; preview and compact stay coherent"""
    local = await derived_thread_fixture(store)
    first = await local.sdk.thread_view.compact(
        {"filePath": local.file_path}, CompactOpts(params=TARGET_PARAMS)
    )
    assert first.ok is True
    if not first.ok:
        return
    assert first.value.compact_point == 48

    preview = await local.sdk.thread_view.preview_compact(
        {"filePath": local.file_path}, CompactOpts(params=ALL_FITS_PARAMS)
    )
    assert preview.ok is True
    if not preview.ok:
        return
    assert preview.value.kind == "ok"
    assert isinstance(preview.value, PreviewCompactOk)
    assert preview.value.preview.compact_point == 0
    assert preview.value.preview.would_produce_bands is False
    assert preview.value.preview.first_kept_message_id == "m1"

    second = await local.sdk.thread_view.compact(
        {"filePath": local.file_path}, CompactOpts(params=ALL_FITS_PARAMS)
    )
    assert second.ok is True
    if not second.ok:
        return
    assert second.value.compact_point == 0
    assert second.value.first_kept_message_id == "m1"

    described = await local.sdk.thread_view.describe({"filePath": local.file_path})
    assert described.ok is True
    if not described.ok:
        return
    assert described.value is not None and described.value.compact_point == 0


async def test_same_point_preview_reports_bands_when_recomputed_arrangement_repairs_the_stored_snapshot(
    store: TempStore,
) -> None:
    """same-point preview reports bands when recomputed arrangement repairs the stored snapshot"""
    local = await derived_thread_fixture(store)
    first = await local.sdk.thread_view.compact(
        {"filePath": local.file_path}, CompactOpts(params=TARGET_PARAMS)
    )
    assert first.ok is True
    if not first.ok:
        return
    assert first.value.compact_point == 48
    assert "t7" in _stored_arrangement_subject_ids(local.file_path)
    assert first.value.gaps == []

    db = open_raw(local.file_path)
    try:
        row = db.prepare(
            "SELECT arrangement_json FROM thread_view WHERE singleton = 1"
        ).get()
        assert row is not None
        arrangement = json.loads(str(row["arrangement_json"]))
        db.prepare(
            "UPDATE thread_view SET arrangement_json = ?, gaps_json = ? WHERE singleton = 1"
        ).run(
            json.dumps(
                [entry for entry in arrangement if entry["subjectId"] != "t7"],
                separators=(",", ":"),
            ),
            "[]",
        )
    finally:
        db.close()

    preview = await local.sdk.thread_view.preview_compact(
        {"filePath": local.file_path}, CompactOpts(params=TARGET_PARAMS)
    )
    assert preview.ok is True
    if not preview.ok or preview.value.kind != "ok":
        return
    assert isinstance(preview.value, PreviewCompactOk)
    assert preview.value.preview.compact_point == 48
    assert preview.value.preview.would_produce_bands is True

    repaired = await local.sdk.thread_view.compact(
        {"filePath": local.file_path}, CompactOpts(params=TARGET_PARAMS)
    )
    assert repaired.ok is True
    if not repaired.ok:
        return
    assert repaired.value.compact_point == 48
    assert "t7" in _stored_arrangement_subject_ids(local.file_path)
    assert repaired.value.gaps == []


async def test_exactness_golden_corpus_sizes_agree_on_compactpoint_no_op_banded_re_compact(
    store: TempStore,
) -> None:
    """exactness golden: corpus sizes agree on compactPoint (no-op, banded, re-compact)"""
    cases = [
        {
            "label": "no-op-small",
            "params": ViewCompactParams(
                lower_bound=500_000,
                percentages=PartialViewProfilePercentages(
                    full=25, smooth=25, detailed=25, brief=25
                ),
            ),
        },
        {"label": "banded-target", "params": TARGET_PARAMS},
        {"label": "banded-gradient", "params": GRADIENT_PARAMS},
    ]

    for scenario in cases:
        local = await derived_thread_fixture(store)
        preview, compact = await _preview_and_compact(
            local.sdk, local.file_path, scenario["params"]  # type: ignore[arg-type]
        )
        assert preview.ok, scenario["label"]
        assert compact.ok, scenario["label"]
        if not preview.ok or not compact.ok:
            continue
        assert preview.value.kind == "ok", scenario["label"]
        if preview.value.kind != "ok":
            continue
        assert isinstance(preview.value, PreviewCompactOk)
        assert preview.value.preview.compact_point == compact.value.compact_point, scenario["label"]
        assert preview.value.preview.would_produce_bands == (
            compact.ok and compact.value.compact_point > 0
        ), scenario["label"]

        second = await _preview_and_compact(local.sdk, local.file_path, scenario["params"])  # type: ignore[arg-type]
        assert second[0].ok is True
        if not second[0].ok:
            continue
        assert second[0].value.kind == "ok"
        if second[0].value.kind != "ok":
            continue
        assert second[1].ok, scenario["label"]
        if not second[1].ok:
            continue
        assert isinstance(second[0].value, PreviewCompactOk)
        assert second[0].value.preview.compact_point == second[1].value.compact_point, scenario["label"]


async def test_near_no_op_with_one_small_brief_entry_still_reports_wouldproducebands_true(
    store: TempStore,
) -> None:
    """near-no-op with one small brief entry still reports wouldProduceBands true"""
    sdk, file_path = await _new_manual_sdk(store)
    batch: list[MessageEventInput] = []
    for turn in range(1, 5):
        batch.extend(
            [
                valid_event("user_prompt", {"payload": {"text": f"brief turn {turn}"}}),
                valid_event("assistant_text", {"payload": {"text": f"ok {turn}"}}),
                valid_event("turn_end"),
            ]
        )
    captured = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    assert captured.ok is True
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok is True

    preview = await sdk.thread_view.preview_compact(
        {"filePath": file_path}, CompactOpts(params=NEAR_NO_OP_PARAMS)
    )
    preview_result = _ok_preview(preview)
    assert preview_result.would_produce_bands is True
    assert preview_result.compact_point == 9


async def test_preview_never_writes_a_thread_view_row(store: TempStore) -> None:
    """preview never writes a thread_view row"""
    local = await derived_thread_fixture(store)
    before = _view_row_count(local.file_path)
    preview = await local.sdk.thread_view.preview_compact(
        {"filePath": local.file_path}, CompactOpts(params=TARGET_PARAMS)
    )
    assert preview.ok is True
    assert _view_row_count(local.file_path) == before


async def test_latest_open_turn_with_a_dangling_tool_call_previews_ok_and_stays_after_compact_point(
    store: TempStore,
) -> None:
    """latest open turn with a dangling tool call previews ok and stays after compact point"""
    path = store.thread_path()
    local_sdk = init_lhc(
        SdkConfig(mode="manual", inference_callbacks=create_deterministic_inference_callbacks())
    )
    created = await local_sdk.threads.new_thread(
        {"filePath": path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(created.error.reason)

    for turn in range(1, 4):
        closed = await local_sdk.intake_stream.message_events(
            {"filePath": path},
            [
                valid_event("user_prompt", {"payload": {"text": f"closed turn {turn}"}}),
                valid_event("assistant_text", {"payload": {"text": f"closed answer {turn}"}}),
                valid_event("turn_end"),
            ],
        )
        assert closed.ok is True
    drained = await local_sdk.work.drain({"filePath": path})
    assert drained.ok is True

    captured = await local_sdk.intake_stream.message_events(
        {"filePath": path},
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
    assert captured.ok is True

    before = _view_row_count(path)
    preview = await local_sdk.thread_view.preview_compact(
        {"filePath": path}, CompactOpts(params=TARGET_PARAMS)
    )
    assert preview.ok is True
    if not preview.ok:
        return
    preview_result = _ok_preview(preview)
    assert preview_result.compact_point == 9
    assert preview_result.would_produce_bands is True
    assert preview_result.first_kept_message_id == "m10"
    assert preview_result.tail_tokens > (TARGET_PARAMS.lower_bound or 0) * 25 / 100
    assert _view_row_count(path) == before


async def test_empty_open_turn_proceeds_to_ok_preview(store: TempStore) -> None:
    """empty open turn proceeds to ok preview"""
    path = store.thread_path()
    local_sdk = init_lhc(
        SdkConfig(mode="manual", inference_callbacks=create_deterministic_inference_callbacks())
    )
    created = await local_sdk.threads.new_thread(
        {"filePath": path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(created.error.reason)

    preview = await local_sdk.thread_view.preview_compact(
        {"filePath": path}, CompactOpts(params=TARGET_PARAMS)
    )
    assert preview.ok is True
    if not preview.ok:
        return
    assert preview.value.kind == "ok"
    assert isinstance(preview.value, PreviewCompactOk)
    assert preview.value.preview.compact_point == 0
    assert preview.value.preview.would_produce_bands is False


async def test_compact_receipt_carries_renderedbands_and_firstkeptmessageid(store: TempStore) -> None:
    """compact receipt carries renderedBands and firstKeptMessageId"""
    local = await derived_thread_fixture(store)
    compact = await local.sdk.thread_view.compact(
        {"filePath": local.file_path}, CompactOpts(params=GRADIENT_PARAMS)
    )
    assert compact.ok is True
    if not compact.ok:
        return
    assert len(compact.value.rendered_bands) > 0
    assert len(compact.value.rendered_bands[0].text) > 0
    assert compact.value.first_kept_message_id is not None
    assert re.match(r"^m\d+$", compact.value.first_kept_message_id)
    for band in compact.value.rendered_bands:
        stored = compact.value.bands[band.band]
        assert stored.entries > 0
        assert len(band.text) > 0


async def test_background_mode_preview_does_not_schedule_drain_with_pending_work(
    store: TempStore,
) -> None:
    """background mode preview does not schedule drain with pending work"""
    sdk = init_lhc(
        SdkConfig(mode="background", inference_callbacks=create_inference_callbacks_double())
    )
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(
        {"filePath": file_path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(created.error.reason)
    thread_id = created.value.thread_id

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path}, event_batch(["user_prompt"])
    )
    assert captured.ok is True
    assert _live_count(file_path) > 0

    passes_before = sdk.scheduler.test_pass_count(thread_id)
    preview = await sdk.thread_view.preview_compact(
        {"filePath": file_path}, CompactOpts(params=ALL_FITS_PARAMS)
    )
    assert preview.ok is True
    assert sdk.scheduler.test_pass_count(thread_id) == passes_before
    assert _live_count(file_path) > 0
