"""Ported from packages/lhc/src/intake-stream/internal/pipeline.ts.

Batch transaction pipeline. Walk-hook / clock test seams keep module state.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone

from typing import TYPE_CHECKING

from ...shared_tech.errors import OpErr, OpOk, OpResult, storage_failure
from ...shared_tech.persist import (
    DbWriteTransaction,
    create_db_read_transaction,
    create_db_write_transaction,
)
from ...shared_tech.storage import Database
from ...threads import ThreadRef
from ...turns import RecordedTurnEvent, TurnStateCorruptionError, create as _create_turn
from .. import (
    BatchEventOutcome,
    BatchResult,
    EventRecord,
    MessageEventInput,
    QueuedWorkItem,
    ThreadPosition,
    TurnTransition,
)
from .validate import validate_events, validate_thread_ref

if TYPE_CHECKING:
    # IMPORT-CYCLE SEAM: messages/__init__ imports ..intake_stream at runtime,
    # so a top-level runtime import of messages here detonates the cycle the
    # moment intake_stream/__init__ imports this pipeline at module top
    # (Phase 2). Phase 2's walk body must import messages.create lazily:
    #     from ... import messages as _messages  # inside the walk function
    from ...messages import create as _create_message

# Closed over by Phase 2 walk; named for TS import fidelity.
_ = (_create_turn, TurnStateCorruptionError)

# Test seam (set only through test/fixtures): called after each event is
# processed inside the walk, so atomicity under mid-walk failure can be
# induced through a real mechanism — closing the handle — rather than a
# mocked transaction object.
IntakeWalkHook = Callable[[Database, int], None]

_walk_hook: IntakeWalkHook | None = None


def set_intake_walk_hook(hook: IntakeWalkHook | None) -> None:
    global _walk_hook
    _walk_hook = hook


# Test seam (set only through test/fixtures): replaces the wall clock so
# recordedAt is sourced deterministically for the public SDK contract proof —
# tests record the same batch through both reference shapes and read it back
# field-for-field, recordedAt included, with nothing stripped. Unset in
# production: recording stamps real wall time. An explicit clock argument to
# run_message_events still wins over the seam.
_injected_clock: Callable[[], datetime] | None = None


def set_intake_clock(clock: Callable[[], datetime] | None) -> None:
    global _injected_clock
    _injected_clock = clock


def _detail(cause: object) -> str:
    return str(cause)


def _recorded_keys(db: Database, keys: Sequence[str]) -> set[str]:
    found: set[str] = set()
    for offset in range(0, len(keys), 400):
        chunk = keys[offset : offset + 400]
        placeholders = ", ".join("?" for _ in chunk)
        rows = db.prepare(
            f"SELECT idempotency_key FROM event WHERE idempotency_key IN ({placeholders})"
        ).all(*chunk)
        for row in rows:
            found.add(str(row["idempotency_key"]))
    return found


def _max_event_order(db: Database) -> int:
    row = db.prepare("SELECT MAX(event_order) AS max_order FROM event").get()
    value = row.get("max_order") if row is not None else None
    return int(value if value is not None else 0)


def _iso_string(value: datetime) -> str:
    if value.tzinfo is None:
        utc = value.replace(tzinfo=timezone.utc)
    else:
        utc = value.astimezone(timezone.utc)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


async def run_message_events(
    thread_ref: ThreadRef,
    events: Sequence[MessageEventInput],
    clock: Callable[[], datetime] | None = None,
) -> OpResult[BatchResult]:
    ref_failure = validate_thread_ref(thread_ref)
    if ref_failure is not None:
        return OpErr(error=ref_failure)
    batch_failure = validate_events(events)
    if batch_failure is not None:
        return OpErr(error=batch_failure)

    effective_clock = clock if clock is not None else _injected_clock
    if effective_clock is None:
        effective_clock = lambda: datetime.now(timezone.utc)

    def _walk(transaction: DbWriteTransaction) -> OpResult[BatchResult]:
        from ... import messages as _messages

        skip_set = _recorded_keys(
            transaction.db,
            [event["idempotencyKey"] for event in events],
        )
        last_order = _max_event_order(transaction.db)
        insert = transaction.db.prepare(
            """INSERT INTO event
                 (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)"""
        )

        event_results: list[BatchEventOutcome] = []
        turn_transitions: list[TurnTransition] = []
        queued_items: list[QueuedWorkItem] = []
        for index, event in enumerate(events):
            idempotency_key = event["idempotencyKey"]
            if idempotency_key in skip_set:
                event_results.append(
                    BatchEventOutcome(
                        idempotency_key=idempotency_key,
                        outcome="skipped",
                        skip_reason="duplicate_idempotency_key",
                    )
                )
            else:
                last_order += 1
                recorded_at = _iso_string(effective_clock())
                insert.run(
                    last_order,
                    event["eventKind"],
                    idempotency_key,
                    event["actor"],
                    event["harness"],
                    json.dumps(
                        event["payload"],
                        separators=(",", ":"),
                        ensure_ascii=False,
                    ),
                    recorded_at,
                )
                skip_set.add(idempotency_key)
                recorded_event: EventRecord = {
                    **event,
                    "eventOrder": last_order,
                    "recordedAt": recorded_at,
                }
                turn_outcome = _create_turn(
                    transaction,
                    RecordedTurnEvent(
                        event_kind=event["eventKind"],
                        event_order=last_order,
                    ),
                )
                turn_transitions.extend(
                    TurnTransition(action=item.action, turn_id=item.turn_id)
                    for item in turn_outcome.transitions
                )
                queued_items.extend(
                    QueuedWorkItem(
                        work_item_id=item.work_item_id,
                        owner=item.owner,
                        kind=item.kind,
                        source_ref=item.source_ref,
                    )
                    for item in turn_outcome.queued_work
                )
                created = _messages.create(transaction, recorded_event, turn_outcome.turn_id)
                queued_items.extend(
                    QueuedWorkItem(
                        work_item_id=item.work_item_id,
                        owner=item.owner,
                        kind=item.kind,
                        source_ref=item.source_ref,
                    )
                    for item in created.queued_work
                )
                event_results.append(
                    BatchEventOutcome(
                        idempotency_key=idempotency_key,
                        outcome="recorded",
                        message_id=(
                            created.message.message_id
                            if created.message is not None
                            else None
                        ),
                    )
                )
            if _walk_hook is not None:
                _walk_hook(transaction.db, index)

        return OpOk(
            value=BatchResult(
                events=event_results,
                turn_transitions=turn_transitions,
                queued_work=queued_items,
                thread_position=ThreadPosition(last_event_order=last_order),
            )
        )

    try:
        result = await create_db_write_transaction(
            thread_ref,
            _walk,
            effective_clock,
        )
        return result.value if result.ok else result
    except TurnStateCorruptionError as cause:
        from ...shared_tech.errors import ErrorResult

        return OpErr(
            error=ErrorResult(
                error_class=cause.error_class,
                code=cause.code,
                reason=str(cause),
            )
        )
    except Exception as cause:
        return storage_failure(
            f"event batch failed and rolled back whole: {_detail(cause)}"
        )


@dataclass(frozen=True, slots=True)
class _RawEventRow:
    event_order: int
    event_kind: str
    idempotency_key: str
    actor: str
    harness: str
    payload: str
    recorded_at: str


async def run_list_events(thread_ref: ThreadRef) -> OpResult[list[EventRecord]]:
    ref_failure = validate_thread_ref(thread_ref)
    if ref_failure is not None:
        return OpErr(error=ref_failure)
    try:
        def _read(transaction) -> list[EventRecord]:
            rows = transaction.db.prepare(
                """SELECT event_order, event_kind, idempotency_key, actor, harness,
                          payload, recorded_at
                   FROM event ORDER BY event_order"""
            ).all()
            return [
                {
                    "eventKind": str(row["event_kind"]),
                    "idempotencyKey": str(row["idempotency_key"]),
                    "actor": str(row["actor"]),
                    "harness": str(row["harness"]),
                    "payload": json.loads(str(row["payload"])),
                    "eventOrder": int(row["event_order"]),
                    "recordedAt": str(row["recorded_at"]),
                }
                for row in rows
            ]

        return await create_db_read_transaction(thread_ref, _read)
    except Exception as cause:
        return storage_failure(f"event read-back failed: {_detail(cause)}")
