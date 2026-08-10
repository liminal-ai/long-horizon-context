/**
 * Exclusive wrapper ownership for a Claude session.
 *
 * The lease is a filesystem create-if-absent record backed by exact OS
 * process identity (pid + bootId + starttime via cc-lhc-native), so PID reuse
 * cannot make a stale owner look live. A second wrapper refuses before
 * spawning/tailing Claude.
 *
 * Reclaim gate (fail closed): an existing lease may be removed only when the
 * probe proves staleness — live identity mismatch (PID reuse) or kernel
 * not_found. Indeterminate liveness (access denied, addon failure, …) throws
 * SessionOwnerLivenessError and leaves the lease untouched.
 *
 * Serialization: the whole inspect→delete→publish transaction (and release's
 * verify→delete) runs under a per-session mkdir(2) acquisition guard, so two
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
  sessionId: string;
  token: string;
  processIdentity: ProcessIdentity;
  acquiredAt: string;
}

export interface SessionOwnerLease {
  sessionId: string;
  path: string;
  token: string;
  release(): void;
}

export class SessionOwnershipConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly ownerPid: number | null,
  ) {
    super(
      `Claude session ${sessionId} already has a live cc-lhc owner` + (ownerPid === null ? "" : ` (pid ${ownerPid})`),
    );
    this.name = "SessionOwnershipConflictError";
  }
}

/**
 * Liveness of an existing owner could not be established. The lease is left
 * in place — uncertainty is never grounds for reclaim.
 */
export class SessionOwnerLivenessError extends Error {
  constructor(
    readonly sessionId: string,
    readonly ownerPid: number,
    detail: string,
  ) {
    super(
      `cannot verify liveness of existing cc-lhc owner for session ${sessionId} ` +
        `(pid ${ownerPid}); refusing to reclaim: ${detail}`,
    );
    this.name = "SessionOwnerLivenessError";
  }
}

/**
 * The per-session acquisition guard is held by another transaction (live
 * contention) or was left behind by an acquirer that crashed mid-acquisition.
 * cc-lhc never removes it automatically — an operator must confirm no wrapper
 * is running for the session and delete the directory.
 */
export class SessionOwnerGuardError extends Error {
  constructor(
    readonly sessionId: string,
    readonly guardDir: string,
  ) {
    super(
      `cc-lhc session-owner acquisition guard is held for session ${sessionId}: ${guardDir}. ` +
        "Another cc-lhc wrapper is acquiring or releasing this session right now, or a previous " +
        "acquirer crashed mid-acquisition and left the guard behind. If you are certain no cc-lhc " +
        "wrapper is running for this session, remove that directory and retry; cc-lhc never " +
        "removes it automatically.",
    );
    this.name = "SessionOwnerGuardError";
  }
}

function ownersDir(home: string): string {
  return join(home, "owners");
}

function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

export function sessionOwnerPath(sessionId: string, home: string = ccLhcHome()): string {
  return join(ownersDir(home), `${sessionKey(sessionId)}.json`);
}

/** Guard directory serializing every inspect→delete→publish for one session. */
export function sessionOwnerGuardPath(sessionId: string, home: string = ccLhcHome()): string {
  return join(ownersDir(home), `.${sessionKey(sessionId)}.acquire`);
}

/**
 * Atomically take the guard. EEXIST means contended or orphaned — fail closed
 * either way; auto-deleting would reintroduce the delete-anothers-lease race.
 */
function takeGuard(sessionId: string, guardDir: string): void {
  try {
    mkdirSync(guardDir, { mode: 0o700 });
  } catch (cause) {
    if (isExists(cause)) {
      throw new SessionOwnerGuardError(sessionId, guardDir);
    }
    throw cause;
  }
}

function dropGuard(guardDir: string): void {
  try {
    rmdirSync(guardDir);
  } catch {
    // Guard release is best-effort; a failure surfaces on the next acquire
    // as a fail-closed SessionOwnerGuardError, never as silent corruption.
  }
}

function parseOwner(raw: string): StoredOwner | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const identity = parseStoredProcessIdentity(value.processIdentity);
    if (
      value.version !== 1 ||
      typeof value.sessionId !== "string" ||
      typeof value.token !== "string" ||
      value.token === "" ||
      typeof value.acquiredAt !== "string" ||
      identity === null
    ) {
      return null;
    }
    return {
      version: 1,
      sessionId: value.sessionId,
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

export function acquireSessionOwner(
  sessionId: string,
  options: {
    home?: string;
    pid?: number;
    readIdentity?: ProbeProcessIdentity;
    token?: string;
  } = {},
): SessionOwnerLease {
  const home = options.home ?? ccLhcHome();
  const pid = options.pid ?? process.pid;
  const readIdentity = options.readIdentity ?? probeProcessIdentityNative;
  const probed = readIdentity(pid);
  if (!probed.ok) {
    throw new ProcessIdentityUnavailableError(
      "cannot establish process identity for session ownership",
      probed.message,
    );
  }
  const identity: ProcessIdentity = probed.identity;
  const token = options.token ?? randomUUID();
  const path = sessionOwnerPath(sessionId, home);
  const guardDir = sessionOwnerGuardPath(sessionId, home);
  mkdirSync(ownersDir(home), { recursive: true, mode: 0o700 });
  const tempPath = join(ownersDir(home), `.${sessionKey(sessionId)}.${token}.tmp`);

  const body = `${JSON.stringify({
    version: 1,
    sessionId,
    token,
    processIdentity: processIdentityJson(identity),
    acquiredAt: new Date().toISOString(),
  } satisfies StoredOwner)}\n`;

  // Serialize the entire inspect→delete→publish transaction: no observation
  // made outside the guard can ever justify a delete inside it.
  takeGuard(sessionId, guardDir);
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
            sessionId,
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
                if (current?.token !== token || current.sessionId !== sessionId) return;
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
          if (existing === null || existing.sessionId !== sessionId) {
            throw new SessionOwnershipConflictError(sessionId, null);
          }
          const live = readIdentity(existing.processIdentity.pid);
          if (live.ok && identitiesEqual(existing.processIdentity, live.identity)) {
            // Exact live identity equals stored identity: the owner is alive.
            throw new SessionOwnershipConflictError(sessionId, existing.processIdentity.pid);
          }
          if (!live.ok && live.code !== "not_found") {
            // Indeterminate (access denied, native/addon failure, …): fail closed.
            throw new SessionOwnerLivenessError(sessionId, existing.processIdentity.pid, live.message);
          }
          // OS-proven stale: live identity mismatch (PID reuse) or kernel
          // not_found. The fresh guarded observation above is the only basis
          // for this delete; remove only this exact session-key file.
          try {
            unlinkSync(path);
          } catch {
            // Already gone; the next loop iteration re-claims atomically.
          }
        }
      }
      throw new SessionOwnershipConflictError(sessionId, null);
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
