"""Ported from packages/lhc/src/shared-tech/thread-migrate.ts. Phase 1 skeleton.

Thread-file schema migrations applied on open.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, TypedDict

from .storage import CURRENT_THREAD_SCHEMA_VERSION, Database, get_schema_version

if TYPE_CHECKING:
    from .work_queue import EnqueueDerivationTarget


THREAD_SCHEMA_VERSION_1 = 1
THREAD_SCHEMA_VERSION_2 = 2
THREAD_SCHEMA_VERSION_3 = 3
THREAD_SCHEMA_VERSION_4 = 4

_OLD_DERIVATION_TYPE = "smooth_turn_compression"
_NEW_DERIVATION_TYPE = "detailed_turn_compression"
_OLD_PROMPT_NAME = "smooth-turn-compression-v1"
_NEW_PROMPT_NAME = "detailed-turn-compression-v1"

_OLD_PROMPT_JSON = f'"prompt":"{_OLD_PROMPT_NAME}"'
_NEW_PROMPT_JSON = f'"prompt":"{_NEW_PROMPT_NAME}"'

# SQL literals from derivationLogSchemaStatements()'s return array in TS —
# held as a constant so the function body stays a Phase 1 skeleton.
_DERIVATION_LOG_SCHEMA_STATEMENTS: tuple[str, ...] = (
    """CREATE TABLE IF NOT EXISTS derivation_log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('message','turn','chunk')),
      subject_id TEXT NOT NULL,
      derivation_type TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );""",
    "CREATE INDEX IF NOT EXISTS idx_derivation_log_subject ON derivation_log (subject_kind, subject_id, derivation_type);",
    "CREATE INDEX IF NOT EXISTS idx_derivation_log_event ON derivation_log (event_kind);",
)


def derivation_log_schema_statements() -> list[str]:
    raise NotImplementedError


def _migrate_detailed_turn_compression_rename(db: Database) -> None:
    raise NotImplementedError


class _QueuedDerivationTarget(TypedDict):
    """EnqueueDerivationTarget's stored-payload shape (camelCase JSON keys)."""

    subjectKind: str
    subjectId: str
    derivationType: str


class _QueuedWorkItemPayload(TypedDict, total=False):
    sourceVersion: int
    operation: str
    derivations: list[_QueuedDerivationTarget]


_LEGACY_TURN_DERIVATION_COMPRESSION_TYPES: frozenset[str] = frozenset(
    {_OLD_DERIVATION_TYPE, _NEW_DERIVATION_TYPE}
)


def _turn_derivation_payload_needs_pre_detailed_assembly(payload: _QueuedWorkItemPayload) -> bool:
    raise NotImplementedError


def _migrated_turn_derivation_targets(
    turn_id: str,
) -> list[EnqueueDerivationTarget]:
    raise NotImplementedError


# Pre-rewire turn_derivation items scheduled compression inside the same handler;
# rewrite their derivations payload and seed pre_detailed_assembly so item 1 can
# complete and enqueue compression. Idempotent — safe on every open.
def _migrate_queued_turn_derivation_work_items(db: Database) -> None:
    raise NotImplementedError


def _run_queued_turn_derivation_migration(db: Database) -> None:
    raise NotImplementedError


def _migrate_one_shot_work_queue(db: Database) -> None:
    raise NotImplementedError


def migrate_thread_schema(db: Database) -> None:
    raise NotImplementedError


def is_supported_thread_schema_version(version: int) -> bool:
    raise NotImplementedError
