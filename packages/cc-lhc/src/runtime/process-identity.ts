/**
 * OS-verifiable process identity for descriptor ownership.
 *
 * Linux (certified topology): boot_id + /proc/<pid>/stat starttime.
 * PID alone is not an incarnation — PIDs reuse after exit.
 *
 * If identity cannot be established, callers must fail closed (no PID-alive fallback).
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

export type ReadProcessIdentity = (pid: number) => ProcessIdentity | null;

/** Default Linux reader. Returns null if /proc is missing or unreadable. */
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
