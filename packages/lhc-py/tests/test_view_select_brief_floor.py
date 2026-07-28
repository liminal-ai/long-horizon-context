"""Ported from packages/lhc/test/view-select-brief-floor.test.ts.

The brief band's two failure defenses, from the production incident where a
chunk whose brief derivation never landed rendered its whole uncompressed
fallback, and the brief walk stopped there — silently dropping every older
chunk although each had a healthy, small brief.

  - the walk: brief is the last band, so an entry that does not fit is
    skipped (recorded as a gap) and the walk continues to older candidates.
  - the floor: a brief that fell back to larger material is capped at 5% of
    the brief band budget (never below 200 tokens) with a terminal marker,
    so the failure costs the band a brief-sized entry, not a body-sized one.

Selection is exercised through select_arrangement directly (pure over its
inputs); the floor is exercised through the ladder resolver it lives in.
"""

from __future__ import annotations

import re

from lhc.shared_tech.token_counting import estimate_tokens
from lhc.shared_tech.view import ViewProfilePercentages
from lhc.thread_view.internal.render import (
    CompactChunkMaterialConcat,
    CompactChunkMaterialSnapshot,
    DerivationSnapshot,
    brief_fallback_cap_tokens,
    resolve_brief_representation,
)
from lhc.thread_view.internal.select import (
    SelectionChunk,
    SelectionConfig,
    SelectionInputs,
    SelectionMessage,
    SelectionResult,
    SelectionTurn,
    select_arrangement,
)

# full 250 (t8 alone), smooth 10 (t7 alone), detailed 40 (c6 alone as an
# oversized loner), brief 700 for the remaining chunks c5…c1.
PARAMS = SelectionConfig(
    lower_bound=1000,
    percentages=ViewProfilePercentages(full=25, smooth=1, detailed=4, brief=70),
)
BRIEF_BUDGET = 700
CHUNK_IDS = ("c1", "c2", "c3", "c4", "c5", "c6")

# ~2251 tokens: more than three times the whole brief band budget, the shape
# of an uncompressed fallback standing in for a failed brief.
OVERSIZED_BODY = "chunk detail line " * 750


# Eight closed turns, one message each; t1…t6 are single-turn chunks, t7 is
# the smooth band's one entry, t8's 500 tokens put the compact point at t7's
# close.
def incident_inputs(
    *,
    brief_override: DerivationSnapshot | None = None,
    brief_material: CompactChunkMaterialSnapshot | None = None,
) -> SelectionInputs:
    turns = [
        SelectionTurn(
            turn_id=f"t{index + 1}",
            turn_order=index + 1,
            status="closed",
            opened_at=index * 10 + 1,
            closed_at=(index + 1) * 10,
        )
        for index in range(8)
    ]
    messages = [
        SelectionMessage(
            message_id=f"m{turn.turn_order}",
            order=turn.opened_at,
            kind="user_prompt",
            token_estimate=500 if turn.turn_id == "t8" else 10,
            turn_id=turn.turn_id,
            text=f"prompt {turn.turn_id}",
        )
        for turn in turns
    ]
    chunks = [
        SelectionChunk(
            chunk_id=chunk_id,
            chunk_order=index + 1,
            status="closed",
            member_turn_ids=[f"t{index + 1}"],
        )
        for index, chunk_id in enumerate(CHUNK_IDS)
    ]

    derivations: dict[str, DerivationSnapshot] = {
        "t7/turn_rendering": DerivationSnapshot(state="ready", content="rendered turn t7"),
    }
    for chunk_id in CHUNK_IDS:
        # Detailed material is deliberately larger than the detailed share, so c6
        # takes that band alone and c5…c1 arrive at brief.
        derivations[f"{chunk_id}/chunk_summary_detailed"] = DerivationSnapshot(
            state="ready",
            content=f"detailed summary line {chunk_id} " * 15,
        )
        derivations[f"{chunk_id}/chunk_summary_brief"] = DerivationSnapshot(
            state="ready",
            content=f"brief summary for chunk {chunk_id}",
        )
    if brief_override is not None:
        derivations["c3/chunk_summary_brief"] = brief_override

    compact_chunk_materials: dict[str, CompactChunkMaterialSnapshot] = {}
    if brief_material is not None:
        compact_chunk_materials["c3/chunk_summary_brief"] = brief_material

    return SelectionInputs(
        messages=messages,
        turns=turns,
        chunks=chunks,
        derivations=derivations,
        compact_chunk_materials=compact_chunk_materials,
        max_event_order=80,
        derivation_counts={},
    )


def brief_subjects(selection: SelectionResult) -> list[str]:
    return [entry.subject_id for entry in selection.entries if entry.band == "brief"]


class TestBriefBandFailedDerivation:
    """brief band: a chunk whose brief derivation failed."""

    def test_capped_to_floor_and_older_healthy_chunks_still_land(self) -> None:
        selection = select_arrangement(
            incident_inputs(
                brief_override=DerivationSnapshot(state="failed", reason="provider timeout"),
                brief_material=CompactChunkMaterialConcat(
                    content=OVERSIZED_BODY, reason="failed_floor"
                ),
            ),
            PARAMS,
        )

        # The incident's regression: c2 and c1 sit behind the bad chunk.
        assert brief_subjects(selection) == ["c1", "c2", "c3", "c4", "c5"]
        assert selection.skipped == []
        assert selection.covered_from == 1  # t1's oldest message

        bad = next(entry for entry in selection.entries if entry.subject_id == "c3")
        assert bad.degraded is True
        assert bad.derivation_used == "stored_member_concat"
        assert re.search(r"\[compression failed: ~\d+ tokens of content truncated\]$", bad.text)
        # Reported post-truncation: the cap plus the ladder's own [degraded: …]
        # line, not the multi-thousand-token body.
        assert estimate_tokens(OVERSIZED_BODY) > 3 * BRIEF_BUDGET
        assert bad.tokens < brief_fallback_cap_tokens(BRIEF_BUDGET) + 20


class TestBriefBandOversizedEntry:
    """brief band: an entry too large for the remaining budget."""

    def test_skipped_with_a_gap_note_while_older_entries_continue(self) -> None:
        # A ready brief is never capped, so this reaches the walk oversized —
        # the walk fix on its own, with the failure floor out of the picture.
        selection = select_arrangement(
            incident_inputs(
                brief_override=DerivationSnapshot(state="ready", content=OVERSIZED_BODY)
            ),
            PARAMS,
        )

        assert brief_subjects(selection) == ["c1", "c2", "c4", "c5"]
        assert selection.covered_from == 1
        assert len(selection.skipped) == 1
        skip = selection.skipped[0]
        assert skip.band == "brief"
        assert skip.subject_id == "c3"
        assert skip.tokens > BRIEF_BUDGET
        assert str(skip.tokens) in skip.reason
        # The skipped chunk's turns are accounted for by the gap note, not
        # answered with unbudgeted detailed material.
        assert [entry for entry in selection.entries if entry.subject_id == "t3"] == []


class TestBriefFailureFloor:
    """brief failure floor."""

    FAILED_BRIEF = DerivationSnapshot(state="failed", reason="provider timeout")

    @staticmethod
    def lookup(_subject_id: str, derivation_type: str) -> DerivationSnapshot | None:
        return (
            TestBriefFailureFloor.FAILED_BRIEF
            if derivation_type == "chunk_summary_brief"
            else None
        )

    @staticmethod
    def fallback(band_budget: float):
        return resolve_brief_representation(
            "c3",
            TestBriefFailureFloor.lookup,
            band_budget,
            CompactChunkMaterialConcat(content=OVERSIZED_BODY, reason="failed_floor"),
        )

    def test_caps_at_five_percent_above_the_floor(self) -> None:
        assert brief_fallback_cap_tokens(8000) == 400
        assert estimate_tokens(self.fallback(8000).body) <= 400
        assert estimate_tokens(self.fallback(8000).body) > 300

    def test_caps_at_200_where_five_percent_falls_below(self) -> None:
        assert brief_fallback_cap_tokens(4000) == 200  # the crossover
        assert brief_fallback_cap_tokens(1000) == 200
        assert estimate_tokens(self.fallback(1000).body) <= 200
        assert estimate_tokens(self.fallback(1000).body) > 150

    def test_marks_the_truncation_with_the_tokens_it_dropped(self) -> None:
        rep = self.fallback(BRIEF_BUDGET)
        marker = re.search(
            r"\[compression failed: ~(\d+) tokens of content truncated\]$", rep.body
        )
        assert marker is not None
        assert int(marker.group(1)) > estimate_tokens(OVERSIZED_BODY) - 250
        assert rep.degraded is True
        assert rep.degraded_marker == "brief-from-stored-members"

    def test_never_truncates_a_ready_brief_however_large(self) -> None:
        def ready(_subject_id: str, derivation_type: str) -> DerivationSnapshot | None:
            if derivation_type == "chunk_summary_brief":
                return DerivationSnapshot(state="ready", content=OVERSIZED_BODY)
            return None

        rep = resolve_brief_representation("c3", ready, 100)
        assert rep.body == OVERSIZED_BODY
        assert rep.degraded is False
        assert rep.derivation_used == "chunk_summary_brief"
