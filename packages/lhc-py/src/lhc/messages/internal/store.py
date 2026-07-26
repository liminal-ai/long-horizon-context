"""Ported from packages/lhc/src/messages/internal/store.ts.

Message and block row operations. Writes run on the caller's handle inside
the batch transaction; reads run on a fresh handle per operation. Edit/delete
validation and row applies also live here: row-level mechanics, no policy.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal, TypedDict

from ...shared_tech._jsstr import js_json_dumps
from ...shared_tech.derivation import Derivation
from ...shared_tech.storage import Database

# Runtime import (not TYPE_CHECKING): Phase 2 bodies construct these records.
# Safe because the parent __init__ defines them BEFORE importing this module
# (see the IMPORT-ORDER CONSTRAINT note there).
from .. import Block, MessageKind, MessageRecord

_SQL_INSERT_MESSAGE = (
    """INSERT INTO message (message_id, source_event_order, kind, token_estimate, actor, harness, turn_id, provider_usage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)"""
)

_SQL_INSERT_MESSAGE_BLOCK = (
    """INSERT INTO message_block (message_id, block_index, block_type, content)
     VALUES (?, ?, ?, ?)"""
)

_SQL_READ_MUTABLE_MESSAGE = (
    """SELECT m.message_id, m.kind, m.turn_id, m.source_event_order,
              t.status AS turn_status,
              NOT EXISTS (
                SELECT 1 FROM message prior
                WHERE prior.turn_id = m.turn_id
                  AND prior.deleted_at IS NULL
                  AND prior.source_event_order < m.source_event_order
              ) AS is_first_member
       FROM message m LEFT JOIN turns t ON t.turn_id = m.turn_id
       WHERE m.message_id = ? AND m.deleted_at IS NULL"""
)

_SQL_MARK_MESSAGE_DELETED = """UPDATE message SET deleted_at = ? WHERE message_id = ?"""

_SQL_SELECT_BLOCKS_FOR_EDIT = (
    """SELECT block_index, block_type, content FROM message_block
       WHERE message_id = ? ORDER BY block_index"""
)

_SQL_UPDATE_MESSAGE_BLOCK = (
    """UPDATE message_block SET content = ? WHERE message_id = ? AND block_index = ?"""
)

_SQL_UPDATE_TOKEN_ESTIMATE = """UPDATE message SET token_estimate = ? WHERE message_id = ?"""

_SQL_READ_MESSAGES_SELECT = (
    """SELECT m.message_id, m.source_event_order, m.kind, m.token_estimate, m.actor, m.harness,
              m.turn_id, m.provider_usage, m.deleted_at, e.recorded_at
       FROM message m JOIN event e ON e.event_order = m.source_event_order"""
)

_SQL_READ_BLOCKS_FOR_IDS_PREFIX = (
    """SELECT message_id, block_type, content FROM message_block
       WHERE message_id IN ("""
)

_SQL_READ_BLOCKS_FOR_IDS_SUFFIX = """)
       ORDER BY message_id, block_index"""

_SQL_READ_MESSAGE_BY_ID = (
    """SELECT m.message_id, m.source_event_order, m.kind, m.token_estimate, m.actor, m.harness,
              m.turn_id, m.provider_usage, m.deleted_at, e.recorded_at
       FROM message m JOIN event e ON e.event_order = m.source_event_order
       WHERE m.message_id = ?"""
)

_SQL_READ_BLOCKS_BY_MESSAGE_ID = (
    """SELECT message_id, block_type, content FROM message_block
       WHERE message_id = ? ORDER BY block_index"""
)


@dataclass(frozen=True, slots=True)
class MessageRow:
    message_id: str
    source_event_order: int
    kind: MessageKind
    token_estimate: int
    actor: str
    harness: str
    # Membership stamp, settled at intake: the current open turn after turn
    # intake. Written once here, never updated.
    turn_id: str
    blocks: list[Block]
    # Verbatim provider usage JSON for assistant_text events that carried it
    # (schema v5). Absent / NULL for every other kind and for pre-v5 rows.
    provider_usage: dict[str, object] | None = None


def insert_message(db: Database, row: MessageRow) -> None:
    # CRITICAL byte-parity: provider_usage must be js_json_dumps (JS-parity
    # serializer) — dict insertion order is load-bearing.
    provider_usage_param = (
        None if row.provider_usage is None else js_json_dumps(row.provider_usage)
    )
    db.prepare(_SQL_INSERT_MESSAGE).run(
        row.message_id,
        row.source_event_order,
        row.kind,
        row.token_estimate,
        row.actor,
        row.harness,
        row.turn_id,
        provider_usage_param,
    )
    insert_block = db.prepare(_SQL_INSERT_MESSAGE_BLOCK)
    for index, block in enumerate(row.blocks):
        insert_block.run(
            row.message_id,
            index,
            block.block_type,
            json.dumps(block.content, separators=(",", ":"), ensure_ascii=False),
        )


# Mutation validation reads the live (deleted-filtered) message joined to its
# turn's status. A deleted target misses here and refuses as message_not_found.
# turnStatus is null only when the stored membership references no readable
# turn; the closed-turn target boundary refuses it the same as an open turn.
# initiatesTurn carries the prompt-protection fact: with initial empty turns,
# the initiator is the first live member of a turn, not necessarily the turn's
# open event.
@dataclass(frozen=True, slots=True)
class MutableMessageView:
    message_id: str
    kind: str
    turn_id: str
    turn_status: Literal["open", "closed"] | None
    initiates_turn: bool


def read_mutable_message(db: Database, message_id: str) -> MutableMessageView | None:
    row = db.prepare(_SQL_READ_MUTABLE_MESSAGE).get(message_id)
    if row is None:
        return None
    turn_status = row["turn_status"]
    return MutableMessageView(
        message_id=str(row["message_id"]),
        kind=str(row["kind"]),
        turn_id=str(row["turn_id"]),
        turn_status=(
            None
            if turn_status is None
            else str(turn_status)  # type: ignore[arg-type]
        ),
        initiates_turn=int(row["is_first_member"]) == 1,
    )


# Delete applies the message-record tombstone: the deleted_at stamp every
# normal message read filters on. Source events are never touched; event
# read-back keeps showing them.
def mark_message_deleted(db: Database, message_id: str, deleted_at: str) -> None:
    db.prepare(_SQL_MARK_MESSAGE_DELETED).run(deleted_at, message_id)


# Edit applies new content to each block's content-bearing field — the same
# field per block type that internal/project.ts wrote and counted — and the
# token estimate re-stamps from the same estimator, so placement arithmetic
# stays current after edits. Events are untouched; the log keeps the original.
def apply_message_edit(db: Database, message_id: str, content: str) -> None:
    from ...shared_tech.token_counting import estimate_tokens

    blocks = db.prepare(_SQL_SELECT_BLOCKS_FOR_EDIT).all(message_id)
    update = db.prepare(_SQL_UPDATE_MESSAGE_BLOCK)
    token_estimate = estimate_tokens(content)
    for block in blocks:
        parsed = json.loads(str(block["content"]))
        # TS mutates properties on JSON.parse result; a scalar throws → rollback.
        if not isinstance(parsed, dict):
            raise TypeError(
                f"message {message_id} block content is not a JSON object"
            )
        block_type = str(block["block_type"])
        if block_type == "text":
            parsed["text"] = content
        elif block_type == "tool_result":
            parsed["content"] = content
        elif block_type == "tool_call":
            parsed["arguments"] = content
            # TS: estimateTokens(JSON.stringify(content)) — UTF-8, not \uXXXX.
            token_estimate = estimate_tokens(
                json.dumps(content, separators=(",", ":"), ensure_ascii=False)
            )
        elif block_type == "model_change":
            parsed["newModel"] = content
        elif block_type == "thinking_level_change":
            parsed["newLevel"] = content
        else:
            raise RuntimeError(
                f"message {message_id} carries unknown block type {block_type}"
            )
        update.run(
            json.dumps(parsed, separators=(",", ":"), ensure_ascii=False),
            message_id,
            int(block["block_index"]),
        )
    db.prepare(_SQL_UPDATE_TOKEN_ESTIMATE).run(token_estimate, message_id)


@dataclass(frozen=True, slots=True)
class _RawMessageRow:
    message_id: str
    source_event_order: int
    kind: str
    token_estimate: int
    actor: str
    harness: str
    turn_id: str
    provider_usage: str | None
    deleted_at: str | None
    # The source event's recorded_at, joined from the durable event row on
    # source_event_order = event_order (every message has exactly one source
    # event).
    recorded_at: str


@dataclass(frozen=True, slots=True)
class _RawBlockRow:
    message_id: str
    block_type: str
    content: str


def _record_from_row(row: _RawMessageRow, blocks: list[Block]) -> MessageRecord:
    # Provider usage is present only when the source event carried it. NULL
    # rows (pre-v5 messages, non-assistant kinds) omit the key (None).
    provider_usage: dict[str, object] | None = None
    if row.provider_usage is not None:
        parsed = json.loads(row.provider_usage)
        if not isinstance(parsed, dict):
            raise TypeError(
                f"provider_usage column is not a JSON object: {type(parsed).__name__}"
            )
        provider_usage = parsed
    return MessageRecord(
        message_id=row.message_id,
        source_event_order=row.source_event_order,
        kind=row.kind,  # type: ignore[arg-type]
        blocks=blocks,
        token_estimate=row.token_estimate,
        actor=row.actor,
        harness=row.harness,
        recorded_at=row.recorded_at,
        turn_id=row.turn_id,
        provider_usage=provider_usage,
        deleted=True if row.deleted_at is not None else None,
    )


# Bounds are in source-event-order coordinates: the coordinate the reports
# name, so drill-down uses what the operator already holds. limit caps the
# count after bounds. Defaults preserve visible messages, unbounded, in record
# order. Same camelCase key shape as MessageListOptions ("from" is a keyword).
MessageReadOptions = TypedDict(
    "MessageReadOptions",
    {"from": int, "to": int, "limit": int, "includeDeleted": bool},
    total=False,
)


def read_messages(db: Database, opts: MessageReadOptions | None = None) -> list[MessageRecord]:
    options = opts if opts is not None else {}
    conditions: list[str] = []
    params: list[int] = []
    if options.get("includeDeleted") is not True:
        conditions.append("m.deleted_at IS NULL")
    if options.get("from") is not None:
        conditions.append("m.source_event_order >= ?")
        params.append(options["from"])
    if options.get("to") is not None:
        conditions.append("m.source_event_order <= ?")
        params.append(options["to"])
    if options.get("limit") is not None:
        params.append(options["limit"])

    sql = _SQL_READ_MESSAGES_SELECT
    if conditions:
        sql += f" WHERE {' AND '.join(conditions)}"
    sql += " ORDER BY m.source_event_order"
    if options.get("limit") is not None:
        sql += " LIMIT ?"
    raw_rows = db.prepare(sql).all(*params)
    message_rows = [
        _RawMessageRow(
            message_id=str(row["message_id"]),
            source_event_order=int(row["source_event_order"]),
            kind=str(row["kind"]),
            token_estimate=int(row["token_estimate"]),
            actor=str(row["actor"]),
            harness=str(row["harness"]),
            turn_id=str(row["turn_id"]),
            provider_usage=(
                str(row["provider_usage"])
                if row["provider_usage"] is not None
                else None
            ),
            deleted_at=(
                str(row["deleted_at"]) if row["deleted_at"] is not None else None
            ),
            recorded_at=str(row["recorded_at"]),
        )
        for row in raw_rows
    ]
    if not message_rows:
        return []

    ids = [row.message_id for row in message_rows]
    placeholders = ", ".join("?" for _ in ids)
    block_rows = db.prepare(
        _SQL_READ_BLOCKS_FOR_IDS_PREFIX
        + placeholders
        + _SQL_READ_BLOCKS_FOR_IDS_SUFFIX
    ).all(*ids)
    blocks_by_message: dict[str, list[Block]] = {}
    for row in block_rows:
        message_id = str(row["message_id"])
        blocks_by_message.setdefault(message_id, []).append(
            Block(
                block_type=str(row["block_type"]),  # type: ignore[arg-type]
                content=json.loads(str(row["content"])),
            )
        )
    return [
        _record_from_row(row, blocks_by_message.get(row.message_id, []))
        for row in message_rows
    ]


# The show operation's by-id read returns the canonical record: full blocks
# verbatim, never view-shortened, with the deleted flag honest. It is
# deliberately unfiltered on deleted_at: show on a deleted message is the audit
# read, never not-found.
# TS: (MessageRecord & { deleted: boolean }) | undefined — deleted is always
# present (true/false), never optional.
@dataclass(frozen=True, slots=True)
class MessageRecordWithDeleted:
    message_id: str
    source_event_order: int
    kind: MessageKind
    blocks: list[Block]
    token_estimate: int
    actor: str
    harness: str
    recorded_at: str
    turn_id: str
    deleted: bool
    provider_usage: dict[str, object] | None = None
    derivations: list[Derivation] | None = None


def read_message_by_id(db: Database, message_id: str) -> MessageRecordWithDeleted | None:
    row = db.prepare(
        """SELECT m.message_id, m.source_event_order, m.kind, m.token_estimate, m.actor, m.harness,
                  m.turn_id, m.provider_usage, m.deleted_at, e.recorded_at
           FROM message m JOIN event e ON e.event_order = m.source_event_order
           WHERE m.message_id = ?"""
    ).get(message_id)
    if row is None:
        return None
    block_rows = db.prepare(
        """SELECT message_id, block_type, content FROM message_block
           WHERE message_id = ? ORDER BY block_index"""
    ).all(message_id)
    blocks = [
        Block(
            block_type=str(block["block_type"]),  # type: ignore[arg-type]
            content=json.loads(str(block["content"])),
        )
        for block in block_rows
    ]
    raw = _RawMessageRow(
        message_id=str(row["message_id"]),
        source_event_order=int(row["source_event_order"]),
        kind=str(row["kind"]),
        token_estimate=int(row["token_estimate"]),
        actor=str(row["actor"]),
        harness=str(row["harness"]),
        turn_id=str(row["turn_id"]),
        provider_usage=(
            str(row["provider_usage"]) if row["provider_usage"] is not None else None
        ),
        deleted_at=str(row["deleted_at"]) if row["deleted_at"] is not None else None,
        recorded_at=str(row["recorded_at"]),
    )
    record = _record_from_row(raw, blocks)
    return MessageRecordWithDeleted(
        message_id=record.message_id,
        source_event_order=record.source_event_order,
        kind=record.kind,
        blocks=record.blocks,
        token_estimate=record.token_estimate,
        actor=record.actor,
        harness=record.harness,
        recorded_at=record.recorded_at,
        turn_id=record.turn_id,
        provider_usage=record.provider_usage,
        deleted=row["deleted_at"] is not None,
    )
