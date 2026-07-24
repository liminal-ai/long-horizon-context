//! Ported from packages/lhc/src/threads/internal/create.ts. Phase 1 skeleton.
//!
//! SQL statement *templates* are REAL (Python `_THREAD_SCHEMA_STATEMENT_TEMPLATES`
//! pattern). Behavior bodies are `todo!("phase 2")`.

#[allow(unused_imports)] // Phase 2: fire_thread_touch on open
use crate::shared_tech::context::fire_thread_touch;
use crate::shared_tech::errors::OpResult;
#[allow(unused_imports)] // Phase 2: open + migrate path
use crate::shared_tech::storage::{
    CURRENT_THREAD_SCHEMA_VERSION, Db, get_schema_version, open_database,
};
#[allow(unused_imports)] // Phase 2: validate + migrate
use crate::shared_tech::thread_migrate::{
    THREAD_SCHEMA_VERSION_1, derivation_log_schema_statements, is_supported_thread_schema_version,
    migrate_thread_schema,
};
#[allow(unused_imports)] // Phase 2: metadata INSERT interpolation
use crate::shared_tech::token_counting::TOKEN_ESTIMATOR_ID;

/// SQL literals from TS `threadSchemaStatements()`'s return array — held so the
/// helper body stays a Phase 1 skeleton. Interpolated slots match Python/TS:
/// `{thread_id}`, `{created_at}`, `{token_estimator}`, `{schema_version}`.
/// `derivationLogSchemaStatements()` is spliced before the turns INSERT at Phase 2.
#[allow(dead_code)] // Phase 2: thread_schema_statements interpolation
const THREAD_SCHEMA_STATEMENT_TEMPLATES: &[&str] = &[
    r#"CREATE TABLE thread_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      token_estimator TEXT NOT NULL
    );"#,
    r#"INSERT INTO thread_metadata (id, thread_id, created_at, token_estimator)
     VALUES (1, '{thread_id}', '{created_at}', '{token_estimator}');"#,
    r#"CREATE TABLE event (
      event_order INTEGER PRIMARY KEY,
      event_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      actor TEXT NOT NULL,
      harness TEXT NOT NULL,
      payload TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );"#,
    r#"CREATE TABLE turns (
      turn_id TEXT PRIMARY KEY,
      turn_order INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
      opened_at_event_order INTEGER NOT NULL,
      closed_at_event_order INTEGER,
      deleted_at TEXT
    );"#,
    r#"CREATE TABLE message (
      message_id TEXT PRIMARY KEY,
      source_event_order INTEGER NOT NULL UNIQUE REFERENCES event(event_order),
      kind TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      actor TEXT NOT NULL,
      harness TEXT NOT NULL,
      turn_id TEXT NOT NULL REFERENCES turns(turn_id),
      deleted_at TEXT
    );"#,
    r#"CREATE TABLE message_block (
      message_id TEXT NOT NULL REFERENCES message(message_id),
      block_index INTEGER NOT NULL,
      block_type TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (message_id, block_index)
    );"#,
    r#"CREATE TABLE work_item (
      work_item_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      claimed_at TEXT,
      claim_expires_at TEXT,
      payload TEXT NOT NULL
    );"#,
    r#"CREATE INDEX idx_work_item_queue ON work_item (status);"#,
    r#"CREATE INDEX idx_message_block_tool_call_id
       ON message_block (block_type, json_extract(content, '$.toolCallId'));"#,
    r#"CREATE TABLE derivation (
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
    );"#,
    r#"CREATE TABLE chunk (
      chunk_id TEXT PRIMARY KEY,
      chunk_order INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('open','closed')),
      accumulated_projected_tokens INTEGER NOT NULL DEFAULT 0
    );"#,
    r#"CREATE TABLE chunk_member (
      chunk_id TEXT NOT NULL REFERENCES chunk(chunk_id),
      turn_id TEXT NOT NULL UNIQUE REFERENCES turns(turn_id),
      member_idx INTEGER NOT NULL,
      PRIMARY KEY (chunk_id, member_idx)
    );"#,
    r#"CREATE TABLE thread_view (
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
    );"#,
    r#"CREATE TABLE thread_view_band (
      view_id TEXT NOT NULL REFERENCES thread_view(view_id) ON DELETE CASCADE,
      band TEXT NOT NULL CHECK (band IN ('brief','detailed','smooth')),
      rendered_text TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      PRIMARY KEY (view_id, band)
    );"#,
    r#"CREATE TABLE view_boundary (
      thread_singleton INTEGER PRIMARY KEY CHECK (thread_singleton = 1),
      position INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );"#,
    r#"INSERT INTO view_boundary (thread_singleton, position, updated_at)
      VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));"#,
    r#"CREATE TABLE log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL CHECK (level IN ('info','warning','error')),
      message TEXT NOT NULL,
      derivation_type TEXT,
      subject_id TEXT,
      reason TEXT,
      floor_used TEXT,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );"#,
    r#"CREATE INDEX idx_log_level ON log (level);"#,
    r#"CREATE INDEX idx_log_derivation_type ON log (derivation_type);"#,
    r#"CREATE INDEX idx_log_subject_id ON log (subject_id);"#,
    r#"CREATE INDEX idx_log_reason ON log (reason);"#,
    // ...derivationLogSchemaStatements() spliced at Phase 2
    r#"INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order)
     VALUES ('t1', 1, 'open', 0);"#,
    r#"PRAGMA user_version = {schema_version};"#,
];

/// TS `generateThreadId` — `th_` + 16 hex chars (8 random bytes).
pub fn generate_thread_id() -> String {
    todo!("phase 2")
}

fn thread_schema_statements(_thread_id: &str, _created_at: &str) -> Vec<String> {
    todo!("phase 2")
}

fn not_a_thread_file<T>(_file_path: &str, _detail: &str) -> OpResult<T> {
    todo!("phase 2")
}

fn error_detail(_cause: &dyn std::fmt::Display) -> String {
    todo!("phase 2")
}

/// TS `validateThreadFile` — success is `{ ok: true }` (no value payload).
fn validate_thread_file(_file_path: &str) -> OpResult<()> {
    todo!("phase 2")
}

/// TS `openThreadDatabase(filePath)` — validate, open, migrate, fire touch.
pub fn open_thread_database(_file_path: &str) -> OpResult<Db> {
    todo!("phase 2")
}

/// TS `createThreadFile` — full schema + metadata + initial turn in one txn.
pub fn create_thread_file(_file_path: &str, _thread_id: &str, _created_at: &str) {
    todo!("phase 2")
}

/// TS `deleteThreadFile` — remove file and WAL companions (compensation).
pub fn delete_thread_file(_file_path: &str) {
    todo!("phase 2")
}
