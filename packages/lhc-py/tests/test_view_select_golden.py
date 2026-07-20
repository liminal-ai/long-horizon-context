"""Ported from packages/lhc/test/view-select-golden.test.ts. Phase 1.

Epic 03 Story 2: selection goldens G1–G4 (architecture-risk). Exact
arrangements against committed JSON (tests/goldens/) — NEVER regenerate.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import TypedDict

import pytest
import pytest_asyncio

from fixtures import (
    DerivedThreadFixture,
    TempStore,
    derived_thread_fixture,
    open_raw,
    temp_store,
)
from lhc.thread_view import CompactOpts
from lhc.shared_tech.view import PartialViewProfilePercentages, ViewCompactParams

_GOLDENS_DIR = Path(__file__).resolve().parent / "goldens"


class _GoldenArrangementEntry(TypedDict):
    band: str
    subjectKind: str
    subjectId: str
    derivationUsed: str
    degraded: bool


class _GoldenGap(TypedDict):
    band: str
    subjectId: str
    reason: str


class _GoldenParams(TypedDict):
    lowerBound: int
    percentages: dict[str, int]


class Golden(TypedDict):
    case: str
    fixture: str
    params: _GoldenParams
    compactPoint: int
    coveredFrom: int
    arrangement: list[_GoldenArrangementEntry]
    gaps: list[_GoldenGap]


class StoredView(TypedDict):
    compactPoint: int
    coveredFrom: int
    arrangement: list[_GoldenArrangementEntry]
    gaps: list[_GoldenGap]


def _load_golden(name: str) -> Golden:
    return json.loads((_GOLDENS_DIR / name).read_text(encoding="utf-8"))


def _read_stored_view(file_path: str) -> StoredView:
    db = open_raw(file_path)
    try:
        row = db.prepare(
            """SELECT compact_point, covered_from, arrangement_json, gaps_json
         FROM thread_view WHERE singleton = 1"""
        ).get()
        if row is None:
            raise RuntimeError("no view row after compact")
        return {
            "compactPoint": int(row["compact_point"]),  # type: ignore[arg-type]
            "coveredFrom": int(row["covered_from"]),  # type: ignore[arg-type]
            "arrangement": json.loads(str(row["arrangement_json"])),
            "gaps": json.loads(str(row["gaps_json"])),
        }
    finally:
        db.close()


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


def _params_of(golden: Golden) -> ViewCompactParams:
    pct = golden["params"]["percentages"]
    return ViewCompactParams(
        lower_bound=golden["params"]["lowerBound"],
        percentages=PartialViewProfilePercentages(
            full=pct["full"],
            smooth=pct["smooth"],
            detailed=pct["detailed"],
            brief=pct["brief"],
        ),
    )


async def _run_golden(fixture: DerivedThreadFixture, golden: Golden) -> StoredView:
    receipt = await fixture.sdk.thread_view.compact(
        {"filePath": fixture.file_path},
        CompactOpts(params=_params_of(golden)),
    )
    assert receipt.ok is True
    if not receipt.ok:
        raise RuntimeError(receipt.error.reason)
    stored = _read_stored_view(fixture.file_path)
    if os.environ.get("GOLDEN_DUMP") == "1":
        print(f"{golden['case']}\n{json.dumps(stored, indent=2)}")
    # Receipt and stored row agree (one selection, two reports).
    assert receipt.value.compact_point == stored["compactPoint"]
    assert receipt.value.covered_from == stored["coveredFrom"]
    return stored


def _expect_matches(stored: StoredView, golden: Golden) -> None:
    assert stored["compactPoint"] == golden["compactPoint"]
    assert stored["coveredFrom"] == golden["coveredFrom"]
    assert stored["arrangement"] == golden["arrangement"]
    assert stored["gaps"] == golden["gaps"]


async def test_g1_proportions_shares_fill_the_full_gradient_as_committed(
    fixture: DerivedThreadFixture,
) -> None:
    """G1 proportions: shares fill the full gradient as committed"""
    golden = _load_golden("g1-proportions.json")
    _expect_matches(await _run_golden(fixture, golden), golden)


async def test_g2a_budget_edge_a_turn_exactly_filling_the_smooth_remainder_is_included(
    fixture: DerivedThreadFixture,
) -> None:
    """G2a budget edge: a turn exactly filling the smooth remainder is included (≤ rule)"""
    golden = _load_golden("g2-edge-inclusion.json")
    _expect_matches(await _run_golden(fixture, golden), golden)


async def test_g2b_budget_edge_one_token_under_the_exact_fill_excludes_the_turn(
    fixture: DerivedThreadFixture,
) -> None:
    """G2b budget edge: one token under the exact fill excludes the turn and stops the band"""
    golden = _load_golden("g2-edge-exclusion.json")
    _expect_matches(await _run_golden(fixture, golden), golden)


async def test_g3_oversized_loner_a_single_turn_larger_than_the_whole_smooth_budget(
    fixture: DerivedThreadFixture,
) -> None:
    """G3 oversized loner: a single turn larger than the whole smooth budget represents alone"""
    golden = _load_golden("g3-oversized-loner.json")
    stored = await _run_golden(fixture, golden)
    _expect_matches(stored, golden)
    # The loner condition itself: exactly one non-gap smooth entry, and the
    # smooth budget (250 × 4% = 10) is smaller than any turn entry could
    # render. Coverage gaps are added after the budget fill.
    assert (
        len(
            [
                entry
                for entry in stored["arrangement"]
                if entry["band"] == "smooth" and entry["derivationUsed"] != "gap"
            ]
        )
        == 1
    )
