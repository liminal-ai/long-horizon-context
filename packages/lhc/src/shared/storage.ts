import { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number; // 1-based, strictly increasing
  statements: readonly string[];
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version: number | bigint }
    | undefined;
  return Number(row?.user_version ?? 0);
}

export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
): void {
  let current = getSchemaVersion(db);
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of ordered) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE;");
    try {
      for (const statement of migration.statements) db.exec(statement);
      db.exec(`PRAGMA user_version = ${migration.version};`);
      db.exec("COMMIT;");
    } catch (cause) {
      db.exec("ROLLBACK;");
      throw cause;
    }
    current = migration.version;
  }
}
