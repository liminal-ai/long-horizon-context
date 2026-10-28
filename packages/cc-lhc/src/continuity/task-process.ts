/**
 * LIM-149 TC-4.5d: keep a real Claude-managed background shell alive across
 * Smart Compact and deliver its actual terminal outcome, on Linux, macOS and
 * Windows alike.
 *
 * Probed facts (real Claude Code 2.1.258, burn-in receipt 2481e843… and the
 * disposable probes of the correction passes):
 *  - A managed task runs as claude's direct child in its OWN process group,
 *    holding the task output file open. A graceful SIGTERM lets claude's
 *    shutdown reap it ("[killed]" + killed notification).
 *  - An idle claude whose background shells finish makes NO provider call; it
 *    only appends "[exited with code N]" to the task output. A finishing
 *    agent (or a due scheduled wakeup) DOES wake its model.
 *  - A paused claude (every thread stopped) can wake nothing; its separate-
 *    group shells keep running and their exit records stay uncollected —
 *    readable through the native addon — until it is resumed or terminated.
 *
 * So the wrapper's own old child is retained as the completion host of its
 * adopted shells: alive and input-fenced for an adopt-only carryover (Claude's
 * marker is the outcome), paused for a mixed one (the task's uncollected exit
 * record is the outcome). Disappearance is never an outcome, an indeterminate
 * probe never advances state, and every signal is exact-identity gated.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

import { exactProcessControl, type FindChildHoldingFileResult, type ReadChildExitResult } from "cc-lhc-native";

import { probeProcessIdentityNative } from "../runtime/native-identity.js";
import type { ProbeProcessIdentity } from "../runtime/process-identity.js";
import type { ContinuityStore, RetainedHostRecord, TaskProcessIdentity } from "./store.js";

export interface DiscoverDeps {
  findChildHoldingFile?: (parentPid: number, path: string) => FindChildHoldingFileResult;
  probeIdentity?: ProbeProcessIdentity;
}

export function discoverAdoptedTaskProcess(
  oldChildPid: number,
  output: { path: string },
  deps: DiscoverDeps = {},
): TaskProcessIdentity | null {
  const find =
    deps.findChildHoldingFile ?? ((parent, path) => exactProcessControl().findChildHoldingFile(parent, path));
  const probe = deps.probeIdentity ?? probeProcessIdentityNative;
  const found = find(oldChildPid, output.path);
  if (!found.ok || found.pid === null) return null;
  const probed = probe(found.pid);
  if (!probed.ok) return null;
  return { pid: probed.identity.pid, bootId: probed.identity.bootId, starttime: probed.identity.starttime };
}

export type TaskOutputMarker = { kind: "exited"; code: number } | { kind: "killed" };

const MARKER_TAIL_BYTES = 64;

export function parseTaskOutputMarker(path: string): TaskOutputMarker | null {
  let tail: string;
  try {
    const size = statSync(path).size;
    const span = Math.min(size, MARKER_TAIL_BYTES);
    if (span === 0) return null;
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(span);
      readSync(fd, buf, 0, span, size - span);
      tail = buf.toString("utf8").trimEnd();
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  if (tail.endsWith("[killed]")) return { kind: "killed" };
  const match = /\[exited with code (\d+)\]$/.exec(tail);
  if (match !== null) {
    const code = Number(match[1]);
    if (Number.isSafeInteger(code)) return { kind: "exited", code };
  }
  return null;
}

export type TaskExitOutcome =
  | { kind: "exited"; code: number }
  | { kind: "signaled"; signal: number }
  | { kind: "running" };

export function readTaskExit(
  proc: { pid: number; starttime: string },
  read: (pid: number, starttime: string) => ReadChildExitResult = (pid, starttime) =>
    exactProcessControl().readChildExit(pid, starttime),
): TaskExitOutcome | null {
  const result = read(proc.pid, proc.starttime);
  if (!result.ok) return null;
  if (result.state === "running") return { kind: "running" };
  if (result.state === "signaled") return { kind: "signaled", signal: result.signal };
  return { kind: "exited", code: result.code };
}

export interface ReconcileDeps {
  probeIdentity?: ProbeProcessIdentity;
  readMarker?: (path: string) => TaskOutputMarker | null;
  readTaskExit?: (proc: { pid: number; starttime: string }) => TaskExitOutcome | null;
}

export interface ReconciledItem {
  launchId: string;
  outcome: "completed" | "failed" | "killed";
  evidence: string;
}

export interface ReconcileReport {
  reconciled: ReconciledItem[];
  unsupervised: string[];
}

function probeGone(probe: ProbeProcessIdentity, proc: { pid: number; bootId: string; starttime: string }): boolean {
  const probed = probe(proc.pid);
  if (probed.ok) return probed.identity.bootId !== proc.bootId || probed.identity.starttime !== proc.starttime;
  return probed.code === "not_found";
}

export function reconcileAdoptedShells(
  store: ContinuityStore,
  threadId: string,
  deps: ReconcileDeps = {},
): ReconcileReport {
  const probe = deps.probeIdentity ?? probeProcessIdentityNative;
  const readMarker = deps.readMarker ?? parseTaskOutputMarker;
  const report: ReconcileReport = { reconciled: [], unsupervised: [] };
  const nowMs = Date.now();
  const host = store.retainedHostGeneration(threadId)?.retainedHost ?? null;
  const readExit = deps.readTaskExit ?? ((proc) => readTaskExit(proc));
  for (const item of store.listItems(threadId)) {
    if (item.state === "terminal" || item.family !== "background_shell" || item.carryMode !== "adopt") continue;
    if (host?.frozen === true) {
      const task = item.continuation?.taskProcess;
      if (task === undefined) {
        continue;
      }
      const outcome = readExit({ pid: task.pid, starttime: task.starttime });
      if (outcome === null) {
        if (item.state === "active") {
          store.setVerified({ threadId, launchId: item.launchId, verified: false, nowMs });
          report.unsupervised.push(item.launchId);
        }
        continue;
      }
      if (outcome.kind === "running") continue;
      const zOutcome: ReconciledItem["outcome"] =
        outcome.kind === "exited" && outcome.code === 0 ? "completed" : "failed";
      const evidence =
        outcome.kind === "signaled"
          ? `task killed by signal ${outcome.signal} (paused-host exit record)`
          : `task exited with code ${outcome.code} (paused-host exit record)`;
      const result = store.recordTerminal({ threadId, launchId: item.launchId, outcome: zOutcome, evidence, nowMs });
      if (result?.applied === true) report.reconciled.push({ launchId: item.launchId, outcome: zOutcome, evidence });
      continue;
    }
    const outputFile = item.continuation?.outputFile;
    const marker = outputFile === undefined ? null : readMarker(outputFile);
    if (marker !== null) {
      const outcome: ReconciledItem["outcome"] =
        marker.kind === "killed" ? "killed" : marker.code === 0 ? "completed" : "failed";
      const evidence =
        marker.kind === "killed"
          ? "claude kill marker in task output (task did not survive its session)"
          : `claude exit marker in task output: exited with code ${marker.code}`;
      const result = store.recordTerminal({ threadId, launchId: item.launchId, outcome, evidence, nowMs });
      if (result?.applied === true) report.reconciled.push({ launchId: item.launchId, outcome, evidence });
      continue;
    }
    if (item.state !== "active") continue;
    const task = item.continuation?.taskProcess;
    const hostGone = host !== null && probeGone(probe, host);
    const taskGone = task !== undefined && probeGone(probe, task);
    const lost = host !== null && hostGone && (task === undefined || taskGone);
    if (lost) {
      store.setVerified({ threadId, launchId: item.launchId, verified: false, nowMs });
      report.unsupervised.push(item.launchId);
    }
  }
  return report;
}

export type HostSettle =
  | { kind: "none" }
  | { kind: "kept"; reason: "items_open" | "indeterminate" }
  | { kind: "already_gone" }
  | { kind: "terminated" }
  | { kind: "terminate_failed"; detail: string };

export interface SettleHostDeps {
  probeIdentity?: ProbeProcessIdentity;
  terminateHost: (host: RetainedHostRecord) => Promise<boolean>;
}

export async function settleRetainedHost(
  store: ContinuityStore,
  threadId: string,
  deps: SettleHostDeps,
): Promise<HostSettle> {
  const generation = store.retainedHostGeneration(threadId);
  const host = generation?.retainedHost ?? null;
  if (generation === null || host === null) return { kind: "none" };
  const probe = deps.probeIdentity ?? probeProcessIdentityNative;
  const probed = probe(host.pid);
  const nowMs = Date.now();
  if (!probed.ok) {
    if (probed.code !== "not_found") return { kind: "kept", reason: "indeterminate" };
    store.clearRetainedHost({ threadId, generation: generation.generation, nowMs });
    return { kind: "already_gone" };
  }
  if (probed.identity.bootId !== host.bootId || probed.identity.starttime !== host.starttime) {
    store.clearRetainedHost({ threadId, generation: generation.generation, nowMs });
    return { kind: "already_gone" };
  }
  const stillOpen = store
    .listItems(threadId)
    .some((item) => item.state !== "terminal" && item.family === "background_shell" && item.carryMode === "adopt");
  if (stillOpen) return { kind: "kept", reason: "items_open" };
  const ok = await deps.terminateHost(host);
  if (!ok) return { kind: "terminate_failed", detail: `retained host pid ${host.pid} did not exit when asked` };
  store.clearRetainedHost({ threadId, generation: generation.generation, nowMs });
  return { kind: "terminated" };
}

const SETTLE_SIGTERM_WAIT_MS = 3_000;
const SETTLE_SIGKILL_WAIT_MS = 1_000;

export async function terminateRetainedHostReal(
  host: RetainedHostRecord,
  probe: ProbeProcessIdentity = probeProcessIdentityNative,
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => process.kill(pid, signal),
): Promise<boolean> {
  const sameNow = (): boolean => {
    const probed = probe(host.pid);
    return probed.ok && probed.identity.bootId === host.bootId && probed.identity.starttime === host.starttime;
  };
  const waitGone = async (capMs: number): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < capMs) {
      if (!sameNow()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !sameNow();
  };
  if (!sameNow()) return true;
  if (host.frozen !== true) {
    try {
      kill(host.pid, "SIGTERM");
    } catch {
      return !sameNow();
    }
    if (await waitGone(SETTLE_SIGTERM_WAIT_MS)) return true;
    if (!sameNow()) return true;
  }
  try {
    kill(host.pid, "SIGKILL");
  } catch {
    return !sameNow();
  }
  return waitGone(SETTLE_SIGKILL_WAIT_MS);
}
