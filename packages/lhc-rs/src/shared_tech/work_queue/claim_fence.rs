//! Claim-attempt fencing and clean-exit handback.
//!
//! Ported from packages/lhc/src/shared-tech/work-queue/claim-fence.ts.
//! Node `process.once("exit")` is not used. Hosts call
//! [`release_held_claims_for`] when one thread closes or unloads, and
//! [`release_held_claims`] once at coordinated process shutdown.
//!
//! Rust-only scoped call: Codex serves many thread databases in one process,
//! so a process-wide take on thread close would requeue other live threads'
//! in-flight claims. TS keeps exit-only `releaseHeldClaims` (cc-lhc is one
//! thread per process). Fencing and the two-expiry policy are unchanged.
//!
//! Hand-back sqlite uses crate-private fallible storage (`open_database_for_handback`,
//! `exec_fallible` / `prepare_fallible` / `run_fallible` / `close_fallible`),
//! not the panicking adapter and not `catch_unwind`.

use std::collections::HashMap;
use std::sync::Mutex;

use super::super::storage::{Db, SqlParam, open_database_for_handback};

/// WHERE clause naming one claim attempt; bind with [`claim_params`].
pub const OWNED_CLAIM_SQL: &str =
    "work_item_id = ? AND status = 'claimed' AND json_extract(payload, '$.claimAttempt') IS ?";

/// The claim UPDATE's SET fragment: take the claim and start a new attempt.
pub const TAKE_CLAIM_SET_SQL: &str = "status = 'claimed', claimed_at = ?, claim_expires_at = ?,
  payload = json_set(payload, '$.claimAttempt', COALESCE(json_extract(payload, '$.claimAttempt'), 0) + 1)";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimAttempt {
    pub work_item_id: String,
    pub claim_attempt: Option<i64>,
}

pub fn claim_params(claim: &ClaimAttempt) -> [SqlParam; 2] {
    [
        SqlParam::from(claim.work_item_id.as_str()),
        match claim.claim_attempt {
            Some(n) => SqlParam::I64(n),
            None => SqlParam::Null,
        },
    ]
}

struct HeldClaim {
    path: String,
    work_item_id: String,
    claim_attempt: Option<i64>,
}

fn held_key(path: &str, claim: &ClaimAttempt) -> String {
    format!(
        "{}\u{0000}{}\u{0000}{}",
        path,
        claim.work_item_id,
        claim
            .claim_attempt
            .map(|n| n.to_string())
            .unwrap_or_default()
    )
}

static HELD: Mutex<Option<HashMap<String, HeldClaim>>> = Mutex::new(None);

fn held_map() -> std::sync::MutexGuard<'static, Option<HashMap<String, HeldClaim>>> {
    HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Record a claim this process now holds (no-op for a handle without a known path).
pub fn note_claim_held(db: &Db, claim: &ClaimAttempt) {
    let path = db.path();
    if path.is_empty() {
        return;
    }
    let key = held_key(path, claim);
    let mut guard = held_map();
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(
        key,
        HeldClaim {
            path: path.to_string(),
            work_item_id: claim.work_item_id.clone(),
            claim_attempt: claim.claim_attempt,
        },
    );
}

/// The claim is consumed or lost; this process no longer holds it.
pub fn note_claim_done(db: &Db, claim: &ClaimAttempt) {
    let path = db.path();
    if path.is_empty() {
        return;
    }
    let key = held_key(path, claim);
    if let Some(map) = held_map().as_mut() {
        map.remove(&key);
    }
}

fn warn_handback(path: &str, detail: &str) {
    eprintln!("lhc: release_held_claims failed for {path}: {detail} (claim left to expire)");
}

fn release_taken_claims(path: &str, list: Vec<(String, Option<i64>)>) -> i64 {
    if list.is_empty() || !std::path::Path::new(path).exists() {
        return 0;
    }
    let db = match open_database_for_handback(path) {
        Ok(db) => db,
        Err(detail) => {
            warn_handback(path, &detail);
            return 0;
        }
    };
    let released = match release_claims_on_db(&db, list) {
        Ok(n) => n,
        Err(detail) => {
            warn_handback(path, &detail);
            0
        }
    };
    if let Err(detail) = db.close_fallible() {
        warn_handback(path, &detail);
    }
    released
}

fn release_claims_on_db(db: &Db, list: Vec<(String, Option<i64>)>) -> Result<i64, String> {
    db.exec_fallible("PRAGMA busy_timeout = 2000;")?;
    let sql = format!(
        "UPDATE work_item SET status = 'queued', claimed_at = NULL, claim_expires_at = NULL,
           payload = json_remove(payload, '$.claimExpired')
         WHERE {OWNED_CLAIM_SQL}"
    );
    let stmt = db.prepare_fallible(&sql)?;
    let mut n = 0i64;
    for (work_item_id, claim_attempt) in list {
        n += stmt
            .run_fallible(&claim_params(&ClaimAttempt {
                work_item_id,
                claim_attempt,
            }))?
            .changes;
    }
    Ok(n)
}

/// Hand claims held on one thread database back to the queue. Fenced to the
/// attempt. Hosts call this when that thread closes or unloads; other
/// databases' in-flight claims stay held. Best effort: a failure is logged,
/// the connection is closed, and the unsuccessful claim is left to expire.
/// Never panics: sqlite failures are logged and skipped.
pub fn release_held_claims_for(path: &str) -> i64 {
    if path.is_empty() {
        return 0;
    }
    let list = {
        let mut guard = held_map();
        let Some(map) = guard.as_mut() else {
            return 0;
        };
        let mut list = Vec::new();
        map.retain(|_, claim| {
            if claim.path == path {
                list.push((claim.work_item_id.clone(), claim.claim_attempt));
                false
            } else {
                true
            }
        });
        list
    };
    release_taken_claims(path, list)
}

/// Hand every still-held claim back to the queue. Fenced to the attempt.
/// Process-wide: hosts invoke this once at coordinated process shutdown,
/// after stopping claim admission and settling or cancelling workers, not
/// on a single thread's close. Best effort per database: a failure is
/// logged, the connection is closed, remaining databases continue, and the
/// unsuccessful claim is left to expire as before. Never panics: sqlite
/// failures are logged and remaining databases continue.
pub fn release_held_claims() -> i64 {
    let claims = {
        let mut guard = held_map();
        guard.take().unwrap_or_default()
    };
    let mut by_path: HashMap<String, Vec<(String, Option<i64>)>> = HashMap::new();
    for claim in claims.into_values() {
        by_path
            .entry(claim.path)
            .or_default()
            .push((claim.work_item_id, claim.claim_attempt));
    }
    let mut released = 0i64;
    for (path, list) in by_path {
        released += release_taken_claims(&path, list);
    }
    released
}
