import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type Migration, openDatabase, runMigrations } from "../../shared-tech/storage.js";

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
  {
    // The cwd a thread was created in, so the resume picker can scope its list
    // to the current directory. Added as its own version so a registry created
    // under v1 upgrades lazily on next open rather than silently lacking the
    // column.
    version: 2,
    statements: [`ALTER TABLE threads ADD COLUMN cwd TEXT;`],
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
// openDatabase would create the file. An existing registry is brought to the
// current schema on open so reads can rely on the current columns (e.g. the
// A-8 `cwd` column) regardless of which version created it; a registry already
// at the latest version pays nothing (runMigrations is a no-op).
export function openRegistryForRead(registryPath: string): DatabaseSync | null {
  if (!existsSync(registryPath)) return null;
  const db = openDatabase(registryPath);
  try {
    runMigrations(db, REGISTRY_MIGRATIONS);
  } catch (cause) {
    db.close();
    throw cause;
  }
  return db;
}

export interface RegistryRow {
  threadId: string;
  filePath: string;
  title?: string;
  cwd?: string;
  createdAt: string;
}

interface RawRow {
  thread_id: string;
  file_path: string;
  title: string | null;
  cwd: string | null;
  created_at: string;
}

const ROW_COLUMNS = "thread_id, file_path, title, cwd, created_at";

// Insertion order (rowid) breaks ties at the same created_at timestamp, so
// "most recent" (the last row) is the last-inserted thread even when two
// creations land in the same millisecond — the determinism `--continue`
// (resolve the most recently created thread) relies on.
const ROW_ORDER = "ORDER BY created_at, rowid";

function toRegistryRow(raw: RawRow): RegistryRow {
  const row: RegistryRow = {
    threadId: raw.thread_id,
    filePath: raw.file_path,
    createdAt: raw.created_at,
  };
  if (raw.title !== null) row.title = raw.title;
  if (raw.cwd !== null) row.cwd = raw.cwd;
  return row;
}

export function insertThreadRow(db: DatabaseSync, row: RegistryRow): void {
  db.prepare("INSERT INTO threads (thread_id, file_path, title, cwd, created_at) VALUES (?, ?, ?, ?, ?)").run(
    row.threadId,
    row.filePath,
    row.title ?? null,
    row.cwd ?? null,
    row.createdAt,
  );
}

export function selectThreadRow(db: DatabaseSync, threadId: string): RegistryRow | undefined {
  const raw = db.prepare(`SELECT ${ROW_COLUMNS} FROM threads WHERE thread_id = ?`).get(threadId) as unknown as
    | RawRow
    | undefined;
  return raw === undefined ? undefined : toRegistryRow(raw);
}

// Partial-id resolve (A-8): every thread whose id begins with the given prefix.
// LIKE metacharacters in the (caller-supplied) prefix are escaped so the '_' in
// the thread-id scheme (th_<hex>) and any '%' match literally rather than as
// wildcards; ESCAPE makes '\' the escape character.
export function selectThreadRowsByPrefix(db: DatabaseSync, prefix: string): RegistryRow[] {
  const escaped = prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const raws = db
    .prepare(`SELECT ${ROW_COLUMNS} FROM threads WHERE thread_id LIKE ? ESCAPE '\\' ${ROW_ORDER}`)
    .all(`${escaped}%`) as unknown as RawRow[];
  return raws.map(toRegistryRow);
}

// cwd, when given, filters at the registry (A-8): the picker must not scope by
// filtering an unscoped list after the fact (anti-shim) — the scope is the query.
export function selectAllThreadRows(db: DatabaseSync, opts: { cwd?: string } = {}): RegistryRow[] {
  const raws =
    opts.cwd === undefined
      ? (db.prepare(`SELECT ${ROW_COLUMNS} FROM threads ${ROW_ORDER}`).all() as unknown as RawRow[])
      : (db
          .prepare(`SELECT ${ROW_COLUMNS} FROM threads WHERE cwd = ? ${ROW_ORDER}`)
          .all(opts.cwd) as unknown as RawRow[]);
  return raws.map(toRegistryRow);
}
