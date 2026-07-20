"""Ported from packages/lhc/src/turns/internal/store.ts. Phase 1 skeleton.

Turn row operations. Writes run on the caller's handle inside the batch
transaction; reads run on a fresh handle per operation. A closed turn has
no writer anywhere in this module: its membership and boundaries are stable
because no UPDATE touches closed rows.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from ...shared_tech.storage import Database

if TYPE_CHECKING:
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
    raise NotImplementedError


def count_turn_members(db: Database, turn_id: str) -> int:
    raise NotImplementedError


def next_turn_order(db: Database) -> int:
    raise NotImplementedError


def insert_open_turn(db: Database, turn_order: int, opened_at_event_order: int) -> str:
    raise NotImplementedError


def close_turn(db: Database, turn_id: str, closed_at_event_order: int) -> None:
    raise NotImplementedError


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
    raise NotImplementedError


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
    raise NotImplementedError
