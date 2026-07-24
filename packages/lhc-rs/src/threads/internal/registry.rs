//! Ported from packages/lhc/src/threads/internal/registry.ts. Phase 1 skeleton.
//!
//! Constants + closed row types REAL; behavior bodies `todo!("phase 2")`.

use std::path::PathBuf;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::shared_tech::storage::Db;

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

#[allow(dead_code)] // Phase 2: has_no_schema
const REGISTRY_SCHEMA_STATEMENTS: &[&str] = &[r#"CREATE TABLE threads (
    thread_id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    title TEXT,
    cwd TEXT,
    created_at TEXT NOT NULL
  );"#];

#[allow(dead_code)] // Phase 2: select_thread_row
const ROW_COLUMNS: &str = "thread_id, file_path, title, cwd, created_at";

/// Insertion order (rowid) breaks ties at the same created_at timestamp.
#[allow(dead_code)] // Phase 2: select_thread_rows_by_prefix
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
pub fn resolve_registry_path(_registry_path: Option<&str>) -> String {
    todo!("phase 2")
}

fn has_no_schema(_db: &Db) -> bool {
    todo!("phase 2")
}

/// First write creates the current registry file and schema lazily.
pub fn open_registry_for_write(_registry_path: &str) -> Db {
    todo!("phase 2")
}

/// TS `openRegistryForRead` — null when the registry file does not exist.
pub fn open_registry_for_read(_registry_path: &str) -> Option<Db> {
    todo!("phase 2")
}

fn to_registry_row(_raw: RawRow) -> RegistryRow {
    todo!("phase 2")
}

pub fn insert_thread_row(_db: &Db, _row: &RegistryRow) {
    todo!("phase 2")
}

pub fn select_thread_row(_db: &Db, _thread_id: &str) -> Option<RegistryRow> {
    todo!("phase 2")
}

pub fn select_thread_rows_by_prefix(_db: &Db, _prefix: &str) -> Vec<RegistryRow> {
    todo!("phase 2")
}

pub fn select_all_thread_rows(_db: &Db, _opts: SelectAllThreadRowsOpts) -> Vec<RegistryRow> {
    todo!("phase 2")
}
