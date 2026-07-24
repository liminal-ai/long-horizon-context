//! Ported from packages/lhc/src/threads/internal/registry.ts.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::shared_tech::errors::OpResult;
use crate::shared_tech::storage::{Db, SqlParam, open_database};

/// TS `DEFAULT_REGISTRY_PATH` — `~/.lhc/registry.sqlite`.
pub static DEFAULT_REGISTRY_PATH: LazyLock<String> = LazyLock::new(|| {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".lhc")
        .join("registry.sqlite")
        .to_string_lossy()
        .into_owned()
});

const REGISTRY_SCHEMA_STATEMENTS: &[&str] = &[r#"CREATE TABLE threads (
    thread_id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    title TEXT,
    cwd TEXT,
    created_at TEXT NOT NULL
  );"#];

const ROW_COLUMNS: &str = "thread_id, file_path, title, cwd, created_at";

/// Insertion order (rowid) breaks ties at the same created_at timestamp.
const ROW_ORDER: &str = "ORDER BY created_at, rowid";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryRow {
    pub thread_id: String,
    pub file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub created_at: String,
}

/// SQL row shape before optional-null → Option mapping (TS `RawRow`).
#[derive(Debug, Clone, PartialEq)]
struct RawRow {
    thread_id: String,
    file_path: String,
    title: Option<String>,
    cwd: Option<String>,
    created_at: String,
}

/// TS `selectAllThreadRows` opts — cwd filters at the registry (A-8).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectAllThreadRowsOpts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// TS `resolveRegistryPath(registryPath?)`.
pub fn resolve_registry_path(registry_path: Option<&str>) -> String {
    match registry_path {
        Some(path) => path.to_string(),
        None => DEFAULT_REGISTRY_PATH.clone(),
    }
}

fn has_no_schema(db: &Db) -> bool {
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 1")
        .get()
        .is_none()
}

/// First write creates the current registry file and schema lazily.
pub fn open_registry_for_write(registry_path: &str) -> Db {
    if let Some(parent) = Path::new(registry_path).parent() {
        std::fs::create_dir_all(parent).unwrap_or_else(|err| panic!("{err}"));
    }
    let db = match open_database(registry_path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if has_no_schema(&db) {
            db.exec("BEGIN IMMEDIATE;");
            let inner = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                for statement in REGISTRY_SCHEMA_STATEMENTS {
                    db.exec(statement);
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
        }
    }));
    if let Err(cause) = result {
        db.close();
        std::panic::resume_unwind(cause);
    }
    db
}

/// TS `openRegistryForRead` — null when the registry file does not exist.
pub fn open_registry_for_read(registry_path: &str) -> Option<Db> {
    if !Path::new(registry_path).exists() {
        return None;
    }
    match open_database(registry_path) {
        OpResult::Ok { value } => Some(value),
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

fn to_registry_row(raw: RawRow) -> RegistryRow {
    RegistryRow {
        thread_id: raw.thread_id,
        file_path: raw.file_path,
        title: raw.title,
        cwd: raw.cwd,
        created_at: raw.created_at,
    }
}

fn map_raw_row(map: &serde_json::Map<String, serde_json::Value>) -> RawRow {
    fn req_str(map: &serde_json::Map<String, serde_json::Value>, key: &str) -> String {
        map.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("missing column {key}"))
            .to_string()
    }
    fn opt_str(map: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
        match map.get(key) {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(s)) => Some(s.clone()),
            Some(other) => Some(other.to_string()),
        }
    }
    RawRow {
        thread_id: req_str(map, "thread_id"),
        file_path: req_str(map, "file_path"),
        title: opt_str(map, "title"),
        cwd: opt_str(map, "cwd"),
        created_at: req_str(map, "created_at"),
    }
}

pub fn insert_thread_row(db: &Db, row: &RegistryRow) {
    db.prepare(
        "INSERT INTO threads (thread_id, file_path, title, cwd, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(&[
        SqlParam::from(row.thread_id.as_str()),
        SqlParam::from(row.file_path.as_str()),
        SqlParam::from(row.title.clone()),
        SqlParam::from(row.cwd.clone()),
        SqlParam::from(row.created_at.as_str()),
    ]);
}

pub fn select_thread_row(db: &Db, thread_id: &str) -> Option<RegistryRow> {
    let sql = format!("SELECT {ROW_COLUMNS} FROM threads WHERE thread_id = ?");
    db.prepare(&sql)
        .get_params(&[SqlParam::from(thread_id)])
        .map(|raw| to_registry_row(map_raw_row(&raw)))
}

pub fn select_thread_rows_by_prefix(db: &Db, prefix: &str) -> Vec<RegistryRow> {
    let escaped = prefix
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let sql =
        format!("SELECT {ROW_COLUMNS} FROM threads WHERE thread_id LIKE ? ESCAPE '\\' {ROW_ORDER}");
    db.prepare(&sql)
        .all(&[SqlParam::from(format!("{escaped}%"))])
        .into_iter()
        .map(|raw| to_registry_row(map_raw_row(&raw)))
        .collect()
}

pub fn select_all_thread_rows(db: &Db, opts: SelectAllThreadRowsOpts) -> Vec<RegistryRow> {
    match opts.cwd {
        None => {
            let sql = format!("SELECT {ROW_COLUMNS} FROM threads {ROW_ORDER}");
            db.prepare(&sql)
                .all(&[])
                .into_iter()
                .map(|raw| to_registry_row(map_raw_row(&raw)))
                .collect()
        }
        Some(cwd) => {
            let sql = format!("SELECT {ROW_COLUMNS} FROM threads WHERE cwd = ? {ROW_ORDER}");
            db.prepare(&sql)
                .all(&[SqlParam::from(cwd.as_str())])
                .into_iter()
                .map(|raw| to_registry_row(map_raw_row(&raw)))
                .collect()
        }
    }
}
