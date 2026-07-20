"""Ported from packages/lhc/src/threads/internal/create.ts. Phase 1 skeleton.

Thread-file create/open/delete and the one random id generator.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ...shared_tech.errors import OpErr, OpResult
from ...shared_tech.storage import CURRENT_THREAD_SCHEMA_VERSION, Database
from ...shared_tech.thread_migrate import THREAD_SCHEMA_VERSION_1
from ...shared_tech.token_counting import TOKEN_ESTIMATOR_ID

# SQL literals from threadSchemaStatements()'s return array in TS — held so
# the helper body stays a Phase 1 skeleton. Interpolated slots match TS.
_THREAD_SCHEMA_STATEMENT_TEMPLATES: tuple[str, ...] = (
    """CREATE TABLE thread_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      token_estimator TEXT NOT NULL
    );""",
    """INSERT INTO thread_metadata (id, thread_id, created_at, token_estimator)
     VALUES (1, '{thread_id}', '{created_at}', '{token_estimator}');""",
    """CREATE TABLE event (
      event_order INTEGER PRIMARY KEY,
      event_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      actor TEXT NOT NULL,
      harness TEXT NOT NULL,
      payload TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );""",
    """CREATE TABLE turns (
      turn_id TEXT PRIMARY KEY,
      turn_order INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
      opened_at_event_order INTEGER NOT NULL,
      closed_at_event_order INTEGER,
      deleted_at TEXT
    );""",
    """CREATE TABLE message (
      message_id TEXT PRIMARY KEY,
      source_event_order INTEGER NOT NULL UNIQUE REFERENCES event(event_order),
      kind TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      actor TEXT NOT NULL,
      harness TEXT NOT NULL,
      turn_id TEXT NOT NULL REFERENCES turns(turn_id),
      deleted_at TEXT
    );""",
    """CREATE TABLE message_block (
      message_id TEXT NOT NULL REFERENCES message(message_id),
      block_index INTEGER NOT NULL,
      block_type TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (message_id, block_index)
    );""",
    """CREATE TABLE work_item (
      work_item_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      claimed_at TEXT,
      claim_expires_at TEXT,
      payload TEXT NOT NULL
    );""",
    """CREATE INDEX idx_work_item_queue ON work_item (status);""",
    """CREATE INDEX idx_message_block_tool_call_id
       ON message_block (block_type, json_extract(content, '$.toolCallId'));""",
    """CREATE TABLE derivation (
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('message','turn','chunk')),
      subject_id TEXT NOT NULL,
      derivation_type TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','ready','failed','blocked')),
      content TEXT,
      reason TEXT,
      metadata TEXT,
      source_version INTEGER NOT NULL DEFAULT 1,
      gaps TEXT,
      derived_at TEXT,
      PRIMARY KEY (subject_kind, subject_id, derivation_type)
    );""",
    """CREATE TABLE chunk (
      chunk_id TEXT PRIMARY KEY,
      chunk_order INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('open','closed')),
      accumulated_projected_tokens INTEGER NOT NULL DEFAULT 0
    );""",
    """CREATE TABLE chunk_member (
      chunk_id TEXT NOT NULL REFERENCES chunk(chunk_id),
      turn_id TEXT NOT NULL UNIQUE REFERENCES turns(turn_id),
      member_idx INTEGER NOT NULL,
      PRIMARY KEY (chunk_id, member_idx)
    );""",
    """CREATE TABLE thread_view (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      view_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      compact_point INTEGER NOT NULL,
      covered_from INTEGER NOT NULL,
      profile_name TEXT,
      config_json TEXT NOT NULL,
      arrangement_json TEXT NOT NULL,
      gaps_json TEXT NOT NULL,
      source_state_json TEXT NOT NULL
    );""",
    """CREATE TABLE thread_view_band (
      view_id TEXT NOT NULL REFERENCES thread_view(view_id) ON DELETE CASCADE,
      band TEXT NOT NULL CHECK (band IN ('brief','detailed','smooth')),
      rendered_text TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      PRIMARY KEY (view_id, band)
    );""",
    """CREATE TABLE view_boundary (
      thread_singleton INTEGER PRIMARY KEY CHECK (thread_singleton = 1),
      position INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );""",
    """INSERT INTO view_boundary (thread_singleton, position, updated_at)
      VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));""",
    """CREATE TABLE log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL CHECK (level IN ('info','warning','error')),
      message TEXT NOT NULL,
      derivation_type TEXT,
      subject_id TEXT,
      reason TEXT,
      floor_used TEXT,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );""",
    """CREATE INDEX idx_log_level ON log (level);""",
    """CREATE INDEX idx_log_derivation_type ON log (derivation_type);""",
    """CREATE INDEX idx_log_subject_id ON log (subject_id);""",
    """CREATE INDEX idx_log_reason ON log (reason);""",
    # ...derivationLogSchemaStatements() spliced at Phase 2
    """INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order)
     VALUES ('t1', 1, 'open', 0);""",
    """PRAGMA user_version = {schema_version};""",
)

# Names the TS helper closes over (kept for Phase 2 fidelity).
_ = (TOKEN_ESTIMATOR_ID, CURRENT_THREAD_SCHEMA_VERSION, THREAD_SCHEMA_VERSION_1)


def generate_thread_id() -> str:
    raise NotImplementedError


def _thread_schema_statements(thread_id: str, created_at: str) -> list[str]:
    raise NotImplementedError


def _not_a_thread_file(file_path: str, detail: str) -> OpErr:
    raise NotImplementedError


def _error_detail(cause: object) -> str:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _ValidateThreadFileOk:
    """TS validateThreadFile success is exactly `{ ok: true }` — no value field."""

    ok: Literal[True] = True


def _validate_thread_file(file_path: str) -> _ValidateThreadFileOk | OpErr:
    raise NotImplementedError


def open_thread_database(file_path: str) -> OpResult[Database]:
    raise NotImplementedError


def create_thread_file(file_path: str, thread_id: str, created_at: str) -> None:
    raise NotImplementedError


def delete_thread_file(file_path: str) -> None:
    raise NotImplementedError
