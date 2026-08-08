//! Ported from packages/lhc/test/thread-migrate.test.ts. Phase 1.
//!
//! Below-SDK fixture setup uses open_raw (Db) — the same choice the TS makes
//! with node:sqlite's DatabaseSync, since these helpers must construct legacy
//! schema shapes the current (post-migration) production seam would never write.

mod fixtures;

use lhc::shared_tech::derivation::{LeaseConfig, SdkConfig, SdkMode};
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::scheduler::DrainDisposition;
use lhc::shared_tech::storage::{Db, SqlParam, get_schema_version};
use lhc::shared_tech::thread_migrate::{
    THREAD_SCHEMA_VERSION_1, THREAD_SCHEMA_VERSION_2, THREAD_SCHEMA_VERSION_4,
    THREAD_SCHEMA_VERSION_5, THREAD_SCHEMA_VERSION_6,
};
use lhc::threads::{NewThreadInput, open_thread_database};
use lhc::{OpResult, ThreadRef, init_lhc, intake_stream, threads};

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, TurnEndOverrides, UserPromptOverrides,
    UserPromptPayload, create_inference_callbacks_double, kind, open_raw, read_derived_forms,
    temp_store, valid_event,
};

const RECEIPT_ACCOUNT_WITH_PROMPT_FILENAME: &str =
    "edit packages/lhc/src/shared-tech/prompts/smooth-turn-compression-v1.ts";

fn add_legacy_queue_columns(db: &Db) {
    db.exec("ALTER TABLE work_item ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;");
    db.exec("ALTER TABLE work_item ADD COLUMN last_error TEXT;");
    db.exec("ALTER TABLE work_item ADD COLUMN eligible_at TEXT;");
    db.exec("ALTER TABLE work_item ADD COLUMN claim_epoch INTEGER NOT NULL DEFAULT 0;");
}

// Fresh threads are created at the current schema. Simulating an older file
// means stripping columns that that older version never had, so the migration
// step that adds them can run for real.
fn strip_v5_host_fact_columns(db: &Db) {
    db.exec("ALTER TABLE turns DROP COLUMN outcome;");
    db.exec("ALTER TABLE turns DROP COLUMN outcome_reason;");
    db.exec("ALTER TABLE turns DROP COLUMN started_at;");
    db.exec("ALTER TABLE turns DROP COLUMN ended_at;");
    db.exec("ALTER TABLE message DROP COLUMN provider_usage;");
}

fn simulate_v1_thread(file_path: &str) {
    let db = open_raw(file_path);
    strip_v5_host_fact_columns(&db);
    add_legacy_queue_columns(&db);
    db.exec("DROP TABLE IF EXISTS derivation_log;");
    db.exec(&format!("PRAGMA user_version = {THREAD_SCHEMA_VERSION_1};"));
    db.close();
}

fn simulate_v2_thread_with_old_derivation_names(file_path: &str) {
    let metadata = js_json_stringify(&serde_json::json!({
        "receipts": [{
            "messageId": "m1",
            "activity": "tool_call",
            "account": RECEIPT_ACCOUNT_WITH_PROMPT_FILENAME,
            "outcome": "succeeded",
        }],
        "provenance": {
            "provider": "openai-codex",
            "model": "gpt-5.4-mini",
            "prompt": "smooth-turn-compression-v1",
        },
    }));
    let log_payload = js_json_stringify(&serde_json::json!({
        "reason": RECEIPT_ACCOUNT_WITH_PROMPT_FILENAME,
        "provenance": {
            "provider": "openai-codex",
            "model": "gpt-5.4-mini",
            "prompt": "smooth-turn-compression-v1",
        },
    }));
    let db = open_raw(file_path);
    strip_v5_host_fact_columns(&db);
    add_legacy_queue_columns(&db);
    db.prepare(
        "INSERT INTO derivation
           (subject_kind, subject_id, derivation_type, state, content, source_version)
         VALUES ('turn', 't1', 'smooth_turn_compression', 'ready', 'legacy compression', 1)",
    )
    .run(&[]);
    db.prepare(
        "INSERT INTO derivation
           (subject_kind, subject_id, derivation_type, state, content, metadata, source_version)
         VALUES ('turn', 't2', 'smooth_turn_compression', 'ready', 'legacy with receipts', ?, 1)",
    )
    .run(&[SqlParam::from(metadata.as_str())]);
    db.prepare(
        "INSERT INTO derivation_log
           (subject_kind, subject_id, derivation_type, event_kind, payload)
         VALUES ('turn', 't2', 'smooth_turn_compression', 'inference_succeeded', ?)",
    )
    .run(&[SqlParam::from(log_payload.as_str())]);
    db.prepare(
        "INSERT INTO thread_view
           (singleton, view_id, created_at, compact_point, covered_from, profile_name,
            config_json, arrangement_json, gaps_json, source_state_json)
         VALUES (1, 'v1', '2026-01-01T00:00:00.000Z', 0, 0, NULL,
           '{}',
           '[{\"band\":\"detailed\",\"subjectKind\":\"turn\",\"subjectId\":\"t1\",\"derivationUsed\":\"smooth_turn_compression\",\"degraded\":false}]',
           '[{\"subjectId\":\"t1\",\"reason\":\"smooth_turn_compression pending\"}]',
           '{\"turns\":{\"t1\":{\"smooth_turn_compression\":\"ready\"}}}')",
    )
    .run(&[]);
    db.exec(&format!("PRAGMA user_version = {THREAD_SCHEMA_VERSION_2};"));
    db.close();
}

struct PoisonOpts {
    downgrade_to_v2: bool,
    work_status: Option<&'static str>,
    crash_window: bool,
}

async fn fixture_poisoned_turn_derivation_work_item(file_path: &str, opts: PoisonOpts) {
    let result = intake_stream::message_events(
        ThreadRef::file_path(file_path),
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "migration drain test".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("migration answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;
    if !result.is_ok() {
        if let OpResult::Err { error } = result {
            panic!("fixture intake failed: {}", error.reason);
        }
    }

    let db = open_raw(file_path);
    let row = db
        .prepare("SELECT payload FROM work_item WHERE kind = 'turn_derivation'")
        .get();
    let Some(row) = row else {
        panic!("fixture invariant: turn_derivation work item expected");
    };
    let payload_raw = row
        .get("payload")
        .and_then(|v| v.as_str())
        .expect("payload string");
    let payload: serde_json::Value =
        serde_json::from_str(payload_raw).expect("work_item payload json");
    let source_version = payload
        .get("sourceVersion")
        .and_then(|v| v.as_i64())
        .unwrap_or(1);
    let derivations = if opts.crash_window {
        serde_json::json!([
            {"subjectKind": "turn", "subjectId": "t1", "derivationType": "turn_rendering"},
            {"subjectKind": "turn", "subjectId": "t1", "derivationType": "pre_detailed_assembly"},
        ])
    } else {
        serde_json::json!([
            {"subjectKind": "turn", "subjectId": "t1", "derivationType": "turn_rendering"},
            {"subjectKind": "turn", "subjectId": "t1", "derivationType": "detailed_turn_compression"},
        ])
    };
    // TS `JSON.stringify` omits `operation` when undefined — do not serialize null.
    let mut new_payload = serde_json::json!({
        "sourceVersion": source_version,
        "derivations": derivations,
    });
    if let Some(operation) = payload.get("operation") {
        if !operation.is_null() {
            new_payload
                .as_object_mut()
                .expect("payload object")
                .insert("operation".into(), operation.clone());
        }
    }
    let new_payload = js_json_stringify(&new_payload);
    db.prepare("UPDATE work_item SET payload = ? WHERE kind = 'turn_derivation'")
        .run(&[SqlParam::from(new_payload.as_str())]);
    db.prepare("DELETE FROM derivation WHERE derivation_type = 'pre_detailed_assembly'")
        .run(&[]);
    if !opts.crash_window {
        db.prepare(
            "INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
             VALUES ('turn', 't1', 'detailed_turn_compression', 'pending', ?)
             ON CONFLICT (subject_kind, subject_id, derivation_type) DO UPDATE SET
               state = 'pending', content = NULL, reason = NULL, metadata = NULL,
               gaps = NULL, derived_at = NULL, source_version = excluded.source_version",
        )
        .run(&[SqlParam::from(source_version)]);
    }
    if opts.work_status == Some("claimed") {
        db.prepare(
            "UPDATE work_item
             SET status = 'claimed',
                 claimed_at = '2020-01-01T00:00:00.000Z',
                 claim_expires_at = '2020-01-01T00:00:00.000Z'
             WHERE kind = 'turn_derivation'",
        )
        .run(&[]);
    }
    if opts.downgrade_to_v2 {
        strip_v5_host_fact_columns(&db);
        add_legacy_queue_columns(&db);
        db.exec(&format!("PRAGMA user_version = {THREAD_SCHEMA_VERSION_2};"));
    }
    db.close();
}

fn form_of(file_path: &str, derivation_type: &str) -> Option<lhc::Derivation> {
    read_derived_forms(file_path)
        .into_iter()
        .find(|form| form.subject_id == "t1" && form.derivation_type == derivation_type)
}

async fn drain_turn_derivations_green(file_path: &str) {
    let double = create_inference_callbacks_double();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
        view: None,
    });
    let drain = sdk.work.drain(ThreadRef::file_path(file_path), None).await;
    assert!(drain.is_ok());
    if !drain.is_ok() {
        return;
    }

    let rendering = form_of(file_path, "turn_rendering");
    assert_eq!(rendering.as_ref().map(|f| f.state.as_str()), Some("ready"));
    let assembly = form_of(file_path, "pre_detailed_assembly");
    assert_eq!(assembly.as_ref().map(|f| f.state.as_str()), Some("ready"));
    assert!(
        assembly
            .as_ref()
            .and_then(|f| f.content.as_ref())
            .is_some_and(|c| c.contains("User:\n"))
    );
    assert!(
        assembly
            .as_ref()
            .and_then(|f| f.content.as_ref())
            .is_some_and(|c| c.contains("⏺ "))
    );
    let compression = form_of(file_path, "detailed_turn_compression");
    assert_eq!(
        compression.as_ref().map(|f| f.state.as_str()),
        Some("ready")
    );

    let queue_db = open_raw(file_path);
    let count = queue_db
        .prepare("SELECT COUNT(*) AS count FROM work_item WHERE status IN ('queued', 'claimed')")
        .get()
        .and_then(|row| row.get("count").cloned())
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    assert_eq!(count, 0);
    queue_db.close();
}

fn schema_version(db: &Db) -> i64 {
    match get_schema_version(db) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("get_schema_version failed: {}", error.reason),
    }
}

#[tokio::test]
async fn opens_a_v1_thread_file_migrates_derivation_log_and_preserves_existing_data() {
    let store = temp_store();
    let file_path = store.thread_path(None);
    let file_path_str = file_path.to_string_lossy().into_owned();
    let created = threads::new_thread(NewThreadInput {
        file_path: file_path_str.clone(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await;
    assert!(created.is_ok());
    let OpResult::Ok { value: created } = created else {
        store.cleanup();
        return;
    };
    let thread_id = created.thread_id;
    simulate_v1_thread(&file_path_str);

    let before = open_raw(&file_path_str);
    assert_eq!(schema_version(&before), THREAD_SCHEMA_VERSION_1);
    assert!(
        before
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'derivation_log'"
            )
            .get()
            .is_none()
    );
    before.close();

    let opened = open_thread_database(&file_path_str);
    assert!(opened.is_ok());
    let OpResult::Ok { value: db } = opened else {
        store.cleanup();
        return;
    };
    assert_eq!(schema_version(&db), THREAD_SCHEMA_VERSION_6);
    assert!(
        db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'derivation_log'"
        )
        .get()
        .is_some()
    );
    let metadata = db
        .prepare("SELECT thread_id FROM thread_metadata WHERE id = 1")
        .get();
    assert_eq!(
        metadata
            .as_ref()
            .and_then(|m| m.get("thread_id"))
            .and_then(|v| v.as_str()),
        Some(thread_id.as_str())
    );
    let turn_count = db
        .prepare("SELECT COUNT(*) AS count FROM turns")
        .get()
        .and_then(|row| row.get("count").cloned())
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    assert_eq!(turn_count, 1);
    db.close();
    store.cleanup();
}

#[tokio::test]
async fn migrates_v2_derivation_rows_and_stored_view_json_from_smooth_turn_compression_to_detailed_turn_compression()
 {
    let store = temp_store();
    let file_path = store.thread_path(None);
    let file_path_str = file_path.to_string_lossy().into_owned();
    let created = threads::new_thread(NewThreadInput {
        file_path: file_path_str.clone(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await;
    assert!(created.is_ok());
    if !created.is_ok() {
        store.cleanup();
        return;
    }

    simulate_v2_thread_with_old_derivation_names(&file_path_str);

    let opened = open_thread_database(&file_path_str);
    assert!(opened.is_ok());
    let OpResult::Ok { value: db } = opened else {
        store.cleanup();
        return;
    };
    assert_eq!(schema_version(&db), THREAD_SCHEMA_VERSION_6);
    let derivation = db
        .prepare(
            "SELECT derivation_type, content FROM derivation
             WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'detailed_turn_compression'",
        )
        .get();
    assert_eq!(
        derivation
            .as_ref()
            .and_then(|d| d.get("derivation_type"))
            .and_then(|v| v.as_str()),
        Some("detailed_turn_compression")
    );
    assert_eq!(
        derivation
            .as_ref()
            .and_then(|d| d.get("content"))
            .and_then(|v| v.as_str()),
        Some("legacy compression")
    );
    assert!(
        db.prepare("SELECT 1 FROM derivation WHERE derivation_type = 'smooth_turn_compression'")
            .get()
            .is_none()
    );

    let view = db
        .prepare(
            "SELECT arrangement_json, gaps_json, source_state_json FROM thread_view WHERE singleton = 1",
        )
        .get()
        .expect("thread_view");
    let arrangement = view
        .get("arrangement_json")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let gaps = view.get("gaps_json").and_then(|v| v.as_str()).unwrap_or("");
    let source_state = view
        .get("source_state_json")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    assert!(arrangement.contains("\"derivationUsed\":\"detailed_turn_compression\""));
    assert!(!arrangement.contains("smooth_turn_compression"));
    assert!(gaps.contains("detailed_turn_compression"));
    assert!(!gaps.contains("smooth_turn_compression"));
    assert!(source_state.contains("detailed_turn_compression"));
    assert!(!source_state.contains("smooth_turn_compression"));

    let migrated_metadata = db
        .prepare(
            "SELECT metadata FROM derivation
             WHERE subject_kind = 'turn' AND subject_id = 't2' AND derivation_type = 'detailed_turn_compression'",
        )
        .get();
    assert!(migrated_metadata.is_some());
    let parsed_metadata: serde_json::Value = serde_json::from_str(
        migrated_metadata
            .as_ref()
            .and_then(|m| m.get("metadata"))
            .and_then(|v| v.as_str())
            .expect("metadata"),
    )
    .expect("metadata json");
    assert_eq!(
        parsed_metadata["receipts"][0]["account"].as_str(),
        Some(RECEIPT_ACCOUNT_WITH_PROMPT_FILENAME)
    );
    assert_eq!(
        parsed_metadata["provenance"]["prompt"].as_str(),
        Some("detailed-turn-compression-v1")
    );

    let migrated_log = db
        .prepare(
            "SELECT payload FROM derivation_log
             WHERE subject_kind = 'turn' AND subject_id = 't2' AND derivation_type = 'detailed_turn_compression'",
        )
        .get();
    assert!(migrated_log.is_some());
    let parsed_log: serde_json::Value = serde_json::from_str(
        migrated_log
            .as_ref()
            .and_then(|m| m.get("payload"))
            .and_then(|v| v.as_str())
            .expect("payload"),
    )
    .expect("log payload json");
    assert_eq!(
        parsed_log["reason"].as_str(),
        Some(RECEIPT_ACCOUNT_WITH_PROMPT_FILENAME)
    );
    assert_eq!(
        parsed_log["provenance"]["prompt"].as_str(),
        Some("detailed-turn-compression-v1")
    );
    db.close();
    store.cleanup();
}

#[tokio::test]
async fn normalizes_queued_old_shape_turn_derivation_items_and_drains_cleanly_end_to_end() {
    let store = temp_store();
    let file_path = store.thread_path(None);
    let file_path_str = file_path.to_string_lossy().into_owned();
    let created = threads::new_thread(NewThreadInput {
        file_path: file_path_str.clone(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await;
    assert!(created.is_ok());
    if !created.is_ok() {
        store.cleanup();
        return;
    }

    fixture_poisoned_turn_derivation_work_item(
        &file_path_str,
        PoisonOpts {
            downgrade_to_v2: true,
            work_status: None,
            crash_window: false,
        },
    )
    .await;

    let opened = open_thread_database(&file_path_str);
    assert!(opened.is_ok());
    let OpResult::Ok { value: db } = opened else {
        store.cleanup();
        return;
    };
    assert_eq!(schema_version(&db), THREAD_SCHEMA_VERSION_6);
    let payload_raw = db
        .prepare("SELECT payload FROM work_item WHERE kind = 'turn_derivation'")
        .get()
        .and_then(|row| {
            row.get("payload")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .expect("payload");
    let payload: serde_json::Value = serde_json::from_str(&payload_raw).expect("payload json");
    let mut types: Vec<_> = payload["derivations"]
        .as_array()
        .expect("derivations")
        .iter()
        .map(|t| t["derivationType"].as_str().unwrap_or("").to_string())
        .collect();
    types.sort();
    assert_eq!(
        types,
        vec![
            "pre_detailed_assembly".to_string(),
            "turn_rendering".to_string()
        ]
    );
    let state = db
        .prepare(
            "SELECT state FROM derivation
             WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'pre_detailed_assembly'",
        )
        .get()
        .and_then(|row| row.get("state").and_then(|v| v.as_str()).map(str::to_string));
    assert_eq!(state.as_deref(), Some("pending"));
    db.close();

    drain_turn_derivations_green(&file_path_str).await;
    store.cleanup();
}

#[tokio::test]
async fn normalizes_a_claimed_old_shape_item_then_fails_its_expired_lease_without_rerunning_it() {
    let store = temp_store();
    let file_path = store.thread_path(None);
    let file_path_str = file_path.to_string_lossy().into_owned();
    let created = threads::new_thread(NewThreadInput {
        file_path: file_path_str.clone(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await;
    assert!(created.is_ok());
    if !created.is_ok() {
        store.cleanup();
        return;
    }

    fixture_poisoned_turn_derivation_work_item(
        &file_path_str,
        PoisonOpts {
            downgrade_to_v2: false,
            work_status: Some("claimed"),
            crash_window: false,
        },
    )
    .await;

    let opened = open_thread_database(&file_path_str);
    assert!(opened.is_ok());
    let OpResult::Ok { value: db } = opened else {
        store.cleanup();
        return;
    };
    let work = db
        .prepare("SELECT status, payload FROM work_item WHERE kind = 'turn_derivation'")
        .get()
        .expect("work_item");
    assert_eq!(work.get("status").and_then(|v| v.as_str()), Some("claimed"));
    let payload: serde_json::Value = serde_json::from_str(
        work.get("payload")
            .and_then(|v| v.as_str())
            .expect("payload"),
    )
    .expect("payload json");
    let mut types: Vec<_> = payload["derivations"]
        .as_array()
        .expect("derivations")
        .iter()
        .map(|t| t["derivationType"].as_str().unwrap_or("").to_string())
        .collect();
    types.sort();
    assert_eq!(
        types,
        vec![
            "pre_detailed_assembly".to_string(),
            "turn_rendering".to_string()
        ]
    );
    let state = db
        .prepare(
            "SELECT state FROM derivation
             WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'pre_detailed_assembly'",
        )
        .get()
        .and_then(|row| row.get("state").and_then(|v| v.as_str()).map(str::to_string));
    assert_eq!(state.as_deref(), Some("pending"));
    db.close();

    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let drained = sdk
        .work
        .drain(ThreadRef::file_path(&file_path_str), None)
        .await;
    assert!(drained.is_ok());
    if let OpResult::Ok { value } = drained {
        assert!(value.ran.iter().any(|entry| {
            entry.work_item_id == "w-t1-turn_derivation-v1"
                && entry.disposition == DrainDisposition::FailedTerminal
                && entry.reason.as_deref() == Some("claim_expired")
        }));
    }
    let rendering = form_of(&file_path_str, "turn_rendering");
    assert_eq!(rendering.as_ref().map(|f| f.state.as_str()), Some("failed"));
    assert_eq!(
        rendering.and_then(|f| f.reason),
        Some("claim_expired".into())
    );
    let assembly = form_of(&file_path_str, "pre_detailed_assembly");
    assert_eq!(assembly.as_ref().map(|f| f.state.as_str()), Some("failed"));
    assert_eq!(
        assembly.and_then(|f| f.reason),
        Some("claim_expired".into())
    );
    store.cleanup();
}

#[tokio::test]
async fn heals_a_crash_window_partial_normalization_on_reopen_new_shape_payload_missing_assembly_row()
 {
    let store = temp_store();
    let file_path = store.thread_path(None);
    let file_path_str = file_path.to_string_lossy().into_owned();
    let created = threads::new_thread(NewThreadInput {
        file_path: file_path_str.clone(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await;
    assert!(created.is_ok());
    if !created.is_ok() {
        store.cleanup();
        return;
    }

    fixture_poisoned_turn_derivation_work_item(
        &file_path_str,
        PoisonOpts {
            downgrade_to_v2: false,
            work_status: None,
            crash_window: true,
        },
    )
    .await;

    let before = open_raw(&file_path_str);
    let payload_raw = before
        .prepare("SELECT payload FROM work_item WHERE kind = 'turn_derivation'")
        .get()
        .and_then(|row| {
            row.get("payload")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .expect("payload");
    let payload: serde_json::Value = serde_json::from_str(&payload_raw).expect("payload json");
    assert!(
        payload["derivations"]
            .as_array()
            .expect("derivations")
            .iter()
            .any(|t| t["derivationType"].as_str() == Some("pre_detailed_assembly"))
    );
    assert!(
        before
            .prepare(
                "SELECT 1 FROM derivation
                 WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'pre_detailed_assembly'",
            )
            .get()
            .is_none()
    );
    before.close();

    let opened = open_thread_database(&file_path_str);
    assert!(opened.is_ok());
    let OpResult::Ok { value: db } = opened else {
        store.cleanup();
        return;
    };
    let state = db
        .prepare(
            "SELECT state FROM derivation
             WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'pre_detailed_assembly'",
        )
        .get()
        .and_then(|row| row.get("state").and_then(|v| v.as_str()).map(str::to_string));
    assert_eq!(state.as_deref(), Some("pending"));
    db.close();

    drain_turn_derivations_green(&file_path_str).await;
    store.cleanup();
}

// Schema v5 (D4): add nullable turn host-fact + message provider_usage columns
// with no backfill. Existing rows keep NULL in every new field.
fn simulate_v4_thread(file_path: &str) {
    let db = open_raw(file_path);
    strip_v5_host_fact_columns(&db);
    db.exec(&format!("PRAGMA user_version = {THREAD_SCHEMA_VERSION_4};"));
    db.close();
}

#[tokio::test]
async fn migrates_a_v4_file_adds_nullable_host_fact_columns_preserves_data_backfills_nothing() {
    let store = temp_store();
    let file_path = store.thread_path(None);
    let file_path_str = file_path.to_string_lossy().into_owned();
    let created = threads::new_thread(NewThreadInput {
        file_path: file_path_str.clone(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await;
    assert!(created.is_ok());
    if !created.is_ok() {
        store.cleanup();
        return;
    }

    let intake = intake_stream::message_events(
        ThreadRef::file_path(&file_path_str),
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "v4 migration prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("v4 migration answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;
    assert!(intake.is_ok());
    if !intake.is_ok() {
        store.cleanup();
        return;
    }

    let before = open_raw(&file_path_str);
    let event_count = before
        .prepare("SELECT COUNT(*) AS count FROM event")
        .get()
        .and_then(|row| row.get("count").cloned())
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    let message_ids: Vec<String> = before
        .prepare("SELECT message_id FROM message ORDER BY source_event_order")
        .all(&[])
        .into_iter()
        .filter_map(|row| {
            row.get("message_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .collect();
    let turn_ids: Vec<String> = before
        .prepare("SELECT turn_id FROM turns ORDER BY turn_order")
        .all(&[])
        .into_iter()
        .filter_map(|row| {
            row.get("turn_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .collect();
    assert_eq!(event_count, 3);
    assert_eq!(message_ids, vec!["m1".to_string(), "m2".to_string()]);
    assert_eq!(turn_ids, vec!["t1".to_string(), "t2".to_string()]);
    before.close();

    simulate_v4_thread(&file_path_str);

    let pre_migrate = open_raw(&file_path_str);
    assert_eq!(schema_version(&pre_migrate), THREAD_SCHEMA_VERSION_4);
    let turn_cols: Vec<String> = pre_migrate
        .prepare("PRAGMA table_info(turns)")
        .all(&[])
        .into_iter()
        .filter_map(|row| row.get("name").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    let message_cols: Vec<String> = pre_migrate
        .prepare("PRAGMA table_info(message)")
        .all(&[])
        .into_iter()
        .filter_map(|row| row.get("name").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    assert!(!turn_cols.iter().any(|n| n == "outcome"));
    assert!(!turn_cols.iter().any(|n| n == "outcome_reason"));
    assert!(!turn_cols.iter().any(|n| n == "started_at"));
    assert!(!turn_cols.iter().any(|n| n == "ended_at"));
    assert!(!message_cols.iter().any(|n| n == "provider_usage"));
    pre_migrate.close();

    let opened = open_thread_database(&file_path_str);
    assert!(opened.is_ok());
    let OpResult::Ok { value: db } = opened else {
        store.cleanup();
        return;
    };
    assert_eq!(schema_version(&db), THREAD_SCHEMA_VERSION_6);

    let turn_cols: Vec<String> = db
        .prepare("PRAGMA table_info(turns)")
        .all(&[])
        .into_iter()
        .filter_map(|row| row.get("name").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    let message_cols: Vec<String> = db
        .prepare("PRAGMA table_info(message)")
        .all(&[])
        .into_iter()
        .filter_map(|row| row.get("name").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    for col in ["outcome", "outcome_reason", "started_at", "ended_at"] {
        assert!(
            turn_cols.iter().any(|n| n == col),
            "turns missing column {col}: {turn_cols:?}"
        );
    }
    assert!(message_cols.iter().any(|n| n == "provider_usage"));

    // All pre-migration rows keep NULL in every new field — no invented values.
    let turn_rows = db
        .prepare(
            "SELECT turn_id, outcome, outcome_reason, started_at, ended_at FROM turns ORDER BY turn_order",
        )
        .all(&[]);
    assert_eq!(
        turn_rows
            .iter()
            .filter_map(|row| row
                .get("turn_id")
                .and_then(|v| v.as_str())
                .map(str::to_string))
            .collect::<Vec<_>>(),
        turn_ids
    );
    for row in &turn_rows {
        assert!(matches!(
            row.get("outcome"),
            None | Some(serde_json::Value::Null)
        ));
        assert!(matches!(
            row.get("outcome_reason"),
            None | Some(serde_json::Value::Null)
        ));
        assert!(matches!(
            row.get("started_at"),
            None | Some(serde_json::Value::Null)
        ));
        assert!(matches!(
            row.get("ended_at"),
            None | Some(serde_json::Value::Null)
        ));
    }

    let message_rows = db
        .prepare("SELECT message_id, provider_usage FROM message ORDER BY source_event_order")
        .all(&[]);
    assert_eq!(
        message_rows
            .iter()
            .filter_map(|row| {
                row.get("message_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .collect::<Vec<_>>(),
        message_ids
    );
    for row in &message_rows {
        assert!(matches!(
            row.get("provider_usage"),
            None | Some(serde_json::Value::Null)
        ));
    }

    // Existing record content is intact.
    assert_eq!(
        db.prepare("SELECT COUNT(*) AS count FROM event")
            .get()
            .and_then(|row| row.get("count").cloned())
            .and_then(|v| v.as_i64())
            .unwrap_or(-1),
        event_count
    );
    let prompt = db
        .prepare("SELECT content FROM message_block WHERE message_id = 'm1' AND block_index = 0")
        .get()
        .expect("prompt block");
    let content: serde_json::Value = serde_json::from_str(
        prompt
            .get("content")
            .and_then(|v| v.as_str())
            .expect("content"),
    )
    .expect("content json");
    assert_eq!(content["text"].as_str(), Some("v4 migration prompt"));
    db.close();
    store.cleanup();
}

#[tokio::test]
async fn migrates_a_genuine_v5_file_by_creating_the_retrieval_impression_table_and_indexes() {
    use std::panic::{AssertUnwindSafe, catch_unwind};

    let store = temp_store();
    let file_path = store.thread_path(None).to_string_lossy().into_owned();
    let sdk = init_lhc(SdkConfig {
        mode: SdkMode::Manual,
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    assert!(created.is_ok());

    // Seed real v5-era rows (messages / turns / events) before stripping the
    // impression table — migration must preserve them.
    let intake = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "v5 migrate seed prompt".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new("v5 migrate seed answer")),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(intake.is_ok());

    let (event_count, message_count, turn_count, prompt_text) = {
        let old = open_raw(&file_path);
        let event_count = old
            .prepare("SELECT COUNT(*) AS c FROM event")
            .get()
            .and_then(|r| r.get("c").and_then(|v| v.as_i64()))
            .unwrap_or(-1);
        let message_count = old
            .prepare("SELECT COUNT(*) AS c FROM message")
            .get()
            .and_then(|r| r.get("c").and_then(|v| v.as_i64()))
            .unwrap_or(-1);
        let turn_count = old
            .prepare("SELECT COUNT(*) AS c FROM turns")
            .get()
            .and_then(|r| r.get("c").and_then(|v| v.as_i64()))
            .unwrap_or(-1);
        let prompt_text = old
            .prepare(
                "SELECT content FROM message_block WHERE message_id = 'm1' AND block_index = 0",
            )
            .get()
            .and_then(|r| {
                r.get("content")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .expect("prompt block");

        old.exec("DROP TABLE retrieval_impression;");
        // Drop indexes may already be gone with the table; user_version back to 5.
        old.exec(&format!("PRAGMA user_version = {THREAD_SCHEMA_VERSION_5};"));
        let missing = old
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'retrieval_impression'",
            )
            .get();
        assert!(missing.is_none());
        assert!(event_count >= 3);
        assert!(message_count >= 2);
        assert!(turn_count >= 1);
        old.close();
        (event_count, message_count, turn_count, prompt_text)
    };

    let opened = open_thread_database(&file_path);
    let OpResult::Ok { value: db } = opened else {
        panic!("open failed");
    };
    assert_eq!(schema_version(&db), THREAD_SCHEMA_VERSION_6);
    let present = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'retrieval_impression'",
        )
        .get();
    assert!(present.is_some());
    let indexes: Vec<String> = db
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE type = 'index' AND name LIKE 'idx_retrieval_impression_%' ORDER BY name",
        )
        .all(&[])
        .into_iter()
        .filter_map(|row| row.get("name").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    assert_eq!(
        indexes,
        vec![
            "idx_retrieval_impression_call".to_string(),
            "idx_retrieval_impression_entity".to_string(),
        ]
    );

    // Data preservation: seed rows survive the 5→6 upgrade.
    assert_eq!(
        db.prepare("SELECT COUNT(*) AS c FROM event")
            .get()
            .and_then(|r| r.get("c").and_then(|v| v.as_i64()))
            .unwrap_or(-1),
        event_count
    );
    assert_eq!(
        db.prepare("SELECT COUNT(*) AS c FROM message")
            .get()
            .and_then(|r| r.get("c").and_then(|v| v.as_i64()))
            .unwrap_or(-1),
        message_count
    );
    assert_eq!(
        db.prepare("SELECT COUNT(*) AS c FROM turns")
            .get()
            .and_then(|r| r.get("c").and_then(|v| v.as_i64()))
            .unwrap_or(-1),
        turn_count
    );
    let after_prompt = db
        .prepare("SELECT content FROM message_block WHERE message_id = 'm1' AND block_index = 0")
        .get()
        .and_then(|r| {
            r.get("content")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .expect("prompt block after migrate");
    assert_eq!(after_prompt, prompt_text);
    assert!(prompt_text.contains("v5 migrate seed prompt"));

    // CHECK constraints: bad entity_kind and bad served must be rejected.
    let bad_kind = catch_unwind(AssertUnwindSafe(|| {
        db.prepare(
            r#"INSERT INTO retrieval_impression
               (call_id, surface, entity_kind, entity_id, request_idx, served, reason, tokens)
               VALUES ('c1', 'test', 'bogus', 't1', 0, 1, NULL, 1)"#,
        )
        .run(&[]);
    }));
    assert!(
        bad_kind.is_err(),
        "entity_kind CHECK must reject values outside turn|message"
    );

    let bad_served = catch_unwind(AssertUnwindSafe(|| {
        db.prepare(
            r#"INSERT INTO retrieval_impression
               (call_id, surface, entity_kind, entity_id, request_idx, served, reason, tokens)
               VALUES ('c2', 'test', 'turn', 't1', 0, 2, NULL, 1)"#,
        )
        .run(&[]);
    }));
    assert!(
        bad_served.is_err(),
        "served CHECK must reject values outside 0|1"
    );

    // Valid insert still works after the rejected attempts.
    db.prepare(
        r#"INSERT INTO retrieval_impression
           (call_id, surface, entity_kind, entity_id, request_idx, served, reason, tokens)
           VALUES ('c3', 'test', 'turn', 't1', 0, 1, NULL, 7)"#,
    )
    .run(&[]);
    let ok_row = db
        .prepare(
            "SELECT entity_kind, served, tokens FROM retrieval_impression WHERE call_id = 'c3'",
        )
        .get()
        .expect("valid impression row");
    assert_eq!(
        ok_row.get("entity_kind").and_then(|v| v.as_str()),
        Some("turn")
    );
    assert_eq!(ok_row.get("served").and_then(|v| v.as_i64()), Some(1));
    assert_eq!(ok_row.get("tokens").and_then(|v| v.as_i64()), Some(7));

    db.close();
}
