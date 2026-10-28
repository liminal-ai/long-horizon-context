import { threads } from "lhc";

import {
  clearPendingCurrentSession,
  type LineageDbDeps,
  lookupSessionLineage,
  markSessionAccepted,
  readPendingCurrentSession,
  recordPendingCurrentSession,
  supersedePendingCurrentSession,
  type ThreadSessionRow,
  threadSessionRows,
} from "./lineage-db.js";

export const CLAUDE_ALIAS_HOST = "claude-code";

export function claudeSessionAlias(sessionId: string): string {
  return `${CLAUDE_ALIAS_HOST}:${sessionId}`;
}

export function claudeSessionIdFromAlias(alias: string): string | null {
  const prefix = `${CLAUDE_ALIAS_HOST}:`;
  if (!alias.startsWith(prefix)) return null;
  const sessionId = alias.slice(prefix.length);
  return sessionId === "" ? null : sessionId;
}

export class ThreadRegistryUnavailableError extends Error {
  constructor(reason: string) {
    super(`cc-lhc cannot read the LHC thread registry: ${reason}`);
    this.name = "ThreadRegistryUnavailableError";
  }
}

function unavailable(reason: string): never {
  throw new ThreadRegistryUnavailableError(reason);
}

export interface LaunchThreadBinding {
  threadId: string;
  createdAtLaunch: boolean;
}

export interface LaunchThreadLookup {
  sessionId: string;
  registryPath: string;
  lineageDbPath: string;
  lineageDeps?: LineageDbDeps;
  log?: (message: string) => void;
}

export async function resolveLaunchThread(lookup: LaunchThreadLookup): Promise<string | null> {
  const registryPath = lookup.registryPath;
  const alias = claudeSessionAlias(lookup.sessionId);
  const resolved = await threads.resolveAlias({ alias, registryPath });
  if (resolved.ok) return resolved.value.threadId;
  if (resolved.error.code !== "alias_not_found") unavailable(resolved.error.reason);

  const log = lookup.log ?? (() => {});
  const entry = lookupSessionLineage(lookup.lineageDbPath, lookup.sessionId, lookup.lineageDeps);
  if (entry === undefined) return null;
  if (!entry.accepted) {
    log(`cc-lhc: ${lookup.sessionId} is a rebuilt session of thread ${entry.threadId} that was never accepted`);
    const current = await threads.currentAlias({ threadId: entry.threadId, registryPath });
    if (!current.ok) unavailable(current.error.reason);
    if (current.value.currentAlias !== null) return entry.threadId;
    return (await importLegacyLineage(lookup, entry.threadId)) ?? entry.threadId;
  }

  const imported = await importLegacyLineage(lookup, entry.threadId);
  if (imported === null) return null;

  const reread = await threads.resolveAlias({ alias, registryPath });
  if (reread.ok) return reread.value.threadId;
  if (reread.error.code !== "alias_not_found") unavailable(reread.error.reason);
  return null;
}

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

async function importLegacyLineage(lookup: LaunchThreadLookup, legacyThreadId: string): Promise<string | null> {
  const log = lookup.log ?? (() => {});
  const rows = threadSessionRows(lookup.lineageDbPath, legacyThreadId, lookup.lineageDeps).filter(
    (row) => row.accepted,
  );
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
      row === current ? await threads.registerCurrentAlias(registration) : await threads.registerAlias(registration);
    if (bound.ok) continue;
    if (bound.error.code === "alias_bound_to_other_thread") {
      log(`cc-lhc: legacy import skipped ${registration.alias} — ${bound.error.reason}`);
      continue;
    }
    unavailable(bound.error.reason);
  }
  return legacyThreadId;
}

export async function currentSessionAlias(threadId: string, registryPath: string): Promise<string | null> {
  const current = await threads.currentAlias({ threadId, registryPath });
  if (!current.ok) unavailable(current.error.reason);
  return current.value.currentAlias;
}

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

export interface SwapAcceptance {
  registryAdvanced: boolean;
  recovery: "applied" | "recorded" | "unrecorded";
  reason?: string;
}

export async function recordSwapAcceptance(input: {
  sessionId: string;
  threadId: string;
  registryPath: string;
  lineageDbPath: string;
  lineageDeps?: LineageDbDeps;
  log?: (message: string) => void;
}): Promise<SwapAcceptance> {
  const log = input.log ?? (() => {});
  try {
    markSessionAccepted(input.lineageDbPath, input.sessionId, input.lineageDeps);
  } catch (cause) {
    log(`cc-lhc: accepted session ${input.sessionId} not promoted in host lineage: ${detail(cause)}`);
  }
  const advanced = await acceptCurrentSession(input);
  if (advanced.ok) {
    try {
      supersedePendingCurrentSession(input.lineageDbPath, input.threadId, input.lineageDeps);
    } catch (cause) {
      log(`cc-lhc: superseded pending acceptance not cleared for thread ${input.threadId}: ${detail(cause)}`);
    }
    return { registryAdvanced: true, recovery: "applied" };
  }

  let observedPrevious: string | null = null;
  try {
    const current = await currentSessionAlias(input.threadId, input.registryPath);
    observedPrevious = current === null ? null : claudeSessionIdFromAlias(current);
  } catch (cause) {
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

export interface PendingAcceptanceReconciliation {
  acceptedSessionId: string | null;
  registryAdvanced: boolean;
  note?: string;
}

export async function reconcilePendingAcceptance(input: {
  threadId: string;
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
    const note = `pending acceptance record unreadable for thread ${input.threadId}: ${detail(cause)}`;
    log(`cc-lhc: ${note}`);
    return { acceptedSessionId: null, registryAdvanced: false, note };
  }
  if (pending === undefined) return { acceptedSessionId: null, registryAdvanced: false };

  if (pending.sessionId === input.registryCurrentSessionId) {
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

export function unacceptedSwapArtifacts(input: {
  threadId: string;
  currentSessionId: string | null;
  lineageDbPath: string;
  lineageDeps?: LineageDbDeps;
}): UnacceptedSwapArtifact[] {
  if (input.currentSessionId === null) return [];
  let rows: ThreadSessionRow[];
  try {
    rows = threadSessionRows(input.lineageDbPath, input.threadId, input.lineageDeps);
  } catch {
    return [];
  }
  const currentIndex = rows.findIndex((row: ThreadSessionRow) => row.sessionId === input.currentSessionId);
  return rows
    .filter(
      (row, index) =>
        row.sessionId !== input.currentSessionId &&
        (!row.accepted || (currentIndex !== -1 && index > currentIndex && row.prefix.kind === "verified")),
    )
    .map((row) => ({ sessionId: row.sessionId, updatedAt: row.updatedAt }));
}
