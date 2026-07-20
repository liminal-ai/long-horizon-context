"""Ported from packages/lhc/src/turns/internal/compose.ts. Phase 1 skeleton.

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

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from ...shared_tech.derivation import (
    DependencyGap,
    DerivationMetadata,
    DerivationState,
    RenderingPart,
    RenderingPartKind,
    ToolOutcome,
)

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
    raise NotImplementedError


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
    raise NotImplementedError


def _model_change_text(message: ComposeMessage) -> str:
    raise NotImplementedError


def _thinking_level_change_text(message: ComposeMessage) -> str:
    raise NotImplementedError


def _prompt_fallback_text(message: ComposeMessage) -> str:
    raise NotImplementedError


# Mechanical outcome from the record alone: a tool call's outcome comes from
# its paired result among the turn's messages.
def _record_outcomes(messages: Sequence[ComposeMessage]) -> dict[str, bool]:
    raise NotImplementedError


def _outcome_from_record(result_by_call_id: Mapping[str, bool], call_id: object) -> ToolOutcome:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _PartPlan:
    fallback_text: Callable[[ComposeMessage], str]
    derivation: str | None = None


def _tool_call_fallback_text(message: ComposeMessage) -> str:
    raise NotImplementedError


def _tool_result_fallback_text(message: ComposeMessage) -> str:
    raise NotImplementedError


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
    raise NotImplementedError


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
    raise NotImplementedError


def _run_tally_text(counts: Mapping[ToolOutcome, int]) -> str:
    raise NotImplementedError


# One RenderingPart for a maximal tool run: a run-level header over member
# accounts in record order, each tool member stating its own outcome.
def _compose_run(members: Sequence[_ComposeAtom]) -> RenderingPart:
    raise NotImplementedError


# Compose the ordered RenderingParts. Per-message atoms build first
# (derivations verbatim or fallbacks, per-message gaps); then maximal runs of
# consecutive tool activity fold into one run part each with prompts/assistant
# text breaking runs and thinking/runtime notes transparent to them.
def compose_rendering_input(
    messages: Sequence[ComposeMessage],
    derivations: Mapping[str, ComposeDerivationRow],
) -> CompositionInput:
    raise NotImplementedError


def _format_dialogue_section(part: RenderingPart) -> str:
    raise NotImplementedError


def _compose_dialogue_text(parts: Sequence[RenderingPart]) -> str:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class PreDetailedAssembly:
    text: str
    gaps: list[DependencyGap]
    recoveries: list[RecoveryReceipt]


# Dialog-register assembly for detailed-band compression: user prompts
# (smoothed where ready) and assistant text only, in record order.
def compose_pre_detailed_assembly(
    messages: Sequence[ComposeMessage],
    derivations: Mapping[str, ComposeDerivationRow],
) -> PreDetailedAssembly:
    raise NotImplementedError
