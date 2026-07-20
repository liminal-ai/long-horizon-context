"""Ported from packages/lhc/test/view-compact-full-boundary.test.ts. Phase 1.

Compact full-band boundary rounding.
"""

from __future__ import annotations

import pytest

from lhc import Lhc, create_deterministic_inference_callbacks, init_lhc
from lhc.shared_tech.derivation import SdkConfig
from lhc.shared_tech.view import (
    PartialViewProfilePercentages,
    PreviewCompactOk,
    PreviewCompactResult,
    ViewCompactParams,
    ViewProfilePercentages,
)
from lhc.thread_view import CompactOpts
from lhc.thread_view.internal.select import (
    SelectionConfig,
    SelectionInputs,
    SelectionMessage,
    SelectionTurn,
    select_arrangement,
)
from fixtures import TempStore, open_raw, temp_store, valid_event

_store: TempStore | None = None


@pytest.fixture(scope="module")
def store() -> TempStore:
    global _store
    s = temp_store()
    _store = s
    yield s
    s.cleanup()
    _store = None


_EMPTY_DERIVATION_COUNTS: dict[str, dict[str, int]] = {}


def _selection_inputs(
    turns: list[SelectionTurn],
    messages: list[SelectionMessage],
) -> SelectionInputs:
    return SelectionInputs(
        turns=turns,
        messages=messages,
        chunks=[],
        derivations={},
        max_event_order=max(
            (turn.closed_at if turn.closed_at is not None else turn.opened_at for turn in turns),
            default=0,
        ),
        derivation_counts=_EMPTY_DERIVATION_COUNTS,
    )


def _msg(
    message_id: str,
    order: int,
    token_estimate: int,
    turn_id: str,
    kind: str = "assistant_text",
) -> SelectionMessage:
    return SelectionMessage(
        message_id=message_id,
        order=order,
        kind=kind,
        token_estimate=token_estimate,
        turn_id=turn_id,
        text=message_id,
    )


_MID_THREAD_TURNS: list[SelectionTurn] = [
    SelectionTurn(turn_id="t1", turn_order=1, status="closed", opened_at=1, closed_at=3),
    SelectionTurn(turn_id="t2", turn_order=2, status="closed", opened_at=4, closed_at=7),
    SelectionTurn(turn_id="t3", turn_order=3, status="closed", opened_at=8, closed_at=9),
    SelectionTurn(turn_id="t4", turn_order=4, status="open", opened_at=10, closed_at=None),
]

_MID_THREAD_MESSAGES: list[SelectionMessage] = [
    _msg("m1", 1, 10, "t1"),
    _msg("m2-old", 4, 40, "t2"),
    _msg("m2-mid", 5, 30, "t2"),
    _msg("m2-new", 6, 30, "t2"),
    _msg("m3", 8, 20, "t3"),
]


def _compact_point_at(full_budget: int) -> int:
    return select_arrangement(
        _selection_inputs(_MID_THREAD_TURNS, _MID_THREAD_MESSAGES),
        SelectionConfig(
            lower_bound=full_budget,
            percentages=ViewProfilePercentages(full=100, smooth=0, detailed=0, brief=0),
        ),
    ).compact_point


async def _new_sdk(store: TempStore) -> tuple[Lhc, str]:
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


def _ok_preview(result) -> PreviewCompactResult:
    assert result.ok is True
    if not result.ok:
        raise RuntimeError(result.error.reason)
    assert result.value.kind == "ok"
    if not isinstance(result.value, PreviewCompactOk):
        raise RuntimeError(getattr(result.value, "reason", "expected ok preview"))
    return result.value.preview


async def _oversized_final_turn(store: TempStore, remove_open_turn: bool) -> PreviewCompactResult:
    sdk, file_path = await _new_sdk(store)
    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "small first turn"}}),
            valid_event("assistant_text", {"payload": {"text": "done"}}),
            valid_event("turn_end"),
            valid_event("user_prompt", {"payload": {"text": "large final turn"}}),
            valid_event("assistant_text", {"payload": {"text": "oversized " * 1000}}),
            valid_event("turn_end"),
        ],
    )
    if not captured.ok:
        raise RuntimeError(captured.error.reason)

    if remove_open_turn:
        db = open_raw(file_path)
        try:
            db.prepare("DELETE FROM turns WHERE status = 'open'").run()
        finally:
            db.close()

    return _ok_preview(
        await sdk.thread_view.preview_compact(
            {"filePath": file_path},
            CompactOpts(
                params=ViewCompactParams(
                    lower_bound=120,
                    percentages=PartialViewProfilePercentages(
                        full=25, smooth=25, detailed=25, brief=25
                    ),
                )
            ),
        )
    )


async def test_keeps_an_oversized_newest_closed_turn_ahead_of_an_empty_open_turn(
    store: TempStore,
) -> None:
    """keeps an oversized newest closed turn ahead of an empty open turn"""
    preview = await _oversized_final_turn(store, False)
    assert preview.compact_point == 3
    assert preview.first_kept_message_id == "m4"


async def test_keeps_an_oversized_newest_closed_turn_when_there_is_no_open_turn(
    store: TempStore,
) -> None:
    """keeps an oversized newest closed turn when there is no open turn"""
    preview = await _oversized_final_turn(store, True)
    assert preview.compact_point == 3
    assert preview.first_kept_message_id == "m4"


def test_keeps_a_mid_thread_straddling_turn_when_most_of_its_tokens_are_on_the_full_side() -> None:
    """keeps a mid-thread straddling turn when most of its tokens are on the full side"""
    assert _compact_point_at(80) == 3


def test_evicts_a_mid_thread_straddling_turn_when_most_of_its_tokens_are_on_the_smooth_side() -> None:
    """evicts a mid-thread straddling turn when most of its tokens are on the smooth side"""
    assert _compact_point_at(60) == 7


def test_keeps_a_mid_thread_straddling_turn_on_an_exact_50_50_split() -> None:
    """keeps a mid-thread straddling turn on an exact 50/50 split"""
    assert _compact_point_at(70) == 3


def test_keeps_an_exactly_covered_closed_turn_in_full() -> None:
    """keeps an exactly-covered closed turn in full"""
    assert _compact_point_at(120) == 3


def test_starts_the_tail_at_an_open_turn_even_when_the_budget_crosses_inside_it() -> None:
    """starts the tail at an open turn even when the budget crosses inside it"""
    turns = [
        SelectionTurn(turn_id="t1", turn_order=1, status="closed", opened_at=1, closed_at=3),
        SelectionTurn(turn_id="t2", turn_order=2, status="closed", opened_at=4, closed_at=6),
        SelectionTurn(turn_id="t3", turn_order=3, status="open", opened_at=7, closed_at=None),
    ]
    messages = [
        _msg("m1", 1, 10, "t1"),
        _msg("m2", 4, 10, "t2"),
        _msg("m3-old", 7, 25, "t3"),
        _msg("m3-mid", 8, 25, "t3"),
        _msg("m3-new", 9, 25, "t3"),
    ]
    selection = select_arrangement(
        _selection_inputs(turns, messages),
        SelectionConfig(
            lower_bound=40,
            percentages=ViewProfilePercentages(full=100, smooth=0, detailed=0, brief=0),
        ),
    )
    assert selection.compact_point == 6


def test_treats_a_runtime_note_only_post_eviction_tail_as_empty_and_keeps_the_straddling_turn() -> None:
    """treats a runtime_note-only post-eviction tail as empty and keeps the straddling turn"""
    # Same mid-thread token layout as compactPointAt(60) (would evict t2 on
    # token split alone), but the only newer message is a runtime_note — not
    # mappable, so the emptiness override keeps t2 in full.
    turns = [
        SelectionTurn(turn_id="t1", turn_order=1, status="closed", opened_at=1, closed_at=3),
        SelectionTurn(turn_id="t2", turn_order=2, status="closed", opened_at=4, closed_at=7),
        SelectionTurn(turn_id="t3", turn_order=3, status="open", opened_at=8, closed_at=None),
    ]
    messages = [
        _msg("m1", 1, 10, "t1"),
        _msg("m2-old", 4, 40, "t2"),
        _msg("m2-mid", 5, 30, "t2"),
        _msg("m2-new", 6, 30, "t2"),
        _msg("m-note", 8, 20, "t3", "runtime_note"),
    ]
    selection = select_arrangement(
        _selection_inputs(turns, messages),
        SelectionConfig(
            lower_bound=60,
            percentages=ViewProfilePercentages(full=100, smooth=0, detailed=0, brief=0),
        ),
    )
    assert selection.compact_point == 3


async def test_runtime_note_only_tail_keeps_straddling_turn_preview_anchor_is_non_null(
    store: TempStore,
) -> None:
    """runtime_note-only tail keeps straddling turn; preview anchor is non-null"""
    sdk, file_path = await _new_sdk(store)
    # t1 small, t2 oversized (token-split would want eviction), open turn holds
    # only a runtime_note — not mappable, so emptiness override keeps t2 in full.
    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "small first turn"}}),
            valid_event("assistant_text", {"payload": {"text": "done"}}),
            valid_event("turn_end"),
            valid_event("user_prompt", {"payload": {"text": "large final turn"}}),
            valid_event("assistant_text", {"payload": {"text": "oversized " * 1000}}),
            valid_event("turn_end"),
            valid_event("runtime_note", {"payload": {"text": "harness note only"}}),
        ],
    )
    if not captured.ok:
        raise RuntimeError(captured.error.reason)

    preview = _ok_preview(
        await sdk.thread_view.preview_compact(
            {"filePath": file_path},
            CompactOpts(
                params=ViewCompactParams(
                    lower_bound=120,
                    percentages=PartialViewProfilePercentages(
                        full=25, smooth=25, detailed=25, brief=25
                    ),
                )
            ),
        )
    )

    # Override keeps t2 in full (compact point at t1 close); anchor is t2's
    # first mappable message — never null solely because of a runtime_note tail.
    assert preview.compact_point == 3
    assert preview.first_kept_message_id == "m4"
    assert preview.first_kept_message_id is not None
