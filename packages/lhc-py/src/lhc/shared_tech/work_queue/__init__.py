"""Ported from packages/lhc/src/shared-tech/work-queue/index.ts. Phase 1 skeleton.

Durable work-item mechanics: recording, ordered listing, and the enqueue
wrapper that makes scheduling structural. The util is domain-blind: it
knows item mechanics (owner, kind, sourceRef), while each owning domain
supplies the derivation targets and handler meaning.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Literal, TypedDict, Union

from ..derivation import CompletionTx, HandlerDerivationWrite, SubjectKind, WorkHandler, WorkItemRef
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


# Persisted JSON byte-for-byte (JSON.stringify(sourceRef) into work_item.source_ref).
# TypedDict + verbatim camelCase keys — same precedent as ThreadRef.
class WorkSourceRefMessage(TypedDict):
    messageId: str


class WorkSourceRefTurn(TypedDict):
    turnId: str


class WorkSourceRefChunk(TypedDict):
    chunkId: str


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
    handlers_by_kind: WorkHandlerMap = {}
    for handlers in handler_groups:
        for kind, handler in handlers.items():
            if kind in handlers_by_kind:
                raise TypeError(f'work kind "{kind}" registered by more than one domain')
            handlers_by_kind[kind] = handler
    return handlers_by_kind


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


# ── persisted work_item.payload JSON (canonical stored shape) ─────
# CamelCase TypedDicts: the byte-for-byte JSON written into work_item.payload.
# thread_migrate and _parse_work_payload both consume this shape.


class _QueuedDerivationTarget(TypedDict):
    """EnqueueDerivationTarget's stored-payload shape (camelCase JSON keys)."""

    subjectKind: str
    subjectId: str
    derivationType: str


class _QueuedWorkItemPayload(TypedDict, total=False):
    """Persisted work_item.payload JSON (camelCase keys)."""

    sourceVersion: int
    operation: str
    derivations: list[_QueuedDerivationTarget]


@dataclass(frozen=True, slots=True)
class WorkItemInput:
    owner: WorkOwner
    kind: WorkKind
    source_ref: WorkSourceRef
    operation: DurableWorkOperation | None = None
    source_version: int | None = None  # defaults to 1 — first version of a fresh source
    derivations: Sequence[EnqueueDerivationTarget] | None = None


def _source_id_of(source_ref: WorkSourceRef) -> str:
    if "messageId" in source_ref:
        return source_ref["messageId"]
    if "turnId" in source_ref:
        return source_ref["turnId"]
    return source_ref["chunkId"]


def _target_key(
    target: EnqueueDerivationTarget | HandlerDerivationWrite,
) -> str:
    return f"{target.subject_kind}/{target.subject_id}/{target.derivation_type}"


def _json(value: object) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _operation_payload(operation: DurableWorkOperation | None) -> object | None:
    if operation is None:
        return None
    if operation.operation == "messages.derive":
        return {"operation": operation.operation, "messageId": operation.message_id}
    if operation.operation in ("turns.deriveTurn", "turns.deriveDetailedTurnCompression"):
        return {"operation": operation.operation, "turnId": operation.turn_id}
    return {"operation": operation.operation, "chunkId": operation.chunk_id}


def _parse_operation(value: object) -> DurableWorkOperation | None:
    if not isinstance(value, dict):
        return None
    operation = value.get("operation")
    # IMPORT-CYCLE SEAM: durable_work imports work_queue at module load time.
    from ..durable_work import (
        MessagesDeriveOperation,
        TurnsDeriveBriefChunkOperation,
        TurnsDeriveDetailedChunkOperation,
        TurnsDeriveDetailedTurnCompressionOperation,
        TurnsDeriveTurnOperation,
    )

    if operation == "messages.derive" and isinstance(value.get("messageId"), str):
        return MessagesDeriveOperation(message_id=value["messageId"])
    if operation == "turns.deriveTurn" and isinstance(value.get("turnId"), str):
        return TurnsDeriveTurnOperation(turn_id=value["turnId"])
    if operation == "turns.deriveDetailedTurnCompression" and isinstance(value.get("turnId"), str):
        return TurnsDeriveDetailedTurnCompressionOperation(turn_id=value["turnId"])
    if operation == "turns.deriveDetailedChunk" and isinstance(value.get("chunkId"), str):
        return TurnsDeriveDetailedChunkOperation(chunk_id=value["chunkId"])
    if operation == "turns.deriveBriefChunk" and isinstance(value.get("chunkId"), str):
        return TurnsDeriveBriefChunkOperation(chunk_id=value["chunkId"])
    return None


def _parse_instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iso_millis(value: datetime) -> str:
    utc = value.astimezone(timezone.utc)
    milliseconds = utc.microsecond // 1000
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{milliseconds:03d}Z"


def _claim_is_expired(expires_at: object, now: str) -> bool:
    if not isinstance(expires_at, str):
        return True
    try:
        return _parse_instant(expires_at) <= _parse_instant(now)
    except ValueError:
        return True


# Deterministic id scoped to source version: re-queueing the same kind for
# the same source at the same version is the same id, while a post-mutation
# replacement at the next version never collides with older in-flight work.
def record_item(db: Database, input: WorkItemInput, queued_at: str) -> WorkItemRecord:
    source_version = input.source_version if input.source_version is not None else 1
    work_item_id = f"w-{_source_id_of(input.source_ref)}-{input.kind}-v{source_version}"
    operation = input.operation
    if operation is None:
        operation = _operation_intent_for_row(input.kind, input.source_ref)
    derivations: list[_QueuedDerivationTarget] = [
        {
            "subjectKind": target.subject_kind,
            "subjectId": target.subject_id,
            "derivationType": target.derivation_type,
        }
        for target in (input.derivations if input.derivations is not None else [])
    ]
    payload = {
        "sourceVersion": source_version,
        "operation": _operation_payload(operation),
        "derivations": derivations,
    }
    db.prepare(
        """INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
           VALUES (?, ?, ?, ?, 'queued', ?, ?)"""
    ).run(
        work_item_id,
        input.owner,
        input.kind,
        _json(input.source_ref),
        queued_at,
        _json(payload),
    )
    return WorkItemRecord(
        work_item_id=work_item_id,
        owner=input.owner,
        kind=input.kind,
        source_ref=input.source_ref,
        status="queued",
        queued_at=queued_at,
    )


@dataclass(frozen=True, slots=True)
class EnqueueInput:
    owner: WorkOwner
    kind: WorkKind
    source_ref: WorkSourceRef
    derivations: Sequence[EnqueueDerivationTarget]
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
    derivations: Sequence[EnqueueDerivationTarget]
    expected_derivations: Sequence[ImmediateDerivationBoundary]
    operation: DurableWorkOperation | None = None
    source_version: int | None = None


@dataclass(frozen=True, slots=True)
class ImmediateClaimClaimed:
    item: ClaimedWorkItem
    outcome: Literal["claimed"] = "claimed"


@dataclass(frozen=True, slots=True)
class ImmediateClaimExpired:
    item: ClaimedWorkItem
    outcome: Literal["expired"] = "expired"


@dataclass(frozen=True, slots=True)
class ImmediateClaimQueued:
    work_item_id: str
    outcome: Literal["queued"] = "queued"


@dataclass(frozen=True, slots=True)
class ImmediateClaimInFlight:
    work_item_id: str
    outcome: Literal["in_flight"] = "in_flight"


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
    item = record_item(
        transaction.db,
        input,
        _iso_millis(transaction.clock()),
    )
    source_version = input.source_version if input.source_version is not None else 1
    upsert = transaction.db.prepare(
        """INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
           VALUES (?, ?, ?, 'pending', ?)
           ON CONFLICT (subject_kind, subject_id, derivation_type) DO UPDATE SET
             state = 'pending', content = NULL, reason = NULL, metadata = NULL,
             gaps = NULL, derived_at = NULL, source_version = excluded.source_version"""
    )
    for target in input.derivations:
        upsert.run(target.subject_kind, target.subject_id, target.derivation_type, source_version)
    transaction.post_commit_hook.add(lambda: transaction.poke(transaction.thread_id))
    return item


@dataclass(frozen=True, slots=True)
class ClaimTiming:
    now: str
    lease_duration_ms: int


def create_or_claim_immediate_work_item(
    db: Database,
    input: ImmediateClaimInput,
    claim_timing: ClaimTiming,
) -> ImmediateClaimOutcome:
    source_version = input.source_version if input.source_version is not None else 1
    queued_at = claim_timing.now
    claim_expires_at = _iso_millis(
        _parse_instant(claim_timing.now) + timedelta(milliseconds=claim_timing.lease_duration_ms)
    )
    source_ref_json = _json(input.source_ref)
    work_item_id = f"w-{_source_id_of(input.source_ref)}-{input.kind}-v{source_version}"
    current_boundary = db.prepare(
        """SELECT state, source_version FROM derivation
           WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?"""
    )

    def boundaries_match() -> bool:
        for target in input.expected_derivations:
            row = current_boundary.get(target.subject_kind, target.subject_id, target.derivation_type)
            if not target.exists:
                if row is not None:
                    return False
                continue
            if (
                row is None
                or row["state"] != target.state
                or int(row["source_version"]) != target.source_version
            ):
                return False
        return True

    def upsert_pending() -> None:
        upsert = db.prepare(
            """INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
               VALUES (?, ?, ?, 'pending', ?)
               ON CONFLICT (subject_kind, subject_id, derivation_type) DO UPDATE SET
                 state = 'pending', content = NULL, reason = NULL, metadata = NULL,
                 gaps = NULL, derived_at = NULL, source_version = excluded.source_version"""
        )
        for target in input.derivations:
            upsert.run(target.subject_kind, target.subject_id, target.derivation_type, source_version)

    def exact_live() -> dict[str, object] | None:
        return db.prepare(
            """SELECT work_item_id FROM work_item
               WHERE status IN ('queued', 'claimed') AND owner = ? AND kind = ? AND source_ref = ?
                 AND COALESCE(json_extract(payload, '$.sourceVersion'), 1) = ?
               LIMIT 1"""
        ).get(input.owner, input.kind, source_ref_json, source_version)

    db.exec("BEGIN IMMEDIATE;")
    try:
        head = db.prepare(
            """SELECT work_item_id, owner, kind, source_ref, status, queued_at,
                      claim_expires_at, payload
               FROM work_item WHERE status IN ('queued', 'claimed')
               ORDER BY rowid LIMIT 1"""
        ).get()
        if head is not None:
            raw_head = _raw_claim_row(head)
            head_source_version = _parse_work_payload(raw_head).source_version
            exact_operation = (
                head["owner"] == input.owner
                and head["kind"] == input.kind
                and head["source_ref"] == source_ref_json
                and (head_source_version if head_source_version is not None else 1) == source_version
            )
            if not exact_operation:
                live = exact_live()
                if live is not None:
                    db.exec("COMMIT;")
                    return ImmediateClaimInFlight(work_item_id=str(live["work_item_id"]))
                if not boundaries_match():
                    db.exec("COMMIT;")
                    return ImmediateClaimInFlight(work_item_id=work_item_id)
                item = record_item(db, input, queued_at)
                upsert_pending()
                db.exec("COMMIT;")
                return ImmediateClaimQueued(work_item_id=item.work_item_id)
            if not boundaries_match():
                db.exec("COMMIT;")
                return ImmediateClaimInFlight(work_item_id=str(head["work_item_id"]))
            if head["status"] == "claimed":
                expires = head["claim_expires_at"]
                if _claim_is_expired(expires, claim_timing.now):
                    item = _to_claimed_item(raw_head)
                    db.exec("COMMIT;")
                    return ImmediateClaimExpired(item=item)
                db.exec("COMMIT;")
                return ImmediateClaimInFlight(work_item_id=str(head["work_item_id"]))
            claimed = db.prepare(
                """UPDATE work_item SET status = 'claimed', claimed_at = ?, claim_expires_at = ?
                   WHERE work_item_id = ? AND status = 'queued'
                   RETURNING work_item_id, owner, kind, source_ref, queued_at, payload"""
            ).get(claim_timing.now, claim_expires_at, head["work_item_id"])
            if claimed is None:
                db.exec("COMMIT;")
                return ImmediateClaimInFlight(work_item_id=str(head["work_item_id"]))
            claimed_item = _to_claimed_item(_raw_claim_row(claimed))
            db.exec("COMMIT;")
            return ImmediateClaimClaimed(item=claimed_item)

        if not boundaries_match():
            db.exec("COMMIT;")
            return ImmediateClaimInFlight(work_item_id=work_item_id)
        item = record_item(db, input, queued_at)
        upsert_pending()
        claimed = db.prepare(
            """UPDATE work_item SET status = 'claimed', claimed_at = ?, claim_expires_at = ?
               WHERE work_item_id = ? AND status = 'queued'
               RETURNING work_item_id, owner, kind, source_ref, queued_at, payload"""
        ).get(claim_timing.now, claim_expires_at, item.work_item_id)
        if claimed is None:
            raise RuntimeError(f"failed to claim immediate work item {item.work_item_id}")
        claimed_item = _to_claimed_item(_raw_claim_row(claimed))
        db.exec("COMMIT;")
        return ImmediateClaimClaimed(item=claimed_item)
    except BaseException:
        db.exec("ROLLBACK;")
        raise


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
    derivations: Sequence[EnqueueDerivationTarget]
    operation: DurableWorkOperation | None = None


# Phase 2 conversion seam: ClaimedWorkItem (runtime snake dataclass) →
# WorkItemRef (handler TypedDict with camelCase keys). No named conversion
# exists in TS; this is the Python seam point.
def work_item_ref_of(item: ClaimedWorkItem) -> WorkItemRef:
    # NOMINAL-TYPING BOUNDARY: runtime dataclass to handler's camelCase shape.
    return {
        "workItemId": item.work_item_id,
        "kind": item.kind,
        "sourceRef": dict(item.source_ref),
    }


@dataclass(frozen=True, slots=True)
class ClaimOutcomeClaimed:
    item: ClaimedWorkItem
    outcome: Literal["claimed"] = "claimed"


@dataclass(frozen=True, slots=True)
class ClaimOutcomeExpired:
    item: ClaimedWorkItem
    outcome: Literal["expired"] = "expired"


@dataclass(frozen=True, slots=True)
class ClaimOutcomeEmpty:
    outcome: Literal["empty"] = "empty"


@dataclass(frozen=True, slots=True)
class ClaimOutcomeInFlight:
    claim_expires_at: str
    outcome: Literal["in_flight"] = "in_flight"


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
    """Parsed in-memory form of `_QueuedWorkItemPayload`.

    Phase 2 builds this FROM the stored camelCase TypedDict (JSON.parse of
    work_item.payload), then maps operation strings through operation_intent.
    """

    source_version: int | None = None
    operation: DurableWorkOperation | None = None
    derivations: list[EnqueueDerivationTarget] | None = None


def _parse_work_payload(row: _RawClaimRow) -> _WorkPayload:
    parsed = json.loads(row.payload)
    if not isinstance(parsed, dict):
        return _WorkPayload()
    source_version = parsed.get("sourceVersion")
    raw_derivations = parsed.get("derivations")
    derivations: list[EnqueueDerivationTarget] | None = None
    if isinstance(raw_derivations, list):
        derivations = []
        for target in raw_derivations:
            if not isinstance(target, dict):
                continue
            derivations.append(
                EnqueueDerivationTarget(
                    subject_kind=target["subjectKind"],
                    subject_id=target["subjectId"],
                    derivation_type=target["derivationType"],
                )
            )
    return _WorkPayload(
        source_version=source_version if isinstance(source_version, int) else None,
        operation=_parse_operation(parsed.get("operation")),
        derivations=derivations,
    )


# IMPORT-CYCLE SEAM: DurableWorkOperation is TYPE_CHECKING-only here because
# durable_work imports this module at top level. The Phase 2 body must import
# lazily: `from .durable_work import ...` inside this function.
def _operation_intent_for_row(kind: str, source_ref: WorkSourceRef) -> DurableWorkOperation | None:
    if kind not in WORK_KIND_REGISTRY:
        return None
    # IMPORT-CYCLE SEAM: durable_work imports work_queue at module load time.
    from ..durable_work import operation_intent

    return operation_intent(kind, source_ref)  # type: ignore[arg-type]


def _to_claimed_item(row: _RawClaimRow) -> ClaimedWorkItem:
    source_ref = json.loads(row.source_ref)
    payload = _parse_work_payload(row)
    operation = payload.operation
    if operation is None:
        operation = _operation_intent_for_row(row.kind, source_ref)
    return ClaimedWorkItem(
        work_item_id=row.work_item_id,
        owner=row.owner,  # type: ignore[arg-type]
        kind=row.kind,
        source_ref=source_ref,
        queued_at=row.queued_at,
        source_version=payload.source_version if payload.source_version is not None else 1,
        operation=operation,
        derivations=payload.derivations if payload.derivations is not None else [],
    )


def _raw_claim_row(row: dict[str, object]) -> _RawClaimRow:
    return _RawClaimRow(
        work_item_id=str(row["work_item_id"]),
        owner=str(row["owner"]),
        kind=str(row["kind"]),
        source_ref=str(row["source_ref"]),
        queued_at=str(row["queued_at"]),
        payload=str(row["payload"]),
    )


@dataclass(frozen=True, slots=True)
class DeleteClaimedItem:
    work_item_id: str


def delete_claimed_item(db: Database, item: DeleteClaimedItem) -> bool:
    db.exec("BEGIN IMMEDIATE;")
    try:
        deleted = db.prepare(
            "DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'"
        ).run(item.work_item_id)
        db.exec("COMMIT;")
        return int(getattr(deleted, "changes")) > 0
    except BaseException:
        db.exec("ROLLBACK;")
        raise


# Head-first, never skip-ahead: the claim decision is made against the oldest
# live row only. A queued head is claimed once. An expired claim is returned
# as dead work so the drain can fail it without running the handler again.
def claim_next(db: Database, now: str, lease_duration_ms: int) -> ClaimOutcome:
    expires_at = _iso_millis(_parse_instant(now) + timedelta(milliseconds=lease_duration_ms))
    db.exec("BEGIN IMMEDIATE;")
    try:
        head = db.prepare(
            """SELECT work_item_id, owner, kind, source_ref, status, queued_at,
                      claim_expires_at, payload
               FROM work_item WHERE status IN ('queued', 'claimed')
               ORDER BY rowid LIMIT 1"""
        ).get()
        if head is None:
            db.exec("COMMIT;")
            return ClaimOutcomeEmpty()
        raw_head = _raw_claim_row(head)
        if head["status"] == "claimed":
            expiry = head["claim_expires_at"]
            item = _to_claimed_item(raw_head)
            db.exec("COMMIT;")
            if _claim_is_expired(expiry, now):
                return ClaimOutcomeExpired(item=item)
            return ClaimOutcomeInFlight(claim_expires_at=expiry)
        claimed = db.prepare(
            """UPDATE work_item SET status = 'claimed', claimed_at = ?, claim_expires_at = ?
               WHERE work_item_id = ? AND status = 'queued'
               RETURNING work_item_id, owner, kind, source_ref, queued_at, payload"""
        ).get(now, expires_at, head["work_item_id"])
        if claimed is None:
            raise RuntimeError(f"failed to claim queued work item {head['work_item_id']}")
        item = _to_claimed_item(_raw_claim_row(claimed))
        db.exec("COMMIT;")
        return ClaimOutcomeClaimed(item=item)
    except BaseException:
        db.exec("ROLLBACK;")
        raise


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
    # IMPORT-CYCLE SEAM: durable_work imports work_queue at module load time.
    from ..durable_work import DerivationCompletionError, assert_exact_derivation_writes
    from ..persist import create_post_commit_hook_set

    post_commit_hook = create_post_commit_hook_set()
    db.exec("BEGIN IMMEDIATE;")
    try:
        owned = db.prepare(
            "SELECT 1 FROM work_item WHERE work_item_id = ? AND status = 'claimed'"
        ).get(item.work_item_id)
        if owned is None:
            db.exec("COMMIT;")
            return "lost_lease"
        assert_exact_derivation_writes(item.derivations, writes)
        hits = 0
        misses = 0
        update = db.prepare(
            """UPDATE derivation
               SET state = 'ready', content = ?, reason = NULL, metadata = ?,
                   gaps = NULL, derived_at = ?
               WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?
                 AND source_version = ?"""
        )
        for write in writes:
            changed = update.run(
                write.content,
                None if write.metadata is None else _json(write.metadata),
                derived_at,
                write.subject_kind,
                write.subject_id,
                write.derivation_type,
                item.source_version,
            )
            count = int(getattr(changed, "changes"))
            if count == 0:
                misses += 1
            if count > 1:
                raise DerivationCompletionError(
                    f"derivation completion write hit {count} rows for {_target_key(write)} "
                    f"at sourceVersion {item.source_version}"
                )
            hits += count
        stale = len(writes) > 0 and hits == 0
        if not stale and misses > 0:
            raise DerivationCompletionError(
                f"derivation completion partially hit {hits} of {len(writes)} rows "
                f"at sourceVersion {item.source_version}"
            )
        if not stale and on_applied is not None:
            on_applied(CompletionTx(db=db, on_commit=post_commit_hook.add))
        db.prepare(
            "DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'"
        ).run(item.work_item_id)
        db.exec("COMMIT;")
        post_commit_hook.flush()
        return "stale_discarded" if stale else "done"
    except BaseException:
        db.exec("ROLLBACK;")
        raise


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
    ids: list[str] = []
    remove = db.prepare(
        """DELETE FROM work_item WHERE status = 'queued' AND kind = ? AND source_ref = ?
           RETURNING work_item_id"""
    )
    for target in targets:
        for row in remove.all(target.kind, _json(target.source_ref)):
            ids.append(str(row["work_item_id"]))
    return ids


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
    row = db.prepare(
        """SELECT 1 FROM work_item
           WHERE status IN ('queued', 'claimed') AND kind = ? AND source_ref = ?
             AND COALESCE(json_extract(payload, '$.sourceVersion'), 1) = ?
           LIMIT 1"""
    ).get(kind, _json(source_ref), source_version)
    return row is not None


# Live items left in the queue; used by drain reporting and owner repair reports.
def count_live_items(db: Database) -> int:
    row = db.prepare(
        "SELECT COUNT(*) AS n FROM work_item WHERE status IN ('queued', 'claimed')"
    ).get()
    if row is None:
        return 0
    return int(row["n"])


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
    rows = db.prepare(
        """SELECT work_item_id, owner, kind, source_ref, status, claimed_at,
                  claim_expires_at, queued_at, payload
           FROM work_item ORDER BY rowid"""
    ).all()
    details: list[QueueDetailRow] = []
    for row in rows:
        item = _to_claimed_item(_raw_claim_row(row))
        details.append(
            QueueDetailRow(
                work_item_id=item.work_item_id,
                owner=item.owner,
                kind=item.kind,
                source_ref=item.source_ref,
                status=str(row["status"]),  # type: ignore[arg-type]
                queued_at=item.queued_at,
                source_version=item.source_version,
                claimed_at=str(row["claimed_at"]) if row["claimed_at"] is not None else None,
                claim_expires_at=(
                    str(row["claim_expires_at"]) if row["claim_expires_at"] is not None else None
                ),
            )
        )
    return details


# Listing in queue order (insertion order within the walk); each owning
# domain lists only its own items.
def list_items(db: Database, owner: WorkOwner) -> list[WorkItemRecord]:
    rows = db.prepare(
        """SELECT work_item_id, owner, kind, source_ref, queued_at
           FROM work_item WHERE owner = ? ORDER BY rowid"""
    ).all(owner)
    return [
        WorkItemRecord(
            work_item_id=str(row["work_item_id"]),
            owner=str(row["owner"]),  # type: ignore[arg-type]
            kind=str(row["kind"]),  # type: ignore[arg-type]
            source_ref=json.loads(str(row["source_ref"])),
            status="queued",
            queued_at=str(row["queued_at"]),
        )
        for row in rows
    ]
