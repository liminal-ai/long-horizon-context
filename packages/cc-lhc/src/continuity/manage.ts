import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import { probeProcessIdentityNative } from "../runtime/native-identity.js";
import type { ProbeProcessIdentity } from "../runtime/process-identity.js";
import {
  type AdapterContext,
  isRefusal,
  type PathFact,
  sameIdentity,
  statPathReal,
  verifyOutputFile,
} from "./adapters.js";
import type { CarriedResult, ContinuityItem, ContinuityOperation, ContinuityStore, VerifiedIdentity } from "./store.js";

export const DEFAULT_OUTPUT_MAX_BYTES = 64 * 1024;
export const OUTPUT_MAX_BYTES_CEILING = 1024 * 1024;

export type ManageRefusal =
  | "unknown_item"
  | "unsupported"
  | "not_active"
  | "identity_missing"
  | "identity_changed"
  | "identity_unverifiable"
  | "process_not_live"
  | "process_identity_changed"
  | "range_invalid"
  | "signal_failed";

export type IdentityCheck = "verified" | "changed" | "missing" | "unverifiable" | "none";

export interface ManagePorts {
  platform?: NodeJS.Platform;
  statPath?: (path: string) => PathFact;
  readFileIdentity?: AdapterContext["readFileIdentity"];
  probeIdentity?: ProbeProcessIdentity;
  signal?: (pid: number, platform: NodeJS.Platform) => { ok: true } | { ok: false; reason: string };
  nowMs?: () => number;
}

export interface ItemStatus {
  launchId: string;
  family: ContinuityItem["family"];
  label: string;
  state: ContinuityItem["state"];
  carryMode: ContinuityItem["carryMode"] | null;
  generation: number;
  operations: readonly ContinuityOperation[];
  identity: IdentityCheck;
  process: "live" | "exited" | "identity_changed" | "indeterminate" | null;
  terminal: ContinuityItem["terminal"];
}

export type StatusResult = { ok: true; status: ItemStatus } | { ok: false; reason: ManageRefusal; detail: string };

export interface OutputRange {
  offset?: number;
  maxBytes?: number;
}

export type OutputResult =
  | { ok: true; path: string; offset: number; bytes: Buffer; totalBytes: number; nextOffset: number | null }
  | { ok: false; reason: ManageRefusal; detail: string };

export type StopResult =
  | { ok: true; launchId: string; pid: number }
  | { ok: false; reason: ManageRefusal; detail: string };

function refuse<R extends { ok: false; reason: ManageRefusal; detail: string }>(
  reason: ManageRefusal,
  detail: string,
): R {
  return { ok: false, reason, detail } as R;
}

function contextOf(ports: ManagePorts): AdapterContext {
  return {
    platform: ports.platform ?? process.platform,
    sourceRolloutPath: undefined,
    statPath: ports.statPath ?? statPathReal,
    ...(ports.readFileIdentity === undefined ? {} : { readFileIdentity: ports.readFileIdentity }),
  };
}

function checkIdentity(item: ContinuityItem, ports: ManagePorts): IdentityCheck {
  const recorded = item.verifiedIdentity;
  if (recorded === null) return "none";
  const stat = ports.statPath ?? statPathReal;
  const files = (...paths: string[]): IdentityCheck => {
    const facts = paths.map((p) => stat(p).kind);
    if (facts.every((k) => k === "file")) return "verified";
    return facts.some((k) => k === "missing") ? "missing" : "unverifiable";
  };
  switch (recorded.kind) {
    case "posix_output":
    case "win32_output": {
      const current = verifyOutputFile(contextOf(ports), recorded.path);
      if (isRefusal(current)) return current.reason === "output_file_missing" ? "missing" : "unverifiable";
      return sameIdentity(current, recorded) ? "verified" : "changed";
    }
    case "agent_transcript":
      return files(recorded.path);
    case "workflow_run":
      return files(recorded.scriptPath, recorded.journalPath);
    case "scheduled_time":
    case "monitor_launch":
      return "verified";
  }
}

function checkProcess(item: ContinuityItem, ports: ManagePorts): ItemStatus["process"] {
  const proc = item.relaunch?.process ?? item.continuation?.taskProcess ?? null;
  if (proc === null) return null;
  const probed = (ports.probeIdentity ?? probeProcessIdentityNative)(proc.pid);
  if (!probed.ok) return probed.code === "not_found" ? "exited" : "indeterminate";
  return probed.identity.bootId === proc.bootId && probed.identity.starttime === proc.starttime
    ? "live"
    : "identity_changed";
}

export function itemStatus(
  store: ContinuityStore,
  threadId: string,
  launchId: string,
  ports: ManagePorts = {},
): StatusResult {
  const item = store.getItem(threadId, launchId);
  if (item === null) {
    const result = store.getResult(threadId, launchId);
    if (result === null) return refuse("unknown_item", `no carried item ${launchId} in this session's record`);
    return { ok: true, status: statusFromResult(result) };
  }
  return {
    ok: true,
    status: {
      launchId: item.launchId,
      family: item.family,
      label: item.label,
      state: item.state,
      carryMode: item.carryMode,
      generation: item.generation,
      operations: item.operations,
      identity: checkIdentity(item, ports),
      process: checkProcess(item, ports),
      terminal: item.terminal,
    },
  };
}

function statusFromResult(result: CarriedResult): ItemStatus {
  return {
    launchId: result.launchId,
    family: result.family,
    label: result.label,
    state: "terminal",
    carryMode: null,
    generation: result.generation,
    operations: result.artifact?.kind === "owned_copy" ? ["status", "output"] : ["status"],
    identity: "none",
    process: null,
    terminal: { outcome: result.outcome, evidence: result.evidence, observedAtMs: result.observedAtMs },
  };
}

function readBounded(path: string, requestedOffset: number, maxBytes: number): OutputResult {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (cause) {
    return refuse(
      "identity_unverifiable",
      `cannot open ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  try {
    const totalBytes = Number(fstatSync(fd, { bigint: true }).size);
    const offset =
      requestedOffset < 0 ? Math.max(0, totalBytes + requestedOffset) : Math.min(requestedOffset, totalBytes);
    const length = Math.min(maxBytes, totalBytes - offset);
    const bytes = Buffer.alloc(Math.max(0, length));
    let read = 0;
    while (read < length) {
      const n = readSync(fd, bytes, read, length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    const got = bytes.subarray(0, read);
    const end = offset + read;
    return { ok: true, path, offset, bytes: got, totalBytes, nextOffset: end < totalBytes ? end : null };
  } finally {
    closeSync(fd);
  }
}

function validRange(range: OutputRange): { offset: number; maxBytes: number } | null {
  const maxBytes = range.maxBytes ?? DEFAULT_OUTPUT_MAX_BYTES;
  const offset = range.offset ?? 0;
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > OUTPUT_MAX_BYTES_CEILING ||
    !Number.isInteger(offset)
  ) {
    return null;
  }
  return { offset, maxBytes };
}

function ownedArtifact(item: ContinuityItem): { path: string; identity: VerifiedIdentity } | null {
  if (item.relaunch !== null) return { path: item.relaunch.outputPath, identity: item.relaunch.output };
  const id = item.verifiedIdentity;
  if (id !== null && (id.kind === "posix_output" || id.kind === "win32_output")) return { path: id.path, identity: id };
  return null;
}

export function readItemOutput(
  store: ContinuityStore,
  threadId: string,
  launchId: string,
  range: OutputRange = {},
  ports: ManagePorts = {},
): OutputResult {
  const item = store.getItem(threadId, launchId);
  const valid = validRange(range);
  const readOwnedCopy = (result: CarriedResult): OutputResult => {
    if (result.artifact?.kind !== "owned_copy") {
      return refuse("unsupported", `${result.family} ${launchId} left no parent-readable output`);
    }
    if (valid === null)
      return refuse("range_invalid", `offset must be an integer and max in 1..${OUTPUT_MAX_BYTES_CEILING}`);
    if ((ports.statPath ?? statPathReal)(result.artifact.path).kind !== "file") {
      return refuse("identity_missing", `${launchId} owned result copy is gone: ${result.artifact.path}`);
    }
    return readBounded(result.artifact.path, valid.offset, valid.maxBytes);
  };
  if (item === null) {
    const result = store.getResult(threadId, launchId);
    if (result === null) return refuse("unknown_item", `no carried item ${launchId} in this session's record`);
    return readOwnedCopy(result);
  }
  if (!item.operations.includes("output")) {
    const result = store.getResult(threadId, launchId);
    if (result?.artifact?.kind === "owned_copy") return readOwnedCopy(result);
    return refuse("unsupported", `${item.family} ${launchId} offers no parent-readable output`);
  }
  const artifact = ownedArtifact(item);
  if (artifact === null) return refuse("identity_missing", `${launchId} has no verified output artifact`);
  if (valid === null)
    return refuse("range_invalid", `offset must be an integer and max in 1..${OUTPUT_MAX_BYTES_CEILING}`);
  const { offset: requestedOffset, maxBytes } = valid;
  const current = verifyOutputFile(contextOf(ports), artifact.path);
  if (isRefusal(current)) {
    return current.reason === "output_file_missing"
      ? refuse("identity_missing", `${launchId} output file is gone: ${artifact.path}`)
      : refuse("identity_unverifiable", `${launchId} output identity ${current.reason}`);
  }
  if (!sameIdentity(current, artifact.identity)) {
    return refuse("identity_changed", `${artifact.path} is no longer the file this item wrote`);
  }
  return readBounded(artifact.path, requestedOffset, maxBytes);
}

export function ownedOutputOf(item: ContinuityItem): { path: string; identity: VerifiedIdentity } | null {
  return ownedArtifact(item);
}

export function signalRelaunched(pid: number, platform: NodeJS.Platform): { ok: true } | { ok: false; reason: string } {
  try {
    if (platform === "win32") {
      const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
      if (result.status !== 0)
        return { ok: false, reason: (result.stderr || result.stdout || "taskkill failed").trim() };
      return { ok: true };
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * After a failed stop signal: is the exact process still running? taskkill /T
 * exits non-zero when one process in the tree is already gone or cannot be
 * terminated, even though the root was killed, and a forced termination can
 * outlast taskkill's own exit by a moment. So the process is re-probed for up
 * to `waitMs`: gone or a different incarnation means the stop took effect.
 * A probe that cannot tell counts as still running.
 */
export function stillRunningAfterFailedSignal(
  probe: ProbeProcessIdentity,
  proc: { pid: number; bootId: string; starttime: string },
  waitMs = 1_000,
): boolean {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const after = probe(proc.pid);
    const running = !after.ok
      ? after.code !== "not_found"
      : after.identity.bootId === proc.bootId && after.identity.starttime === proc.starttime;
    if (!running || Date.now() >= deadline) return running;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

export function stopItem(
  store: ContinuityStore,
  threadId: string,
  launchId: string,
  ports: ManagePorts = {},
): StopResult {
  const item = store.getItem(threadId, launchId);
  if (item === null) return refuse("unknown_item", `no carried item ${launchId} in this session's record`);
  if (!item.operations.includes("stop") || item.relaunch?.process == null) {
    return refuse("unsupported", `${item.family} ${launchId} offers no parent-side stop`);
  }
  if (item.state !== "active") return refuse("not_active", `${launchId} is ${item.state}`);
  const proc = item.relaunch.process;
  const probed = (ports.probeIdentity ?? probeProcessIdentityNative)(proc.pid);
  if (!probed.ok) {
    return probed.code === "not_found"
      ? refuse("process_not_live", `relaunched process pid ${proc.pid} has exited`)
      : refuse("identity_unverifiable", `relaunched process pid ${proc.pid}: ${probed.message}`);
  }
  if (probed.identity.bootId !== proc.bootId || probed.identity.starttime !== proc.starttime) {
    return refuse("process_identity_changed", `pid ${proc.pid} is now a different process; nothing signalled`);
  }
  const signalled = (ports.signal ?? signalRelaunched)(proc.pid, ports.platform ?? process.platform);
  if (!signalled.ok && stillRunningAfterFailedSignal(ports.probeIdentity ?? probeProcessIdentityNative, proc)) {
    return refuse("signal_failed", signalled.reason);
  }
  store.recordTerminal({
    threadId,
    launchId,
    outcome: "stopped",
    evidence: `stopped by the replacement session (cc-lhc tasks stop, pid ${proc.pid})`,
    nowMs: (ports.nowMs ?? Date.now)(),
  });
  return { ok: true, launchId, pid: proc.pid };
}
