import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, runMigrations, type Migration } from "../../../shared/storage.js";

export const DEFAULT_REGISTRY_PATH = join(homedir(), ".lhc", "registry.sqlite");

export function resolveRegistryPath(registryPath?: string): string {
  return registryPath ?? DEFAULT_REGISTRY_PATH;
}

const REGISTRY_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE threads (
        thread_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL
      );`,
    ],
  },
];

// First write creates the database and schema lazily (design decision 6).
export function openRegistryForWrite(registryPath: string): DatabaseSync {
  mkdirSync(dirname(registryPath), { recursive: true });
  const db = openDatabase(registryPath);
  try {
    runMigrations(db, REGISTRY_MIGRATIONS);
  } catch (cause) {
    db.close();
    throw cause;
  }
  return db;
}

// Reads never create the registry: callers map null to empty list /
// thread_not_found. The existence check is the non-creation guarantee —
// openDatabase would create the file.
export function openRegistryForRead(registryPath: string): DatabaseSync | null {
  if (!existsSync(registryPath)) return null;
  return openDatabase(registryPath);
}

export interface RegistryRow {
  threadId: string;
  filePath: string;
  title?: string;
  createdAt: string;
}

interface RawRow {
  thread_id: string;
  file_path: string;
  title: string | null;
  created_at: string;
}

function toRegistryRow(raw: RawRow): RegistryRow {
  const row: RegistryRow = {
    threadId: raw.thread_id,
    filePath: raw.file_path,
    createdAt: raw.created_at,
  };
  if (raw.title !== null) row.title = raw.title;
  return row;
}

export function insertThreadRow(db: DatabaseSync, row: RegistryRow): void {
  db.prepare(
    "INSERT INTO threads (thread_id, file_path, title, created_at) VALUES (?, ?, ?, ?)",
  ).run(row.threadId, row.filePath, row.title ?? null, row.createdAt);
}

export function selectThreadRow(
  db: DatabaseSync,
  threadId: string,
): RegistryRow | undefined {
  const raw = db
    .prepare("SELECT thread_id, file_path, title, created_at FROM threads WHERE thread_id = ?")
    .get(threadId) as unknown as RawRow | undefined;
  return raw === undefined ? undefined : toRegistryRow(raw);
}

export function selectAllThreadRows(db: DatabaseSync): RegistryRow[] {
  const raws = db
    .prepare(
      "SELECT thread_id, file_path, title, created_at FROM threads ORDER BY created_at, thread_id",
    )
    .all() as unknown as RawRow[];
  return raws.map(toRegistryRow);
}
