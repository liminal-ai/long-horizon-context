import type { DatabaseSync } from "node:sqlite";
import { CURRENT_THREAD_SCHEMA_VERSION, getSchemaVersion } from "./storage.js";

export const THREAD_SCHEMA_VERSION_1 = 1;

export function derivationLogSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS derivation_log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('message','turn','chunk')),
      subject_id TEXT NOT NULL,
      derivation_type TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );`,
    `CREATE INDEX IF NOT EXISTS idx_derivation_log_subject ON derivation_log (subject_kind, subject_id, derivation_type);`,
    `CREATE INDEX IF NOT EXISTS idx_derivation_log_event ON derivation_log (event_kind);`,
  ];
}

export function migrateThreadSchema(db: DatabaseSync): void {
  const version = getSchemaVersion(db);
  if (version >= CURRENT_THREAD_SCHEMA_VERSION) return;
  if (version !== THREAD_SCHEMA_VERSION_1) {
    throw new Error(`unsupported thread schema version ${version}`);
  }
  db.exec("BEGIN IMMEDIATE;");
  try {
    for (const statement of derivationLogSchemaStatements()) db.exec(statement);
    db.exec(`PRAGMA user_version = ${CURRENT_THREAD_SCHEMA_VERSION};`);
    db.exec("COMMIT;");
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

export function isSupportedThreadSchemaVersion(version: number): boolean {
  return version >= THREAD_SCHEMA_VERSION_1 && version <= CURRENT_THREAD_SCHEMA_VERSION;
}
