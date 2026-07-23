//! Ported from packages/lhc/src/shared-tech/logging/derivation-log.ts.
//! Phase 1 skeleton.
//!
//! Append-only execution history for inference-backed derivations. State stays
//! compact (pending | ready | failed | blocked); this table carries the story.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_tech::derivation::SubjectKind;
use crate::shared_tech::persist::DbTransaction;
use crate::shared_tech::storage::Db;

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

fn insert_derivation_log(_path: &str, _entry: &DerivationLogEntry) {
    todo!("phase 2")
}

/// Borrows the ambient txn (does not consume it).
pub fn append_derivation_log(_transaction: DbTransaction<'_>, _entry: &DerivationLogEntry) {
    todo!("phase 2")
}

pub fn query_derivation_log(_db: &Db, _q: &DerivationLogQuery) -> Vec<StoredDerivationLogEntry> {
    todo!("phase 2")
}
