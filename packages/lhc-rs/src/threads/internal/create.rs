//! Ported from packages/lhc/src/threads/internal/create.ts.

use std::fs;
use std::path::Path;

use crate::shared_tech::context::fire_thread_touch;
use crate::shared_tech::errors::{OpResult, storage_failure};
use crate::shared_tech::storage::{
    CURRENT_THREAD_SCHEMA_VERSION, Db, get_schema_version, open_database,
    open_database_for_thread_validation,
};
use crate::shared_tech::thread_migrate::{
    THREAD_SCHEMA_VERSION_1, derivation_log_schema_statements, is_supported_thread_schema_version,
    migrate_thread_schema,
};
use crate::shared_tech::token_counting::TOKEN_ESTIMATOR_ID;

/// SQL literals from TS `threadSchemaStatements()`'s return array.
/// Interpolated slots: `{thread_id}`, `{created_at}`, `{token_estimator}`,
/// `{schema_version}`. `derivationLogSchemaStatements()` is spliced before
/// the turns INSERT.
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
    r#"INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order)
     VALUES ('t1', 1, 'open', 0);"#,
    r#"PRAGMA user_version = {schema_version};"#,
];

/// TS `generateThreadId` — `th_` + 16 hex chars (8 random bytes).
pub fn generate_thread_id() -> String {
    use std::io::Read;
    let mut bytes = [0u8; 8];
    std::fs::File::open("/dev/urandom")
        .expect("open /dev/urandom")
        .read_exact(&mut bytes)
        .expect("read /dev/urandom");
    let mut hex = String::with_capacity(16);
    for b in bytes {
        hex.push_str(&format!("{b:02x}"));
    }
    format!("th_{hex}")
}

fn thread_schema_statements(thread_id: &str, created_at: &str) -> Vec<String> {
    let mut statements = Vec::new();
    for template in THREAD_SCHEMA_STATEMENT_TEMPLATES {
        if template.starts_with("INSERT INTO turns") {
            for stmt in derivation_log_schema_statements() {
                statements.push(stmt.to_string());
            }
        }
        statements.push(
            template
                .replace("{thread_id}", thread_id)
                .replace("{created_at}", created_at)
                .replace("{token_estimator}", TOKEN_ESTIMATOR_ID)
                .replace(
                    "{schema_version}",
                    &CURRENT_THREAD_SCHEMA_VERSION.to_string(),
                ),
        );
    }
    statements
}

fn not_a_thread_file<T>(file_path: &str, detail: &str) -> OpResult<T> {
    OpResult::Err {
        error: crate::shared_tech::errors::ErrorResult {
            error_class: crate::shared_tech::errors::ErrorClass::CallerError,
            code: crate::shared_tech::errors::ErrorCode::ThreadNotFound,
            reason: format!("file at {file_path} exists but is not an lhc thread file ({detail})"),
            event_index: None,
        },
    }
}

fn map_inspect_failure(file_path: &str, detail: &str) -> OpResult<()> {
    // SQLite may defer "not a database" until the first query; identity failure
    // at any stage (open / schema / metadata), matching TS catch.
    if detail.contains("not a database") {
        return not_a_thread_file(file_path, detail);
    }
    storage_failure(&format!("could not inspect thread file: {detail}"))
}

fn panic_inspect_detail(panic: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic during thread file inspection".to_string()
    }
}

/// TS `validateThreadFile` — success is `{ ok: true }` (no value payload).
///
/// Open / schema / metadata / close mirror TS try/catch/finally. Uses the
/// WAL-aware validation opener (not the immutable peek opener). Storage
/// panics from prepare/get are caught and mapped — never escape this path.
fn validate_thread_file(file_path: &str) -> OpResult<()> {
    let mut opened = match open_database_for_thread_validation(file_path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => {
            return map_inspect_failure(file_path, &error.reason);
        }
    };
    let inspect = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let db = opened.db();
        let schema_version = match get_schema_version(db) {
            OpResult::Ok { value } => value,
            OpResult::Err { error } => {
                return map_inspect_failure(file_path, &error.reason);
            }
        };
        if schema_version == 0 {
            return not_a_thread_file(file_path, "no lhc schema version");
        }
        if !is_supported_thread_schema_version(schema_version) {
            return not_a_thread_file(
                file_path,
                &format!(
                    "schema version {schema_version}, expected {THREAD_SCHEMA_VERSION_1}..{CURRENT_THREAD_SCHEMA_VERSION}"
                ),
            );
        }
        let table = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_metadata'",
            )
            .get();
        if table.is_none() {
            return not_a_thread_file(file_path, "no thread_metadata table");
        }
        let row = db
            .prepare("SELECT thread_id FROM thread_metadata WHERE id = 1")
            .get();
        if row.is_none() {
            return not_a_thread_file(file_path, "no thread metadata row");
        }
        OpResult::Ok { value: () }
    }));
    // finally: close without masking the primary classification.
    let close_panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        opened.close();
    }));
    match inspect {
        Ok(result) => {
            let _ = close_panic;
            result
        }
        Err(panic) => {
            let _ = close_panic;
            map_inspect_failure(file_path, &panic_inspect_detail(panic))
        }
    }
}

/// TS `openThreadDatabase(filePath)` — validate, open, migrate, fire touch.
pub fn open_thread_database(file_path: &str) -> OpResult<Db> {
    match validate_thread_file(file_path) {
        OpResult::Ok { .. } => {}
        OpResult::Err { error } => return OpResult::Err { error },
    }
    // TS catch: writable open + pragma init (e.g. journal_mode=WAL on a
    // read-only file/dir) must become storageFailure, not an escaping panic.
    let open_result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| open_database(file_path)));
    let db = match open_result {
        Ok(OpResult::Ok { value }) => value,
        Ok(OpResult::Err { error }) => {
            return storage_failure(&format!("could not open thread file: {}", error.reason));
        }
        Err(panic) => {
            let detail = panic_detail(panic);
            return storage_failure(&format!("could not open thread file: {detail}"));
        }
    };
    let migrate_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        migrate_thread_schema(&db);
    }));
    if let Err(panic) = migrate_result {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            db.close();
        }));
        let detail = panic_detail(panic);
        return storage_failure(&format!("could not open thread file: {detail}"));
    }
    fire_thread_touch(file_path, &db);
    OpResult::Ok { value: db }
}

fn panic_detail(panic: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic during thread open".to_string()
    }
}

/// TS `createThreadFile` — full schema + metadata + initial turn in one txn.
/// Panics on failure (TS throws); callers compensate with [`delete_thread_file`].
pub fn create_thread_file(file_path: &str, thread_id: &str, created_at: &str) {
    let db = match open_database(file_path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        db.exec("BEGIN IMMEDIATE;");
        let inner = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            for statement in thread_schema_statements(thread_id, created_at) {
                db.exec(&statement);
            }
        }));
        match inner {
            Ok(()) => db.exec("COMMIT;"),
            Err(cause) => {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    db.exec("ROLLBACK;");
                }));
                std::panic::resume_unwind(cause);
            }
        }
    }));
    db.close();
    if let Err(cause) = result {
        std::panic::resume_unwind(cause);
    }
}

/// TS `deleteThreadFile` — remove file and WAL companions (compensation).
pub fn delete_thread_file(file_path: &str) {
    for suffix in ["", "-wal", "-shm"] {
        let path = format!("{file_path}{suffix}");
        let _ = fs::remove_file(Path::new(&path));
    }
}
