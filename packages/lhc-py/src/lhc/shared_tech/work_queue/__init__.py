"""Ported from packages/lhc/src/shared-tech/work-queue/index.ts. Phase 1 skeleton.

Durable work-item mechanics: recording, ordered listing, and the enqueue
wrapper that makes scheduling structural. The util is domain-blind: it
knows item mechanics (owner, kind, sourceRef), while each owning domain
supplies the derivation targets and handler meaning.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Union

from ..derivation import CompletionTx, HandlerDerivationWrite, SubjectKind, WorkHandler
from ..persist import DbWriteTransaction
from ..storage import Database

if TYPE_CHECKING:
    from ..durable_work import DurableWorkOperation

WorkOwner = Literal["messages", "turns"]

WorkKind = Literal[
    "prompt_smoothing",
    "tool_result_summary",
    "turn_derivation",
    "detailed_turn_compression",
    "chunk_summary_detailed",
    "chunk_summary_brief",
]


@dataclass(frozen=True, slots=True)
class WorkSourceRefMessage:
    message_id: str


@dataclass(frozen=True, slots=True)
class WorkSourceRefTurn:
    turn_id: str


@dataclass(frozen=True, slots=True)
class WorkSourceRefChunk:
    chunk_id: str


WorkSourceRef = Union[WorkSourceRefMessage, WorkSourceRefTurn, WorkSourceRefChunk]

# TS: Partial<Record<WorkKind, WorkHandler>> — not every kind need be registered.
WorkHandlerMap = dict[WorkKind, WorkHandler]


@dataclass(frozen=True, slots=True)
class _WorkKindRegistryEntry:
    owner: WorkOwner
    source_ref_key: Literal["messageId", "turnId", "chunkId"]


# Mechanical metadata only; what a kind means stays with the owning domain's
# handler.
WORK_KIND_REGISTRY: dict[WorkKind, _WorkKindRegistryEntry] = {
    "prompt_smoothing": _WorkKindRegistryEntry(owner="messages", source_ref_key="messageId"),
    "tool_result_summary": _WorkKindRegistryEntry(owner="messages", source_ref_key="messageId"),
    "turn_derivation": _WorkKindRegistryEntry(owner="turns", source_ref_key="turnId"),
    "detailed_turn_compression": _WorkKindRegistryEntry(owner="turns", source_ref_key="turnId"),
    "chunk_summary_detailed": _WorkKindRegistryEntry(owner="turns", source_ref_key="chunkId"),
    "chunk_summary_brief": _WorkKindRegistryEntry(owner="turns", source_ref_key="chunkId"),
}


# SDK construction wiring for durable work dispatch. Domains own their
# handler tables; shared-tech owns merging those tables into the queue's
# dispatch map and refusing duplicate kind claims.
def map_work_q_handlers(handler_groups: Sequence[WorkHandlerMap]) -> WorkHandlerMap:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class WorkItemRecord:
    work_item_id: str
    owner: WorkOwner
    kind: WorkKind
    source_ref: WorkSourceRef
    status: Literal["queued"]  # the only status written before a drain claims it
    queued_at: str


# The derivations an enqueue is scheduling work toward; the owning domain
# names them (the util stays meaning-blind). Stored in the row's payload so
# the drain's failure paths can land the derivation's failed/blocked state
# without asking any domain what a kind means.
@dataclass(frozen=True, slots=True)
class EnqueueDerivationTarget:
    subject_kind: SubjectKind
    subject_id: str
    derivation_type: str


@dataclass(frozen=True, slots=True)
class WorkItemInput:
    owner: WorkOwner
    kind: WorkKind
    source_ref: WorkSourceRef
    operation: DurableWorkOperation | None = None
    source_version: int | None = None  # defaults to 1 — first version of a fresh source
    derivations: tuple[EnqueueDerivationTarget, ...] | list[EnqueueDerivationTarget] | None = None


def _source_id_of(source_ref: WorkSourceRef) -> str:
    raise NotImplementedError


def _target_key(
    target: EnqueueDerivationTarget | HandlerDerivationWrite,
) -> str:
    raise NotImplementedError


# Deterministic id scoped to source version: re-queueing the same kind for
# the same source at the same version is the same id, while a post-mutation
# replacement at the next version never collides with older in-flight work.
def record_item(db: Database, input: WorkItemInput, queued_at: str) -> WorkItemRecord:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class EnqueueInput:
    owner: WorkOwner
    kind: WorkKind
    source_ref: WorkSourceRef
    derivations: tuple[EnqueueDerivationTarget, ...] | list[EnqueueDerivationTarget]
    operation: DurableWorkOperation | None = None
    source_version: int | None = None


@dataclass(frozen=True, slots=True)
class ImmediateDerivationBoundaryMissing:
    subject_kind: SubjectKind
    subject_id: str
    derivation_type: str
    exists: Literal[False] = False


@dataclass(frozen=True, slots=True)
class ImmediateDerivationBoundaryPresent:
    subject_kind: SubjectKind
    subject_id: str
    derivation_type: str
    state: str
    source_version: int
    exists: Literal[True] = True


ImmediateDerivationBoundary = Union[
    ImmediateDerivationBoundaryMissing,
    ImmediateDerivationBoundaryPresent,
]


@dataclass(frozen=True, slots=True)
class ImmediateClaimInput:
    owner: WorkOwner
    kind: WorkKind
    source_ref: WorkSourceRef
    derivations: tuple[EnqueueDerivationTarget, ...] | list[EnqueueDerivationTarget]
    expected_derivations: tuple[ImmediateDerivationBoundary, ...] | list[ImmediateDerivationBoundary]
    operation: DurableWorkOperation | None = None
    source_version: int | None = None


@dataclass(frozen=True, slots=True)
class ImmediateClaimClaimed:
    outcome: Literal["claimed"]
    item: ClaimedWorkItem


@dataclass(frozen=True, slots=True)
class ImmediateClaimExpired:
    outcome: Literal["expired"]
    item: ClaimedWorkItem


@dataclass(frozen=True, slots=True)
class ImmediateClaimQueued:
    outcome: Literal["queued"]
    work_item_id: str


@dataclass(frozen=True, slots=True)
class ImmediateClaimInFlight:
    outcome: Literal["in_flight"]
    work_item_id: str


ImmediateClaimOutcome = Union[
    ImmediateClaimClaimed,
    ImmediateClaimExpired,
    ImmediateClaimQueued,
    ImmediateClaimInFlight,
]


# The one way work is scheduled: the work row, the derivation's `pending`
# state row, and the scheduler poke all ride the ambient transaction. They
# commit together or vanish together. Enqueue is the *only* place a
# derivation row is created (completion is UPDATE-only); re-enqueueing
# resets an existing row to pending at the enqueued source version.
def enqueue(transaction: DbWriteTransaction, input: EnqueueInput) -> WorkItemRecord:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class ClaimTiming:
    now: str
    lease_duration_ms: int


def create_or_claim_immediate_work_item(
    db: Database,
    input: ImmediateClaimInput,
    claim_timing: ClaimTiming,
) -> ImmediateClaimOutcome:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _RawWorkItemRow:
    work_item_id: str
    owner: str
    kind: str
    source_ref: str
    queued_at: str


# The claimed row as the drain holds it: mechanical fields plus the payload's
# source version and derivation targets. `kind` is a plain string here — a raw row
# with an unregistered kind must still be claimable so the drain can land it
# failed_terminal instead of skipping it.
@dataclass(frozen=True, slots=True)
class ClaimedWorkItem:
    work_item_id: str
    owner: WorkOwner
    kind: str
    source_ref: WorkSourceRef
    queued_at: str
    source_version: int
    derivations: tuple[EnqueueDerivationTarget, ...] | list[EnqueueDerivationTarget]
    operation: DurableWorkOperation | None = None


@dataclass(frozen=True, slots=True)
class ClaimOutcomeClaimed:
    outcome: Literal["claimed"]
    item: ClaimedWorkItem


@dataclass(frozen=True, slots=True)
class ClaimOutcomeExpired:
    outcome: Literal["expired"]
    item: ClaimedWorkItem


@dataclass(frozen=True, slots=True)
class ClaimOutcomeEmpty:
    outcome: Literal["empty"]


@dataclass(frozen=True, slots=True)
class ClaimOutcomeInFlight:
    outcome: Literal["in_flight"]
    claim_expires_at: str


ClaimOutcome = Union[
    ClaimOutcomeClaimed,
    ClaimOutcomeExpired,
    ClaimOutcomeEmpty,
    ClaimOutcomeInFlight,
]


@dataclass(frozen=True, slots=True)
class _RawClaimRow:
    work_item_id: str
    owner: str
    kind: str
    source_ref: str
    queued_at: str
    payload: str


@dataclass(frozen=True, slots=True)
class _WorkPayload:
    source_version: int | None = None
    operation: DurableWorkOperation | None = None
    derivations: list[EnqueueDerivationTarget] | None = None


def _parse_work_payload(row: _RawClaimRow) -> _WorkPayload:
    raise NotImplementedError


def _operation_intent_for_row(kind: str, source_ref: WorkSourceRef) -> DurableWorkOperation | None:
    raise NotImplementedError


def _to_claimed_item(row: _RawClaimRow) -> ClaimedWorkItem:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class DeleteClaimedItem:
    work_item_id: str


def delete_claimed_item(db: Database, item: DeleteClaimedItem) -> bool:
    raise NotImplementedError


# Head-first, never skip-ahead: the claim decision is made against the oldest
# live row only. A queued head is claimed once. An expired claim is returned
# as dead work so the drain can fail it without running the handler again.
def claim_next(db: Database, now: str, lease_duration_ms: int) -> ClaimOutcome:
    raise NotImplementedError


# Completion writes derivations and deletes the item row in one short
# transaction. UPDATE-only, never upsert: enqueue created the pending row, and
# completions for older source versions are discarded as stale. The optional
# on_applied hook runs after successful writes inside the same transaction, so
# follow-on chunk placement and summary enqueues commit or roll back with the
# completion.
def complete(
    db: Database,
    item: ClaimedWorkItem,
    writes: Sequence[HandlerDerivationWrite],
    derived_at: str,
    on_applied: Callable[[CompletionTx], None] | None = None,
) -> Literal["done", "stale_discarded", "lost_lease"]:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _SupersedeTarget:
    kind: WorkKind
    source_ref: WorkSourceRef


# Delete still-queued items for the given (kind, sourceRef) targets, returning
# the deleted ids for mutation results. Runs inside the caller's ambient
# transaction. Claimed items are deliberately left alone: source-version
# checks discard their stale completions.
def supersede_queued(
    db: Database,
    targets: Sequence[_SupersedeTarget],
) -> list[str]:
    raise NotImplementedError


# Is there a live item, queued or in flight, for this kind and source at this
# source version? Runs inside the caller's repair transaction so the check and
# enqueue commit together. Version-scoped on purpose: older claimed work is
# already fenced by source version and must not block repair.
def has_live_item(
    db: Database,
    kind: WorkKind,
    source_ref: WorkSourceRef,
    source_version: int,
) -> bool:
    raise NotImplementedError


# Live items left in the queue; used by drain reporting and owner repair reports.
def count_live_items(db: Database) -> int:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class QueueDetailRow:
    work_item_id: str
    owner: WorkOwner
    kind: str
    source_ref: WorkSourceRef
    status: Literal["queued", "claimed"]
    queued_at: str
    source_version: int
    claimed_at: str | None = None
    claim_expires_at: str | None = None


# Mechanical detail of every live row in queue order. Owner reports join this
# against derivations; tests use it for lease assertions.
def queue_detail(db: Database) -> list[QueueDetailRow]:
    raise NotImplementedError


# Listing in queue order (insertion order within the walk); each owning
# domain lists only its own items.
def list_items(db: Database, owner: WorkOwner) -> list[WorkItemRecord]:
    raise NotImplementedError
