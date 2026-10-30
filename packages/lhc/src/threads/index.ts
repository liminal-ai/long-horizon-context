import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  createDbReadTransaction,
  createDbWriteTransaction,
  type ErrorResult,
  type OpResult,
  storageFailure,
} from "../shared-tech/index.js";
import { type CopyThreadInput, copyThread } from "./fork.js";
import { createThreadFile, deleteThreadFile, generateThreadId, openThreadDatabase } from "./internal/create.js";

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

export interface AdoptThreadCopyInput {
  sourceFilePath: string;
  filePath: string;
  registryPath?: string;
  title?: string;
  cwd?: string;
}

export interface ThreadInfo {
  threadId: string;
  filePath: string;
  title?: string;
  cwd?: string;
  createdAt: string;
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

function isBlankPath(filePath: string): boolean {
  return filePath.trim() === "";
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function newThread(input: NewThreadInput): Promise<OpResult<{ threadId: string; filePath: string }>> {
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

/**
 * Copy an existing LHC thread with SQLite backup semantics and register the
 * copy under its original thread id: `copyThread` with the id kept and no
 * idle requirement. The source is opened read-only.
 */
export async function adoptThreadCopy(
  input: AdoptThreadCopyInput,
): Promise<OpResult<{ threadId: string; filePath: string }>> {
  if (isBlankPath(input.sourceFilePath) || isBlankPath(input.filePath)) {
    return invalidThreadRef("sourceFilePath and filePath must be non-empty paths");
  }
  const copyInput: CopyThreadInput = {
    source: { filePath: input.sourceFilePath },
    filePath: input.filePath,
    keepThreadId: true,
    requireIdle: false,
  };
  if (input.registryPath !== undefined) copyInput.registryPath = input.registryPath;
  if (input.title !== undefined) copyInput.title = input.title;
  if (input.cwd !== undefined) copyInput.cwd = input.cwd;
  const copied = await copyThread(copyInput);
  if (!copied.ok) return copied;
  return { ok: true, value: { threadId: copied.value.threadId, filePath: copied.value.filePath } };
}

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

export interface CompactPolicy {
  trigger: number;
  target: number;
}

export async function getCompactPolicy(ref: ThreadRef): Promise<OpResult<CompactPolicy | null>> {
  try {
    return await createDbReadTransaction(ref, (transaction) => {
      const row = transaction.db
        .prepare(`SELECT compact_trigger_tokens, compact_target_tokens FROM thread_metadata WHERE id = 1`)
        .get() as { compact_trigger_tokens: number | null; compact_target_tokens: number | null } | undefined;
      if (row?.compact_trigger_tokens == null || row.compact_target_tokens == null) return null;
      return { trigger: row.compact_trigger_tokens, target: row.compact_target_tokens };
    });
  } catch (cause) {
    return storageFailure(`compact policy read failed: ${detail(cause)}`);
  }
}

function compactPolicyRefusal(policy: CompactPolicy): string | null {
  const positive = (n: number): boolean => Number.isSafeInteger(n) && n > 0;
  if (!positive(policy.trigger) || !positive(policy.target)) {
    return `trigger and target must be positive integers; received trigger ${policy.trigger}, target ${policy.target}`;
  }
  if (policy.target >= policy.trigger) {
    return `target must be below trigger; received trigger ${policy.trigger}, target ${policy.target}`;
  }
  return null;
}

export async function setCompactPolicy(ref: ThreadRef, policy: CompactPolicy): Promise<OpResult<CompactPolicy>> {
  const refusal = compactPolicyRefusal(policy);
  if (refusal !== null) {
    return { ok: false, error: { errorClass: "caller_error", code: "invalid_compact_policy", reason: refusal } };
  }
  try {
    return await createDbWriteTransaction(ref, (transaction) => {
      transaction.db
        .prepare(`UPDATE thread_metadata SET compact_trigger_tokens = ?, compact_target_tokens = ? WHERE id = 1`)
        .run(policy.trigger, policy.target);
      return { trigger: policy.trigger, target: policy.target };
    });
  } catch (cause) {
    return storageFailure(`compact policy write failed: ${detail(cause)}`);
  }
}

export async function resolveThreadRef(ref: ThreadRef): Promise<OpResult<{ filePath: string }>> {
  if ("threadId" in ref) {
    const resolved = await resolve(ref);
    if (!resolved.ok) return resolved;
    return { ok: true, value: { filePath: resolved.value.filePath } };
  }
  if (isBlankPath(ref.filePath)) {
    return invalidThreadRef("filePath must be a non-empty path; received a blank string");
  }
  return { ok: true, value: { filePath: ref.filePath } };
}

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

export {
  type BindHostInput,
  bindHost,
  type CopyThreadInput,
  type CopyThreadReceipt,
  copyThread,
  exportHistory,
  FILE_HOST_THREAD_SCHEMA_VERSION,
  FORK_HOSTS,
  type ForkCompactChoice,
  type ForkCompactPlan,
  type ForkHost,
  forkCompactPlan,
  forkThreadId,
  HANDOFF_PROFILE,
  HISTORY_EXPORT_KINDS,
  type HistoryBlock,
  type HistoryExport,
  type HistoryMessage,
  type HistoryTurn,
  HOST_PROVIDERS,
  type HostBinding,
  handoffCompactOptions,
  hostBinding,
  hostProvider,
  type IdentityNoteInput,
  type IdentityNoteReceipt,
  identityNoteText,
  isSourceOnlyHost,
  type RepairInput,
  type RepairReceipt,
  type RepairTally,
  RUST_HOST_THREAD_SCHEMA_VERSION,
  repairDerivations,
  SOURCE_ONLY_HOSTS,
  writeIdentityNote,
} from "./fork.js";
