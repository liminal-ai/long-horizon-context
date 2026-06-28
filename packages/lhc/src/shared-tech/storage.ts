import { DatabaseSync } from "node:sqlite";

export const CURRENT_THREAD_SCHEMA_VERSION = 2;

const databasePaths = new WeakMap<DatabaseSync, string>();

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  databasePaths.set(db, path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
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
