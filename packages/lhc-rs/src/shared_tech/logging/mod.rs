//! Ported from packages/lhc/src/shared-tech/logging/index.ts.
//!
//! The logging surface: a domain-blind tech-util for recording fallback
//! events and diagnostics. LHC internals and the host extension both write
//! through this surface. Writes are fail-soft and never share the caller's
//! transaction. Queries return entries by actionable fields.

use std::panic::{AssertUnwindSafe, catch_unwind};

use serde::{Deserialize, Serialize};

use crate::shared_tech::persist::DbTransaction;
use crate::shared_tech::storage::{Db, SqlParam, open_database};

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

    fn from_wire(s: &str) -> Self {
        match s {
            "info" => LogLevel::Info,
            "warning" => LogLevel::Warning,
            "error" => LogLevel::Error,
            other => panic!("unknown log level from row: {other}"),
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

fn insert_log(path: &str, entry: &LogEntry) {
    // TS insertLog: open+insert in try/catch (fail-soft); close in finally
    // (close failure propagates) — logging/index.ts:39-59.
    let opened = catch_unwind(AssertUnwindSafe(|| open_database(path)));
    let db = match opened {
        Ok(crate::shared_tech::errors::OpResult::Ok { value: db }) => db,
        Ok(crate::shared_tech::errors::OpResult::Err { .. }) | Err(_) => return,
    };
    let _ = catch_unwind(AssertUnwindSafe(|| {
        db.prepare(
            "INSERT INTO log (level, message, derivation_type, subject_id, reason, floor_used)\n       VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(&[
            SqlParam::from(entry.level.as_str()),
            SqlParam::from(entry.message.as_str()),
            SqlParam::from(entry.derivation_type.as_deref()),
            SqlParam::from(entry.subject_id.as_deref()),
            SqlParam::from(entry.reason.as_deref()),
            SqlParam::from(entry.floor_used.as_deref()),
        ]);
    }));
    db.close();
}

/// Write a log entry. Fail-soft: never throws to the caller, never shares
/// the caller's transaction. Borrows the ambient txn (does not consume it).
pub fn write_log(transaction: DbTransaction<'_>, entry: &LogEntry) {
    // TS `databasePathFor` distinguishes undefined from `""`; an opened db
    // with path `""` still has a known path — do not early-return on empty.
    let path = match &transaction {
        DbTransaction::Read(txn) => txn.db.path().to_string(),
        DbTransaction::Write(txn) => txn.db.path().to_string(),
    };
    match transaction {
        DbTransaction::Write(txn) => {
            let path = path.clone();
            let entry = entry.clone();
            (txn.post_commit_hook.add)(Box::new(move || insert_log(&path, &entry)));
        }
        DbTransaction::Read(_) => insert_log(&path, entry),
    }
}

/// Query log entries by actionable fields. Returns all matching entries in
/// descending order of recorded_at (newest first).
pub fn query_log(db: &Db, q: &LogQuery) -> Vec<StoredLogEntry> {
    let mut conditions: Vec<&str> = Vec::new();
    let mut params: Vec<SqlParam> = Vec::new();

    if let Some(level) = q.level {
        conditions.push("level = ?");
        params.push(SqlParam::from(level.as_str()));
    }
    if let Some(derivation_type) = &q.derivation_type {
        conditions.push("derivation_type = ?");
        params.push(SqlParam::from(derivation_type.as_str()));
    }
    if let Some(subject_id) = &q.subject_id {
        conditions.push("subject_id = ?");
        params.push(SqlParam::from(subject_id.as_str()));
    }
    if let Some(reason) = &q.reason {
        conditions.push("reason = ?");
        params.push(SqlParam::from(reason.as_str()));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "
    SELECT log_id, level, message, derivation_type, subject_id, reason, floor_used, recorded_at
    FROM log
    {where_clause}
    ORDER BY recorded_at DESC
  "
    );

    let rows = db.prepare(&sql).all(&params);
    rows.into_iter()
        .map(|row| StoredLogEntry {
            log_id: row.get("log_id").and_then(|v| v.as_i64()).unwrap_or(0),
            level: LogLevel::from_wire(
                row.get("level")
                    .and_then(|v| v.as_str())
                    .unwrap_or_else(|| panic!("log row missing level")),
            ),
            message: row
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            derivation_type: row
                .get("derivation_type")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            subject_id: row
                .get("subject_id")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            reason: row
                .get("reason")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            floor_used: row
                .get("floor_used")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            recorded_at: row
                .get("recorded_at")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect()
}
