/**
 * Evidence-only durable handoff receipts (LIM-116).
 *
 * `cc_handoff_receipts` in host-local `cc-lhc.sqlite` is the sole persisted
 * authority for old-child cleanup classification. It never drives mutation,
 * routing, recovery, or replay. Governor receipts may reference `handoffId`
 * and terminal success; they do not copy cleanup kind, pid, or detail.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ContextMutationOperation } from "../commands/context-mutation.js";
import { defaultLineageDbPath } from "../intake/paths.js";
import type { OldChildCleanup } from "./old-child-cleanup.js";

export const HANDOFF_RECEIPT_BUSY_TIMEOUT_MS = 10_000;

export type HandoffTerminalDisposition = "success" | "failed_before_switch";

export interface DurableHandoffReceipt {
  handoffId: string;
  operation: ContextMutationOperation;
  oldSessionId: string;
  newSessionId: string;
  preparedAt: string;
  terminalDisposition: HandoffTerminalDisposition | null;
  cleanupKind: OldChildCleanup["kind"] | null;
  cleanupPid: number | null;
  detail: string | null;
  completedAt: string | null;
}

export interface HandoffReceiptStoreDeps {
  openDbFn?: (path: string) => DatabaseSync;
  mkdirFn?: (path: string) => void;
  nowFn?: () => Date;
}

export interface HandoffReceiptStore {
  readonly path: string;
  insertPrepared(row: DurableHandoffReceipt): DurableHandoffReceipt;
  update(row: DurableHandoffReceipt): DurableHandoffReceipt;
  readBack(handoffId: string): DurableHandoffReceipt | null;
  listAll(): DurableHandoffReceipt[];
  close(): void;
}

function defaultDeps(): Required<HandoffReceiptStoreDeps> {
  return {
    openDbFn: (path: string) => new DatabaseSync(path),
    mkdirFn: (path: string) => {
      mkdirSync(path, { recursive: true });
    },
    nowFn: () => new Date(),
  };
}

function initSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${HANDOFF_RECEIPT_BUSY_TIMEOUT_MS}`);
  const modeRow = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
  const mode = String(modeRow?.journal_mode ?? "").toLowerCase();
  if (mode !== "wal") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_handoff_receipts (
      handoff_id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      old_session_id TEXT NOT NULL,
      new_session_id TEXT NOT NULL,
      prepared_at TEXT NOT NULL,
      terminal_disposition TEXT,
      cleanup_kind TEXT,
      cleanup_pid INTEGER,
      detail TEXT,
      completed_at TEXT
    )
  `);
}

function parseRow(row: Record<string, unknown>): DurableHandoffReceipt {
  const pid = row.cleanup_pid;
  return {
    handoffId: String(row.handoff_id),
    operation: row.operation as ContextMutationOperation,
    oldSessionId: String(row.old_session_id),
    newSessionId: String(row.new_session_id),
    preparedAt: String(row.prepared_at),
    terminalDisposition:
      row.terminal_disposition === "success" || row.terminal_disposition === "failed_before_switch"
        ? row.terminal_disposition
        : null,
    cleanupKind:
      row.cleanup_kind === "terminated" ||
      row.cleanup_kind === "surviving_orphan" ||
      row.cleanup_kind === "retained_task_host" ||
      row.cleanup_kind === "unknown"
        ? row.cleanup_kind
        : null,
    cleanupPid: typeof pid === "number" && Number.isSafeInteger(pid) ? pid : null,
    detail: typeof row.detail === "string" ? row.detail : null,
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
  };
}

export function openHandoffReceiptStore(
  dbPath: string = defaultLineageDbPath(),
  deps: HandoffReceiptStoreDeps = {},
): HandoffReceiptStore {
  const merged = { ...defaultDeps(), ...deps };
  merged.mkdirFn(dirname(dbPath));
  const db = merged.openDbFn(dbPath);
  try {
    initSchema(db);
  } catch (cause) {
    // A corrupt or foreign file throws on the first statement. Release the
    // handle before rethrowing so the failed open does not pin the file for
    // the wrapper's lifetime (Windows refuses deletion of a pinned file).
    try {
      db.close();
    } catch {
      // never opened far enough to close
    }
    throw cause;
  }

  const insert = db.prepare(`
    INSERT INTO cc_handoff_receipts (
      handoff_id, operation, old_session_id, new_session_id, prepared_at,
      terminal_disposition, cleanup_kind, cleanup_pid, detail, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE cc_handoff_receipts
    SET operation = ?, old_session_id = ?, new_session_id = ?, prepared_at = ?,
        terminal_disposition = ?, cleanup_kind = ?, cleanup_pid = ?, detail = ?, completed_at = ?
    WHERE handoff_id = ?
  `);
  const selectById = db.prepare(`SELECT * FROM cc_handoff_receipts WHERE handoff_id = ?`);
  const selectAll = db.prepare(`SELECT * FROM cc_handoff_receipts ORDER BY prepared_at ASC`);
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
        // already rolled back
      }
      throw cause;
    }
  };

  const bindRow = (row: DurableHandoffReceipt) =>
    [
      row.handoffId,
      row.operation,
      row.oldSessionId,
      row.newSessionId,
      row.preparedAt,
      row.terminalDisposition,
      row.cleanupKind,
      row.cleanupPid,
      row.detail,
      row.completedAt,
    ] as const;

  const store: HandoffReceiptStore = {
    path: dbPath,
    insertPrepared(row) {
      return runInTx(() => {
        insert.run(...bindRow(row));
        const readBack = selectById.get(row.handoffId) as Record<string, unknown> | undefined;
        if (readBack === undefined) {
          throw new Error(`cc-lhc handoff receipt insert failed readback for ${row.handoffId}`);
        }
        return parseRow(readBack);
      });
    },
    update(row) {
      return runInTx(() => {
        const result = update.run(
          row.operation,
          row.oldSessionId,
          row.newSessionId,
          row.preparedAt,
          row.terminalDisposition,
          row.cleanupKind,
          row.cleanupPid,
          row.detail,
          row.completedAt,
          row.handoffId,
        );
        if (result.changes === 0) {
          throw new Error(`cc-lhc handoff receipt update matched no row ${row.handoffId}`);
        }
        const readBack = selectById.get(row.handoffId) as Record<string, unknown> | undefined;
        if (readBack === undefined) {
          throw new Error(`cc-lhc handoff receipt update failed readback for ${row.handoffId}`);
        }
        return parseRow(readBack);
      });
    },
    readBack(handoffId) {
      const row = selectById.get(handoffId) as Record<string, unknown> | undefined;
      return row === undefined ? null : parseRow(row);
    },
    listAll() {
      const rows = selectAll.all() as Array<Record<string, unknown>>;
      return rows.map((row) => parseRow(row));
    },
    close() {
      db.close();
    },
  };

  return store;
}

export function cleanupFields(
  cleanup: OldChildCleanup,
): Pick<DurableHandoffReceipt, "cleanupKind" | "cleanupPid" | "detail"> {
  if (cleanup.kind === "unknown") {
    return {
      cleanupKind: "unknown",
      cleanupPid: cleanup.pid ?? null,
      detail: cleanup.detail,
    };
  }
  return {
    cleanupKind: cleanup.kind,
    cleanupPid: cleanup.pid,
    detail: null,
  };
}

export interface HandoffReceiptPort {
  insertPrepared(row: DurableHandoffReceipt): DurableHandoffReceipt;
  update(row: DurableHandoffReceipt): DurableHandoffReceipt;
  readBack(handoffId: string): DurableHandoffReceipt | null;
}

export function handoffReceiptPortFromStore(store: HandoffReceiptStore): HandoffReceiptPort {
  return {
    insertPrepared: (row) => store.insertPrepared(row),
    update: (row) => store.update(row),
    readBack: (handoffId) => store.readBack(handoffId),
  };
}
