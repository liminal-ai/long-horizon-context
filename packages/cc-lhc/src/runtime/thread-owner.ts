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
    super(`LHC thread ${threadId} already has a live cc-lhc owner` + (ownerPid === null ? "" : ` (pid ${ownerPid})`));
    this.name = "ThreadOwnershipConflictError";
  }
}

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

export function threadOwnerGuardPath(threadId: string, home: string = ccLhcHome()): string {
  return join(ownersDir(home), `.${threadKey(threadId)}.acquire`);
}

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
  } catch {}
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

export interface ReclaimedThreadOwnerLease {
  threadId: string;
  deadPid: number;
  leasePath: string;
  reason: "not_found" | "identity_mismatch";
}

export type ThreadOwnerLiveness = "none" | "live" | "dead" | "indeterminate";

export function probeThreadOwner(
  threadId: string,
  options: { home?: string; readIdentity?: ProbeProcessIdentity } = {},
): ThreadOwnerLiveness {
  const path = threadOwnerPath(threadId, options.home ?? ccLhcHome());
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "indeterminate";
  }
  const owner = parseOwner(raw);
  if (owner === null || owner.threadId !== threadId) return "indeterminate";
  const live = (options.readIdentity ?? probeProcessIdentityNative)(owner.processIdentity.pid);
  if (live.ok) return identitiesEqual(owner.processIdentity, live.identity) ? "live" : "dead";
  return live.code === "not_found" ? "dead" : "indeterminate";
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
    onReclaim?: (reclaimed: ReclaimedThreadOwnerLease) => void;
  } = {},
): ThreadOwnerLease {
  const home = options.home ?? ccLhcHome();
  const pid = options.pid ?? process.pid;
  const readIdentity = options.readIdentity ?? probeProcessIdentityNative;
  const probed = readIdentity(pid);
  if (!probed.ok) {
    throw new ProcessIdentityUnavailableError("cannot establish process identity for thread ownership", probed.message);
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

  takeGuard(threadId, guardDir);
  try {
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
              try {
                mkdirSync(guardDir, { mode: 0o700 });
              } catch {
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
                } catch {}
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
            continue;
          }
          if (existing === null || existing.threadId !== threadId) {
            throw new ThreadOwnershipConflictError(threadId, null);
          }
          const live = readIdentity(existing.processIdentity.pid);
          if (live.ok && identitiesEqual(existing.processIdentity, live.identity)) {
            throw new ThreadOwnershipConflictError(threadId, existing.processIdentity.pid);
          }
          if (!live.ok && live.code !== "not_found") {
            throw new ThreadOwnerLivenessError(threadId, existing.processIdentity.pid, live.message);
          }
          try {
            unlinkSync(path);
          } catch {}
          options.onReclaim?.({
            threadId,
            deadPid: existing.processIdentity.pid,
            leasePath: path,
            reason: live.ok ? "identity_mismatch" : "not_found",
          });
        }
      }
      throw new ThreadOwnershipConflictError(threadId, null);
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {}
    }
  } finally {
    dropGuard(guardDir);
  }
}
