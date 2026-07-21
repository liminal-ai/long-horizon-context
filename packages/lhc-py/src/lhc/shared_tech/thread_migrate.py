"""Ported from packages/lhc/src/shared-tech/thread-migrate.ts.

Thread-file schema migrations applied on open.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Literal

from .storage import CURRENT_THREAD_SCHEMA_VERSION, Database, get_schema_version

if TYPE_CHECKING:
    from .work_queue import EnqueueDerivationTarget, _QueuedWorkItemPayload


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
    return list(_DERIVATION_LOG_SCHEMA_STATEMENTS)


def _migrate_detailed_turn_compression_rename(db: Database) -> None:
    db.prepare("UPDATE derivation SET derivation_type = ? WHERE derivation_type = ?").run(
        _NEW_DERIVATION_TYPE, _OLD_DERIVATION_TYPE
    )
    db.prepare("UPDATE derivation_log SET derivation_type = ? WHERE derivation_type = ?").run(
        _NEW_DERIVATION_TYPE, _OLD_DERIVATION_TYPE
    )
    db.prepare("UPDATE log SET derivation_type = ? WHERE derivation_type = ?").run(
        _NEW_DERIVATION_TYPE, _OLD_DERIVATION_TYPE
    )
    db.prepare("UPDATE derivation SET metadata = REPLACE(metadata, ?, ?) WHERE metadata LIKE ?").run(
        _OLD_PROMPT_JSON, _NEW_PROMPT_JSON, f"%{_OLD_PROMPT_JSON}%"
    )
    db.prepare(
        "UPDATE derivation_log SET payload = REPLACE(payload, ?, ?) WHERE payload LIKE ?"
    ).run(_OLD_PROMPT_JSON, _NEW_PROMPT_JSON, f"%{_OLD_PROMPT_JSON}%")
    db.prepare("UPDATE log SET message = REPLACE(message, ?, ?) WHERE message LIKE ?").run(
        _OLD_DERIVATION_TYPE, _NEW_DERIVATION_TYPE, f"%{_OLD_DERIVATION_TYPE}%"
    )
    db.prepare(
        """UPDATE thread_view SET
             arrangement_json = REPLACE(arrangement_json, ?, ?),
             gaps_json = REPLACE(gaps_json, ?, ?),
             source_state_json = REPLACE(source_state_json, ?, ?)
           WHERE arrangement_json LIKE ?
              OR gaps_json LIKE ?
              OR source_state_json LIKE ?"""
    ).run(
        _OLD_DERIVATION_TYPE,
        _NEW_DERIVATION_TYPE,
        _OLD_DERIVATION_TYPE,
        _NEW_DERIVATION_TYPE,
        _OLD_DERIVATION_TYPE,
        _NEW_DERIVATION_TYPE,
        f"%{_OLD_DERIVATION_TYPE}%",
        f"%{_OLD_DERIVATION_TYPE}%",
        f"%{_OLD_DERIVATION_TYPE}%",
    )


# Canonical stored payload TypedDicts (`_QueuedWorkItemPayload` etc.) live in
# work_queue (TS owner). Imported under TYPE_CHECKING only — a runtime import
# would cycle (work_queue → persist → threads → thread_migrate).

_LEGACY_TURN_DERIVATION_COMPRESSION_TYPES: frozenset[str] = frozenset(
    {_OLD_DERIVATION_TYPE, _NEW_DERIVATION_TYPE}
)


def _turn_derivation_payload_needs_pre_detailed_assembly(payload: _QueuedWorkItemPayload) -> bool:
    derivations = payload.get("derivations")
    if derivations is None:
        derivations = []
    if not any(target.get("derivationType") == "turn_rendering" for target in derivations):
        return False
    if any(target.get("derivationType") == "pre_detailed_assembly" for target in derivations):
        return False
    return any(
        target.get("derivationType") in _LEGACY_TURN_DERIVATION_COMPRESSION_TYPES
        for target in derivations
    )


def _migrated_turn_derivation_targets(
    turn_id: str,
) -> list[EnqueueDerivationTarget]:
    from .work_queue import EnqueueDerivationTarget

    return [
        EnqueueDerivationTarget(
            subject_kind="turn", subject_id=turn_id, derivation_type="turn_rendering"
        ),
        EnqueueDerivationTarget(
            subject_kind="turn",
            subject_id=turn_id,
            derivation_type="pre_detailed_assembly",
        ),
    ]


# Pre-rewire turn_derivation items scheduled compression inside the same handler;
# rewrite their derivations payload and seed pre_detailed_assembly so item 1 can
# complete and enqueue compression. Idempotent — safe on every open.
def _migrate_queued_turn_derivation_work_items(db: Database) -> None:
    rows = db.prepare(
        """SELECT work_item_id, source_ref, payload
           FROM work_item
           WHERE kind = 'turn_derivation' AND status IN ('queued', 'claimed')"""
    ).all()
    update_payload = db.prepare("UPDATE work_item SET payload = ? WHERE work_item_id = ?")
    seed_assembly = db.prepare(
        """INSERT OR IGNORE INTO derivation
             (subject_kind, subject_id, derivation_type, state, source_version)
           VALUES ('turn', ?, 'pre_detailed_assembly', 'pending', ?)"""
    )
    assembly_row_exists = db.prepare(
        """SELECT 1 AS present FROM derivation
           WHERE subject_kind = 'turn' AND subject_id = ?
             AND derivation_type = 'pre_detailed_assembly'"""
    )
    for row in rows:
        source_ref = json.loads(str(row["source_ref"]))
        turn_id = source_ref.get("turnId") if isinstance(source_ref, dict) else None
        if not isinstance(turn_id, str):
            continue
        payload = json.loads(str(row["payload"]))
        # TS parity: property access on null throws (fail-closed -> rollback);
        # on any other non-object it yields undefined, so migration treats the
        # row as an empty payload rather than skipping it.
        if payload is None:
            raise TypeError("cannot read properties of null (reading 'sourceVersion')")
        if not isinstance(payload, dict):
            payload = {}
        source_version = payload.get("sourceVersion")
        if source_version is None:
            source_version = 1
        needs_payload_migration = _turn_derivation_payload_needs_pre_detailed_assembly(payload)
        derivations = payload.get("derivations")
        if derivations is None:
            derivations = []
        targets_assembly = any(
            isinstance(target, dict)
            and target.get("derivationType") == "pre_detailed_assembly"
            for target in derivations
        )
        needs_assembly_seed = needs_payload_migration or (
            targets_assembly and assembly_row_exists.get(turn_id) is None
        )
        if not needs_payload_migration and not needs_assembly_seed:
            continue
        if needs_assembly_seed:
            seed_assembly.run(turn_id, source_version)
        if needs_payload_migration:
            next_payload = dict(payload)
            next_payload["derivations"] = [
                {
                    "subjectKind": target.subject_kind,
                    "subjectId": target.subject_id,
                    "derivationType": target.derivation_type,
                }
                for target in _migrated_turn_derivation_targets(turn_id)
            ]
            update_payload.run(
                json.dumps(next_payload, separators=(",", ":"), ensure_ascii=False),
                row["work_item_id"],
            )


def _run_queued_turn_derivation_migration(db: Database) -> None:
    db.exec("BEGIN IMMEDIATE;")
    try:
        _migrate_queued_turn_derivation_work_items(db)
        db.exec("COMMIT;")
    except BaseException:
        db.exec("ROLLBACK;")
        raise


def _migrate_one_shot_work_queue(db: Database) -> None:
    db.exec("DROP INDEX idx_work_item_queue;")
    db.exec("ALTER TABLE work_item DROP COLUMN attempts;")
    db.exec("ALTER TABLE work_item DROP COLUMN last_error;")
    db.exec("ALTER TABLE work_item DROP COLUMN eligible_at;")
    db.exec("ALTER TABLE work_item DROP COLUMN claim_epoch;")
    db.exec("CREATE INDEX idx_work_item_queue ON work_item (status);")


def migrate_thread_schema(db: Database) -> None:
    version = get_schema_version(db)
    if version >= CURRENT_THREAD_SCHEMA_VERSION:
        _run_queued_turn_derivation_migration(db)
        return
    if version < THREAD_SCHEMA_VERSION_1:
        raise RuntimeError(f"unsupported thread schema version {version}")

    db.exec("BEGIN IMMEDIATE;")
    try:
        if version == THREAD_SCHEMA_VERSION_1:
            for statement in derivation_log_schema_statements():
                db.exec(statement)
            version = THREAD_SCHEMA_VERSION_2
        if version == THREAD_SCHEMA_VERSION_2:
            _migrate_detailed_turn_compression_rename(db)
            version = THREAD_SCHEMA_VERSION_3
        if version == THREAD_SCHEMA_VERSION_3:
            _migrate_queued_turn_derivation_work_items(db)
            _migrate_one_shot_work_queue(db)
            version = THREAD_SCHEMA_VERSION_4
        if version != CURRENT_THREAD_SCHEMA_VERSION:
            raise RuntimeError(f"unsupported thread schema version {version}")
        db.exec(f"PRAGMA user_version = {CURRENT_THREAD_SCHEMA_VERSION};")
        db.exec("COMMIT;")
    except BaseException:
        db.exec("ROLLBACK;")
        raise


def is_supported_thread_schema_version(version: int) -> bool:
    return THREAD_SCHEMA_VERSION_1 <= version <= CURRENT_THREAD_SCHEMA_VERSION
