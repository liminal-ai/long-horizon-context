//! Ported from packages/lhc/test/logging-surface.test.ts. Phase 1.

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, TurnEndOverrides, UserPromptOverrides,
    UserPromptPayload, create_inference_callbacks_double, kind, open_raw, read_derived_forms,
    register_test_work_handlers, temp_store, valid_event,
};
use lhc::OpResult;
use lhc::shared_tech::derivation::{LeaseConfig, SdkConfig, SdkMode};
use lhc::shared_tech::persist::DbTransaction;
use lhc::shared_tech::storage::SqlParam;
use lhc::threads::NewThreadInput;
use lhc::{
    DbReadTransaction, DrainReport, Lhc, LogEntry, LogLevel, LogQuery, MessageEventInput,
    ThreadRef, count_live_items, create_deterministic_inference_callbacks, init_lhc,
    set_scheduler_poke, set_thread_touch, write_log,
};
use serde_json::Value;

fn make_sdk() -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(create_deterministic_inference_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    })
}

async fn new_thread(store: &fixtures::TempStore, sdk: &Lhc) -> String {
    let file_path = store.thread_path(Some("logging-test"));
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.to_string_lossy().into_owned(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    assert!(created.is_ok());
    match created {
        OpResult::Ok { value } => value.file_path,
        OpResult::Err { .. } => unreachable!(),
    }
}

async fn write(sdk: &Lhc, file_path: &str, entry: LogEntry) {
    let written = sdk
        .logging
        .write(ThreadRef::file_path(file_path), entry)
        .await;
    assert!(written.is_ok());
}

fn manual_sdk(double: &fixtures::InferenceCallbacksDouble) -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
        view: None,
    })
}

async fn send(target: &Lhc, file_path: &str, batch: &[MessageEventInput]) {
    let result = target
        .intake_stream
        .message_events(ThreadRef::file_path(file_path), batch)
        .await;
    assert!(result.is_ok());
}

async fn drain(target: &Lhc, file_path: &str) -> DrainReport {
    let result = target
        .work
        .drain(ThreadRef::file_path(file_path), None)
        .await;
    assert!(result.is_ok());
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { .. } => panic!("drain failed"),
    }
}

fn live_count(file_path: &str) -> i64 {
    let db = open_raw(file_path);
    let n = count_live_items(&db);
    db.close();
    n
}

async fn send_turn(target: &Lhc, file_path: &str) {
    send(
        target,
        file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "raw prompt one".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("answer text")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;
}

fn cleanup_seams() {
    set_scheduler_poke(None);
    set_thread_touch(None);
}

#[tokio::test]
async fn tc_5_1a_persists_info_warning_and_error_levels() {
    let store = temp_store();
    let sdk = make_sdk();
    let file_path = new_thread(&store, &sdk).await;
    for level in [LogLevel::Info, LogLevel::Warning, LogLevel::Error] {
        write(
            &sdk,
            &file_path,
            LogEntry {
                level,
                message: format!("{} message", level.as_str()),
                derivation_type: None,
                subject_id: None,
                reason: None,
                floor_used: None,
            },
        )
        .await;
    }
    let queried = sdk
        .logging
        .query(
            ThreadRef::file_path(&file_path),
            LogQuery {
                level: None,
                derivation_type: None,
                subject_id: None,
                reason: None,
            },
        )
        .await;
    assert!(queried.is_ok());
    if let OpResult::Ok { value } = queried {
        let mut levels: Vec<_> = value.iter().map(|e| e.level.as_str()).collect();
        levels.sort();
        assert_eq!(levels, vec!["error", "info", "warning"]);
    }
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn tc_5_2a_writes_internal_and_external_callers_through_the_same_store() {
    let store = temp_store();
    let sdk = make_sdk();
    let file_path = new_thread(&store, &sdk).await;
    let db = open_raw(&file_path);
    let txn = DbReadTransaction {
        db: &db,
        thread_id: "logging-test".into(),
        file_path: file_path.clone(),
    };
    write_log(
        DbTransaction::Read(&txn),
        &LogEntry {
            level: LogLevel::Info,
            message: "internal caller".into(),
            derivation_type: Some("smoothed_prompt".into()),
            subject_id: Some("m1".into()),
            reason: None,
            floor_used: None,
        },
    );
    write(
        &sdk,
        &file_path,
        LogEntry {
            level: LogLevel::Warning,
            message: "external caller".into(),
            derivation_type: Some("tool_result_summary".into()),
            subject_id: Some("m2".into()),
            reason: None,
            floor_used: None,
        },
    )
    .await;
    let queried = sdk
        .logging
        .query(
            ThreadRef::file_path(&file_path),
            LogQuery {
                level: None,
                derivation_type: None,
                subject_id: None,
                reason: None,
            },
        )
        .await;
    assert!(queried.is_ok());
    if let OpResult::Ok { value } = queried {
        let mut messages: Vec<_> = value.iter().map(|e| e.message.as_str()).collect();
        messages.sort();
        assert_eq!(messages, vec!["external caller", "internal caller"]);
    }
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn tc_5_3a_keeps_fallback_events_in_the_log_not_on_ready_derivations() {
    let store = temp_store();
    let sdk = make_sdk();
    let file_path = new_thread(&store, &sdk).await;
    let double = create_inference_callbacks_double();
    double.fail_kind("prompt_smoothing", 1, Some("scripted smoothing failure"));
    let target = manual_sdk(&double);
    send_turn(&target, &file_path).await;
    let report = drain(&target, &file_path).await;
    assert_eq!(
        report
            .ran
            .iter()
            .map(|e| (e.work_item_id.as_str(), e.disposition.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("w-m1-prompt_smoothing-v1", "failed_terminal"),
            ("w-t1-turn_derivation-v1", "done"),
            ("w-t1-detailed_turn_compression-v1", "done"),
        ]
    );
    let read = open_raw(&file_path);
    let row = read
        .prepare(
            "SELECT state, content, reason, gaps, metadata FROM derivation WHERE subject_id = ?",
        )
        .get_params(&[SqlParam::from("t1")]);
    assert!(row.is_some());
    let row = row.unwrap();
    assert_eq!(row.get("state").and_then(|v| v.as_str()), Some("ready"));
    assert_eq!(row.get("reason"), Some(&Value::Null));
    assert_eq!(row.get("gaps"), Some(&Value::Null));
    assert!(
        row.get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("raw prompt one")
    );
    assert_eq!(row.get("metadata"), Some(&Value::Null));
    read.close();
    let queried = sdk
        .logging
        .query(
            ThreadRef::file_path(&file_path),
            LogQuery {
                level: None,
                derivation_type: Some("smoothed_prompt".into()),
                subject_id: None,
                reason: None,
            },
        )
        .await;
    assert!(queried.is_ok());
    if let OpResult::Ok { value } = queried {
        assert_eq!(value.len(), 1);
        assert_eq!(value[0].derivation_type.as_deref(), Some("smoothed_prompt"));
        assert_eq!(value[0].subject_id.as_deref(), Some("m1"));
        assert_eq!(value[0].floor_used.as_deref(), Some("raw prompt one"));
    }
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn tc_5_3b_keeps_failed_state_and_reason_on_the_derivation_record() {
    let store = temp_store();
    let sdk = make_sdk();
    let file_path = new_thread(&store, &sdk).await;
    let db = open_raw(&file_path);
    db.prepare(
        "INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, reason) VALUES (?, ?, ?, ?, ?)",
    )
    .run(&[
        SqlParam::from("message"),
        SqlParam::from("m2"),
        SqlParam::from("tool_result_summary"),
        SqlParam::from("failed"),
        SqlParam::from("provider_unavailable"),
    ]);
    db.close();
    write(
        &sdk,
        &file_path,
        LogEntry {
            level: LogLevel::Error,
            message: "diagnostic".into(),
            derivation_type: Some("tool_result_summary".into()),
            subject_id: Some("m2".into()),
            reason: Some("provider_unavailable".into()),
            floor_used: None,
        },
    )
    .await;
    let read = open_raw(&file_path);
    let row = read
        .prepare("SELECT state, reason FROM derivation WHERE subject_id = ?")
        .get_params(&[SqlParam::from("m2")]);
    assert_eq!(
        row.as_ref().map(|m| (
            m.get("state").and_then(|v| v.as_str()),
            m.get("reason").and_then(|v| v.as_str())
        )),
        Some((Some("failed"), Some("provider_unavailable")))
    );
    read.close();
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn tc_5_4a_queries_by_actionable_fields() {
    let store = temp_store();
    let sdk = make_sdk();
    let file_path = new_thread(&store, &sdk).await;
    write(
        &sdk,
        &file_path,
        LogEntry {
            level: LogLevel::Info,
            message: "smoothed ok".into(),
            derivation_type: Some("smoothed_prompt".into()),
            subject_id: Some("m1".into()),
            reason: Some("observed".into()),
            floor_used: None,
        },
    )
    .await;
    write(
        &sdk,
        &file_path,
        LogEntry {
            level: LogLevel::Warning,
            message: "tool fallback".into(),
            derivation_type: Some("tool_result_summary".into()),
            subject_id: Some("m2".into()),
            reason: Some("not_ready".into()),
            floor_used: None,
        },
    )
    .await;
    write(
        &sdk,
        &file_path,
        LogEntry {
            level: LogLevel::Warning,
            message: "smoothed fallback".into(),
            derivation_type: Some("smoothed_prompt".into()),
            subject_id: Some("m3".into()),
            reason: Some("not_ready".into()),
            floor_used: None,
        },
    )
    .await;
    let queried = sdk
        .logging
        .query(
            ThreadRef::file_path(&file_path),
            LogQuery {
                level: Some(LogLevel::Warning),
                derivation_type: Some("smoothed_prompt".into()),
                subject_id: None,
                reason: Some("not_ready".into()),
            },
        )
        .await;
    assert!(queried.is_ok());
    if let OpResult::Ok { value } = queried {
        assert_eq!(
            value.iter().map(|e| e.message.as_str()).collect::<Vec<_>>(),
            vec!["smoothed fallback"]
        );
    }
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn tc_5_5a_contains_logging_write_failures() {
    let store = temp_store();
    let sdk = make_sdk();
    let file_path = new_thread(&store, &sdk).await;
    let db = open_raw(&file_path);
    db.exec("BEGIN IMMEDIATE;");
    db.prepare(
        "INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, content) VALUES (?, ?, ?, ?, ?)",
    )
    .run(&[
        SqlParam::from("turn"),
        SqlParam::from("t1"),
        SqlParam::from("turn_rendering"),
        SqlParam::from("ready"),
        SqlParam::from("turn content"),
    ]);
    // TS injects throwing prepare via `as never`. Induce prepare/store failure
    // with an empty sqlite file (no log table) — Phase 2 write_log fail-softs.
    let fail_path = store.dir.join("empty-fail.sqlite");
    let fail_db = open_raw(&fail_path); // creates empty db, no schema/log table
    let fail_txn = DbReadTransaction {
        db: &fail_db,
        thread_id: "logging-test".into(),
        file_path: fail_path.to_string_lossy().into_owned(),
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        write_log(
            DbTransaction::Read(&fail_txn),
            &LogEntry {
                level: LogLevel::Warning,
                message: "will be dropped".into(),
                derivation_type: None,
                subject_id: None,
                reason: None,
                floor_used: None,
            },
        );
    }));
    match result {
        Ok(()) => {
            // Phase 2 success path: write_log must not panic (fail-soft).
        }
        Err(payload) => {
            let msg = payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
                .unwrap_or_else(|| "non-string panic payload".into());
            if msg.contains("phase 2") || msg.contains("not yet implemented") {
                panic!("{msg}");
            }
            panic!("write_log panicked unexpectedly: {msg}");
        }
    }
    db.prepare(
        "INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, content) VALUES (?, ?, ?, ?, ?)",
    )
    .run(&[
        SqlParam::from("turn"),
        SqlParam::from("t1"),
        SqlParam::from("detailed_turn_compression"),
        SqlParam::from("ready"),
        SqlParam::from("projection content"),
    ]);
    db.exec("COMMIT;");
    let rows = db
        .prepare(
            "SELECT derivation_type FROM derivation WHERE subject_id = ? ORDER BY derivation_type",
        )
        .all(&[SqlParam::from("t1")]);
    assert_eq!(
        rows.iter()
            .map(|r| r
                .get("derivation_type")
                .and_then(|v| v.as_str())
                .unwrap_or(""))
            .collect::<Vec<_>>(),
        vec!["detailed_turn_compression", "turn_rendering"]
    );
    db.close();
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn tc_5_5b_keeps_log_writes_outside_caller_rollbacks_in_a_real_store() {
    let store = temp_store();
    let sdk = make_sdk();
    let file_path = new_thread(&store, &sdk).await;
    write(
        &sdk,
        &file_path,
        LogEntry {
            level: LogLevel::Info,
            message: "before rollback".into(),
            derivation_type: Some("turn_rendering".into()),
            subject_id: Some("t-rollback".into()),
            reason: Some("rollback_probe".into()),
            floor_used: None,
        },
    )
    .await;
    let db = open_raw(&file_path);
    db.exec("BEGIN IMMEDIATE;");
    db.prepare(
        "INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, content) VALUES (?, ?, ?, ?, ?)",
    )
    .run(&[
        SqlParam::from("turn"),
        SqlParam::from("t-rollback"),
        SqlParam::from("turn_rendering"),
        SqlParam::from("ready"),
        SqlParam::from("rolled back content"),
    ]);
    db.exec("ROLLBACK;");
    let derivation_rows = db
        .prepare("SELECT COUNT(*) AS n FROM derivation WHERE subject_id = ?")
        .get_params(&[SqlParam::from("t-rollback")]);
    assert_eq!(
        derivation_rows
            .as_ref()
            .and_then(|m| m.get("n"))
            .and_then(|v| v.as_i64()),
        Some(0)
    );
    db.close();
    let queried = sdk
        .logging
        .query(
            ThreadRef::file_path(&file_path),
            LogQuery {
                level: None,
                derivation_type: None,
                subject_id: Some("t-rollback".into()),
                reason: None,
            },
        )
        .await;
    assert!(queried.is_ok());
    if let OpResult::Ok { value } = queried {
        assert_eq!(
            value.iter().map(|e| e.message.as_str()).collect::<Vec<_>>(),
            vec!["before rollback"]
        );
    }
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn background_logging_write_catches_up_leftover_work_logging_query_stays_read_only() {
    let store = temp_store();
    let sdk = make_sdk();
    let file_path = new_thread(&store, &sdk).await;
    send_turn(&sdk, &file_path).await;
    assert_eq!(live_count(&file_path), 2);

    let double = create_inference_callbacks_double();
    let background = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Background,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 1000 }),
        chunk_policy: None,
        view: None,
    });
    register_test_work_handlers(&background, double.to_callbacks(), None);

    let queried = background
        .logging
        .query(
            ThreadRef::file_path(&file_path),
            LogQuery {
                level: None,
                derivation_type: None,
                subject_id: None,
                reason: None,
            },
        )
        .await;
    assert!(queried.is_ok());
    background
        .drain_settled(ThreadRef::file_path(&file_path))
        .await;
    assert_eq!(live_count(&file_path), 2);
    assert_eq!(
        read_derived_forms(&file_path)
            .iter()
            .map(|f| f.state.as_str())
            .collect::<Vec<_>>(),
        vec!["pending", "pending", "pending"]
    );

    let written = background
        .logging
        .write(
            ThreadRef::file_path(&file_path),
            LogEntry {
                level: LogLevel::Info,
                message: "background touch".into(),
                derivation_type: None,
                subject_id: None,
                reason: None,
                floor_used: None,
            },
        )
        .await;
    assert!(written.is_ok());
    background
        .drain_settled(ThreadRef::file_path(&file_path))
        .await;
    assert_eq!(live_count(&file_path), 0);
    assert_eq!(
        read_derived_forms(&file_path)
            .iter()
            .map(|f| f.state.as_str())
            .collect::<Vec<_>>(),
        vec!["ready", "ready", "ready", "ready"]
    );
    cleanup_seams();
    store.cleanup();
}
