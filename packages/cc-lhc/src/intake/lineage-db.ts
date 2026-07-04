import { existsSync, mkdirSync, renameSync } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { OpResult, ThreadRef } from "lhc";

import { encodeProjectPath } from "../rollout/discover.js";
import { captureThreadRef, defaultLineageDbPath, defaultRegistryPath } from "./paths.js";
import { createReplayDedupeState, MAX_THREAD_SIGNATURES, type ReplayDedupeState } from "./replay-dedupe.js";

export interface LineageSessionEntry {
  threadId: string;
  updatedAt: string;
}

export interface LineageDbDeps {
  nowFn?: () => Date;
  readdirFn?: typeof readdir;
  statFn?: typeof stat;
  accessFn?: typeof access;
  mkdirFn?: (path: string) => void;
  renameFn?: (from: string, to: string) => void;
  existsFn?: (path: string) => boolean;
  openDbFn?: (path: string) => DatabaseSync;
  withDb?: (dbPath: string, run: (db: DatabaseSync) => void) => void;
}

const defaultDeps = (): Required<Pick<LineageDbDeps, "nowFn" | "readdirFn" | "statFn" | "accessFn">> & LineageDbDeps => ({
  nowFn: () => new Date(),
  readdirFn: readdir,
  statFn: stat,
  accessFn: access,
  mkdirFn: (path: string) => {
    mkdirSync(path, { recursive: true });
  },
  renameFn: (from: string, to: string) => {
    renameSync(from, to);
  },
  existsFn: (path: string) => existsSync(path),
});

function isENOENT(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as NodeJS.ErrnoException).code === "ENOENT";
}

export function lineageWriteFailureMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return `[cc-lhc] lineage write failed (continuing): ${message}`;
}

export function lineageReadFailureMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return `[cc-lhc] lineage read failed (continuing): ${message}`;
}

function safeLineageRead<T>(
  logError: (message: string) => void,
  run: () => T,
  fallback: T,
): T {
  try {
    return run();
  } catch (cause) {
    logError(lineageReadFailureMessage(cause));
    return fallback;
  }
}

async function safeLineageReadAsync<T>(
  logError: (message: string) => void,
  run: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    logError(lineageReadFailureMessage(cause));
    return fallback;
  }
}

function initLineageSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_session_lineage (
      rollout_session_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
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
  } catch {
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

export async function safeRecordSessionThread(
  dbPath: string,
  sessionId: string,
  threadId: string,
  logError: (message: string) => void,
  deps: LineageDbDeps = {},
): Promise<void> {
  try {
    recordSessionThread(dbPath, sessionId, threadId, deps);
  } catch (cause) {
    logError(lineageWriteFailureMessage(cause));
  }
}

export async function safeAppendThreadSignatures(
  dbPath: string,
  threadId: string,
  added: readonly string[],
  logError: (message: string) => void,
  deps: LineageDbDeps = {},
): Promise<void> {
  try {
    appendThreadSignatures(dbPath, threadId, added, deps);
  } catch (cause) {
    logError(lineageWriteFailureMessage(cause));
  }
}

export function lookupThreadForSession(dbPath: string, sessionId: string, deps: LineageDbDeps = {}): string | undefined {
  let threadId: string | undefined;
  withLineageDb(dbPath, deps, (db) => {
    const row = db
      .prepare("SELECT thread_id FROM cc_session_lineage WHERE rollout_session_id = ?")
      .get(sessionId) as { thread_id: string } | undefined;
    threadId = row?.thread_id;
  });
  return threadId;
}

export function newestSessionEntry(
  dbPath: string,
  deps: LineageDbDeps = {},
): { sessionId: string; entry: LineageSessionEntry } | undefined {
  let best: { sessionId: string; entry: LineageSessionEntry } | undefined;
  withLineageDb(dbPath, deps, (db) => {
    const row = db
      .prepare(
        "SELECT rollout_session_id, thread_id, updated_at FROM cc_session_lineage ORDER BY updated_at DESC LIMIT 1",
      )
      .get() as { rollout_session_id: string; thread_id: string; updated_at: string } | undefined;
    if (row === undefined) return;
    best = { sessionId: row.rollout_session_id, entry: { threadId: row.thread_id, updatedAt: row.updated_at } };
  });
  return best;
}

export async function newestJsonlSessionId(
  projectsRoot: string,
  cwd: string,
  deps: LineageDbDeps = {},
): Promise<string | undefined> {
  const { readdirFn, statFn } = { ...defaultDeps(), ...deps };
  const projectDir = join(projectsRoot, encodeProjectPath(cwd));
  let names: string[];
  try {
    names = await readdirFn(projectDir);
  } catch (cause) {
    if (isENOENT(cause)) return undefined;
    throw cause;
  }

  let best: { sessionId: string; mtimeMs: number } | undefined;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = join(projectDir, name);
    try {
      const fileStat = await statFn(filePath);
      const sessionId = basename(name, ".jsonl");
      if (best === undefined || fileStat.mtimeMs > best.mtimeMs) {
        best = { sessionId, mtimeMs: fileStat.mtimeMs };
      }
    } catch {
      // skip unreadable
    }
  }
  return best?.sessionId;
}

export async function tryContinueThreadFromNewestSession(
  dbPath: string,
  cwd: string,
  projectsRoot: string,
  deps: LineageDbDeps = {},
): Promise<{ sessionId: string; threadId: string } | undefined> {
  const newest = newestSessionEntry(dbPath, deps);
  if (newest === undefined) return undefined;
  const newestJsonl = await newestJsonlSessionId(projectsRoot, cwd, deps);
  if (newestJsonl === undefined || newestJsonl !== newest.sessionId) return undefined;
  return { sessionId: newest.sessionId, threadId: newest.entry.threadId };
}

export function recordSessionThread(
  dbPath: string,
  sessionId: string,
  threadId: string,
  deps: LineageDbDeps = {},
): void {
  const { nowFn } = { ...defaultDeps(), ...deps };
  withLineageDb(dbPath, deps, (db) => {
    db.exec("BEGIN");
    try {
      db.prepare(
        "INSERT INTO cc_session_lineage (rollout_session_id, thread_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(rollout_session_id) DO UPDATE SET thread_id = excluded.thread_id, updated_at = excluded.updated_at",
      ).run(sessionId, threadId, nowFn().toISOString());
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
): string[] {
  return safeLineageRead(logError, () => loadThreadSignatures(dbPath, threadId, deps), []);
}

export interface ResolveCaptureThreadInput {
  sessionId: string;
  cwd: string;
  resumeSessionId?: string;
  continueFlag?: boolean;
  registryPath?: string;
  lineageDbPath?: string;
  projectsRoot?: string;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  lineageDeps?: LineageDbDeps;
  createThreadFn: (cwd: string, registryPath: string) => Promise<OpResult<ThreadRef>>;
}

export interface ResolveCaptureThreadResult {
  threadRef: ThreadRef;
  isExistingThread: boolean;
  dedupeState: ReplayDedupeState;
  persistSignatures: (signatures: string[]) => Promise<void>;
}

export async function resolveCaptureThread(input: ResolveCaptureThreadInput): Promise<ResolveCaptureThreadResult> {
  const dbPath = input.lineageDbPath ?? defaultLineageDbPath();
  const registryPath = input.registryPath ?? defaultRegistryPath();
  const log = input.log ?? (() => {});
  const logError = input.logError ?? (() => {});

  let threadId: string | undefined = safeLineageRead(
    logError,
    () => lookupThreadForSession(dbPath, input.sessionId, input.lineageDeps),
    undefined,
  );
  let isExistingThread = threadId !== undefined;

  if (threadId === undefined && input.resumeSessionId !== undefined) {
    const fromResume = safeLineageRead(
      logError,
      () => lookupThreadForSession(dbPath, input.resumeSessionId!, input.lineageDeps),
      undefined,
    );
    if (fromResume !== undefined) {
      threadId = fromResume;
      isExistingThread = true;
    }
  }

  if (threadId === undefined && input.continueFlag === true && input.projectsRoot !== undefined) {
    const continued = await safeLineageReadAsync(
      logError,
      () => tryContinueThreadFromNewestSession(dbPath, input.cwd, input.projectsRoot!, input.lineageDeps),
      undefined,
    );
    if (continued !== undefined) {
      threadId = continued.threadId;
      isExistingThread = true;
    }
  }

  if (threadId !== undefined) {
    log(`cc-lhc: continuing thread ${threadId} for session ${input.sessionId}`);
    await safeRecordSessionThread(dbPath, input.sessionId, threadId, logError, input.lineageDeps);
    const signatures = safeLoadThreadSignatures(dbPath, threadId, logError, input.lineageDeps);
    const threadRef = captureThreadRef(threadId, registryPath);
    return {
      threadRef,
      isExistingThread,
      dedupeState: createReplayDedupeState(isExistingThread, signatures),
      persistSignatures: async (added) => {
        await safeAppendThreadSignatures(dbPath, threadId!, added, logError, input.lineageDeps);
      },
    };
  }

  const created = await input.createThreadFn(input.cwd, registryPath);
  if (!created.ok) {
    throw new Error(`cc-lhc thread create failed: ${created.error.reason}`);
  }
  const newThreadId = "threadId" in created.value ? created.value.threadId : "";
  if (newThreadId === "") {
    throw new Error("cc-lhc thread create failed: missing threadId");
  }
  await safeRecordSessionThread(dbPath, input.sessionId, newThreadId, logError, input.lineageDeps);
  return {
    threadRef: captureThreadRef(newThreadId, registryPath),
    isExistingThread: false,
    dedupeState: createReplayDedupeState(false, []),
    persistSignatures: async (added) => {
      await safeAppendThreadSignatures(dbPath, newThreadId, added, logError, input.lineageDeps);
    },
  };
}

export { defaultLineageDbPath } from "./paths.js";

/** @deprecated use defaultLineageDbPath */
export const defaultLineagePath = defaultLineageDbPath;
