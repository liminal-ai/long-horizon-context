"""Ported from packages/lhc/src/shared-tech/view.ts.

Shared thread-view vocabulary. Shared so CLI, SDK, and tests import one
home; the thread-view domain owns behavior, this module owns only shapes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Union

Band = Literal["brief", "detailed", "smooth"]


@dataclass(frozen=True, slots=True)
class ViewProfilePercentages:
    full: int
    smooth: int
    detailed: int
    brief: int


@dataclass(frozen=True, slots=True)
class ViewProfile:
    name: str
    # Target assembled size; whole-entry fills may land under or over because
    # the bound is a target, not a cap.
    lower_bound: int
    # Band shares of the lower bound; must sum to 100.
    percentages: ViewProfilePercentages


@dataclass(frozen=True, slots=True)
class PartialViewProfilePercentages:
    """Partial<ViewProfile["percentages"]> — each band share individually optional."""

    full: int | None = None
    smooth: int | None = None
    detailed: int | None = None
    brief: int | None = None


@dataclass(frozen=True, slots=True)
class ViewProfileOverride:
    """A user profile entry as configured: a full profile under a new name, or a
    field-wise override of a built-in merged by name. A partial entry
    whose name matches no built-in has nothing to merge over and is rejected at
    construction.
    """

    name: str
    lower_bound: int | None = None
    percentages: PartialViewProfilePercentages | None = None


@dataclass(frozen=True, slots=True)
class ViewCompactParams:
    """Compact-time explicit parameters: field-wise overrides of the base profile,
    down to single band percentages — the same depth the CLI's per-band flags
    override at.
    """

    lower_bound: int | None = None
    percentages: PartialViewProfilePercentages | None = None


@dataclass(frozen=True, slots=True)
class VisibilityBudgets:
    """Visibility-boundary budgets: max > target, both positive. Intake no longer
    advances the boundary automatically; the budgets still shape status and any
    future explicit pressure policy that reads the visibility zone.
    """

    max_tokens: int
    target_tokens: int


@dataclass(frozen=True, slots=True)
class PartialVisibilityBudgets:
    """Partial<VisibilityBudgets> — every field optional at SdkViewConfig."""

    max_tokens: int | None = None
    target_tokens: int | None = None


@dataclass(frozen=True, slots=True)
class SdkViewConfig:
    profiles: list[ViewProfileOverride] | None = None  # merged over built-ins by name
    visibility: PartialVisibilityBudgets | None = None  # defaults: 64000 / 32000
    compact_threshold: int | None = None  # status trigger; default 160000


@dataclass(frozen=True, slots=True)
class ResolvedViewConfig:
    """Every optional filled by init_lhc's central defaults; profiles resolved
    to complete, validated entries keyed by name.
    """

    profiles: dict[str, ViewProfile]  # Readonly in TS; plain dict here
    visibility: VisibilityBudgets
    compact_threshold: int


# ── model-context / status shapes (the product crossing to the harness) ────


@dataclass(frozen=True, slots=True)
class LlmRequestContextPart:
    text: str
    type: Literal["text"] = "text"


@dataclass(frozen=True, slots=True)
class LlmRequestContextMessage:
    role: Literal["user", "assistant"]
    content: list[LlmRequestContextPart]


@dataclass(frozen=True, slots=True)
class LlmRequestContext:
    thread_id: str
    messages: list[LlmRequestContextMessage]


# PI SessionManager-friendly message shapes built from canonical LHC record
# data. The host maps these to its session append API.


@dataclass(frozen=True, slots=True)
class SessionAssistantPart:
    type: Literal["text", "thinking", "toolCall"]
    text: str | None = None
    thinking: str | None = None
    tool_call_id: str | None = None
    tool_name: str | None = None
    arguments: dict[str, object] | None = None


@dataclass(frozen=True, slots=True)
class SessionThreadViewEntrySource:
    message_id: str
    idempotency_key: str | None


@dataclass(frozen=True, slots=True)
class SessionUserMessage:
    content: str
    source_messages: list[SessionThreadViewEntrySource]
    role: Literal["user"] = "user"


@dataclass(frozen=True, slots=True)
class SessionAssistantMessage:
    content: list[SessionAssistantPart]
    """One row per grouped LHC message, in part order."""
    source_messages: list[SessionThreadViewEntrySource]
    role: Literal["assistant"] = "assistant"


@dataclass(frozen=True, slots=True)
class SessionToolResultMessage:
    tool_call_id: str
    content: str
    source_messages: list[SessionThreadViewEntrySource]
    tool_name: str | None = None
    is_error: bool | None = None
    role: Literal["toolResult"] = "toolResult"


@dataclass(frozen=True, slots=True)
class SessionModelChangeEntry:
    provider: str
    model_id: str
    source_messages: list[SessionThreadViewEntrySource]
    kind: Literal["model_change"] = "model_change"


@dataclass(frozen=True, slots=True)
class SessionThinkingLevelChangeEntry:
    level: str
    source_messages: list[SessionThreadViewEntrySource]
    kind: Literal["thinking_level_change"] = "thinking_level_change"


SessionThreadViewMessage = Union[SessionUserMessage, SessionAssistantMessage, SessionToolResultMessage]

SessionThreadViewEntry = Union[
    SessionThreadViewMessage,
    SessionModelChangeEntry,
    SessionThinkingLevelChangeEntry,
]


@dataclass(frozen=True, slots=True)
class SessionThreadView:
    thread_id: str
    entries: list[SessionThreadViewEntry]


@dataclass(frozen=True, slots=True)
class StoredViewArrangementEntry:
    band: Band
    subject_kind: Literal["chunk", "turn"]
    subject_id: str
    derivation_used: str
    degraded: bool


@dataclass(frozen=True, slots=True)
class StoredViewGap:
    band: Band
    subject_id: str
    reason: str


@dataclass(frozen=True, slots=True)
class StoredViewConfig:
    # TS `number` — JSON may yield int or float; never truncate on read.
    lower_bound: int | float
    percentages: dict[str, int | float]


@dataclass(frozen=True, slots=True)
class StoredViewSourceState:
    max_event_order: int
    # Nested SelectionInputs map persisted verbatim (derivation type → state → count).
    derivation_counts: dict[str, dict[str, int]]


@dataclass(frozen=True, slots=True)
class StoredViewBand:
    band: Band
    stored_tokens: int


@dataclass(frozen=True, slots=True)
class StoredView:
    """The stored active view row as `threadView.describe` exposes it: snapshot
    fields verbatim — arrangement, gaps, config, source-state provenance, and
    per-band stored token counts — never recomputed, never repaired. Absent view
    means describe returns ok/null, mirroring status's never-compacted behavior.
    """

    view_id: str
    created_at: str
    compact_point: int
    covered_from: int
    # null when explicit params overrode a named base at compact (the stored
    # config carries the resolved truth either way).
    profile_name: str | None
    config: StoredViewConfig
    # Every selected entry in served order, gap entries included (they are
    # arrangement rows too; `gaps` carries their reasons).
    arrangement: list[StoredViewArrangementEntry]
    gaps: list[StoredViewGap]
    # What the compact saw, stored verbatim.
    source_state: StoredViewSourceState
    # Non-empty bands in gradient order with their stored token counts.
    bands: list[StoredViewBand]


# Mutable accumulator: the TS counterpart is mutated in place by the
# bucket helpers (thread_view._bucket_derivation / inspect overview
# bucket_entries), so this dataclass is deliberately NOT frozen.
@dataclass(slots=True)
class ViewStatusDerivation:
    pending: int
    failed: int
    blocked: int


@dataclass(frozen=True, slots=True)
class ViewStatusView:
    degraded: int
    gaps: int
    built_at: str


@dataclass(frozen=True, slots=True)
class ViewStatusVisibility:
    boundary_position: int
    zone_tokens: int
    max_tokens: int


@dataclass(frozen=True, slots=True)
class ViewStatus:
    tail_tokens: int
    threshold: int
    compact_recommended: bool
    derivation: ViewStatusDerivation
    view: ViewStatusView | None
    visibility: ViewStatusVisibility


@dataclass(frozen=True, slots=True)
class PruneReceipt:
    previous_boundary: int
    new_boundary: int
    compact_point: int
    target_tokens: int
    tool_results_pruned: int
    tokens_behind_boundary: int
    zone_tokens_before: int
    zone_tokens_after: int
    no_op: bool


@dataclass(frozen=True, slots=True)
class PreviewCompactResult:
    compact_point: int
    would_produce_bands: bool
    tail_tokens: int
    first_kept_message_id: str | None


@dataclass(frozen=True, slots=True)
class PreviewCompactOk:
    preview: PreviewCompactResult
    kind: Literal["ok"] = "ok"


@dataclass(frozen=True, slots=True)
class PreviewCompactErr:
    reason: str
    kind: Literal["error"] = "error"


PreviewCompactOutcome = Union[PreviewCompactOk, PreviewCompactErr]


# ── receipts ─────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class CompactBandStats:
    entries: int
    tokens: int


@dataclass(frozen=True, slots=True)
class CompactReceiptConfig:
    full: int
    smooth: int
    detailed: int
    brief: int
    lower_bound: int


@dataclass(frozen=True, slots=True)
class CompactDegradedEntry:
    band: Band
    subject_id: str
    used_derivation: str


@dataclass(frozen=True, slots=True)
class CompactGapEntry:
    band: Band
    subject_id: str
    reason: str


@dataclass(frozen=True, slots=True)
class CompactWarning:
    band: Band
    subject_id: str
    derivation_type: Literal["chunk_summary_detailed", "chunk_summary_brief"]
    reason: str


@dataclass(frozen=True, slots=True)
class CompactRenderedBand:
    band: Band
    text: str


@dataclass(frozen=True, slots=True)
class CompactReceipt:
    view_id: str
    profile: str | None
    config: CompactReceiptConfig
    bands: dict[Band, CompactBandStats]
    tail_tokens: int
    # The assembled view's actual total (band tokens + tail tokens) against
    # the configured lower bound — a target, not a cap: whole-entry fills may
    # land under it, indivisible entries over it.
    total_tokens: int
    covered_from: int
    compact_point: int
    degraded: list[CompactDegradedEntry]
    gaps: list[CompactGapEntry]
    rendered_bands: list[CompactRenderedBand]
    first_kept_message_id: str | None
    warnings: list[CompactWarning] | None = None
