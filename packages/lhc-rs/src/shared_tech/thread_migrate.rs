//! Ported from packages/lhc/src/shared-tech/thread-migrate.ts.
//!
//! Thread-file schema migrations applied on open.

use std::panic::{AssertUnwindSafe, catch_unwind};

use super::derivation::SubjectKind;
use super::errors::OpResult;
use super::js_json::js_json_stringify_of;
use super::storage::{CURRENT_THREAD_SCHEMA_VERSION, Db, SqlParam, get_schema_version};
use super::work_queue::EnqueueDerivationTarget;

pub const THREAD_SCHEMA_VERSION_1: i64 = 1;
pub const THREAD_SCHEMA_VERSION_2: i64 = 2;
pub const THREAD_SCHEMA_VERSION_3: i64 = 3;
pub const THREAD_SCHEMA_VERSION_4: i64 = 4;
pub const THREAD_SCHEMA_VERSION_5: i64 = 5;

const OLD_DERIVATION_TYPE: &str = "smooth_turn_compression";
const NEW_DERIVATION_TYPE: &str = "detailed_turn_compression";
// TS interpolates these into OLD/NEW_PROMPT_JSON; Rust keeps the expanded
// literals byte-identical to the TS template results.
#[allow(dead_code)]
const OLD_PROMPT_NAME: &str = "smooth-turn-compression-v1";
#[allow(dead_code)]
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

fn migrate_detailed_turn_compression_rename(db: &Db) {
    db.prepare("UPDATE derivation SET derivation_type = ? WHERE derivation_type = ?")
        .run(&[
            SqlParam::from(NEW_DERIVATION_TYPE),
            SqlParam::from(OLD_DERIVATION_TYPE),
        ]);
    db.prepare("UPDATE derivation_log SET derivation_type = ? WHERE derivation_type = ?")
        .run(&[
            SqlParam::from(NEW_DERIVATION_TYPE),
            SqlParam::from(OLD_DERIVATION_TYPE),
        ]);
    db.prepare("UPDATE log SET derivation_type = ? WHERE derivation_type = ?")
        .run(&[
            SqlParam::from(NEW_DERIVATION_TYPE),
            SqlParam::from(OLD_DERIVATION_TYPE),
        ]);
    db.prepare("UPDATE derivation SET metadata = REPLACE(metadata, ?, ?) WHERE metadata LIKE ?")
        .run(&[
            SqlParam::from(OLD_PROMPT_JSON),
            SqlParam::from(NEW_PROMPT_JSON),
            SqlParam::from(format!("%{OLD_PROMPT_JSON}%")),
        ]);
    db.prepare("UPDATE derivation_log SET payload = REPLACE(payload, ?, ?) WHERE payload LIKE ?")
        .run(&[
            SqlParam::from(OLD_PROMPT_JSON),
            SqlParam::from(NEW_PROMPT_JSON),
            SqlParam::from(format!("%{OLD_PROMPT_JSON}%")),
        ]);
    db.prepare("UPDATE log SET message = REPLACE(message, ?, ?) WHERE message LIKE ?")
        .run(&[
            SqlParam::from(OLD_DERIVATION_TYPE),
            SqlParam::from(NEW_DERIVATION_TYPE),
            SqlParam::from(format!("%{OLD_DERIVATION_TYPE}%")),
        ]);
    db.prepare(
        r#"UPDATE thread_view SET
       arrangement_json = REPLACE(arrangement_json, ?, ?),
       gaps_json = REPLACE(gaps_json, ?, ?),
       source_state_json = REPLACE(source_state_json, ?, ?)
     WHERE arrangement_json LIKE ?
        OR gaps_json LIKE ?
        OR source_state_json LIKE ?"#,
    )
    .run(&[
        SqlParam::from(OLD_DERIVATION_TYPE),
        SqlParam::from(NEW_DERIVATION_TYPE),
        SqlParam::from(OLD_DERIVATION_TYPE),
        SqlParam::from(NEW_DERIVATION_TYPE),
        SqlParam::from(OLD_DERIVATION_TYPE),
        SqlParam::from(NEW_DERIVATION_TYPE),
        SqlParam::from(format!("%{OLD_DERIVATION_TYPE}%")),
        SqlParam::from(format!("%{OLD_DERIVATION_TYPE}%")),
        SqlParam::from(format!("%{OLD_DERIVATION_TYPE}%")),
    ]);
}

/// Loose migrate-time derivation target (string subjectKind — not closed SubjectKind).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueuedWorkItemDerivation {
    subject_kind: String,
    subject_id: String,
    derivation_type: String,
}

/// Migration payload is ordered, unvalidated JSON (TS `JSON.parse` → object).
/// Accessors operate on raw JSON values with JS property / `.some` semantics;
/// `operation` and unknowns remain arbitrary JSON (string legacy or object).
type QueuedWorkItemPayload = serde_json::Map<String, serde_json::Value>;

/// TS `payload.sourceVersion ?? 1` then node:sqlite positional bind.
/// Missing/null → integer `1`. JSON numbers bind without truncation (fractional
/// → REAL). String → TEXT. Boolean/object/array throw (unsupported bind).
fn payload_source_version_param(payload: &QueuedWorkItemPayload) -> SqlParam {
    match payload.get("sourceVersion") {
        None | Some(serde_json::Value::Null) => SqlParam::I64(1),
        Some(serde_json::Value::Number(n)) => {
            // JS Number is IEEE-754; preserve fractional values as REAL.
            if let Some(f) = n.as_f64() {
                if f.is_finite() {
                    // Exact integers that fit i64 still bind as INTEGER when the
                    // JSON number has no fractional component (serde distinction
                    // mirrors JS ToNumber then sqlite affinity for whole values
                    // written as JSON integers). Fractional → REAL.
                    if let Some(i) = n.as_i64() {
                        SqlParam::I64(i)
                    } else {
                        SqlParam::F64(f)
                    }
                } else {
                    panic!("SQLite bind rejected non-finite sourceVersion");
                }
            } else {
                panic!("SQLite bind rejected sourceVersion number");
            }
        }
        Some(serde_json::Value::String(s)) => SqlParam::Text(s.clone()),
        Some(serde_json::Value::Bool(_))
        | Some(serde_json::Value::Array(_))
        | Some(serde_json::Value::Object(_)) => {
            panic!("SQLite bind rejected unsupported sourceVersion type");
        }
    }
}

/// TS `target.derivationType` — null throws; non-object yields undefined.
fn derivation_type_of(target: &serde_json::Value) -> Option<&str> {
    match target {
        serde_json::Value::Null => {
            panic!("cannot read properties of null (reading 'derivationType')");
        }
        serde_json::Value::Object(map) => map.get("derivationType").and_then(|v| v.as_str()),
        _ => None,
    }
}

/// TS `(payload.derivations ?? []).some(pred)` over raw elements — no silent
/// drop of incomplete objects; non-array non-null throws (`.some` not callable).
fn derivations_some(
    payload: &QueuedWorkItemPayload,
    mut pred: impl FnMut(&serde_json::Value) -> bool,
) -> bool {
    match payload.get("derivations") {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Array(items)) => {
            for item in items {
                if pred(item) {
                    return true;
                }
            }
            false
        }
        Some(_) => panic!("derivations.some is not a function"),
    }
}

/// Replace `derivations` retaining original key position when present
/// (TS object-spread / preserve_order Map insert-overwrite semantics).
fn set_payload_derivations(
    payload: &mut QueuedWorkItemPayload,
    derivations: Vec<QueuedWorkItemDerivation>,
) {
    let value = serde_json::to_value(derivations).unwrap_or_else(|err| panic!("{err}"));
    payload.insert("derivations".to_string(), value);
}

/// TS `LEGACY_TURN_DERIVATION_COMPRESSION_TYPES = new Set([OLD, NEW])`.
const LEGACY_TURN_DERIVATION_COMPRESSION_TYPES: &[&str] =
    &[OLD_DERIVATION_TYPE, NEW_DERIVATION_TYPE];

fn turn_derivation_payload_needs_pre_detailed_assembly(payload: &QueuedWorkItemPayload) -> bool {
    if !derivations_some(payload, |target| {
        derivation_type_of(target) == Some("turn_rendering")
    }) {
        return false;
    }
    if derivations_some(payload, |target| {
        derivation_type_of(target) == Some("pre_detailed_assembly")
    }) {
        return false;
    }
    derivations_some(payload, |target| {
        matches!(
            derivation_type_of(target),
            Some(dt) if LEGACY_TURN_DERIVATION_COMPRESSION_TYPES.contains(&dt)
        )
    })
}

fn migrated_turn_derivation_targets(turn_id: &str) -> Vec<EnqueueDerivationTarget> {
    vec![
        EnqueueDerivationTarget {
            subject_kind: SubjectKind::Turn,
            subject_id: turn_id.to_string(),
            derivation_type: "turn_rendering".to_string(),
        },
        EnqueueDerivationTarget {
            subject_kind: SubjectKind::Turn,
            subject_id: turn_id.to_string(),
            derivation_type: "pre_detailed_assembly".to_string(),
        },
    ]
}

fn migrate_queued_turn_derivation_work_items(db: &Db) {
    let rows = db
        .prepare(
            r#"SELECT work_item_id, source_ref, payload
       FROM work_item
       WHERE kind = 'turn_derivation' AND status IN ('queued', 'claimed')"#,
        )
        .all(&[]);

    let update_payload = db.prepare("UPDATE work_item SET payload = ? WHERE work_item_id = ?");
    let seed_assembly = db.prepare(
        r#"INSERT OR IGNORE INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
     VALUES ('turn', ?, 'pre_detailed_assembly', 'pending', ?)"#,
    );
    let assembly_row_exists = db.prepare(
        r#"SELECT 1 AS present FROM derivation
     WHERE subject_kind = 'turn' AND subject_id = ? AND derivation_type = 'pre_detailed_assembly'"#,
    );

    for row in rows {
        let source_ref_raw = row
            .get("source_ref")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("work_item.source_ref missing"));
        let source_ref: serde_json::Value =
            serde_json::from_str(source_ref_raw).unwrap_or_else(|err| panic!("{err}"));
        let turn_id = match source_ref.get("turnId") {
            Some(serde_json::Value::String(s)) => s.as_str(),
            _ => continue,
        };

        let payload_raw = row
            .get("payload")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("work_item.payload missing"));
        let payload_value: serde_json::Value =
            serde_json::from_str(payload_raw).unwrap_or_else(|err| panic!("{err}"));
        // TS parity: property access on null throws; on any other non-object it
        // yields undefined, so migration treats the row as an empty payload.
        if payload_value.is_null() {
            panic!("cannot read properties of null (reading 'sourceVersion')");
        }
        let payload: QueuedWorkItemPayload = match payload_value {
            serde_json::Value::Object(map) => map,
            _ => QueuedWorkItemPayload::new(),
        };
        let source_version = payload_source_version_param(&payload);
        let needs_payload_migration = turn_derivation_payload_needs_pre_detailed_assembly(&payload);
        let targets_pre_detailed_assembly = derivations_some(&payload, |target| {
            derivation_type_of(target) == Some("pre_detailed_assembly")
        });
        let needs_assembly_seed = needs_payload_migration
            || (targets_pre_detailed_assembly
                && assembly_row_exists
                    .get_params(&[SqlParam::from(turn_id)])
                    .is_none());
        if !needs_payload_migration && !needs_assembly_seed {
            continue;
        }

        if needs_assembly_seed {
            seed_assembly.run(&[SqlParam::from(turn_id), source_version]);
        }
        if needs_payload_migration {
            let mut next_payload = payload;
            set_payload_derivations(
                &mut next_payload,
                migrated_turn_derivation_targets(turn_id)
                    .into_iter()
                    .map(|target| QueuedWorkItemDerivation {
                        subject_kind: target.subject_kind.as_str().to_string(),
                        subject_id: target.subject_id,
                        derivation_type: target.derivation_type,
                    })
                    .collect(),
            );
            let next_json =
                js_json_stringify_of(&next_payload).unwrap_or_else(|err| panic!("{err}"));
            let work_item_id = row
                .get("work_item_id")
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| panic!("work_item.work_item_id missing"));
            update_payload.run(&[
                SqlParam::from(next_json.as_str()),
                SqlParam::from(work_item_id),
            ]);
        }
    }
}

fn run_queued_turn_derivation_migration(db: &Db) {
    db.exec("BEGIN IMMEDIATE;");
    match catch_unwind(AssertUnwindSafe(|| {
        migrate_queued_turn_derivation_work_items(db);
    })) {
        Ok(()) => db.exec("COMMIT;"),
        Err(payload) => {
            db.exec("ROLLBACK;");
            std::panic::resume_unwind(payload);
        }
    }
}

fn migrate_one_shot_work_queue(db: &Db) {
    db.exec("DROP INDEX idx_work_item_queue;");
    db.exec("ALTER TABLE work_item DROP COLUMN attempts;");
    db.exec("ALTER TABLE work_item DROP COLUMN last_error;");
    db.exec("ALTER TABLE work_item DROP COLUMN eligible_at;");
    db.exec("ALTER TABLE work_item DROP COLUMN claim_epoch;");
    db.exec("CREATE INDEX idx_work_item_queue ON work_item (status);");
}

// v4→v5: host-observed turn outcome/timing and per-call provider usage.
// Nullable columns only; no backfill — pre-v5 facts were never recorded.
// ALTER statements must byte-match TS; migrated files append columns AFTER
// existing ones (deliberate asymmetry with fresh DDL).
const SQL_MIGRATE_V5_TURNS_OUTCOME: &str = "ALTER TABLE turns ADD COLUMN outcome TEXT CHECK (outcome IN ('completed', 'aborted') OR outcome IS NULL);";
const SQL_MIGRATE_V5_TURNS_OUTCOME_REASON: &str =
    "ALTER TABLE turns ADD COLUMN outcome_reason TEXT;";
const SQL_MIGRATE_V5_TURNS_STARTED_AT: &str = "ALTER TABLE turns ADD COLUMN started_at TEXT;";
const SQL_MIGRATE_V5_TURNS_ENDED_AT: &str = "ALTER TABLE turns ADD COLUMN ended_at TEXT;";
const SQL_MIGRATE_V5_MESSAGE_PROVIDER_USAGE: &str =
    "ALTER TABLE message ADD COLUMN provider_usage TEXT;";

fn migrate_turn_host_facts(db: &Db) {
    db.exec(SQL_MIGRATE_V5_TURNS_OUTCOME);
    db.exec(SQL_MIGRATE_V5_TURNS_OUTCOME_REASON);
    db.exec(SQL_MIGRATE_V5_TURNS_STARTED_AT);
    db.exec(SQL_MIGRATE_V5_TURNS_ENDED_AT);
    db.exec(SQL_MIGRATE_V5_MESSAGE_PROVIDER_USAGE);
}

pub fn migrate_thread_schema(db: &Db) {
    let mut version = match get_schema_version(db) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    if version >= CURRENT_THREAD_SCHEMA_VERSION {
        run_queued_turn_derivation_migration(db);
        return;
    }
    if version < THREAD_SCHEMA_VERSION_1 {
        panic!("unsupported thread schema version {version}");
    }

    db.exec("BEGIN IMMEDIATE;");
    match catch_unwind(AssertUnwindSafe(|| {
        if version == THREAD_SCHEMA_VERSION_1 {
            for statement in derivation_log_schema_statements() {
                db.exec(statement);
            }
            version = THREAD_SCHEMA_VERSION_2;
        }
        if version == THREAD_SCHEMA_VERSION_2 {
            migrate_detailed_turn_compression_rename(db);
            version = THREAD_SCHEMA_VERSION_3;
        }
        if version == THREAD_SCHEMA_VERSION_3 {
            migrate_queued_turn_derivation_work_items(db);
            migrate_one_shot_work_queue(db);
            version = THREAD_SCHEMA_VERSION_4;
        }
        if version == THREAD_SCHEMA_VERSION_4 {
            migrate_turn_host_facts(db);
            version = THREAD_SCHEMA_VERSION_5;
        }
        if version != CURRENT_THREAD_SCHEMA_VERSION {
            panic!("unsupported thread schema version {version}");
        }
        db.exec(&format!(
            "PRAGMA user_version = {CURRENT_THREAD_SCHEMA_VERSION};"
        ));
    })) {
        Ok(()) => db.exec("COMMIT;"),
        Err(payload) => {
            db.exec("ROLLBACK;");
            std::panic::resume_unwind(payload);
        }
    }
}

pub fn is_supported_thread_schema_version(version: i64) -> bool {
    (THREAD_SCHEMA_VERSION_1..=CURRENT_THREAD_SCHEMA_VERSION).contains(&version)
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
        assert!(matches!(
            payload_source_version_param(&parsed),
            SqlParam::I64(2)
        ));
        assert_eq!(
            parsed.get("operation").and_then(|v| v.as_str()),
            Some("legacy.op")
        );
        assert_eq!(
            parsed.get("legacyFlag"),
            Some(&serde_json::Value::Bool(true))
        );
        let keys: Vec<_> = parsed.keys().cloned().collect();
        assert_eq!(
            keys,
            vec![
                "sourceVersion".to_string(),
                "operation".to_string(),
                "legacyFlag".to_string(),
                "derivations".to_string(),
            ],
            "insertion order must be preserved"
        );
        let mut next = parsed.clone();
        set_payload_derivations(
            &mut next,
            vec![QueuedWorkItemDerivation {
                subject_kind: "turn".to_string(),
                subject_id: "t1".to_string(),
                derivation_type: "pre_detailed_assembly".to_string(),
            }],
        );
        let keys_after: Vec<_> = next.keys().cloned().collect();
        assert_eq!(
            keys_after, keys,
            "replacing derivations must retain key position"
        );
        let bytes = js_json_stringify_of(&next).expect("stringify");
        assert!(
            bytes.contains("\"legacyFlag\":true"),
            "unknown key dropped: {bytes}"
        );
        assert!(
            bytes.contains("\"sourceVersion\":2"),
            "known key lost camelCase: {bytes}"
        );
        // Object-shaped operation (current DurableWorkOperation) must round-trip.
        let object_op = r#"{"sourceVersion":1,"operation":{"kind":"turn_derivation"},"extra":9}"#;
        let obj_parsed: QueuedWorkItemPayload =
            serde_json::from_str(object_op).expect("parse object op");
        assert!(obj_parsed.get("operation").unwrap().is_object());
        let obj_bytes = js_json_stringify_of(&obj_parsed).expect("stringify object op");
        assert!(obj_bytes.contains("\"operation\":{"));
    }
}
