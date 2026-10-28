import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

import { probeProcessIdentityNative } from "../runtime/native-identity.js";
import type { ProbeProcessIdentity } from "../runtime/process-identity.js";
import {
  isRefusal,
  type MonitorLaunchSpec,
  type PathFact,
  resolveMonitorLaunch,
  statPathReal,
  verifyOutputFile,
} from "./adapters.js";
import { type RelaunchShell, type RelaunchShellResolution, resolveRelaunchShell } from "./relaunch-shell.js";
import { type ClosureResult, type ContinuitySnapshot, closeContinuitySnapshot } from "./snapshot.js";
import { type ContinuityStore, relaunchKey } from "./store.js";

export function relaunchOutputPath(dir: string, launchId: string, generation: number): string {
  const safe = relaunchKey(launchId, generation).replace(/[^A-Za-z0-9._-]/g, "_");
  return join(dir, `${safe}.output`);
}

export type RelaunchSpawn = (
  spec: MonitorLaunchSpec,
  outputFd: number,
  cwd: string,
  shell: RelaunchShell,
) => { pid: number };

export function spawnRelaunchReal(
  spec: MonitorLaunchSpec,
  outputFd: number,
  cwd: string,
  shell: RelaunchShell,
): { pid: number } {
  const child: ChildProcess = spawn(shell.program, shell.args(spec.command), {
    cwd,
    env: process.env,
    stdio: ["ignore", outputFd, outputFd],
    detached: true,
    windowsHide: true,
  });
  child.unref();
  if (child.pid === undefined) throw new Error("no pid");
  return { pid: child.pid };
}

export interface CarryoverPorts {
  monitorOutputDir: string;
  cwd: string;
  statPath?: (path: string) => PathFact;
  readRollout?: (path: string) => string | null;
  spawnRelaunch?: RelaunchSpawn;
  relaunchShell?: RelaunchShellResolution;
  probeIdentity?: ProbeProcessIdentity;
  platform?: NodeJS.Platform;
  log: (message: string) => void;
}

export type InvocationResult =
  | { launchId: string; kind: "adopted" | "manifest" | "rearmed" }
  | { launchId: string; kind: "relaunched"; pid: number; outputPath: string }
  | { launchId: string; kind: "already_relaunched"; outputPath: string }
  | { launchId: string; kind: "relaunch_carried"; pid: number | null; outputPath: string }
  | { launchId: string; kind: "failed"; reason: string };

export interface CarryoverTransfer {
  generation: number;
  results: InvocationResult[];
  closure: ClosureResult;
}

function failed(launchId: string, reason: string): InvocationResult {
  return { launchId, kind: "failed", reason };
}

export function invokeCarryover(
  store: ContinuityStore,
  snapshot: ContinuitySnapshot,
  ports: CarryoverPorts,
  nowMs: number,
): CarryoverTransfer {
  const generationClosed = store.getGeneration(snapshot.threadId, snapshot.generation)?.state === "closed";
  const statPath = ports.statPath ?? statPathReal;
  const spawnRelaunch = ports.spawnRelaunch ?? spawnRelaunchReal;
  const platform = ports.platform ?? process.platform;
  const relaunchShell = ports.relaunchShell ?? resolveRelaunchShell(platform);
  const probeIdentity = ports.probeIdentity ?? probeProcessIdentityNative;
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
        if (
          item.relaunch !== null &&
          item.relaunch.outputPath !== relaunchOutputPath(ports.monitorOutputDir, item.launchId, snapshot.generation)
        ) {
          result = {
            launchId: item.launchId,
            kind: "relaunch_carried",
            pid: item.relaunch.process?.pid ?? null,
            outputPath: item.relaunch.outputPath,
          };
          break;
        }
        if (generationClosed) {
          const outputPath = relaunchOutputPath(ports.monitorOutputDir, item.launchId, snapshot.generation);
          result =
            statPath(outputPath).kind === "file"
              ? { launchId: item.launchId, kind: "already_relaunched", outputPath }
              : failed(item.launchId, "monitor relaunch unavailable: generation_closed");
          break;
        }
        const resolved = resolveMonitorLaunch(c.rolloutPath, c.toolUseId, ports.readRollout);
        if (!resolved.ok) {
          result = failed(item.launchId, `monitor relaunch unavailable: ${resolved.reason}`);
          break;
        }
        if (!relaunchShell.ok) {
          result = failed(item.launchId, `monitor relaunch unavailable: ${relaunchShell.reason}`);
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
          const spawned = spawnRelaunch(resolved.spec, fd, ports.cwd, relaunchShell.shell);
          result = { launchId: item.launchId, kind: "relaunched", pid: spawned.pid, outputPath };
          const output = verifyOutputFile({ platform, sourceRolloutPath: undefined, statPath }, outputPath);
          if (isRefusal(output)) {
            ports.log(`cc-lhc continuity: ${item.family} ${item.launchId} relaunch output identity ${output.reason}`);
          } else {
            const probed = probeIdentity(spawned.pid);
            store.setRelaunched({
              threadId: snapshot.threadId,
              launchId: item.launchId,
              relaunch: {
                outputPath,
                output,
                process: probed.ok
                  ? { pid: probed.identity.pid, bootId: probed.identity.bootId, starttime: probed.identity.starttime }
                  : null,
              },
              nowMs,
            });
            if (!probed.ok) {
              ports.log(
                `cc-lhc continuity: ${item.family} ${item.launchId} relaunched process identity ${probed.code}; stop unavailable`,
              );
            }
          }
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
    if (result.kind === "failed" && !generationClosed) {
      store.recordTerminal({
        threadId: snapshot.threadId,
        launchId: item.launchId,
        outcome: "failed",
        evidence: result.reason,
        nowMs,
      });
    }
    results.push(result);
    ports.log(describeInvocation(item.family, result, snapshot.generation, generationClosed));
  }
  const closure = closeContinuitySnapshot(store, {
    threadId: snapshot.threadId,
    generation: snapshot.generation,
    nowMs,
  });
  return { generation: snapshot.generation, results, closure };
}

function describeInvocation(
  family: string,
  result: InvocationResult,
  generation: number,
  generationClosed: boolean,
): string {
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
    case "relaunch_carried":
      return `${head} carried as is (the wrapper's own relaunch${
        result.pid === null ? "" : `, pid ${result.pid}`
      }; generation ${generation})`;
    case "failed":
      return generationClosed
        ? `${head} not carried: ${result.reason} (generation ${generation} already closed; nothing recorded)`
        : `${head} not carried: ${result.reason} (recorded as failed)`;
  }
}
