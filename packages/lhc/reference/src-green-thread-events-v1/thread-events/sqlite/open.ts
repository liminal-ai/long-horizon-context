import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SQLITE_BUSY_TIMEOUT_MS = 5000;

export interface LhcSqliteHandle {
  readonly filename: string;
  readonly db: DatabaseSync;
  close(): void;
}

export function openLhcSqlite(filename: string): LhcSqliteHandle {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  return {
    filename,
    db,
    close() {
      db.close();
    },
  };
}
