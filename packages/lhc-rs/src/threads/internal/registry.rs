//! Ported from packages/lhc/src/threads/internal/registry.ts. Phase 1 skeleton.
//!
//! Wave-later PARTIAL: only the four symbols persist.rs imports.

use serde::{Deserialize, Serialize};

use crate::shared_tech::storage::Db;

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

/// TS `resolveRegistryPath(registryPath?)`.
pub fn resolve_registry_path(_registry_path: Option<&str>) -> String {
    todo!("phase 2")
}

/// TS `openRegistryForRead` — null when the registry file does not exist.
pub fn open_registry_for_read(_registry_path: &str) -> Option<Db> {
    todo!("phase 2")
}

pub fn select_thread_row(_db: &Db, _thread_id: &str) -> Option<RegistryRow> {
    todo!("phase 2")
}

pub fn select_thread_rows_by_prefix(_db: &Db, _prefix: &str) -> Vec<RegistryRow> {
    todo!("phase 2")
}
