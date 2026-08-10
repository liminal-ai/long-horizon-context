/**
 * OS-verifiable process identity for descriptor ownership.
 *
 * The stored schema is pid + bootId + starttime on every platform; PID alone
 * is not an incarnation — PIDs reuse after exit. The production identity
 * source is the cc-lhc-native exact reader (see native-identity.ts); the
 * /proc reader in this file is a Linux reference implementation kept for
 * tests and parity checks only.
 *
 * Liveness is a three-way result, never a nullable:
 *   ok            → exact live identity (compare with identitiesEqual)
 *   not_found     → the kernel proved no such process exists (stale/dead;
 *                   callers may reclaim through their transactional fencing)
 *   indeterminate → access denied, native/addon failure, unsupported
 *                   platform, malformed result, or any other uncertainty.
 *                   Callers MUST fail closed: refuse, and never delete,
 *                   rotate, overwrite, or reclaim on this result.
 */

import { readFileSync } from "node:fs";

export interface ProcessIdentity {
  pid: number;
  /** /proc/sys/kernel/random/boot_id */
  bootId: string;
  /** Field 22 of /proc/<pid>/stat (starttime, clock ticks since boot) as decimal string. */
  starttime: string;
}

/**
 * Parse starttime from a full `/proc/<pid>/stat` line.
 * Comm is `(...)` and may contain spaces or `)`; the last `)` ends comm.
 * After that, field index 19 (0-based among post-comm fields) is starttime
 * (man 5 proc: field 22 overall).
 */
export function parseProcStatStarttime(statContent: string): string | null {
  const line = statContent.trimEnd();
  const open = line.indexOf("(");
  const close = line.lastIndexOf(")");
  if (open < 0 || close <= open) return null;
  const rest = line.slice(close + 1).trim();
  if (rest === "") return null;
  const fields = rest.split(/\s+/);
  // post-comm: state ppid pgrp session tty_nr tpgid flags minflt cminflt
  // majflt cmajflt utime stime cutime cstime priority nice num_threads
  // itrealvalue starttime ...
  // indices 0..18 before starttime, so starttime is fields[19]
  if (fields.length < 20) return null;
  const starttime = fields[19]!;
  if (!/^\d+$/.test(starttime)) return null;
  return starttime;
}

/**
 * Nullable reader shape retained for the Linux /proc reference reader below.
 * Production code paths take a ProbeProcessIdentity instead.
 */
export type ReadProcessIdentity = (pid: number) => ProcessIdentity | null;

/**
 * Three-way liveness result. `not_found` is kernel-proven absence and is the
 * only failure that may justify reclaiming a lease; `indeterminate` covers
 * every other failure and must fail closed.
 */
export type ProcessLivenessResult =
  | { ok: true; identity: ProcessIdentity }
  | { ok: false; code: "not_found"; message: string }
  | { ok: false; code: "indeterminate"; message: string };

export type ProbeProcessIdentity = (pid: number) => ProcessLivenessResult;

/**
 * Thrown when a caller needs its own live identity (descriptor creation,
 * lease acquisition) and the probe cannot supply one. Wrapper startup treats
 * this as fatal and surfaces the actionable message instead of degrading to
 * PID-only liveness or a platform-specific fallback reader.
 */
export class ProcessIdentityUnavailableError extends Error {
  constructor(context: string, detail: string) {
    super(`${context}: ${detail}`);
    this.name = "ProcessIdentityUnavailableError";
  }
}

/**
 * Linux /proc reference reader — test/parity seam only, NOT the production
 * default (that is the cc-lhc-native exact reader). Returns null if /proc is
 * missing or unreadable; the nullable shape cannot distinguish dead from
 * unreadable, which is exactly why production uses ProbeProcessIdentity.
 */
export function readProcessIdentityLinux(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^[0-9a-f-]{8,}$/i.test(bootId)) return null;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const starttime = parseProcStatStarttime(stat);
    if (starttime === null) return null;
    // Confirm pid field matches
    const pidField = stat.trimStart().split(/\s+/, 1)[0];
    if (pidField !== String(pid)) return null;
    return { pid, bootId, starttime };
  } catch {
    return null;
  }
}

export function identitiesEqual(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.bootId === b.bootId && a.starttime === b.starttime;
}

/** Serialize for descriptor JSON (stable key order). */
export function processIdentityJson(id: ProcessIdentity): {
  pid: number;
  bootId: string;
  starttime: string;
} {
  return { pid: id.pid, bootId: id.bootId, starttime: id.starttime };
}

export function parseStoredProcessIdentity(raw: unknown): ProcessIdentity | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.pid !== "number" || !Number.isInteger(o.pid) || o.pid <= 0) return null;
  if (typeof o.bootId !== "string" || o.bootId === "") return null;
  if (typeof o.starttime !== "string" || !/^\d+$/.test(o.starttime)) return null;
  return { pid: o.pid, bootId: o.bootId, starttime: o.starttime };
}
