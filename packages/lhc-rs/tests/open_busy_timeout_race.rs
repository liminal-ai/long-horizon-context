//! R6: parallel openers must not fail with instant SQLITE_BUSY.
//!
//! `open_database` sets `busy_timeout` before `journal_mode=WAL` (TS 1687d4d).
//! WAL init takes a brief write lock; without a timeout first, concurrent
//! openers race to SQLITE_BUSY. This test hammers concurrent opens on one path.

mod fixtures;

use std::sync::{Arc, Barrier};
use std::thread;

use fixtures::temp_store;
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::open_database;

#[test]
fn parallel_open_database_does_not_fail_with_instant_busy() {
    let store = temp_store();
    let path = store
        .dir
        .join("race-open.sqlite")
        .to_string_lossy()
        .into_owned();

    // Seed the file so every worker opens an existing path (WAL coordination
    // is the interesting race — concurrent first-create is a different path).
    {
        let db = match open_database(&path) {
            OpResult::Ok { value } => value,
            OpResult::Err { error } => panic!("seed open failed: {}", error.reason),
        };
        db.exec("CREATE TABLE IF NOT EXISTS race_probe (id INTEGER PRIMARY KEY);");
        db.close();
    }

    const N: usize = 16;
    let barrier = Arc::new(Barrier::new(N));
    let path = Arc::new(path);
    let mut handles = Vec::with_capacity(N);

    for i in 0..N {
        let barrier = Arc::clone(&barrier);
        let path = Arc::clone(&path);
        handles.push(thread::spawn(move || {
            barrier.wait();
            // Several rapid opens per worker — mirrors two tools + capture
            // openers colliding around WAL init.
            for round in 0..8 {
                match open_database(path.as_str()) {
                    OpResult::Ok { value: db } => {
                        // Touch the connection so open is fully live.
                        let _ = db.prepare("SELECT 1 AS one").get();
                        db.close();
                    }
                    OpResult::Err { error } => {
                        panic!(
                            "worker {i} round {round}: open_database failed: {} \
                             (busy_timeout must precede journal_mode=WAL)",
                            error.reason
                        );
                    }
                }
            }
        }));
    }

    for (i, handle) in handles.into_iter().enumerate() {
        handle
            .join()
            .unwrap_or_else(|_| panic!("worker {i} panicked"));
    }
}

#[test]
fn open_database_applies_busy_timeout_before_wal() {
    // Structural contract: the only writable pragma site must set timeout first.
    // Race test above exercises the live path; this guards against reorder.
    let src = include_str!("../src/shared_tech/storage.rs");
    let fn_start = src
        .find("pub fn open_database(path: &str)")
        .expect("open_database present");
    let body = &src[fn_start..];
    let busy = body
        .find("PRAGMA busy_timeout = 5000;")
        .expect("busy_timeout pragma");
    let wal = body
        .find("PRAGMA journal_mode = WAL;")
        .expect("journal_mode pragma");
    assert!(
        busy < wal,
        "busy_timeout must appear before journal_mode=WAL in open_database"
    );
}
