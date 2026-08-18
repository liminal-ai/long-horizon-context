import type { DatabaseSync } from "node:sqlite";
import { getSchemaVersion } from "../../shared-tech/storage.js";

// v1 is the threads listing alone. Registries written before the alias map
// existed carry user_version 0, so 0 and 1 both mean "listing only".
export const REGISTRY_SCHEMA_VERSION_1 = 1;
// v2 adds the opaque host-qualified alias map and one current-alias pointer
// per thread.
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

// The alias map answers, before any thread file opens, which thread an opaque
// host alias belongs to and which alias that thread currently accepts.
//
// UNIQUE (thread_id, alias) exists to be the composite foreign key's parent:
// a current-alias pointer can only name an alias registered to that same
// thread, and SQLite enforces it rather than an application check.
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

// Existing registries migrate in place on open — the alias tables are added to
// the registry a host already has, never only to a freshly created one.
//
// A registry stamped past the current version is left untouched instead of
// refused: the alias schema is purely additive, so an older binary keeps
// resolving threads against a registry a newer one wrote.
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
