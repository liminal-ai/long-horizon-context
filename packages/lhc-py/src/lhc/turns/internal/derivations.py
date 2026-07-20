"""Ported from packages/lhc/src/turns/internal/derivations.ts. Phase 1 skeleton.

Turn-domain reads for derivation: the turn handler's source turn, its
deleted-filtered member messages, the message-level derivation rows used for
composition, and the stored member material chunk summaries consume.
Completion writes for turn- and chunk-owned derivations ride the work-queue
util's version-checked completion path; this module has no write path.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from ...shared_tech.derivation import Derivation, DerivationReportEntry, DerivationState
from ...shared_tech.storage import Database
from .compose import ComposeBlock, ComposeDerivationRow, ComposeMessage, compose_derivation_key
from ...shared_tech.derivation import DerivationMetadata

_SQL_READ_TURN_SOURCE = """SELECT status, deleted_at FROM turns WHERE turn_id = ?"""

_SQL_READ_MEMBER_MESSAGES = (
    """SELECT message_id, kind FROM message
       WHERE turn_id = ? AND deleted_at IS NULL ORDER BY source_event_order"""
)

_SQL_READ_MESSAGE_BLOCKS = (
    """SELECT block_type, content FROM message_block
     WHERE message_id = ? ORDER BY block_index"""
)

_SQL_READ_MESSAGE_DERIVATION_ROWS_PREFIX = (
    """SELECT subject_id, derivation_type, state, content, reason, metadata, source_version
       FROM derivation
       WHERE subject_kind = 'message' AND subject_id IN ("""
)

_SQL_READ_MESSAGE_DERIVATION_ROWS_SUFFIX = """)"""

_SQL_READ_MEMBER_PROJECTIONS = (
    """SELECT cm.turn_id, t.turn_id AS existing_turn_id, t.deleted_at,
              df.state, df.content,
              af.state AS assembly_state, af.content AS assembly_content,
              rf.state AS rendering_state, rf.content AS rendering_content
       FROM chunk_member cm
       LEFT JOIN turns t ON t.turn_id = cm.turn_id
       LEFT JOIN derivation df ON df.subject_kind = 'turn'
         AND df.subject_id = cm.turn_id AND df.derivation_type = 'detailed_turn_compression'
       LEFT JOIN derivation af ON af.subject_kind = 'turn'
         AND af.subject_id = cm.turn_id AND af.derivation_type = 'pre_detailed_assembly'
       LEFT JOIN derivation rf ON rf.subject_kind = 'turn'
         AND rf.subject_id = cm.turn_id AND rf.derivation_type = 'turn_rendering'
       WHERE cm.chunk_id = ? ORDER BY cm.member_idx"""
)

_SQL_READ_OWNED_DERIVATIONS = (
    """SELECT subject_id, derivation_type, state, content, reason, metadata,
              source_version, gaps, derived_at
       FROM derivation WHERE subject_kind = ?
       ORDER BY subject_id, derivation_type"""
)

_SQL_READ_CHUNK_ROWS = (
    """SELECT chunk_id, chunk_order, status, accumulated_projected_tokens
       FROM chunk ORDER BY chunk_order"""
)

_SQL_READ_CHUNK_ROW_MEMBERS = (
    """SELECT cm.turn_id FROM chunk_member cm
     JOIN turns t ON t.turn_id = cm.turn_id AND t.deleted_at IS NULL
     WHERE cm.chunk_id = ? ORDER BY cm.member_idx"""
)

_SQL_READ_TURN_DERIVATION_ROW = (
    """SELECT state, content, reason, source_version FROM derivation
       WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?"""
)

_SQL_READ_CHUNK_SUMMARY_DERIVATION = (
    """SELECT state, content, reason, source_version FROM derivation
       WHERE subject_kind = 'chunk' AND subject_id = ? AND derivation_type = ?"""
)

# The derivation_type→kind CASE is the turns owner's own queue-site mapping.
# turn_rendering and pre_detailed_assembly map to turn_derivation;
# detailed_turn_compression maps to its same-named kind; chunk summaries map
# to their same-named kinds.
_SQL_REPORT_TURN_DERIVATIONS = (
    """SELECT df.subject_kind, df.subject_id, df.derivation_type, df.state, df.content, df.reason,
              df.metadata, df.source_version, df.gaps, df.derived_at,
              w.status AS queue_status
       FROM derivation df
       LEFT JOIN work_item w
         ON w.status IN ('queued', 'claimed')
        AND w.kind = CASE
          WHEN df.derivation_type IN ('turn_rendering', 'pre_detailed_assembly') THEN 'turn_derivation'
          WHEN df.derivation_type = 'detailed_turn_compression' THEN 'detailed_turn_compression'
          WHEN df.subject_kind = 'chunk' THEN df.derivation_type
          ELSE 'turn_derivation'
        END
        AND json_extract(
              w.source_ref,
              CASE WHEN df.subject_kind = 'turn' THEN '$.turnId' ELSE '$.chunkId' END
            ) = df.subject_id
        AND COALESCE(json_extract(w.payload, '$.sourceVersion'), 1) = df.source_version
       WHERE {conditions}
       ORDER BY df.subject_kind DESC, df.subject_id, df.derivation_type"""
)

_SQL_CHUNK_EXISTS = """SELECT 1 FROM chunk WHERE chunk_id = ?"""


@dataclass(frozen=True, slots=True)
class TurnSource:
    turn_id: str
    status: Literal["open", "closed"]
    deleted: bool


def read_turn_source(db: Database, turn_id: str) -> TurnSource | None:
    row = db.prepare(_SQL_READ_TURN_SOURCE).get(turn_id)
    if row is None:
        return None
    return TurnSource(
        turn_id=turn_id,
        status=str(row["status"]),  # type: ignore[arg-type]
        deleted=row["deleted_at"] is not None,
    )


# Member messages in message order, blocks attached, deleted messages filtered.
# Composition always reads the live member set.
def read_member_messages(db: Database, turn_id: str) -> list[ComposeMessage]:
    result: list[ComposeMessage] = []
    block_stmt = db.prepare(_SQL_READ_MESSAGE_BLOCKS)
    for row in db.prepare(_SQL_READ_MEMBER_MESSAGES).all(turn_id):
        blocks = [
            ComposeBlock(
                block_type=str(block["block_type"]),
                content=json.loads(str(block["content"])),
            )
            for block in block_stmt.all(row["message_id"])
        ]
        result.append(
            ComposeMessage(
                message_id=str(row["message_id"]),
                kind=str(row["kind"]),  # type: ignore[arg-type]
                blocks=blocks,
            )
        )
    return result


# The message-owned derivation rows for a set of member messages, keyed for
# composition. This is a cross-owner read only; message handlers remain the
# only writers for message derivations.
def read_message_derivation_rows(
    db: Database,
    message_ids: Sequence[str],
) -> dict[str, ComposeDerivationRow]:
    if not message_ids:
        return {}
    placeholders = ", ".join("?" for _ in message_ids)
    rows = db.prepare(
        _SQL_READ_MESSAGE_DERIVATION_ROWS_PREFIX
        + placeholders
        + _SQL_READ_MESSAGE_DERIVATION_ROWS_SUFFIX
    ).all(*message_ids)
    result: dict[str, ComposeDerivationRow] = {}
    from ...shared_tech.derivation import decode_derivation_metadata

    for row in rows:
        metadata = None
        if row["metadata"] is not None:
            metadata = decode_derivation_metadata(json.loads(str(row["metadata"])))
        subject_id = str(row["subject_id"])
        derivation_type = str(row["derivation_type"])
        result[compose_derivation_key(subject_id, derivation_type)] = ComposeDerivationRow(
            state=str(row["state"]),  # type: ignore[arg-type]
            source_version=int(row["source_version"]),
            content=str(row["content"]) if row["content"] is not None else None,
            metadata=metadata,
            reason=str(row["reason"]) if row["reason"] is not None else None,
        )
    return result


# Stored member material in turn order for chunk summaries: every chunk_member
# row by member_idx, joined to its canonical turn, stored
# detailed_turn_compression row, and pre_detailed_assembly for failed floors.
# Missing turns are returned as source corruption so background summaries
# block instead of silently summarizing a shortened member list; SDK
# soft-deleted turns stay filtered because sanctioned delete rebuilds chunk
# summaries from survivors.
@dataclass(frozen=True, slots=True)
class MemberProjection:
    turn_id: str
    state: str | None = None  # None: no compression row exists for the member
    content: str | None = None
    assembly_state: str | None = None
    assembly_content: str | None = None
    rendering_state: str | None = None
    rendering_content: str | None = None
    source_corruption_reason: str | None = None


def read_member_projections(db: Database, chunk_id: str) -> list[MemberProjection]:
    rows = db.prepare(_SQL_READ_MEMBER_PROJECTIONS).all(chunk_id)
    result: list[MemberProjection] = []
    for row in rows:
        if row["deleted_at"] is not None:
            continue
        turn_id = str(row["turn_id"])
        source_corruption_reason = None
        if row["existing_turn_id"] is None:
            source_corruption_reason = (
                f"canonical record corrupt: chunk {chunk_id} member {turn_id} "
                "references missing turn"
            )
        result.append(
            MemberProjection(
                turn_id=turn_id,
                state=None if row["state"] is None else str(row["state"]),
                content=None if row["content"] is None else str(row["content"]),
                assembly_state=(
                    None
                    if row["assembly_state"] is None
                    else str(row["assembly_state"])
                ),
                assembly_content=(
                    None
                    if row["assembly_content"] is None
                    else str(row["assembly_content"])
                ),
                rendering_state=(
                    None
                    if row["rendering_state"] is None
                    else str(row["rendering_state"])
                ),
                rendering_content=(
                    None
                    if row["rendering_content"] is None
                    else str(row["rendering_content"])
                ),
                source_corruption_reason=source_corruption_reason,
            )
        )
    return result


@dataclass(frozen=True, slots=True)
class _RawOwnedDerivationRow:
    subject_id: str
    derivation_type: str
    state: str
    content: str | None
    reason: str | None
    metadata: str | None
    source_version: int
    gaps: str | None
    derived_at: str | None


# Every derivation row this owner holds for one subject kind, grouped by subject
# id. Rows come back exactly as the pipeline landed them; nothing is derived at
# read time.
def read_owned_derivations(
    db: Database,
    subject_kind: Literal["turn", "chunk"],
) -> dict[str, list[Derivation]]:
    from ...shared_tech.derivation import DependencyGap, decode_derivation_metadata

    rows = db.prepare(_SQL_READ_OWNED_DERIVATIONS).all(subject_kind)
    by_subject: dict[str, list[Derivation]] = {}
    for row in rows:
        subject_id = str(row["subject_id"])
        metadata = None
        if row["metadata"] is not None:
            metadata = decode_derivation_metadata(json.loads(str(row["metadata"])))
        gaps = None
        if row["gaps"] is not None:
            raw_gaps = json.loads(str(row["gaps"]))
            gaps = [
                DependencyGap(
                    subject_kind=str(gap["subjectKind"]),  # type: ignore[arg-type]
                    subject_id=str(gap["subjectId"]),
                    derivation_type=str(gap["derivationType"]),
                )
                for gap in raw_gaps
            ]
        record = Derivation(
            subject_kind=subject_kind,
            subject_id=subject_id,
            derivation_type=str(row["derivation_type"]),
            state=str(row["state"]),  # type: ignore[arg-type]
            source_version=int(row["source_version"]),
            content=None if row["content"] is None else str(row["content"]),
            reason=None if row["reason"] is None else str(row["reason"]),
            gaps=gaps,
            metadata=metadata,
            derived_at=None if row["derived_at"] is None else str(row["derived_at"]),
        )
        bucket = by_subject.get(subject_id)
        if bucket is None:
            bucket = []
            by_subject[subject_id] = bucket
        bucket.append(record)
    return by_subject


# Chunk read-back rows for the list_chunks surface: stored chunk state plus
# live (deleted-filtered) membership in member order.
@dataclass(frozen=True, slots=True)
class ChunkReadRow:
    chunk_id: str
    chunk_order: int
    status: Literal["open", "closed"]
    accumulated_projected_tokens: int
    member_turn_ids: list[str]


def read_chunk_rows(db: Database) -> list[ChunkReadRow]:
    chunks = db.prepare(_SQL_READ_CHUNK_ROWS).all()
    member_stmt = db.prepare(_SQL_READ_CHUNK_ROW_MEMBERS)
    return [
        ChunkReadRow(
            chunk_id=str(row["chunk_id"]),
            chunk_order=int(row["chunk_order"]),
            status=str(row["status"]),  # type: ignore[arg-type]
            accumulated_projected_tokens=int(row["accumulated_projected_tokens"]),
            member_turn_ids=[
                str(member["turn_id"]) for member in member_stmt.all(row["chunk_id"])
            ],
        )
        for row in chunks
    ]


# One derivation row by exact key for this owner's subjects — the requeue
# operation's refusal read (missing row, blocked state, current version).
@dataclass(frozen=True, slots=True)
class TurnDerivationRowView:
    state: DerivationState
    source_version: int
    content: str | None = None
    reason: str | None = None


def read_turn_derivation_row(
    db: Database,
    subject_kind: Literal["turn", "chunk"],
    subject_id: str,
    derivation: str,
) -> TurnDerivationRowView | None:
    row = db.prepare(_SQL_READ_TURN_DERIVATION_ROW).get(
        subject_kind, subject_id, derivation
    )
    if row is None:
        return None
    return TurnDerivationRowView(
        state=str(row["state"]),  # type: ignore[arg-type]
        source_version=int(row["source_version"]),
        content=str(row["content"]) if row["content"] is not None else None,
        reason=str(row["reason"]) if row["reason"] is not None else None,
    )


def read_chunk_summary_derivation(
    db: Database,
    chunk_id: str,
    derivation_type: Literal["chunk_summary_detailed", "chunk_summary_brief"],
) -> TurnDerivationRowView | None:
    row = db.prepare(_SQL_READ_CHUNK_SUMMARY_DERIVATION).get(
        chunk_id, derivation_type
    )
    if row is None:
        return None
    return TurnDerivationRowView(
        state=str(row["state"]),  # type: ignore[arg-type]
        source_version=int(row["source_version"]),
        content=str(row["content"]) if row["content"] is not None else None,
        reason=str(row["reason"]) if row["reason"] is not None else None,
    )


@dataclass(frozen=True, slots=True)
class TurnReportOptions:
    not_ready: bool | None = None
    turn_id: str | None = None
    chunk_id: str | None = None


# The turns owner's report: one query over turn- and chunk-owned derivation rows
# LEFT JOINed with the live work_item targeting each derivation at its current
# source version. turn_rendering and pre_detailed_assembly map to turn_derivation;
# detailed_turn_compression maps to its same-named kind; chunk summaries map
# to their same-named kinds.
def report_turn_derivations(
    db: Database,
    opts: TurnReportOptions | None = None,
) -> list[DerivationReportEntry]:
    from ...shared_tech.report import RawReportRow, report_entry_from_row

    options = opts if opts is not None else TurnReportOptions()
    conditions = ["df.subject_kind IN ('turn', 'chunk')"]
    params: list[str] = []
    subject_filters: list[str] = []
    if options.turn_id is not None:
        subject_filters.append("(df.subject_kind = 'turn' AND df.subject_id = ?)")
        params.append(options.turn_id)
    if options.chunk_id is not None:
        subject_filters.append("(df.subject_kind = 'chunk' AND df.subject_id = ?)")
        params.append(options.chunk_id)
    if len(subject_filters) > 0:
        conditions.append(f"({' OR '.join(subject_filters)})")
    # notReady is exact set equality by construction: every state but ready.
    if options.not_ready is True:
        conditions.append("df.state <> 'ready'")
    rows = db.prepare(
        _SQL_REPORT_TURN_DERIVATIONS.format(conditions=" AND ".join(conditions))
    ).all(*params)
    return [
        report_entry_from_row(
            str(row["subject_kind"]),  # type: ignore[arg-type]
            RawReportRow(
                subject_id=str(row["subject_id"]),
                derivation_type=str(row["derivation_type"]),
                state=str(row["state"]),
                content=None if row["content"] is None else str(row["content"]),
                reason=None if row["reason"] is None else str(row["reason"]),
                metadata=None if row["metadata"] is None else str(row["metadata"]),
                source_version=int(row["source_version"]),
                gaps=None if row["gaps"] is None else str(row["gaps"]),
                derived_at=None if row["derived_at"] is None else str(row["derived_at"]),
                queue_status=(
                    None if row["queue_status"] is None else str(row["queue_status"])
                ),
            ),
        )
        for row in rows
    ]


def chunk_exists(db: Database, chunk_id: str) -> bool:
    return db.prepare(_SQL_CHUNK_EXISTS).get(chunk_id) is not None
