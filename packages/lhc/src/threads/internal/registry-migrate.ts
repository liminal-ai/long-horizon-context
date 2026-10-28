import type { DatabaseSync } from "node:sqlite";
import { getSchemaVersion } from "../../shared-tech/storage.js";

export const REGISTRY_SCHEMA_VERSION_1 = 1;
export const REGISTRY_SCHEMA_VERSION_2 = 2;
export const CURRENT_REGISTRY_SCHEMA_VERSION = REGISTRY_SCHEMA_VERSION_2;

export function threadListingSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS threads (
      thread_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      title TEXT,
      cwd TEXT,
      created_at TEXT NOT NULL
    );`,
  ];
}

export function threadAliasSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS thread_alias (
      alias TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      UNIQUE (thread_id, alias)
    );`,
    `CREATE TABLE IF NOT EXISTS thread_current_alias (
      thread_id TEXT PRIMARY KEY,
      alias TEXT NOT NULL,
      advanced_at TEXT NOT NULL,
      FOREIGN KEY (thread_id, alias) REFERENCES thread_alias (thread_id, alias)
    );`,
  ];
}

export function migrateRegistrySchema(db: DatabaseSync): void {
  if (getSchemaVersion(db) >= CURRENT_REGISTRY_SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE;");
  try {
    for (const statement of threadAliasSchemaStatements()) db.exec(statement);
    db.exec(`PRAGMA user_version = ${CURRENT_REGISTRY_SCHEMA_VERSION};`);
    db.exec("COMMIT;");
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}
