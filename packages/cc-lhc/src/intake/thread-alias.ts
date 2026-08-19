/**
 * Claude session aliases of one LHC thread.
 *
 * A thread accumulates many native Claude session ids over its life — the
 * original, one per compact rebuild, one per resume. The LHC registry holds
 * the alias map (R15): every alias names one thread for its whole life, and
 * one alias per thread is current — the latest session the wrapper accepted.
 * cc-lhc storage is no longer the session→thread authority; it keeps
 * host-local detail (rollout paths, prefix proof, prompt-intake evidence,
 * recovery detail).
 *
 * Aliases are host-qualified (`claude-code:<uuid>`) so a registry shared with
 * another host cannot collide two hosts' native session ids.
 */

import { threads } from "lhc";

import {
  type LineageDbDeps,
  type ThreadSessionRow,
  threadForLegacySession,
  threadSessionRows,
} from "./lineage-db.js";

/** Qualifier for every Claude Code session alias in the shared registry. */
export const CLAUDE_ALIAS_HOST = "claude-code";

export function claudeSessionAlias(sessionId: string): string {
  return `${CLAUDE_ALIAS_HOST}:${sessionId}`;
}

/** The native session id inside a Claude Code alias; null for any other host. */
export function claudeSessionIdFromAlias(alias: string): string | null {
  const prefix = `${CLAUDE_ALIAS_HOST}:`;
  if (!alias.startsWith(prefix)) return null;
  const sessionId = alias.slice(prefix.length);
  return sessionId === "" ? null : sessionId;
}

/**
 * The registry could not answer. Launch says so instead of guessing a thread
 * from cwd, recency, or the newest thread — a wrong guess captures one
 * conversation into another thread.
 */
export class ThreadRegistryUnavailableError extends Error {
  constructor(reason: string) {
    super(`cc-lhc cannot read the LHC thread registry: ${reason}`);
    this.name = "ThreadRegistryUnavailableError";
  }
}

function unavailable(reason: string): never {
  throw new ThreadRegistryUnavailableError(reason);
}

/** The thread one launch owns, and whether that launch brought it into being. */
export interface LaunchThreadBinding {
  threadId: string;
  createdAtLaunch: boolean;
}

export interface LaunchThreadLookup {
  /** The native Claude session this launch asked for; qualified here. */
  sessionId: string;
  registryPath: string;
  lineageDbPath: string;
  lineageDeps?: LineageDbDeps;
  log?: (message: string) => void;
}

/**
 * The thread this launch alias belongs to, or null when no thread has ever
 * held it. The answer authorizes the owner-lock key and NOTHING else: which
 * session the launch lands on is re-read under the acquired lock, because the
 * current pointer can advance between this read and the lock.
 */
export async function resolveLaunchThread(lookup: LaunchThreadLookup): Promise<string | null> {
  const registryPath = lookup.registryPath;
  const alias = claudeSessionAlias(lookup.sessionId);
  const resolved = await threads.resolveAlias({ alias, registryPath });
  if (resolved.ok) return resolved.value.threadId;
  if (resolved.error.code !== "alias_not_found") unavailable(resolved.error.reason);

  const imported = await importLegacyLineage(lookup);
  if (imported === null) return null;

  // Read the alias back through the registry: if a concurrent importer bound
  // it first, that binding is the truth, not what legacy storage claimed.
  const reread = await threads.resolveAlias({ alias, registryPath });
  if (reread.ok) return reread.value.threadId;
  if (reread.error.code !== "alias_not_found") unavailable(reread.error.reason);
  return null;
}

/**
 * The thread this launch competes for: the one that already holds the alias,
 * or a new one the launch creates and claims. Creation races are settled by
 * the registry — an alias names one thread for its whole life, so the loser
 * adopts the winner's thread and both launches then contend for one lock.
 *
 * The answer authorizes the lock key only. `currentSessionAlias` under the
 * acquired lock decides which session the launch lands on.
 */
export async function bindLaunchThread(
  lookup: LaunchThreadLookup & { createThread: () => Promise<string> },
): Promise<LaunchThreadBinding> {
  const existing = await resolveLaunchThread(lookup);
  if (existing !== null) return { threadId: existing, createdAtLaunch: false };

  const log = lookup.log ?? (() => {});
  const alias = claudeSessionAlias(lookup.sessionId);
  const threadId = await lookup.createThread();
  const claimed = await threads.registerCurrentAlias({ alias, threadId, registryPath: lookup.registryPath });
  if (claimed.ok) return { threadId, createdAtLaunch: true };
  if (claimed.error.code !== "alias_bound_to_other_thread") unavailable(claimed.error.reason);

  const winner = await threads.resolveAlias({ alias, registryPath: lookup.registryPath });
  if (!winner.ok) unavailable(winner.error.reason);
  log(
    `cc-lhc: another wrapper claimed ${alias} first — using thread ${winner.value.threadId}; ` +
      `the thread ${threadId} this launch created is unused`,
  );
  return { threadId: winner.value.threadId, createdAtLaunch: false };
}

/**
 * One-way import of the pre-registry cc-lhc lineage for the thread this alias
 * belonged to, on the first registry miss. Every legacy session of that thread
 * becomes an alias; its most recently bound session becomes current. Nothing
 * reads legacy lineage for thread identity again once the alias is registered,
 * and a registry binding that already exists always wins.
 */
async function importLegacyLineage(lookup: LaunchThreadLookup): Promise<string | null> {
  const log = lookup.log ?? (() => {});
  const legacyThreadId = threadForLegacySession(lookup.lineageDbPath, lookup.sessionId, lookup.lineageDeps);
  if (legacyThreadId === undefined) return null;

  const rows = threadSessionRows(lookup.lineageDbPath, legacyThreadId, lookup.lineageDeps);
  if (rows.length === 0) return null;
  const current = rows[rows.length - 1]!;
  log(
    `cc-lhc: importing legacy lineage for thread ${legacyThreadId} — ${rows.length} session alias(es), ` +
      `current ${current.sessionId}`,
  );

  for (const row of rows) {
    const registration = {
      alias: claudeSessionAlias(row.sessionId),
      threadId: legacyThreadId,
      registryPath: lookup.registryPath,
    };
    const bound =
      row === current
        ? await threads.registerCurrentAlias(registration)
        : await threads.registerAlias(registration);
    if (bound.ok) continue;
    if (bound.error.code === "alias_bound_to_other_thread") {
      // The registry already knows this session's thread. Legacy storage never
      // overwrites it — the import skips the alias and keeps going.
      log(`cc-lhc: legacy import skipped ${registration.alias} — ${bound.error.reason}`);
      continue;
    }
    unavailable(bound.error.reason);
  }
  return legacyThreadId;
}

/**
 * The alias this thread currently accepts, read under the acquired thread
 * lock. Null means the thread has no accepted session yet.
 */
export async function currentSessionAlias(threadId: string, registryPath: string): Promise<string | null> {
  const current = await threads.currentAlias({ threadId, registryPath });
  if (!current.ok) unavailable(current.error.reason);
  return current.value.currentAlias;
}

/**
 * Bind a Claude session to a thread and make it the thread's current session.
 * Used when a launch creates the thread and when a swap is accepted.
 */
export async function acceptCurrentSession(input: {
  sessionId: string;
  threadId: string;
  registryPath: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const advanced = await threads.registerCurrentAlias({
    alias: claudeSessionAlias(input.sessionId),
    threadId: input.threadId,
    registryPath: input.registryPath,
  });
  return advanced.ok ? { ok: true } : { ok: false, reason: advanced.error.reason };
}

export interface UnacceptedSwapArtifact {
  sessionId: string;
  updatedAt: string;
}

/**
 * Rebuilt sessions this thread reserved but never accepted — a swap that was
 * interrupted between writing the replacement rollout and the wrapper
 * observing the replacement live. The current pointer is the acceptance fact,
 * so anything bound after it was never accepted: the launch discards it from
 * session selection (the file stays on disk, untouched and unread) and lands
 * on the current session. Nothing here can stop a launch.
 */
export function unacceptedSwapArtifacts(input: {
  threadId: string;
  currentAlias: string | null;
  lineageDbPath: string;
  lineageDeps?: LineageDbDeps;
}): UnacceptedSwapArtifact[] {
  const currentSessionId = input.currentAlias === null ? null : claudeSessionIdFromAlias(input.currentAlias);
  if (currentSessionId === null) return [];
  const rows = threadSessionRows(input.lineageDbPath, input.threadId, input.lineageDeps);
  const currentIndex = rows.findIndex((row: ThreadSessionRow) => row.sessionId === currentSessionId);
  if (currentIndex === -1) return [];
  return rows
    .slice(currentIndex + 1)
    .filter((row) => row.prefix.kind === "verified")
    .map((row) => ({ sessionId: row.sessionId, updatedAt: row.updatedAt }));
}
