import { existsSync } from "node:fs";
import { runWithThreadTouchSuppressed } from "../../shared/context.js";
import { storageFailure, type ErrorResult, type OpResult } from "../../shared/errors.js";
import {
  createThreadFile,
  deleteThreadFile,
  generateThreadId,
  openThreadDatabase,
} from "./internal/create.js";

// Re-exported for the other domain surfaces: opening a thread file through
// the threads domain is what guarantees its schema is current (a pre-Story-3
// file gains the message tables here before any write or read touches them).
export { openThreadDatabase };
import {
  insertThreadRow,
  openRegistryForRead,
  openRegistryForWrite,
  resolveRegistryPath,
  selectAllThreadRows,
  selectThreadRow,
  type RegistryRow,
} from "./internal/registry.js";

export type ThreadRef =
  | { threadId: string; registryPath?: string }
  | { filePath: string };

export interface NewThreadInput {
  filePath: string;
  title?: string;
  registryPath?: string;
}

export interface ThreadInfo {
  threadId: string;
  filePath: string;
  title?: string;
  createdAt: string; // ISO-8601
}

function toThreadInfo(row: RegistryRow): ThreadInfo {
  const info: ThreadInfo = {
    threadId: row.threadId,
    filePath: row.filePath,
    createdAt: row.createdAt,
  };
  if (row.title !== undefined) info.title = row.title;
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
export async function newThread(
  input: NewThreadInput,
): Promise<OpResult<{ threadId: string; filePath: string }>> {
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

  let registry;
  try {
    registry = openRegistryForWrite(resolveRegistryPath(input.registryPath));
    const row: RegistryRow = { threadId, filePath: input.filePath, createdAt };
    if (input.title !== undefined) row.title = input.title;
    insertThreadRow(registry, row);
  } catch (cause) {
    deleteThreadFile(input.filePath);
    return storageFailure(`registry insert failed: ${detail(cause)}`);
  } finally {
    registry?.close();
  }

  return { ok: true, value: { threadId, filePath: input.filePath } };
}

export async function resolve(input: {
  threadId: string;
  registryPath?: string;
}): Promise<OpResult<ThreadInfo>> {
  let registry;
  try {
    registry = openRegistryForRead(resolveRegistryPath(input.registryPath));
    if (registry === null) return threadNotFound(input.threadId);
    const row = selectThreadRow(registry, input.threadId);
    if (row === undefined) return threadNotFound(input.threadId);
    return { ok: true, value: toThreadInfo(row) };
  } catch (cause) {
    return storageFailure(`registry read failed: ${detail(cause)}`);
  } finally {
    registry?.close();
  }
}

export async function listThreads(input?: {
  registryPath?: string;
}): Promise<OpResult<ThreadInfo[]>> {
  let registry;
  try {
    registry = openRegistryForRead(resolveRegistryPath(input?.registryPath));
    if (registry === null) return { ok: true, value: [] };
    return { ok: true, value: selectAllThreadRows(registry).map(toThreadInfo) };
  } catch (cause) {
    return storageFailure(`registry read failed: ${detail(cause)}`);
  } finally {
    registry?.close();
  }
}

// The thread file's own identity header (Epic 04): thread_metadata is this
// domain's table — creation writes it (internal/create.ts) and only this
// surface reads it back. Added for inspect's overview, which must report
// thread identity for ANY resolvable ref — including a { filePath } ref that
// no registry knows — without reading tables itself (inspect's must-not-own
// rule). A pure read: the whole operation runs touch-suppressed (DD-6), so a
// background SDK can never hang a first-touch catch-up drain off it.
export interface ThreadFileInfo {
  threadId: string;
  createdAt: string;
}

export async function info(ref: ThreadRef): Promise<OpResult<ThreadFileInfo>> {
  return runWithThreadTouchSuppressed(() => infoInner(ref));
}

async function infoInner(ref: ThreadRef): Promise<OpResult<ThreadFileInfo>> {
  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) {
    return {
      ok: false,
      error: {
        errorClass: "caller_error",
        code: "thread_not_found",
        reason: `no thread file exists at ${filePath}`,
      },
    };
  }
  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const row = db
      .prepare(`SELECT thread_id, created_at FROM thread_metadata WHERE id = 1`)
      .get() as { thread_id: string; created_at: string } | undefined;
    if (row === undefined) {
      // openThreadDatabase validated the row exists; its absence here is
      // external interference between the probe and this read.
      return storageFailure(`thread file at ${filePath} lost its metadata row`);
    }
    return { ok: true, value: { threadId: row.thread_id, createdAt: row.created_at } };
  } catch (cause) {
    return storageFailure(`thread info read failed: ${detail(cause)}`);
  } finally {
    db.close();
  }
}

// The single interpreter of thread references: { threadId } resolves to a
// path through the registry, { filePath } passes through untouched. No other
// code ever reads a thread reference.
export async function resolveThreadRef(
  ref: ThreadRef,
): Promise<OpResult<{ filePath: string }>> {
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
