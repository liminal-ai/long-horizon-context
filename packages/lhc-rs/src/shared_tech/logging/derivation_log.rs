//! Ported from packages/lhc/src/shared-tech/logging/derivation-log.ts.
//!
//! Append-only execution history for inference-backed derivations. State stays
//! compact (pending | ready | failed | blocked); this table carries the story.

use std::panic::{AssertUnwindSafe, catch_unwind};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_tech::derivation::SubjectKind;
use crate::shared_tech::js_json::js_json_stringify;
use crate::shared_tech::persist::DbTransaction;
use crate::shared_tech::storage::{Db, SqlParam, open_database};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DerivationLogEventKind {
    InferenceFailed,
    InferenceSucceeded,
    FallbackApplied,
    TerminalFailed,
}

impl DerivationLogEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DerivationLogEventKind::InferenceFailed => "inference_failed",
            DerivationLogEventKind::InferenceSucceeded => "inference_succeeded",
            DerivationLogEventKind::FallbackApplied => "fallback_applied",
            DerivationLogEventKind::TerminalFailed => "terminal_failed",
        }
    }

    fn from_wire(s: &str) -> Self {
        match s {
            "inference_failed" => DerivationLogEventKind::InferenceFailed,
            "inference_succeeded" => DerivationLogEventKind::InferenceSucceeded,
            "fallback_applied" => DerivationLogEventKind::FallbackApplied,
            "terminal_failed" => DerivationLogEventKind::TerminalFailed,
            other => panic!("unknown derivation log event kind from row: {other}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivationLogTarget {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: String,
}

/// TS `DerivationLogPayload` — known optional keys plus index signature.
/// Call sites use a freeform map; known keys are documented by convention.
pub type DerivationLogPayload = Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivationLogEntry {
    pub target: DerivationLogTarget,
    pub event_kind: DerivationLogEventKind,
    pub payload: DerivationLogPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDerivationLogEntry {
    pub log_id: i64,
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: String,
    pub event_kind: DerivationLogEventKind,
    pub payload: DerivationLogPayload,
    pub recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivationLogQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_kind: Option<SubjectKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derivation_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_kind: Option<DerivationLogEventKind>,
}

fn parse_subject_kind(s: &str) -> SubjectKind {
    match s {
        "message" => SubjectKind::Message,
        "turn" => SubjectKind::Turn,
        "chunk" => SubjectKind::Chunk,
        other => panic!("unknown subject kind from derivation log row: {other}"),
    }
}

fn insert_derivation_log(path: &str, entry: &DerivationLogEntry) {
    // TS insertDerivationLog: open+insert fail-soft; close in finally
    // (close failure propagates) — derivation-log.ts:50-68.
    let opened = catch_unwind(AssertUnwindSafe(|| open_database(path)));
    let db = match opened {
        Ok(crate::shared_tech::errors::OpResult::Ok { value: db }) => db,
        Ok(crate::shared_tech::errors::OpResult::Err { .. }) | Err(_) => return,
    };
    let payload = js_json_stringify(&Value::Object(entry.payload.clone()));
    let _ = catch_unwind(AssertUnwindSafe(|| {
        db.prepare(
            "INSERT INTO derivation_log (subject_kind, subject_id, derivation_type, event_kind, payload)\n       VALUES (?, ?, ?, ?, ?)",
        )
        .run(&[
            SqlParam::from(entry.target.subject_kind.as_str()),
            SqlParam::from(entry.target.subject_id.as_str()),
            SqlParam::from(entry.target.derivation_type.as_str()),
            SqlParam::from(entry.event_kind.as_str()),
            SqlParam::from(payload.as_str()),
        ]);
    }));
    db.close();
}

/// Borrows the ambient txn (does not consume it).
pub fn append_derivation_log(transaction: DbTransaction<'_>, entry: &DerivationLogEntry) {
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
            (txn.post_commit_hook.add)(Box::new(move || insert_derivation_log(&path, &entry)));
        }
        DbTransaction::Read(_) => insert_derivation_log(&path, entry),
    }
}

pub fn query_derivation_log(db: &Db, q: &DerivationLogQuery) -> Vec<StoredDerivationLogEntry> {
    let mut conditions: Vec<&str> = Vec::new();
    let mut params: Vec<SqlParam> = Vec::new();

    if let Some(subject_kind) = q.subject_kind {
        conditions.push("subject_kind = ?");
        params.push(SqlParam::from(subject_kind.as_str()));
    }
    if let Some(subject_id) = &q.subject_id {
        conditions.push("subject_id = ?");
        params.push(SqlParam::from(subject_id.as_str()));
    }
    if let Some(derivation_type) = &q.derivation_type {
        conditions.push("derivation_type = ?");
        params.push(SqlParam::from(derivation_type.as_str()));
    }
    if let Some(event_kind) = q.event_kind {
        conditions.push("event_kind = ?");
        params.push(SqlParam::from(event_kind.as_str()));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "
    SELECT log_id, subject_kind, subject_id, derivation_type, event_kind, payload, recorded_at
    FROM derivation_log
    {where_clause}
    ORDER BY log_id ASC
  "
    );

    let rows = db.prepare(&sql).all(&params);
    rows.into_iter()
        .map(|row| {
            let payload_text = row.get("payload").and_then(|v| v.as_str()).unwrap_or("{}");
            let payload: DerivationLogPayload = serde_json::from_str(payload_text)
                .unwrap_or_else(|err| panic!("derivation log payload JSON: {err}"));
            StoredDerivationLogEntry {
                log_id: row.get("log_id").and_then(|v| v.as_i64()).unwrap_or(0),
                subject_kind: parse_subject_kind(
                    row.get("subject_kind")
                        .and_then(|v| v.as_str())
                        .unwrap_or_else(|| panic!("derivation log row missing subject_kind")),
                ),
                subject_id: row
                    .get("subject_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                derivation_type: row
                    .get("derivation_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                event_kind: DerivationLogEventKind::from_wire(
                    row.get("event_kind")
                        .and_then(|v| v.as_str())
                        .unwrap_or_else(|| panic!("derivation log row missing event_kind")),
                ),
                payload,
                recorded_at: row
                    .get("recorded_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            }
        })
        .collect()
}
