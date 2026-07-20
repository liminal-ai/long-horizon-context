"""Ported from packages/lhc/test/fixtures/view-thread.ts. Phase 1 skeleton.

The Epic 03 derived-thread fixture (Story 0, FC-0.3/0.4/0.5): one recorded
conversation — 12 turns, 4 chunks, tool-heavy middle — drained through the
real Epic 02 machinery. Types/constants are REAL; SDK-calling builders are
skeletons.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from lhc.intake_stream import MessageEventInput
from lhc.messages import MutationResult
from lhc.sdk import Lhc
from lhc.shared_tech.derivation import ChunkPolicyConfig, DerivationReportEntry
from lhc.shared_tech.view import CompactReceipt

from .inference_callbacks_double import InferenceCallbacksDouble
from .threads import ChunkSnapshot

if TYPE_CHECKING:
    from . import TempStore

# Reason classes the scripted failures stamp, chosen from the sweep
# classification table's vocabulary (tech design §Spec Validation): a
# rate-limit class reads transient, a content-refusal class reads permanent —
# FC-0.4's distinguishable-on-read-back guarantee, proven here before
# Story 3 depends on it.
RATE_LIMIT_FAILURE_REASON = "rate_limit: scripted failure (fixture)"
PERMANENT_FAILURE_REASON = "content_refusal: scripted permanent failure (fixture)"

# Chunk policy pinned so the 12 fixed-shape turns cut into exactly 4 chunks
# (3 members each; c1–c3 closed, c4 still open). Projections from the
# deterministic double are near-constant in size (`projection(<digest>:<40
# chars>)`), so the cut is stable; the builder asserts the shape and throws
# if drift ever moves it.
_FIXTURE_CHUNK_POLICY = ChunkPolicyConfig(
    target_projected_tokens=90,
    max_projected_tokens=4400,
)

_TURN_COUNT = 12
_TOOL_HEAVY_TURNS = frozenset({5, 6, 7, 8})


def _turn_events(turn: int) -> list[MessageEventInput]:
    from . import valid_event

    events: list[MessageEventInput] = [
        valid_event(
            "user_prompt",
            {"payload": {"text": f"turn {turn}: please investigate area {turn}"}},
        ),
        valid_event(
            "assistant_thinking",
            {"payload": {"text": f"considering what area {turn} contains"}},
        ),
    ]
    if turn in _TOOL_HEAVY_TURNS:
        # The tool-heavy middle: two tool runs per turn — what gives Story 4 a
        # realistic over-max zone of tool results to age behind the boundary.
        for run in (1, 2):
            tool_call_id = f"call-fx-{turn}-{run}"
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
            valid_event(
                "assistant_text",
                {"payload": {"text": f"findings for area {turn}"}},
            ),
            valid_event("turn_end"),
        ]
    )
    return events


async def _send(
    sdk: Lhc,
    file_path: str,
    batch: Sequence[MessageEventInput],
) -> list[str]:
    raise NotImplementedError


async def _drain(sdk: Lhc, file_path: str) -> None:
    raise NotImplementedError


def _failed_entries(
    entries: Sequence[DerivationReportEntry],
    reason: str,
) -> list[DerivationReportEntry]:
    return [entry for entry in entries if entry.state == "failed" and entry.reason == reason]


def _set_message_derivation_failed(file_path: str, subject_id: str, reason: str) -> None:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class DerivedThreadFixture:
    file_path: str
    sdk: Lhc
    double: InferenceCallbacksDouble
    turn_ids: list[str]  # t1..t12
    chunks: ChunkSnapshot
    # The two manufactured failed subjects (tool_result_summary forms), reached
    # through real terminal failure — absent when failures
    # are disabled for a variant.
    failed_transient_message_id: str | None = None
    failed_permanent_message_id: str | None = None


@dataclass(frozen=True, slots=True)
class DerivedThreadOptions:
    failures: bool = True  # default true: manufacture the two failed states


@dataclass(frozen=True, slots=True)
class MutationInFlightFixture:
    file_path: str
    sdk: Lhc
    double: InferenceCallbacksDouble
    turn_ids: list[str]
    chunks: ChunkSnapshot
    compact_receipt: CompactReceipt
    edited_message_id: str
    # The cascade contract's exact account of the edit: cleared set, queued
    # replacements, superseded items — what the bracketing health reads
    # assert against.
    mutation: MutationResult
    failed_transient_message_id: str | None = None
    failed_permanent_message_id: str | None = None


@dataclass(frozen=True, slots=True)
class MixedStateFixture:
    file_path: str
    sdk: Lhc
    double: InferenceCallbacksDouble
    turn_ids: list[str]
    chunks: ChunkSnapshot
    blocked_turn_id: str  # t13: turn forms blocked through the terminal path
    pending_prompt_message_id: str  # t14's prompt: smoothed_prompt still queued
    failed_transient_message_id: str | None = None
    failed_permanent_message_id: str | None = None


# TS returns anonymous `{ filePath; sdk }` / `{ filePath; sdk; blockedTurnId }`.
@dataclass(frozen=True, slots=True)
class _CorruptedVariantResult:
    file_path: str
    sdk: Lhc


@dataclass(frozen=True, slots=True)
class _BlockedSiblingResult:
    file_path: str
    sdk: Lhc
    blocked_turn_id: str


async def derived_thread_fixture(
    store: TempStore,
    opts: DerivedThreadOptions | None = None,
) -> DerivedThreadFixture:
    raise NotImplementedError


# The canonical-corruption variant (FC-0.5, Epic 01 fixture pattern): a
# short real conversation, drained clean, then damaged below the SDK into
# the two-open-turns state no public operation can produce. Canonical
# consumers refuse it with state_corruption.
async def corrupted_variant_thread(store: TempStore) -> _CorruptedVariantResult:
    raise NotImplementedError


# ── Epic 04 Story 2 extensions (test plan: fixture extended in place) ──


async def mutation_in_flight_variant(store: TempStore) -> MutationInFlightFixture:
    raise NotImplementedError


async def mixed_state_variant_thread(store: TempStore) -> MixedStateFixture:
    raise NotImplementedError


# The blocked state's sacrificial sibling (FC-0.3): a closed turn whose
# queued derivation meets real source damage at drain time — the handler
# finds two open turns and lands the turn forms blocked through the
# production terminal path, never a hand-written row.
async def blocked_sibling_thread(store: TempStore) -> _BlockedSiblingResult:
    raise NotImplementedError


__all__ = [
    "PERMANENT_FAILURE_REASON",
    "RATE_LIMIT_FAILURE_REASON",
    "DerivedThreadFixture",
    "DerivedThreadOptions",
    "MixedStateFixture",
    "MutationInFlightFixture",
    "blocked_sibling_thread",
    "corrupted_variant_thread",
    "derived_thread_fixture",
    "mixed_state_variant_thread",
    "mutation_in_flight_variant",
]
