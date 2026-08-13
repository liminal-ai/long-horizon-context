// Durable compact-continuation writer, boundary status, stage log, receipts.
// Domain-owned table access only — no ad hoc SQL outside this module.
// Schema v8: terminal receipts (no LWW overwrite), append-only stage log.

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
  | "force_turn_end"
  | "compact_prepared"
  | "marker_persisted"
  | "install_succeeded"
  | "install_failed"
  | "compact_failed"
  | "receipt_recorded"
  | "writer_released"
  | "interrupted";

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
  db.prepare(
    `INSERT INTO compact_continuation_boundary (
       continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(continuation_turn_id) DO UPDATE SET
       attempt_id = excluded.attempt_id,
       status = excluded.status,
       marker_persisted = excluded.marker_persisted,
       last_stage = excluded.last_stage,
       completed_at = excluded.completed_at`,
  ).run(
    row.continuationTurnId,
    row.attemptId,
    row.status,
    row.markerPersisted ? 1 : 0,
    row.lastStage,
    row.forcedAt,
    row.completedAt ?? null,
  );
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

export function readPendingBoundary(db: DatabaseSync): BoundaryRow | null {
  const row = db
    .prepare(
      `SELECT continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
       FROM compact_continuation_boundary
       WHERE status IN ('pending', 'failed_repairable')
       ORDER BY forced_at DESC
       LIMIT 1`,
    )
    .get() as
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
