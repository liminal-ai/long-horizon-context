//! LIM-133: current-schema opens are read-mostly (Rust parity with
//! packages/lhc/test/read-mostly-open.test.ts).
//!
//! The queued turn_derivation repair is a recurring mixed-version crash-window
//! repair, not a once-only migration, so it keeps running on every open — but
//! only after a read-only predicate says there is something to repair. With no
//! matching work the open takes no write transaction at all.
//!
//! `PRAGMA query_only = ON` is the instrument: it turns any write attempt,
//! `BEGIN IMMEDIATE` included, into an immediate "attempt to write a readonly
//! database" error. A migration pass that completes under query_only provably
//! wrote nothing.

mod fixtures;

use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;

use fixtures::{conversation_turn, open_raw, temp_store};
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::thread_migrate::migrate_thread_schema;
use lhc::threads::{NewThreadInput, open_thread_database};
use lhc::{OpResult, ThreadRef, intake_stream, threads};

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Runs the current-schema migration under a connection that cannot write.
/// Returns true when the pass attempted a write transaction.
fn migrate_under_query_only(file_path: &str) -> bool {
    let db = open_raw(file_path);
    db.exec("PRAGMA query_only = ON;");
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
        migrate_thread_schema(&db);
    }));
    db.close();
    match outcome {
        Ok(()) => false,
        Err(panic) => {
            let detail = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_string()))
                .unwrap_or_default();
            assert!(
                detail.contains("readonly database"),
                "unexpected migration failure: {detail}"
            );
            true
        }
    }
}

async fn thread_with_one_turn(store: &fixtures::TempStore, name: &str) -> String {
    let file_path = path_str(&store.thread_path(Some(name)));
    let created = threads::new_thread(NewThreadInput {
        file_path: file_path.clone(),
        title: None,
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(created.is_ok(), "fixture thread creation must succeed");
    let recorded = intake_stream::message_events(
        ThreadRef::file_path(file_path.clone()),
        &conversation_turn(),
    )
    .await;
    assert!(recorded.is_ok(), "fixture intake must succeed");
    file_path
}

/// Rewrites the queued work item back to the pre-rewire (legacy) shape.
fn poison_turn_derivation_item(file_path: &str, status: &str, payload_override: Option<&str>) {
    let db = open_raw(file_path);
    let row = db
        .prepare(
            "SELECT work_item_id, payload FROM work_item WHERE kind = 'turn_derivation' LIMIT 1",
        )
        .get()
        .expect("fixture invariant: a turn_derivation work item must exist");
    let existing: serde_json::Value = serde_json::from_str(
        row.get("payload")
            .and_then(|v| v.as_str())
            .expect("payload string"),
    )
    .expect("payload json");
    let source_version = existing
        .get("sourceVersion")
        .and_then(|v| v.as_i64())
        .unwrap_or(1);
    let legacy = js_json_stringify(&serde_json::json!({
        "sourceVersion": source_version,
        "operation": existing.get("operation").cloned().unwrap_or(serde_json::Value::Null),
        "derivations": [
            {"subjectKind": "turn", "subjectId": "t1", "derivationType": "turn_rendering"},
            {"subjectKind": "turn", "subjectId": "t1", "derivationType": "detailed_turn_compression"},
        ],
    }));
    let payload = payload_override.unwrap_or(legacy.as_str());
    db.prepare("UPDATE work_item SET payload = ?, status = ? WHERE kind = 'turn_derivation'")
        .run(&[SqlParam::from(payload), SqlParam::from(status)]);
    db.prepare("DELETE FROM derivation WHERE derivation_type = 'pre_detailed_assembly'")
        .run(&[]);
    db.close();
}

fn assembly_row_count(file_path: &str, turn_id: &str) -> i64 {
    let db = open_raw(file_path);
    let count = db
        .prepare(
            "SELECT COUNT(*) AS n FROM derivation
             WHERE subject_kind = 'turn' AND subject_id = ? AND derivation_type = 'pre_detailed_assembly'",
        )
        .get_params(&[SqlParam::from(turn_id)])
        .and_then(|row| row.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    db.close();
    count
}

fn derivation_types_of(file_path: &str, work_item_id: &str) -> Vec<String> {
    let db = open_raw(file_path);
    let payload = db
        .prepare("SELECT payload FROM work_item WHERE work_item_id = ?")
        .get_params(&[SqlParam::from(work_item_id)])
        .and_then(|row| {
            row.get("payload")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .expect("work item payload");
    db.close();
    let parsed: serde_json::Value = serde_json::from_str(&payload).expect("payload json");
    parsed
        .get("derivations")
        .and_then(|v| v.as_array())
        .expect("derivations array")
        .iter()
        .map(|target| {
            target
                .get("derivationType")
                .and_then(|v| v.as_str())
                .expect("derivationType")
                .to_string()
        })
        .collect()
}

fn work_item_status(file_path: &str, work_item_id: &str) -> String {
    let db = open_raw(file_path);
    let status = db
        .prepare("SELECT status FROM work_item WHERE work_item_id = ?")
        .get_params(&[SqlParam::from(work_item_id)])
        .and_then(|row| {
            row.get("status")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .expect("work item status");
    db.close();
    status
}

fn open_and_close(file_path: &str) {
    let opened = open_thread_database(file_path);
    assert!(
        opened.is_ok(),
        "open must succeed: {}",
        match &opened {
            OpResult::Err { error } => error.reason.clone(),
            OpResult::Ok { .. } => String::new(),
        }
    );
    if let OpResult::Ok { value } = opened {
        value.close();
    }
}

// ── no repairable work: no write transaction ─────────────────────────────

#[tokio::test]
async fn a_freshly_created_thread_takes_no_write_transaction_on_open() {
    let store = temp_store();
    let file_path = path_str(&store.thread_path(Some("fresh")));
    let created = threads::new_thread(NewThreadInput {
        file_path: file_path.clone(),
        title: None,
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(created.is_ok());
    assert!(!migrate_under_query_only(&file_path));
    store.cleanup();
}

#[tokio::test]
async fn ordinary_queued_derivation_work_takes_no_write_transaction_on_open() {
    let store = temp_store();
    let file_path = thread_with_one_turn(&store, "ordinary").await;
    assert!(!migrate_under_query_only(&file_path));
    store.cleanup();
}

#[tokio::test]
async fn a_legacy_shaped_item_that_is_already_done_takes_no_write_transaction() {
    let store = temp_store();
    let file_path = thread_with_one_turn(&store, "done-item").await;
    poison_turn_derivation_item(&file_path, "done", None);
    assert!(!migrate_under_query_only(&file_path));
    store.cleanup();
}

#[tokio::test]
async fn opens_normally_while_another_connection_holds_the_write_lock() {
    let store = temp_store();
    let file_path = thread_with_one_turn(&store, "held-lock").await;
    let writer = open_raw(&file_path);
    writer.exec("BEGIN IMMEDIATE;");
    open_and_close(&file_path);
    writer.exec("ROLLBACK;");
    writer.close();
    store.cleanup();
}

// ── matching legacy work: repair exactly once ────────────────────────────

#[tokio::test]
async fn repairs_a_queued_row_exactly_once_and_then_stops_writing() {
    let store = temp_store();
    let file_path = thread_with_one_turn(&store, "queued-repair").await;
    poison_turn_derivation_item(&file_path, "queued", None);

    // The predicate says there is work: the open takes the write transaction.
    assert!(migrate_under_query_only(&file_path));

    open_and_close(&file_path);

    assert_eq!(assembly_row_count(&file_path, "t1"), 1);
    assert_eq!(
        derivation_types_of(&file_path, "w-t1-turn_derivation-v1"),
        vec![
            "turn_rendering".to_string(),
            "pre_detailed_assembly".to_string()
        ]
    );

    // Second and third opens find nothing to do and write nothing.
    assert!(!migrate_under_query_only(&file_path));
    open_and_close(&file_path);
    assert_eq!(assembly_row_count(&file_path, "t1"), 1);
    assert!(!migrate_under_query_only(&file_path));
    store.cleanup();
}

#[tokio::test]
async fn repairs_a_claimed_row_the_same_way() {
    let store = temp_store();
    let file_path = thread_with_one_turn(&store, "claimed-repair").await;
    poison_turn_derivation_item(&file_path, "claimed", None);
    assert!(migrate_under_query_only(&file_path));
    open_and_close(&file_path);
    assert_eq!(assembly_row_count(&file_path, "t1"), 1);
    assert_eq!(
        work_item_status(&file_path, "w-t1-turn_derivation-v1"),
        "claimed"
    );
    assert!(!migrate_under_query_only(&file_path));
    store.cleanup();
}

#[tokio::test]
async fn seeds_only_the_matching_item_when_matching_and_non_matching_rows_are_mixed() {
    let store = temp_store();
    let file_path = thread_with_one_turn(&store, "mixed").await;

    // A second turn's item stays in the current shape with its assembly row.
    {
        let db = open_raw(&file_path);
        db.exec(
            "INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order)
             VALUES ('t9', 9, 'open', 0)",
        );
        let current = js_json_stringify(&serde_json::json!({
            "sourceVersion": 1,
            "operation": "derive",
            "derivations": [
                {"subjectKind": "turn", "subjectId": "t9", "derivationType": "turn_rendering"},
                {"subjectKind": "turn", "subjectId": "t9", "derivationType": "pre_detailed_assembly"},
            ],
        }));
        db.prepare(
            "INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
             VALUES ('w-t9', 'turns', 'turn_derivation', ?, 'queued', '2020-01-01T00:00:00.000Z', ?)",
        )
        .run(&[
            SqlParam::from(r#"{"turnId":"t9"}"#),
            SqlParam::from(current.as_str()),
        ]);
        db.exec(
            "INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
             VALUES ('turn', 't9', 'pre_detailed_assembly', 'pending', 1)",
        );
        db.close();
    }
    poison_turn_derivation_item(&file_path, "queued", None);

    open_and_close(&file_path);

    assert_eq!(assembly_row_count(&file_path, "t1"), 1);
    assert_eq!(assembly_row_count(&file_path, "t9"), 1);
    // t9's payload was already current: it is untouched.
    assert_eq!(
        derivation_types_of(&file_path, "w-t9"),
        vec![
            "turn_rendering".to_string(),
            "pre_detailed_assembly".to_string()
        ]
    );
    assert!(!migrate_under_query_only(&file_path));
    store.cleanup();
}

/// Two openers must contend for real on the same pending legacy repair.
///
/// A third connection pre-holds `BEGIN IMMEDIATE`, so neither opener can take
/// the repair transaction. Each entrant first reads, from its own connection,
/// the exact state the production read-only predicate reads (assembly row
/// absent, payload still legacy), then all three threads meet at one `Barrier`
/// immediately before `open_thread_database`, so both entrants are released
/// toward the open together with the write lock still held.
///
/// What this proves: two simultaneous contended repair attempts against the
/// same pending row both terminate successfully, and the file converges to
/// exactly one repaired payload and one assembly row with no repair work left.
/// It does not observe the losing opener's inner recheck directly — that the
/// second evaluation happens *inside* the transaction is pinned structurally by
/// `the_current_schema_path_probes_before_it_locks`.
#[tokio::test]
async fn keeps_the_repair_idempotent_when_two_openers_race_the_same_file() {
    let store = temp_store();
    let file_path = thread_with_one_turn(&store, "race").await;
    poison_turn_derivation_item(&file_path, "queued", None);

    // Pre-held write lock: reads (validation, the outer repair predicate) still
    // pass under WAL, but no opener can acquire the repair transaction.
    let lock_holder = open_raw(&file_path);
    lock_holder.exec("BEGIN IMMEDIATE;");

    // Two entrants plus this thread: nobody opens until everyone has observed
    // the pending state.
    let released = Arc::new(Barrier::new(3));
    let completed = Arc::new(AtomicU64::new(0));

    let entrants: Vec<_> = (0..2)
        .map(|entrant| {
            let file_path = file_path.clone();
            let released = Arc::clone(&released);
            let completed = Arc::clone(&completed);
            thread::spawn(move || {
                // The same facts the production predicate reads, from this
                // thread's own connection: repair is still outstanding here.
                assert_eq!(
                    assembly_row_count(&file_path, "t1"),
                    0,
                    "entrant {entrant}: repair must still be pending on entry"
                );
                assert!(
                    derivation_types_of(&file_path, "w-t1-turn_derivation-v1")
                        .contains(&"detailed_turn_compression".to_string()),
                    "entrant {entrant}: payload must still be legacy on entry"
                );

                released.wait();
                let opened = open_thread_database(&file_path);
                completed.fetch_add(1, Ordering::SeqCst);
                assert!(
                    opened.is_ok(),
                    "entrant {entrant}: contended open must succeed: {}",
                    match &opened {
                        OpResult::Err { error } => error.reason.clone(),
                        OpResult::Ok { .. } => String::new(),
                    }
                );
                if let OpResult::Ok { value } = opened {
                    value.close();
                }
            })
        })
        .collect();

    released.wait();
    // Both entrants are released into the open path together, and the held
    // write lock means neither can have repaired anything yet.
    assert_eq!(
        completed.load(Ordering::SeqCst),
        0,
        "the held write lock must keep both entrants inside the open path"
    );
    assert_eq!(assembly_row_count(&file_path, "t1"), 0);

    lock_holder.exec("ROLLBACK;");
    lock_holder.close();

    for entrant in entrants {
        entrant.join().expect("entrant thread");
    }

    // Exactly one repaired state, and nothing left to repair.
    assert_eq!(assembly_row_count(&file_path, "t1"), 1);
    assert_eq!(
        derivation_types_of(&file_path, "w-t1-turn_derivation-v1"),
        vec![
            "turn_rendering".to_string(),
            "pre_detailed_assembly".to_string()
        ]
    );
    assert!(!migrate_under_query_only(&file_path));
    store.cleanup();
}

#[tokio::test]
async fn a_malformed_legacy_payload_stays_a_storage_failure() {
    let store = temp_store();
    let file_path = thread_with_one_turn(&store, "malformed").await;
    poison_turn_derivation_item(&file_path, "queued", Some("{ not json"));
    let opened = open_thread_database(&file_path);
    let OpResult::Err { error } = opened else {
        panic!("a malformed payload must fail the open");
    };
    assert_eq!(
        error.error_class,
        lhc::shared_tech::errors::ErrorClass::SystemError
    );
    assert_eq!(
        error.code,
        lhc::shared_tech::errors::ErrorCode::StorageFailure
    );
    assert!(error.reason.contains("could not open thread file"));
    store.cleanup();
}

#[test]
fn the_current_schema_path_probes_before_it_locks() {
    let src = include_str!("../src/shared_tech/thread_migrate.rs");
    let start = src
        .find("fn run_queued_turn_derivation_migration(db: &Db)")
        .expect("current-schema repair entry point");
    let body = &src[start..];
    let end = body.find("\n}\n").expect("body ends");
    let body = &body[..end];
    let probe = body
        .find("if !queued_turn_derivation_repair_pending(db)")
        .expect("read-only predicate guard");
    let begin = body
        .find("db.exec(\"BEGIN IMMEDIATE;\")")
        .expect("write transaction");
    assert!(
        probe < begin,
        "the predicate must gate the write transaction"
    );
    assert!(
        body[begin..].contains("if queued_turn_derivation_repair_pending(db)"),
        "the predicate must run again inside the transaction"
    );
}
