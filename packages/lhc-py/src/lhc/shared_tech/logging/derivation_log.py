"""Ported from packages/lhc/src/shared-tech/logging/derivation-log.ts.

Append-only execution history for inference-backed derivations. State stays
compact (pending | ready | failed | blocked); this table carries the story.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal

from ..derivation import SubjectKind
from ..persist import DbReadTransaction, DbWriteTransaction
from ..storage import Database, database_path_for, open_database

DerivationLogEventKind = Literal[
    "inference_failed",
    "inference_succeeded",
    "fallback_applied",
    "terminal_failed",
]


@dataclass(frozen=True, slots=True)
class DerivationLogTarget:
    subject_kind: SubjectKind
    subject_id: str
    derivation_type: str


@dataclass(frozen=True, slots=True)
class DerivationLogPayload:
    """Documentation of known payload keys (TS index signature allows extras).

    Call sites and DerivationLogEntry.payload use dict[str, object]; this
    dataclass documents the known optional keys only — do not pass it into
    append/query APIs.
    """

    reason: str | None = None
    fallback_floor: str | None = None
    provenance: dict[str, str] | None = None  # {provider, model, prompt}


@dataclass(frozen=True, slots=True)
class DerivationLogEntry:
    target: DerivationLogTarget
    event_kind: DerivationLogEventKind
    payload: dict[str, object]  # DerivationLogPayload + index signature


@dataclass(frozen=True, slots=True)
class StoredDerivationLogEntry:
    log_id: int
    subject_kind: SubjectKind
    subject_id: str
    derivation_type: str
    event_kind: DerivationLogEventKind
    payload: dict[str, object]
    recorded_at: str


@dataclass(frozen=True, slots=True)
class DerivationLogQuery:
    subject_kind: SubjectKind | None = None
    subject_id: str | None = None
    derivation_type: str | None = None
    event_kind: DerivationLogEventKind | None = None


def _insert_derivation_log(path: str, entry: DerivationLogEntry) -> None:
    db: Database | None = None
    try:
        db = open_database(path)
        db.prepare(
            """INSERT INTO derivation_log (subject_kind, subject_id, derivation_type, event_kind, payload)
       VALUES (?, ?, ?, ?, ?)"""
        ).run(
            entry.target.subject_kind,
            entry.target.subject_id,
            entry.target.derivation_type,
            entry.event_kind,
            json.dumps(entry.payload, separators=(",", ":"), ensure_ascii=False),
        )
    except Exception:
        # Fail-soft: logging must not affect derivation execution.
        pass
    finally:
        if db is not None:
            db.close()


def append_derivation_log(
    transaction: DbReadTransaction | DbWriteTransaction,
    entry: DerivationLogEntry,
) -> None:
    path = database_path_for(transaction.db)
    if path is None:
        return
    if isinstance(transaction, DbWriteTransaction):
        transaction.post_commit_hook.add(lambda: _insert_derivation_log(path, entry))
        return
    _insert_derivation_log(path, entry)


def query_derivation_log(db: Database, q: DerivationLogQuery) -> list[StoredDerivationLogEntry]:
    conditions: list[str] = []
    params: list[object] = []

    if q.subject_kind is not None:
        conditions.append("subject_kind = ?")
        params.append(q.subject_kind)
    if q.subject_id is not None:
        conditions.append("subject_id = ?")
        params.append(q.subject_id)
    if q.derivation_type is not None:
        conditions.append("derivation_type = ?")
        params.append(q.derivation_type)
    if q.event_kind is not None:
        conditions.append("event_kind = ?")
        params.append(q.event_kind)

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"""
    SELECT log_id, subject_kind, subject_id, derivation_type, event_kind, payload, recorded_at
    FROM derivation_log
    {where_clause}
    ORDER BY log_id ASC
  """

    rows = db.prepare(sql).all(*params)
    return [
        StoredDerivationLogEntry(
            log_id=int(row["log_id"]),  # type: ignore[arg-type]
            subject_kind=row["subject_kind"],  # type: ignore[arg-type]
            subject_id=str(row["subject_id"]),
            derivation_type=str(row["derivation_type"]),
            event_kind=row["event_kind"],  # type: ignore[arg-type]
            payload=json.loads(str(row["payload"])),
            recorded_at=str(row["recorded_at"]),
        )
        for row in rows
    ]
