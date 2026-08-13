// Durable compact-continuation writer claim and receipt rows (schema v7).
// Domain-owned table access only — no ad hoc SQL outside this module.

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

export function readWriterClaim(db: DatabaseSync): WriterClaimRow {
  const row = db
    .prepare(`SELECT claim, attempt_id, claimed_at FROM compact_continuation_writer WHERE singleton = 1`)
    .get() as { claim: string; attempt_id: string | null; claimed_at: string | null } | undefined;
  if (row === undefined) {
    // Fresh migrate always seeds the singleton; missing row is corrupt.
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
 * Returns false when another claim is held (or held by a different attempt).
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

/**
 * Release the LHC writer for this attempt. No-op when already free or held
 * by a different attempt (truthful: only the owner may release).
 */
export function releaseLhcWriter(db: DatabaseSync, attemptId: string): void {
  db.prepare(
    `UPDATE compact_continuation_writer
     SET claim = 'none', attempt_id = NULL, claimed_at = NULL
     WHERE singleton = 1 AND claim = 'lhc' AND attempt_id = ?`,
  ).run(attemptId);
}

/**
 * Force-clear the writer claim (test / recovery). Production runtime uses
 * releaseLhcWriter with the owning attempt id.
 */
export function forceClearWriter(db: DatabaseSync): void {
  db.prepare(
    `UPDATE compact_continuation_writer
     SET claim = 'none', attempt_id = NULL, claimed_at = NULL
     WHERE singleton = 1`,
  ).run();
}

export type StoredCompactContinuationReceipt = {
  attemptId: string;
  recordedAt: string;
  outcome: string;
  reasonCode: string;
  refused: boolean;
  skipped: boolean;
  continuationTurnId: string | null;
  receipt: CompactContinuationReceipt;
  decision: CompactContinuationDecision;
};

export function upsertReceipt(
  db: DatabaseSync,
  attemptId: string,
  recordedAt: string,
  decision: CompactContinuationDecision,
): void {
  db.prepare(
    `INSERT INTO compact_continuation_receipt (
       attempt_id, recorded_at, outcome, reason_code, refused, skipped,
       continuation_turn_id, receipt_json, decision_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(attempt_id) DO UPDATE SET
       recorded_at = excluded.recorded_at,
       outcome = excluded.outcome,
       reason_code = excluded.reason_code,
       refused = excluded.refused,
       skipped = excluded.skipped,
       continuation_turn_id = excluded.continuation_turn_id,
       receipt_json = excluded.receipt_json,
       decision_json = excluded.decision_json`,
  ).run(
    attemptId,
    recordedAt,
    decision.receipt.outcome,
    decision.receipt.reasonCode,
    decision.receipt.refused ? 1 : 0,
    decision.receipt.skipped ? 1 : 0,
    decision.receipt.residual.continuationTurnId,
    JSON.stringify(decision.receipt),
    JSON.stringify(decision),
  );
}

export function readReceiptByAttemptId(db: DatabaseSync, attemptId: string): StoredCompactContinuationReceipt | null {
  const row = db
    .prepare(
      `SELECT attempt_id, recorded_at, outcome, reason_code, refused, skipped,
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
        continuation_turn_id: string | null;
        receipt_json: string;
        decision_json: string;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    attemptId: row.attempt_id,
    recordedAt: row.recorded_at,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    refused: Number(row.refused) === 1,
    skipped: Number(row.skipped) === 1,
    continuationTurnId: row.continuation_turn_id,
    receipt: JSON.parse(row.receipt_json) as CompactContinuationReceipt,
    decision: JSON.parse(row.decision_json) as CompactContinuationDecision,
  };
}

export function listReceipts(db: DatabaseSync, limit = 50): StoredCompactContinuationReceipt[] {
  const rows = db
    .prepare(
      `SELECT attempt_id, recorded_at, outcome, reason_code, refused, skipped,
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
    continuation_turn_id: string | null;
    receipt_json: string;
    decision_json: string;
  }>;
  return rows.map((row) => ({
    attemptId: row.attempt_id,
    recordedAt: row.recorded_at,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    refused: Number(row.refused) === 1,
    skipped: Number(row.skipped) === 1,
    continuationTurnId: row.continuation_turn_id,
    receipt: JSON.parse(row.receipt_json) as CompactContinuationReceipt,
    decision: JSON.parse(row.decision_json) as CompactContinuationDecision,
  }));
}

/** True when the boundary-keyed marker event exists (idempotency key match). */
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
