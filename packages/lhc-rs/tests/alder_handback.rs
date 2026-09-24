//! Clean-exit hand-back: scoped per database, never panics.
//!
//! Alder's P2 at d2dbc055: a concurrent writer made UPDATE SQLITE_BUSY, and
//! `release_held_claims` unwound out of the SDK shutdown call. TS catches per
//! file and closes in `finally`. These tests use [`release_held_claims_for`]
//! and their own database so they run in parallel. The process-wide
//! release-all case lives in `alder_handback_release_all.rs`.

use std::sync::atomic::{AtomicU64, Ordering};

use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::{Db, open_database};
use lhc::shared_tech::work_queue::{ClaimAttempt, note_claim_held, release_held_claims_for};
use pretty_assertions::assert_eq;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn temp_path(label: &str) -> String {
    std::env::temp_dir()
        .join(format!(
            "lhc-handback-{}-{}-{}.sqlite",
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
fn clean_exit_handback_is_best_effort_under_writer_contention() {
    let path = temp_path("busy");
    let db = open(&path);
    seed_claimed(&db, "w1", r#"{"claimAttempt":1}"#);
    note_claim_held(
        &db,
        &ClaimAttempt {
            work_item_id: "w1".into(),
            claim_attempt: Some(1),
        },
    );
    db.exec("BEGIN IMMEDIATE;");
    let result = std::panic::catch_unwind(|| release_held_claims_for(&path));
    db.exec("ROLLBACK;");
    assert_eq!(status(&db, "w1"), "claimed");
    db.close();
    std::fs::remove_file(&path).unwrap();
    assert!(
        result.is_ok(),
        "best-effort handback must return rather than panic on SQLITE_BUSY"
    );
}

#[test]
fn handback_clears_expiry_but_does_not_release_a_newer_holder() {
    let path = temp_path("healthy");
    let db = open(&path);
    db.exec(
        "CREATE TABLE work_item (
            work_item_id TEXT PRIMARY KEY,
            status TEXT,
            claimed_at TEXT,
            claim_expires_at TEXT,
            payload TEXT
         );
         INSERT INTO work_item VALUES
           ('owned','claimed','now','later','{\"claimAttempt\":1,\"claimExpired\":true}'),
           ('stale','claimed','now','later','{\"claimAttempt\":2}');",
    );
    for id in ["owned", "stale"] {
        note_claim_held(
            &db,
            &ClaimAttempt {
                work_item_id: id.into(),
                claim_attempt: Some(1),
            },
        );
    }
    assert_eq!(release_held_claims_for(&path), 1);
    assert_eq!(status(&db, "owned"), "queued");
    assert_eq!(
        db.prepare("SELECT json_extract(payload, '$.claimExpired') AS expired FROM work_item WHERE work_item_id='owned'")
            .get()
            .expect("row")["expired"],
        serde_json::Value::Null
    );
    assert_eq!(status(&db, "stale"), "claimed");
    db.close();
    std::fs::remove_file(&path).unwrap();
}

#[test]
fn scoped_handback_does_not_release_another_database() {
    let kept_path = temp_path("kept");
    let released_path = temp_path("released");
    let kept = open(&kept_path);
    let released = open(&released_path);
    seed_claimed(&kept, "w-kept", r#"{"claimAttempt":1}"#);
    seed_claimed(&released, "w-released", r#"{"claimAttempt":1}"#);
    note_claim_held(
        &kept,
        &ClaimAttempt {
            work_item_id: "w-kept".into(),
            claim_attempt: Some(1),
        },
    );
    note_claim_held(
        &released,
        &ClaimAttempt {
            work_item_id: "w-released".into(),
            claim_attempt: Some(1),
        },
    );
    assert_eq!(release_held_claims_for(&released_path), 1);
    assert_eq!(status(&released, "w-released"), "queued");
    assert_eq!(status(&kept, "w-kept"), "claimed");
    assert_eq!(release_held_claims_for(&kept_path), 1);
    assert_eq!(status(&kept, "w-kept"), "queued");
    kept.close();
    released.close();
    std::fs::remove_file(&kept_path).unwrap();
    std::fs::remove_file(&released_path).unwrap();
}
