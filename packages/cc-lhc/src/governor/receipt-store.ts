/**
 * Durable governor receipt store (LIM-64).
 *
 * Structured, restart-inspectable records tied to observe sequence, settle
 * sequence, capture generation, usage/estimate, and optional handoff outcome.
 * Lives in the wrapper lineage SQLite (`cc-lhc.sqlite`), not the append-only
 * wrapper log alone.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { defaultLineageDbPath } from "../intake/paths.js";
import type { GovernorDurableReceipt, GovernorHandoffOutcome, GovernorObserveRecord } from "./types.js";

export interface GovernorReceiptStoreDeps {
  openDbFn?: (path: string) => DatabaseSync;
  mkdirFn?: (path: string) => void;
  nowFn?: () => Date;
  uuidFn?: () => string;
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

function initSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
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
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cc_governor_receipts_session
      ON cc_governor_receipts(session_id, observe_sequence)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cc_governor_receipts_settle
      ON cc_governor_receipts(session_id, settle_sequence)
  `);
}

export interface GovernorReceiptStore {
  readonly path: string;
  /** Persist a new observe classification. Returns the durable receipt. */
  appendObserve(args: {
    observe: GovernorObserveRecord;
    sessionId?: string | null;
    threadId?: string | null;
  }): GovernorDurableReceipt;
  /** Attach a handoff/mutation outcome to an existing receipt (by id). */
  attachHandoffOutcome(receiptId: string, outcome: GovernorHandoffOutcome): GovernorDurableReceipt | null;
  /** Attach outcome to the most recent would_mutate receipt for a session. */
  attachHandoffOutcomeToLatestWouldMutate(
    sessionId: string | null | undefined,
    outcome: GovernorHandoffOutcome,
  ): GovernorDurableReceipt | null;
  listBySession(sessionId: string): GovernorDurableReceipt[];
  listAll(): GovernorDurableReceipt[];
  getById(receiptId: string): GovernorDurableReceipt | null;
  close(): void;
}

function parsePayload(json: string): GovernorDurableReceipt {
  return JSON.parse(json) as GovernorDurableReceipt;
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
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updatePayload = db.prepare(`
    UPDATE cc_governor_receipts
    SET payload_json = ?, updated_at = ?
    WHERE receipt_id = ?
  `);

  const selectById = db.prepare(`
    SELECT payload_json FROM cc_governor_receipts WHERE receipt_id = ?
  `);

  const selectBySession = db.prepare(`
    SELECT payload_json FROM cc_governor_receipts
    WHERE session_id = ?
    ORDER BY observe_sequence ASC, created_at ASC
  `);

  const selectAll = db.prepare(`
    SELECT payload_json FROM cc_governor_receipts
    ORDER BY created_at ASC, observe_sequence ASC
  `);

  const selectLatestWouldMutate = db.prepare(`
    SELECT payload_json FROM cc_governor_receipts
    WHERE would_mutate = 1
      AND (? IS NULL OR session_id = ? OR session_id IS NULL)
    ORDER BY observe_sequence DESC, created_at DESC
    LIMIT 1
  `);

  const store: GovernorReceiptStore = {
    path: dbPath,
    appendObserve({ observe, sessionId = null, threadId = null }) {
      const now = merged.nowFn().toISOString();
      const receiptId = merged.uuidFn();
      const receipt: GovernorDurableReceipt = {
        receiptId,
        sessionId,
        threadId,
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
        handoffOutcome:
          observe.observePhase === "open_turn" && observe.decision === "would_compact"
            ? { kind: "deferred_open_turn" }
            : observe.wouldMutate
              ? { kind: "scheduled" }
              : { kind: "not_applicable" },
        observe,
        createdAt: now,
        updatedAt: now,
      };
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
      );
      return receipt;
    },
    attachHandoffOutcome(receiptId, outcome) {
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
      return updated;
    },
    attachHandoffOutcomeToLatestWouldMutate(sessionId, outcome) {
      const sid = sessionId ?? null;
      const row = selectLatestWouldMutate.get(sid, sid) as { payload_json: string } | undefined;
      if (row === undefined) return null;
      const receipt = parsePayload(row.payload_json);
      return store.attachHandoffOutcome(receipt.receiptId, outcome);
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
    close() {
      try {
        db.close();
      } catch {
        // best effort
      }
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
  const observe = args.observe;
  return {
    receiptId: args.receiptId ?? "test-receipt",
    sessionId: args.sessionId ?? null,
    threadId: args.threadId ?? null,
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
    handoffOutcome:
      observe.observePhase === "open_turn" && observe.decision === "would_compact"
        ? { kind: "deferred_open_turn" }
        : observe.wouldMutate
          ? { kind: "scheduled" }
          : { kind: "not_applicable" },
    observe,
    createdAt: now,
    updatedAt: now,
  };
}
