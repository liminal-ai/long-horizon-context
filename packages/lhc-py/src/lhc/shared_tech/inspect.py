"""Ported from packages/lhc/src/shared-tech/inspect.ts. Phase 1 skeleton.

Inspect report shapes. Inspect is a pure consumer: these shapes carry other
domains' surface output composed into counts and summaries; nothing here is
re-derived or re-interpreted beyond the owners' reported states.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .view import Band


@dataclass(frozen=True, slots=True)
class InspectOverviewThread:
    id: str
    created_at: str
    metadata: dict[str, str] | None = None


@dataclass(frozen=True, slots=True)
class InspectOverviewEventsSpan:
    first: int
    last: int


@dataclass(frozen=True, slots=True)
class InspectOverviewEvents:
    count: int
    # span null means count 0: absent pieces report as zeros/nulls.
    span: InspectOverviewEventsSpan | None


@dataclass(frozen=True, slots=True)
class InspectOverviewMessages:
    # Deleted messages appear only in `deleted`: excluded from visible, by_kind,
    # and visible_tokens. Event counts above are unaffected because the record
    # retains everything.
    visible: int
    by_kind: dict[str, int]
    deleted: int
    visible_tokens: int


@dataclass(frozen=True, slots=True)
class InspectOverviewTurns:
    open: int
    closed: int


@dataclass(frozen=True, slots=True)
class InspectOverviewChunks:
    count: int
    unchunked_turns: int


# Mutable accumulator: the TS counterpart is mutated in place by the
# bucket helpers (thread_view._bucket_derivation / inspect overview
# bucket_entries), so this dataclass is deliberately NOT frozen.
@dataclass(slots=True)
class InspectOverviewDerivation:
    # Counts by operational state across both owners' report surfaces; ready
    # included, unlike ViewStatus, which reports situations only.
    ready: int
    pending: int
    failed: int
    blocked: int


@dataclass(frozen=True, slots=True)
class InspectOverviewView:
    # Active-view summary, or null when never compacted.
    view_id: str
    created_at: str
    compact_point: int
    covered_from: int


@dataclass(frozen=True, slots=True)
class InspectOverviewVisibility:
    boundary_position: int
    zone_tokens: int


@dataclass(frozen=True, slots=True)
class InspectOverview:
    thread: InspectOverviewThread
    events: InspectOverviewEvents
    messages: InspectOverviewMessages
    turns: InspectOverviewTurns
    chunks: InspectOverviewChunks
    derivation: InspectOverviewDerivation
    view: InspectOverviewView | None
    visibility: InspectOverviewVisibility


@dataclass(frozen=True, slots=True)
class ViewContentsMetaConfig:
    lower_bound: int
    percentages: dict[str, int]


@dataclass(frozen=True, slots=True)
class ViewContentsMeta:
    view_id: str
    created_at: str
    profile: str | None
    config: ViewContentsMetaConfig
    compact_point: int
    covered_from: int


@dataclass(frozen=True, slots=True)
class ViewContentsBandEntry:
    subject_kind: Literal["chunk", "turn"]
    subject_id: str
    derivation_used: str
    degraded: bool


@dataclass(frozen=True, slots=True)
class ViewContentsBand:
    band: Band
    entries: list[ViewContentsBandEntry]
    stored_tokens: int


@dataclass(frozen=True, slots=True)
class ViewContentsGap:
    band: Band
    subject_id: str
    reason: str


@dataclass(frozen=True, slots=True)
class ViewContentsTail:
    message_count: int
    tokens: int  # as served


@dataclass(frozen=True, slots=True)
class ViewContentsLoadCost:
    # load_cost totals what model context serves now: band and tail tokens are
    # both measured over served messages with the shared estimator, so equality
    # with an independent context read is structural. The stored per-band counts
    # stay reported above; they price the snapshot bytes without the served
    # band-marker header, so they are describe's truth, not the serving cost.
    band_tokens: int
    tail_tokens: int
    total: int  # = model context


@dataclass(frozen=True, slots=True)
class ViewContentsSourceState:
    # Provenance verbatim; null on a never-compacted thread because no compact
    # ever recorded what it saw, and inventing zeros would fabricate provenance.
    # Nested type → state → count (TS declared flat; runtime persists nested).
    max_event_order: int
    derivation_counts: dict[str, dict[str, int]]


@dataclass(frozen=True, slots=True)
class ViewContentsReport:
    """View-contents report shape served by `inspect.view`."""

    meta: ViewContentsMeta | None
    bands: list[ViewContentsBand]
    gaps: list[ViewContentsGap]
    tail: ViewContentsTail
    load_cost: ViewContentsLoadCost
    source_state: ViewContentsSourceState | None


@dataclass(frozen=True, slots=True)
class HealthOwnerCounts:
    ready: int
    pending: int
    failed: int
    blocked: int


@dataclass(frozen=True, slots=True)
class HealthOwnerEntry:
    owner: Literal["capture", "messages", "turns"]
    kind: str
    counts: HealthOwnerCounts


@dataclass(frozen=True, slots=True)
class HealthFailure:
    owner: str
    subject_kind: str
    subject_id: str
    derivation_type: str
    reason: str


@dataclass(frozen=True, slots=True)
class HealthRepairPreview:
    owner: str
    subject_kind: str
    subject_id: str
    derivation_type: str


@dataclass(frozen=True, slots=True)
class HealthQueue:
    queued: int
    claimed: int


@dataclass(frozen=True, slots=True)
class HealthReport:
    # Counts by owner, derivation kind, and operational state, assembled entirely
    # from the owners' report surfaces.
    owners: list[HealthOwnerEntry]
    # Actionable failure detail: enough to decide and target a requeue without
    # raw SQL.
    failures: list[HealthFailure]
    # What a requeue pass would touch: failed and not blocked, reported, never
    # executed.
    repair_preview: list[HealthRepairPreview]
    # Live queue visibility from the owners' queue detail, counted per report
    # entry so the section is consistent by construction with the pending state
    # counts in the same report.
    queue: HealthQueue
