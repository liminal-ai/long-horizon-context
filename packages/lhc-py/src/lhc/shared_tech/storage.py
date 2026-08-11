"""Ported from packages/lhc/src/shared-tech/storage.ts.

`node:sqlite` DatabaseSync → stdlib sqlite3 behind this adapter seam.
WAL-on-open and prepare/get/all/run semantics mirror node:sqlite.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Protocol, runtime_checkable
from weakref import WeakKeyDictionary


@runtime_checkable
class PreparedStatement(Protocol):
    """Mirrors node:sqlite StatementSync prepare/get/all/run semantics."""

    def get(self, *params: object) -> dict[str, object] | None: ...

    def all(self, *params: object) -> list[dict[str, object]]: ...

    def run(self, *params: object) -> object: ...


@runtime_checkable
class Database(Protocol):
    """Adapter seam for node:sqlite DatabaseSync.

    Concrete Phase 2 implementation wraps sqlite3.Connection with WAL on open.
    """

    def prepare(self, sql: str) -> PreparedStatement: ...

    def exec(self, sql: str) -> None: ...

    def close(self) -> None: ...


# Re-export the stdlib type name for call sites that need a concrete annotation
# while the Protocol seam is the public surface.
SqliteConnection = sqlite3.Connection

CURRENT_THREAD_SCHEMA_VERSION = 6

# node:sqlite DatabaseSync path registry (WeakMap).
_database_paths: WeakKeyDictionary[Database, str] = WeakKeyDictionary()


@dataclass(frozen=True, slots=True)
class _StatementRunResult:
    """node:sqlite StatementResult — changes + lastInsertRowid."""

    changes: int
    lastInsertRowid: int


def _split_sql_statements(sql: str) -> list[str]:
    """Split a SQL script into statements without executing a COMMIT.

    Avoids sqlite3.executescript(), which always COMMITs any open transaction
    before running (breaking BEGIN / write / ROLLBACK). Handles quotes and
    line/block comments so semicolons inside them are not separators.
    """
    statements: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(sql)
    in_single = False
    in_double = False
    in_line_comment = False
    in_block_comment = False
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if in_line_comment:
            buf.append(ch)
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            buf.append(ch)
            if ch == "*" and nxt == "/":
                buf.append(nxt)
                i += 2
                in_block_comment = False
                continue
            i += 1
            continue
        if in_single:
            buf.append(ch)
            if ch == "'" and nxt == "'":
                buf.append(nxt)
                i += 2
                continue
            if ch == "'":
                in_single = False
            i += 1
            continue
        if in_double:
            buf.append(ch)
            if ch == '"' and nxt == '"':
                buf.append(nxt)
                i += 2
                continue
            if ch == '"':
                in_double = False
            i += 1
            continue
        if ch == "-" and nxt == "-":
            buf.append(ch)
            buf.append(nxt)
            i += 2
            in_line_comment = True
            continue
        if ch == "/" and nxt == "*":
            buf.append(ch)
            buf.append(nxt)
            i += 2
            in_block_comment = True
            continue
        if ch == "'":
            buf.append(ch)
            in_single = True
            i += 1
            continue
        if ch == '"':
            buf.append(ch)
            in_double = True
            i += 1
            continue
        if ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                statements.append(stmt)
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    stmt = "".join(buf).strip()
    if stmt:
        statements.append(stmt)
    return statements


class _SqlitePreparedStatement:
    """Mirrors node:sqlite StatementSync against a sqlite3 connection."""

    def __init__(self, conn: sqlite3.Connection, sql: str) -> None:
        self._conn = conn
        self._sql = sql

    def get(self, *params: object) -> dict[str, object] | None:
        row = self._conn.execute(self._sql, params).fetchone()
        return dict(row) if row is not None else None

    def all(self, *params: object) -> list[dict[str, object]]:
        return [dict(row) for row in self._conn.execute(self._sql, params).fetchall()]

    def run(self, *params: object) -> object:
        # Autocommit when not inside BEGIN (isolation_level=None), matching
        # node:sqlite StatementSync.run — never force-commit mid-transaction.
        cursor = self._conn.execute(self._sql, params)
        changes = cursor.rowcount if cursor.rowcount is not None and cursor.rowcount >= 0 else 0
        last_id = int(cursor.lastrowid) if cursor.lastrowid is not None else 0
        return _StatementRunResult(changes=changes, lastInsertRowid=last_id)


class _SqliteDatabase:
    """Concrete DatabaseSync stand-in: prepare / exec / close + WAL on open."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def prepare(self, sql: str) -> _SqlitePreparedStatement:
        return _SqlitePreparedStatement(self._conn, sql)

    def exec(self, sql: str) -> None:
        # Must NOT use executescript — it COMMITs any open transaction first,
        # which breaks BEGIN / prepared write / ROLLBACK. Split and execute
        # each statement on the open connection (node:sqlite exec semantics).
        for statement in _split_sql_statements(sql):
            self._conn.execute(statement)

    def close(self) -> None:
        self._conn.close()


def open_database(path: str) -> Database:
    # isolation_level=None → SQLite autocommit (node:sqlite default): each
    # statement commits unless the caller opened a transaction with BEGIN.
    conn = sqlite3.connect(path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    db = _SqliteDatabase(conn)
    _database_paths[db] = path
    db.exec("PRAGMA journal_mode = WAL;")
    db.exec("PRAGMA foreign_keys = ON;")
    db.exec("PRAGMA busy_timeout = 5000;")
    db.exec("PRAGMA synchronous = NORMAL;")
    return db


def database_path_for(db: Database) -> str | None:
    return _database_paths.get(db)


def get_schema_version(db: Database) -> int:
    row = db.prepare("PRAGMA user_version").get()
    if row is None:
        return 0
    value = row.get("user_version", 0)
    return int(value) if value is not None else 0
