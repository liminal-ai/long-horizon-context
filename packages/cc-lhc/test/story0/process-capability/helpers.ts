/**
 * Test-only helpers for the Story 0 production-path proof: identity-safe
 * signaling, a one-shot terminal observer, and POSIX output-identity checks.
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  identitiesEqual,
  type ProbeProcessIdentity,
  type ProcessIdentity,
  type ProcessLivenessResult,
  processIdentityJson,
} from "../../../src/runtime/process-identity.js";

export type ProofStatus = "proved" | "candidate_failed" | "unproved";

export interface Proof {
  id: string;
  status: ProofStatus;
  detail: string;
}

export interface Affiliation {
  pid: number;
  ppid: number | null;
  pgrp: number | null;
  session: number | null;
}

export function proof(id: string, status: ProofStatus, detail: string): Proof {
  return { id, status, detail };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(condition: () => boolean, label: string, capMs = 12_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

export function readAffiliation(pid: number): Affiliation {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = raw.lastIndexOf(")");
      const rest = raw
        .slice(close + 1)
        .trim()
        .split(/\s+/);
      const ppid = Number(rest[1]);
      const pgrp = Number(rest[2]);
      const session = Number(rest[3]);
      if ([ppid, pgrp, session].every((n) => Number.isSafeInteger(n))) {
        return { pid, ppid, pgrp, session };
      }
    } catch {
      // Fall through.
    }
  }
  if (process.platform === "darwin") {
    const r = spawnSync("/bin/ps", ["-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "sess=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const parts = r.stdout
      .trim()
      .split(/\s+/)
      .map((p) => Number(p));
    if (r.status === 0 && parts.length >= 4 && parts.every((n) => Number.isSafeInteger(n))) {
      return { pid, ppid: parts[1] ?? null, pgrp: parts[2] ?? null, session: parts[3] ?? null };
    }
  }
  return { pid, ppid: null, pgrp: null, session: null };
}

function posixLocator(path: string): { dev: string; ino: string } | null {
  try {
    const st = statSync(path, { bigint: true });
    return { dev: st.dev.toString(), ino: st.ino.toString() };
  } catch {
    return null;
  }
}

export function provePosixOutputIdentity(dir: string): {
  kind: "posix_dev_ino" | "unproven";
  stableAcrossAppend: boolean | null;
  reuseDiscriminated: boolean | null;
} {
  const path = join(dir, "locator-probe");
  const held = join(dir, "locator-probe.held");
  writeFileSync(path, "a\n");
  const first = posixLocator(path);
  appendFileSync(path, "b\n");
  const appended = posixLocator(path);
  rmSync(held, { force: true });
  renameSync(path, held);
  writeFileSync(path, "replacement\n");
  const replaced = posixLocator(path);
  const heldLoc = posixLocator(held);
  const stable =
    first !== null &&
    appended !== null &&
    first.dev === appended.dev &&
    first.ino === appended.ino &&
    first.ino !== "0";
  const discriminated =
    first !== null &&
    replaced !== null &&
    heldLoc !== null &&
    first.dev === heldLoc.dev &&
    first.ino === heldLoc.ino &&
    (first.dev !== replaced.dev || first.ino !== replaced.ino);
  return { kind: "posix_dev_ino", stableAcrossAppend: stable, reuseDiscriminated: discriminated };
}

function signalProcess(pid: number, kind: "term" | "kill"): "sigterm" | "terminate_process" | "sigkill" {
  if (process.platform === "win32") {
    process.kill(pid);
    return "terminate_process";
  }
  process.kill(pid, kind === "term" ? "SIGTERM" : "SIGKILL");
  return kind === "term" ? "sigterm" : "sigkill";
}

export async function identitySafeSignal(
  stored: ProcessIdentity,
  probe: ProbeProcessIdentity,
  kind: "term" | "kill",
): Promise<{ action: "skipped" | "signaled" | "refused"; reason: string }> {
  const live = probe(stored.pid);
  if (!live.ok && live.code === "not_found") return { action: "skipped", reason: "not_found" };
  if (!live.ok) return { action: "refused", reason: "indeterminate" };
  if (!identitiesEqual(live.identity, stored)) return { action: "refused", reason: "identity_mismatch" };
  signalProcess(stored.pid, kind);
  if (kind === "kill") {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const again = probe(stored.pid);
      if (!again.ok && again.code === "not_found") break;
      await sleep(20);
    }
  }
  return { action: "signaled", reason: kind };
}

export function guardedStop(
  pid: number,
  expected: ProcessIdentity,
  probe: ProbeProcessIdentity,
): {
  disposition: "refused" | "signaled";
  signaled: boolean;
  reason: "identity_mismatch" | "identity_matched" | "not_found" | "indeterminate";
  method: "sigterm" | "terminate_process" | null;
  expected: ReturnType<typeof processIdentityJson>;
  liveAfter: ProcessLivenessResult;
} {
  const live = probe(pid);
  const expectedJson = processIdentityJson(expected);
  if (!live.ok) {
    return {
      disposition: "refused",
      signaled: false,
      reason: live.code,
      method: null,
      expected: expectedJson,
      liveAfter: probe(pid),
    };
  }
  if (!identitiesEqual(live.identity, expected)) {
    return {
      disposition: "refused",
      signaled: false,
      reason: "identity_mismatch",
      method: null,
      expected: expectedJson,
      liveAfter: probe(pid),
    };
  }
  const method = signalProcess(pid, "term");
  return {
    disposition: "signaled",
    signaled: true,
    reason: "identity_matched",
    method: method === "terminate_process" ? "terminate_process" : "sigterm",
    expected: expectedJson,
    liveAfter: probe(pid),
  };
}

export function createTerminalObserver(): {
  observe: (eventId: string, previous: ProcessLivenessResult, current: ProcessLivenessResult) => void;
  emissionCount: (eventId: string) => number;
} {
  const emissions = new Map<string, number>();
  return {
    observe(eventId, previous, current) {
      if (previous.ok && !current.ok && current.code === "not_found") {
        emissions.set(eventId, (emissions.get(eventId) ?? 0) + 1);
      }
    },
    emissionCount(eventId) {
      return emissions.get(eventId) ?? 0;
    },
  };
}

export function terminalEventId(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.bootId}:${identity.starttime}:exit:1`;
}

export function writeReceipt(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}

export function receiptPath(): string {
  return process.env.CC_LHC_STORY0_RECEIPT ?? join(process.cwd(), "..", "..", "build/story0/process-capability.json");
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export { identitiesEqual, processIdentityJson };
