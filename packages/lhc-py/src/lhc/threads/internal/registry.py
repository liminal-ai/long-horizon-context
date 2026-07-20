"""Ported from packages/lhc/src/threads/internal/registry.ts. Phase 1 skeleton.

Registry helpers: path resolution, open for read/write, row insert/select.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ...shared_tech.storage import Database

DEFAULT_REGISTRY_PATH = str(Path.home() / ".lhc" / "registry.sqlite")

_REGISTRY_SCHEMA_STATEMENTS: tuple[str, ...] = (
    """CREATE TABLE threads (
    thread_id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    title TEXT,
    cwd TEXT,
    created_at TEXT NOT NULL
  );""",
)

_ROW_COLUMNS = "thread_id, file_path, title, cwd, created_at"

# Insertion order (rowid) breaks ties at the same created_at timestamp, so
# "most recent" (the last row) is the last-inserted thread even when two
# creations land in the same millisecond — the determinism `--continue`
# (resolve the most recently created thread) relies on.
_ROW_ORDER = "ORDER BY created_at, rowid"


def resolve_registry_path(registry_path: str | None = None) -> str:
    raise NotImplementedError


def _has_no_schema(db: Database) -> bool:
    raise NotImplementedError


# First write creates the current registry file and schema lazily.
def open_registry_for_write(registry_path: str) -> Database:
    raise NotImplementedError


# Reads never create the registry: callers map null to empty list /
# thread_not_found. The existence check is the non-creation guarantee —
# openDatabase would create the file.
def open_registry_for_read(registry_path: str) -> Database | None:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class RegistryRow:
    thread_id: str
    file_path: str
    created_at: str
    title: str | None = None
    cwd: str | None = None


@dataclass(frozen=True, slots=True)
class _RawRow:
    thread_id: str
    file_path: str
    title: str | None
    cwd: str | None
    created_at: str


def _to_registry_row(raw: _RawRow) -> RegistryRow:
    raise NotImplementedError


def insert_thread_row(db: Database, row: RegistryRow) -> None:
    raise NotImplementedError


def select_thread_row(db: Database, thread_id: str) -> RegistryRow | None:
    raise NotImplementedError


# Partial-id resolve (A-8): every thread whose id begins with the given prefix.
def select_thread_rows_by_prefix(db: Database, prefix: str) -> list[RegistryRow]:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class SelectAllThreadRowsOpts:
    cwd: str | None = None


# cwd, when given, filters at the registry (A-8): the picker must not scope by
# filtering an unscoped list after the fact (anti-shim) — the scope is the query.
def select_all_thread_rows(
    db: Database,
    opts: SelectAllThreadRowsOpts | None = None,
) -> list[RegistryRow]:
    raise NotImplementedError
