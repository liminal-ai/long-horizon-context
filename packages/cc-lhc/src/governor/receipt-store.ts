import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { defaultLineageDbPath } from "../intake/paths.js";
import type { GovernorDurableReceipt, GovernorHandoffOutcome, GovernorObserveRecord } from "./types.js";

export const GOVERNOR_RECEIPT_BUSY_TIMEOUT_MS = 10_000;

export interface GovernorReceiptStoreDeps {
  openDbFn?: (path: string) => DatabaseSync;
  mkdirFn?: (path: string) => void;
  nowFn?: () => Date;
  uuidFn?: () => string;
}

export interface AppendObserveResult {
  receipt: GovernorDurableReceipt;
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
}

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

export function isTerminalHandoffOutcome(outcome: GovernorHandoffOutcome | null | undefined): boolean {
  if (outcome === null || outcome === undefined) return false;
  switch (outcome.kind) {
    case "handoff_success":
    case "handoff_cancelled":
    case "handoff_replacement_nonviable":
    case "mutation_refused":
    case "mutation_deferred":
    case "mutation_partial":
    case "mutation_noop":
    case "deferred_open_turn":
    case "not_applicable":
      return true;
    case "scheduled":
      return false;
    default:
      return false;
  }
}

export interface GovernorReceiptStore {
  readonly path: string;
  appendObserve(args: {
    observe: GovernorObserveRecord;
    sessionId?: string | null;
    threadId?: string | null;
  }): AppendObserveResult;
  attachHandoffOutcome(receiptId: string, outcome: GovernorHandoffOutcome): GovernorDurableReceipt | null;
  listBySession(sessionId: string): GovernorDurableReceipt[];
  listAll(): GovernorDurableReceipt[];
  getById(receiptId: string): GovernorDurableReceipt | null;
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

export function openGovernorReceiptStore(
  dbPath: string = defaultLineageDbPath(),
  deps: GovernorReceiptStoreDeps = {},
): GovernorReceiptStore {
  const merged = { ...defaultDeps(), ...deps };
  merged.mkdirFn(dirname(dbPath));
  const db = merged.openDbFn(dbPath);
  try {
    initSchema(db);
  } catch (cause) {
    try {
      db.close();
    } catch {}
    throw cause;
  }

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
      } catch {}
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
    close() {
      db.close();
    },
  };

  return store;
}

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
