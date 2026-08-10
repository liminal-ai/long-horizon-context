/**
 * Exclusive wrapper ownership for a Claude session.
 *
 * The lease is a filesystem create-if-absent record backed by Linux process
 * identity (pid + boot id + /proc starttime), so PID reuse cannot make a stale
 * owner look live. A second wrapper refuses before spawning/tailing Claude.
 */

import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ccLhcHome } from "../intake/paths.js";
import {
  identitiesEqual,
  parseStoredProcessIdentity,
  processIdentityJson,
  readProcessIdentityLinux,
  type ProcessIdentity,
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
  constructor(readonly sessionId: string, readonly ownerPid: number | null) {
    super(
      `Claude session ${sessionId} already has a live cc-lhc owner` +
        (ownerPid === null ? "" : ` (pid ${ownerPid})`),
    );
    this.name = "SessionOwnershipConflictError";
  }
}

function ownersDir(home: string): string {
  return join(home, "owners");
}

export function sessionOwnerPath(sessionId: string, home: string = ccLhcHome()): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(ownersDir(home), `${key}.json`);
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
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as NodeJS.ErrnoException).code === "EEXIST"
  );
}

export function acquireSessionOwner(
  sessionId: string,
  options: {
    home?: string;
    pid?: number;
    readIdentity?: (pid: number) => ProcessIdentity | null;
    token?: string;
  } = {},
): SessionOwnerLease {
  const home = options.home ?? ccLhcHome();
  const pid = options.pid ?? process.pid;
  const readIdentity = options.readIdentity ?? readProcessIdentityLinux;
  const identity = readIdentity(pid);
  if (identity === null) throw new Error("cannot establish process identity for session ownership");
  const token = options.token ?? randomUUID();
  const path = sessionOwnerPath(sessionId, home);
  mkdirSync(ownersDir(home), { recursive: true, mode: 0o700 });
  const tempPath = join(ownersDir(home), `.${createHash("sha256").update(sessionId).digest("hex")}.${token}.tmp`);

  const body = `${JSON.stringify({
    version: 1,
    sessionId,
    token,
    processIdentity: processIdentityJson(identity),
    acquiredAt: new Date().toISOString(),
  } satisfies StoredOwner)}\n`;

  // Publish only a complete body. link(2) is an atomic no-clobber claim on the
  // same filesystem; unlike open(O_EXCL)+write, observers can never see an
  // empty/partial live-owner record.
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
        },
      };
    } catch (cause) {
      if (!isExists(cause)) throw cause;
      let existing: StoredOwner | null = null;
      try {
        existing = parseOwner(readFileSync(path, "utf8"));
      } catch {
        // Missing between EEXIST and read: retry the atomic claim once.
        continue;
      }
      // A published record is always complete in this implementation.
      // Malformed content is therefore ambiguous/tampered, not proof of
      // staleness; never delete it and risk duplicate ownership.
      if (existing === null || existing.sessionId !== sessionId) {
        throw new SessionOwnershipConflictError(sessionId, null);
      }
      const liveIdentity = existing === null ? null : readIdentity(existing.processIdentity.pid);
      if (
        existing !== null &&
        existing.sessionId === sessionId &&
        liveIdentity !== null &&
        identitiesEqual(existing.processIdentity, liveIdentity)
      ) {
        throw new SessionOwnershipConflictError(sessionId, existing.processIdentity.pid);
      }
      // OS-proven stale. Remove only this exact session-key file; the following
      // atomic claim resolves concurrent reclaimers.
      try {
        unlinkSync(path);
      } catch {
        // Another reclaimer won; retry and observe its lease.
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
}
