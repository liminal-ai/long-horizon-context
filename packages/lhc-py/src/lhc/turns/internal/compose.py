"""Ported from packages/lhc/src/turns/internal/compose.ts.

Rendering composition: message-level derivations become ordered
RenderingParts for deterministic turn rendering, with fallbacks and gap
records where a derivation is not ready. The function stays pure:
`(messages, derivations) -> { parts, gaps }` with no DB handle, inference,
or clock in the signature.

Tool activity stays in message order and groups into maximal runs. A run
becomes one RenderingPart whose header names tools, call count, and per-call
mechanical outcomes. Prompts and assistant text break a run; thinking and
runtime notes do not. Runs are never reordered.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from ...shared_tech._jsstr import js_json_dumps, js_trim
from ...shared_tech.derivation import (
    DependencyGap,
    DerivationMetadata,
    DerivationState,
    RenderingPart,
    RenderingPartKind,
    ToolOutcome,
    RenderingPartBlock,
)
from ...messages.internal.smoothing import clean_prompt
from ...shared_tech.tool_result_rendering import truncate_for_fallback

# PART_PLANS derivation keys are the durable message-owned derivation names
# composition reads; fallback callables are the private helpers (Phase 2 bodies).
# TS: const PART_PLANS: Record<RenderingPartKind, PartPlan>


@dataclass(frozen=True, slots=True)
class ComposeBlock:
    block_type: str
    content: dict[str, object]


# The member message as the composer sees it: kind plus projected blocks,
# verbatim from the record (already deleted-filtered by the caller's read).
@dataclass(frozen=True, slots=True)
class ComposeMessage:
    message_id: str
    kind: RenderingPartKind
    blocks: list[ComposeBlock]


# One message-owned derivation row as composition input; keyed by the caller as
# `${messageId}/${derivation}`.
@dataclass(frozen=True, slots=True)
class ComposeDerivationRow:
    state: DerivationState
    source_version: int
    content: str | None = None
    metadata: DerivationMetadata | None = None
    reason: str | None = None


def compose_derivation_key(message_id: str, derivation: str) -> str:
    return f"{message_id}/{derivation}"


@dataclass(frozen=True, slots=True)
class RecoveryReceipt:
    subject_kind: Literal["message"]
    subject_id: str
    derivation_type: str
    content: str
    source_version: int
    reason: Literal["not_ready", "failed_floor"]
    floor_used: str


@dataclass(frozen=True, slots=True)
class CompositionInput:
    parts: list[RenderingPart]
    gaps: list[DependencyGap]
    recoveries: list[RecoveryReceipt]


def _text_of(message: ComposeMessage) -> str:
    if not message.blocks:
        return ""
    text = message.blocks[0].content.get("text")
    return text if isinstance(text, str) else ""


def _model_change_text(message: ComposeMessage) -> str:
    block = message.blocks[0].content if message.blocks else {}
    previous = block.get("previousModel")
    next_model = block.get("newModel")
    if isinstance(previous, str) and isinstance(next_model, str):
        return f"model_change {previous} -> {next_model}"
    return "model_change"


def _thinking_level_change_text(message: ComposeMessage) -> str:
    block = message.blocks[0].content if message.blocks else {}
    previous = block.get("previousLevel")
    next_level = block.get("newLevel")
    if isinstance(previous, str) and isinstance(next_level, str):
        return f"thinking_level_change {previous} -> {next_level}"
    return "thinking_level_change"


def _prompt_fallback_text(message: ComposeMessage) -> str:
    original = _text_of(message)
    floor = clean_prompt(original)
    return original if not floor and original else floor


# Mechanical outcome from the record alone: a tool call's outcome comes from
# its paired result among the turn's messages.
def _record_outcomes(messages: Sequence[ComposeMessage]) -> dict[str, bool]:
    result: dict[str, bool] = {}
    for message in messages:
        if message.kind != "tool_result":
            continue
        block = message.blocks[0].content if message.blocks else {}
        call_id = block.get("toolCallId")
        if isinstance(call_id, str):
            result[call_id] = block.get("isError") is True
    return result


def _outcome_from_record(result_by_call_id: Mapping[str, bool], call_id: object) -> ToolOutcome:
    if not isinstance(call_id, str) or call_id not in result_by_call_id:
        return "unknown"
    return "failed" if result_by_call_id[call_id] else "succeeded"


@dataclass(frozen=True, slots=True)
class _PartPlan:
    fallback_text: Callable[[ComposeMessage], str]
    derivation: str | None = None


def _tool_call_fallback_text(message: ComposeMessage) -> str:
    block = message.blocks[0].content if message.blocks else {}
    tool_name = block.get("toolName")
    if not isinstance(tool_name, str):
        tool_name = "unknown_tool"
    arguments = block.get("arguments")
    if arguments is None:
        arguments = {}
    serialized = js_json_dumps(arguments)
    return truncate_for_fallback(f"{tool_name}({serialized})")


def _tool_result_fallback_text(message: ComposeMessage) -> str:
    block = message.blocks[0].content if message.blocks else {}
    content = block.get("content")
    return truncate_for_fallback(content if isinstance(content, str) else "")


_PART_PLANS: dict[RenderingPartKind, _PartPlan] = {
    "user_prompt": _PartPlan(derivation="smoothed_prompt", fallback_text=_prompt_fallback_text),
    "assistant_text": _PartPlan(fallback_text=_text_of),
    "assistant_thinking": _PartPlan(fallback_text=_text_of),
    "runtime_note": _PartPlan(fallback_text=_text_of),
    "model_change": _PartPlan(fallback_text=_model_change_text),
    "thinking_level_change": _PartPlan(fallback_text=_thinking_level_change_text),
    "tool_call": _PartPlan(fallback_text=_tool_call_fallback_text),
    "tool_result": _PartPlan(derivation="tool_result_summary", fallback_text=_tool_result_fallback_text),
}


# One per-message atom before grouping: its composed part plus the structural
# facts the run-grouping reads. Tool atoms fold into runs; prompts and
# assistant text break runs; thinking and runtime notes are transparent —
# interior ones fold into the surrounding run's account, edge ones stand alone.
@dataclass(frozen=True, slots=True)
class _ComposeAtom:
    part: RenderingPart
    is_tool: bool
    is_break: bool  # user_prompt | assistant_text — ends a run
    tool_name: str | None = None  # tool_call only
    tool_call_id: str | None = None  # tool_call | tool_result


_RUN_BREAK_KINDS: frozenset[RenderingPartKind] = frozenset({"user_prompt", "assistant_text"})
_TOOL_KINDS: frozenset[RenderingPartKind] = frozenset({"tool_call", "tool_result"})
_DIALOG_KINDS: frozenset[RenderingPartKind] = frozenset({"user_prompt", "assistant_text"})


@dataclass(frozen=True, slots=True)
class _BuiltAtom:
    atom: _ComposeAtom
    gap: DependencyGap | None = None
    recovery: RecoveryReceipt | None = None


# One message → its composed part (ready derivation verbatim, else raw/truncated
# fallback) plus a gap when a derivable derivation was not ready. Gaps stay
# per-message — precise to the source record — regardless of run grouping
# The caller lands gaps on the rendering and they hold until an explicit
# rebuild recomposes from current states.
def _build_atom(
    message: ComposeMessage,
    derivations: Mapping[str, ComposeDerivationRow],
    result_by_call_id: dict[str, bool],
) -> _BuiltAtom:
    plan = _PART_PLANS[message.kind]
    derivation = (
        None
        if plan.derivation is None
        else derivations.get(compose_derivation_key(message.message_id, plan.derivation))
    )
    ready = (
        derivation is not None
        and derivation.state == "ready"
        and derivation.content is not None
    )
    block = message.blocks[0].content if message.blocks else {}
    blocks = None
    if message.kind in ("model_change", "thinking_level_change"):
        blocks = [
            RenderingPartBlock(block_type=b.block_type, content=b.content)
            for b in message.blocks
        ]
    outcome: ToolOutcome | None = None
    if message.kind == "tool_call":
        if ready and derivation is not None and derivation.metadata is not None:
            outcome = derivation.metadata.outcome
        if outcome is None:
            outcome = _outcome_from_record(result_by_call_id, block.get("toolCallId"))
    elif message.kind == "tool_result":
        if ready and derivation is not None and derivation.metadata is not None:
            outcome = derivation.metadata.outcome
        if outcome is None:
            outcome = "failed" if block.get("isError") is True else "succeeded"
    part = RenderingPart(
        message_id=message.message_id,
        kind=message.kind,
        text=derivation.content if ready and derivation is not None else plan.fallback_text(message),
        fallback=plan.derivation is not None and not ready,
        blocks=blocks,
        outcome=outcome,
    )
    atom = _ComposeAtom(
        part=part,
        is_tool=message.kind in _TOOL_KINDS,
        is_break=message.kind in _RUN_BREAK_KINDS,
        tool_name=(
            str(block["toolName"])
            if message.kind == "tool_call" and isinstance(block.get("toolName"), str)
            else None
        ),
        tool_call_id=(
            str(block["toolCallId"])
            if message.kind in _TOOL_KINDS and isinstance(block.get("toolCallId"), str)
            else None
        ),
    )
    if not part.fallback or plan.derivation is None:
        return _BuiltAtom(atom=atom)
    gap = DependencyGap(
        subject_kind="message",
        subject_id=message.message_id,
        derivation_type=plan.derivation,
    )
    recovery = RecoveryReceipt(
        subject_kind="message",
        subject_id=message.message_id,
        derivation_type=plan.derivation,
        content=part.text,
        source_version=derivation.source_version if derivation is not None else 1,
        reason="failed_floor" if derivation is not None and derivation.state == "failed" else "not_ready",
        floor_used=part.text,
    )
    return _BuiltAtom(atom=atom, gap=gap, recovery=recovery)


_RUN_OUTCOME_ORDER: tuple[ToolOutcome, ...] = ("succeeded", "failed", "unknown")


@dataclass(frozen=True, slots=True)
class _RunTally:
    counts: dict[ToolOutcome, int]
    outcome: ToolOutcome
    call_count: int
    tool_names: list[str]


# The run's per-invocation outcome tally: each call counted once, plus any
# result whose paired call sits outside this run (a cross-turn pair). Mixed
# outcomes stay explicit; the run-level outcome is failed if any failed, else
# unknown if any unknown, else succeeded.
def _tally_run(members: Sequence[_ComposeAtom]) -> _RunTally:
    calls = [member for member in members if member.part.kind == "tool_call"]
    call_ids = {member.tool_call_id for member in calls if member.tool_call_id is not None}
    orphan_results = [
        member
        for member in members
        if member.part.kind == "tool_result"
        and (member.tool_call_id is None or member.tool_call_id not in call_ids)
    ]
    counts: dict[ToolOutcome, int] = {"succeeded": 0, "failed": 0, "unknown": 0}
    for member in [*calls, *orphan_results]:
        counts[member.part.outcome or "unknown"] += 1
    outcome: ToolOutcome = (
        "failed" if counts["failed"] else "unknown" if counts["unknown"] else "succeeded"
    )
    tool_names: list[str] = []
    for call in calls:
        if call.tool_name is not None and call.tool_name not in tool_names:
            tool_names.append(call.tool_name)
    return _RunTally(counts, outcome, len(calls), tool_names)


def _run_tally_text(counts: Mapping[ToolOutcome, int]) -> str:
    segments = [f"{counts[outcome]} {outcome}" for outcome in _RUN_OUTCOME_ORDER if counts[outcome] > 0]
    return ", ".join(segments) if segments else "no outcomes"


def wrap_entity_xml(entity_id: str, body: str) -> str:
    """Short XML wrap: tag name is the entity id (`m12`, `t3`)."""
    return f"<{entity_id}>\n{body}\n</{entity_id}>"


def _wrap_message_line_xml(message_id: str, line: str) -> str:
    return f"<{message_id}>{line}</{message_id}>"


def format_turn_range_header(turn_ids: Sequence[str]) -> str:
    """Chunk band header: member turn ids the model can request later."""
    if len(turn_ids) == 0:
        return ""
    return f"<turns>{' '.join(turn_ids)}</turns>"


def stored_rendering_has_turn_label(content: str, turn_id: str) -> bool:
    """True when stored turn_rendering already carries the outer turn label wrap.

    Used by retrieval (R4+) and by the smooth select/compact path (R3) to decide
    live re-composition for legacy unlabeled rows.
    """
    return content.startswith(f"<{turn_id}>\n") and content.endswith(f"\n</{turn_id}>")


# One RenderingPart for a maximal tool run: a run-level header over member
# accounts in record order, each tool member stating its own outcome. Each
# member line is tagged with its message id so smooth history can address it.
def _compose_run(members: Sequence[_ComposeAtom]) -> RenderingPart:
    if not members:
        raise RuntimeError("composeRun: a tool run has no members")
    tally = _tally_run(members)
    tools = ", ".join(tally.tool_names) if tally.tool_names else "tools"
    plural = "" if tally.call_count == 1 else "s"
    header = (
        f"tool run · {tools} · {tally.call_count} call{plural} · "
        f"{_run_tally_text(tally.counts)}"
    )
    detail = "\n".join(
        _wrap_message_line_xml(
            member.part.message_id,
            (
                f"{member.part.text} ⇒ {member.part.outcome or 'unknown'}"
                if member.is_tool
                else member.part.text
            ),
        )
        for member in members
    )
    lead = members[0]
    return RenderingPart(
        message_id=lead.part.message_id,
        kind=lead.part.kind,
        text=f"[{header}]\n{detail}",
        fallback=any(member.is_tool and member.part.fallback for member in members),
        outcome=tally.outcome,
        member_message_ids=[member.part.message_id for member in members],
    )


# Compose the ordered RenderingParts. Per-message atoms build first
# (derivations verbatim or fallbacks, per-message gaps); then maximal runs of
# consecutive tool activity fold into one run part each with prompts/assistant
# text breaking runs and thinking/runtime notes transparent to them.
def compose_rendering_input(
    messages: Sequence[ComposeMessage],
    derivations: Mapping[str, ComposeDerivationRow],
) -> CompositionInput:
    result_by_call_id = _record_outcomes(messages)
    atoms: list[_ComposeAtom] = []
    gaps: list[DependencyGap] = []
    recoveries: list[RecoveryReceipt] = []
    for message in messages:
        built = _build_atom(message, derivations, result_by_call_id)
        atoms.append(built.atom)
        if built.gap is not None:
            gaps.append(built.gap)
        if built.recovery is not None:
            recoveries.append(built.recovery)
    parts: list[RenderingPart] = []
    i = 0
    while i < len(atoms):
        atom = atoms[i]
        if not atom.is_tool:
            parts.append(atom.part)
            i += 1
            continue
        j = i
        last_tool_idx = i
        while j + 1 < len(atoms) and not atoms[j + 1].is_break:
            j += 1
            if atoms[j].is_tool:
                last_tool_idx = j
        parts.append(_compose_run(atoms[i : last_tool_idx + 1]))
        parts.extend(atom.part for atom in atoms[last_tool_idx + 1 : j + 1])
        i = j + 1
    return CompositionInput(parts, gaps, recoveries)


def _format_dialogue_section(part: RenderingPart) -> str:
    return f"User:\n{part.text}" if part.kind == "user_prompt" else f"⏺ {part.text}"


def _compose_dialogue_text(parts: Sequence[RenderingPart]) -> str:
    dialogue = [part for part in parts if part.kind in _DIALOG_KINDS]
    if not dialogue:
        return ""
    text = _format_dialogue_section(dialogue[0])
    for previous, current in zip(dialogue, dialogue[1:]):
        separator = "\n" if previous.kind == current.kind == "assistant_text" else "\n\n"
        text += separator + _format_dialogue_section(current)
    return re.sub(r"\n{3,}", "\n\n", text)


def _rendering_part_label(kind: RenderingPartKind) -> str:
    return {
        "user_prompt": "User prompt",
        "assistant_text": "Assistant response",
        "assistant_thinking": "Assistant thinking",
        "runtime_note": "Runtime note",
        "model_change": "Model change",
        "thinking_level_change": "Thinking level change",
        "tool_call": "Tool call",
        "tool_result": "Tool result",
    }[kind]


# Smooth-band turn_rendering text: turn wrap + per-message tags. Not used for
# pre_detailed_assembly (compression stays untagged).
def compose_structured_turn_text(parts: Sequence[RenderingPart], turn_id: str) -> str:
    sections: list[str] = []
    for part in parts:
        # Empty thinking has no usable representation in a text band. Leaving it
        # here bypasses the serving-exit tail filters once the turn is compacted.
        # JS String.prototype.trim (not Python str.strip): U+FEFF is empty, U+0085 is not.
        if part.kind == "assistant_thinking" and js_trim(part.text) == "":
            continue
        annotations: list[str] = []
        if part.fallback:
            annotations.append("fallback")
        if part.outcome is not None:
            annotations.append(f"outcome: {part.outcome}")
        suffix = f" [{'; '.join(annotations)}]" if annotations else ""
        header = f"{_rendering_part_label(part.kind)}{suffix}"
        # Tool runs already tag each member line; other parts wrap the whole body.
        if part.member_message_ids is not None and len(part.member_message_ids) > 0:
            body = part.text
        else:
            body = wrap_entity_xml(part.message_id, part.text)
        sections.append(f"{header}\n{body}")
    inner = "\n\n".join(sections)
    return wrap_entity_xml(turn_id, inner)


@dataclass(frozen=True, slots=True)
class PreDetailedAssembly:
    text: str
    gaps: list[DependencyGap]
    recoveries: list[RecoveryReceipt]


def labeled_or_recomposed_turn_rendering(
    turn_id: str,
    stored_content: str | None,
    messages: Sequence[ComposeMessage],
    derivations: Mapping[str, ComposeDerivationRow],
) -> str:
    """TS retrieval ``turnCandidate`` body resolution (pin 81cd48c).

    When a ready stored rendering already carries the outer ``<turnId>`` wrap,
    return it verbatim (no double-label). Otherwise recompose from the live
    member messages and their message-owned derivations — pure, no writes —
    exactly as ``turn_derivation`` would via ``composeStructuredTurnText``.
    """
    if isinstance(stored_content, str) and stored_rendering_has_turn_label(
        stored_content, turn_id
    ):
        return stored_content
    composition = compose_rendering_input(messages, derivations)
    return compose_structured_turn_text(composition.parts, turn_id)


# Dialog-register assembly for detailed-band compression: user prompts
# (smoothed where ready) and assistant text only, in record order.
# Label-free by design — derivation prompts must not learn retrieval markup.
def compose_pre_detailed_assembly(
    messages: Sequence[ComposeMessage],
    derivations: Mapping[str, ComposeDerivationRow],
) -> PreDetailedAssembly:
    result_by_call_id = _record_outcomes(messages)
    parts: list[RenderingPart] = []
    gaps: list[DependencyGap] = []
    recoveries: list[RecoveryReceipt] = []
    for message in messages:
        if message.kind not in _DIALOG_KINDS:
            continue
        built = _build_atom(message, derivations, result_by_call_id)
        parts.append(built.atom.part)
        if built.gap is not None:
            gaps.append(built.gap)
        if built.recovery is not None:
            recoveries.append(built.recovery)
    return PreDetailedAssembly(_compose_dialogue_text(parts), gaps, recoveries)
