"""Ported from packages/lhc/test/fixtures/corrupt.ts. Phase 1 skeleton.

NOT_JSON is pure data — real. The three writers below-SDK-write raw sqlite
rows (a second open turn / poisoned JSON columns), so they are skeletons.
"""

from __future__ import annotations

from lhc.shared_tech.storage import open_database

# The one sanctioned below-SDK write in the test suite: overwrites a message
# block's content, or a derived-form's metadata, with bytes strict JSON
# parsing rejects. Value must still *store* — see the TS module comment for
# the json_extract-accepts / JSON.parse-rejects needle this threads.
NOT_JSON = "{'unreadable': true,}"


def corrupt_two_open_turns(path: str) -> None:
    db = open_database(path)
    try:
        row = db.prepare("SELECT MAX(turn_order) AS max_order FROM turns").get()
        max_order = row.get("max_order") if row is not None else None
        next_order = int(max_order or 0) + 1
        db.prepare(
            """INSERT INTO turns
                 (turn_id, turn_order, status, opened_at_event_order)
               VALUES (?, ?, 'open', ?)"""
        ).run(f"t{next_order}", next_order, 0)
    finally:
        db.close()


def poison_message_block_json(path: str, message_id: str) -> None:
    db = open_database(path)
    try:
        db.prepare(
            "UPDATE message_block SET content = ? WHERE message_id = ?"
        ).run(NOT_JSON, message_id)
    finally:
        db.close()


def poison_message_form_json(path: str, message_id: str) -> None:
    db = open_database(path)
    try:
        db.prepare(
            """UPDATE derivation SET metadata = ?
               WHERE subject_kind = 'message' AND subject_id = ?"""
        ).run(NOT_JSON, message_id)
    finally:
        db.close()


__all__ = [
    "NOT_JSON",
    "corrupt_two_open_turns",
    "poison_message_block_json",
    "poison_message_form_json",
]
