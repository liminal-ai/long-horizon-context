"""Ported from packages/lhc/src/turns/internal/chunks.ts.

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
    row = db.prepare(_SQL_MEMBER_COUNT).get(chunk_id)
    return int(row["n"]) if row is not None else 0


def _close_chunk(db: Database, chunk_id: str) -> None:
    db.prepare(_SQL_CLOSE_CHUNK).run(chunk_id)


def _open_next_chunk(db: Database) -> str:
    row = db.prepare(_SQL_MAX_CHUNK_ORDER).get()
    value = row["max_order"] if row is not None else None
    order = int(value if value is not None else 0) + 1
    chunk_id = f"c{order}"
    db.prepare(_SQL_INSERT_OPEN_CHUNK).run(chunk_id, order)
    return chunk_id


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
    existing = db.prepare(_SQL_SELECT_EXISTING_PLACEMENT).get(turn_id)
    if existing is not None:
        return PlacementResult(
            chunk_id=str(existing["chunk_id"]),
            member_idx=int(existing["member_idx"]),
            closed_chunk_ids=[],
            already_placed=True,
        )
    closed: list[str] = []
    row = db.prepare(_SQL_SELECT_OPEN_CHUNK).get()
    open_chunk = (
        _OpenChunkRow(
            chunk_id=str(row["chunk_id"]),
            accumulated_projected_tokens=int(row["accumulated_projected_tokens"]),
        )
        if row is not None
        else None
    )
    target = getattr(policy, "target_projected_tokens")
    maximum = getattr(policy, "max_projected_tokens")
    if (
        open_chunk is not None
        and _member_count(db, open_chunk.chunk_id) > 0
        and open_chunk.accumulated_projected_tokens + projected_tokens >= target
    ):
        _close_chunk(db, open_chunk.chunk_id)
        closed.append(open_chunk.chunk_id)
        open_chunk = None
    chunk_id = open_chunk.chunk_id if open_chunk is not None else _open_next_chunk(db)
    member_idx = _member_count(db, chunk_id)
    db.prepare(_SQL_INSERT_CHUNK_MEMBER).run(chunk_id, turn_id, member_idx)
    db.prepare(_SQL_ACCUMULATE_PROJECTED_TOKENS).run(projected_tokens, chunk_id)
    if projected_tokens >= maximum:
        _close_chunk(db, chunk_id)
        closed.append(chunk_id)
    return PlacementResult(chunk_id, member_idx, closed, False)


# Closing queues the two summary kinds as independent work items. Both enqueues
# ride the caller's ambient completion transaction.
def enqueue_chunk_summaries(transaction: DbWriteTransaction, chunk_id: str) -> list[WorkItemRecord]:
    from ...shared_tech.work_queue import EnqueueDerivationTarget, EnqueueInput, enqueue

    return [
        enqueue(
            transaction,
            EnqueueInput(
                owner="turns",
                kind=kind,
                source_ref={"chunkId": chunk_id},
                derivations=[
                    EnqueueDerivationTarget(
                        subject_kind="chunk",
                        subject_id=chunk_id,
                        derivation_type=kind,
                    )
                ],
            ),
        )
        for kind in ("chunk_summary_detailed", "chunk_summary_brief")
    ]


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
    chunk_rows = db.prepare(_SQL_SELECT_CHUNK_STRUCTURE).all()
    member_rows = db.prepare(_SQL_SELECT_CHUNK_STRUCTURE_MEMBERS).all()
    members_by_chunk: dict[str, list[str]] = {}
    for row in member_rows:
        chunk_id = str(row["chunk_id"])
        members = members_by_chunk.get(chunk_id)
        if members is None:
            members = []
            members_by_chunk[chunk_id] = members
        members.append(str(row["turn_id"]))
    return [
        ChunkStructureRow(
            chunk_id=str(row["chunk_id"]),
            chunk_order=int(row["chunk_order"]),
            status=str(row["status"]),  # type: ignore[arg-type]
            member_turn_ids=list(members_by_chunk.get(str(row["chunk_id"]), [])),
        )
        for row in chunk_rows
    ]


# Placement read-back for the turns surface: chunk_id + member_idx by turn, one
# query, stored values only.
@dataclass(frozen=True, slots=True)
class TurnPlacement:
    chunk_id: str
    member_idx: int


def read_placements(db: Database) -> dict[str, TurnPlacement]:
    rows = db.prepare(_SQL_SELECT_PLACEMENTS).all()
    by_turn: dict[str, TurnPlacement] = {}
    for row in rows:
        by_turn[str(row["turn_id"])] = TurnPlacement(
            chunk_id=str(row["chunk_id"]),
            member_idx=int(row["member_idx"]),
        )
    return by_turn
