import { DatabaseSync } from "node:sqlite";

export const CURRENT_THREAD_SCHEMA_VERSION = 6;

const databasePaths = new WeakMap<DatabaseSync, string>();

/** Cross-process lock wait (ms). Same-process writers use the JS write mutex. */
export const SQLITE_BUSY_TIMEOUT_MS = 10_000;

export function openDatabase(path: string): DatabaseSync {
  // Constructor timeout applies to lock waits (cross-process). Same-process
  // writers are also serialized by createDbWriteTransaction's async mutex —
  // DatabaseSync busy waits block the event loop and cannot interleave holders.
  const db = new DatabaseSync(path, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  databasePaths.set(db, path);
  // busy_timeout FIRST so any brief lock waits instead of instant SQLITE_BUSY.
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  // Only promote to WAL when not already WAL. Re-applying `PRAGMA journal_mode
  // = WAL` on every open takes a write lock that races concurrent openers.
  // Query form is read-only against an already-WAL file.
  const modeRow = db.prepare("PRAGMA journal_mode").get() as
    | { journal_mode: string }
    | undefined;
  const mode = String(modeRow?.journal_mode ?? "").toLowerCase();
  if (mode !== "wal") {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}

export function databasePathFor(db: DatabaseSync): string | undefined {
  return databasePaths.get(db);
}

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number | bigint } | undefined;
  return Number(row?.user_version ?? 0);
}
