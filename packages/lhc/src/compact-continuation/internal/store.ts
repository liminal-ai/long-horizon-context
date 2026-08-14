// Durable compact-continuation writer, boundary status, stage log, receipts.
// Domain-owned table access only — no ad hoc SQL outside this module.
// Schema v10: terminal receipts, immutable identity, force intent, one unresolved boundary.

import type { DatabaseSync } from "node:sqlite";
import type {
  CompactContinuationDecision,
  CompactContinuationReceipt,
} from "../../shared-tech/compact-continuation/index.js";

export type WriterClaimRow = {
  claim: "none" | "lhc";
  attemptId: string | null;
  claimedAt: string | null;
};

export type BoundaryStatus = "pending" | "complete" | "failed_repairable";

export type BoundaryRow = {
  continuationTurnId: string;
  attemptId: string;
  status: BoundaryStatus;
  markerPersisted: boolean;
  lastStage: string;
  forcedAt: string;
  completedAt: string | null;
};

export type StageName =
  | "claimed_writer"
  | "force_intent"
  | "force_turn_end"
  | "compact_prepared"
  | "marker_persisted"
  | "install_succeeded"
  | "install_failed"
  | "compact_failed"
  | "receipt_recorded"
  | "writer_released"
  | "interrupted"
  | "retry_posture"
  | "writer_claim_repaired"
  | "recovery_maintenance";

export type ForceIntentRow = {
  attemptId: string;
  turnEndIdempotencyKey: string;
  status: "intent" | "applied" | "reconciled";
  continuationTurnId: string | null;
  recordedAt: string;
};

export type AttemptRow = {
  attemptId: string;
  intentHash: string;
  intentJson: string;
  createdAt: string;
};

export function readWriterClaim(db: DatabaseSync): WriterClaimRow {
  const row = db
    .prepare(`SELECT claim, attempt_id, claimed_at FROM compact_continuation_writer WHERE singleton = 1`)
    .get() as { claim: string; attempt_id: string | null; claimed_at: string | null } | undefined;
  if (row === undefined) {
    throw new Error("compact_continuation_writer singleton row missing");
  }
  return {
    claim: row.claim === "lhc" ? "lhc" : "none",
    attemptId: row.attempt_id,
    claimedAt: row.claimed_at,
  };
}

/**
 * Claim the LHC writer for this attempt. Idempotent for the same attemptId.
 * Returns false when another claim is held by a different attempt.
 */
export function claimLhcWriter(db: DatabaseSync, attemptId: string, claimedAt: string): boolean {
  const current = readWriterClaim(db);
  if (current.claim === "lhc" && current.attemptId === attemptId) {
    return true;
  }
  if (current.claim === "lhc" && current.attemptId !== attemptId) {
    return false;
  }
  const result = db
    .prepare(
      `UPDATE compact_continuation_writer
       SET claim = 'lhc', attempt_id = ?, claimed_at = ?
       WHERE singleton = 1 AND claim = 'none'`,
    )
    .run(attemptId, claimedAt);
  return Number(result.changes) === 1;
}

export function releaseLhcWriter(db: DatabaseSync, attemptId: string): boolean {
  const result = db
    .prepare(
      `UPDATE compact_continuation_writer
       SET claim = 'none', attempt_id = NULL, claimed_at = NULL
       WHERE singleton = 1 AND claim = 'lhc' AND attempt_id = ?`,
    )
    .run(attemptId);
  return Number(result.changes) === 1 || readWriterClaim(db).claim === "none";
}

/** Test-only: force-clear the writer claim. */
export function forceClearWriter(db: DatabaseSync): void {
  db.prepare(
    `UPDATE compact_continuation_writer
     SET claim = 'none', attempt_id = NULL, claimed_at = NULL
     WHERE singleton = 1`,
  ).run();
}

/** Test-only: seed a held writer claim without going through claimLhcWriter. */
export function seedWriterClaim(db: DatabaseSync, attemptId: string, claimedAt: string): void {
  db.prepare(
    `UPDATE compact_continuation_writer
     SET claim = 'lhc', attempt_id = ?, claimed_at = ?
     WHERE singleton = 1`,
  ).run(attemptId, claimedAt);
}

export type StoredCompactContinuationReceipt = {
  attemptId: string;
  recordedAt: string;
  outcome: string;
  reasonCode: string;
  refused: boolean;
  skipped: boolean;
  terminal: boolean;
  continuationTurnId: string | null;
  receipt: CompactContinuationReceipt;
  decision: CompactContinuationDecision;
};

/**
 * Persist a receipt. Terminal receipts never overwrite an existing terminal row.
 * Returns: 'inserted' | 'already_terminal' | 'updated_nonterminal'
 */
export function persistReceipt(
  db: DatabaseSync,
  attemptId: string,
  recordedAt: string,
  decision: CompactContinuationDecision,
  terminal: boolean,
): "inserted" | "already_terminal" | "updated_nonterminal" {
  const existing = db
    .prepare(`SELECT terminal FROM compact_continuation_receipt WHERE attempt_id = ?`)
    .get(attemptId) as { terminal: number | bigint } | undefined;
  if (existing !== undefined && Number(existing.terminal) === 1) {
    return "already_terminal";
  }
  if (existing === undefined) {
    db.prepare(
      `INSERT INTO compact_continuation_receipt (
         attempt_id, recorded_at, outcome, reason_code, refused, skipped, terminal,
         continuation_turn_id, receipt_json, decision_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      attemptId,
      recordedAt,
      decision.receipt.outcome,
      decision.receipt.reasonCode,
      decision.receipt.refused ? 1 : 0,
      decision.receipt.skipped ? 1 : 0,
      terminal ? 1 : 0,
      decision.receipt.residual.continuationTurnId,
      JSON.stringify(decision.receipt),
      JSON.stringify(decision),
    );
    return "inserted";
  }
  db.prepare(
    `UPDATE compact_continuation_receipt SET
       recorded_at = ?, outcome = ?, reason_code = ?, refused = ?, skipped = ?,
       terminal = ?, continuation_turn_id = ?, receipt_json = ?, decision_json = ?
     WHERE attempt_id = ? AND terminal = 0`,
  ).run(
    recordedAt,
    decision.receipt.outcome,
    decision.receipt.reasonCode,
    decision.receipt.refused ? 1 : 0,
    decision.receipt.skipped ? 1 : 0,
    terminal ? 1 : 0,
    decision.receipt.residual.continuationTurnId,
    JSON.stringify(decision.receipt),
    JSON.stringify(decision),
    attemptId,
  );
  return "updated_nonterminal";
}

function rowToReceipt(row: {
  attempt_id: string;
  recorded_at: string;
  outcome: string;
  reason_code: string;
  refused: number | bigint;
  skipped: number | bigint;
  terminal: number | bigint;
  continuation_turn_id: string | null;
  receipt_json: string;
  decision_json: string;
}): StoredCompactContinuationReceipt {
  return {
    attemptId: row.attempt_id,
    recordedAt: row.recorded_at,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    refused: Number(row.refused) === 1,
    skipped: Number(row.skipped) === 1,
    terminal: Number(row.terminal) === 1,
    continuationTurnId: row.continuation_turn_id,
    receipt: JSON.parse(row.receipt_json) as CompactContinuationReceipt,
    decision: JSON.parse(row.decision_json) as CompactContinuationDecision,
  };
}

export function readReceiptByAttemptId(db: DatabaseSync, attemptId: string): StoredCompactContinuationReceipt | null {
  const row = db
    .prepare(
      `SELECT attempt_id, recorded_at, outcome, reason_code, refused, skipped, terminal,
              continuation_turn_id, receipt_json, decision_json
       FROM compact_continuation_receipt WHERE attempt_id = ?`,
    )
    .get(attemptId) as
    | {
        attempt_id: string;
        recorded_at: string;
        outcome: string;
        reason_code: string;
        refused: number | bigint;
        skipped: number | bigint;
        terminal: number | bigint;
        continuation_turn_id: string | null;
        receipt_json: string;
        decision_json: string;
      }
    | undefined;
  if (row === undefined) return null;
  return rowToReceipt(row);
}

export function listReceipts(db: DatabaseSync, limit = 50): StoredCompactContinuationReceipt[] {
  const rows = db
    .prepare(
      `SELECT attempt_id, recorded_at, outcome, reason_code, refused, skipped, terminal,
              continuation_turn_id, receipt_json, decision_json
       FROM compact_continuation_receipt
       ORDER BY recorded_at DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as Array<{
    attempt_id: string;
    recorded_at: string;
    outcome: string;
    reason_code: string;
    refused: number | bigint;
    skipped: number | bigint;
    terminal: number | bigint;
    continuation_turn_id: string | null;
    receipt_json: string;
    decision_json: string;
  }>;
  return rows.map(rowToReceipt);
}

export function appendStageLog(
  db: DatabaseSync,
  attemptId: string,
  stage: StageName,
  recordedAt: string,
  detail?: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO compact_continuation_stage_log (attempt_id, stage, detail_json, recorded_at)
     VALUES (?, ?, ?, ?)`,
  ).run(attemptId, stage, detail === undefined ? null : JSON.stringify(detail), recordedAt);
}

export function listStageLog(
  db: DatabaseSync,
  attemptId: string,
): Array<{ stage: string; detail: Record<string, unknown> | null; recordedAt: string }> {
  const rows = db
    .prepare(
      `SELECT stage, detail_json, recorded_at FROM compact_continuation_stage_log
       WHERE attempt_id = ? ORDER BY log_id`,
    )
    .all(attemptId) as unknown as Array<{
    stage: string;
    detail_json: string | null;
    recorded_at: string;
  }>;
  return rows.map((row) => ({
    stage: row.stage,
    detail: row.detail_json === null ? null : (JSON.parse(row.detail_json) as Record<string, unknown>),
    recordedAt: row.recorded_at,
  }));
}

/**
 * Insert or update a boundary owned by attemptId.
 * Never changes ownership: if the row exists under a different attempt, throws.
 * Zero-row owner-mismatch updates also throw (do not silently continue).
 */
export function upsertBoundary(
  db: DatabaseSync,
  row: {
    continuationTurnId: string;
    attemptId: string;
    status: BoundaryStatus;
    markerPersisted: boolean;
    lastStage: string;
    forcedAt: string;
    completedAt?: string | null;
  },
): void {
  const existing = readBoundary(db, row.continuationTurnId);
  if (existing !== null && existing.attemptId !== row.attemptId) {
    throw new Error(`boundary ${row.continuationTurnId} owned by ${existing.attemptId}, not ${row.attemptId}`);
  }
  const result = db
    .prepare(
      `INSERT INTO compact_continuation_boundary (
         continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(continuation_turn_id) DO UPDATE SET
         status = excluded.status,
         marker_persisted = excluded.marker_persisted,
         last_stage = excluded.last_stage,
         completed_at = excluded.completed_at
       WHERE compact_continuation_boundary.attempt_id = excluded.attempt_id`,
    )
    .run(
      row.continuationTurnId,
      row.attemptId,
      row.status,
      row.markerPersisted ? 1 : 0,
      row.lastStage,
      row.forcedAt,
      row.completedAt ?? null,
    );
  if (Number(result.changes) === 0) {
    throw new Error(
      `boundary ${row.continuationTurnId} upsert changed 0 rows (owner mismatch or missing row for attempt ${row.attemptId})`,
    );
  }
}

export function insertAttemptIntent(
  db: DatabaseSync,
  attemptId: string,
  intentHash: string,
  intentJson: string,
  createdAt: string,
): "inserted" | "exists_same" | "exists_different" {
  const existing = db
    .prepare(`SELECT intent_hash FROM compact_continuation_attempt WHERE attempt_id = ?`)
    .get(attemptId) as { intent_hash: string } | undefined;
  if (existing !== undefined) {
    return existing.intent_hash === intentHash ? "exists_same" : "exists_different";
  }
  db.prepare(
    `INSERT INTO compact_continuation_attempt (attempt_id, intent_hash, intent_json, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(attemptId, intentHash, intentJson, createdAt);
  return "inserted";
}

export function readAttemptIntent(db: DatabaseSync, attemptId: string): AttemptRow | null {
  const row = db
    .prepare(
      `SELECT attempt_id, intent_hash, intent_json, created_at FROM compact_continuation_attempt WHERE attempt_id = ?`,
    )
    .get(attemptId) as { attempt_id: string; intent_hash: string; intent_json: string; created_at: string } | undefined;
  if (row === undefined) return null;
  return {
    attemptId: row.attempt_id,
    intentHash: row.intent_hash,
    intentJson: row.intent_json,
    createdAt: row.created_at,
  };
}

export function recordForceIntent(
  db: DatabaseSync,
  attemptId: string,
  turnEndIdempotencyKey: string,
  recordedAt: string,
): void {
  db.prepare(
    `INSERT INTO compact_continuation_force_intent (
       attempt_id, turn_end_idempotency_key, status, continuation_turn_id, recorded_at
     ) VALUES (?, ?, 'intent', NULL, ?)
     ON CONFLICT(attempt_id) DO UPDATE SET
       turn_end_idempotency_key = excluded.turn_end_idempotency_key,
       status = CASE
         WHEN compact_continuation_force_intent.status = 'reconciled' THEN compact_continuation_force_intent.status
         ELSE 'intent'
       END,
       recorded_at = excluded.recorded_at`,
  ).run(attemptId, turnEndIdempotencyKey, recordedAt);
}

export function readForceIntent(db: DatabaseSync, attemptId: string): ForceIntentRow | null {
  const row = db
    .prepare(
      `SELECT attempt_id, turn_end_idempotency_key, status, continuation_turn_id, recorded_at
       FROM compact_continuation_force_intent WHERE attempt_id = ?`,
    )
    .get(attemptId) as
    | {
        attempt_id: string;
        turn_end_idempotency_key: string;
        status: string;
        continuation_turn_id: string | null;
        recorded_at: string;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    attemptId: row.attempt_id,
    turnEndIdempotencyKey: row.turn_end_idempotency_key,
    status: row.status as ForceIntentRow["status"],
    continuationTurnId: row.continuation_turn_id,
    recordedAt: row.recorded_at,
  };
}

/**
 * Mark force intent reconciled with the continuation turn.
 * Throws when no force-intent row exists for this attempt (caller must have
 * recorded intent before turn_end). Idempotent when already reconciled.
 */
export function markForceIntentApplied(db: DatabaseSync, attemptId: string, continuationTurnId: string): void {
  const existing = db
    .prepare(`SELECT attempt_id FROM compact_continuation_force_intent WHERE attempt_id = ?`)
    .get(attemptId) as { attempt_id: string } | undefined;
  if (existing === undefined) {
    throw new Error(`markForceIntentApplied: no force intent row for attempt ${attemptId}`);
  }
  db.prepare(
    `UPDATE compact_continuation_force_intent
     SET status = 'reconciled', continuation_turn_id = ?
     WHERE attempt_id = ?`,
  ).run(continuationTurnId, attemptId);
}

/**
 * Find turn opened by a force turn_end event (idempotency key), if recorded.
 */
export function findContinuationTurnFromForceKey(db: DatabaseSync, turnEndIdempotencyKey: string): string | null {
  const event = db
    .prepare(
      `SELECT event_order FROM event
       WHERE idempotency_key = ? AND event_kind = 'turn_end'`,
    )
    .get(turnEndIdempotencyKey) as { event_order: number | bigint } | undefined;
  if (event === undefined) return null;
  const order = Number(event.event_order);
  // The newly opened turn has opened_at_event_order = turn_end event order.
  const turn = db
    .prepare(`SELECT turn_id FROM turns WHERE opened_at_event_order = ? ORDER BY turn_order DESC LIMIT 1`)
    .get(order) as { turn_id: string } | undefined;
  return turn?.turn_id ?? null;
}

export function readBoundary(db: DatabaseSync, continuationTurnId: string): BoundaryRow | null {
  const row = db
    .prepare(
      `SELECT continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
       FROM compact_continuation_boundary WHERE continuation_turn_id = ?`,
    )
    .get(continuationTurnId) as
    | {
        continuation_turn_id: string;
        attempt_id: string;
        status: string;
        marker_persisted: number | bigint;
        last_stage: string;
        forced_at: string;
        completed_at: string | null;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    continuationTurnId: row.continuation_turn_id,
    attemptId: row.attempt_id,
    status: row.status as BoundaryStatus,
    markerPersisted: Number(row.marker_persisted) === 1,
    lastStage: row.last_stage,
    forcedAt: row.forced_at,
    completedAt: row.completed_at,
  };
}

/**
 * Read the single unresolved boundary. Schema enforces at most one; if the
 * index is missing and multiple exist, throw (do not silently hide one).
 */
export function readPendingBoundary(db: DatabaseSync): BoundaryRow | null {
  const rows = db
    .prepare(
      `SELECT continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
       FROM compact_continuation_boundary
       WHERE status IN ('pending', 'failed_repairable')
       ORDER BY forced_at DESC`,
    )
    .all() as unknown as Array<{
    continuation_turn_id: string;
    attempt_id: string;
    status: string;
    marker_persisted: number | bigint;
    last_stage: string;
    forced_at: string;
    completed_at: string | null;
  }>;
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new Error(`compact-continuation corruption: ${rows.length} unresolved boundaries (at most one allowed)`);
  }
  const row = rows[0]!;
  return {
    continuationTurnId: row.continuation_turn_id,
    attemptId: row.attempt_id,
    status: row.status as BoundaryStatus,
    markerPersisted: Number(row.marker_persisted) === 1,
    lastStage: row.last_stage,
    forcedAt: row.forced_at,
    completedAt: row.completed_at,
  };
}

export function listBoundaries(db: DatabaseSync): BoundaryRow[] {
  const rows = db
    .prepare(
      `SELECT continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
       FROM compact_continuation_boundary ORDER BY forced_at`,
    )
    .all() as unknown as Array<{
    continuation_turn_id: string;
    attempt_id: string;
    status: string;
    marker_persisted: number | bigint;
    last_stage: string;
    forced_at: string;
    completed_at: string | null;
  }>;
  return rows.map((row) => ({
    continuationTurnId: row.continuation_turn_id,
    attemptId: row.attempt_id,
    status: row.status as BoundaryStatus,
    markerPersisted: Number(row.marker_persisted) === 1,
    lastStage: row.last_stage,
    forcedAt: row.forced_at,
    completedAt: row.completed_at,
  }));
}

export function markerExistsByIdempotencyKey(db: DatabaseSync, idempotencyKey: string): boolean {
  const row = db.prepare(`SELECT 1 AS present FROM event WHERE idempotency_key = ? LIMIT 1`).get(idempotencyKey) as
    | { present: number }
    | undefined;
  return row !== undefined;
}

export function readOpenTurnIds(db: DatabaseSync): string[] {
  const rows = db
    .prepare(`SELECT turn_id FROM turns WHERE status = 'open' ORDER BY turn_order`)
    .all() as unknown as Array<{ turn_id: string }>;
  return rows.map((row) => row.turn_id);
}

export function readOpenTurnMemberCount(db: DatabaseSync, turnId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM message WHERE turn_id = ? AND deleted_at IS NULL`).get(turnId) as
    | { n: number | bigint }
    | undefined;
  return Number(row?.n ?? 0);
}

export function maxEventOrder(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COALESCE(MAX(event_order), 0) AS m FROM event`).get() as {
    m: number | bigint;
  };
  return Number(row.m);
}

// ── Host validation (schema v11) ─────────────────────────────────────────────

export type HostValidationStatus = "awaiting" | "ok" | "failed";

export type HostValidationRow = {
  attemptId: string;
  status: HostValidationStatus;
  reason: string | null;
  recordedAt: string;
  updatedAt: string;
};

export function readHostValidation(db: DatabaseSync, attemptId: string): HostValidationRow | null {
  const row = db
    .prepare(
      `SELECT attempt_id, status, reason, recorded_at, updated_at
       FROM compact_continuation_host_validation WHERE attempt_id = ?`,
    )
    .get(attemptId) as
    | {
        attempt_id: string;
        status: string;
        reason: string | null;
        recorded_at: string;
        updated_at: string;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    attemptId: row.attempt_id,
    status: row.status as HostValidationStatus,
    reason: row.reason,
    recordedAt: row.recorded_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Record awaiting host validation after successful core install.
 * Idempotent for same attempt when already awaiting; refuses overwrite of terminal ok/failed.
 */
export function recordHostValidationAwaiting(db: DatabaseSync, attemptId: string, recordedAt: string): void {
  const existing = readHostValidation(db, attemptId);
  if (existing !== null) {
    if (existing.status === "awaiting") return;
    throw new Error(`host validation already terminal for attempt ${attemptId} (status=${existing.status})`);
  }
  db.prepare(
    `INSERT INTO compact_continuation_host_validation (attempt_id, status, reason, recorded_at, updated_at)
     VALUES (?, 'awaiting', NULL, ?, ?)`,
  ).run(attemptId, recordedAt, recordedAt);
}

/**
 * Host records full-body validation result. Does not roll back core install.
 * Only transitions from awaiting (or inserts failed/ok when missing for repair).
 */
export function recordHostValidationResult(
  db: DatabaseSync,
  attemptId: string,
  result: "ok" | "failed",
  updatedAt: string,
  reason?: string,
): HostValidationRow {
  const existing = readHostValidation(db, attemptId);
  if (existing !== null && (existing.status === "ok" || existing.status === "failed")) {
    if (existing.status === result) return existing;
    throw new Error(
      `host validation already recorded as ${existing.status} for attempt ${attemptId}; cannot set ${result}`,
    );
  }
  if (existing === null) {
    db.prepare(
      `INSERT INTO compact_continuation_host_validation (attempt_id, status, reason, recorded_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(attemptId, result, reason ?? null, updatedAt, updatedAt);
  } else {
    db.prepare(
      `UPDATE compact_continuation_host_validation
       SET status = ?, reason = ?, updated_at = ?
       WHERE attempt_id = ? AND status = 'awaiting'`,
    ).run(result, reason ?? null, updatedAt, attemptId);
  }
  const row = readHostValidation(db, attemptId);
  if (row === null) throw new Error(`host validation write failed for ${attemptId}`);
  return row;
}
