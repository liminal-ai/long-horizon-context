//! Ported from packages/lhc/src/shared-tech/thread-migrate.ts.
//! Phase 1 skeleton — version constants + SQL statements REAL; behavior todo.
//!
//! Thread-file schema migrations applied on open.

#[allow(unused_imports)] // Phase 2 migration body
use super::storage::{CURRENT_THREAD_SCHEMA_VERSION, Db, get_schema_version};
#[allow(unused_imports)] // Phase 2 payload rewrite
use super::work_queue::EnqueueDerivationTarget;

pub const THREAD_SCHEMA_VERSION_1: i64 = 1;
pub const THREAD_SCHEMA_VERSION_2: i64 = 2;
pub const THREAD_SCHEMA_VERSION_3: i64 = 3;
pub const THREAD_SCHEMA_VERSION_4: i64 = 4;

const OLD_DERIVATION_TYPE: &str = "smooth_turn_compression";
const NEW_DERIVATION_TYPE: &str = "detailed_turn_compression";
const OLD_PROMPT_NAME: &str = "smooth-turn-compression-v1";
const NEW_PROMPT_NAME: &str = "detailed-turn-compression-v1";

const OLD_PROMPT_JSON: &str = r#""prompt":"smooth-turn-compression-v1""#;
const NEW_PROMPT_JSON: &str = r#""prompt":"detailed-turn-compression-v1""#;

/// SQL literals from TS `derivationLogSchemaStatements()` — held as constants
/// so the function body stays a Phase 1 skeleton of cloning them out.
const DERIVATION_LOG_SCHEMA_STATEMENTS: &[&str] = &[
    r#"CREATE TABLE IF NOT EXISTS derivation_log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('message','turn','chunk')),
      subject_id TEXT NOT NULL,
      derivation_type TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );"#,
    "CREATE INDEX IF NOT EXISTS idx_derivation_log_subject ON derivation_log (subject_kind, subject_id, derivation_type);",
    "CREATE INDEX IF NOT EXISTS idx_derivation_log_event ON derivation_log (event_kind);",
];

pub fn derivation_log_schema_statements() -> Vec<&'static str> {
    DERIVATION_LOG_SCHEMA_STATEMENTS.to_vec()
}

fn migrate_detailed_turn_compression_rename(_db: &Db) {
    todo!("phase 2")
}

/// Loose migrate-time derivation target (string subjectKind — not closed SubjectKind).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueuedWorkItemDerivation {
    subject_kind: String,
    subject_id: String,
    derivation_type: String,
}

/// Private DIFFERENT loose payload for migrate rewrite (TS `QueuedWorkItemPayload`).
/// Not the strict work-queue `RecordItemPayload` / `WorkPayload` — `operation` is
/// a string, and unknown keys are preserved via flatten (TS object spread).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct QueuedWorkItemPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_version: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    derivations: Option<Vec<QueuedWorkItemDerivation>>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

/// TS `LEGACY_TURN_DERIVATION_COMPRESSION_TYPES = new Set([OLD, NEW])`.
const LEGACY_TURN_DERIVATION_COMPRESSION_TYPES: &[&str] =
    &[OLD_DERIVATION_TYPE, NEW_DERIVATION_TYPE];

fn turn_derivation_payload_needs_pre_detailed_assembly(_payload: &QueuedWorkItemPayload) -> bool {
    todo!("phase 2")
}

fn migrated_turn_derivation_targets(_turn_id: &str) -> Vec<EnqueueDerivationTarget> {
    todo!("phase 2")
}

fn migrate_queued_turn_derivation_work_items(_db: &Db) {
    todo!("phase 2")
}

fn run_queued_turn_derivation_migration(_db: &Db) {
    todo!("phase 2")
}

fn migrate_one_shot_work_queue(_db: &Db) {
    todo!("phase 2")
}

pub fn migrate_thread_schema(_db: &Db) {
    todo!("phase 2")
}

pub fn is_supported_thread_schema_version(_version: i64) -> bool {
    todo!("phase 2")
}

/// Mutation-sensitive coverage for migrate loose payload unknown-key preservation.
/// Rust-only (no TS twin) — allowlist as `lib::shared_tech::thread_migrate::tests::*`.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared_tech::js_json::js_json_stringify_of;

    #[test]
    fn migrate_loose_queued_work_item_payload_preserves_unknown_keys() {
        let raw = r#"{"sourceVersion":2,"operation":"legacy.op","legacyFlag":true,"derivations":[{"subjectKind":"turn","subjectId":"t1","derivationType":"turn_rendering"}]}"#;
        let parsed: QueuedWorkItemPayload = serde_json::from_str(raw).expect("parse loose");
        assert_eq!(parsed.source_version, Some(2));
        assert_eq!(parsed.operation.as_deref(), Some("legacy.op"));
        assert_eq!(
            parsed.extra.get("legacyFlag"),
            Some(&serde_json::Value::Bool(true))
        );
        let bytes = js_json_stringify_of(&parsed).expect("stringify");
        assert!(
            bytes.contains("\"legacyFlag\":true"),
            "unknown key dropped: {bytes}"
        );
        assert!(
            bytes.contains("\"sourceVersion\":2"),
            "known key lost camelCase: {bytes}"
        );
    }
}
