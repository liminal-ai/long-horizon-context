"""Ported from packages/lhc/src/turns/internal/chunk-recovery.ts. Phase 1 skeleton.

Compact-selection material for a chunk: ready stored summary content, or a
deterministic concat floor over live members when the summary is not ready.
"""

from __future__ import annotations

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
    raise NotImplementedError


def _stored_member_concat(db: Database, chunk_id: str) -> CompactChunkMaterial:
    raise NotImplementedError


def compact_chunk_material_from_stored_members(
    db: Database,
    chunk_id: str,
    derivation_type: Literal["chunk_summary_detailed", "chunk_summary_brief"],
) -> CompactChunkMaterial:
    raise NotImplementedError
