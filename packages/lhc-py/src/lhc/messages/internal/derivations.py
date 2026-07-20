"""Ported from packages/lhc/src/messages/internal/derivations.ts. Phase 1 skeleton.

Message-domain reads for derivation: a handler can read its source message
and call-id pair, nothing more. Pair lookup is one indexed query by call id,
never a block scan, drain-time sweep, or read-time join. Completion writes
ride the work-queue util's version-checked `complete`; no write path lives
here. Read-back returns stored message-owned derivation rows as stored, never
re-derived on read.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from ...shared_tech.derivation import (
    DependencyGap,
    Derivation,
    DerivationMetadata,
    DerivationReportEntry,
    DerivationState,
)
from ...shared_tech.storage import Database

_SQL_SELECT_MESSAGE_KIND = """SELECT kind FROM message WHERE message_id = ?"""

_SQL_SELECT_MESSAGE_BLOCKS = (
    """SELECT block_type, content FROM message_block
       WHERE message_id = ? ORDER BY block_index"""
)

_SQL_READ_MESSAGE_DERIVATIONS_BASE = (
    """SELECT subject_id, derivation_type, state, content, reason, metadata,
              source_version, gaps, derived_at
       FROM derivation WHERE subject_kind = 'message'"""
)

_SQL_READ_MESSAGE_DERIVATION_ROW = (
    """SELECT state, reason, source_version FROM derivation
       WHERE subject_kind = 'message' AND subject_id = ? AND derivation_type = ?"""
)

# The derivation_type→kind CASE is the owner's own queue-site mapping
# (MESSAGE_WORK_DERIVATIONS) inverted.
_SQL_REPORT_MESSAGE_DERIVATIONS = (
    """SELECT df.subject_id, df.derivation_type, df.state, df.content, df.reason, df.metadata,
              df.source_version, df.gaps, df.derived_at,
              w.status AS queue_status
       FROM derivation df
       LEFT JOIN work_item w
         ON w.status IN ('queued', 'claimed')
        AND w.kind = CASE df.derivation_type WHEN 'smoothed_prompt' THEN 'prompt_smoothing' ELSE df.derivation_type END
        AND json_extract(w.source_ref, '$.messageId') = df.subject_id
        AND COALESCE(json_extract(w.payload, '$.sourceVersion'), 1) = df.source_version
       WHERE {conditions}
       ORDER BY df.subject_id, df.derivation_type"""
)

_SQL_FIND_PAIRED_BLOCK = (
    """SELECT b.content FROM message_block b
       JOIN message m ON m.message_id = b.message_id AND m.deleted_at IS NULL
       WHERE b.block_type = ? AND json_extract(b.content, '$.toolCallId') = ?
       ORDER BY m.source_event_order LIMIT 1"""
)


@dataclass(frozen=True, slots=True)
class MessageSourceBlock:
    block_type: str
    content: dict[str, object]


@dataclass(frozen=True, slots=True)
class MessageSource:
    message_id: str
    kind: str
    blocks: list[MessageSourceBlock]


def read_message_source(db: Database, message_id: str) -> MessageSource | None:
    row = db.prepare(_SQL_SELECT_MESSAGE_KIND).get(message_id)
    if row is None:
        return None
    blocks = [
        MessageSourceBlock(
            block_type=str(block["block_type"]),
            content=json.loads(str(block["content"])),
        )
        for block in db.prepare(_SQL_SELECT_MESSAGE_BLOCKS).all(message_id)
    ]
    return MessageSource(message_id=message_id, kind=str(row["kind"]), blocks=blocks)


@dataclass(frozen=True, slots=True)
class _RawDerivationRow:
    subject_id: str
    derivation_type: str
    state: str
    content: str | None
    reason: str | None
    metadata: str | None
    source_version: int
    gaps: str | None
    derived_at: str | None


# Every message-owned derivation row, grouped by message id — the derivation
# read-back joined onto message reads. Rows come back exactly as the queue
# landed them: state, content, reason, mechanically stamped metadata; nothing
# is derived at read time.
#
# message_ids, when provided, scopes the read to just those subjects so a
# bounded list loads only its window's derivations, never every message-owned
# derivation in the thread. Omitted — the report-surface path that already
# reads its own scope — reads all message-owned derivation rows as before.
def read_message_derivations(
    db: Database,
    message_ids: Sequence[str] | None = None,
) -> dict[str, list[Derivation]]:
    sql = _SQL_READ_MESSAGE_DERIVATIONS_BASE
    params: list[object] = []
    if message_ids is not None:
        if not message_ids:
            return {}
        sql += f" AND subject_id IN ({', '.join('?' for _ in message_ids)})"
        params.extend(message_ids)
    sql += " ORDER BY subject_id, derivation_type"

    from ...shared_tech.derivation import decode_derivation_metadata

    result: dict[str, list[Derivation]] = {}
    for row in db.prepare(sql).all(*params):
        metadata = None
        if row["metadata"] is not None:
            metadata = decode_derivation_metadata(json.loads(str(row["metadata"])))
        gaps = None
        if row["gaps"] is not None:
            gaps = [
                DependencyGap(
                    subject_kind=gap["subjectKind"],
                    subject_id=gap["subjectId"],
                    derivation_type=gap["derivationType"],
                )
                for gap in json.loads(str(row["gaps"]))
            ]
        subject_id = str(row["subject_id"])
        result.setdefault(subject_id, []).append(
            Derivation(
                subject_kind="message",
                subject_id=subject_id,
                derivation_type=str(row["derivation_type"]),
                state=str(row["state"]),  # type: ignore[arg-type]
                source_version=int(row["source_version"]),
                content=str(row["content"]) if row["content"] is not None else None,
                reason=str(row["reason"]) if row["reason"] is not None else None,
                gaps=gaps,
                metadata=metadata,
                derived_at=(
                    str(row["derived_at"]) if row["derived_at"] is not None else None
                ),
            )
        )
    return result


@dataclass(frozen=True, slots=True)
class MessageDerivationRowView:
    state: DerivationState
    source_version: int
    reason: str | None = None


# One derivation row by exact key — the requeue operation's refusal read (missing
# row, blocked state, current source version). State returned as stored.
def read_message_derivation_row(
    db: Database,
    message_id: str,
    derivation_type: str,
) -> MessageDerivationRowView | None:
    row = db.prepare(_SQL_READ_MESSAGE_DERIVATION_ROW).get(
        message_id, derivation_type
    )
    if row is None:
        return None
    return MessageDerivationRowView(
        state=str(row["state"]),  # type: ignore[arg-type]
        source_version=int(row["source_version"]),
        reason=str(row["reason"]) if row["reason"] is not None else None,
    )


@dataclass(frozen=True, slots=True)
class MessageReportOptions:
    not_ready: bool | None = None
    message_id: str | None = None


# The message owner's report is one query: message-owned derivation rows LEFT
# JOINed with the live work_item still targeting each derivation at its current
# source version, if any. Terminal outcomes already live on derivation rows. No
# N+1, no in-memory assembly beyond row mapping.
def report_message_derivations(
    db: Database,
    opts: MessageReportOptions | None = None,
) -> list[DerivationReportEntry]:
    from ...shared_tech.report import RawReportRow, report_entry_from_row

    options = opts if opts is not None else MessageReportOptions()
    conditions = ["df.subject_kind = 'message'"]
    params: list[str] = []
    if options.message_id is not None:
        conditions.append("df.subject_id = ?")
        params.append(options.message_id)
    if options.not_ready is True:
        conditions.append("df.state <> 'ready'")
    rows = db.prepare(
        f"""SELECT df.subject_id, df.derivation_type, df.state, df.content, df.reason, df.metadata,
                   df.source_version, df.gaps, df.derived_at,
                   w.status AS queue_status
            FROM derivation df
            LEFT JOIN work_item w
              ON w.status IN ('queued', 'claimed')
             AND w.kind = CASE df.derivation_type WHEN 'smoothed_prompt' THEN 'prompt_smoothing' ELSE df.derivation_type END
             AND json_extract(w.source_ref, '$.messageId') = df.subject_id
             AND COALESCE(json_extract(w.payload, '$.sourceVersion'), 1) = df.source_version
            WHERE {' AND '.join(conditions)}
            ORDER BY df.subject_id, df.derivation_type"""
    ).all(*params)
    return [
        report_entry_from_row(
            "message",
            RawReportRow(
                subject_id=str(row["subject_id"]),
                derivation_type=str(row["derivation_type"]),
                state=str(row["state"]),
                content=str(row["content"]) if row["content"] is not None else None,
                reason=str(row["reason"]) if row["reason"] is not None else None,
                metadata=str(row["metadata"]) if row["metadata"] is not None else None,
                source_version=int(row["source_version"]),
                gaps=str(row["gaps"]) if row["gaps"] is not None else None,
                derived_at=(
                    str(row["derived_at"]) if row["derived_at"] is not None else None
                ),
                queue_status=(
                    str(row["queue_status"]) if row["queue_status"] is not None else None
                ),
            ),
        )
        for row in rows
    ]


# The call-id pairing reads. Earliest-recorded block wins if a call id were
# ever repeated; in a valid record the pair is unique. Deleted messages
# are excluded: composition inputs and derivation reads never see deleted
# records, so a tool_call whose paired result has been deleted reads no pair
# and derives outcome `unknown` — never the dead result's outcome.
def _find_paired_block(
    db: Database,
    block_type: Literal["tool_call", "tool_result"],
    tool_call_id: str,
) -> dict[str, object] | None:
    row = db.prepare(_SQL_FIND_PAIRED_BLOCK).get(block_type, tool_call_id)
    if row is None:
        return None
    value = json.loads(str(row["content"]))
    return value if isinstance(value, dict) else None


@dataclass(frozen=True, slots=True)
class PairedToolResult:
    content: str
    is_error: bool


def find_paired_tool_result(db: Database, tool_call_id: str) -> PairedToolResult | None:
    block = _find_paired_block(db, "tool_result", tool_call_id)
    if block is None:
        return None
    content = block.get("content")
    return PairedToolResult(
        content=content if isinstance(content, str) else "",
        is_error=block.get("isError") is True,
    )


@dataclass(frozen=True, slots=True)
class PairedToolCall:
    tool_name: str
    tool_input: dict[str, object] | None = None


def find_paired_tool_call(db: Database, tool_call_id: str) -> PairedToolCall | None:
    block = _find_paired_block(db, "tool_call", tool_call_id)
    if block is None:
        return None
    tool_name = block.get("toolName")
    arguments = block.get("arguments")
    return PairedToolCall(
        tool_name=tool_name if isinstance(tool_name, str) else "",
        tool_input=arguments if isinstance(arguments, dict) else None,
    )
