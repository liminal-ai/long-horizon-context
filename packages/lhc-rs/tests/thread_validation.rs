//! LIM-133: live, WAL-aware thread-file validation (Rust parity with
//! packages/lhc/test/thread-validation.test.ts).
//!
//! Validation opens the live file read-only — no private copy, no fingerprint,
//! no temporary directory — so uncheckpointed WAL frames are visible and a
//! concurrent append or checkpoint cannot tear identity. The caller-versus-
//! storage classification of every invalid candidate matches TypeScript
//! byte for byte.

mod fixtures;

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use fixtures::{open_raw, temp_store};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::storage::SqlParam;
use lhc::threads;
use lhc::threads::{NewThreadInput, open_thread_database};

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// SQLite's user_version lives at byte offset 60 of the main database file
/// header (4 bytes, big endian). Reading it straight off disk proves what the
/// main file alone says, with no SQLite connection involved.
fn main_file_user_version(file_path: &str) -> u32 {
    let mut file = fs::File::open(file_path).expect("open main database file");
    let mut header = [0u8; 64];
    file.read_exact(&mut header).expect("read sqlite header");
    u32::from_be_bytes([header[60], header[61], header[62], header[63]])
}

async fn new_thread_at(store: &fixtures::TempStore, name: &str) -> String {
    let file_path = path_str(&store.thread_path(Some(name)));
    let created = threads::new_thread(NewThreadInput {
        file_path: file_path.clone(),
        title: None,
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(created.is_ok(), "fixture thread creation must succeed");
    file_path
}

#[tokio::test]
async fn accepts_a_thread_whose_schema_marker_exists_only_in_the_wal() {
    let store = temp_store();
    let file_path = new_thread_at(&store, "wal-only").await;

    // Push the main file back to "not an lhc thread file" and checkpoint that
    // state into the main database.
    let reset = open_raw(&file_path);
    reset.exec("PRAGMA user_version = 0;");
    reset.close();
    assert_eq!(main_file_user_version(&file_path), 0);

    // Restore the marker on a connection that never checkpoints, and hold it
    // open so the change stays in the WAL only.
    let wal_only = open_raw(&file_path);
    wal_only.exec("PRAGMA wal_autocheckpoint = 0;");
    wal_only.exec("PRAGMA user_version = 12;");

    // The main file still says "no lhc schema version" ...
    assert_eq!(main_file_user_version(&file_path), 0);
    // ... but validation reads the live database, WAL included.
    let opened = open_thread_database(&file_path);
    assert!(
        opened.is_ok(),
        "wal-only schema marker must validate: {}",
        match &opened {
            OpResult::Err { error } => error.reason.clone(),
            OpResult::Ok { .. } => String::new(),
        }
    );
    if let OpResult::Ok { value } = opened {
        value.close();
    }
    wal_only.close();
    store.cleanup();
}

/// Number of `-wal` bytes currently on disk (0 after a TRUNCATE checkpoint).
fn wal_len(file_path: &str) -> u64 {
    fs::metadata(format!("{file_path}-wal"))
        .map(|meta| meta.len())
        .unwrap_or(0)
}

fn event_key_count(file_path: &str, key: &str) -> i64 {
    let db = open_raw(file_path);
    let count = db
        .prepare("SELECT COUNT(*) AS n FROM event WHERE idempotency_key = ?")
        .get_params(&[SqlParam::from(key)])
        .and_then(|row| row.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    db.close();
    count
}

const OVERLAP_INSERT_SQL: &str = "INSERT INTO event
     (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
     VALUES (?, 'runtime_note', ?, 'overlap', 'overlap', ?, '2020-01-01T00:00:00.000Z')";

/// Validation must stay correct while another connection actually holds an
/// append transaction open, and while a truncating checkpoint is actually
/// mid-flight — not merely between such operations.
///
/// Both phases are deterministic through SQLite's own locking; no timing
/// threshold is an acceptance fact.
///
/// Phase A holds a real `BEGIN IMMEDIATE` transaction open across the
/// validation: the writer signals only after its insert and does not commit
/// until the parent releases it. Validation therefore runs against a file with
/// an uncommitted append in flight, and must both succeed and read the
/// coherent committed snapshot (the in-flight row is not visible).
///
/// Phase B pins a read snapshot, commits a newer event into the WAL behind it,
/// and starts `wal_checkpoint(TRUNCATE)` on another connection. The checkpoint
/// cannot finish while the reader pins those frames — proven by a bounded
/// done-channel timeout used purely as synchronization — so the validation in
/// between provably runs with the checkpoint in flight. Releasing the reader
/// must let the checkpoint complete, which the zero-length WAL confirms.
#[tokio::test]
async fn survives_concurrent_appends_and_checkpoints_without_a_false_identity() {
    let store = temp_store();
    let file_path = new_thread_at(&store, "checkpoint-race").await;

    // ── Phase A — validation while an append transaction is in flight ────
    const IN_FLIGHT_ORDER: i64 = 1_000_001;
    const IN_FLIGHT_KEY: &str = "overlap:in-flight-append";

    let (inserted_tx, inserted_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let writer = {
        let file_path = file_path.clone();
        thread::spawn(move || {
            let db = open_raw(&file_path);
            db.exec("BEGIN IMMEDIATE;");
            db.prepare(OVERLAP_INSERT_SQL).run(&[
                SqlParam::from(IN_FLIGHT_ORDER),
                SqlParam::from(IN_FLIGHT_KEY),
                SqlParam::from(r#"{"text":"in-flight append"}"#),
            ]);
            // Signalled after the insert, before the commit: the transaction
            // is open and holding the write lock from here until release.
            inserted_tx.send(()).expect("signal in-flight insert");
            release_rx.recv().expect("await release");
            db.exec("COMMIT;");
            db.close();
        })
    };
    inserted_rx
        .recv()
        .expect("writer must reach its in-flight insert");

    let opened = open_thread_database(&file_path);
    assert!(
        opened.is_ok(),
        "validation during an in-flight append must not report a false thread_not_found: {}",
        match &opened {
            OpResult::Err { error } => error.reason.clone(),
            OpResult::Ok { .. } => String::new(),
        }
    );
    if let OpResult::Ok { value } = opened {
        value.close();
    }
    // Coherent snapshot: the still-uncommitted row is not visible.
    assert_eq!(event_key_count(&file_path, IN_FLIGHT_KEY), 0);

    release_tx.send(()).expect("release writer");
    writer.join().expect("writer thread");
    assert_eq!(
        event_key_count(&file_path, IN_FLIGHT_KEY),
        1,
        "the in-flight append must be durable after commit"
    );

    // ── Phase B — validation while a TRUNCATE checkpoint is in flight ────
    const CHECKPOINT_ORDER: i64 = 1_000_002;
    const CHECKPOINT_KEY: &str = "overlap:post-snapshot-append";

    // Pin a read snapshot, then commit a newer event behind it: those WAL
    // frames cannot be reclaimed while this reader stays open.
    let reader = open_raw(&file_path);
    reader.exec("BEGIN;");
    let _pinned = reader
        .prepare("SELECT COUNT(*) AS n FROM event")
        .get()
        .expect("pinned read snapshot");

    let appender = open_raw(&file_path);
    appender.prepare(OVERLAP_INSERT_SQL).run(&[
        SqlParam::from(CHECKPOINT_ORDER),
        SqlParam::from(CHECKPOINT_KEY),
        SqlParam::from(r#"{"text":"post-snapshot append"}"#),
    ]);
    appender.close();

    let (start_tx, start_rx) = mpsc::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let checkpointer = {
        let file_path = file_path.clone();
        thread::spawn(move || {
            let db = open_raw(&file_path);
            start_rx.recv().expect("await checkpoint start");
            db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
            done_tx.send(()).expect("signal checkpoint completion");
            db.close();
        })
    };
    start_tx.send(()).expect("start checkpoint");

    // Synchronization, not a benchmark: the checkpoint cannot complete while
    // the reader pins older frames, so this must not resolve.
    assert!(
        done_rx.recv_timeout(Duration::from_millis(750)).is_err(),
        "a TRUNCATE checkpoint must still be in flight while a reader pins WAL frames"
    );

    let opened = open_thread_database(&file_path);
    assert!(
        opened.is_ok(),
        "validation during an in-flight checkpoint must not report a false thread_not_found: {}",
        match &opened {
            OpResult::Err { error } => error.reason.clone(),
            OpResult::Ok { .. } => String::new(),
        }
    );
    if let OpResult::Ok { value } = opened {
        value.close();
    }

    reader.exec("ROLLBACK;");
    reader.close();
    done_rx
        .recv_timeout(Duration::from_secs(30))
        .expect("the checkpoint must complete once the pinned reader releases");
    checkpointer.join().expect("checkpointer thread");
    assert_eq!(
        wal_len(&file_path),
        0,
        "the TRUNCATE checkpoint must have completed and reset the WAL"
    );

    let after = open_thread_database(&file_path);
    assert!(
        after.is_ok(),
        "the thread must stay valid after checkpointing"
    );
    if let OpResult::Ok { value } = after {
        value.close();
    }
    assert_eq!(event_key_count(&file_path, CHECKPOINT_KEY), 1);

    store.cleanup();
}

#[tokio::test]
async fn validation_leaves_a_normal_wal_database_with_no_snapshot_beside_it() {
    let store = temp_store();
    let file_path = new_thread_at(&store, "no-copies").await;
    let opened = open_thread_database(&file_path);
    assert!(opened.is_ok());
    if let OpResult::Ok { value } = opened {
        value.close();
    }

    let mut names: Vec<String> = fs::read_dir(&store.dir)
        .expect("read temp store")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for name in &names {
        let allowed = name.starts_with("no-copies.sqlite") || name.starts_with("registry.sqlite");
        assert!(allowed, "unexpected file beside the thread: {name}");
    }
    store.cleanup();
}

// ── invalid candidate matrix (exact TS classification) ────────────────────

fn candidate_path(store: &fixtures::TempStore, name: &str) -> String {
    path_str(&store.dir.join(format!("{name}.sqlite")))
}

fn expect_caller_error(file_path: &str, detail: &str) {
    let result = open_thread_database(file_path);
    let OpResult::Err { error } = result else {
        panic!("candidate at {file_path} must be refused");
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::ThreadNotFound);
    assert_eq!(
        error.reason,
        format!("file at {file_path} exists but is not an lhc thread file ({detail})")
    );
}

#[test]
fn missing_file_is_a_storage_failure_not_a_caller_error() {
    let store = temp_store();
    let file_path = candidate_path(&store, "absent");
    let result = open_thread_database(&file_path);
    let OpResult::Err { error } = result else {
        panic!("absent candidate must be refused");
    };
    assert_eq!(error.error_class, ErrorClass::SystemError);
    assert_eq!(error.code, ErrorCode::StorageFailure);
    assert_eq!(
        error.reason,
        "could not inspect thread file: unable to open database file"
    );
    store.cleanup();
}

#[test]
fn non_database_file_is_a_caller_error() {
    let store = temp_store();
    let file_path = candidate_path(&store, "non-database");
    fs::write(
        &file_path,
        "this is definitely not a sqlite database file at all",
    )
    .expect("write candidate");
    expect_caller_error(&file_path, "file is not a database");
    store.cleanup();
}

#[test]
fn schema_zero_is_a_caller_error() {
    let store = temp_store();
    let file_path = candidate_path(&store, "schema-zero");
    let db = open_raw(&file_path);
    db.exec("CREATE TABLE unrelated (x);");
    db.close();
    expect_caller_error(&file_path, "no lhc schema version");
    store.cleanup();
}

#[test]
fn unsupported_schema_is_a_caller_error_naming_the_range() {
    let store = temp_store();
    let file_path = candidate_path(&store, "unsupported-schema");
    let db = open_raw(&file_path);
    db.exec("CREATE TABLE unrelated (x);");
    db.exec("PRAGMA user_version = 99;");
    db.close();
    expect_caller_error(&file_path, "schema version 99, expected 1..12");
    store.cleanup();
}

#[test]
fn missing_metadata_table_is_a_caller_error() {
    let store = temp_store();
    let file_path = candidate_path(&store, "missing-table");
    let db = open_raw(&file_path);
    db.exec("CREATE TABLE unrelated (x);");
    db.exec("PRAGMA user_version = 12;");
    db.close();
    expect_caller_error(&file_path, "no thread_metadata table");
    store.cleanup();
}

#[test]
fn missing_metadata_row_is_a_caller_error() {
    let store = temp_store();
    let file_path = candidate_path(&store, "missing-row");
    let db = open_raw(&file_path);
    db.exec("CREATE TABLE thread_metadata (id INTEGER PRIMARY KEY, thread_id TEXT);");
    db.exec("PRAGMA user_version = 12;");
    db.close();
    expect_caller_error(&file_path, "no thread metadata row");
    store.cleanup();
}

#[test]
fn a_directory_in_the_threads_place_is_a_storage_failure() {
    let store = temp_store();
    let file_path = candidate_path(&store, "a-directory");
    fs::create_dir(&file_path).expect("create directory candidate");
    let result = open_thread_database(&file_path);
    let OpResult::Err { error } = result else {
        panic!("a directory must be refused");
    };
    assert_eq!(error.error_class, ErrorClass::SystemError);
    assert_eq!(error.code, ErrorCode::StorageFailure);
    store.cleanup();
}

// ── journal mode promotion ────────────────────────────────────────────────

fn journal_mode(db: &lhc::shared_tech::storage::Db) -> String {
    db.prepare("PRAGMA journal_mode")
        .get()
        .and_then(|row| {
            row.get("journal_mode")
                .and_then(|v| v.as_str())
                .map(str::to_ascii_lowercase)
        })
        .expect("journal_mode")
}

#[test]
fn promotes_a_non_wal_file_once_and_leaves_an_already_wal_file_alone() {
    let store = temp_store();
    let file_path = path_str(&store.thread_path(Some("promote")));

    // Seed a delete-journal database without going through open_database.
    {
        let seed = open_raw(&file_path);
        seed.exec("PRAGMA journal_mode = DELETE;");
        seed.exec("CREATE TABLE probe (x);");
        assert_eq!(journal_mode(&seed), "delete");
        seed.close();
    }

    let first = open_raw(&file_path);
    assert_eq!(journal_mode(&first), "wal");
    first.close();

    // Subsequent opens read the mode and skip the write form; the file stays
    // WAL and openers keep succeeding.
    for _ in 0..5 {
        let again = open_raw(&file_path);
        assert_eq!(journal_mode(&again), "wal");
        again.close();
    }
    store.cleanup();
}

#[tokio::test]
async fn opens_an_already_wal_thread_while_another_connection_holds_the_write_lock() {
    let store = temp_store();
    let file_path = new_thread_at(&store, "held-write-lock").await;
    let writer = open_raw(&file_path);
    writer.exec("BEGIN IMMEDIATE;");
    let opened = open_raw(&file_path);
    assert_eq!(journal_mode(&opened), "wal");
    opened.close();
    writer.exec("ROLLBACK;");
    writer.close();
    store.cleanup();
}

// ── structural: the validation opener cannot copy or stage anything ───────

#[test]
fn validation_opener_is_live_read_only_with_no_copy_or_temp_root() {
    let src = include_str!("../src/shared_tech/storage.rs");
    let start = src
        .find("pub(crate) fn open_database_for_thread_validation(path: &str)")
        .expect("validation opener present");
    let body = &src[start..];
    let end = body.find("\n}\n").expect("opener body ends");
    let body = &body[..end];

    assert!(
        body.contains("?mode=ro"),
        "validation must open the live file read-only"
    );
    assert!(
        !body.contains("immutable=1"),
        "validation must stay WAL-aware (no immutable=1)"
    );
    for banned in [
        "lhc-thread-validate",
        "fs::copy",
        "create_dir",
        "temp_dir",
        "fingerprint",
        "hash",
    ] {
        assert!(
            !body.contains(banned),
            "validation opener must not reference {banned}"
        );
    }

    // Nothing anywhere in the storage seam stages a private snapshot any more.
    for banned in [
        "lhc-thread-validate",
        "ThreadValidationDb",
        "VALIDATION_TEMP_SEQ",
        "copy_coherent_validation_snapshot",
    ] {
        assert!(
            !src.contains(banned),
            "storage.rs must not reference {banned}"
        );
    }

    // The immutable peek seam is untouched and still distinct.
    let peek = src
        .find("pub(crate) fn open_database_read_only(path: &str)")
        .expect("peek opener present");
    assert!(src[peek..].contains("immutable=1"));
}

#[test]
fn open_database_checks_journal_mode_before_setting_it() {
    let src = include_str!("../src/shared_tech/storage.rs");
    let start = src
        .find("pub fn open_database(path: &str)")
        .expect("open_database present");
    let body = &src[start..];
    let query = body
        .find(".prepare(\"PRAGMA journal_mode\")")
        .expect("journal_mode query form");
    let set = body
        .find("db.exec(\"PRAGMA journal_mode = WAL;\")")
        .expect("journal_mode write form");
    assert!(
        query < set,
        "open_database must read the journal mode before promoting it"
    );
    assert!(
        body[..set].contains("if mode != \"wal\""),
        "the write form must be guarded by the already-WAL check"
    );
}

#[test]
fn no_validation_snapshot_root_exists_for_this_process() {
    let prefix = format!("lhc-thread-validate-{}-", std::process::id());
    let leaked: Vec<PathBuf> = fs::read_dir(std::env::temp_dir())
        .expect("read temp dir")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix))
        })
        .collect();
    assert!(
        leaked.is_empty(),
        "this process created validation snapshot roots: {leaked:?}"
    );
}
