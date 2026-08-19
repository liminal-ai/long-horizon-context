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
  /**
   * Content-verifiable rebuilt-prefix fence (or explicit none/unknown).
   * `unknown` must not be treated as known-zero skip.
   */
  prefix: PrefixBoundary;
  /**
   * Convenience: verified line count, else 0. Callers that need skip semantics
   * must inspect `prefix.kind` — do not treat this alone as a trust decision.
   */
  replayedPrefixLines: number;
}

/** One session binding of a thread, with its host-local prefix proof. */
export interface ThreadSessionRow {
  sessionId: string;
  updatedAt: string;
  prefix: PrefixBoundary;
}

export interface RecordSessionThreadOptions {
  /**
   * When set, persist (or overwrite) the prefix provenance/boundary.
   * When omitted on update, an existing boundary is preserved so ordinary
   * re-binds after resume do not clear a rebuilt-session fence.
   */
  prefix?: PrefixBoundary;
  /**
   * @deprecated Use `prefix: { kind: "verified", ... }` from writeRebuiltRollout.
   * Count-only registration is rejected for skip trust; prefer full boundary.
   */
  replayedPrefixLines?: number;
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

/** Only proven on-disk corruption authorizes quarantine. Busy/locked/schema
 * errors leave the original file untouched and propagate to the caller. */
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

/**
 * Schema notes (correction 5):
 * - `prefix_provenance`: none | unknown | verified
 * - Known-none is distinct from unknown legacy state
 * - Migrating pre-c5 DBs marks existing rows `unknown` so a DEFAULT 0 line
 *   count is never silently trusted as "no synthetic prefix"; capture refuses
 *   unknown until reconciliation establishes `none` or `verified`
 */
function initLineageSchema(db: DatabaseSync): void {
  // busy_timeout FIRST so concurrent governor-receipt / lineage openers wait
  // instead of instant SQLITE_BUSY while journal_mode=WAL takes its write lock.
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

  // Pre-review-3: only thread_id/updated_at
  if (!tableHasColumn(db, "cc_session_lineage", "replayed_prefix_lines")) {
    db.exec("ALTER TABLE cc_session_lineage ADD COLUMN replayed_prefix_lines INTEGER");
  }
  if (!tableHasColumn(db, "cc_session_lineage", "prefix_provenance")) {
    // Existing rows become unknown — even if replayed_prefix_lines was 0 under
    // the old NOT NULL DEFAULT 0 migration (that erased the none/unknown split).
    db.exec("ALTER TABLE cc_session_lineage ADD COLUMN prefix_provenance TEXT NOT NULL DEFAULT 'unknown'");
  }
  if (!tableHasColumn(db, "cc_session_lineage", "replayed_prefix_bytes")) {
    db.exec("ALTER TABLE cc_session_lineage ADD COLUMN replayed_prefix_bytes INTEGER");
  }
  if (!tableHasColumn(db, "cc_session_lineage", "replayed_prefix_sha256")) {
    db.exec("ALTER TABLE cc_session_lineage ADD COLUMN replayed_prefix_sha256 TEXT");
  }

  // Rows that only have a line count (no digest) cannot be verified — force unknown.
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

  // One row per thread: a swap this wrapper observed accepted (capture
  // ready-after-replay and a live child) whose registry current pointer did
  // not advance. It records an acceptance that already happened; the next
  // launch reconciles it into the registry under the thread lock.
  //
  // It never maps an alias to a thread and never overrides registry alias
  // ownership — the registry alone answers which thread an alias belongs to.
  // `previous_session_id` is the registry current this host observed when the
  // advance failed: the row may repair only that exact predecessor state, so a
  // pointer that moved on afterwards is never rolled backwards. A row written
  // before that column existed carries NULL and can repair nothing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_pending_current_session (
      thread_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      previous_session_id TEXT,
      accepted_at TEXT NOT NULL
    )
  `);

  // Pre-amendment rows recorded no predecessor; NULL keeps them settle-only.
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
      } catch {
        // best effort
      }
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
      } catch {
        // best effort
      }
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
    // Strict: contradictory none rows become unknown.
    return isCanonicalNoneRow(row) ? prefixBoundaryNone() : prefixBoundaryUnknown();
  }
  if (prov === "verified") {
    // Strict: no clamp/floor/normalize of forged negatives or fractional values.
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

/** Full lineage entry for a rollout session id (thread + prefix provenance). */
export function lookupSessionLineage(
  dbPath: string,
  sessionId: string,
  deps: LineageDbDeps = {},
): LineageSessionEntry | undefined {
  let entry: LineageSessionEntry | undefined;
  withLineageDb(dbPath, deps, (db) => {
    const row = db
      .prepare(
        `SELECT thread_id, updated_at, prefix_provenance,
                replayed_prefix_lines, replayed_prefix_bytes, replayed_prefix_sha256
         FROM cc_session_lineage WHERE rollout_session_id = ?`,
      )
      .get(sessionId) as
      | {
          thread_id: string;
          updated_at: string;
          prefix_provenance: string;
          replayed_prefix_lines: number | null;
          replayed_prefix_bytes: number | null;
          replayed_prefix_sha256: string | null;
        }
      | undefined;
    if (row !== undefined) entry = rowToEntry(row);
  });
  return entry;
}

/**
 * The thread a pre-registry lineage row bound this session to. Read ONLY by
 * the alias map's one-way import on a first registry miss; after the import
 * the registry answers thread identity and this column never overrides it.
 */
export function threadForLegacySession(
  dbPath: string,
  sessionId: string,
  deps: LineageDbDeps = {},
): string | undefined {
  return lookupSessionLineage(dbPath, sessionId, deps)?.threadId;
}

/**
 * Every Claude session this thread has been bound to, oldest binding first.
 * Host-local detail: the rows carry the prefix proof and the pre-registry
 * lineage the alias map imports one way on its first miss.
 */
export function threadSessionRows(dbPath: string, threadId: string, deps: LineageDbDeps = {}): ThreadSessionRow[] {
  const rows: ThreadSessionRow[] = [];
  withLineageDb(dbPath, deps, (db) => {
    const raw = db
      .prepare(
        `SELECT rollout_session_id, thread_id, updated_at, prefix_provenance,
                replayed_prefix_lines, replayed_prefix_bytes, replayed_prefix_sha256
         FROM cc_session_lineage WHERE thread_id = ? ORDER BY updated_at, rowid`,
      )
      .all(threadId) as Array<{
      rollout_session_id: string;
      thread_id: string;
      updated_at: string;
      prefix_provenance: string;
      replayed_prefix_lines: number | null;
      replayed_prefix_bytes: number | null;
      replayed_prefix_sha256: string | null;
    }>;
    for (const row of raw) {
      const entry = rowToEntry(row);
      rows.push({ sessionId: row.rollout_session_id, updatedAt: entry.updatedAt, prefix: entry.prefix });
    }
  });
  return rows;
}

/** A swap accepted by this host whose registry pointer has not caught up. */
export interface PendingCurrentSession {
  threadId: string;
  sessionId: string;
  /** Registry current observed when the advance failed; null when unobserved. */
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
    // A row that does not carry an accepted session names nothing this launch
    // can act on. Corrupt recovery bookkeeping is unclaimed work, not a wedge:
    // the registry pointer and the files on disk are the durable facts.
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

/**
 * Drops any pending recovery detail for a thread: a newer acceptance reached
 * the registry, so an older unapplied one can no longer repair anything.
 */
export function supersedePendingCurrentSession(dbPath: string, threadId: string, deps: LineageDbDeps = {}): void {
  withLineageDb(dbPath, deps, (db) => {
    db.prepare("DELETE FROM cc_pending_current_session WHERE thread_id = ?").run(threadId);
  });
}

/** Settles the exact pending acceptance; a newer one is left for its own pass. */
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
  // Prefer explicit PrefixBoundary; count-only is stored as unknown (not trusted skip).
  let setPrefix = false;
  let cols = prefixToColumns(prefixBoundaryNone());
  if (options.prefix !== undefined) {
    setPrefix = true;
    cols = prefixToColumns(options.prefix);
  } else if (options.replayedPrefixLines !== undefined) {
    // Deprecated path: never promote count-only to verified.
    setPrefix = true;
    cols =
      options.replayedPrefixLines > 0
        ? prefixToColumns(prefixBoundaryUnknown())
        : prefixToColumns(prefixBoundaryNone());
  }

  withLineageDb(dbPath, deps, (db) => {
    db.exec("BEGIN");
    try {
      // On conflict: always refresh thread binding; only overwrite prefix when
      // the caller explicitly supplied one (rebuild registration / fresh none).
      // Ordinary resume re-binds must not clear a stored verified fence.
      if (setPrefix) {
        db.prepare(
          `INSERT INTO cc_session_lineage (
             rollout_session_id, thread_id, updated_at,
             prefix_provenance, replayed_prefix_lines, replayed_prefix_bytes, replayed_prefix_sha256
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(rollout_session_id) DO UPDATE SET
             thread_id = excluded.thread_id,
             updated_at = excluded.updated_at,
             prefix_provenance = excluded.prefix_provenance,
             replayed_prefix_lines = excluded.replayed_prefix_lines,
             replayed_prefix_bytes = excluded.replayed_prefix_bytes,
             replayed_prefix_sha256 = excluded.replayed_prefix_sha256`,
        ).run(sessionId, threadId, nowFn().toISOString(), cols.provenance, cols.lines, cols.bytes, cols.sha256);
      } else {
        // Ordinary rebind: update an existing row's thread binding only.
        // Do NOT insert a missing target as known-none (that poisons later resume).
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
          // No row: leave absent. Callers that need a new row must pass explicit
          // prefix (fresh none or verified rebuild).
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

/**
 * Launch class for provenance decisions.
 * - fresh: wrapper-created genuinely new session (fresh / explicit_new only)
 * - existing: resume, continue, fork, rebuilt handoff, or any pre-existing id
 */
export type LaunchClass = "fresh" | "existing";

export interface BindCaptureThreadInput {
  sessionId: string;
  /**
   * The thread this session belongs to, resolved through the registry alias
   * map at launch. cc-lhc storage never answers thread identity here.
   */
  threadId: string;
  /**
   * True when the launch created this thread. Only a wrapper-created fresh
   * session on a brand-new thread may establish known-none provenance.
   */
  threadCreatedAtLaunch: boolean;
  /**
   * Whether this launch is allowed to establish known-none on a new thread.
   * Defaults to `existing` (fail closed) when omitted.
   */
  launchClass?: LaunchClass;
  registryPath?: string;
  lineageDbPath?: string;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  /** Structured lineage failure (not log substring). */
  onLineageFailure?: (reason: string) => void;
  lineageDeps?: LineageDbDeps;
}

export interface BindCaptureThreadResult {
  threadRef: ThreadRef;
  isExistingThread: boolean;
  /**
   * Prefix provenance for **input.sessionId** (the session being bound).
   * Loaded from durable lineage so external resume after process exit can
   * content-verify before skipping served projection.
   */
  prefix: PrefixBoundary;
  /** @deprecated Prefer `prefix`; verified line count only when kind=verified. */
  replayedPrefixLines: number;
  dedupeState: ReplayDedupeState;
  persistSignatures: (signatures: string[]) => Promise<LineageOutcome>;
}

/**
 * Bind one Claude session to the thread the registry already named, and load
 * the host-local capture detail that binding needs: the session's own prefix
 * proof and the thread's replay signatures. Thread identity is an input here,
 * never a lookup.
 */
export async function bindCaptureThread(input: BindCaptureThreadInput): Promise<BindCaptureThreadResult> {
  const dbPath = input.lineageDbPath ?? defaultLineageDbPath();
  const registryPath = input.registryPath ?? defaultRegistryPath();
  const log = input.log ?? (() => {});
  const logError = input.logError ?? (() => {});
  const onLineageFailure = input.onLineageFailure ?? (() => {});
  // Default existing: never establish known-none without an explicit fresh launch.
  const launchClass: LaunchClass = input.launchClass ?? "existing";
  const threadId = input.threadId;

  let lineageReadFailed = false;
  /** The session's own stored prefix proof, when it already has a row. */
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
    /**
     * Provenance for an existing binding:
     * - any lineage read failure → unknown
     * - the session has its own row → its stored prefix
     * - no row yet (first launch of this session on a known thread) → unknown
     */
    const prefix = lineageReadFailed ? prefixBoundaryUnknown() : (targetPrefix ?? prefixBoundaryUnknown());
    const prefixNote =
      prefix.kind === "verified"
        ? ` (prefix=verified lines=${prefix.lineCount} bytes=${prefix.byteLength})`
        : prefix.kind === "unknown"
          ? " (prefix=unknown)"
          : " (prefix=none)";
    log(`cc-lhc: continuing thread ${threadId} for session ${input.sessionId}${prefixNote}`);
    // Re-bind thread only — do not clear a stored rebuilt-prefix fence.
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

  // Known-none only for wrapper-created genuinely fresh launches with healthy
  // lineage I/O. Lineage read failure or existing-class launch → unknown.
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

/** @deprecated use defaultLineageDbPath */
export const defaultLineagePath = defaultLineageDbPath;
