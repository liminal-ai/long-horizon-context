"""Ported from packages/lhc/src/turns/internal/chunks.ts. Phase 1 skeleton.

Chunk mechanics: open-chunk append, the accumulated close policy, and the
close-to-summary enqueues. Placement is pure arithmetic over stored projected
token counts. The caller hands in the incoming turn's count, the open chunk
carries its accumulated count durably, and placement never uses clock,
inference, or token re-estimation. Everything here runs inside the
turn-derivation completion transaction; a crash leaves either a placed turn
with any close's summary enqueues or nothing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from ...shared_tech.storage import Database
from ...shared_tech.work_queue import WorkItemRecord

if TYPE_CHECKING:
    from ...shared_tech.persist import DbWriteTransaction

_SQL_MEMBER_COUNT = """SELECT COUNT(*) AS n FROM chunk_member WHERE chunk_id = ?"""

_SQL_CLOSE_CHUNK = """UPDATE chunk SET status = 'closed' WHERE chunk_id = ?"""

_SQL_MAX_CHUNK_ORDER = """SELECT MAX(chunk_order) AS max_order FROM chunk"""

_SQL_INSERT_OPEN_CHUNK = (
    """INSERT INTO chunk (chunk_id, chunk_order, status, accumulated_projected_tokens)
     VALUES (?, ?, 'open', 0)"""
)

_SQL_SELECT_EXISTING_PLACEMENT = """SELECT chunk_id, member_idx FROM chunk_member WHERE turn_id = ?"""

_SQL_SELECT_OPEN_CHUNK = (
    """SELECT chunk_id, accumulated_projected_tokens FROM chunk
       WHERE status = 'open' ORDER BY chunk_order DESC LIMIT 1"""
)

_SQL_INSERT_CHUNK_MEMBER = """INSERT INTO chunk_member (chunk_id, turn_id, member_idx) VALUES (?, ?, ?)"""

_SQL_ACCUMULATE_PROJECTED_TOKENS = (
    """UPDATE chunk SET accumulated_projected_tokens = accumulated_projected_tokens + ?
     WHERE chunk_id = ?"""
)

_SQL_SELECT_CHUNK_STRUCTURE = """SELECT chunk_id, chunk_order, status FROM chunk ORDER BY chunk_order"""

_SQL_SELECT_CHUNK_STRUCTURE_MEMBERS = (
    """SELECT cm.chunk_id, cm.turn_id FROM chunk_member cm
       JOIN chunk c ON c.chunk_id = cm.chunk_id
       ORDER BY c.chunk_order, cm.member_idx"""
)

_SQL_SELECT_PLACEMENTS = """SELECT turn_id, chunk_id, member_idx FROM chunk_member"""


@dataclass(frozen=True, slots=True)
class ChunkPolicy:
    target_projected_tokens: int
    max_projected_tokens: int


@dataclass(frozen=True, slots=True)
class PlacementResult:
    chunk_id: str
    member_idx: int
    # Chunks closed by this placement, in close order: at most the previous
    # open chunk (accumulation rule) and then the incoming turn's own chunk
    # (max rule) — a turn ≥ max arriving behind an open chunk closes both.
    closed_chunk_ids: list[str]
    # An explicitly rebuilt turn keeps its placement. Sanctioned delete rebuilds
    # chunk summaries from surviving members without changing chunk membership.
    already_placed: bool


@dataclass(frozen=True, slots=True)
class _OpenChunkRow:
    chunk_id: str
    accumulated_projected_tokens: int


def _member_count(db: Database, chunk_id: str) -> int:
    raise NotImplementedError


def _close_chunk(db: Database, chunk_id: str) -> None:
    raise NotImplementedError


def _open_next_chunk(db: Database) -> str:
    raise NotImplementedError


# The close policy: when the open chunk's accumulated count plus the incoming
# turn's count would reach the target, equality included, the chunk closes
# holding its current members and the incoming turn opens the next chunk. A
# single turn at or above max closes its own chunk immediately. An empty open
# chunk always accepts the incoming turn; a chunk never closes empty.
def place_turn(
    db: Database,
    turn_id: str,
    projected_tokens: int,
    policy: ChunkPolicy,
) -> PlacementResult:
    raise NotImplementedError


# Closing queues the two summary kinds as independent work items. Both enqueues
# ride the caller's ambient completion transaction.
def enqueue_chunk_summaries(transaction: DbWriteTransaction, chunk_id: str) -> list[WorkItemRecord]:
    raise NotImplementedError


# The chunk structure for compact selection: every chunk in chunk order with
# its raw membership in member order. Membership is NOT filtered by turn
# liveness — references are returned as stored so the consumer can run its
# own referential check (a member pointing at no turn row at all is damage;
# a member pointing at a tombstoned turn is not). This is why it does not
# reuse read_chunk_rows, whose live-turn join would hide both cases.
@dataclass(frozen=True, slots=True)
class ChunkStructureRow:
    chunk_id: str
    chunk_order: int
    status: Literal["open", "closed"]
    member_turn_ids: list[str]


def read_chunk_structure(db: Database) -> list[ChunkStructureRow]:
    raise NotImplementedError


# Placement read-back for the turns surface: chunk_id + member_idx by turn, one
# query, stored values only.
@dataclass(frozen=True, slots=True)
class TurnPlacement:
    chunk_id: str
    member_idx: int


def read_placements(db: Database) -> dict[str, TurnPlacement]:
    raise NotImplementedError
