//! Durable compact-continuation writer, boundary status, stage log, receipts.
//! Domain-owned table access only — no ad hoc SQL outside this module.
//! Schema v10: terminal receipts, immutable identity, force intent, one unresolved boundary.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_tech::compact_continuation::{
    CompactContinuationDecision, CompactContinuationReceipt,
};
use crate::shared_tech::js_json::js_json_stringify;
use crate::shared_tech::storage::{Db, SqlParam};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriterClaimRow {
    pub claim: WriterClaimKind,
    pub attempt_id: Option<String>,
    pub claimed_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriterClaimKind {
    None,
    Lhc,
}

impl WriterClaimKind {
    pub fn as_str(self) -> &'static str {
        match self {
            WriterClaimKind::None => "none",
            WriterClaimKind::Lhc => "lhc",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoundaryStatus {
    Pending,
    Complete,
    FailedRepairable,
}

impl BoundaryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            BoundaryStatus::Pending => "pending",
            BoundaryStatus::Complete => "complete",
            BoundaryStatus::FailedRepairable => "failed_repairable",
        }
    }

    pub fn from_wire(s: &str) -> Self {
        match s {
            "pending" => BoundaryStatus::Pending,
            "complete" => BoundaryStatus::Complete,
            "failed_repairable" => BoundaryStatus::FailedRepairable,
            other => panic!("unknown boundary status: {other}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryRow {
    pub continuation_turn_id: String,
    pub attempt_id: String,
    pub status: BoundaryStatus,
    pub marker_persisted: bool,
    pub last_stage: String,
    pub forced_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageName {
    ClaimedWriter,
    ForceIntent,
    ForceTurnEnd,
    CompactPrepared,
    MarkerPersisted,
    InstallSucceeded,
    InstallFailed,
    CompactFailed,
    UnsafeRunwayRefused,
    ReceiptRecorded,
    WriterReleased,
    Interrupted,
    RetryPosture,
    WriterClaimRepaired,
    RecoveryMaintenance,
    BoundaryDiscarded,
}

impl StageName {
    pub fn as_str(self) -> &'static str {
        match self {
            StageName::ClaimedWriter => "claimed_writer",
            StageName::ForceIntent => "force_intent",
            StageName::ForceTurnEnd => "force_turn_end",
            StageName::CompactPrepared => "compact_prepared",
            StageName::MarkerPersisted => "marker_persisted",
            StageName::InstallSucceeded => "install_succeeded",
            StageName::InstallFailed => "install_failed",
            StageName::CompactFailed => "compact_failed",
            StageName::UnsafeRunwayRefused => "unsafe_runway_refused",
            StageName::ReceiptRecorded => "receipt_recorded",
            StageName::WriterReleased => "writer_released",
            StageName::Interrupted => "interrupted",
            StageName::RetryPosture => "retry_posture",
            StageName::WriterClaimRepaired => "writer_claim_repaired",
            StageName::RecoveryMaintenance => "recovery_maintenance",
            StageName::BoundaryDiscarded => "boundary_discarded",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceIntentRow {
    pub attempt_id: String,
    pub turn_end_idempotency_key: String,
    pub status: ForceIntentStatus,
    pub continuation_turn_id: Option<String>,
    pub recorded_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForceIntentStatus {
    Intent,
    Applied,
    Reconciled,
}

impl ForceIntentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ForceIntentStatus::Intent => "intent",
            ForceIntentStatus::Applied => "applied",
            ForceIntentStatus::Reconciled => "reconciled",
        }
    }

    pub fn from_wire(s: &str) -> Self {
        match s {
            "intent" => ForceIntentStatus::Intent,
            "applied" => ForceIntentStatus::Applied,
            "reconciled" => ForceIntentStatus::Reconciled,
            other => panic!("unknown force intent status: {other}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptRow {
    pub attempt_id: String,
    pub intent_hash: String,
    pub intent_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCompactContinuationReceipt {
    pub attempt_id: String,
    pub recorded_at: String,
    pub outcome: String,
    pub reason_code: String,
    pub refused: bool,
    pub skipped: bool,
    pub terminal: bool,
    pub continuation_turn_id: Option<String>,
    pub receipt: CompactContinuationReceipt,
    pub decision: CompactContinuationDecision,
}

fn map_str(row: &Map<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("missing column {key}"))
        .to_string()
}

fn map_opt_str(row: &Map<String, Value>, key: &str) -> Option<String> {
    match row.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => panic!("column {key} not text: {other}"),
    }
}

fn map_i64(row: &Map<String, Value>, key: &str) -> i64 {
    match row.get(key) {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or(0),
        _ => 0,
    }
}

pub fn read_writer_claim(db: &Db) -> WriterClaimRow {
    let row = db
        .prepare("SELECT claim, attempt_id, claimed_at FROM compact_continuation_writer WHERE singleton = 1")
        .get();
    let Some(row) = row else {
        panic!("compact_continuation_writer singleton row missing");
    };
    let claim = match row.get("claim").and_then(|v| v.as_str()) {
        Some("lhc") => WriterClaimKind::Lhc,
        _ => WriterClaimKind::None,
    };
    WriterClaimRow {
        claim,
        attempt_id: map_opt_str(&row, "attempt_id"),
        claimed_at: map_opt_str(&row, "claimed_at"),
    }
}

/// Claim the LHC writer for this attempt. Idempotent for the same attemptId.
/// Returns false when another claim is held by a different attempt.
pub fn claim_lhc_writer(db: &Db, attempt_id: &str, claimed_at: &str) -> bool {
    let current = read_writer_claim(db);
    if current.claim == WriterClaimKind::Lhc && current.attempt_id.as_deref() == Some(attempt_id) {
        return true;
    }
    if current.claim == WriterClaimKind::Lhc && current.attempt_id.as_deref() != Some(attempt_id) {
        return false;
    }
    let result = db
        .prepare(
            r#"UPDATE compact_continuation_writer
       SET claim = 'lhc', attempt_id = ?, claimed_at = ?
       WHERE singleton = 1 AND claim = 'none'"#,
        )
        .run(&[SqlParam::from(attempt_id), SqlParam::from(claimed_at)]);
    result.changes == 1
}

pub fn release_lhc_writer(db: &Db, attempt_id: &str) -> bool {
    let result = db
        .prepare(
            r#"UPDATE compact_continuation_writer
       SET claim = 'none', attempt_id = NULL, claimed_at = NULL
       WHERE singleton = 1 AND claim = 'lhc' AND attempt_id = ?"#,
        )
        .run(&[SqlParam::from(attempt_id)]);
    result.changes == 1 || read_writer_claim(db).claim == WriterClaimKind::None
}

/// Test-only: force-clear the writer claim.
#[doc(hidden)]
#[cfg(any(test, feature = "test-util"))]
pub fn force_clear_writer(db: &Db) {
    db.prepare(
        r#"UPDATE compact_continuation_writer
     SET claim = 'none', attempt_id = NULL, claimed_at = NULL
     WHERE singleton = 1"#,
    )
    .run(&[]);
}

/// Test-only: seed a held writer claim without going through claim_lhc_writer.
#[doc(hidden)]
#[cfg(any(test, feature = "test-util"))]
pub fn seed_writer_claim(db: &Db, attempt_id: &str, claimed_at: &str) {
    db.prepare(
        r#"UPDATE compact_continuation_writer
     SET claim = 'lhc', attempt_id = ?, claimed_at = ?
     WHERE singleton = 1"#,
    )
    .run(&[SqlParam::from(attempt_id), SqlParam::from(claimed_at)]);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistReceiptResult {
    Inserted,
    AlreadyTerminal,
    UpdatedNonterminal,
}

/// Persist a receipt. Terminal receipts never overwrite an existing terminal row.
pub fn persist_receipt(
    db: &Db,
    attempt_id: &str,
    recorded_at: &str,
    decision: &CompactContinuationDecision,
    terminal: bool,
) -> PersistReceiptResult {
    let existing = db
        .prepare("SELECT terminal FROM compact_continuation_receipt WHERE attempt_id = ?")
        .get_params(&[SqlParam::from(attempt_id)]);
    if let Some(row) = &existing {
        if map_i64(row, "terminal") == 1 {
            return PersistReceiptResult::AlreadyTerminal;
        }
    }
    let receipt_json =
        js_json_stringify(&serde_json::to_value(&decision.receipt).unwrap_or(Value::Null));
    let decision_json = js_json_stringify(&serde_json::to_value(decision).unwrap_or(Value::Null));
    let continuation_turn_id = decision.receipt.residual.continuation_turn_id.clone();
    if existing.is_none() {
        db.prepare(
            r#"INSERT INTO compact_continuation_receipt (
         attempt_id, recorded_at, outcome, reason_code, refused, skipped, terminal,
         continuation_turn_id, receipt_json, decision_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .run(&[
            SqlParam::from(attempt_id),
            SqlParam::from(recorded_at),
            SqlParam::from(decision.receipt.outcome.as_str()),
            SqlParam::from(decision.receipt.reason_code.as_str()),
            SqlParam::from(if decision.receipt.refused { 1i64 } else { 0 }),
            SqlParam::from(if decision.receipt.skipped { 1i64 } else { 0 }),
            SqlParam::from(if terminal { 1i64 } else { 0 }),
            SqlParam::from(continuation_turn_id.as_deref()),
            SqlParam::from(receipt_json.as_str()),
            SqlParam::from(decision_json.as_str()),
        ]);
        return PersistReceiptResult::Inserted;
    }
    db.prepare(
        r#"UPDATE compact_continuation_receipt SET
       recorded_at = ?, outcome = ?, reason_code = ?, refused = ?, skipped = ?,
       terminal = ?, continuation_turn_id = ?, receipt_json = ?, decision_json = ?
     WHERE attempt_id = ? AND terminal = 0"#,
    )
    .run(&[
        SqlParam::from(recorded_at),
        SqlParam::from(decision.receipt.outcome.as_str()),
        SqlParam::from(decision.receipt.reason_code.as_str()),
        SqlParam::from(if decision.receipt.refused { 1i64 } else { 0 }),
        SqlParam::from(if decision.receipt.skipped { 1i64 } else { 0 }),
        SqlParam::from(if terminal { 1i64 } else { 0 }),
        SqlParam::from(continuation_turn_id.as_deref()),
        SqlParam::from(receipt_json.as_str()),
        SqlParam::from(decision_json.as_str()),
        SqlParam::from(attempt_id),
    ]);
    PersistReceiptResult::UpdatedNonterminal
}

fn row_to_receipt(row: &Map<String, Value>) -> StoredCompactContinuationReceipt {
    let receipt: CompactContinuationReceipt =
        serde_json::from_str(map_str(row, "receipt_json").as_str()).expect("receipt_json");
    let decision: CompactContinuationDecision =
        serde_json::from_str(map_str(row, "decision_json").as_str()).expect("decision_json");
    StoredCompactContinuationReceipt {
        attempt_id: map_str(row, "attempt_id"),
        recorded_at: map_str(row, "recorded_at"),
        outcome: map_str(row, "outcome"),
        reason_code: map_str(row, "reason_code"),
        refused: map_i64(row, "refused") == 1,
        skipped: map_i64(row, "skipped") == 1,
        terminal: map_i64(row, "terminal") == 1,
        continuation_turn_id: map_opt_str(row, "continuation_turn_id"),
        receipt,
        decision,
    }
}

pub fn read_receipt_by_attempt_id(
    db: &Db,
    attempt_id: &str,
) -> Option<StoredCompactContinuationReceipt> {
    let row = db
        .prepare(
            r#"SELECT attempt_id, recorded_at, outcome, reason_code, refused, skipped, terminal,
              continuation_turn_id, receipt_json, decision_json
       FROM compact_continuation_receipt WHERE attempt_id = ?"#,
        )
        .get_params(&[SqlParam::from(attempt_id)])?;
    Some(row_to_receipt(&row))
}

pub fn list_receipts(db: &Db, limit: i64) -> Vec<StoredCompactContinuationReceipt> {
    let rows = db
        .prepare(
            r#"SELECT attempt_id, recorded_at, outcome, reason_code, refused, skipped, terminal,
              continuation_turn_id, receipt_json, decision_json
       FROM compact_continuation_receipt
       ORDER BY recorded_at DESC
       LIMIT ?"#,
        )
        .all(&[SqlParam::from(limit)]);
    rows.iter().map(row_to_receipt).collect()
}

pub fn append_stage_log(
    db: &Db,
    attempt_id: &str,
    stage: StageName,
    recorded_at: &str,
    detail: Option<&Map<String, Value>>,
) {
    let detail_json = detail.map(|d| js_json_stringify(&Value::Object(d.clone())));
    db.prepare(
        r#"INSERT INTO compact_continuation_stage_log (attempt_id, stage, detail_json, recorded_at)
     VALUES (?, ?, ?, ?)"#,
    )
    .run(&[
        SqlParam::from(attempt_id),
        SqlParam::from(stage.as_str()),
        SqlParam::from(detail_json.as_deref()),
        SqlParam::from(recorded_at),
    ]);
}

#[derive(Debug, Clone, PartialEq)]
pub struct StageLogEntry {
    pub stage: String,
    pub detail: Option<Map<String, Value>>,
    pub recorded_at: String,
}

pub fn list_stage_log(db: &Db, attempt_id: &str) -> Vec<StageLogEntry> {
    let rows = db
        .prepare(
            r#"SELECT stage, detail_json, recorded_at FROM compact_continuation_stage_log
       WHERE attempt_id = ? ORDER BY log_id"#,
        )
        .all(&[SqlParam::from(attempt_id)]);
    rows.iter()
        .map(|row| {
            let detail = match row.get("detail_json") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => {
                    let v: Value = serde_json::from_str(s).expect("detail_json");
                    v.as_object().cloned()
                }
                Some(other) => panic!("detail_json not text: {other}"),
            };
            StageLogEntry {
                stage: map_str(row, "stage"),
                detail,
                recorded_at: map_str(row, "recorded_at"),
            }
        })
        .collect()
}

fn boundary_from_row(row: &Map<String, Value>) -> BoundaryRow {
    BoundaryRow {
        continuation_turn_id: map_str(row, "continuation_turn_id"),
        attempt_id: map_str(row, "attempt_id"),
        status: BoundaryStatus::from_wire(&map_str(row, "status")),
        marker_persisted: map_i64(row, "marker_persisted") == 1,
        last_stage: map_str(row, "last_stage"),
        forced_at: map_str(row, "forced_at"),
        completed_at: map_opt_str(row, "completed_at"),
    }
}

/// Insert or update a boundary owned by attemptId.
/// Never changes ownership: if the row exists under a different attempt, panics.
/// Discard a pending/failed compact-continuation boundary owned by this
/// attempt. Used when the bounded retry budget is exhausted (R23-S9/S10): the
/// attempt terminalizes on `continue_current_body` and its speculative
/// boundary bookkeeping must not remain to wedge every fresh attempt. Only
/// the bookkeeping row is removed — canonical turn/marker bytes and the
/// terminal receipt stay untouched.
pub fn delete_boundary(db: &Db, continuation_turn_id: &str, attempt_id: &str) {
    let Some(existing) = read_boundary(db, continuation_turn_id) else {
        return;
    };
    assert_eq!(
        existing.attempt_id, attempt_id,
        "boundary {continuation_turn_id} owned by {}, not {attempt_id}",
        existing.attempt_id
    );
    db.prepare("DELETE FROM compact_continuation_boundary WHERE continuation_turn_id = ?")
        .run(&[SqlParam::from(continuation_turn_id)]);
}

pub fn upsert_boundary(
    db: &Db,
    continuation_turn_id: &str,
    attempt_id: &str,
    status: BoundaryStatus,
    marker_persisted: bool,
    last_stage: &str,
    forced_at: &str,
    completed_at: Option<&str>,
) {
    if let Some(existing) = read_boundary(db, continuation_turn_id) {
        if existing.attempt_id != attempt_id {
            panic!(
                "boundary {continuation_turn_id} owned by {}, not {attempt_id}",
                existing.attempt_id
            );
        }
    }
    let result = db
        .prepare(
            r#"INSERT INTO compact_continuation_boundary (
         continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(continuation_turn_id) DO UPDATE SET
         status = excluded.status,
         marker_persisted = excluded.marker_persisted,
         last_stage = excluded.last_stage,
         completed_at = excluded.completed_at
       WHERE compact_continuation_boundary.attempt_id = excluded.attempt_id"#,
        )
        .run(&[
            SqlParam::from(continuation_turn_id),
            SqlParam::from(attempt_id),
            SqlParam::from(status.as_str()),
            SqlParam::from(if marker_persisted { 1i64 } else { 0 }),
            SqlParam::from(last_stage),
            SqlParam::from(forced_at),
            SqlParam::from(completed_at),
        ]);
    if result.changes == 0 {
        panic!(
            "boundary {continuation_turn_id} upsert changed 0 rows (owner mismatch or missing row for attempt {attempt_id})"
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertAttemptIntentResult {
    Inserted,
    ExistsSame,
    ExistsDifferent,
}

pub fn insert_attempt_intent(
    db: &Db,
    attempt_id: &str,
    intent_hash: &str,
    intent_json: &str,
    created_at: &str,
) -> InsertAttemptIntentResult {
    let existing = db
        .prepare("SELECT intent_hash FROM compact_continuation_attempt WHERE attempt_id = ?")
        .get_params(&[SqlParam::from(attempt_id)]);
    if let Some(row) = existing {
        let existing_hash = map_str(&row, "intent_hash");
        return if existing_hash == intent_hash {
            InsertAttemptIntentResult::ExistsSame
        } else {
            InsertAttemptIntentResult::ExistsDifferent
        };
    }
    db.prepare(
        r#"INSERT INTO compact_continuation_attempt (attempt_id, intent_hash, intent_json, created_at)
     VALUES (?, ?, ?, ?)"#,
    )
    .run(&[
        SqlParam::from(attempt_id),
        SqlParam::from(intent_hash),
        SqlParam::from(intent_json),
        SqlParam::from(created_at),
    ]);
    InsertAttemptIntentResult::Inserted
}

pub fn read_attempt_intent(db: &Db, attempt_id: &str) -> Option<AttemptRow> {
    let row = db
        .prepare(
            r#"SELECT attempt_id, intent_hash, intent_json, created_at FROM compact_continuation_attempt WHERE attempt_id = ?"#,
        )
        .get_params(&[SqlParam::from(attempt_id)])?;
    Some(AttemptRow {
        attempt_id: map_str(&row, "attempt_id"),
        intent_hash: map_str(&row, "intent_hash"),
        intent_json: map_str(&row, "intent_json"),
        created_at: map_str(&row, "created_at"),
    })
}

pub fn record_force_intent(
    db: &Db,
    attempt_id: &str,
    turn_end_idempotency_key: &str,
    recorded_at: &str,
) {
    db.prepare(
        r#"INSERT INTO compact_continuation_force_intent (
       attempt_id, turn_end_idempotency_key, status, continuation_turn_id, recorded_at
     ) VALUES (?, ?, 'intent', NULL, ?)
     ON CONFLICT(attempt_id) DO UPDATE SET
       turn_end_idempotency_key = excluded.turn_end_idempotency_key,
       status = CASE
         WHEN compact_continuation_force_intent.status = 'reconciled' THEN compact_continuation_force_intent.status
         ELSE 'intent'
       END,
       recorded_at = excluded.recorded_at"#,
    )
    .run(&[
        SqlParam::from(attempt_id),
        SqlParam::from(turn_end_idempotency_key),
        SqlParam::from(recorded_at),
    ]);
}

pub fn read_force_intent(db: &Db, attempt_id: &str) -> Option<ForceIntentRow> {
    let row = db
        .prepare(
            r#"SELECT attempt_id, turn_end_idempotency_key, status, continuation_turn_id, recorded_at
       FROM compact_continuation_force_intent WHERE attempt_id = ?"#,
        )
        .get_params(&[SqlParam::from(attempt_id)])?;
    Some(ForceIntentRow {
        attempt_id: map_str(&row, "attempt_id"),
        turn_end_idempotency_key: map_str(&row, "turn_end_idempotency_key"),
        status: ForceIntentStatus::from_wire(&map_str(&row, "status")),
        continuation_turn_id: map_opt_str(&row, "continuation_turn_id"),
        recorded_at: map_str(&row, "recorded_at"),
    })
}

pub fn mark_force_intent_applied(db: &Db, attempt_id: &str, continuation_turn_id: &str) {
    let existing = db
        .prepare("SELECT attempt_id FROM compact_continuation_force_intent WHERE attempt_id = ?")
        .get_params(&[SqlParam::from(attempt_id)]);
    if existing.is_none() {
        panic!("markForceIntentApplied: no force intent row for attempt {attempt_id}");
    }
    db.prepare(
        r#"UPDATE compact_continuation_force_intent
     SET status = 'reconciled', continuation_turn_id = ?
     WHERE attempt_id = ?"#,
    )
    .run(&[
        SqlParam::from(continuation_turn_id),
        SqlParam::from(attempt_id),
    ]);
}

pub fn find_continuation_turn_from_force_key(
    db: &Db,
    turn_end_idempotency_key: &str,
) -> Option<String> {
    let event = db
        .prepare(
            r#"SELECT event_order FROM event
       WHERE idempotency_key = ? AND event_kind = 'turn_end'"#,
        )
        .get_params(&[SqlParam::from(turn_end_idempotency_key)])?;
    let order = map_i64(&event, "event_order");
    let turn = db
        .prepare(
            "SELECT turn_id FROM turns WHERE opened_at_event_order = ? ORDER BY turn_order DESC LIMIT 1",
        )
        .get_params(&[SqlParam::from(order)])?;
    Some(map_str(&turn, "turn_id"))
}

pub fn read_boundary(db: &Db, continuation_turn_id: &str) -> Option<BoundaryRow> {
    let row = db
        .prepare(
            r#"SELECT continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
       FROM compact_continuation_boundary WHERE continuation_turn_id = ?"#,
        )
        .get_params(&[SqlParam::from(continuation_turn_id)])?;
    Some(boundary_from_row(&row))
}

pub fn read_pending_boundary(db: &Db) -> Option<BoundaryRow> {
    let rows = db
        .prepare(
            r#"SELECT continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
       FROM compact_continuation_boundary
       WHERE status IN ('pending', 'failed_repairable')
       ORDER BY forced_at DESC"#,
        )
        .all(&[]);
    if rows.is_empty() {
        return None;
    }
    if rows.len() > 1 {
        panic!(
            "compact-continuation corruption: {} unresolved boundaries (at most one allowed)",
            rows.len()
        );
    }
    Some(boundary_from_row(&rows[0]))
}

pub fn list_boundaries(db: &Db) -> Vec<BoundaryRow> {
    let rows = db
        .prepare(
            r#"SELECT continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
       FROM compact_continuation_boundary ORDER BY forced_at"#,
        )
        .all(&[]);
    rows.iter().map(boundary_from_row).collect()
}

pub fn marker_exists_by_idempotency_key(db: &Db, idempotency_key: &str) -> bool {
    db.prepare("SELECT 1 AS present FROM event WHERE idempotency_key = ? LIMIT 1")
        .get_params(&[SqlParam::from(idempotency_key)])
        .is_some()
}

pub fn read_open_turn_ids(db: &Db) -> Vec<String> {
    let rows = db
        .prepare("SELECT turn_id FROM turns WHERE status = 'open' ORDER BY turn_order")
        .all(&[]);
    rows.iter().map(|r| map_str(r, "turn_id")).collect()
}

pub fn read_open_turn_member_count(db: &Db, turn_id: &str) -> i64 {
    let row = db
        .prepare("SELECT COUNT(*) AS n FROM message WHERE turn_id = ? AND deleted_at IS NULL")
        .get_params(&[SqlParam::from(turn_id)]);
    row.as_ref().map(|r| map_i64(r, "n")).unwrap_or(0)
}

/// Internal helper retained for crash-gap / schema probes; not on the hot path.
#[cfg(any(test, feature = "test-util"))]
#[allow(dead_code)]
pub fn max_event_order(db: &Db) -> i64 {
    let row = db
        .prepare("SELECT COALESCE(MAX(event_order), 0) AS m FROM event")
        .get()
        .expect("max event order");
    map_i64(&row, "m")
}

// ── Host validation (schema v11) ─────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostValidationStatus {
    Awaiting,
    Ok,
    Failed,
}

impl HostValidationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Awaiting => "awaiting",
            Self::Ok => "ok",
            Self::Failed => "failed",
        }
    }

    pub fn from_str_exact(s: &str) -> Option<Self> {
        Some(match s {
            "awaiting" => Self::Awaiting,
            "ok" => Self::Ok,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostValidationRow {
    pub attempt_id: String,
    pub status: HostValidationStatus,
    pub reason: Option<String>,
    pub recorded_at: String,
    pub updated_at: String,
}

pub fn read_host_validation(db: &Db, attempt_id: &str) -> Option<HostValidationRow> {
    let row = db
        .prepare(
            "SELECT attempt_id, status, reason, recorded_at, updated_at
             FROM compact_continuation_host_validation WHERE attempt_id = ?",
        )
        .get_params(&[SqlParam::from(attempt_id)])?;
    let status_str = row.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let status = HostValidationStatus::from_str_exact(status_str)
        .unwrap_or_else(|| panic!("invalid host validation status '{status_str}'"));
    Some(HostValidationRow {
        attempt_id: row
            .get("attempt_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        status,
        reason: row
            .get("reason")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        recorded_at: row
            .get("recorded_at")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        updated_at: row
            .get("updated_at")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

/// Record awaiting host validation after successful core install.
/// Idempotent for same attempt when already awaiting; panics on overwrite of
/// terminal ok/failed (mirrors the TS throw; caught at the operation boundary).
pub fn record_host_validation_awaiting(db: &Db, attempt_id: &str, recorded_at: &str) {
    if let Some(existing) = read_host_validation(db, attempt_id) {
        if existing.status == HostValidationStatus::Awaiting {
            return;
        }
        panic!(
            "host validation already terminal for attempt {attempt_id} (status={})",
            existing.status.as_str()
        );
    }
    db.prepare(
        "INSERT INTO compact_continuation_host_validation (attempt_id, status, reason, recorded_at, updated_at)
         VALUES (?, 'awaiting', NULL, ?, ?)",
    )
    .run(&[
        SqlParam::from(attempt_id),
        SqlParam::from(recorded_at),
        SqlParam::from(recorded_at),
    ]);
}

/// Host records full-body validation result. Does not roll back core install.
/// Only transitions from awaiting (or inserts failed/ok when missing for repair).
pub fn record_host_validation_result(
    db: &Db,
    attempt_id: &str,
    result: HostValidationStatus,
    updated_at: &str,
    reason: Option<&str>,
) -> HostValidationRow {
    assert!(
        matches!(
            result,
            HostValidationStatus::Ok | HostValidationStatus::Failed
        ),
        "host validation result must be ok|failed"
    );
    let existing = read_host_validation(db, attempt_id);
    if let Some(existing) = &existing
        && matches!(
            existing.status,
            HostValidationStatus::Ok | HostValidationStatus::Failed
        )
    {
        if existing.status == result {
            return existing.clone();
        }
        panic!(
            "host validation already recorded as {} for attempt {attempt_id}; cannot set {}",
            existing.status.as_str(),
            result.as_str()
        );
    }
    if existing.is_none() {
        db.prepare(
            "INSERT INTO compact_continuation_host_validation (attempt_id, status, reason, recorded_at, updated_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .run(&[
            SqlParam::from(attempt_id),
            SqlParam::from(result.as_str()),
            SqlParam::from(reason),
            SqlParam::from(updated_at),
            SqlParam::from(updated_at),
        ]);
    } else {
        db.prepare(
            "UPDATE compact_continuation_host_validation
             SET status = ?, reason = ?, updated_at = ?
             WHERE attempt_id = ? AND status = 'awaiting'",
        )
        .run(&[
            SqlParam::from(result.as_str()),
            SqlParam::from(reason),
            SqlParam::from(updated_at),
            SqlParam::from(attempt_id),
        ]);
    }
    read_host_validation(db, attempt_id)
        .unwrap_or_else(|| panic!("host validation write failed for {attempt_id}"))
}
