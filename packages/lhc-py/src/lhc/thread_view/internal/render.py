"""Ported from packages/lhc/src/thread-view/internal/render.ts.

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

from ...shared_tech._jsstr import js_json_dumps
from ...shared_tech.tool_result_rendering import FALLBACK_TRUNCATION_LIMIT, truncate_for_fallback
from ...shared_tech.view import Band
from .snapshot import TailMessageRow

# Deterministic abbreviation: a fixed prefix plus an exact tail marker, a pure
# function of the input string alone. Restated here, byte-identical to
# turns/internal/compose.ts's truncateForFallback, because cross-domain
# internals may not be imported. TS imports truncateForFallback from shared-tech;
# Phase 2 bodies call it via deterministic_truncation.
ABBREVIATION_LIMIT = FALLBACK_TRUNCATION_LIMIT


@dataclass(frozen=True, slots=True)
class AssembledContextMessage:
    role: Literal["user", "assistant"]
    content: str
    band: Band | None = None


def deterministic_truncation(text: str) -> str:
    return truncate_for_fallback(text)


def _block_content(message: TailMessageRow) -> dict[str, object]:
    if not message.blocks:
        return {}
    return message.blocks[0].content


def _text_of(message: TailMessageRow) -> str:
    text = _block_content(message).get("text")
    return text if isinstance(text, str) else ""


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
    names: dict[str, str] = {}
    for message in messages:
        if message.kind != "tool_call":
            continue
        block = _block_content(message)
        call_id = block.get("toolCallId")
        tool_name = block.get("toolName")
        if isinstance(call_id, str) and isinstance(tool_name, str):
            names[call_id] = tool_name
    return names


def _render_tool_call(message: TailMessageRow) -> AssembledContextMessage:
    block = _block_content(message)
    name_val = block.get("toolName")
    name = name_val if isinstance(name_val, str) else "unknown_tool"
    args = block.get("arguments")
    if args is None:
        args = {}
    serialized = js_json_dumps(args)
    return AssembledContextMessage(
        role="assistant",
        content=f"[tool call · {name}] {serialized}",
    )


def _tool_result_raw_content(message: TailMessageRow) -> str:
    content = _block_content(message).get("content")
    return content if isinstance(content, str) else ""


# Tool-result body for session loading: full ahead of the boundary, truncated at-or-behind.
def tool_result_session_content(message: TailMessageRow, ctx: TailRenderContext) -> str:
    content = _tool_result_raw_content(message)
    if message.source_event_order > ctx.boundary_position:
        return content
    return deterministic_truncation(content)


def _render_tool_result(message: TailMessageRow, ctx: TailRenderContext) -> AssembledContextMessage:
    block = _block_content(message)
    call_id = block.get("toolCallId")
    if isinstance(call_id, str):
        name = ctx.tool_name_by_call_id.get(call_id)
    else:
        name = None
    if name is None:
        name = "unknown_tool"
    if message.source_event_order > ctx.boundary_position:
        return AssembledContextMessage(
            role="user",
            content=f"[tool result · {name}]\n{_tool_result_raw_content(message)}",
        )
    short = deterministic_truncation(_tool_result_raw_content(message))
    return AssembledContextMessage(
        role="user",
        content=f"[tool result · {name} · abridged]\n{short}",
    )


# One tail message → one assembled message per the mapping table. Each kind is its
# own arm so a single kind's drift fails its own named test leg.
def render_tail_message(message: TailMessageRow, ctx: TailRenderContext) -> AssembledContextMessage:
    kind = message.kind
    if kind == "user_prompt":
        return AssembledContextMessage(role="user", content=_text_of(message))
    if kind == "assistant_text":
        return AssembledContextMessage(role="assistant", content=_text_of(message))
    if kind == "assistant_thinking":
        # Included: the tail is full fidelity (bands compress thinking away for
        # older turns); harness-side conversion may re-block or drop.
        return AssembledContextMessage(
            role="assistant",
            content=f"[thinking]\n{_text_of(message)}\n[/thinking]",
        )
    if kind == "tool_call":
        return _render_tool_call(message)
    if kind == "tool_result":
        return _render_tool_result(message, ctx)
    if kind == "runtime_note":
        return AssembledContextMessage(
            role="user",
            content=f"[runtime note] {_text_of(message)}",
        )
    if kind == "model_change":
        block = message.blocks[0].content if message.blocks else {}
        previous = block.get("previousModel")
        new = block.get("newModel")
        return AssembledContextMessage(
            role="user",
            content=(
                f"[model change] {'' if previous is None else str(previous)}"
                f" -> {'' if new is None else str(new)}"
            ),
        )
    if kind == "thinking_level_change":
        block = message.blocks[0].content if message.blocks else {}
        previous = block.get("previousLevel")
        new = block.get("newLevel")
        return AssembledContextMessage(
            role="user",
            content=(
                f"[thinking level change] {'' if previous is None else str(previous)}"
                f" -> {'' if new is None else str(new)}"
            ),
        )
    raise AssertionError(f"unhandled message kind: {kind!r}")


# One non-empty band to one labeled `user` message: band-marker header, then
# the snapshot bytes verbatim. Inference APIs reject unknown roles.
def render_band_message(band: Band, rendered_text: str) -> AssembledContextMessage:
    return AssembledContextMessage(
        role="user",
        band=band,
        content=f"[context · {band}]\n{rendered_text}",
    )


# ── band entries: degrade ladders, gaps, keys ────────────────────


# One derivation's stored state as the ladder reads it (a read shape for
# Derivation: the resolvers never write, never re-derive).
@dataclass(frozen=True, slots=True)
class DerivationSnapshot:
    state: Literal["pending", "ready", "failed", "blocked"]
    content: str | None = None
    reason: str | None = None


# NOMINAL-TYPING BOUNDARY: same shape as turns.internal.chunk_recovery.CompactChunkReady, but a distinct class —
# dataclass __eq__ requires identical type, so Phase 2 must convert
# explicitly at this boundary (or tests comparing across it will fail).
@dataclass(frozen=True, slots=True)
class CompactChunkMaterialReady:
    content: str
    kind: Literal["ready"] = "ready"


# NOMINAL-TYPING BOUNDARY: same shape as turns.internal.chunk_recovery.CompactChunkConcat, but a distinct class —
# dataclass __eq__ requires identical type, so Phase 2 must convert
# explicitly at this boundary (or tests comparing across it will fail).
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
    # "Usable" means state = ready.
    return (
        derivation is not None
        and derivation.state == "ready"
        and isinstance(derivation.content, str)
    )


def _ladder_state(derivation: DerivationSnapshot | None) -> str:
    return "absent" if derivation is None else derivation.state


# Smooth (turn) ladder: turn_rendering → detailed_turn_compression →
# deterministic excerpt of the turn's live messages → gap entry.
def resolve_smooth_representation(
    turn_id: str,
    lookup: DerivationLookup,
    excerpt: str | None,
) -> ResolvedRepresentation:
    rendering = lookup(turn_id, "turn_rendering")
    if _usable(rendering):
        assert rendering is not None and rendering.content is not None
        return ResolvedRepresentation(
            derivation_used="turn_rendering",
            body=rendering.content,
            degraded=False,
            gap=False,
        )
    compression = lookup(turn_id, "detailed_turn_compression")
    if _usable(compression):
        assert compression is not None and compression.content is not None
        return ResolvedRepresentation(
            derivation_used="detailed_turn_compression",
            body=compression.content,
            degraded=True,
            gap=False,
            degraded_marker="smooth-from-compression",
        )
    if excerpt is not None:
        return ResolvedRepresentation(
            derivation_used="message_excerpt",
            body=deterministic_truncation(excerpt),
            degraded=True,
            gap=False,
            degraded_marker="smooth-from-excerpt",
        )
    return ResolvedRepresentation(
        derivation_used="gap",
        body="",
        degraded=False,
        gap=True,
        reason=(
            f"no usable derivation (turn_rendering: {_ladder_state(rendering)}, "
            f"detailed_turn_compression: {_ladder_state(compression)}, no live messages)"
        ),
    )


# Detailed (chunk) ladder: chunk_summary_detailed → chunk_summary_brief →
# concatenated member smooth compressions (truncated, marked) → gap entry.
def resolve_detailed_representation(
    chunk_id: str,
    lookup: DerivationLookup,
    material: CompactChunkMaterialSnapshot | None = None,
) -> ResolvedRepresentation:
    detailed = lookup(chunk_id, "chunk_summary_detailed")
    if _usable(detailed):
        assert detailed is not None and detailed.content is not None
        return ResolvedRepresentation(
            derivation_used="chunk_summary_detailed",
            body=detailed.content,
            degraded=False,
            gap=False,
        )
    if material is not None and material.kind == "ready":
        return ResolvedRepresentation(
            derivation_used="chunk_summary_detailed",
            body=material.content,
            degraded=False,
            gap=False,
        )
    if material is not None and material.kind == "concat":
        return ResolvedRepresentation(
            derivation_used="stored_member_concat",
            body=material.content,
            degraded=True,
            gap=False,
            degraded_marker="detailed-from-stored-members",
            reason=material.reason,
        )
    return ResolvedRepresentation(
        derivation_used="gap",
        body="",
        degraded=False,
        gap=True,
        reason=(
            f"no usable derivation (chunk_summary_detailed: {_ladder_state(detailed)}, "
            f"compact material absent)"
        ),
    )


# Brief (chunk) ladder: chunk_summary_brief → chunk_summary_detailed
# truncated → gap entry (no compression rung in this band's ladder).
def resolve_brief_representation(
    chunk_id: str,
    lookup: DerivationLookup,
    material: CompactChunkMaterialSnapshot | None = None,
) -> ResolvedRepresentation:
    brief = lookup(chunk_id, "chunk_summary_brief")
    if _usable(brief):
        assert brief is not None and brief.content is not None
        return ResolvedRepresentation(
            derivation_used="chunk_summary_brief",
            body=brief.content,
            degraded=False,
            gap=False,
        )
    if material is not None and material.kind == "ready":
        return ResolvedRepresentation(
            derivation_used="chunk_summary_brief",
            body=material.content,
            degraded=False,
            gap=False,
        )
    if material is not None and material.kind == "concat":
        return ResolvedRepresentation(
            derivation_used="stored_member_concat",
            body=material.content,
            degraded=True,
            gap=False,
            degraded_marker="brief-from-stored-members",
            reason=material.reason,
        )
    return ResolvedRepresentation(
        derivation_used="gap",
        body="",
        degraded=False,
        gap=True,
        reason=(
            f"no usable derivation (chunk_summary_brief: {_ladder_state(brief)}, "
            f"compact material absent)"
        ),
    )


@dataclass(frozen=True, slots=True)
class _ExcerptBlock:
    """TS inline `{ blockType: string; content: Record<string, unknown> }`."""

    block_type: str
    content: dict[str, object]


# The per-message line an excerpt or note renders — a compact, deterministic
# excerpt of the raw record (last-rung fallback, not the tail mapping).
def excerpt_line(kind: str, blocks: Sequence[_ExcerptBlock]) -> str:
    content = blocks[0].content if blocks else {}
    text_val = content.get("text")
    text = text_val if isinstance(text_val, str) else ""
    if kind == "tool_call":
        name_val = content.get("toolName")
        name = name_val if isinstance(name_val, str) else "unknown_tool"
        return f"[tool call · {name}]"
    if kind == "tool_result":
        return "[tool result]"
    return text


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
    lines = [f"[inter-turn note] {text}" for text in note_texts]
    if rep.gap:
        reason = "unknown" if rep.reason is None else rep.reason
        lines.append(f"[{subject_kind} unavailable: {reason}]")
    else:
        if rep.degraded:
            marker_name = (
                rep.derivation_used if rep.degraded_marker is None else rep.degraded_marker
            )
            marker = f"[degraded: {marker_name}]\n"
        else:
            marker = ""
        lines.append(f"{marker}{rep.body}")
    return "\n".join(lines)


# A band's snapshot bytes: its entries oldest-first, blank-line separated.
def assemble_band_text(entry_texts: Sequence[str]) -> str:
    return "\n\n".join(entry_texts)
