"""Ported from packages/lhc/src/messages/internal/cascade.ts.

The mutation cascade walks the derivation chain upward from the mutated
subject: the message's own derivations, its turn derivations, and the
containing chunk summaries. Each cleared row moves to `pending` at the next
source version and replacement work is enqueued inside the caller's mutation
transaction.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace

from ...shared_tech.derivation import SubjectKind
from ...shared_tech.persist import DbWriteTransaction
from ...shared_tech.storage import Database
from ...shared_tech.work_queue import (
    EnqueueDerivationTarget,
    EnqueueInput,
    WORK_KIND_REGISTRY,
    WorkKind,
    WorkSourceRef,
    enqueue,
    supersede_queued,
    _SupersedeTarget,
)

# Replacement work for one subject may fan out across several kinds; enqueue
# in dependency order so turn_derivation lands pre_detailed_assembly before
# detailed_turn_compression, and both finish before chunk summaries consume them.
_REBUILD_KIND_ORDER: dict[WorkKind, int] = {
    "prompt_smoothing": 0,
    "tool_result_summary": 1,
    "turn_derivation": 2,
    "detailed_turn_compression": 3,
    "chunk_summary_detailed": 4,
    "chunk_summary_brief": 5,
}

# Each derivation's rebuild queue-site — the owning domains' enqueue mappings,
# gathered here because the cascade is the one place that re-queues across
# the whole chain. Both turn derivations ride the one turn_derivation item;
# detailed_turn_compression rides its own kind; every other derivation rides
# its same-named kind.
_DERIVATION_REBUILD_KINDS: dict[str, WorkKind] = {
    "smoothed_prompt": "prompt_smoothing",
    "tool_result_summary": "tool_result_summary",
    "turn_rendering": "turn_derivation",
    "pre_detailed_assembly": "turn_derivation",
    "detailed_turn_compression": "detailed_turn_compression",
    "chunk_summary_detailed": "chunk_summary_detailed",
    "chunk_summary_brief": "chunk_summary_brief",
}

_SQL_CHAIN_TURN = """SELECT turn_id FROM message WHERE message_id = ?"""

_SQL_CHAIN_CHUNK = """SELECT chunk_id FROM chunk_member WHERE turn_id = ?"""

_SQL_PAIRED_OWN_BLOCK = (
    """SELECT block_type, json_extract(content, '$.toolCallId') AS tool_call_id
       FROM message_block
       WHERE message_id = ? AND block_type IN ('tool_call', 'tool_result')
       LIMIT 1"""
)

_SQL_PAIRED_COUNTERPART = (
    """SELECT m.message_id FROM message_block b
       JOIN message m ON m.message_id = b.message_id AND m.deleted_at IS NULL
       WHERE b.block_type = ? AND json_extract(b.content, '$.toolCallId') = ?
         AND m.message_id <> ?
       ORDER BY m.source_event_order LIMIT 1"""
)

_SQL_READ_DERIVATIONS = (
    """SELECT derivation_type, source_version FROM derivation
     WHERE subject_kind = ? AND subject_id = ? ORDER BY derivation_type"""
)

_SQL_DROP_DERIVATIONS = """DELETE FROM derivation WHERE subject_kind = ? AND subject_id = ?"""


@dataclass(frozen=True, slots=True)
class CascadeClear:
    subject_kind: SubjectKind
    subject_id: str
    derivation_type: str


@dataclass(frozen=True, slots=True)
class CascadeQueued:
    work_item_id: str
    kind: WorkKind


@dataclass(frozen=True, slots=True)
class CascadeOutcome:
    cleared: list[CascadeClear]
    dropped: list[CascadeClear]
    queued: list[CascadeQueued]
    superseded: list[str]


@dataclass(frozen=True, slots=True)
class _ChainSubject:
    subject_kind: SubjectKind
    subject_id: str


def _source_ref_for(subject: _ChainSubject) -> WorkSourceRef:
    if subject.subject_kind == "message":
        return {"messageId": subject.subject_id}
    if subject.subject_kind == "turn":
        return {"turnId": subject.subject_id}
    return {"chunkId": subject.subject_id}


# The structural walk: the mutated message's turn from its membership stamp,
# the turn's chunk from its placement row. The chunk link may be absent for an
# unplaced turn, and the chain stops there. Deliberately unfiltered: the walk
# runs after a delete stamps its subject, and the chain above a just-deleted
# record is exactly what must still cascade.
def _chain_subjects(db: Database, message_id: str) -> list[_ChainSubject]:
    subjects: list[_ChainSubject] = [
        _ChainSubject(subject_kind="message", subject_id=message_id)
    ]
    turn_row = db.prepare(_SQL_CHAIN_TURN).get(message_id)
    if turn_row is None:
        return subjects
    turn_id = str(turn_row["turn_id"])
    subjects.append(_ChainSubject(subject_kind="turn", subject_id=turn_id))
    chunk_row = db.prepare(_SQL_CHAIN_CHUNK).get(turn_id)
    if chunk_row is not None:
        subjects.append(
            _ChainSubject(subject_kind="chunk", subject_id=str(chunk_row["chunk_id"]))
        )
    return subjects


# A tool summary derives from its message and paired counterpart, so mutating
# one half is a source change for the counterpart's summary. Find the live
# counterpart of a mutated tool message — the opposite block type sharing its
# toolCallId — as a clear subject.
def _paired_counterpart_subject(db: Database, message_id: str) -> _ChainSubject | None:
    own = db.prepare(_SQL_PAIRED_OWN_BLOCK).get(message_id)
    if own is None or own["tool_call_id"] is None:
        return None
    counterpart_type = "tool_result" if str(own["block_type"]) == "tool_call" else "tool_call"
    row = db.prepare(_SQL_PAIRED_COUNTERPART).get(
        counterpart_type, str(own["tool_call_id"]), message_id
    )
    if row is None:
        return None
    return _ChainSubject(subject_kind="message", subject_id=str(row["message_id"]))


@dataclass(frozen=True, slots=True)
class _RebuildGroup:
    subject: _ChainSubject
    kind: WorkKind
    derivations: list[EnqueueDerivationTarget]
    max_source_version: int


def _rebuild_kind_for(derivation_type: str) -> WorkKind:
    kind = _DERIVATION_REBUILD_KINDS.get(derivation_type)
    if kind is None:
        raise RuntimeError(f"no rebuild work kind mapped for derivation {derivation_type}")
    return kind


# Shared cascade core: drop subjects lose their derivation rows outright; clear
# subjects go pending at the next source version with replacement work
# enqueued. Supersede-deletes land before replacement enqueues so a tidied id
# can never collide, and queued items against dropped subjects are tidied with
# no replacement: dead work for a source that no longer reads.
def _run_cascade(
    transaction: DbWriteTransaction,
    drop_subjects: Sequence[_ChainSubject],
    clear_subjects: Sequence[_ChainSubject],
) -> CascadeOutcome:
    read_derivations = transaction.db.prepare(_SQL_READ_DERIVATIONS)

    dropped: list[CascadeClear] = []
    supersede_targets: list[_SupersedeTarget] = []
    drop_rows = transaction.db.prepare(_SQL_DROP_DERIVATIONS)
    for subject in drop_subjects:
        rows = read_derivations.all(subject.subject_kind, subject.subject_id)
        # Insertion-ordered like TS Set (derivations ORDER BY type).
        kinds: dict[WorkKind, None] = {}
        for row in rows:
            dropped.append(
                CascadeClear(
                    subject_kind=subject.subject_kind,
                    subject_id=subject.subject_id,
                    derivation_type=str(row["derivation_type"]),
                )
            )
            kinds[_rebuild_kind_for(str(row["derivation_type"]))] = None
        for kind in kinds:
            supersede_targets.append(
                _SupersedeTarget(kind=kind, source_ref=_source_ref_for(subject))
            )
        drop_rows.run(subject.subject_kind, subject.subject_id)

    cleared: list[CascadeClear] = []
    groups: dict[str, _RebuildGroup] = {}
    for subject in clear_subjects:
        rows = read_derivations.all(subject.subject_kind, subject.subject_id)
        for row in rows:
            derivation_type = str(row["derivation_type"])
            cleared.append(
                CascadeClear(
                    subject_kind=subject.subject_kind,
                    subject_id=subject.subject_id,
                    derivation_type=derivation_type,
                )
            )
            kind = _rebuild_kind_for(derivation_type)
            key = f"{subject.subject_kind}:{subject.subject_id}:{kind}"
            target = EnqueueDerivationTarget(
                subject_kind=subject.subject_kind,
                subject_id=subject.subject_id,
                derivation_type=derivation_type,
            )
            group = groups.get(key)
            if group is None:
                groups[key] = _RebuildGroup(
                    subject=subject,
                    kind=kind,
                    derivations=[target],
                    max_source_version=int(row["source_version"]),
                )
            else:
                groups[key] = replace(
                    group,
                    derivations=[*group.derivations, target],
                    max_source_version=max(
                        group.max_source_version, int(row["source_version"])
                    ),
                )

    superseded = supersede_queued(
        transaction.db,
        [
            *supersede_targets,
            *[
                _SupersedeTarget(
                    kind=group.kind, source_ref=_source_ref_for(group.subject)
                )
                for group in groups.values()
            ],
        ],
    )

    queued = [
        CascadeQueued(
            work_item_id=enqueue(
                transaction,
                EnqueueInput(
                    owner=WORK_KIND_REGISTRY[group.kind].owner,
                    kind=group.kind,
                    source_ref=_source_ref_for(group.subject),
                    source_version=group.max_source_version + 1,
                    derivations=group.derivations,
                ),
            ).work_item_id,
            kind=group.kind,
        )
        for group in sorted(
            groups.values(), key=lambda g: _REBUILD_KIND_ORDER[g.kind]
        )
    ]

    return CascadeOutcome(
        cleared=cleared,
        dropped=dropped,
        queued=queued,
        superseded=superseded,
    )


# Edit's close path: clear-and-requeue for the full chain above (and
# including) the edited message, inside the mutation's ambient transaction.
# A call/result pair counterpart joins the clear set: editing one half is a
# source change for the other's summary.
def cascade_from_message(transaction: DbWriteTransaction, message_id: str) -> CascadeOutcome:
    clear = _chain_subjects(transaction.db, message_id)
    counterpart = _paired_counterpart_subject(transaction.db, message_id)
    if counterpart is not None:
        clear.append(counterpart)
    return _run_cascade(transaction, [], clear)


# Message delete drops the deleted message's own derivations; its turn and
# chunk clear and re-queue for minus-one composition. Message-delete validation
# refuses turn-initiating prompts, so the turn always keeps members and never
# empties through this path.
def cascade_message_delete(transaction: DbWriteTransaction, message_id: str) -> CascadeOutcome:
    chain = _chain_subjects(transaction.db, message_id)
    own = chain[0] if chain else None
    upward = chain[1:] if len(chain) > 1 else []
    counterpart = _paired_counterpart_subject(transaction.db, message_id)
    if counterpart is not None:
        upward.append(counterpart)
    return _run_cascade(transaction, [] if own is None else [own], upward)
