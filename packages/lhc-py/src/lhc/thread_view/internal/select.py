"""Ported from packages/lhc/src/thread-view/internal/select.ts. Phase 1 skeleton.

Band selection: compact point, smooth/detailed/brief fills, unchunked turns,
the coverage edge (covered_from), and
canonical-corruption detection. Two halves, deliberately split:

  - readSelectionInputs: the record/derivation reads, with the corruption check
    in the reads, before any transaction opens. A refusal here means nothing
    was written, so the prior view is trivially intact. Never moved inside
    the transaction.
  - selectArrangement: a pure function over those inputs. No DB handle, no
    clock, no inference: same inputs, same arrangement.

Tie-breakers: inclusion thresholds are <=; walks are newest-first everywhere;
chunk coverage is decided by the chunk's newest
member turn. Entry costs are the tokens of the rendered entry text itself,
so the budgeted tokens are the stored tokens — no second estimate.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ...shared_tech.storage import Database
from ...shared_tech.view import Band, ViewProfilePercentages
from .render import CompactChunkMaterialSnapshot, DerivationSnapshot

# Canonical source state needed to identify or read the compacted span is
# damaged: compact refuses with state_corruption. Derived-material damage never
# raises this; it degrades through the ladders instead.


class CanonicalCorruptionError(Exception):
    code: Literal["turn_state_corrupt", "source_damaged"]

    def __init__(self, code: Literal["turn_state_corrupt", "source_damaged"], reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.name = "CanonicalCorruptionError"


@dataclass(frozen=True, slots=True)
class SelectionMessage:
    message_id: str
    order: int  # source_event_order
    kind: str
    token_estimate: int
    turn_id: str
    text: str  # excerpt/note line (render.excerptLine)


@dataclass(frozen=True, slots=True)
class SelectionTurn:
    turn_id: str
    turn_order: int
    status: Literal["open", "closed"]
    opened_at: int
    closed_at: int | None


@dataclass(frozen=True, slots=True)
class SelectionChunk:
    chunk_id: str
    chunk_order: int
    status: Literal["open", "closed"]
    member_turn_ids: list[str]  # member order


@dataclass(frozen=True, slots=True)
class SelectionInputs:
    messages: list[SelectionMessage]  # live only, ascending order
    turns: list[SelectionTurn]  # ascending turnOrder
    chunks: list[SelectionChunk]  # ascending chunkOrder
    derivations: dict[str, DerivationSnapshot]  # `${subjectId}/${derivationType}` (turn/chunk subjects)
    max_event_order: int
    derivation_counts: dict[str, dict[str, int]]  # derivation type → state → count
    compact_chunk_materials: dict[str, CompactChunkMaterialSnapshot] | None = None


@dataclass(frozen=True, slots=True)
class ArrangementEntry:
    band: Band
    subject_kind: Literal["turn", "chunk"]
    subject_id: str
    derivation_used: str
    degraded: bool
    gap: bool
    start_order: int  # oldest event order the entry represents (notes included)
    text: str  # rendered entry text (the band stores this verbatim)
    tokens: int
    reason: str | None = None  # gap entries


@dataclass(frozen=True, slots=True)
class SelectionResult:
    compact_point: int
    covered_from: int
    # Gradient order (brief → detailed → smooth), oldest-first within band —
    # the order the bands render and the arrangement persists.
    entries: list[ArrangementEntry]


_SQL_DERIVATION_ROWS = (
    """SELECT subject_id, derivation_type, state, content, reason FROM derivation
       WHERE subject_kind IN ('turn', 'chunk')"""
)

_SQL_MAX_EVENT_ORDER = """SELECT COALESCE(MAX(event_order), 0) AS m FROM event"""

_SQL_DERIVATION_COUNTS = (
    """SELECT derivation_type, state, COUNT(*) AS n FROM derivation GROUP BY derivation_type, state"""
)


# ── reads (corruption check lives here, pre-transaction) ─────────


def read_selection_inputs(db: Database) -> SelectionInputs:
    raise NotImplementedError


# ── the pure walk ─────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class SelectionConfig:
    lower_bound: int
    percentages: ViewProfilePercentages


PiMappableMessageKind = Literal[
    "user_prompt",
    "assistant_text",
    "assistant_thinking",
    "tool_call",
    "tool_result",
    "model_change",
    "thinking_level_change",
]

# Message kinds that can anchor a host session rebuild past the compact point.
# Excludes runtime_note (and any future non-mappable kinds). Shared with the
# first-kept-message lookup in compact-compute so "empty tail" means the same
# thing in both places.
PI_MAPPABLE_MESSAGE_KINDS: tuple[PiMappableMessageKind, ...] = (
    "user_prompt",
    "assistant_text",
    "assistant_thinking",
    "tool_call",
    "tool_result",
    "model_change",
    "thinking_level_change",
)

_PI_MAPPABLE_KIND_SET: frozenset[str] = frozenset(PI_MAPPABLE_MESSAGE_KINDS)


def _straddling_turn_stays_in_full(
    full_side_tokens: int,
    turn_tokens: int,
    eviction_would_empty_full: bool,
) -> bool:
    raise NotImplementedError


def select_arrangement(inputs: SelectionInputs, config: SelectionConfig) -> SelectionResult:
    raise NotImplementedError
