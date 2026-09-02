//! LIM-133: normal SDK operations create no validation snapshot root and do no
//! file-size-proportional work.
//!
//! The old validation opener staged a private main+WAL copy under
//! `$TMPDIR/lhc-thread-validate-<pid>-<seq>` for *every* thread validation, so
//! a crash-killed process leaked the whole database. These tests prove the
//! copy is gone: structurally (no snapshot root for this process or for a
//! SIGKILLed child) and algorithmically (`/proc/self/io` byte counters stay
//! flat while the thread file is large).

mod fixtures;

use std::path::{Path, PathBuf};
use std::time::Duration;

use fixtures::{open_raw, temp_store};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::SqlParam;
use lhc::threads;
use lhc::threads::{NewThreadInput, open_thread_database};

const CHILD_THREAD_ENV: &str = "LHC_LIM133_HARD_KILL_CHILD_THREAD";

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Validation snapshot roots owned by one process id. Scoped by pid on
/// purpose: the shared temp directory may still hold roots leaked by older
/// binaries, and this story does not clean those up (LIM-139 owns that).
fn snapshot_roots_for(pid: u32) -> Vec<PathBuf> {
    let prefix = format!("lhc-thread-validate-{pid}-");
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix))
        })
        .collect()
}

async fn seeded_thread(store: &fixtures::TempStore, name: &str) -> String {
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
async fn normal_operations_create_no_validation_snapshot_root() {
    let store = temp_store();
    let file_path = seeded_thread(&store, "no-snapshot").await;
    let pid = std::process::id();
    let before = snapshot_roots_for(pid).len();

    for _ in 0..10 {
        let opened = open_thread_database(&file_path);
        assert!(opened.is_ok());
        if let OpResult::Ok { value } = opened {
            value.close();
        }
        let info = threads::info(lhc::ThreadRef::file_path(file_path.clone())).await;
        assert!(info.is_ok());
    }

    let after = snapshot_roots_for(pid);
    assert_eq!(
        after.len(),
        before,
        "normal operations created validation snapshot roots: {after:?}"
    );
    store.cleanup();
}

/// Child half of [`hard_killed_child_leaves_no_validation_snapshot`]. A no-op
/// pass in ordinary runs; only the spawned child sets the env var.
#[test]
fn hard_kill_child_helper() {
    let Ok(file_path) = std::env::var(CHILD_THREAD_ENV) else {
        return;
    };
    // Validate in a tight loop until the parent kills this process.
    loop {
        let opened = open_thread_database(&file_path);
        if let OpResult::Ok { value } = opened {
            value.close();
        }
    }
}

#[tokio::test]
async fn hard_killed_child_leaves_no_validation_snapshot() {
    let store = temp_store();
    let file_path = seeded_thread(&store, "hard-kill").await;

    let exe = std::env::current_exe().expect("test binary path");
    let mut child = std::process::Command::new(exe)
        .args([
            "hard_kill_child_helper",
            "--exact",
            "--nocapture",
            "--test-threads",
            "1",
        ])
        .env(CHILD_THREAD_ENV, &file_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn validation child");
    let child_pid = child.id();

    // Let the child get well into its validation loop, then kill it outright
    // (Child::kill is SIGKILL on unix — no unwinding, no Drop, no cleanup).
    std::thread::sleep(Duration::from_millis(750));
    child.kill().expect("kill validation child");
    let _ = child.wait();

    let leaked = snapshot_roots_for(child_pid);
    assert!(
        leaked.is_empty(),
        "a hard-killed validating process leaked snapshot roots: {leaked:?}"
    );
    store.cleanup();
}

// ── algorithmic byte proof (Linux corroboration; timing is not asserted) ──

#[cfg(target_os = "linux")]
fn proc_io_counter(field: &str) -> u64 {
    let text = std::fs::read_to_string("/proc/self/io").expect("read /proc/self/io");
    for line in text.lines() {
        if let Some(value) = line
            .strip_prefix(field)
            .and_then(|rest| rest.strip_prefix(": "))
        {
            return value.trim().parse().expect("io counter");
        }
    }
    panic!("field {field} missing from /proc/self/io");
}

/// Pads the thread file with large event payloads so a whole-file copy would
/// be unmistakable in the byte counters.
fn grow_thread_file(file_path: &str, rows: usize, payload_bytes: usize) {
    let db = open_raw(file_path);
    let filler = "x".repeat(payload_bytes);
    db.exec("BEGIN IMMEDIATE;");
    for index in 0..rows {
        db.prepare(
            "INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
             VALUES (?, 'runtime_note', ?, 'bulk', 'bulk', ?, '2020-01-01T00:00:00.000Z')",
        )
        .run(&[
            SqlParam::from(1_000_000 + index as i64),
            SqlParam::from(format!("bulk:{index:06}")),
            SqlParam::from(filler.as_str()),
        ]);
    }
    db.exec("COMMIT;");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.close();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn normal_open_reads_bounded_bytes_not_the_whole_file() {
    let store = temp_store();
    let file_path = seeded_thread(&store, "large").await;
    grow_thread_file(&file_path, 256, 64 * 1024);

    let size = std::fs::metadata(&file_path)
        .expect("thread file size")
        .len();
    assert!(
        size >= 16 * 1024 * 1024,
        "fixture must be large enough to make a copy obvious, got {size} bytes"
    );

    // One warm-up open so page cache / schema parsing is not counted.
    if let OpResult::Ok { value } = open_thread_database(&file_path) {
        value.close();
    }

    let read_before = proc_io_counter("rchar");
    let write_before = proc_io_counter("wchar");
    for _ in 0..3 {
        let opened = open_thread_database(&file_path);
        assert!(opened.is_ok());
        if let OpResult::Ok { value } = opened {
            value.close();
        }
    }
    let read_delta = proc_io_counter("rchar") - read_before;
    let write_delta = proc_io_counter("wchar") - write_before;

    // A copying validator would move at least one file length per open.
    let budget = 1024 * 1024;
    assert!(
        read_delta < budget,
        "three opens read {read_delta} bytes from a {size}-byte thread — that is file-size proportional"
    );
    assert!(
        write_delta < budget,
        "three opens wrote {write_delta} bytes from a {size}-byte thread — that is file-size proportional"
    );
    store.cleanup();
}
