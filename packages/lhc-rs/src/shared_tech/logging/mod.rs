//! Ported from packages/lhc/src/shared-tech/logging/index.ts. Phase 1 skeleton.
//!
//! The logging surface: a domain-blind tech-util for recording fallback
//! events and diagnostics. LHC internals and the host extension both write
//! through this surface. Writes are fail-soft and never share the caller's
//! transaction. Queries return entries by actionable fields.

use serde::{Deserialize, Serialize};

use crate::shared_tech::persist::DbTransaction;
use crate::shared_tech::storage::Db;

pub mod derivation_log;

pub use derivation_log::{
    DerivationLogEntry, DerivationLogEventKind, DerivationLogPayload, DerivationLogQuery,
    DerivationLogTarget, StoredDerivationLogEntry, append_derivation_log, query_derivation_log,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Info,
    Warning,
    Error,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Info => "info",
            LogLevel::Warning => "warning",
            LogLevel::Error => "error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub level: LogLevel,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derivation_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_id: Option<String>,
    /// e.g. "not_ready" | "failed_floor"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// for fallback events
    #[serde(skip_serializing_if = "Option::is_none")]
    pub floor_used: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredLogEntry {
    pub log_id: i64,
    pub level: LogLevel,
    pub message: String,
    pub derivation_type: Option<String>,
    pub subject_id: Option<String>,
    pub reason: Option<String>,
    pub floor_used: Option<String>,
    pub recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<LogLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derivation_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn insert_log(_path: &str, _entry: &LogEntry) {
    todo!("phase 2")
}

/// Write a log entry. Fail-soft: never throws to the caller, never shares
/// the caller's transaction. Borrows the ambient txn (does not consume it).
pub fn write_log(_transaction: DbTransaction<'_>, _entry: &LogEntry) {
    todo!("phase 2")
}

/// Query log entries by actionable fields. Returns all matching entries in
/// descending order of recorded_at (newest first).
pub fn query_log(_db: &Db, _q: &LogQuery) -> Vec<StoredLogEntry> {
    todo!("phase 2")
}
