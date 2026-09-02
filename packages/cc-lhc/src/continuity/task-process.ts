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
  /** Holder lookup seam (tests); production asks the native addon. */
  findChildHoldingFile?: (parentPid: number, path: string) => FindChildHoldingFileResult;
  probeIdentity?: ProbeProcessIdentity;
}

/**
 * Pin the live task process of an adopted background shell: the single direct
 * child of the (still-live) old claude child holding the verified output file
 * open, with exact identity (pid + bootId + starttime) read through the
 * native addon. Uniform on Linux, macOS and Windows. A mixed carryover needs
 * this pin to read the task's exit record once its supervisor is paused; an
 * adopt-only carryover uses it only for `tasks status` process reporting and
 * the lost-supervision backstop. It can never produce a terminal outcome.
 */
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

/** Claude's own terminal record in a task output file, written while it supervises. */
export type TaskOutputMarker = { kind: "exited"; code: number } | { kind: "killed" };

const MARKER_TAIL_BYTES = 64;

/**
 * Parse the trailing marker Claude appends to a managed task's output file:
 * `[exited with code N]` on natural exit (N preserved), `[killed]` when its
 * shutdown reaped the task. An orphaned task's exit appends nothing — absence
 * of a marker is absence of evidence, never an outcome.
 */
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

/** A task process's own exit record, read while its supervisor is paused (LIM-149). */
export type TaskExitOutcome =
  | { kind: "exited"; code: number }
  | { kind: "signaled"; signal: number }
  | { kind: "running" };

/**
 * Read the real exit outcome of a paused host's task child from its
 * uncollected exit record (native addon: Linux /proc, macOS sysctl, Windows
 * process object). The recorded exact identity (pid + starttime) must still
 * name the same process — a reused pid, an identity mismatch, or an unreadable
 * record returns null (fail closed); a still-running child returns `running`.
 */
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
  /** Exit-record reader for a paused host's task child (tests; production asks the native addon). */
  readTaskExit?: (proc: { pid: number; starttime: string }) => TaskExitOutcome | null;
}

export interface ReconciledItem {
  launchId: string;
  outcome: "completed" | "failed" | "killed";
  evidence: string;
}

export interface ReconcileReport {
  /** Items given a truthful terminal outcome from Claude's own marker. */
  reconciled: ReconciledItem[];
  /** Items whose supervision is provably lost (host and task both gone, no marker): flipped to `unknown`, never terminal. */
  unsupervised: string[];
}

function probeGone(probe: ProbeProcessIdentity, proc: { pid: number; bootId: string; starttime: string }): boolean {
  const probed = probe(proc.pid);
  if (probed.ok) return probed.identity.bootId !== proc.bootId || probed.identity.starttime !== proc.starttime;
  // Fail closed: only a kernel-proven absence counts as gone. An
  // indeterminate probe proves nothing and must never advance state.
  return probed.code === "not_found";
}

/**
 * Event-driven settlement for carried adopted shells — markers only, at
 * existing seams. Rules, in order:
 *  - `[exited with code N]` → terminal `completed` (N = 0) or `failed`
 *    (N ≠ 0), the code preserved in the evidence. Claude wrote it; it is the
 *    task's real outcome.
 *  - `[killed]` → terminal `killed` (the task did not survive its session).
 *  - No marker: no outcome exists yet. If BOTH the recorded host and the
 *    (Linux-)discovered task process are kernel-proven gone, no marker can
 *    ever arrive — the item flips to `unknown` state (surfaced, never
 *    terminal, never delivered as completed). An indeterminate probe, a live
 *    host, or a live task leaves the item exactly as it is.
 */
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
    // Paused host (mixed carryover): the stopped supervisor writes no file
    // marker, so the task's real outcome comes from its uncollected exit
    // record. A still-running child stays active; a lost identity fails closed.
    if (host?.frozen === true) {
      const task = item.continuation?.taskProcess;
      if (task === undefined) {
        // A paused host is only ever created once every adopted task was
        // pinned; an unpinned item here means the record is inconsistent —
        // nothing to read, leave it as it is (surfaced, never invented).
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
    // Supervision is lost only when every recorded watcher is kernel-proven
    // gone. With no task identity pinned, the host's proven absence alone
    // means no marker can ever arrive.
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
  /** Terminate the identity-verified host (production: the wrapper's own PTY handle, or an identity-gated pid-exact kill). */
  terminateHost: (host: RetainedHostRecord) => Promise<boolean>;
}

/**
 * Retire the retained host once it has nothing left to supervise. Only the
 * wrapper calls this (the hook and `tasks` CLI never signal anything). The
 * host is signalled only while its live identity matches the record exactly;
 * a reused pid clears the record without a signal; an indeterminate probe
 * keeps everything as it is (fail closed).
 */
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
    // The pid names a stranger now: the host is gone; never signal.
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

/**
 * Pid-exact host termination for a wrapper that no longer holds the PTY
 * handle (restart). The confirmed POSIX route is process.kill(pid, signal) —
 * the same syscall node-pty's UnixTerminal.kill performs — gated on an exact
 * identity re-check immediately before each signal. Graceful first, so a
 * host still supervising something Claude-owned can reap it truthfully.
 */
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
  // A paused host cannot act on SIGTERM, and a SIGKILL of it releases the
  // uncollected task records whose outcomes were already read — so go
  // straight to SIGKILL. An alive host is asked gracefully first.
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
