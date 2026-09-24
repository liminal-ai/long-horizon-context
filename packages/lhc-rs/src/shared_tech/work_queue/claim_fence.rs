//! Claim-attempt fencing and clean-exit handback.
//!
//! Ported from packages/lhc/src/shared-tech/work-queue/claim-fence.ts.
//! Node `process.once("exit")` is not used; hosts call [`release_held_claims`].

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Mutex;

use super::super::storage::{Db, SqlParam, open_database};

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

fn panic_detail(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
        .unwrap_or_else(|| "non-string panic".to_string())
}

fn warn_handback(path: &str, detail: &str) {
    eprintln!("lhc: release_held_claims failed for {path}: {detail} (claim left to expire)");
}

/// Hand every still-held claim back to the queue. Fenced to the attempt.
/// Process-wide: hosts invoke this once at coordinated process shutdown,
/// not on a single thread's close. Best effort per database: a failure
/// is logged, the connection is closed, remaining databases continue,
/// and the unsuccessful claim is left to expire as before. Never panics.
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
        if !std::path::Path::new(&path).exists() {
            continue;
        }
        let db = match catch_unwind(AssertUnwindSafe(|| open_database(&path))) {
            Ok(crate::shared_tech::errors::OpResult::Ok { value }) => value,
            Ok(crate::shared_tech::errors::OpResult::Err { error }) => {
                warn_handback(&path, &error.reason);
                continue;
            }
            Err(payload) => {
                warn_handback(&path, &panic_detail(payload));
                continue;
            }
        };
        let work = catch_unwind(AssertUnwindSafe(|| {
            db.exec("PRAGMA busy_timeout = 2000;");
            let sql = format!(
                "UPDATE work_item SET status = 'queued', claimed_at = NULL, claim_expires_at = NULL,
                   payload = json_remove(payload, '$.claimExpired')
                 WHERE {OWNED_CLAIM_SQL}"
            );
            let mut n = 0i64;
            for (work_item_id, claim_attempt) in list {
                n += db
                    .prepare(&sql)
                    .run(&claim_params(&ClaimAttempt {
                        work_item_id,
                        claim_attempt,
                    }))
                    .changes;
            }
            n
        }));
        match work {
            Ok(n) => released += n,
            Err(payload) => warn_handback(&path, &panic_detail(payload)),
        }
        let _ = catch_unwind(AssertUnwindSafe(|| db.close()));
    }
    released
}
