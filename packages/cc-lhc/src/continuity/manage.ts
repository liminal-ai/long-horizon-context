/**
 * Carried-work management for the replacement session (LIM-146 AC-2.6).
 *
 * Every operation addresses one logical item by its launch id in the parent's
 * continuity record and re-verifies the item's identity before touching
 * anything outside the database:
 *
 *  - status: the item as recorded, plus whether its verified identity still
 *    holds now and (for a parent-relaunched Monitor) whether that exact
 *    process is live. Reads nothing else.
 *  - output: a bounded byte range of the one artifact the item owns — the
 *    adopted shell's output file or the parent's relaunch output — read only
 *    after that file's recorded identity re-verifies. Never a child handle.
 *  - stop: only for a parent-relaunched Monitor whose exact process identity
 *    was recorded at spawn; the pid is re-read through the native probe and
 *    signalled only on exact equality, then the item is closed `stopped`.
 *
 * Missing, changed, unverifiable, foreign (another thread), or unsupported
 * identity refuses without reading a file or signalling a process.
 */

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
import type { ContinuityItem, ContinuityOperation, ContinuityStore, VerifiedIdentity } from "./store.js";

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
  /** Signal the exact-verified relaunched process; default sends the platform's termination. */
  signal?: (pid: number, platform: NodeJS.Platform) => { ok: true } | { ok: false; reason: string };
  nowMs?: () => number;
}

export interface ItemStatus {
  launchId: string;
  family: ContinuityItem["family"];
  label: string;
  state: ContinuityItem["state"];
  carryMode: ContinuityItem["carryMode"];
  generation: number;
  operations: readonly ContinuityOperation[];
  /** Does the recorded identity still name the same work right now? */
  identity: IdentityCheck;
  /** Parent-relaunched Monitor only: the exact recorded process. */
  process: "live" | "exited" | "identity_changed" | "indeterminate" | null;
  terminal: ContinuityItem["terminal"];
}

export type StatusResult = { ok: true; status: ItemStatus } | { ok: false; reason: ManageRefusal; detail: string };

export interface OutputRange {
  /** Byte offset to start from; negative counts from the end (tail). */
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

/**
 * Re-verify the item's recorded identity now, from the identity's own facts:
 * an output file must still be the same file object; an agent transcript or
 * workflow script/journal must still exist at its recorded path; a scheduled
 * time and a monitor's launch reference are durable facts and stay verified.
 */
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
  const proc = item.relaunch?.process ?? null;
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
  if (item === null) return refuse("unknown_item", `no carried item ${launchId} in this session's record`);
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

/** The one artifact an item owns for `output`, with the identity it must still have. */
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
  if (item === null) return refuse("unknown_item", `no carried item ${launchId} in this session's record`);
  if (!item.operations.includes("output")) {
    return refuse("unsupported", `${item.family} ${launchId} offers no parent-readable output`);
  }
  const artifact = ownedArtifact(item);
  if (artifact === null) return refuse("identity_missing", `${launchId} has no verified output artifact`);
  const maxBytes = range.maxBytes ?? DEFAULT_OUTPUT_MAX_BYTES;
  const requestedOffset = range.offset ?? 0;
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > OUTPUT_MAX_BYTES_CEILING ||
    !Number.isInteger(requestedOffset)
  ) {
    return refuse("range_invalid", `offset must be an integer and max in 1..${OUTPUT_MAX_BYTES_CEILING}`);
  }
  // Re-verify the file's identity before opening it: a replaced or reused path is not this item's output.
  const current = verifyOutputFile(contextOf(ports), artifact.path);
  if (isRefusal(current)) {
    return current.reason === "output_file_missing"
      ? refuse("identity_missing", `${launchId} output file is gone: ${artifact.path}`)
      : refuse("identity_unverifiable", `${launchId} output identity ${current.reason}`);
  }
  if (!sameIdentity(current, artifact.identity)) {
    return refuse("identity_changed", `${artifact.path} is no longer the file this item wrote`);
  }
  let fd: number;
  try {
    fd = openSync(artifact.path, "r");
  } catch (cause) {
    return refuse(
      "identity_unverifiable",
      `cannot open ${artifact.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
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
    return { ok: true, path: artifact.path, offset, bytes: got, totalBytes, nextOffset: end < totalBytes ? end : null };
  } finally {
    closeSync(fd);
  }
}

/** Platform termination of one exact-verified process the parent started detached (a group leader on POSIX). */
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
  if (!signalled.ok) return refuse("signal_failed", signalled.reason);
  store.recordTerminal({
    threadId,
    launchId,
    outcome: "stopped",
    evidence: `stopped by the replacement session (cc-lhc tasks stop, pid ${proc.pid})`,
    nowMs: (ports.nowMs ?? Date.now)(),
  });
  return { ok: true, launchId, pid: proc.pid };
}
