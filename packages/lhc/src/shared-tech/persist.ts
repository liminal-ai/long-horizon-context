import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { ThreadRef } from "../threads/index.js";
import { openThreadDatabase } from "../threads/internal/create.js";
import {
  openRegistryForRead,
  resolveRegistryPath,
  selectThreadRow,
  selectThreadRowsByPrefix,
} from "../threads/internal/registry.js";
import { resolveInstancePoke, runWithThreadTouchSuppressed } from "./context.js";
import { type ErrorResult, type OpResult, storageFailure } from "./errors.js";

export interface PostCommitHook {
  add(operation: () => void): void;
}

interface PostCommitHookSet extends PostCommitHook {
  flush(): void;
}

export interface DbReadTransaction {
  db: DatabaseSync;
  threadId: string;
  filePath: string;
}

export interface DbWriteTransaction extends DbReadTransaction {
  clock: () => Date;
  postCommitHook: PostCommitHook;
  poke(threadId: string): void;
}

export function createPostCommitHookSet(): PostCommitHookSet {
  const operations: Array<() => void> = [];
  return {
    add(operation) {
      operations.push(operation);
    },
    flush() {
      for (const operation of operations.splice(0)) operation();
    },
  };
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

function fileNotFound(filePath: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: {
      errorClass: "caller_error",
      code: "thread_not_found",
      reason: `no thread file exists at ${filePath}`,
    },
  };
}

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

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isBlankPath(filePath: string): boolean {
  return filePath.trim() === "";
}

async function resolveThreadFile(threadRef: ThreadRef): Promise<OpResult<{ filePath: string }>> {
  if ("filePath" in threadRef) {
    if (isBlankPath(threadRef.filePath)) {
      return invalidThreadRef("filePath must be a non-empty path; received a blank string");
    }
    return { ok: true, value: { filePath: threadRef.filePath } };
  }

  let registry: DatabaseSync | null | undefined;
  try {
    registry = openRegistryForRead(resolveRegistryPath(threadRef.registryPath));
    if (registry === null) return threadNotFound(threadRef.threadId);
    const exact = selectThreadRow(registry, threadRef.threadId);
    if (exact !== undefined) return { ok: true, value: { filePath: exact.filePath } };
    const matches = selectThreadRowsByPrefix(registry, threadRef.threadId);
    if (matches.length === 1) return { ok: true, value: { filePath: matches[0]!.filePath } };
    if (matches.length > 1) {
      return ambiguousThreadId(
        threadRef.threadId,
        matches.map((match) => match.threadId),
      );
    }
    return threadNotFound(threadRef.threadId);
  } catch (cause) {
    return storageFailure(`registry read failed: ${detail(cause)}`);
  } finally {
    registry?.close();
  }
}

function readThreadId(db: DatabaseSync, filePath: string): OpResult<string> {
  try {
    const row = db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").get() as
      | { thread_id: string }
      | undefined;
    if (row === undefined) return storageFailure(`thread file at ${filePath} lost its metadata row`);
    return { ok: true, value: row.thread_id };
  } catch (cause) {
    return storageFailure(`thread metadata read failed: ${detail(cause)}`);
  }
}

export async function createDbReadTransaction<T>(
  threadRef: ThreadRef,
  operation: (transaction: DbReadTransaction) => T | Promise<T>,
): Promise<OpResult<T>> {
  return runWithThreadTouchSuppressed(async () => {
    const resolved = await resolveThreadFile(threadRef);
    if (!resolved.ok) return resolved;
    const { filePath } = resolved.value;
    if (!existsSync(filePath)) return fileNotFound(filePath);
    const opened = openThreadDatabase(filePath);
    if (!opened.ok) return opened;
    const db = opened.value;
    try {
      db.exec("BEGIN;");
      const threadId = readThreadId(db, filePath);
      if (!threadId.ok) {
        db.exec("ROLLBACK;");
        return threadId;
      }
      const value = await operation({ db, threadId: threadId.value, filePath });
      db.exec("COMMIT;");
      return { ok: true, value };
    } catch (cause) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // The handle may already be closed by an induced-failure seam.
      }
      throw cause;
    } finally {
      try {
        db.close();
      } catch {
        // Already closed by an induced-failure seam.
      }
    }
  });
}

export async function createDbWriteTransaction<T>(
  threadRef: ThreadRef,
  operation: (transaction: DbWriteTransaction) => T | Promise<T>,
  clock: () => Date = () => new Date(),
): Promise<OpResult<T>> {
  const resolved = await resolveThreadFile(threadRef);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return fileNotFound(filePath);
  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  const postCommitHook = createPostCommitHookSet();
  try {
    const threadId = readThreadId(db, filePath);
    if (!threadId.ok) return threadId;
    db.exec("BEGIN IMMEDIATE;");
    let value: T;
    try {
      value = await operation({
        db,
        filePath,
        threadId: threadId.value,
        clock,
        postCommitHook,
        poke: resolveInstancePoke(),
      });
      db.exec("COMMIT;");
    } catch (cause) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // The handle may have been closed by an induced-failure seam; SQLite
        // has already discarded the open transaction in that case.
      }
      throw cause;
    }
    postCommitHook.flush();
    return { ok: true, value };
  } finally {
    try {
      db.close();
    } catch {
      // Already closed by an induced-failure seam.
    }
  }
}
