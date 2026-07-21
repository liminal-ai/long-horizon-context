"""Ported from packages/lhc/src/shared-tech/logging/index.ts.

The logging surface: a domain-blind tech-util for recording fallback
events and diagnostics. LHC internals and the host extension both write
through this surface. Writes are fail-soft and never share the caller's
transaction. Queries return entries by actionable fields.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..persist import DbReadTransaction, DbWriteTransaction
from ..storage import Database, database_path_for, open_database
from .derivation_log import (
    DerivationLogEntry,
    DerivationLogEventKind,
    DerivationLogPayload,
    DerivationLogQuery,
    DerivationLogTarget,
    StoredDerivationLogEntry,
    append_derivation_log,
    query_derivation_log,
)

LogLevel = Literal["info", "warning", "error"]


@dataclass(frozen=True, slots=True)
class LogEntry:
    level: LogLevel
    message: str
    derivation_type: str | None = None
    subject_id: str | None = None
    reason: str | None = None  # e.g. "not_ready" | "failed_floor"
    floor_used: str | None = None  # for fallback events


@dataclass(frozen=True, slots=True)
class StoredLogEntry:
    log_id: int
    level: LogLevel
    message: str
    derivation_type: str | None
    subject_id: str | None
    reason: str | None
    floor_used: str | None
    recorded_at: str


@dataclass(frozen=True, slots=True)
class LogQuery:
    level: LogLevel | None = None
    derivation_type: str | None = None
    subject_id: str | None = None
    reason: str | None = None


def _insert_log(path: str, entry: LogEntry) -> None:
    db: Database | None = None
    try:
        db = open_database(path)
        db.prepare(
            """INSERT INTO log (level, message, derivation_type, subject_id, reason, floor_used)
       VALUES (?, ?, ?, ?, ?, ?)"""
        ).run(
            entry.level,
            entry.message,
            entry.derivation_type,
            entry.subject_id,
            entry.reason,
            entry.floor_used,
        )
    except Exception:
        # Fail-soft: drop the log entry but do not propagate the error to the caller
        pass
    finally:
        if db is not None:
            db.close()


# Write a log entry. Fail-soft: never throws to the caller, never shares
# the caller's transaction. A logging failure is contained and does not
# affect the operation that produced the log entry.
def write_log(transaction: DbReadTransaction | DbWriteTransaction, entry: LogEntry) -> None:
    path = database_path_for(transaction.db)
    if path is None:
        return
    if isinstance(transaction, DbWriteTransaction):
        transaction.post_commit_hook.add(lambda: _insert_log(path, entry))
        return
    _insert_log(path, entry)


# Query log entries by actionable fields. Returns all matching entries in
# descending order of recorded_at (newest first).
def query_log(db: Database, q: LogQuery) -> list[StoredLogEntry]:
    conditions: list[str] = []
    params: list[object] = []

    if q.level is not None:
        conditions.append("level = ?")
        params.append(q.level)
    if q.derivation_type is not None:
        conditions.append("derivation_type = ?")
        params.append(q.derivation_type)
    if q.subject_id is not None:
        conditions.append("subject_id = ?")
        params.append(q.subject_id)
    if q.reason is not None:
        conditions.append("reason = ?")
        params.append(q.reason)

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"""
    SELECT log_id, level, message, derivation_type, subject_id, reason, floor_used, recorded_at
    FROM log
    {where_clause}
    ORDER BY recorded_at DESC
  """

    rows = db.prepare(sql).all(*params)
    return [
        StoredLogEntry(
            log_id=int(row["log_id"]),  # type: ignore[arg-type]
            level=row["level"],  # type: ignore[arg-type]
            message=str(row["message"]),
            derivation_type=row["derivation_type"],  # type: ignore[arg-type]
            subject_id=row["subject_id"],  # type: ignore[arg-type]
            reason=row["reason"],  # type: ignore[arg-type]
            floor_used=row["floor_used"],  # type: ignore[arg-type]
            recorded_at=str(row["recorded_at"]),
        )
        for row in rows
    ]


__all__ = [
    "DerivationLogEntry",
    "DerivationLogEventKind",
    "DerivationLogPayload",
    "DerivationLogQuery",
    "DerivationLogTarget",
    "LogEntry",
    "LogLevel",
    "LogQuery",
    "StoredDerivationLogEntry",
    "StoredLogEntry",
    "append_derivation_log",
    "query_derivation_log",
    "query_log",
    "write_log",
]
