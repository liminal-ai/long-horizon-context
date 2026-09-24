//! SQLITE_BUSY hand-back under a panic=abort build.
//!
//! Invoked by `handback_abort.rs` via `cargo test --profile abort-probe`.
//! Do not use catch_unwind here: abort cannot catch it.

use std::sync::atomic::{AtomicU64, Ordering};

use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::{Db, open_database};
use lhc::shared_tech::work_queue::{ClaimAttempt, note_claim_held, release_held_claims};
use pretty_assertions::assert_eq;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn temp_path(label: &str) -> String {
    std::env::temp_dir()
        .join(format!(
            "lhc-handback-abort-{}-{}-{}.sqlite",
            label,
            std::process::id(),
            TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ))
        .to_str()
        .expect("temp path utf-8")
        .to_string()
}

fn open(path: &str) -> Db {
    match open_database(path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

fn seed_claimed(db: &Db, work_item_id: &str, payload: &str) {
    db.exec(&format!(
        "CREATE TABLE IF NOT EXISTS work_item (
            work_item_id TEXT PRIMARY KEY,
            status TEXT,
            claimed_at TEXT,
            claim_expires_at TEXT,
            payload TEXT
         );
         INSERT INTO work_item VALUES ('{work_item_id}','claimed','now','later','{payload}');"
    ));
}

fn status(db: &Db, work_item_id: &str) -> String {
    db.prepare("SELECT status FROM work_item WHERE work_item_id = ?")
        .get_params(&[lhc::shared_tech::storage::SqlParam::from(work_item_id)])
        .expect("row")
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

#[test]
fn probe_busy_handback_releases_the_other_database() {
    let busy_path = temp_path("busy");
    let free_path = temp_path("free");
    let busy = open(&busy_path);
    let free = open(&free_path);
    seed_claimed(&busy, "w-busy", r#"{"claimAttempt":1}"#);
    seed_claimed(&free, "w-free", r#"{"claimAttempt":1}"#);
    note_claim_held(
        &busy,
        &ClaimAttempt {
            work_item_id: "w-busy".into(),
            claim_attempt: Some(1),
        },
    );
    note_claim_held(
        &free,
        &ClaimAttempt {
            work_item_id: "w-free".into(),
            claim_attempt: Some(1),
        },
    );
    busy.exec("BEGIN IMMEDIATE;");
    let released = release_held_claims();
    busy.exec("ROLLBACK;");
    assert_eq!(released, 1);
    assert_eq!(status(&busy, "w-busy"), "claimed");
    assert_eq!(status(&free, "w-free"), "queued");
    busy.close();
    free.close();
    std::fs::remove_file(&busy_path).unwrap();
    std::fs::remove_file(&free_path).unwrap();
}
