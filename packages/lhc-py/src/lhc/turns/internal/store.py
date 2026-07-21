"""Ported from packages/lhc/src/turns/internal/store.ts.

Turn row operations. Writes run on the caller's handle inside the batch
transaction; reads run on a fresh handle per operation. A closed turn has
no writer anywhere in this module: its membership and boundaries are stable
because no UPDATE touches closed rows.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ...shared_tech.storage import Database

# Runtime import (not TYPE_CHECKING): Phase 2 bodies construct these records.
# Safe because the parent __init__ defines them BEFORE importing this module
# (see the IMPORT-ORDER CONSTRAINT note there).
from .. import TurnRecord

_SQL_SELECT_OPEN_TURN_IDS = """SELECT turn_id FROM turns WHERE status = 'open' ORDER BY turn_order"""

_SQL_COUNT_TURN_MEMBERS = """SELECT COUNT(*) AS n FROM message WHERE turn_id = ? AND deleted_at IS NULL"""

_SQL_NEXT_TURN_ORDER = """SELECT MAX(turn_order) AS max_order FROM turns"""

_SQL_INSERT_OPEN_TURN = (
    """INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order)
     VALUES (?, ?, 'open', ?)"""
)

_SQL_CLOSE_TURN = (
    """UPDATE turns SET status = 'closed', closed_at_event_order = ? WHERE turn_id = ? AND status = 'open'"""
)

_SQL_SELECT_TURN_MEMBERS = (
    """SELECT message_id, turn_id FROM message
       WHERE turn_id IS NOT NULL AND deleted_at IS NULL ORDER BY source_event_order"""
)

_SQL_SELECT_TURNS_LIVE = (
    """SELECT turn_id, turn_order, status, opened_at_event_order, closed_at_event_order
       FROM turns WHERE deleted_at IS NULL ORDER BY turn_order"""
)

_SQL_SELECT_TURN_STRUCTURE = (
    """SELECT turn_id, turn_order, status, opened_at_event_order, closed_at_event_order, deleted_at
       FROM turns ORDER BY turn_order"""
)


def select_open_turn_ids(db: Database) -> list[str]:
    return [str(row["turn_id"]) for row in db.prepare(_SQL_SELECT_OPEN_TURN_IDS).all()]


def count_turn_members(db: Database, turn_id: str) -> int:
    row = db.prepare(_SQL_COUNT_TURN_MEMBERS).get(turn_id)
    value = row.get("n") if row is not None else None
    return int(value if value is not None else 0)


def next_turn_order(db: Database) -> int:
    row = db.prepare(_SQL_NEXT_TURN_ORDER).get()
    value = row.get("max_order") if row is not None else None
    return int(value if value is not None else 0) + 1


def insert_open_turn(db: Database, turn_order: int, opened_at_event_order: int) -> str:
    turn_id = f"t{turn_order}"
    db.prepare(_SQL_INSERT_OPEN_TURN).run(turn_id, turn_order, opened_at_event_order)
    return turn_id


def close_turn(db: Database, turn_id: str, closed_at_event_order: int) -> None:
    db.prepare(_SQL_CLOSE_TURN).run(closed_at_event_order, turn_id)


@dataclass(frozen=True, slots=True)
class _RawTurnRow:
    turn_id: str
    turn_order: int
    status: str
    opened_at_event_order: int
    closed_at_event_order: int | None


# Membership is stored on the member (message.turn_id), never as a list on
# the turn: member_message_ids is a query, ordered by event order, so there is
# exactly one source of truth. Both halves read deleted-filtered (tech
# design §Mechanics): a deleted turn leaves the listing entirely, and a
# deleted message leaves its turn's membership — the membership shrinks in
# place, the turn row and its boundaries untouched.
def read_turns(db: Database) -> list[TurnRecord]:
    from .chunks import read_placements

    member_rows = db.prepare(_SQL_SELECT_TURN_MEMBERS).all()
    members_by_turn: dict[str, list[str]] = {}
    for row in member_rows:
        turn_id = str(row["turn_id"])
        members = members_by_turn.get(turn_id)
        if members is None:
            members = []
            members_by_turn[turn_id] = members
        members.append(str(row["message_id"]))

    turn_rows = db.prepare(_SQL_SELECT_TURNS_LIVE).all()
    # Chunk placement is stored in chunk_member once derivation places the turn.
    placements = read_placements(db)
    records: list[TurnRecord] = []
    for row in turn_rows:
        turn_id = str(row["turn_id"])
        closed = row["closed_at_event_order"]
        placement = placements.get(turn_id)
        records.append(
            TurnRecord(
                turn_id=turn_id,
                turn_order=int(row["turn_order"]),
                status=str(row["status"]),  # type: ignore[arg-type]
                member_message_ids=list(members_by_turn.get(turn_id, [])),
                opened_at_event_order=int(row["opened_at_event_order"]),
                closed_at_event_order=None if closed is None else int(closed),
                chunk_id=None if placement is None else placement.chunk_id,
                member_idx=None if placement is None else placement.member_idx,
            )
        )
    return records


# The turn structure for compact selection: every turn row in turn order,
# including tombstoned ones (the deleted flag carried through). Unlike
# read_turns, this keeps tombstoned rows because the consumer's referential
# checks treat a tombstoned turn as a legitimate reference target, not damage
# — it separates the live selection set from the referential universe itself.
@dataclass(frozen=True, slots=True)
class TurnStructureRow:
    turn_id: str
    turn_order: int
    status: Literal["open", "closed"]
    opened_at_event_order: int
    closed_at_event_order: int | None
    deleted: bool


def read_turn_structure(db: Database) -> list[TurnStructureRow]:
    rows = db.prepare(_SQL_SELECT_TURN_STRUCTURE).all()
    return [
        TurnStructureRow(
            turn_id=str(row["turn_id"]),
            turn_order=int(row["turn_order"]),
            status=str(row["status"]),  # type: ignore[arg-type]
            opened_at_event_order=int(row["opened_at_event_order"]),
            closed_at_event_order=(
                None
                if row["closed_at_event_order"] is None
                else int(row["closed_at_event_order"])
            ),
            deleted=row["deleted_at"] is not None,
        )
        for row in rows
    ]
