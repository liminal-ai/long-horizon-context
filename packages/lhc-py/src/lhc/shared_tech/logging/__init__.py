"""Ported from packages/lhc/src/shared-tech/logging/index.ts. Phase 1 skeleton.

The logging surface: a domain-blind tech-util for recording fallback
events and diagnostics. LHC internals and the host extension both write
through this surface. Writes are fail-soft and never share the caller's
transaction. Queries return entries by actionable fields.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..persist import DbReadTransaction, DbWriteTransaction
from ..storage import Database
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
    raise NotImplementedError


# Write a log entry. Fail-soft: never throws to the caller, never shares
# the caller's transaction. A logging failure is contained and does not
# affect the operation that produced the log entry.
def write_log(transaction: DbReadTransaction | DbWriteTransaction, entry: LogEntry) -> None:
    raise NotImplementedError


# Query log entries by actionable fields. Returns all matching entries in
# descending order of recorded_at (newest first).
def query_log(db: Database, q: LogQuery) -> list[StoredLogEntry]:
    raise NotImplementedError


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
