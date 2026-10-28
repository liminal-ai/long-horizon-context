import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ThreadRef } from "lhc";

import { captureThreadRef, defaultLineageDbPath, defaultRegistryPath } from "./paths.js";
import {
  isCanonicalNoneRow,
  type PrefixBoundary,
  parseStoredVerifiedPrefix,
  prefixBoundaryNone,
  prefixBoundaryUnknown,
} from "./prefix-boundary.js";
import { createReplayDedupeState, MAX_THREAD_SIGNATURES, type ReplayDedupeState } from "./replay-dedupe.js";

export interface LineageSessionEntry {
  threadId: string;
  updatedAt: string;
  prefix: PrefixBoundary;
  replayedPrefixLines: number;
  accepted: boolean;
}

export interface ThreadSessionRow {
  sessionId: string;
  updatedAt: string;
  prefix: PrefixBoundary;
  accepted: boolean;
}

export interface RecordSessionThreadOptions {
  prefix?: PrefixBoundary;
  replayedPrefixLines?: number;
  accepted?: boolean;
}

export interface LineageDbDeps {
  nowFn?: () => Date;
  mkdirFn?: (path: string) => void;
  renameFn?: (from: string, to: string) => void;
  existsFn?: (path: string) => boolean;
  openDbFn?: (path: string) => DatabaseSync;
  withDb?: (dbPath: string, run: (db: DatabaseSync) => void) => void;
}

const defaultDeps = (): Required<Pick<LineageDbDeps, "nowFn">> & LineageDbDeps => ({
  nowFn: () => new Date(),
  mkdirFn: (path: string) => {
    mkdirSync(path, { recursive: true });
  },
  renameFn: (from: string, to: string) => {
    renameSync(from, to);
  },
  existsFn: (path: string) => existsSync(path),
});

function isProvenSqliteCorruption(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const record = cause as { code?: unknown; message?: unknown };
  if (record.code === "ERR_SQLITE_CORRUPT" || record.code === "ERR_SQLITE_NOTADB") return true;
  const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
  return message.includes("database disk image is malformed") || message.includes("file is not a database");
}

export function lineageWriteFailureMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return `[cc-lhc] lineage write failed (continuing): ${message}`;
}

export function lineageReadFailureMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return `[cc-lhc] lineage read failed (continuing): ${message}`;
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function initLineageSchema(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 10000");
  const modeRow = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
  const mode = String(modeRow?.journal_mode ?? "").toLowerCase();
  if (mode !== "wal") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_session_lineage (
      rollout_session_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      prefix_provenance TEXT NOT NULL DEFAULT 'unknown',
      replayed_prefix_lines INTEGER,
      replayed_prefix_bytes INTEGER,
      replayed_prefix_sha256 TEXT
    )
  `);

  if (!tableHasColumn(db, "cc_session_lineage", "rebuild_unaccepted")) {
    db.exec("ALTER TABLE cc_session_lineage ADD COLUMN rebuild_unaccepted INTEGER NOT NULL DEFAULT 0");
  }

  if (!tableHasColumn(db, "cc_session_lineage", "replayed_prefix_lines")) {
    db.exec("ALTER TABLE cc_session_lineage ADD COLUMN replayed_prefix_lines INTEGER");
  }
  if (!tableHasColumn(db, "cc_session_lineage", "prefix_provenance")) {
    db.exec("ALTER TABLE cc_session_lineage ADD COLUMN prefix_provenance TEXT NOT NULL DEFAULT 'unknown'");
  }
  if (!tableHasColumn(db, "cc_session_lineage", "replayed_prefix_bytes")) {
    db.exec("ALTER TABLE cc_session_lineage ADD COLUMN replayed_prefix_bytes INTEGER");
  }
  if (!tableHasColumn(db, "cc_session_lineage", "replayed_prefix_sha256")) {
    db.exec("ALTER TABLE cc_session_lineage ADD COLUMN replayed_prefix_sha256 TEXT");
  }

  db.exec(`
    UPDATE cc_session_lineage
    SET prefix_provenance = 'unknown',
        replayed_prefix_lines = NULL,
        replayed_prefix_bytes = NULL,
        replayed_prefix_sha256 = NULL
    WHERE prefix_provenance = 'verified'
      AND (replayed_prefix_sha256 IS NULL OR replayed_prefix_sha256 = ''
           OR replayed_prefix_bytes IS NULL)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_pending_current_session (
      thread_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      previous_session_id TEXT,
      accepted_at TEXT NOT NULL
    )
  `);

  if (!tableHasColumn(db, "cc_pending_current_session", "previous_session_id")) {
    db.exec("ALTER TABLE cc_pending_current_session ADD COLUMN previous_session_id TEXT");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_thread_signatures (
      thread_id TEXT NOT NULL,
      signature TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (thread_id, signature)
    )
  `);
}

export function openLineageDatabase(dbPath: string, deps: LineageDbDeps = {}): DatabaseSync {
  const merged = { ...defaultDeps(), ...deps };
  merged.mkdirFn?.(dirname(dbPath));

  const tryOpen = (): DatabaseSync => {
    const db = merged.openDbFn ? merged.openDbFn(dbPath) : new DatabaseSync(dbPath);
    try {
      initLineageSchema(db);
      return db;
    } catch (cause) {
      try {
        db.close();
      } catch {}
      throw cause;
    }
  };

  try {
    return tryOpen();
  } catch (cause) {
    if (!isProvenSqliteCorruption(cause)) throw cause;
    if (merged.existsFn?.(dbPath) === true) {
      try {
        merged.renameFn?.(dbPath, `${dbPath}.corrupt-${String(Date.now())}`);
      } catch {}
    }
    return tryOpen();
  }
}

function withLineageDb(dbPath: string, deps: LineageDbDeps, run: (db: DatabaseSync) => void): void {
  if (deps.withDb !== undefined) {
    deps.withDb(dbPath, () => {
      const { withDb: _withDb, ...innerDeps } = deps;
      const db = openLineageDatabase(dbPath, innerDeps);
      try {
        run(db);
      } finally {
        db.close();
      }
    });
    return;
  }
  const db = openLineageDatabase(dbPath, deps);
  try {
    run(db);
  } finally {
    db.close();
  }
}

export type LineageOutcome = { ok: true } | { ok: false; reason: string };

export async function safeRecordSessionThread(
  dbPath: string,
  sessionId: string,
  threadId: string,
  logError: (message: string) => void,
  deps: LineageDbDeps = {},
  options: RecordSessionThreadOptions = {},
): Promise<LineageOutcome> {
  try {
    recordSessionThread(dbPath, sessionId, threadId, deps, options);
    return { ok: true };
  } catch (cause) {
    const reason = lineageWriteFailureMessage(cause);
    logError(reason);
    return { ok: false, reason: `lineage_write:${detailCause(cause)}` };
  }
}

export async function safeAppendThreadSignatures(
  dbPath: string,
  threadId: string,
  added: readonly string[],
  logError: (message: string) => void,
  deps: LineageDbDeps = {},
): Promise<LineageOutcome> {
  try {
    appendThreadSignatures(dbPath, threadId, added, deps);
    return { ok: true };
  } catch (cause) {
    const reason = lineageWriteFailureMessage(cause);
    logError(reason);
    return { ok: false, reason: `lineage_signature_write:${detailCause(cause)}` };
  }
}

function detailCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function rowToEntry(row: {
  thread_id: string;
  updated_at: string;
  rebuild_unaccepted?: number | null;
  prefix_provenance?: string | null;
  replayed_prefix_lines?: number | null;
  replayed_prefix_bytes?: number | null;
  replayed_prefix_sha256?: string | null;
}): LineageSessionEntry {
  const prefix = prefixFromRow(row);
  return {
    threadId: row.thread_id,
    updatedAt: row.updated_at,
    prefix,
    replayedPrefixLines: prefix.kind === "verified" ? prefix.lineCount : 0,
    accepted: row.rebuild_unaccepted !== 1,
  };
}

function prefixFromRow(row: {
  prefix_provenance?: string | null;
  replayed_prefix_lines?: number | null;
  replayed_prefix_bytes?: number | null;
  replayed_prefix_sha256?: string | null;
}): PrefixBoundary {
  const prov = row.prefix_provenance ?? "unknown";
  if (prov === "none") {
    return isCanonicalNoneRow(row) ? prefixBoundaryNone() : prefixBoundaryUnknown();
  }
  if (prov === "verified") {
    const parsed = parseStoredVerifiedPrefix(
      row.replayed_prefix_lines,
      row.replayed_prefix_bytes,
      row.replayed_prefix_sha256,
    );
    if (parsed === null) return prefixBoundaryUnknown();
    return parsed;
  }
  return prefixBoundaryUnknown();
}

function prefixToColumns(prefix: PrefixBoundary): {
  provenance: string;
  lines: number | null;
  bytes: number | null;
  sha256: string | null;
} {
  if (prefix.kind === "none") {
    return { provenance: "none", lines: 0, bytes: 0, sha256: null };
  }
  if (prefix.kind === "verified") {
    return {
      provenance: "verified",
      lines: prefix.lineCount,
      bytes: prefix.byteLength,
      sha256: prefix.sha256,
    };
  }
  return { provenance: "unknown", lines: null, bytes: null, sha256: null };
}

export function lookupSessionLineage(
  dbPath: string,
  sessionId: string,
  deps: LineageDbDeps = {},
): LineageSessionEntry | undefined {
  let entry: LineageSessionEntry | undefined;
  withLineageDb(dbPath, deps, (db) => {
    const row = db
      .prepare(
        `SELECT thread_id, updated_at, prefix_provenance, rebuild_unaccepted,
                replayed_prefix_lines, replayed_prefix_bytes, replayed_prefix_sha256
         FROM cc_session_lineage WHERE rollout_session_id = ?`,
      )
      .get(sessionId) as
      | {
          thread_id: string;
          updated_at: string;
          prefix_provenance: string;
          rebuild_unaccepted: number | null;
          replayed_prefix_lines: number | null;
          replayed_prefix_bytes: number | null;
          replayed_prefix_sha256: string | null;
        }
      | undefined;
    if (row !== undefined) entry = rowToEntry(row);
  });
  return entry;
}

export function threadForLegacySession(
  dbPath: string,
  sessionId: string,
  deps: LineageDbDeps = {},
): string | undefined {
  return lookupSessionLineage(dbPath, sessionId, deps)?.threadId;
}

export function threadSessionRows(dbPath: string, threadId: string, deps: LineageDbDeps = {}): ThreadSessionRow[] {
  const rows: ThreadSessionRow[] = [];
  withLineageDb(dbPath, deps, (db) => {
    const raw = db
      .prepare(
        `SELECT rollout_session_id, thread_id, updated_at, prefix_provenance, rebuild_unaccepted,
                replayed_prefix_lines, replayed_prefix_bytes, replayed_prefix_sha256
         FROM cc_session_lineage WHERE thread_id = ? ORDER BY updated_at, rowid`,
      )
      .all(threadId) as Array<{
      rollout_session_id: string;
      thread_id: string;
      updated_at: string;
      prefix_provenance: string;
      rebuild_unaccepted: number | null;
      replayed_prefix_lines: number | null;
      replayed_prefix_bytes: number | null;
      replayed_prefix_sha256: string | null;
    }>;
    for (const row of raw) {
      const entry = rowToEntry(row);
      rows.push({
        sessionId: row.rollout_session_id,
        updatedAt: entry.updatedAt,
        prefix: entry.prefix,
        accepted: entry.accepted,
      });
    }
  });
  return rows;
}

export function rebuiltSessionRows(
  dbPath: string,
  deps: LineageDbDeps = {},
): Array<{ sessionId: string; threadId: string; updatedAt: string; accepted: boolean }> {
  const rows: Array<{ sessionId: string; threadId: string; updatedAt: string; accepted: boolean }> = [];
  withLineageDb(dbPath, deps, (db) => {
    const raw = db
      .prepare(
        `SELECT rollout_session_id, thread_id, updated_at, prefix_provenance, rebuild_unaccepted,
                replayed_prefix_lines, replayed_prefix_bytes, replayed_prefix_sha256
         FROM cc_session_lineage WHERE prefix_provenance = 'verified' ORDER BY updated_at, rowid`,
      )
      .all() as Array<{
      rollout_session_id: string;
      thread_id: string;
      updated_at: string;
      prefix_provenance: string;
      rebuild_unaccepted: number | null;
      replayed_prefix_lines: number | null;
      replayed_prefix_bytes: number | null;
      replayed_prefix_sha256: string | null;
    }>;
    for (const row of raw) {
      const entry = rowToEntry(row);
      if (entry.prefix.kind !== "verified") continue;
      rows.push({
        sessionId: row.rollout_session_id,
        threadId: row.thread_id,
        updatedAt: entry.updatedAt,
        accepted: entry.accepted,
      });
    }
  });
  return rows;
}

export function markSessionAccepted(dbPath: string, sessionId: string, deps: LineageDbDeps = {}): void {
  withLineageDb(dbPath, deps, (db) => {
    db.prepare("UPDATE cc_session_lineage SET rebuild_unaccepted = 0 WHERE rollout_session_id = ?").run(sessionId);
  });
}

export interface PendingCurrentSession {
  threadId: string;
  sessionId: string;
  previousSessionId: string | null;
  acceptedAt: string;
}

export function recordPendingCurrentSession(
  dbPath: string,
  threadId: string,
  sessionId: string,
  previousSessionId: string | null,
  deps: LineageDbDeps = {},
): void {
  const { nowFn } = { ...defaultDeps(), ...deps };
  withLineageDb(dbPath, deps, (db) => {
    db.prepare(
      `INSERT INTO cc_pending_current_session (thread_id, session_id, previous_session_id, accepted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         session_id = excluded.session_id,
         previous_session_id = excluded.previous_session_id,
         accepted_at = excluded.accepted_at`,
    ).run(threadId, sessionId, previousSessionId, nowFn().toISOString());
  });
}

export function readPendingCurrentSession(
  dbPath: string,
  threadId: string,
  deps: LineageDbDeps = {},
): PendingCurrentSession | undefined {
  let pending: PendingCurrentSession | undefined;
  withLineageDb(dbPath, deps, (db) => {
    const row = db
      .prepare(
        `SELECT thread_id, session_id, previous_session_id, accepted_at
         FROM cc_pending_current_session WHERE thread_id = ?`,
      )
      .get(threadId) as
      | { thread_id: string; session_id: string; previous_session_id: string | null; accepted_at: string }
      | undefined;
    if (row === undefined) return;
    if (typeof row.session_id !== "string" || row.session_id === "") return;
    pending = {
      threadId,
      sessionId: row.session_id,
      previousSessionId: typeof row.previous_session_id === "string" ? row.previous_session_id : null,
      acceptedAt: typeof row.accepted_at === "string" ? row.accepted_at : "",
    };
  });
  return pending;
}

export function supersedePendingCurrentSession(dbPath: string, threadId: string, deps: LineageDbDeps = {}): void {
  withLineageDb(dbPath, deps, (db) => {
    db.prepare("DELETE FROM cc_pending_current_session WHERE thread_id = ?").run(threadId);
  });
}

export function clearPendingCurrentSession(
  dbPath: string,
  threadId: string,
  sessionId: string,
  deps: LineageDbDeps = {},
): void {
  withLineageDb(dbPath, deps, (db) => {
    db.prepare("DELETE FROM cc_pending_current_session WHERE thread_id = ? AND session_id = ?").run(
      threadId,
      sessionId,
    );
  });
}

export function recordSessionThread(
  dbPath: string,
  sessionId: string,
  threadId: string,
  deps: LineageDbDeps = {},
  options: RecordSessionThreadOptions = {},
): void {
  const { nowFn } = { ...defaultDeps(), ...deps };
  let setPrefix = false;
  const unaccepted = options.accepted === false ? 1 : 0;
  let cols = prefixToColumns(prefixBoundaryNone());
  if (options.prefix !== undefined) {
    setPrefix = true;
    cols = prefixToColumns(options.prefix);
  } else if (options.replayedPrefixLines !== undefined) {
    setPrefix = true;
    cols =
      options.replayedPrefixLines > 0
        ? prefixToColumns(prefixBoundaryUnknown())
        : prefixToColumns(prefixBoundaryNone());
  }

  withLineageDb(dbPath, deps, (db) => {
    db.exec("BEGIN");
    try {
      if (setPrefix) {
        db.prepare(
          `INSERT INTO cc_session_lineage (
             rollout_session_id, thread_id, updated_at,
             prefix_provenance, replayed_prefix_lines, replayed_prefix_bytes, replayed_prefix_sha256,
             rebuild_unaccepted
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(rollout_session_id) DO UPDATE SET
             thread_id = excluded.thread_id,
             updated_at = excluded.updated_at,
             rebuild_unaccepted = excluded.rebuild_unaccepted,
             prefix_provenance = excluded.prefix_provenance,
             replayed_prefix_lines = excluded.replayed_prefix_lines,
             replayed_prefix_bytes = excluded.replayed_prefix_bytes,
             replayed_prefix_sha256 = excluded.replayed_prefix_sha256`,
        ).run(
          sessionId,
          threadId,
          nowFn().toISOString(),
          cols.provenance,
          cols.lines,
          cols.bytes,
          cols.sha256,
          unaccepted,
        );
      } else {
        const updated = db
          .prepare(
            `UPDATE cc_session_lineage
             SET thread_id = ?, updated_at = ?
             WHERE rollout_session_id = ?`,
          )
          .run(threadId, nowFn().toISOString(), sessionId);
        const changes =
          typeof updated === "object" && updated !== null && "changes" in updated
            ? Number((updated as { changes: number }).changes)
            : 0;
        if (changes === 0) {
        }
      }
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
  });
}

function trimThreadSignatures(db: DatabaseSync, threadId: string): void {
  db.prepare(
    `DELETE FROM cc_thread_signatures
     WHERE thread_id = ?
       AND seq NOT IN (
         SELECT seq FROM cc_thread_signatures
         WHERE thread_id = ?
         ORDER BY seq DESC
         LIMIT ?
       )`,
  ).run(threadId, threadId, MAX_THREAD_SIGNATURES);
}

export function appendThreadSignatures(
  dbPath: string,
  threadId: string,
  added: readonly string[],
  deps: LineageDbDeps = {},
): void {
  if (added.length === 0) return;
  withLineageDb(dbPath, deps, (db) => {
    db.exec("BEGIN");
    try {
      const maxRow = db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM cc_thread_signatures WHERE thread_id = ?")
        .get(threadId) as { max_seq: number };
      let nextSeq = maxRow.max_seq;
      const insert = db.prepare(
        "INSERT OR IGNORE INTO cc_thread_signatures (thread_id, signature, seq) VALUES (?, ?, ?)",
      );
      for (const signature of added) {
        nextSeq += 1;
        insert.run(threadId, signature, nextSeq);
      }
      trimThreadSignatures(db, threadId);
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
  });
}

export function threadsMatchingSignatures(
  dbPath: string,
  signatures: readonly string[],
  deps: LineageDbDeps = {},
): Array<{ threadId: string; matches: number }> {
  const unique = [...new Set(signatures)];
  const counts = new Map<string, number>();
  if (unique.length === 0) return [];
  withLineageDb(dbPath, deps, (db) => {
    const CHUNK = 400;
    for (let start = 0; start < unique.length; start += CHUNK) {
      const chunk = unique.slice(start, start + CHUNK);
      const rows = db
        .prepare(
          `SELECT thread_id, COUNT(*) AS matches FROM cc_thread_signatures
           WHERE signature IN (${chunk.map(() => "?").join(", ")}) GROUP BY thread_id`,
        )
        .all(...chunk) as Array<{ thread_id: string; matches: number }>;
      for (const row of rows) counts.set(row.thread_id, (counts.get(row.thread_id) ?? 0) + Number(row.matches));
    }
  });
  return [...counts.entries()]
    .map(([threadId, matches]) => ({ threadId, matches }))
    .sort((a, b) => b.matches - a.matches || a.threadId.localeCompare(b.threadId));
}

export function loadThreadSignatures(dbPath: string, threadId: string, deps: LineageDbDeps = {}): string[] {
  const signatures: string[] = [];
  withLineageDb(dbPath, deps, (db) => {
    const rows = db
      .prepare("SELECT signature FROM cc_thread_signatures WHERE thread_id = ? ORDER BY seq ASC")
      .all(threadId) as Array<{ signature: string }>;
    for (const row of rows) signatures.push(row.signature);
  });
  return signatures;
}

export function safeLoadThreadSignatures(
  dbPath: string,
  threadId: string,
  logError: (message: string) => void,
  deps: LineageDbDeps = {},
): { signatures: string[]; outcome: LineageOutcome } {
  try {
    return { signatures: loadThreadSignatures(dbPath, threadId, deps), outcome: { ok: true } };
  } catch (cause) {
    logError(lineageReadFailureMessage(cause));
    return {
      signatures: [],
      outcome: { ok: false, reason: `lineage_signature_read:${detailCause(cause)}` },
    };
  }
}

export type LaunchClass = "fresh" | "existing";

export interface BindCaptureThreadInput {
  sessionId: string;
  threadId: string;
  threadCreatedAtLaunch: boolean;
  launchClass?: LaunchClass;
  registryPath?: string;
  lineageDbPath?: string;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  onLineageFailure?: (reason: string) => void;
  lineageDeps?: LineageDbDeps;
}

export interface BindCaptureThreadResult {
  threadRef: ThreadRef;
  isExistingThread: boolean;
  prefix: PrefixBoundary;
  replayedPrefixLines: number;
  dedupeState: ReplayDedupeState;
  persistSignatures: (signatures: string[]) => Promise<LineageOutcome>;
}

export async function bindCaptureThread(input: BindCaptureThreadInput): Promise<BindCaptureThreadResult> {
  const dbPath = input.lineageDbPath ?? defaultLineageDbPath();
  const registryPath = input.registryPath ?? defaultRegistryPath();
  const log = input.log ?? (() => {});
  const logError = input.logError ?? (() => {});
  const onLineageFailure = input.onLineageFailure ?? (() => {});
  const launchClass: LaunchClass = input.launchClass ?? "existing";
  const threadId = input.threadId;

  let lineageReadFailed = false;
  let targetPrefix: PrefixBoundary | undefined;
  try {
    targetPrefix = lookupSessionLineage(dbPath, input.sessionId, input.lineageDeps)?.prefix;
  } catch (cause) {
    lineageReadFailed = true;
    logError(lineageReadFailureMessage(cause));
    onLineageFailure(`lineage_read:${detailCause(cause)}`);
  }

  const persistSignatures = async (added: string[]): Promise<LineageOutcome> => {
    const outcome = await safeAppendThreadSignatures(dbPath, threadId, added, logError, input.lineageDeps);
    if (!outcome.ok) onLineageFailure(outcome.reason);
    return outcome;
  };

  if (!input.threadCreatedAtLaunch) {
    const prefix = lineageReadFailed ? prefixBoundaryUnknown() : (targetPrefix ?? prefixBoundaryUnknown());
    const prefixNote =
      prefix.kind === "verified"
        ? ` (prefix=verified lines=${prefix.lineCount} bytes=${prefix.byteLength})`
        : prefix.kind === "unknown"
          ? " (prefix=unknown)"
          : " (prefix=none)";
    log(`cc-lhc: continuing thread ${threadId} for session ${input.sessionId}${prefixNote}`);
    const recorded = await safeRecordSessionThread(dbPath, input.sessionId, threadId, logError, input.lineageDeps);
    if (!recorded.ok) onLineageFailure(recorded.reason);
    const loaded = safeLoadThreadSignatures(dbPath, threadId, logError, input.lineageDeps);
    if (!loaded.outcome.ok) onLineageFailure(loaded.outcome.reason);
    return {
      threadRef: captureThreadRef(threadId, registryPath),
      isExistingThread: true,
      prefix,
      replayedPrefixLines: prefix.kind === "verified" ? prefix.lineCount : 0,
      dedupeState: createReplayDedupeState(true, loaded.signatures),
      persistSignatures,
    };
  }

  const establishNone = launchClass === "fresh" && !lineageReadFailed;
  const newPrefix = establishNone ? prefixBoundaryNone() : prefixBoundaryUnknown();
  const recorded = await safeRecordSessionThread(dbPath, input.sessionId, threadId, logError, input.lineageDeps, {
    prefix: newPrefix,
  });
  if (!recorded.ok) onLineageFailure(recorded.reason);
  if (establishNone) {
    log(`cc-lhc: new thread ${threadId} for fresh session ${input.sessionId} (prefix=none)`);
  } else {
    log(
      `cc-lhc: new thread ${threadId} for session ${input.sessionId} (prefix=unknown; ` +
        `launchClass=${launchClass}, lineageReadFailed=${lineageReadFailed})`,
    );
  }
  return {
    threadRef: captureThreadRef(threadId, registryPath),
    isExistingThread: false,
    prefix: newPrefix,
    replayedPrefixLines: 0,
    dedupeState: createReplayDedupeState(false, []),
    persistSignatures,
  };
}

export { defaultLineageDbPath } from "./paths.js";

export const defaultLineagePath = defaultLineageDbPath;
