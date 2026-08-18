import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { createDbReadTransaction, type ErrorResult, type OpResult, storageFailure } from "../shared-tech/index.js";
import { createThreadFile, deleteThreadFile, generateThreadId, openThreadDatabase } from "./internal/create.js";

// Re-exported for the other domain surfaces: opening a thread file through
// the threads domain is what guarantees its schema is current before any write
// or read touches it.
export { openThreadDatabase };

import {
  insertAliasRowIfAbsent,
  insertThreadRow,
  openExistingRegistry,
  openRegistryForRead,
  openRegistryForWrite,
  type RegistryRow,
  resolveRegistryPath,
  selectAliasResolutionRow,
  selectAliasRow,
  selectAllThreadRows,
  selectCurrentAliasRow,
  selectThreadRow,
  selectThreadRowsByPrefix,
  upsertCurrentAliasRow,
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

// The alias map: a host's own opaque session ids, qualified by host, pointing
// at the LHC thread they belong to. One thread accumulates many aliases over
// its life; exactly one of them is current — the latest the host accepted.
// This is the layer consulted before any thread file opens.

export interface ThreadAliasRegistration {
  alias: string;
  threadId: string;
  registryPath?: string;
}

export interface ThreadAliasLookup {
  alias: string;
  registryPath?: string;
}

export interface ThreadCurrentAliasLookup {
  threadId: string;
  registryPath?: string;
}

export interface ThreadAliasBinding {
  alias: string;
  threadId: string;
  registeredAt: string;
}

// currentAlias is null when the thread has aliases but has not accepted one
// yet: absence is reported as a value, so a caller entering through an old
// alias still learns its thread instead of being refused.
export interface ThreadAliasResolution {
  alias: string;
  threadId: string;
  currentAlias: string | null;
}

export interface ThreadCurrentAlias {
  threadId: string;
  currentAlias: string | null;
}

function invalidThreadAlias(reason: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: { errorClass: "caller_error", code: "invalid_thread_alias", reason },
  };
}

function aliasNotFound(alias: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: {
      errorClass: "caller_error",
      code: "alias_not_found",
      reason: `no thread registered under alias ${alias}`,
    },
  };
}

function aliasBoundToOtherThread(alias: string, boundThreadId: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: {
      errorClass: "caller_error",
      code: "alias_bound_to_other_thread",
      reason: `alias ${alias} is already registered to thread ${boundThreadId} and never rebinds`,
    },
  };
}

// Aliases are opaque to core and host-qualified as "<host>:<host-alias>". Core
// looks for the qualifier separator and nothing else — it never reads either
// side, so no host's id structure is parsed here. The qualifier is what keeps
// one shared registry from colliding two hosts' native session ids.
const ALIAS_QUALIFIER_SEPARATOR = ":";

function rejectInvalidAlias(alias: string): { ok: false; error: ErrorResult } | null {
  if (alias.trim() === "") {
    return invalidThreadAlias("alias must be a non-empty host-qualified key; received a blank string");
  }
  const separator = alias.indexOf(ALIAS_QUALIFIER_SEPARATOR);
  if (separator <= 0 || separator === alias.length - 1) {
    return invalidThreadAlias(
      `alias "${alias}" must be host-qualified as <host>${ALIAS_QUALIFIER_SEPARATOR}<host-alias>, e.g. claude-code:<uuid>`,
    );
  }
  return null;
}

function rejectInvalidThreadId(threadId: string): { ok: false; error: ErrorResult } | null {
  return threadId.trim() === ""
    ? invalidThreadRef("threadId must be a non-empty thread id; received a blank string")
    : null;
}

function rejectInvalidRegistration(registration: ThreadAliasRegistration): { ok: false; error: ErrorResult } | null {
  return rejectInvalidAlias(registration.alias) ?? rejectInvalidThreadId(registration.threadId);
}

// Registering and advancing share one transaction body so the pointer can never
// be advanced in a separate commit from the registration it depends on.
function bindAlias(
  registry: DatabaseSync,
  registration: ThreadAliasRegistration,
  advanceCurrent: boolean,
): OpResult<ThreadAliasBinding> {
  registry.exec("BEGIN IMMEDIATE;");
  try {
    const now = new Date().toISOString();
    insertAliasRowIfAbsent(registry, {
      alias: registration.alias,
      threadId: registration.threadId,
      registeredAt: now,
    });
    const bound = selectAliasRow(registry, registration.alias);
    if (bound === undefined) {
      registry.exec("ROLLBACK;");
      return storageFailure(`registry lost alias ${registration.alias} immediately after registering it`);
    }
    if (bound.threadId !== registration.threadId) {
      registry.exec("ROLLBACK;");
      return aliasBoundToOtherThread(registration.alias, bound.threadId);
    }
    if (advanceCurrent) {
      upsertCurrentAliasRow(registry, {
        threadId: registration.threadId,
        alias: registration.alias,
        advancedAt: now,
      });
    }
    registry.exec("COMMIT;");
    return { ok: true, value: bound };
  } catch (cause) {
    registry.exec("ROLLBACK;");
    throw cause;
  }
}

// Registers an alias against a thread without touching which alias is current.
// Registering the same alias to the same thread again returns the existing
// binding; registering it to a different thread is refused — an alias names one
// thread for its whole life.
export async function registerAlias(registration: ThreadAliasRegistration): Promise<OpResult<ThreadAliasBinding>> {
  const invalid = rejectInvalidRegistration(registration);
  if (invalid !== null) return invalid;

  let registry: DatabaseSync | undefined;
  try {
    registry = openRegistryForWrite(resolveRegistryPath(registration.registryPath));
    return bindAlias(registry, registration, false);
  } catch (cause) {
    return storageFailure(`registry alias registration failed: ${detail(cause)}`);
  } finally {
    registry?.close();
  }
}

// Registers an alias and makes it the thread's current alias in one commit, so
// no reader ever sees a current pointer whose alias is not yet registered.
// Called with an alias the thread already holds, it advances the pointer alone.
export async function registerCurrentAlias(
  registration: ThreadAliasRegistration,
): Promise<OpResult<ThreadAliasResolution>> {
  const invalid = rejectInvalidRegistration(registration);
  if (invalid !== null) return invalid;

  let registry: DatabaseSync | undefined;
  try {
    registry = openRegistryForWrite(resolveRegistryPath(registration.registryPath));
    const bound = bindAlias(registry, registration, true);
    if (!bound.ok) return bound;
    return {
      ok: true,
      value: {
        alias: bound.value.alias,
        threadId: bound.value.threadId,
        currentAlias: bound.value.alias,
      },
    };
  } catch (cause) {
    return storageFailure(`registry alias advance failed: ${detail(cause)}`);
  } finally {
    registry?.close();
  }
}

// The entry point for a host holding any alias of a thread: it answers which
// thread that alias belongs to and which alias that thread currently accepts,
// from one read. An alias no registry knows is a miss, not a failure of the
// registry — the caller decides what to do with an unknown alias.
export async function resolveAlias(lookup: ThreadAliasLookup): Promise<OpResult<ThreadAliasResolution>> {
  const invalid = rejectInvalidAlias(lookup.alias);
  if (invalid !== null) return invalid;

  let registry: DatabaseSync | null | undefined;
  try {
    registry = openExistingRegistry(resolveRegistryPath(lookup.registryPath));
    if (registry === null) return aliasNotFound(lookup.alias);
    const resolution = selectAliasResolutionRow(registry, lookup.alias);
    if (resolution === undefined) return aliasNotFound(lookup.alias);
    return {
      ok: true,
      value: {
        alias: lookup.alias,
        threadId: resolution.threadId,
        currentAlias: resolution.currentAlias,
      },
    };
  } catch (cause) {
    return storageFailure(`registry alias read failed: ${detail(cause)}`);
  } finally {
    registry?.close();
  }
}

// The thread's current alias on its own, for a caller that already holds the
// thread id. A thread with no accepted alias yet reports null.
export async function currentAlias(lookup: ThreadCurrentAliasLookup): Promise<OpResult<ThreadCurrentAlias>> {
  const invalid = rejectInvalidThreadId(lookup.threadId);
  if (invalid !== null) return invalid;

  let registry: DatabaseSync | null | undefined;
  try {
    registry = openExistingRegistry(resolveRegistryPath(lookup.registryPath));
    if (registry === null) return { ok: true, value: { threadId: lookup.threadId, currentAlias: null } };
    return {
      ok: true,
      value: { threadId: lookup.threadId, currentAlias: selectCurrentAliasRow(registry, lookup.threadId) },
    };
  } catch (cause) {
    return storageFailure(`registry current-alias read failed: ${detail(cause)}`);
  } finally {
    registry?.close();
  }
}
