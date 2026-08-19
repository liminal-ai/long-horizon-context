/**
 * Exclusive wrapper ownership for one LHC thread.
 *
 * A thread accumulates many native Claude session ids over its life (original,
 * rebuilt-per-compact, resumed). Keying ownership by session id let two
 * launches on two aliases of the same thread take two different locks and both
 * proceed against it (R15). The lock is therefore keyed by the thread, so every
 * alias of one thread contends for the same lease.
 *
 * The lease is a filesystem create-if-absent record backed by exact OS
 * process identity (pid + bootId + starttime via cc-lhc-native), so PID reuse
 * cannot make a stale owner look live. A second wrapper refuses before
 * spawning/tailing Claude.
 *
 * Reclaim gate (fail closed): an existing lease may be removed only when the
 * probe proves staleness — live identity mismatch (PID reuse) or kernel
 * not_found. Indeterminate liveness (access denied, addon failure, …) throws
 * ThreadOwnerLivenessError and leaves the lease untouched.
 *
 * Serialization: the whole inspect→delete→publish transaction (and release's
 * verify→delete) runs under a per-thread mkdir(2) acquisition guard, so two
 * concurrent acquirers can never both act on the same stale observation —
 * without the guard, A and B could both read a stale lease, A reclaims and
 * publishes, then B deletes A's fresh lease based on its old read. mkdir is
 * atomic create-if-absent on Linux, macOS, and Windows. A guard left behind
 * by a crash *during* acquisition fails closed with an actionable error; it
 * is never auto-deleted. A crash *after* acquisition (guard already released)
 * keeps normal stale-owner reclaim working.
 */

import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ccLhcHome } from "../intake/paths.js";
import { probeProcessIdentityNative } from "./native-identity.js";
import {
  identitiesEqual,
  type ProbeProcessIdentity,
  type ProcessIdentity,
  ProcessIdentityUnavailableError,
  parseStoredProcessIdentity,
  processIdentityJson,
} from "./process-identity.js";

interface StoredOwner {
  version: 1;
  threadId: string;
  token: string;
  processIdentity: ProcessIdentity;
  acquiredAt: string;
}

export interface ThreadOwnerLease {
  threadId: string;
  path: string;
  token: string;
  release(): void;
}

export class ThreadOwnershipConflictError extends Error {
  constructor(
    readonly threadId: string,
    readonly ownerPid: number | null,
  ) {
    super(
      `LHC thread ${threadId} already has a live cc-lhc owner` + (ownerPid === null ? "" : ` (pid ${ownerPid})`),
    );
    this.name = "ThreadOwnershipConflictError";
  }
}

/**
 * Liveness of an existing owner could not be established. The lease is left
 * in place — uncertainty is never grounds for reclaim.
 */
export class ThreadOwnerLivenessError extends Error {
  constructor(
    readonly threadId: string,
    readonly ownerPid: number,
    detail: string,
  ) {
    super(
      `cannot verify liveness of existing cc-lhc owner for thread ${threadId} ` +
        `(pid ${ownerPid}); refusing to reclaim: ${detail}`,
    );
    this.name = "ThreadOwnerLivenessError";
  }
}

/**
 * The per-thread acquisition guard is held by another transaction (live
 * contention) or was left behind by an acquirer that crashed mid-acquisition.
 * cc-lhc never removes it automatically — an operator must confirm no wrapper
 * is running for the thread and delete the directory.
 */
export class ThreadOwnerGuardError extends Error {
  constructor(
    readonly threadId: string,
    readonly guardDir: string,
  ) {
    super(
      `cc-lhc thread-owner acquisition guard is held for thread ${threadId}: ${guardDir}. ` +
        "Another cc-lhc wrapper is acquiring or releasing this thread right now, or a previous " +
        "acquirer crashed mid-acquisition and left the guard behind. If you are certain no cc-lhc " +
        "wrapper is running for this thread, remove that directory and retry; cc-lhc never " +
        "removes it automatically.",
    );
    this.name = "ThreadOwnerGuardError";
  }
}

function ownersDir(home: string): string {
  return join(home, "owners");
}

function threadKey(threadId: string): string {
  return createHash("sha256").update(threadId).digest("hex");
}

export function threadOwnerPath(threadId: string, home: string = ccLhcHome()): string {
  return join(ownersDir(home), `${threadKey(threadId)}.json`);
}

/** Guard directory serializing every inspect→delete→publish for one thread. */
export function threadOwnerGuardPath(threadId: string, home: string = ccLhcHome()): string {
  return join(ownersDir(home), `.${threadKey(threadId)}.acquire`);
}

/**
 * Atomically take the guard. EEXIST means contended or orphaned — fail closed
 * either way; auto-deleting would reintroduce the delete-anothers-lease race.
 */
function takeGuard(threadId: string, guardDir: string): void {
  try {
    mkdirSync(guardDir, { mode: 0o700 });
  } catch (cause) {
    if (isExists(cause)) {
      throw new ThreadOwnerGuardError(threadId, guardDir);
    }
    throw cause;
  }
}

function dropGuard(guardDir: string): void {
  try {
    rmdirSync(guardDir);
  } catch {
    // Guard release is best-effort; a failure surfaces on the next acquire
    // as a fail-closed ThreadOwnerGuardError, never as silent corruption.
  }
}

function parseOwner(raw: string): StoredOwner | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const identity = parseStoredProcessIdentity(value.processIdentity);
    if (
      value.version !== 1 ||
      typeof value.threadId !== "string" ||
      typeof value.token !== "string" ||
      value.token === "" ||
      typeof value.acquiredAt !== "string" ||
      identity === null
    ) {
      return null;
    }
    return {
      version: 1,
      threadId: value.threadId,
      token: value.token,
      processIdentity: identity,
      acquiredAt: value.acquiredAt,
    };
  } catch {
    return null;
  }
}

function isExists(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as NodeJS.ErrnoException).code === "EEXIST";
}

export function acquireThreadOwner(
  threadId: string,
  options: {
    home?: string;
    pid?: number;
    readIdentity?: ProbeProcessIdentity;
    token?: string;
  } = {},
): ThreadOwnerLease {
  const home = options.home ?? ccLhcHome();
  const pid = options.pid ?? process.pid;
  const readIdentity = options.readIdentity ?? probeProcessIdentityNative;
  const probed = readIdentity(pid);
  if (!probed.ok) {
    throw new ProcessIdentityUnavailableError(
      "cannot establish process identity for thread ownership",
      probed.message,
    );
  }
  const identity: ProcessIdentity = probed.identity;
  const token = options.token ?? randomUUID();
  const path = threadOwnerPath(threadId, home);
  const guardDir = threadOwnerGuardPath(threadId, home);
  mkdirSync(ownersDir(home), { recursive: true, mode: 0o700 });
  const tempPath = join(ownersDir(home), `.${threadKey(threadId)}.${token}.tmp`);

  const body = `${JSON.stringify({
    version: 1,
    threadId,
    token,
    processIdentity: processIdentityJson(identity),
    acquiredAt: new Date().toISOString(),
  } satisfies StoredOwner)}\n`;

  // Serialize the entire inspect→delete→publish transaction: no observation
  // made outside the guard can ever justify a delete inside it.
  takeGuard(threadId, guardDir);
  try {
    // Publish only a complete body. link(2) is an atomic no-clobber claim on
    // the same filesystem; unlike open(O_EXCL)+write, observers can never see
    // an empty/partial live-owner record.
    writeFileSync(tempPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          linkSync(tempPath, path);
          return {
            threadId,
            path,
            token,
            release(): void {
              // Release runs under the same guard so it can never race an
              // in-flight acquisition and delete a token it did not verify.
              try {
                mkdirSync(guardDir, { mode: 0o700 });
              } catch {
                // Guard contended (or orphaned): fail open without deleting.
                // Our exit makes the lease OS-provably stale and reclaimable.
                return;
              }
              try {
                let current: StoredOwner | null = null;
                try {
                  current = parseOwner(readFileSync(path, "utf8"));
                } catch {
                  return;
                }
                if (current?.token !== token || current.threadId !== threadId) return;
                try {
                  unlinkSync(path);
                } catch {
                  // Process exit also makes a retained lease safely reclaimable.
                }
              } finally {
                dropGuard(guardDir);
              }
            },
          };
        } catch (cause) {
          if (!isExists(cause)) throw cause;
          let existing: StoredOwner | null = null;
          try {
            existing = parseOwner(readFileSync(path, "utf8"));
          } catch {
            // Missing between EEXIST and read (legacy/unguarded writer):
            // retry the atomic claim once.
            continue;
          }
          // A published record is always complete in this implementation.
          // Malformed content is therefore ambiguous/tampered, not proof of
          // staleness; never delete it and risk duplicate ownership.
          if (existing === null || existing.threadId !== threadId) {
            throw new ThreadOwnershipConflictError(threadId, null);
          }
          const live = readIdentity(existing.processIdentity.pid);
          if (live.ok && identitiesEqual(existing.processIdentity, live.identity)) {
            // Exact live identity equals stored identity: the owner is alive.
            throw new ThreadOwnershipConflictError(threadId, existing.processIdentity.pid);
          }
          if (!live.ok && live.code !== "not_found") {
            // Indeterminate (access denied, native/addon failure, …): fail closed.
            throw new ThreadOwnerLivenessError(threadId, existing.processIdentity.pid, live.message);
          }
          // OS-proven stale: live identity mismatch (PID reuse) or kernel
          // not_found. The fresh guarded observation above is the only basis
          // for this delete; remove only this exact thread-key file.
          try {
            unlinkSync(path);
          } catch {
            // Already gone; the next loop iteration re-claims atomically.
          }
        }
      }
      throw new ThreadOwnershipConflictError(threadId, null);
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup; the dotfile is not an ownership claim.
      }
    }
  } finally {
    dropGuard(guardDir);
  }
}
