"""Bounded indexed reconciliation read for canonical steering (LIM-113)."""

from __future__ import annotations

import json

from ...shared_tech.errors import OpResult, storage_failure
from ...shared_tech.persist import create_db_read_transaction
from ...shared_tech.storage import Database
from ...shared_tech.user_steer import UserSteerPayload, user_steer_idempotency_key
from ...threads import ThreadRef
from .. import RecordedUserSteer

USER_STEER_LOOKUP_SQL = """SELECT e.event_order, e.idempotency_key, e.actor, e.harness,
       e.payload, e.recorded_at, m.message_id
    FROM event e
    LEFT JOIN message m
      ON m.source_event_order = e.event_order AND m.deleted_at IS NULL
    WHERE e.idempotency_key = ? AND e.event_kind = 'user_steer'"""


def read_user_steer_by_key(
    db: Database, idempotency_key: str
) -> RecordedUserSteer | None:
    row = db.prepare(USER_STEER_LOOKUP_SQL).get(idempotency_key)
    if row is None:
        return None
    payload = json.loads(str(row["payload"]))
    return RecordedUserSteer(
        steer_id=str(payload["steerId"]),
        idempotency_key=str(row["idempotency_key"]),
        event_order=int(row["event_order"]),
        recorded_at=str(row["recorded_at"]),
        actor=str(row["actor"]),
        harness=str(row["harness"]),
        payload=payload,
        message_id=None if row["message_id"] is None else str(row["message_id"]),
    )


async def run_find_user_steer(
    thread_ref: ThreadRef, steer_id: str
) -> OpResult[RecordedUserSteer | None]:
    try:
        return await create_db_read_transaction(
            thread_ref,
            lambda transaction: read_user_steer_by_key(
                transaction.db, user_steer_idempotency_key(steer_id)
            ),
        )
    except Exception as cause:
        return storage_failure(f"user_steer lookup failed: {cause}")
