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
  clearPendingCurrentSession,
  type LineageDbDeps,
  readPendingCurrentSession,
  recordPendingCurrentSession,
  supersedePendingCurrentSession,
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

/** What became of a swap acceptance the wrapper observed. */
export interface SwapAcceptance {
  /** The registry current pointer now names the accepted session. */
  registryAdvanced: boolean;
  /**
   * - `applied`: the registry took it; older pending detail is superseded.
   * - `recorded`: the registry refused it; the next launch will reconcile.
   * - `unrecorded`: neither the registry nor the recovery record could be
   *   written, so nothing will reconcile it — the caller must say so.
   */
  recovery: "applied" | "recorded" | "unrecorded";
  reason?: string;
}

/**
 * Make an accepted replacement this thread's current session.
 *
 * Called once the swap is already accepted — capture ready-after-replay and a
 * live child — so nothing here may veto or roll it back. If the registry
 * cannot take the pointer, the acceptance is kept host-side together with the
 * registry current observed at that moment: that predecessor is the only state
 * the record is ever allowed to repair, which is what keeps a later successful
 * acceptance from being rolled backwards by an older unapplied one.
 *
 * A successful advance supersedes any older pending detail for the thread.
 * That cleanup is best effort; reconciliation stays correct without it.
 */
export async function recordSwapAcceptance(input: {
  sessionId: string;
  threadId: string;
  registryPath: string;
  lineageDbPath: string;
  lineageDeps?: LineageDbDeps;
  log?: (message: string) => void;
}): Promise<SwapAcceptance> {
  const log = input.log ?? (() => {});
  const advanced = await acceptCurrentSession(input);
  if (advanced.ok) {
    try {
      supersedePendingCurrentSession(input.lineageDbPath, input.threadId, input.lineageDeps);
    } catch (cause) {
      // A surviving older record cannot repair anything now: reconciliation
      // only acts on the exact predecessor it observed, and the pointer has
      // moved past it. Left for the next launch to settle.
      log(`cc-lhc: superseded pending acceptance not cleared for thread ${input.threadId}: ${detail(cause)}`);
    }
    return { registryAdvanced: true, recovery: "applied" };
  }

  let observedPrevious: string | null = null;
  try {
    const current = await currentSessionAlias(input.threadId, input.registryPath);
    observedPrevious = current === null ? null : claudeSessionIdFromAlias(current);
  } catch (cause) {
    // Without the predecessor the record can repair nothing, but recording it
    // still keeps the acceptance visible instead of silently lost.
    log(`cc-lhc: registry current unreadable while recording acceptance: ${detail(cause)}`);
  }

  try {
    recordPendingCurrentSession(
      input.lineageDbPath,
      input.threadId,
      input.sessionId,
      observedPrevious,
      input.lineageDeps,
    );
  } catch (cause) {
    return {
      registryAdvanced: false,
      recovery: "unrecorded",
      reason: `${advanced.reason}; recovery record also failed: ${detail(cause)}`,
    };
  }
  return { registryAdvanced: false, recovery: "recorded", reason: advanced.reason };
}

/**
 * What a thread's pending acceptance meant for this launch.
 * - `acceptedSessionId`: the session this host already accepted, once it is
 *   known to be this thread's current one.
 * - `registryAdvanced`: the registry pointer now names it too.
 * - `note`: a truthful line when the record could not be applied as-is.
 */
export interface PendingAcceptanceReconciliation {
  acceptedSessionId: string | null;
  registryAdvanced: boolean;
  note?: string;
}

/**
 * Reconcile a swap this host accepted whose registry pointer never advanced —
 * the wrapper died, or the write failed, after the replacement was already
 * live. Runs under the acquired thread lock, against the current pointer read
 * under that same lock.
 *
 * A record may repair only the exact predecessor state it observed. One
 * wrapper keeps its lease across every handoff it performs, so a later
 * acceptance can succeed without any launch in between and leave the older
 * record behind; matching the predecessor is what stops that stale record
 * from dragging the pointer back to a superseded session. Anything the record
 * cannot repair is settled without touching the pointer.
 *
 * The registry stays the authority throughout, and nothing here can stop a
 * launch.
 */
export async function reconcilePendingAcceptance(input: {
  threadId: string;
  /** Registry current for this thread, read under the acquired lock. */
  registryCurrentSessionId: string | null;
  registryPath: string;
  lineageDbPath: string;
  lineageDeps?: LineageDbDeps;
  log?: (message: string) => void;
}): Promise<PendingAcceptanceReconciliation> {
  const log = input.log ?? (() => {});
  let pending: ReturnType<typeof readPendingCurrentSession>;
  try {
    pending = readPendingCurrentSession(input.lineageDbPath, input.threadId, input.lineageDeps);
  } catch (cause) {
    // Unreadable recovery detail is not a reason to refuse a launch; the
    // registry answer stands on its own.
    const note = `pending acceptance record unreadable for thread ${input.threadId}: ${detail(cause)}`;
    log(`cc-lhc: ${note}`);
    return { acceptedSessionId: null, registryAdvanced: false, note };
  }
  if (pending === undefined) return { acceptedSessionId: null, registryAdvanced: false };

  if (pending.sessionId === input.registryCurrentSessionId) {
    // Already applied — by a later attempt, or by the write that appeared to fail.
    settlePending(input, pending.sessionId, log);
    return { acceptedSessionId: null, registryAdvanced: false };
  }

  if (pending.previousSessionId === null || pending.previousSessionId !== input.registryCurrentSessionId) {
    const note =
      pending.previousSessionId === null
        ? `pending acceptance of ${pending.sessionId} settled unapplied — it recorded no predecessor state to repair`
        : `pending acceptance of ${pending.sessionId} settled unapplied — thread ${input.threadId} moved to ` +
          `${input.registryCurrentSessionId ?? "no current session"} after it was recorded ` +
          `(it could only repair ${pending.previousSessionId})`;
    log(`cc-lhc: ${note}`);
    settlePending(input, pending.sessionId, log);
    return { acceptedSessionId: null, registryAdvanced: false, note };
  }

  const advanced = await threads.registerCurrentAlias({
    alias: claudeSessionAlias(pending.sessionId),
    threadId: input.threadId,
    registryPath: input.registryPath,
  });
  if (advanced.ok) {
    log(
      `cc-lhc: reconciled accepted session ${pending.sessionId} (accepted ${pending.acceptedAt}) ` +
        `into thread ${input.threadId}'s current pointer`,
    );
    settlePending(input, pending.sessionId, log);
    return { acceptedSessionId: pending.sessionId, registryAdvanced: true };
  }

  if (advanced.error.code === "alias_bound_to_other_thread") {
    // The registry says that session is not this thread's. Registry wins.
    const note =
      `pending acceptance of ${pending.sessionId} discarded — ${advanced.error.reason}; ` +
      `thread ${input.threadId} keeps its registered current session`;
    log(`cc-lhc: ${note}`);
    settlePending(input, pending.sessionId, log);
    return { acceptedSessionId: null, registryAdvanced: false, note };
  }

  const note =
    `thread ${input.threadId} accepted session ${pending.sessionId} at ${pending.acceptedAt} but the ` +
    `registry pointer still cannot advance (${advanced.error.reason}); landing on the accepted session ` +
    "and retrying at the next launch";
  log(`cc-lhc: ${note}`);
  return { acceptedSessionId: pending.sessionId, registryAdvanced: false, note };
}

function settlePending(
  input: { threadId: string; lineageDbPath: string; lineageDeps?: LineageDbDeps },
  sessionId: string,
  log: (message: string) => void,
): void {
  try {
    clearPendingCurrentSession(input.lineageDbPath, input.threadId, sessionId, input.lineageDeps);
  } catch (cause) {
    // A retained record simply reconciles again next launch: the advance is
    // idempotent. Never worth failing a launch over.
    log(`cc-lhc: pending acceptance record not cleared for thread ${input.threadId}: ${detail(cause)}`);
  }
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
  /** The session this launch treats as current, pending acceptance included. */
  currentSessionId: string | null;
  lineageDbPath: string;
  lineageDeps?: LineageDbDeps;
}): UnacceptedSwapArtifact[] {
  if (input.currentSessionId === null) return [];
  const rows = threadSessionRows(input.lineageDbPath, input.threadId, input.lineageDeps);
  const currentIndex = rows.findIndex((row: ThreadSessionRow) => row.sessionId === input.currentSessionId);
  if (currentIndex === -1) return [];
  return rows
    .slice(currentIndex + 1)
    .filter((row) => row.prefix.kind === "verified")
    .map((row) => ({ sessionId: row.sessionId, updatedAt: row.updatedAt }));
}
