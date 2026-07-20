"""Ported from packages/lhc/src/messages/internal/cascade.ts. Phase 1 skeleton.

The mutation cascade walks the derivation chain upward from the mutated
subject: the message's own derivations, its turn derivations, and the
containing chunk summaries. Each cleared row moves to `pending` at the next
source version and replacement work is enqueued inside the caller's mutation
transaction.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from ...shared_tech.derivation import SubjectKind
from ...shared_tech.persist import DbWriteTransaction
from ...shared_tech.storage import Database
from ...shared_tech.work_queue import EnqueueDerivationTarget, WorkKind, WorkSourceRef

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
    raise NotImplementedError


# The structural walk: the mutated message's turn from its membership stamp,
# the turn's chunk from its placement row. The chunk link may be absent for an
# unplaced turn, and the chain stops there. Deliberately unfiltered: the walk
# runs after a delete stamps its subject, and the chain above a just-deleted
# record is exactly what must still cascade.
def _chain_subjects(db: Database, message_id: str) -> list[_ChainSubject]:
    raise NotImplementedError


# A tool summary derives from its message and paired counterpart, so mutating
# one half is a source change for the counterpart's summary. Find the live
# counterpart of a mutated tool message — the opposite block type sharing its
# toolCallId — as a clear subject.
def _paired_counterpart_subject(db: Database, message_id: str) -> _ChainSubject | None:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _RebuildGroup:
    subject: _ChainSubject
    kind: WorkKind
    derivations: list[EnqueueDerivationTarget]
    max_source_version: int


def _rebuild_kind_for(derivation_type: str) -> WorkKind:
    raise NotImplementedError


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
    raise NotImplementedError


# Edit's close path: clear-and-requeue for the full chain above (and
# including) the edited message, inside the mutation's ambient transaction.
# A call/result pair counterpart joins the clear set: editing one half is a
# source change for the other's summary.
def cascade_from_message(transaction: DbWriteTransaction, message_id: str) -> CascadeOutcome:
    raise NotImplementedError


# Message delete drops the deleted message's own derivations; its turn and
# chunk clear and re-queue for minus-one composition. Message-delete validation
# refuses turn-initiating prompts, so the turn always keeps members and never
# empties through this path.
def cascade_message_delete(transaction: DbWriteTransaction, message_id: str) -> CascadeOutcome:
    raise NotImplementedError
