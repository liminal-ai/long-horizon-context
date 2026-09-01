/**
 * Carryover transfer at the Smart Compact handoff (LIM-145 AC-2.5–2.8).
 *
 * After the replacement child is live, each carried item's declared mechanism
 * is invoked once for the handoff generation, then the same generation is
 * closed. The parent does only what a mechanism needs from it:
 *
 *  - parent_output_read: nothing to start — the process never stopped; the
 *    output file is re-verified so an adopted item is never claimed blindly.
 *  - send_message / workflow_resume / rearm_at: the replacement continues
 *    these from the manifest in its rebuilt rollout; the parent starts nothing.
 *  - monitor_relaunch: the exact launch specification is resolved from the
 *    old rollout now, never earlier, and run once under
 *    `relaunchKey(launchId, generation)`. The fence is the exclusive creation
 *    of that key's output file: a second invocation for the same generation
 *    finds it and starts nothing. The command text is held in memory only.
 *
 * An unavailable mechanism or a failed invocation closes that item with one
 * truthful `failed` terminal outcome; the handoff is never retried or rolled
 * back for it.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

import { type MonitorLaunchSpec, type PathFact, resolveMonitorLaunch, statPathReal } from "./adapters.js";
import { type ClosureResult, type ContinuitySnapshot, closeContinuitySnapshot } from "./snapshot.js";
import { type ContinuityStore, relaunchKey } from "./store.js";

/** Where a relaunched Monitor writes: one file per relaunch key, created exclusively. */
export function relaunchOutputPath(dir: string, launchId: string, generation: number): string {
  const safe = relaunchKey(launchId, generation).replace(/[^A-Za-z0-9._-]/g, "_");
  return join(dir, `${safe}.output`);
}

export type RelaunchSpawn = (spec: MonitorLaunchSpec, outputFd: number, cwd: string) => { pid: number };

/** The platform's POSIX shell runs the exact command string, detached, output to the fence file. */
export function spawnRelaunchReal(spec: MonitorLaunchSpec, outputFd: number, cwd: string): { pid: number } {
  const child: ChildProcess = spawn("/bin/sh", ["-c", spec.command], {
    cwd,
    env: process.env,
    stdio: ["ignore", outputFd, outputFd],
    detached: true,
  });
  child.unref();
  if (child.pid === undefined) throw new Error("no pid");
  return { pid: child.pid };
}

export interface CarryoverPorts {
  /** Directory for relaunch output files (created on demand). */
  monitorOutputDir: string;
  /** Working directory for a relaunched command: the old child's. */
  cwd: string;
  statPath?: (path: string) => PathFact;
  readRollout?: (path: string) => string | null;
  spawnRelaunch?: RelaunchSpawn;
  log: (message: string) => void;
}

export type InvocationResult =
  | { launchId: string; kind: "adopted" | "manifest" | "rearmed" }
  | { launchId: string; kind: "relaunched"; pid: number; outputPath: string }
  | { launchId: string; kind: "already_relaunched"; outputPath: string }
  | { launchId: string; kind: "failed"; reason: string };

export interface CarryoverTransfer {
  generation: number;
  results: InvocationResult[];
  closure: ClosureResult;
}

function failed(launchId: string, reason: string): InvocationResult {
  return { launchId, kind: "failed", reason };
}

/**
 * Invoke every carried mechanism once for the snapshot's generation, record a
 * truthful terminal failure for anything that cannot continue, then close the
 * generation. Idempotent per generation: a relaunch already performed is
 * reported, not repeated.
 */
export function invokeCarryover(
  store: ContinuityStore,
  snapshot: ContinuitySnapshot,
  ports: CarryoverPorts,
  nowMs: number,
): CarryoverTransfer {
  const statPath = ports.statPath ?? statPathReal;
  const spawnRelaunch = ports.spawnRelaunch ?? spawnRelaunchReal;
  const results: InvocationResult[] = [];
  for (const item of snapshot.items) {
    const c = item.continuation;
    let result: InvocationResult;
    switch (c.kind) {
      case "parent_output_read": {
        const fact = statPath(c.path);
        result =
          fact.kind === "file"
            ? { launchId: item.launchId, kind: "adopted" }
            : failed(item.launchId, `adopted output ${fact.kind}`);
        break;
      }
      case "send_message":
      case "workflow_resume":
        result = { launchId: item.launchId, kind: "manifest" };
        break;
      case "rearm_at":
        result = { launchId: item.launchId, kind: "rearmed" };
        break;
      case "monitor_relaunch": {
        const resolved = resolveMonitorLaunch(c.rolloutPath, c.toolUseId, ports.readRollout);
        if (!resolved.ok) {
          result = failed(item.launchId, `monitor relaunch unavailable: ${resolved.reason}`);
          break;
        }
        const outputPath = relaunchOutputPath(ports.monitorOutputDir, item.launchId, snapshot.generation);
        let fd: number;
        try {
          mkdirSync(ports.monitorOutputDir, { recursive: true, mode: 0o700 });
          fd = openSync(outputPath, "wx", 0o600);
        } catch (cause) {
          const code = (cause as { code?: string }).code;
          result =
            code === "EEXIST"
              ? { launchId: item.launchId, kind: "already_relaunched", outputPath }
              : failed(item.launchId, `monitor relaunch output ${code ?? "unavailable"}`);
          break;
        }
        try {
          const spawned = spawnRelaunch(resolved.spec, fd, ports.cwd);
          result = { launchId: item.launchId, kind: "relaunched", pid: spawned.pid, outputPath };
        } catch (cause) {
          result = failed(
            item.launchId,
            `monitor relaunch failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        } finally {
          closeSync(fd);
        }
        break;
      }
    }
    if (result.kind === "failed") {
      store.recordTerminal({
        threadId: snapshot.threadId,
        launchId: item.launchId,
        outcome: "failed",
        evidence: result.reason,
        nowMs,
      });
    }
    results.push(result);
    ports.log(describeInvocation(item.family, result, snapshot.generation));
  }
  const closure = closeContinuitySnapshot(store, {
    threadId: snapshot.threadId,
    generation: snapshot.generation,
    nowMs,
  });
  return { generation: snapshot.generation, results, closure };
}

/** One log line per item: family, launch id, and outcome. Never the command. */
function describeInvocation(family: string, result: InvocationResult, generation: number): string {
  const head = `cc-lhc continuity: ${family} ${result.launchId}`;
  switch (result.kind) {
    case "adopted":
      return `${head} adopted (generation ${generation})`;
    case "manifest":
      return `${head} carried in the rebuilt session's manifest (generation ${generation})`;
    case "rearmed":
      return `${head} re-armed (generation ${generation})`;
    case "relaunched":
      return `${head} restarted once (generation ${generation}, pid ${result.pid})`;
    case "already_relaunched":
      return `${head} already restarted for generation ${generation}; not repeated`;
    case "failed":
      return `${head} not carried: ${result.reason} (recorded as failed)`;
  }
}
