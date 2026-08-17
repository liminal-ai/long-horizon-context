/**
 * Durable governor receipt store (LIM-64).
 *
 * Structured, restart-inspectable records with deterministic replay/upsert
 * keys derived from stable native facts (session/thread, observe phase,
 * sampling ID, decision, provider/estimate pressure). Lives in the wrapper
 * lineage SQLite (`cc-lhc.sqlite`), not the append-only wrapper log alone.
 *
 * Coexistence: busy_timeout is set BEFORE journal_mode=WAL (same race lesson
 * as LHC/pi-lhc open). Insert/upsert + readback use transactions.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { defaultLineageDbPath } from "../intake/paths.js";
import { identitiesEqual, type ProcessIdentity, type ProcessLivenessResult } from "../runtime/process-identity.js";
import {
  mergeRecoveryArtifacts,
  parseRecoveryAttempt,
  RECOVERY_ATTEMPT_PAYLOAD_VERSION,
  type RecoveryArtifacts,
  type RecoveryAttempt,
  type RecoveryStage,
  recoveryStageIndex,
} from "./recovery.js";
import type { GovernorDurableReceipt, GovernorHandoffOutcome, GovernorObserveRecord } from "./types.js";

/** Cross-process lock wait (ms). Matches LHC open-database busy timeout spirit. */
export const GOVERNOR_RECEIPT_BUSY_TIMEOUT_MS = 10_000;

export interface GovernorReceiptStoreDeps {
  openDbFn?: (path: string) => DatabaseSync;
  mkdirFn?: (path: string) => void;
  nowFn?: () => Date;
  uuidFn?: () => string;
}

export interface AppendObserveResult {
  receipt: GovernorDurableReceipt;
  /** True when a new row was inserted; false when exact replay returned existing. */
  inserted: boolean;
}

function defaultDeps(): Required<GovernorReceiptStoreDeps> {
  return {
    openDbFn: (path: string) => new DatabaseSync(path),
    mkdirFn: (path: string) => {
      mkdirSync(path, { recursive: true });
    },
    nowFn: () => new Date(),
    uuidFn: () => randomUUID(),
  };
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function initSchema(db: DatabaseSync): void {
  // busy_timeout FIRST so concurrent lineage/receipt openers wait instead of
  // instant SQLITE_BUSY while journal_mode=WAL takes its brief write lock.
  db.exec(`PRAGMA busy_timeout = ${GOVERNOR_RECEIPT_BUSY_TIMEOUT_MS}`);
  const modeRow = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
  const mode = String(modeRow?.journal_mode ?? "").toLowerCase();
  if (mode !== "wal") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_governor_receipts (
      receipt_id TEXT PRIMARY KEY,
      session_id TEXT,
      thread_id TEXT,
      observe_sequence INTEGER NOT NULL,
      settle_sequence INTEGER,
      capture_generation INTEGER NOT NULL,
      decision TEXT NOT NULL,
      would_mutate INTEGER NOT NULL,
      observe_phase TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  // Additive, idempotent migration: stable native replay key for restart/re-tail.
  if (!tableHasColumn(db, "cc_governor_receipts", "replay_key")) {
    db.exec(`ALTER TABLE cc_governor_receipts ADD COLUMN replay_key TEXT`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_governor_receipts_replay_key
      ON cc_governor_receipts(replay_key)
      WHERE replay_key IS NOT NULL
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cc_governor_receipts_session
      ON cc_governor_receipts(session_id, observe_sequence)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cc_governor_receipts_settle
      ON cc_governor_receipts(session_id, settle_sequence)
  `);
  // Additive (LIM-80 Slice 1): one durable attempt row per receipt. Old
  // databases simply have no rows here, which reads as "unclaimed" work.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_governor_attempts (
      receipt_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      claim_epoch INTEGER NOT NULL,
      stage TEXT NOT NULL,
      payload_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cc_governor_attempts_stage
      ON cc_governor_attempts(stage)
  `);
}

/**
 * Deterministic identity for one classification. Uses only stable native facts
 * that survive process restart — not observeSequence, settleSequence, or
 * captureGeneration (those can reset on restart / re-tail).
 */
export function governorReceiptReplayKey(args: {
  observe: GovernorObserveRecord;
  sessionId?: string | null;
  threadId?: string | null;
}): string {
  const o = args.observe;
  const pressure = o.pressure;
  const parts = [
    args.sessionId ?? "",
    args.threadId ?? "",
    o.observePhase,
    o.samplingId ?? "",
    o.decision,
    o.wouldMutate ? "1" : "0",
    o.providerContextTotal === null ? "null" : String(o.providerContextTotal),
    String(o.postMeasurementEstimate.tokens),
    o.postMeasurementEstimate.source,
    o.postMeasurementEstimate.domain,
    pressure.nextRequestPressureTokens === null ? "null" : String(pressure.nextRequestPressureTokens),
    String(pressure.upperTriggerTokens),
    pressure.atOrAboveTrigger === null ? "null" : pressure.atOrAboveTrigger ? "1" : "0",
    String(o.upperBoundTokens),
    String(o.lowerBoundTokens),
    o.profile,
    o.hostCapability,
  ];
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

/** Terminal handoff/mutation outcomes that must survive exact replay. */
export function isTerminalHandoffOutcome(outcome: GovernorHandoffOutcome | null | undefined): boolean {
  if (outcome === null || outcome === undefined) return false;
  switch (outcome.kind) {
    case "handoff_success":
    case "handoff_cancelled":
    case "handoff_rolled_back":
    case "handoff_failed":
    case "mutation_refused":
    case "mutation_deferred":
    case "mutation_partial":
    case "mutation_noop":
    case "deferred_open_turn":
    case "not_applicable":
      return true;
    case "scheduled":
      // Only non-terminal: an operation owns the receipt, or the wrapper died
      // somewhere between insert and a terminal outcome. Which stage it died at
      // is recorded in the attempt row (LIM-80); see recovery.ts planRecovery.
      return false;
    default:
      return false;
  }
}

/** Result of a compare-and-set claim/reclaim on a receipt's attempt row. */
export type ClaimAttemptResult =
  | { kind: "claimed"; attempt: RecoveryAttempt }
  | { kind: "reclaimed"; attempt: RecoveryAttempt; previousAttemptId: string }
  /** The caller already owns the current attempt (same identity); returned as-is. */
  | { kind: "already_owned"; attempt: RecoveryAttempt }
  /** A foreign owner holds it and no kernel-proven death was supplied: wait. */
  | { kind: "held"; attempt: RecoveryAttempt; ownerLiveness: "ok" | "indeterminate" | "unprobed" }
  /** Reclaim requested against a stale attemptId: someone else moved first. */
  | { kind: "stale_expectation"; attempt: RecoveryAttempt }
  | { kind: "terminal"; attempt: RecoveryAttempt }
  | { kind: "receipt_missing" }
  /** Receipt already carries a terminal outcome; nothing to claim. */
  | { kind: "receipt_terminal"; outcome: GovernorHandoffOutcome };

export type AdvanceAttemptResult =
  | { kind: "advanced"; attempt: RecoveryAttempt }
  /** Same stage written again: idempotent no-op. */
  | { kind: "unchanged"; attempt: RecoveryAttempt }
  | { kind: "not_owner"; attempt: RecoveryAttempt }
  | { kind: "stage_regression"; attempt: RecoveryAttempt; requested: RecoveryStage }
  | { kind: "artifact_conflict"; attempt: RecoveryAttempt; conflictKey: keyof RecoveryArtifacts }
  | { kind: "terminal"; attempt: RecoveryAttempt }
  | { kind: "attempt_missing" };

export type CompleteAttemptResult =
  | { kind: "completed"; attempt: RecoveryAttempt; receipt: GovernorDurableReceipt }
  | { kind: "not_owner"; attempt: RecoveryAttempt }
  | { kind: "already_terminal"; attempt: RecoveryAttempt }
  | { kind: "attempt_missing" }
  | { kind: "receipt_missing" };

export interface GovernorReceiptStore {
  readonly path: string;
  /**
   * Persist a classification. Exact native replay returns the existing receipt
   * (preserves terminal handoff outcome). Concurrent inserts cannot duplicate.
   */
  appendObserve(args: {
    observe: GovernorObserveRecord;
    sessionId?: string | null;
    threadId?: string | null;
  }): AppendObserveResult;
  /** Attach a handoff/mutation outcome to an exact receipt id only. */
  attachHandoffOutcome(receiptId: string, outcome: GovernorHandoffOutcome): GovernorDurableReceipt | null;
  listBySession(sessionId: string): GovernorDurableReceipt[];
  listAll(): GovernorDurableReceipt[];
  getById(receiptId: string): GovernorDurableReceipt | null;
  /** Durable attempt for a receipt, or null when never claimed (legacy/pre-claim). */
  getAttempt(receiptId: string): RecoveryAttempt | null;
  /** All attempts not yet terminal (restart inspection). */
  listOpenAttempts(): RecoveryAttempt[];
  /**
   * Compare-and-set claim of a receipt's work. With no attempt row: inserts one
   * at `operation_claimed` owned by `owner`. With an existing row owned by a
   * different identity: returns `held` unless `reclaim` supplies the expected
   * attemptId AND a kernel-proven `not_found` liveness for that owner, in
   * which case ownership moves (new attemptId, claimEpoch+1) while stage and
   * artifacts are preserved. Indeterminate/live owners are never stolen.
   */
  claimAttempt(args: {
    receiptId: string;
    owner: ProcessIdentity;
    reclaim?: { expectedAttemptId: string; ownerLiveness: ProcessLivenessResult };
  }): ClaimAttemptResult;
  /**
   * Advance the owned attempt to a later stage, merging artifact identities.
   * Rejects a stage regression, an artifact value that contradicts a stored
   * one, a non-owner attemptId, and writes to a terminal attempt.
   */
  advanceAttempt(args: {
    receiptId: string;
    attemptId: string;
    stage: Exclude<RecoveryStage, "terminal">;
    artifacts?: RecoveryArtifacts;
  }): AdvanceAttemptResult;
  /**
   * Terminalize the owned attempt AND attach the receipt's handoff outcome in
   * one transaction, so restart can never see one without the other.
   */
  completeAttempt(args: {
    receiptId: string;
    attemptId: string;
    outcome: Exclude<GovernorHandoffOutcome, { kind: "scheduled" }>;
  }): CompleteAttemptResult;
  /**
   * Close the underlying connection. Errors are not swallowed — evidence and
   * coexistence tests need truthful close failures.
   */
  close(): void;
}

function parsePayload(json: string): GovernorDurableReceipt {
  return JSON.parse(json) as GovernorDurableReceipt;
}

function initialHandoffOutcome(observe: GovernorObserveRecord): GovernorHandoffOutcome {
  if (observe.observePhase === "open_turn" && observe.decision === "would_compact") {
    return { kind: "deferred_open_turn" };
  }
  if (observe.wouldMutate) {
    return { kind: "scheduled" };
  }
  return { kind: "not_applicable" };
}

function materializeReceipt(args: {
  receiptId: string;
  observe: GovernorObserveRecord;
  sessionId: string | null;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
  handoffOutcome?: GovernorHandoffOutcome;
}): GovernorDurableReceipt {
  const observe = args.observe;
  return {
    receiptId: args.receiptId,
    sessionId: args.sessionId,
    threadId: args.threadId,
    observePhase: observe.observePhase,
    decision: observe.decision,
    reason: observe.reason,
    wouldMutate: observe.wouldMutate,
    hostCapability: observe.hostCapability,
    providerContextTotal: observe.providerContextTotal,
    postMeasurementEstimate: observe.postMeasurementEstimate,
    pressure: observe.pressure,
    captureGeneration: observe.captureGeneration,
    inputEpoch: observe.inputEpoch,
    inputEpochAtTurnOpen: observe.inputEpochAtTurnOpen,
    observeSequence: observe.observeSequence,
    settleSequence: observe.settleSequence,
    samplingId: observe.samplingId,
    handoffOutcome: args.handoffOutcome ?? initialHandoffOutcome(observe),
    observe,
    createdAt: args.createdAt,
    updatedAt: args.updatedAt,
  };
}

/**
 * Open (or create) the durable governor receipt store under the lineage DB path.
 * Schema is additive; coexists with lineage tables in the same file when path
 * points at `cc-lhc.sqlite`.
 */
export function openGovernorReceiptStore(
  dbPath: string = defaultLineageDbPath(),
  deps: GovernorReceiptStoreDeps = {},
): GovernorReceiptStore {
  const merged = { ...defaultDeps(), ...deps };
  merged.mkdirFn(dirname(dbPath));
  const db = merged.openDbFn(dbPath);
  initSchema(db);

  const insert = db.prepare(`
    INSERT INTO cc_governor_receipts (
      receipt_id, session_id, thread_id, observe_sequence, settle_sequence,
      capture_generation, decision, would_mutate, observe_phase, payload_json,
      created_at, updated_at, replay_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updatePayload = db.prepare(`
    UPDATE cc_governor_receipts
    SET payload_json = ?, updated_at = ?
    WHERE receipt_id = ?
  `);

  const selectById = db.prepare(`
    SELECT payload_json FROM cc_governor_receipts WHERE receipt_id = ?
  `);

  const selectByReplayKey = db.prepare(`
    SELECT payload_json FROM cc_governor_receipts WHERE replay_key = ?
  `);

  const selectBySession = db.prepare(`
    SELECT payload_json FROM cc_governor_receipts
    WHERE session_id = ?
    ORDER BY created_at ASC, observe_sequence ASC
  `);

  const selectAll = db.prepare(`
    SELECT payload_json FROM cc_governor_receipts
    ORDER BY created_at ASC, observe_sequence ASC
  `);

  const attemptColumns = `
    receipt_id, attempt_id, claim_epoch, stage, payload_version,
    payload_json, created_at, updated_at
  `;
  const selectAttempt = db.prepare(`
    SELECT ${attemptColumns} FROM cc_governor_attempts WHERE receipt_id = ?
  `);
  const selectAllAttempts = db.prepare(`
    SELECT ${attemptColumns} FROM cc_governor_attempts
    ORDER BY created_at ASC, receipt_id ASC
  `);
  const insertAttempt = db.prepare(`
    INSERT INTO cc_governor_attempts (
      receipt_id, attempt_id, claim_epoch, stage, payload_version, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateAttempt = db.prepare(`
    UPDATE cc_governor_attempts
    SET attempt_id = ?, claim_epoch = ?, stage = ?, payload_json = ?, updated_at = ?
    WHERE receipt_id = ? AND attempt_id = ?
  `);

  type AttemptRow = {
    receipt_id: string;
    attempt_id: string;
    claim_epoch: number;
    stage: string;
    payload_version: number;
    payload_json: string;
    created_at: string;
    updated_at: string;
  };

  const parseAttemptRow = (row: AttemptRow): RecoveryAttempt => {
    if (row.payload_version !== RECOVERY_ATTEMPT_PAYLOAD_VERSION) {
      throw new Error(
        `cc-lhc governor attempt row for receipt ${row.receipt_id} has unsupported payload version ${row.payload_version}`,
      );
    }
    const parsed = parseRecoveryAttempt(JSON.parse(row.payload_json));
    const columnsMatch =
      parsed !== null &&
      parsed.receiptId === row.receipt_id &&
      parsed.attemptId === row.attempt_id &&
      parsed.claimEpoch === row.claim_epoch &&
      parsed.stage === row.stage &&
      parsed.createdAt === row.created_at &&
      parsed.updatedAt === row.updated_at;
    if (!columnsMatch) {
      throw new Error(`cc-lhc governor attempt row for receipt ${row.receipt_id} is malformed`);
    }
    return parsed;
  };

  const readAttempt = (receiptId: string): RecoveryAttempt | null => {
    const row = selectAttempt.get(receiptId) as AttemptRow | undefined;
    if (row === undefined) return null;
    return parseAttemptRow(row);
  };

  /** Write an attempt row with CAS on the attempt id currently stored. */
  const writeAttempt = (next: RecoveryAttempt, expectedAttemptId: string): void => {
    const result = updateAttempt.run(
      next.attemptId,
      next.claimEpoch,
      next.stage,
      JSON.stringify(next),
      next.updatedAt,
      next.receiptId,
      expectedAttemptId,
    );
    if (result.changes !== 1) {
      throw new Error(
        `cc-lhc governor attempt CAS failed for receipt ${next.receiptId} (expected attempt ${expectedAttemptId})`,
      );
    }
  };

  const begin = db.prepare("BEGIN IMMEDIATE");
  const commit = db.prepare("COMMIT");
  const rollback = db.prepare("ROLLBACK");

  const runInTx = <T>(fn: () => T): T => {
    begin.run();
    try {
      const result = fn();
      commit.run();
      return result;
    } catch (cause) {
      try {
        rollback.run();
      } catch {
        // already rolled back or no active transaction
      }
      throw cause;
    }
  };

  const store: GovernorReceiptStore = {
    path: dbPath,
    appendObserve({ observe, sessionId = null, threadId = null }) {
      const replayKey = governorReceiptReplayKey({ observe, sessionId, threadId });
      return runInTx(() => {
        const existing = selectByReplayKey.get(replayKey) as { payload_json: string } | undefined;
        if (existing !== undefined) {
          // Exact replay: return existing row, preserve terminal handoff outcome.
          return { receipt: parsePayload(existing.payload_json), inserted: false };
        }

        const now = merged.nowFn().toISOString();
        const receiptId = merged.uuidFn();
        const receipt = materializeReceipt({
          receiptId,
          observe,
          sessionId,
          threadId,
          createdAt: now,
          updatedAt: now,
        });
        try {
          insert.run(
            receiptId,
            sessionId,
            threadId,
            observe.observeSequence,
            observe.settleSequence,
            observe.captureGeneration,
            observe.decision,
            observe.wouldMutate ? 1 : 0,
            observe.observePhase,
            JSON.stringify(receipt),
            now,
            now,
            replayKey,
          );
        } catch (cause) {
          // Concurrent append: unique index wins; re-read winner.
          const raced = selectByReplayKey.get(replayKey) as { payload_json: string } | undefined;
          if (raced !== undefined) {
            return { receipt: parsePayload(raced.payload_json), inserted: false };
          }
          throw cause;
        }
        const readBack = selectById.get(receiptId) as { payload_json: string } | undefined;
        if (readBack === undefined) {
          throw new Error(`cc-lhc governor receipt insert failed readback for ${receiptId}`);
        }
        return { receipt: parsePayload(readBack.payload_json), inserted: true };
      });
    },
    attachHandoffOutcome(receiptId, outcome) {
      return runInTx(() => {
        const row = selectById.get(receiptId) as { payload_json: string } | undefined;
        if (row === undefined) return null;
        const receipt = parsePayload(row.payload_json);
        const now = merged.nowFn().toISOString();
        const updated: GovernorDurableReceipt = {
          ...receipt,
          handoffOutcome: outcome,
          updatedAt: now,
        };
        updatePayload.run(JSON.stringify(updated), now, receiptId);
        const readBack = selectById.get(receiptId) as { payload_json: string } | undefined;
        return readBack === undefined ? null : parsePayload(readBack.payload_json);
      });
    },
    listBySession(sessionId) {
      const rows = selectBySession.all(sessionId) as Array<{ payload_json: string }>;
      return rows.map((r) => parsePayload(r.payload_json));
    },
    listAll() {
      const rows = selectAll.all() as Array<{ payload_json: string }>;
      return rows.map((r) => parsePayload(r.payload_json));
    },
    getById(receiptId) {
      const row = selectById.get(receiptId) as { payload_json: string } | undefined;
      if (row === undefined) return null;
      return parsePayload(row.payload_json);
    },
    getAttempt(receiptId) {
      return readAttempt(receiptId);
    },
    listOpenAttempts() {
      // Parse every row before filtering. Trusting the duplicated SQL `stage`
      // column in the WHERE clause could hide a malformed payload whose column
      // falsely says terminal, defeating restart inspection.
      const rows = selectAllAttempts.all() as AttemptRow[];
      return rows.map(parseAttemptRow).filter((attempt) => attempt.stage !== "terminal");
    },
    claimAttempt({ receiptId, owner, reclaim }) {
      return runInTx((): ClaimAttemptResult => {
        const receiptRow = selectById.get(receiptId) as { payload_json: string } | undefined;
        if (receiptRow === undefined) return { kind: "receipt_missing" };
        const receipt = parsePayload(receiptRow.payload_json);
        if (receipt.handoffOutcome !== null && receipt.handoffOutcome.kind !== "scheduled") {
          return { kind: "receipt_terminal", outcome: receipt.handoffOutcome };
        }
        const now = merged.nowFn().toISOString();
        const existing = readAttempt(receiptId);
        if (existing === null) {
          const attempt: RecoveryAttempt = {
            receiptId,
            attemptId: merged.uuidFn(),
            claimEpoch: 1,
            owner,
            stage: "operation_claimed",
            artifacts: {},
            terminalOutcomeKind: null,
            claimedAt: now,
            stageUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
          };
          // Inside BEGIN IMMEDIATE the read above is authoritative; a PK
          // violation here would be a real defect and surfaces as a throw.
          insertAttempt.run(
            receiptId,
            attempt.attemptId,
            attempt.claimEpoch,
            attempt.stage,
            RECOVERY_ATTEMPT_PAYLOAD_VERSION,
            JSON.stringify(attempt),
            now,
            now,
          );
          return { kind: "claimed", attempt };
        }
        if (existing.stage === "terminal") return { kind: "terminal", attempt: existing };
        if (identitiesEqual(existing.owner, owner)) return { kind: "already_owned", attempt: existing };
        if (reclaim === undefined) return { kind: "held", attempt: existing, ownerLiveness: "unprobed" };
        if (reclaim.expectedAttemptId !== existing.attemptId) {
          return { kind: "stale_expectation", attempt: existing };
        }
        const liveness = reclaim.ownerLiveness;
        if (liveness.ok) return { kind: "held", attempt: existing, ownerLiveness: "ok" };
        if (liveness.code !== "not_found") return { kind: "held", attempt: existing, ownerLiveness: "indeterminate" };
        // Kernel-proven dead owner: move ownership, keep durable progress.
        const reclaimed: RecoveryAttempt = {
          ...existing,
          attemptId: merged.uuidFn(),
          claimEpoch: existing.claimEpoch + 1,
          owner,
          claimedAt: now,
          updatedAt: now,
        };
        writeAttempt(reclaimed, existing.attemptId);
        return { kind: "reclaimed", attempt: reclaimed, previousAttemptId: existing.attemptId };
      });
    },
    advanceAttempt({ receiptId, attemptId, stage, artifacts }) {
      return runInTx((): AdvanceAttemptResult => {
        const existing = readAttempt(receiptId);
        if (existing === null) return { kind: "attempt_missing" };
        if (existing.attemptId !== attemptId) return { kind: "not_owner", attempt: existing };
        if (existing.stage === "terminal") return { kind: "terminal", attempt: existing };
        const currentIndex = recoveryStageIndex(existing.stage);
        const requestedIndex = recoveryStageIndex(stage);
        if (requestedIndex < currentIndex) {
          return { kind: "stage_regression", attempt: existing, requested: stage };
        }
        const mergedArtifacts = mergeRecoveryArtifacts(existing.artifacts, artifacts ?? {});
        if (!mergedArtifacts.ok) {
          return { kind: "artifact_conflict", attempt: existing, conflictKey: mergedArtifacts.conflictKey };
        }
        const artifactsChanged = JSON.stringify(mergedArtifacts.artifacts) !== JSON.stringify(existing.artifacts);
        if (requestedIndex === currentIndex && !artifactsChanged) {
          return { kind: "unchanged", attempt: existing };
        }
        const now = merged.nowFn().toISOString();
        const next: RecoveryAttempt = {
          ...existing,
          stage,
          artifacts: mergedArtifacts.artifacts,
          stageUpdatedAt: requestedIndex === currentIndex ? existing.stageUpdatedAt : now,
          updatedAt: now,
        };
        writeAttempt(next, attemptId);
        return { kind: "advanced", attempt: next };
      });
    },
    completeAttempt({ receiptId, attemptId, outcome }) {
      return runInTx((): CompleteAttemptResult => {
        const existing = readAttempt(receiptId);
        if (existing === null) return { kind: "attempt_missing" };
        if (existing.attemptId !== attemptId) return { kind: "not_owner", attempt: existing };
        if (existing.stage === "terminal") return { kind: "already_terminal", attempt: existing };
        const receiptRow = selectById.get(receiptId) as { payload_json: string } | undefined;
        if (receiptRow === undefined) return { kind: "receipt_missing" };
        const now = merged.nowFn().toISOString();
        const next: RecoveryAttempt = {
          ...existing,
          stage: "terminal",
          terminalOutcomeKind: outcome.kind,
          stageUpdatedAt: now,
          updatedAt: now,
        };
        writeAttempt(next, attemptId);
        const receipt = parsePayload(receiptRow.payload_json);
        const updatedReceipt: GovernorDurableReceipt = { ...receipt, handoffOutcome: outcome, updatedAt: now };
        updatePayload.run(JSON.stringify(updatedReceipt), now, receiptId);
        return { kind: "completed", attempt: next, receipt: updatedReceipt };
      });
    },
    close() {
      db.close();
    },
  };

  return store;
}

/** Pure helper for tests: build a receipt without opening SQLite. */
export function materializeGovernorReceipt(args: {
  observe: GovernorObserveRecord;
  sessionId?: string | null;
  threadId?: string | null;
  receiptId?: string;
  createdAt?: string;
}): GovernorDurableReceipt {
  const now = args.createdAt ?? new Date().toISOString();
  return materializeReceipt({
    receiptId: args.receiptId ?? "test-receipt",
    observe: args.observe,
    sessionId: args.sessionId ?? null,
    threadId: args.threadId ?? null,
    createdAt: now,
    updatedAt: now,
  });
}
