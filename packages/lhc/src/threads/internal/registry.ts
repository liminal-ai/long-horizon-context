import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../shared-tech/storage.js";
import { migrateRegistrySchema, threadListingSchemaStatements } from "./registry-migrate.js";

export const DEFAULT_REGISTRY_PATH = join(homedir(), ".lhc", "registry.sqlite");

export function resolveRegistryPath(registryPath?: string): string {
  return registryPath ?? DEFAULT_REGISTRY_PATH;
}

function hasNoSchema(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 1").get();
  return row === undefined;
}

// First write creates the current registry file and schema lazily; every open
// then brings an existing registry forward, so the alias map reaches registries
// that already hold threads and not just newly created ones.
export function openRegistryForWrite(registryPath: string): DatabaseSync {
  mkdirSync(dirname(registryPath), { recursive: true });
  const db = openDatabase(registryPath);
  try {
    if (hasNoSchema(db)) {
      db.exec("BEGIN IMMEDIATE;");
      try {
        for (const statement of threadListingSchemaStatements()) db.exec(statement);
        db.exec("COMMIT;");
      } catch (cause) {
        db.exec("ROLLBACK;");
        throw cause;
      }
    }
    migrateRegistrySchema(db);
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

// Alias reads need the v2 tables, so they open an existing registry through
// the migrating path — bringing a registry current is not creating one, and
// the non-creation guarantee still holds through the existence check.
export function openExistingRegistry(registryPath: string): DatabaseSync | null {
  if (!existsSync(registryPath)) return null;
  return openRegistryForWrite(registryPath);
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

export interface ThreadAliasRow {
  alias: string;
  threadId: string;
  registeredAt: string;
}

export interface ThreadAliasResolutionRow {
  threadId: string;
  currentAlias: string | null;
}

// Registration never rebinds: an alias already bound keeps its binding, and the
// caller learns which thread holds it from the row read back.
export function insertAliasRowIfAbsent(db: DatabaseSync, row: ThreadAliasRow): void {
  db.prepare("INSERT OR IGNORE INTO thread_alias (alias, thread_id, registered_at) VALUES (?, ?, ?)").run(
    row.alias,
    row.threadId,
    row.registeredAt,
  );
}

export function selectAliasRow(db: DatabaseSync, alias: string): ThreadAliasRow | undefined {
  const raw = db
    .prepare("SELECT alias, thread_id, registered_at FROM thread_alias WHERE alias = ?")
    .get(alias) as unknown as { alias: string; thread_id: string; registered_at: string } | undefined;
  return raw === undefined ? undefined : { alias: raw.alias, threadId: raw.thread_id, registeredAt: raw.registered_at };
}

// One statement, therefore one snapshot: the alias's thread and that thread's
// current alias can never come from two different states of the registry.
export function selectAliasResolutionRow(db: DatabaseSync, alias: string): ThreadAliasResolutionRow | undefined {
  const raw = db
    .prepare(
      `SELECT a.thread_id AS thread_id, c.alias AS current_alias
       FROM thread_alias a
       LEFT JOIN thread_current_alias c ON c.thread_id = a.thread_id
       WHERE a.alias = ?`,
    )
    .get(alias) as unknown as { thread_id: string; current_alias: string | null } | undefined;
  return raw === undefined ? undefined : { threadId: raw.thread_id, currentAlias: raw.current_alias };
}

export function selectCurrentAliasRow(db: DatabaseSync, threadId: string): string | null {
  const raw = db.prepare("SELECT alias FROM thread_current_alias WHERE thread_id = ?").get(threadId) as unknown as
    | { alias: string }
    | undefined;
  return raw === undefined ? null : raw.alias;
}

// The composite foreign key refuses a pointer to an alias of another thread,
// so the invariant holds against any writer, not just this one.
export function upsertCurrentAliasRow(
  db: DatabaseSync,
  pointer: { threadId: string; alias: string; advancedAt: string },
): void {
  db.prepare(
    `INSERT INTO thread_current_alias (thread_id, alias, advanced_at) VALUES (?, ?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET alias = excluded.alias, advanced_at = excluded.advanced_at`,
  ).run(pointer.threadId, pointer.alias, pointer.advancedAt);
}
