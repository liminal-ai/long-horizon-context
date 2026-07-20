"""Ported from packages/lhc/src/shared-tech/storage.ts. Phase 1 skeleton.

`node:sqlite` DatabaseSync → stdlib sqlite3 behind this adapter seam.
Phase 1: signatures only; WAL-on-open and prepare/get/all/run semantics land
in Phase 2.
"""

from __future__ import annotations

import sqlite3
from typing import Protocol, runtime_checkable


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

CURRENT_THREAD_SCHEMA_VERSION = 4


def open_database(path: str) -> Database:
    raise NotImplementedError


def database_path_for(db: Database) -> str | None:
    raise NotImplementedError


def get_schema_version(db: Database) -> int:
    raise NotImplementedError
