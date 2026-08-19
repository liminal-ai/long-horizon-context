"""Ported from packages/lhc/src/turns/internal/chunk-recovery.ts.

Compact-selection material for a chunk: ready stored summary content, or a
deterministic concat floor over live members when the summary is not ready.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal, Union

from ...shared_tech.storage import Database

_SQL_CHUNK_EXISTS = """SELECT 1 FROM chunk WHERE chunk_id = ?"""

_SQL_LIVE_CHUNK_MEMBERS = (
    """SELECT cm.turn_id FROM chunk_member cm
       JOIN turns t ON t.turn_id = cm.turn_id AND t.deleted_at IS NULL
       WHERE cm.chunk_id = ? ORDER BY cm.member_idx"""
)

_SQL_TURN_MESSAGES = (
    """SELECT message_id, kind FROM message
     WHERE turn_id = ? AND deleted_at IS NULL ORDER BY source_event_order"""
)

_SQL_MESSAGE_BLOCK_CONTENT = """SELECT content FROM message_block WHERE message_id = ? ORDER BY block_index"""

_SQL_TURN_STATUS = """SELECT status, closed_at_event_order FROM turns WHERE turn_id = ?"""

_SQL_CHUNK_DERIVATION = (
    """SELECT state, content, reason FROM derivation
       WHERE subject_kind = 'chunk' AND subject_id = ? AND derivation_type = ?"""
)


@dataclass(frozen=True, slots=True)
class CompactChunkReady:
    content: str
    kind: Literal["ready"] = "ready"


@dataclass(frozen=True, slots=True)
class CompactChunkConcat:
    content: str
    reason: str
    kind: Literal["concat"] = "concat"


@dataclass(frozen=True, slots=True)
class CompactChunkBlocked:
    reason: str
    kind: Literal["blocked"] = "blocked"


CompactChunkMaterial = Union[CompactChunkReady, CompactChunkConcat, CompactChunkBlocked]


def _block_text(kind: str, content: dict[str, object]) -> str:
    from ...shared_tech import truncate_for_fallback

    if kind in (
        "user_prompt",
        "user_steer",
        "assistant_text",
        "assistant_thinking",
        "runtime_note",
    ):
        text = content.get("text")
        return text if isinstance(text, str) else ""
    if kind == "model_change":
        previous = content["previousModel"] if "previousModel" in content else None
        new = content["newModel"] if "newModel" in content else None
        return f"[model change] {'' if previous is None else str(previous)} -> {'' if new is None else str(new)}"
    if kind == "thinking_level_change":
        previous = content["previousLevel"] if "previousLevel" in content else None
        new = content["newLevel"] if "newLevel" in content else None
        return (
            f"[thinking level change] {'' if previous is None else str(previous)} -> "
            f"{'' if new is None else str(new)}"
        )
    if kind == "tool_call":
        name_val = content.get("toolName")
        name = name_val if isinstance(name_val, str) else "unknown_tool"
        args = content["arguments"] if "arguments" in content else {}
        if args is None:
            args = {}
        return truncate_for_fallback(
            f"[tool call · {name}] {json.dumps(args, separators=(',', ':'), ensure_ascii=False)}"
        )
    if kind == "tool_result":
        text = content.get("content")
        if isinstance(text, str):
            return f"[tool result]\n{truncate_for_fallback(text)}"
        return "[tool result]"
    return ""


def _stored_member_concat(db: Database, chunk_id: str) -> CompactChunkMaterial:
    chunk = db.prepare(_SQL_CHUNK_EXISTS).get(chunk_id)
    if chunk is None:
        return CompactChunkBlocked(
            reason=f"canonical record corrupt: chunk {chunk_id} not found"
        )

    members = db.prepare(_SQL_LIVE_CHUNK_MEMBERS).all(chunk_id)
    if len(members) == 0:
        return CompactChunkBlocked(
            reason=f"canonical record corrupt: chunk {chunk_id} has no readable members"
        )

    message_stmt = db.prepare(_SQL_TURN_MESSAGES)
    block_stmt = db.prepare(_SQL_MESSAGE_BLOCK_CONTENT)
    sections: list[str] = []
    for member in members:
        turn_id = str(member["turn_id"])
        turn = db.prepare(_SQL_TURN_STATUS).get(turn_id)
        if (
            turn is None
            or str(turn["status"]) != "closed"
            or turn["closed_at_event_order"] is None
        ):
            return CompactChunkBlocked(
                reason=(
                    f"canonical record corrupt: chunk {chunk_id} member "
                    f"{turn_id} is unreadable"
                )
            )
        messages = message_stmt.all(turn_id)
        lines: list[str] = []
        for message in messages:
            blocks = block_stmt.all(str(message["message_id"]))
            rendered = [
                text
                for text in (
                    _block_text(
                        str(message["kind"]),
                        json.loads(str(block["content"])),
                    )
                    for block in blocks
                )
                if len(text) > 0
            ]
            lines.extend(rendered)
        sections.append("\n".join(lines))

    return CompactChunkConcat(
        content="\n\n---\n\n".join(sections),
        reason="not_ready",
    )


def compact_chunk_material_from_stored_members(
    db: Database,
    chunk_id: str,
    derivation_type: Literal["chunk_summary_detailed", "chunk_summary_brief"],
) -> CompactChunkMaterial:
    row = db.prepare(_SQL_CHUNK_DERIVATION).get(chunk_id, derivation_type)
    if row is not None and str(row["state"]) == "ready" and row["content"] is not None:
        return CompactChunkReady(content=str(row["content"]))
    # Optional summaries never fail closed from derivation state. Canonical
    # member damage still returns Blocked from stored-member concat.
    fallback = _stored_member_concat(db, chunk_id)
    if not isinstance(fallback, CompactChunkConcat):
        return fallback
    return CompactChunkConcat(
        content=fallback.content,
        reason=_compact_fallback_reason(row, derivation_type, chunk_id),
    )


def _compact_fallback_reason(row: object | None, derivation_type: str, chunk_id: str) -> str:
    if row is None:
        return "missing_derivation"
    mapping = row  # sqlite row mapping
    state = str(mapping["state"])  # type: ignore[index]
    original = mapping["reason"]  # type: ignore[index]
    if state == "failed":
        return f"failed_floor: {original}" if original is not None else "failed_floor"
    if state == "blocked":
        if original is None:
            return f"{derivation_type} for chunk {chunk_id} is blocked"
        text = str(original)
        marker = "is failed: "
        if marker in text:
            return f"failed_floor: {text.rsplit(marker, 1)[1]}"
        return text
    return "not_ready"
