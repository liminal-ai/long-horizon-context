"""Ported from packages/lhc/test/thread-migrate.test.ts. Phase 1.

Below-SDK fixture setup here uses the stdlib sqlite3 module directly (not
open_raw/open_database) — the same choice the TS makes with node:sqlite's
DatabaseSync, since these helpers must construct legacy schema shapes the
current (post-migration) production seam would never write.
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from lhc import init_lhc, intake_stream, threads
from lhc.shared_tech.storage import get_schema_version
from lhc.threads import NewThreadInput
from lhc.shared_tech.thread_migrate import (
    THREAD_SCHEMA_VERSION_1,
    THREAD_SCHEMA_VERSION_2,
    THREAD_SCHEMA_VERSION_4,
)
from lhc.threads.internal.create import open_thread_database
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
    read_derived_forms,
    temp_store,
    valid_event,
)


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


class _PreparedStmt:
    """Mirrors node:sqlite StatementSync.get/.all/.run against a raw sqlite3.Connection."""

    def __init__(self, conn: sqlite3.Connection, sql: str) -> None:
        self._conn = conn
        self._sql = sql

    def get(self, *params: object) -> dict[str, object] | None:
        row = self._conn.execute(self._sql, params).fetchone()
        return dict(row) if row is not None else None

    def all(self, *params: object) -> list[dict[str, object]]:
        return [dict(row) for row in self._conn.execute(self._sql, params).fetchall()]

    def run(self, *params: object) -> None:
        self._conn.execute(self._sql, params)
        self._conn.commit()


class _RawDb:
    """Mirrors node:sqlite DatabaseSync's prepare/exec/close against a raw
    sqlite3.Connection, so fixture setup here matches the TS test's DatabaseSync
    usage — including passing straight into get_schema_version once Phase 2
    lands it.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def prepare(self, sql: str) -> _PreparedStmt:
        return _PreparedStmt(self._conn, sql)

    def exec(self, sql: str) -> None:
        self._conn.executescript(sql)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()


def _connect(file_path: str, read_only: bool = False) -> _RawDb:
    if read_only:
        conn = sqlite3.connect(f"file:{file_path}?mode=ro", uri=True)
    else:
        conn = sqlite3.connect(file_path)
    conn.row_factory = sqlite3.Row
    return _RawDb(conn)


def _add_legacy_queue_columns(db: _RawDb) -> None:
    db.exec("ALTER TABLE work_item ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;")
    db.exec("ALTER TABLE work_item ADD COLUMN last_error TEXT;")
    db.exec("ALTER TABLE work_item ADD COLUMN eligible_at TEXT;")
    db.exec("ALTER TABLE work_item ADD COLUMN claim_epoch INTEGER NOT NULL DEFAULT 0;")


def _simulate_v1_thread(file_path: str) -> None:
    db = _connect(file_path)
    try:
        _add_legacy_queue_columns(db)
        db.exec("DROP TABLE IF EXISTS derivation_log;")
        db.exec(f"PRAGMA user_version = {THREAD_SCHEMA_VERSION_1};")
    finally:
        db.close()


_RECEIPT_ACCOUNT_WITH_PROMPT_FILENAME = "edit packages/lhc/src/shared-tech/prompts/smooth-turn-compression-v1.ts"


def _simulate_v2_thread_with_old_derivation_names(file_path: str) -> None:
    metadata = json.dumps(
        {
            "receipts": [
                {
                    "messageId": "m1",
                    "activity": "tool_call",
                    "account": _RECEIPT_ACCOUNT_WITH_PROMPT_FILENAME,
                    "outcome": "succeeded",
                }
            ],
            "provenance": {"provider": "openai-codex", "model": "gpt-5.4-mini", "prompt": "smooth-turn-compression-v1"},
        },
        separators=(",", ":"),
    )
    log_payload = json.dumps(
        {
            "reason": _RECEIPT_ACCOUNT_WITH_PROMPT_FILENAME,
            "provenance": {"provider": "openai-codex", "model": "gpt-5.4-mini", "prompt": "smooth-turn-compression-v1"},
        },
        separators=(",", ":"),
    )
    db = _connect(file_path)
    try:
        _add_legacy_queue_columns(db)
        db.prepare(
            """INSERT INTO derivation
                 (subject_kind, subject_id, derivation_type, state, content, source_version)
               VALUES ('turn', 't1', 'smooth_turn_compression', 'ready', 'legacy compression', 1)"""
        ).run()
        db.prepare(
            """INSERT INTO derivation
                 (subject_kind, subject_id, derivation_type, state, content, metadata, source_version)
               VALUES ('turn', 't2', 'smooth_turn_compression', 'ready', 'legacy with receipts', ?, 1)"""
        ).run(metadata)
        db.prepare(
            """INSERT INTO derivation_log
                 (subject_kind, subject_id, derivation_type, event_kind, payload)
               VALUES ('turn', 't2', 'smooth_turn_compression', 'inference_succeeded', ?)"""
        ).run(log_payload)
        db.prepare(
            """INSERT INTO thread_view
                 (singleton, view_id, created_at, compact_point, covered_from, profile_name,
                  config_json, arrangement_json, gaps_json, source_state_json)
               VALUES (1, 'v1', '2026-01-01T00:00:00.000Z', 0, 0, NULL,
                 '{}',
                 '[{"band":"detailed","subjectKind":"turn","subjectId":"t1","derivationUsed":"smooth_turn_compression","degraded":false}]',
                 '[{"subjectId":"t1","reason":"smooth_turn_compression pending"}]',
                 '{"turns":{"t1":{"smooth_turn_compression":"ready"}}}')"""
        ).run()
        db.exec(f"PRAGMA user_version = {THREAD_SCHEMA_VERSION_2};")
    finally:
        db.close()


async def _fixture_poisoned_turn_derivation_work_item(
    file_path: str,
    downgrade_to_v2: bool = False,
    work_status: str | None = None,
    crash_window: bool = False,
) -> None:
    result = await intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "migration drain test"}}),
            valid_event("assistant_text", {"payload": {"text": "migration answer"}}),
            valid_event("turn_end"),
        ],
    )
    if not result.ok:
        raise RuntimeError(f"fixture intake failed: {result.error.reason}")

    db = _connect(file_path)
    try:
        row = db.prepare("SELECT payload FROM work_item WHERE kind = 'turn_derivation'").get()
        if row is None:
            raise RuntimeError("fixture invariant: turn_derivation work item expected")
        payload = json.loads(row["payload"])
        source_version = payload.get("sourceVersion", 1)
        # crash_window: the payload is already rewritten to the new-shape
        # target (pre_detailed_assembly) but the crash struck before its
        # pending row could be created — the row-create step below is
        # skipped. Otherwise the payload still names the old-shape target
        # (detailed_turn_compression); normalization on reopen must rewrite
        # the payload itself to the new-shape pair.
        if crash_window:
            derivations = [
                {"subjectKind": "turn", "subjectId": "t1", "derivationType": "turn_rendering"},
                {"subjectKind": "turn", "subjectId": "t1", "derivationType": "pre_detailed_assembly"},
            ]
        else:
            derivations = [
                {"subjectKind": "turn", "subjectId": "t1", "derivationType": "turn_rendering"},
                {"subjectKind": "turn", "subjectId": "t1", "derivationType": "detailed_turn_compression"},
            ]
        db.prepare("UPDATE work_item SET payload = ? WHERE kind = 'turn_derivation'").run(
            json.dumps(
                {
                    "sourceVersion": source_version,
                    "operation": payload.get("operation"),
                    "derivations": derivations,
                },
                separators=(",", ":"),
            )
        )
        db.prepare("DELETE FROM derivation WHERE derivation_type = 'pre_detailed_assembly'").run()
        if not crash_window:
            db.prepare(
                """INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
                   VALUES ('turn', 't1', 'detailed_turn_compression', 'pending', ?)
                   ON CONFLICT (subject_kind, subject_id, derivation_type) DO UPDATE SET
                     state = 'pending', content = NULL, reason = NULL, metadata = NULL,
                     gaps = NULL, derived_at = NULL, source_version = excluded.source_version"""
            ).run(source_version)
        if work_status == "claimed":
            db.prepare(
                """UPDATE work_item
                   SET status = 'claimed',
                       claimed_at = '2020-01-01T00:00:00.000Z',
                       claim_expires_at = '2020-01-01T00:00:00.000Z'
                   WHERE kind = 'turn_derivation'"""
            ).run()
        if downgrade_to_v2:
            _add_legacy_queue_columns(db)
            db.exec(f"PRAGMA user_version = {THREAD_SCHEMA_VERSION_2};")
    finally:
        db.close()


def _form_of(file_path: str, derivation_type: str):
    return next(
        (
            form
            for form in read_derived_forms(file_path)
            if form.subject_id == "t1" and form.derivation_type == derivation_type
        ),
        None,
    )


async def _drain_turn_derivations_green(file_path: str) -> None:
    double = create_inference_callbacks_double()
    sdk = init_lhc({"inferenceCallbacks": double, "mode": "manual", "lease": {"durationMs": 200}})
    drain = await sdk.work.drain({"filePath": file_path})
    assert drain.ok is True
    if not drain.ok:
        return

    rendering = _form_of(file_path, "turn_rendering")
    assert rendering is not None
    assert rendering.state == "ready"
    assembly = _form_of(file_path, "pre_detailed_assembly")
    assert assembly is not None
    assert assembly.state == "ready"
    assert assembly.content is not None
    assert "User:\n" in assembly.content
    assert "⏺ " in assembly.content
    compression = _form_of(file_path, "detailed_turn_compression")
    assert compression is not None
    assert compression.state == "ready"

    queue_db = _connect(file_path, read_only=True)
    try:
        row = queue_db.prepare(
            "SELECT COUNT(*) AS count FROM work_item WHERE status IN ('queued', 'claimed')"
        ).get()
        assert row is not None
        assert row["count"] == 0
    finally:
        queue_db.close()


async def test_opens_a_v1_thread_file_migrates_derivation_log_and_preserves_existing_data(store: TempStore) -> None:
    """opens a v1 thread file, migrates derivation_log, and preserves existing data"""
    file_path = store.thread_path()
    created = await threads.new_thread(NewThreadInput(file_path=file_path, registry_path=store.registry_path))
    assert created.ok is True
    if not created.ok:
        return

    thread_id = created.value.thread_id
    _simulate_v1_thread(file_path)

    before = _connect(file_path, read_only=True)
    try:
        assert get_schema_version(before) == THREAD_SCHEMA_VERSION_1
        assert (
            before.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'derivation_log'"
            ).get()
            is None
        )
    finally:
        before.close()

    opened = open_thread_database(file_path)
    assert opened.ok is True
    if not opened.ok:
        return

    db = opened.value
    try:
        assert get_schema_version(db) == THREAD_SCHEMA_VERSION_4
        assert (
            db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'derivation_log'").get()
            is not None
        )
        metadata = db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").get()
        assert metadata is not None
        assert metadata["thread_id"] == thread_id
        turn_count = db.prepare("SELECT COUNT(*) AS count FROM turns").get()
        assert int(turn_count["count"]) == 1
    finally:
        db.close()


async def test_migrates_v2_derivation_rows_and_stored_view_json(store: TempStore) -> None:
    """migrates v2 derivation rows and stored view JSON from smooth_turn_compression to detailed_turn_compression"""
    file_path = store.thread_path()
    created = await threads.new_thread(NewThreadInput(file_path=file_path, registry_path=store.registry_path))
    assert created.ok is True
    if not created.ok:
        return

    _simulate_v2_thread_with_old_derivation_names(file_path)

    opened = open_thread_database(file_path)
    assert opened.ok is True
    if not opened.ok:
        return

    db = opened.value
    try:
        assert get_schema_version(db) == THREAD_SCHEMA_VERSION_4
        derivation = db.prepare(
            """SELECT derivation_type, content FROM derivation
               WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'detailed_turn_compression'"""
        ).get()
        assert derivation is not None
        assert derivation["derivation_type"] == "detailed_turn_compression"
        assert derivation["content"] == "legacy compression"
        assert (
            db.prepare("SELECT 1 FROM derivation WHERE derivation_type = 'smooth_turn_compression'").get() is None
        )

        view = db.prepare(
            "SELECT arrangement_json, gaps_json, source_state_json FROM thread_view WHERE singleton = 1"
        ).get()
        assert '"derivationUsed":"detailed_turn_compression"' in view["arrangement_json"]
        assert "smooth_turn_compression" not in view["arrangement_json"]
        assert "detailed_turn_compression" in view["gaps_json"]
        assert "smooth_turn_compression" not in view["gaps_json"]
        assert "detailed_turn_compression" in view["source_state_json"]
        assert "smooth_turn_compression" not in view["source_state_json"]

        migrated_metadata = db.prepare(
            """SELECT metadata FROM derivation
               WHERE subject_kind = 'turn' AND subject_id = 't2' AND derivation_type = 'detailed_turn_compression'"""
        ).get()
        assert migrated_metadata is not None
        parsed_metadata = json.loads(migrated_metadata["metadata"])
        assert parsed_metadata["receipts"][0]["account"] == _RECEIPT_ACCOUNT_WITH_PROMPT_FILENAME
        assert parsed_metadata["provenance"]["prompt"] == "detailed-turn-compression-v1"

        migrated_log = db.prepare(
            """SELECT payload FROM derivation_log
               WHERE subject_kind = 'turn' AND subject_id = 't2' AND derivation_type = 'detailed_turn_compression'"""
        ).get()
        assert migrated_log is not None
        parsed_log_payload = json.loads(migrated_log["payload"])
        assert parsed_log_payload["reason"] == _RECEIPT_ACCOUNT_WITH_PROMPT_FILENAME
        assert parsed_log_payload["provenance"]["prompt"] == "detailed-turn-compression-v1"
    finally:
        db.close()


async def test_normalizes_queued_old_shape_turn_derivation_items_and_drains_cleanly(store: TempStore) -> None:
    """normalizes queued old-shape turn_derivation items and drains cleanly end to end"""
    file_path = store.thread_path()
    created = await threads.new_thread(NewThreadInput(file_path=file_path, registry_path=store.registry_path))
    assert created.ok is True
    if not created.ok:
        return

    await _fixture_poisoned_turn_derivation_work_item(file_path, downgrade_to_v2=True)

    opened = open_thread_database(file_path)
    assert opened.ok is True
    if not opened.ok:
        return

    db = opened.value
    try:
        assert get_schema_version(db) == THREAD_SCHEMA_VERSION_4
        payload = json.loads(
            db.prepare("SELECT payload FROM work_item WHERE kind = 'turn_derivation'").get()["payload"]
        )
        assert sorted(target["derivationType"] for target in payload["derivations"]) == [
            "pre_detailed_assembly",
            "turn_rendering",
        ]
        state_row = db.prepare(
            """SELECT state FROM derivation
               WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'pre_detailed_assembly'"""
        ).get()
        assert state_row["state"] == "pending"
    finally:
        db.close()

    await _drain_turn_derivations_green(file_path)


async def test_normalizes_a_claimed_old_shape_item_then_fails_its_expired_lease(store: TempStore) -> None:
    """normalizes a claimed old-shape item, then fails its expired lease without rerunning it"""
    file_path = store.thread_path()
    created = await threads.new_thread(NewThreadInput(file_path=file_path, registry_path=store.registry_path))
    assert created.ok is True
    if not created.ok:
        return

    await _fixture_poisoned_turn_derivation_work_item(file_path, work_status="claimed")

    opened = open_thread_database(file_path)
    assert opened.ok is True
    if not opened.ok:
        return

    db = opened.value
    try:
        work = db.prepare("SELECT status, payload FROM work_item WHERE kind = 'turn_derivation'").get()
        assert work["status"] == "claimed"
        payload = json.loads(work["payload"])
        assert sorted(target["derivationType"] for target in payload["derivations"]) == [
            "pre_detailed_assembly",
            "turn_rendering",
        ]
        state_row = db.prepare(
            """SELECT state FROM derivation
               WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'pre_detailed_assembly'"""
        ).get()
        assert state_row["state"] == "pending"
    finally:
        db.close()

    sdk = init_lhc({"inferenceCallbacks": create_inference_callbacks_double(), "mode": "manual"})
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok is True
    if not drained.ok:
        return
    assert any(
        entry.work_item_id == "w-t1-turn_derivation-v1"
        and entry.disposition == "failed_terminal"
        and entry.reason == "claim_expired"
        for entry in drained.value.ran
    )
    rendering = _form_of(file_path, "turn_rendering")
    assert rendering is not None
    assert rendering.state == "failed"
    assert rendering.reason == "claim_expired"
    assembly = _form_of(file_path, "pre_detailed_assembly")
    assert assembly is not None
    assert assembly.state == "failed"
    assert assembly.reason == "claim_expired"


async def test_heals_a_crash_window_partial_normalization_on_reopen(store: TempStore) -> None:
    """heals a crash-window partial normalization on reopen (new-shape payload, missing assembly row)"""
    file_path = store.thread_path()
    created = await threads.new_thread(NewThreadInput(file_path=file_path, registry_path=store.registry_path))
    assert created.ok is True
    if not created.ok:
        return

    await _fixture_poisoned_turn_derivation_work_item(file_path, crash_window=True)

    before = _connect(file_path, read_only=True)
    try:
        row = before.prepare("SELECT payload FROM work_item WHERE kind = 'turn_derivation'").get()
        assert row is not None
        payload = json.loads(row["payload"])
        assert any(target["derivationType"] == "pre_detailed_assembly" for target in payload["derivations"])
        assert (
            before.prepare(
                """SELECT 1 FROM derivation
                   WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'pre_detailed_assembly'"""
            ).get()
            is None
        )
    finally:
        before.close()

    opened = open_thread_database(file_path)
    assert opened.ok is True
    if not opened.ok:
        return

    db = opened.value
    try:
        state_row = db.prepare(
            """SELECT state FROM derivation
               WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'pre_detailed_assembly'"""
        ).get()
        assert state_row["state"] == "pending"
    finally:
        db.close()

    await _drain_turn_derivations_green(file_path)
