//! SQLITE_BUSY hand-back under a real panic=abort executable.
//!
//! Built with `cargo run --profile abort-probe --example handback_abort_probe`.
//! `cargo test --profile abort-probe` does not honor panic=abort for libtest.

use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::{Db, open_database};
use lhc::shared_tech::work_queue::{ClaimAttempt, note_claim_held, release_held_claims};

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

fn main() {
    assert!(
        cfg!(panic = "abort"),
        "probe must actually compile with panic=abort"
    );

    let pid = std::process::id();
    let busy_path = std::env::temp_dir().join(format!("lhc-handback-abort-busy-{pid}.sqlite"));
    let free_path = std::env::temp_dir().join(format!("lhc-handback-abort-free-{pid}.sqlite"));
    let busy_path = busy_path.to_str().expect("busy path utf-8").to_string();
    let free_path = free_path.to_str().expect("free path utf-8").to_string();

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
    let busy_status = status(&busy, "w-busy");
    let free_status = status(&free, "w-free");
    println!("panic=abort");
    println!("released={released}");
    println!("busy={busy_status}");
    println!("free={free_status}");
    busy.close();
    free.close();
    let _ = std::fs::remove_file(&busy_path);
    let _ = std::fs::remove_file(&free_path);
    assert_eq!(released, 1);
    assert_eq!(busy_status, "claimed");
    assert_eq!(free_status, "queued");
}
