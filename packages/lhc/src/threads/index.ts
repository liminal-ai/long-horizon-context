import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { createDbReadTransaction, type ErrorResult, type OpResult, storageFailure } from "../shared-tech/index.js";
import { createThreadFile, deleteThreadFile, generateThreadId, openThreadDatabase } from "./internal/create.js";

// Re-exported for the other domain surfaces: opening a thread file through
// the threads domain is what guarantees its schema is current before any write
// or read touches it.
export { openThreadDatabase };

import {
  insertThreadRow,
  openRegistryForRead,
  openRegistryForWrite,
  type RegistryRow,
  resolveRegistryPath,
  selectAllThreadRows,
  selectThreadRow,
  selectThreadRowsByPrefix,
} from "./internal/registry.js";

export type ThreadRef = { threadId: string; registryPath?: string } | { filePath: string };

export interface NewThreadInput {
  filePath: string;
  title?: string;
  cwd?: string;
  registryPath?: string;
}

export interface ThreadInfo {
  threadId: string;
  filePath: string;
  title?: string;
  cwd?: string;
  createdAt: string; // ISO-8601
}

function toThreadInfo(row: RegistryRow): ThreadInfo {
  const info: ThreadInfo = {
    threadId: row.threadId,
    filePath: row.filePath,
    createdAt: row.createdAt,
  };
  if (row.title !== undefined) info.title = row.title;
  if (row.cwd !== undefined) info.cwd = row.cwd;
  return info;
}

function threadNotFound(threadId: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: {
      errorClass: "caller_error",
      code: "thread_not_found",
      reason: `no thread registered with id ${threadId}`,
    },
  };
}

// A partial id that matches more than one thread is a caller error, not a
// silent pick: resolution names the collision and the caller must disambiguate
// An ambiguous id fails loud, never resolves arbitrarily.
function ambiguousThreadId(prefix: string, matchIds: readonly string[]): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: {
      errorClass: "caller_error",
      code: "ambiguous_thread_id",
      reason: `thread id "${prefix}" is ambiguous: it matches ${matchIds.length} threads (${matchIds.join(", ")}); use a longer id`,
    },
  };
}

function invalidThreadRef(reason: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: { errorClass: "caller_error", code: "invalid_thread_ref", reason },
  };
}

// A file path that is empty or whitespace-only cannot name a durable file:
// node:sqlite's DatabaseSync("") opens a temporary database that vanishes on
// close, so such a path must be refused as a caller error before any storage
// is touched rather than silently producing a thread with no durable file.
function isBlankPath(filePath: string): boolean {
  return filePath.trim() === "";
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Creation spans two databases that cannot share a transaction. Order is
// file-then-row with compensation: the invariant "no registry row without
// its file" is absolute; an orphan file from a crash between the writes is
// documented harmless (design decision 2).
export async function newThread(input: NewThreadInput): Promise<OpResult<{ threadId: string; filePath: string }>> {
  // Guard before any storage touch: an empty/blank path would otherwise open
  // a temp database and register a thread with no durable file (the no-row-
  // without-file invariant below depends on the path naming a real file).
  if (isBlankPath(input.filePath)) {
    return invalidThreadRef("filePath must be a non-empty path; received a blank string");
  }
  if (existsSync(input.filePath)) {
    return {
      ok: false,
      error: {
        errorClass: "caller_error",
        code: "path_exists",
        reason: `a file already exists at ${input.filePath}`,
      },
    };
  }

  const threadId = generateThreadId();
  const createdAt = new Date().toISOString();

  try {
    createThreadFile(input.filePath, threadId, createdAt);
  } catch (cause) {
    deleteThreadFile(input.filePath);
    return storageFailure(`thread file creation failed: ${detail(cause)}`);
  }

  let registry: DatabaseSync | undefined;
  try {
    registry = openRegistryForWrite(resolveRegistryPath(input.registryPath));
    const row: RegistryRow = { threadId, filePath: input.filePath, createdAt };
    if (input.title !== undefined) row.title = input.title;
    if (input.cwd !== undefined) row.cwd = input.cwd;
    insertThreadRow(registry, row);
  } catch (cause) {
    deleteThreadFile(input.filePath);
    return storageFailure(`registry insert failed: ${detail(cause)}`);
  } finally {
    registry?.close();
  }

  return { ok: true, value: { threadId, filePath: input.filePath } };
}

// Resolution accepts a full or partial (prefix) thread id (A-8). An exact id
// wins outright — a full id always resolves to itself, even if it is also a
// prefix of a longer id — so only a genuinely partial id ever consults the
// prefix path; that path resolves a unique prefix, fails ambiguous on more than
// one match, and fails not-found on none. No path ever creates a thread.
export async function resolve(input: { threadId: string; registryPath?: string }): Promise<OpResult<ThreadInfo>> {
  let registry: DatabaseSync | null | undefined;
  try {
    registry = openRegistryForRead(resolveRegistryPath(input.registryPath));
    if (registry === null) return threadNotFound(input.threadId);
    const exact = selectThreadRow(registry, input.threadId);
    if (exact !== undefined) return { ok: true, value: toThreadInfo(exact) };
    const matches = selectThreadRowsByPrefix(registry, input.threadId);
    if (matches.length === 1) return { ok: true, value: toThreadInfo(matches[0]!) };
    if (matches.length > 1) {
      return ambiguousThreadId(
        input.threadId,
        matches.map((m) => m.threadId),
      );
    }
    return threadNotFound(input.threadId);
  } catch (cause) {
    return storageFailure(`registry read failed: ${detail(cause)}`);
  } finally {
    registry?.close();
  }
}

export async function listThreads(input?: { cwd?: string; registryPath?: string }): Promise<OpResult<ThreadInfo[]>> {
  let registry: DatabaseSync | null | undefined;
  try {
    registry = openRegistryForRead(resolveRegistryPath(input?.registryPath));
    if (registry === null) return { ok: true, value: [] };
    const opts = input?.cwd === undefined ? {} : { cwd: input.cwd };
    return { ok: true, value: selectAllThreadRows(registry, opts).map(toThreadInfo) };
  } catch (cause) {
    return storageFailure(`registry read failed: ${detail(cause)}`);
  } finally {
    registry?.close();
  }
}

// The thread file's own identity header: thread_metadata is this domain's table.
// Creation writes it and only this surface reads it back. Inspect overview can
// report thread identity for any resolvable ref, including a { filePath } ref
// no registry knows, without reading tables itself. This is a pure read under
// touch suppression, so a background SDK cannot hang catch-up work off it.
export interface ThreadFileInfo {
  threadId: string;
  createdAt: string;
}

export async function info(ref: ThreadRef): Promise<OpResult<ThreadFileInfo>> {
  try {
    const result = await createDbReadTransaction(ref, (transaction): OpResult<ThreadFileInfo> => {
      const row = transaction.db.prepare(`SELECT thread_id, created_at FROM thread_metadata WHERE id = 1`).get() as
        | { thread_id: string; created_at: string }
        | undefined;
      if (row === undefined) {
        return storageFailure(`thread file at ${transaction.filePath} lost its metadata row`);
      }
      return { ok: true, value: { threadId: row.thread_id, createdAt: row.created_at } };
    });
    return result.ok ? result.value : result;
  } catch (cause) {
    return storageFailure(`thread info read failed: ${detail(cause)}`);
  }
}

// The single interpreter of thread references: { threadId } resolves to a
// path through the registry, { filePath } passes through untouched. No other
// code ever reads a thread reference.
export async function resolveThreadRef(ref: ThreadRef): Promise<OpResult<{ filePath: string }>> {
  if ("threadId" in ref) {
    const resolved = await resolve(ref);
    if (!resolved.ok) return resolved;
    return { ok: true, value: { filePath: resolved.value.filePath } };
  }
  // Mirror newThread's guard so every read surface that routes through here
  // fails closed on a blank path instead of opening a temp database.
  if (isBlankPath(ref.filePath)) {
    return invalidThreadRef("filePath must be a non-empty path; received a blank string");
  }
  return { ok: true, value: { filePath: ref.filePath } };
}
