"""Ported from packages/lhc/src/thread-view/internal/render.ts. Phase 1 skeleton.

Tail and band formatting: the tail mapping table, short/full tool-result
selection by boundary position, and the deterministic at-or-behind-boundary
truncation rule. Pure functions over read state by design: no DB handle, no
inference, no clock.

The band-entry side includes degrade ladders, gap entries as the last rung,
the [degraded: ...] and [inter-turn note] markers, and band-text assembly.
select.ts consumes the same entry renderer to price
entries during the fill walk, so the tokens the walk budgets are the tokens
the band stores: one renderer, no drift.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, Union

from ...shared_tech.tool_result_rendering import FALLBACK_TRUNCATION_LIMIT, truncate_for_fallback
from ...shared_tech.view import Band
from .snapshot import TailMessageRow

# Deterministic abbreviation: a fixed prefix plus an exact tail marker, a pure
# function of the input string alone. Restated here, byte-identical to
# turns/internal/compose.ts's truncateForFallback, because cross-domain
# internals may not be imported. TS imports truncateForFallback from shared-tech;
# Phase 2 bodies call it via deterministic_truncation.
ABBREVIATION_LIMIT = FALLBACK_TRUNCATION_LIMIT

_ = truncate_for_fallback


@dataclass(frozen=True, slots=True)
class AssembledContextMessage:
    role: Literal["user", "assistant"]
    content: str
    band: Band | None = None


def deterministic_truncation(text: str) -> str:
    raise NotImplementedError


def _block_content(message: TailMessageRow) -> dict[str, object]:
    raise NotImplementedError


def _text_of(message: TailMessageRow) -> str:
    raise NotImplementedError


# What the tail renderer needs beyond the message itself: the boundary
# position (short/full selection) and the call-id → tool-name pairing
# (results carry only their call id).
@dataclass(frozen=True, slots=True)
class TailRenderContext:
    boundary_position: int
    tool_name_by_call_id: Mapping[str, str]


# The call-id → tool-name map from the messages in hand. Pairing within the
# tail is structurally sufficient: the compact point snaps to a turn start,
# so a tail result's call is never behind it.
def tool_names_by_call_id(messages: Sequence[TailMessageRow]) -> dict[str, str]:
    raise NotImplementedError


def _render_tool_call(message: TailMessageRow) -> AssembledContextMessage:
    raise NotImplementedError


def _tool_result_raw_content(message: TailMessageRow) -> str:
    raise NotImplementedError


# Tool-result body for session loading: full ahead of the boundary, truncated at-or-behind.
def tool_result_session_content(message: TailMessageRow, ctx: TailRenderContext) -> str:
    raise NotImplementedError


def _render_tool_result(message: TailMessageRow, ctx: TailRenderContext) -> AssembledContextMessage:
    raise NotImplementedError


# One tail message → one assembled message per the mapping table. Each kind is its
# own arm so a single kind's drift fails its own named test leg.
def render_tail_message(message: TailMessageRow, ctx: TailRenderContext) -> AssembledContextMessage:
    raise NotImplementedError


# One non-empty band to one labeled `user` message: band-marker header, then
# the snapshot bytes verbatim. Inference APIs reject unknown roles.
def render_band_message(band: Band, rendered_text: str) -> AssembledContextMessage:
    raise NotImplementedError


# ── band entries: degrade ladders, gaps, keys ────────────────────


# One derivation's stored state as the ladder reads it (a read shape for
# Derivation: the resolvers never write, never re-derive).
@dataclass(frozen=True, slots=True)
class DerivationSnapshot:
    state: Literal["pending", "ready", "failed", "blocked"]
    content: str | None = None
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class CompactChunkMaterialReady:
    content: str
    kind: Literal["ready"] = "ready"


@dataclass(frozen=True, slots=True)
class CompactChunkMaterialConcat:
    content: str
    reason: str
    kind: Literal["concat"] = "concat"


CompactChunkMaterialSnapshot = Union[CompactChunkMaterialReady, CompactChunkMaterialConcat]

DerivationLookup = Callable[[str, str], DerivationSnapshot | None]


# A subject's resolved representation: which rung of its ladder renders.
# `derivation_used` is the arrangement/receipt vocabulary; `degraded_marker` is the
# rendered [degraded: …] text for fallback rungs.
@dataclass(frozen=True, slots=True)
class ResolvedRepresentation:
    derivation_used: str
    body: str
    degraded: bool
    gap: bool
    degraded_marker: str | None = None
    reason: str | None = None


def _usable(derivation: DerivationSnapshot | None) -> bool:
    raise NotImplementedError


def _ladder_state(derivation: DerivationSnapshot | None) -> str:
    raise NotImplementedError


# Smooth (turn) ladder: turn_rendering → detailed_turn_compression →
# deterministic excerpt of the turn's live messages → gap entry.
def resolve_smooth_representation(
    turn_id: str,
    lookup: DerivationLookup,
    excerpt: str | None,
) -> ResolvedRepresentation:
    raise NotImplementedError


# Detailed (chunk) ladder: chunk_summary_detailed → chunk_summary_brief →
# concatenated member smooth compressions (truncated, marked) → gap entry.
def resolve_detailed_representation(
    chunk_id: str,
    lookup: DerivationLookup,
    material: CompactChunkMaterialSnapshot | None = None,
) -> ResolvedRepresentation:
    raise NotImplementedError


# Brief (chunk) ladder: chunk_summary_brief → chunk_summary_detailed
# truncated → gap entry (no compression rung in this band's ladder).
def resolve_brief_representation(
    chunk_id: str,
    lookup: DerivationLookup,
    material: CompactChunkMaterialSnapshot | None = None,
) -> ResolvedRepresentation:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _ExcerptBlock:
    """TS inline `{ blockType: string; content: Record<string, unknown> }`."""

    block_type: str
    content: dict[str, object]


# The per-message line an excerpt or note renders — a compact, deterministic
# excerpt of the raw record (last-rung fallback, not the tail mapping).
def excerpt_line(kind: str, blocks: Sequence[_ExcerptBlock]) -> str:
    raise NotImplementedError


# One selected subject → its band-entry text: any attached inter-turn notes
# (rule 6: rendered raw with the marker, immediately before the entry), then
# the representation body, [degraded: …] when a fallback rung rendered, or the
# gap line as the last rung. select.ts prices exactly this text in the fill
# walk; the band stores exactly this text.
def render_arrangement_entry(
    subject_kind: Literal["turn", "chunk"],
    _subject_id: str,
    rep: ResolvedRepresentation,
    note_texts: Sequence[str],
) -> str:
    raise NotImplementedError


# A band's snapshot bytes: its entries oldest-first, blank-line separated.
def assemble_band_text(entry_texts: Sequence[str]) -> str:
    raise NotImplementedError
