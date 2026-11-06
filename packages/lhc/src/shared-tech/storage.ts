import { DatabaseSync } from "node:sqlite";

export const CURRENT_THREAD_SCHEMA_VERSION = 14;

const databasePaths = new WeakMap<DatabaseSync, string>();

export const SQLITE_BUSY_TIMEOUT_MS = 10_000;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  databasePaths.set(db, path);
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  const modeRow = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
  const mode = String(modeRow?.journal_mode ?? "").toLowerCase();
  if (mode !== "wal") {
    switchToWal(db);
  }
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}

const SQLITE_BUSY = 5;
const WAL_RETRY_PAUSE_MS = 10;

// The WAL switch upgrades a read lock to a write lock, and SQLite returns
// SQLITE_BUSY at once for that upgrade instead of calling the busy handler.
function switchToWal(db: DatabaseSync): void {
  const deadline = Date.now() + SQLITE_BUSY_TIMEOUT_MS;
  try {
    for (;;) {
      db.exec(`PRAGMA busy_timeout = ${Math.max(1, deadline - Date.now())};`);
      try {
        db.exec("PRAGMA journal_mode = WAL;");
        return;
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== SQLITE_BUSY || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAL_RETRY_PAUSE_MS);
      }
    }
  } finally {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  }
}

export function databasePathFor(db: DatabaseSync): string | undefined {
  return databasePaths.get(db);
}

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number | bigint } | undefined;
  return Number(row?.user_version ?? 0);
}
