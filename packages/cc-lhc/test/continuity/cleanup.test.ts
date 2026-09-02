/**
 * LIM-146 AC-2.10 (TC-2.10a–c): bounded cleanup of finished carried work over
 * the real SQLite record and real files. Ordering (result safe → copy → result
 * updated → tracking removed), the 1 MiB bound and 0600 mode, survival of
 * status/output through the durable result, byte-exact user output, fence
 * removal only after copy, exact preservation of open work, refusal on
 * identity change / copy failure / update failure / missing result, and no
 * process signal anywhere.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { statPathReal, verifyOutputFile } from "../../src/continuity/adapters.js";
import { cleanupThread, RESULT_COPY_MAX_BYTES, resultCopyDir } from "../../src/continuity/cleanup.js";
import { itemStatus, readItemOutput } from "../../src/continuity/manage.js";
import { createContinuityObserver } from "../../src/continuity/observe.js";
import { type ContinuityStore, openContinuityStore } from "../../src/continuity/store.js";
import { probeProcessIdentityNative } from "../../src/runtime/native-identity.js";
import { allLaunchLines, LAUNCH_IDS, notification, qualifyAll, reapProcesses, toolResult, toolUse } from "./helpers.js";

const T = "th_cleanup";
const OTHER = "th_other";
const ALL_IDS = Object.values(LAUNCH_IDS);
const ctx = { platform: process.platform, sourceRolloutPath: undefined, statPath: statPathReal } as const;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const pids: number[] = [];
afterEach(async () => {
  await reapProcesses(pids);
});

/** A thread with five carried items: shell adopted (real 1 MiB+ output), Monitor relaunched by the parent (real live process + fence). */
function seed() {
  const root = mkdtempSync(join(tmpdir(), "cc-lhc-cleanup-"));
  const continuityDir = join(root, "continuity");
  const tasksDir = join(root, "tasks");
  mkdirSync(continuityDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  const shellOutput = join(tasksDir, "shell-1.output");
  const source = Buffer.alloc(RESULT_COPY_MAX_BYTES + 64);
  for (let i = 0; i < source.length; i += 1) source[i] = 33 + ((i * 7) % 90);
  writeFileSync(shellOutput, source);
  const fence = join(continuityDir, "monitor_mon-1_toolu_mon.1.output");
  writeFileSync(fence, "relaunched-once-XyZ");
  const fenceFd = openSync(fence, "a");
  // A portable long-lived writer holding the fence open (no /bin/sh on Windows).
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
    detached: true,
    stdio: ["ignore", fenceFd, fenceFd],
  });
  child.unref();
  pids.push(child.pid!);
  const probed = probeProcessIdentityNative(child.pid!);
  if (!probed.ok) throw new Error(`probe: ${probed.message}`);

  const dbPath = join(root, "cc-lhc.sqlite");
  const store = openContinuityStore(dbPath);
  const observer = createContinuityObserver({ store, threadId: T, nowFn: () => 1_000 });
  for (const line of allLaunchLines()) observer.observeLine(line);
  qualifyAll(store, T, 2_000);
  const shellIdentity = verifyOutputFile(ctx, shellOutput);
  if ("ok" in shellIdentity) throw new Error("shell identity");
  store.setCarryMode({
    threadId: T,
    launchId: LAUNCH_IDS.background_shell,
    carryMode: "adopt",
    operations: ["status", "output"],
    verifiedIdentity: shellIdentity,
    nowMs: 2_001,
  });
  store.setCarryMode({
    threadId: T,
    launchId: LAUNCH_IDS.monitor,
    carryMode: "reconstruct",
    operations: ["status"],
    verifiedIdentity: { kind: "monitor_launch", toolUseId: "toolu_mon", rolloutPath: join(root, "old.jsonl") },
    nowMs: 2_002,
  });
  store.allocateGeneration({ threadId: T, oldSessionId: "old", launchIds: ALL_IDS, nowMs: 3_000 });
  const fenceIdentity = verifyOutputFile(ctx, fence);
  if ("ok" in fenceIdentity) throw new Error("fence identity");
  store.setRelaunched({
    threadId: T,
    launchId: LAUNCH_IDS.monitor,
    relaunch: {
      outputPath: fence,
      output: fenceIdentity,
      process: { pid: child.pid!, bootId: probed.identity.bootId, starttime: probed.identity.starttime },
    },
    nowMs: 3_001,
  });
  // A never-carried later launch (generation 0) that finishes: obsolete tracking with nothing to preserve.
  observer.observeLine(toolUse("toolu_agent2", "Agent", { description: "later", subagent_type: "general-purpose" }));
  observer.observeLine(
    toolResult("toolu_agent2", { status: "async_launched", agentId: "agent-2", description: "agent-2" }),
  );
  observer.observeLine(notification({ taskIds: ["agent-2"], status: "completed" }));
  // Another thread's carried item in the same database.
  const other = createContinuityObserver({ store, threadId: OTHER, nowFn: () => 1_000 });
  other.observeLine(toolUse("toolu_agent9", "Agent", { description: "other", subagent_type: "general-purpose" }));
  other.observeLine(
    toolResult("toolu_agent9", { status: "async_launched", agentId: "agent-9", description: "agent-9" }),
  );
  qualifyAll(store, OTHER, 2_000);
  store.allocateGeneration({
    threadId: OTHER,
    oldSessionId: "x",
    launchIds: ["agent:agent-9:toolu_agent9"],
    nowMs: 3_000,
  });
  store.recordTerminal({
    threadId: OTHER,
    launchId: "agent:agent-9:toolu_agent9",
    outcome: "completed",
    evidence: "x",
    nowMs: 4_000,
  });

  const finish = (launchId: string, outcome: "completed" | "failed" | "stopped" = "completed") =>
    store.recordTerminal({ threadId: T, launchId, outcome, evidence: `task-notification ${outcome}`, nowMs: 5_000 });
  const copies = () =>
    existsSync(resultCopyDir(continuityDir)) ? readdirSync(resultCopyDir(continuityDir)).sort() : [];
  const logs: string[] = [];
  const clean = (ports: Parameters<typeof cleanupThread>[3] = {}) =>
    cleanupThread(store, T, continuityDir, { log: (m) => logs.push(m), ...ports });
  const otherState = () => ({
    items: store.listItems(OTHER),
    gen: store.getGeneration(OTHER, 1),
    result: store.getResult(OTHER, "agent:agent-9:toolu_agent9"),
  });
  return {
    root,
    dbPath,
    continuityDir,
    shellOutput,
    source,
    fence,
    pid: child.pid!,
    store,
    finish,
    copies,
    clean,
    logs,
    otherState,
  };
}

describe("cleanup of finished carried work", () => {
  it("TC-2.10a/b: a finished adopted shell's output is copied (≤1 MiB, 0600) and its result repointed before its tracking goes; status/output survive; user output and open siblings are untouched", () => {
    const s = seed();
    s.finish(LAUNCH_IDS.background_shell);
    s.finish(LAUNCH_IDS.agent);
    const open = [LAUNCH_IDS.monitor, LAUNCH_IDS.workflow, LAUNCH_IDS.scheduled_wakeup].map((id) =>
      s.store.getItem(T, id),
    );
    const gen = s.store.getGeneration(T, 1);
    const other = s.otherState();

    const report = s.clean();
    expect(report.removed.sort()).toEqual(
      [LAUNCH_IDS.agent, LAUNCH_IDS.background_shell, "agent:agent-2:toolu_agent2"].sort(),
    );
    expect(report.retained).toEqual([]);
    expect(report.preserved.sort()).toEqual(
      [LAUNCH_IDS.monitor, LAUNCH_IDS.workflow, LAUNCH_IDS.scheduled_wakeup].sort(),
    );
    expect(report.fencesRemoved).toEqual([]);
    expect(report.generationsRemoved).toBe(0);
    expect(report.copied).toHaveLength(1);
    const copy = report.copied[0]!;
    expect(copy).toMatchObject({
      launchId: LAUNCH_IDS.background_shell,
      bytes: RESULT_COPY_MAX_BYTES,
      truncated: true,
    });
    expect(copy.path.startsWith(resultCopyDir(s.continuityDir))).toBe(true);
    expect(statSync(copy.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(copy.path).equals(s.source.subarray(0, RESULT_COPY_MAX_BYTES))).toBe(true);
    // The user's output is byte-exact and still the same file object.
    expect(readFileSync(s.shellOutput).equals(s.source)).toBe(true);
    // Durable results: repointed shell, plain agent; both retained and pending.
    expect(s.store.getResult(T, LAUNCH_IDS.background_shell)).toMatchObject({
      artifact: { kind: "owned_copy", path: copy.path, bytes: RESULT_COPY_MAX_BYTES, truncated: true },
      delivery: "pending",
    });
    expect(s.store.getResult(T, LAUNCH_IDS.agent)).toMatchObject({ artifact: null, delivery: "pending" });
    expect(s.store.getResult(T, "agent:agent-2:toolu_agent2")).toBeNull();
    // Tracking gone, status and bounded output still answer from the result.
    expect(s.store.getItem(T, LAUNCH_IDS.background_shell)).toBeNull();
    expect(itemStatus(s.store, T, LAUNCH_IDS.background_shell)).toMatchObject({
      ok: true,
      status: {
        state: "terminal",
        carryMode: null,
        operations: ["status", "output"],
        identity: "none",
        process: null,
        terminal: { outcome: "completed" },
      },
    });
    const out = readItemOutput(s.store, T, LAUNCH_IDS.background_shell, { offset: 100, maxBytes: 1_000 });
    expect(out.ok && out.bytes.equals(s.source.subarray(100, 1_100))).toBe(true);
    expect(out.ok && out.totalBytes).toBe(RESULT_COPY_MAX_BYTES);
    expect(readItemOutput(s.store, T, LAUNCH_IDS.agent)).toMatchObject({ ok: false, reason: "unsupported" });
    // Open work, its relaunch record, its live process, its fence, and its generation: exactly as before.
    expect(
      [LAUNCH_IDS.monitor, LAUNCH_IDS.workflow, LAUNCH_IDS.scheduled_wakeup].map((id) => s.store.getItem(T, id)),
    ).toEqual(open);
    expect(s.store.getGeneration(T, 1)).toEqual(gen);
    expect(alive(s.pid)).toBe(true);
    expect(readFileSync(s.fence, "utf8")).toBe("relaunched-once-XyZ");
    expect(s.otherState()).toEqual(other);
    // Idempotent: nothing further changes.
    const copyStat = statSync(copy.path);
    const again = s.clean();
    expect(again).toMatchObject({ removed: [], retained: [], copied: [], fencesRemoved: [], generationsRemoved: 0 });
    expect(statSync(copy.path).mtimeMs).toBe(copyStat.mtimeMs);
    expect(s.copies()).toHaveLength(1);
    s.store.close();
  });

  it("TC-2.10b/c: a terminal Monitor's fence is removed only after its copy is durable, no process is signalled, and generation rows go only once nothing is open", () => {
    const s = seed();
    s.finish(LAUNCH_IDS.background_shell);
    s.finish(LAUNCH_IDS.agent);
    s.finish(LAUNCH_IDS.workflow, "failed");
    // Monitor still active: its fence and process stay whatever else is cleaned.
    let report = s.clean();
    // shell, agent, workflow, and the never-carried agent-2.
    expect(report.removed).toHaveLength(4);
    expect(report.preserved.sort()).toEqual([LAUNCH_IDS.monitor, LAUNCH_IDS.scheduled_wakeup].sort());
    expect(existsSync(s.fence)).toBe(true);
    expect(alive(s.pid)).toBe(true);
    expect(s.store.getGeneration(T, 1)).toMatchObject({ state: "open" });
    // Monitor and wakeup finish (the process itself is still there — cleanup never signals it).
    s.finish(LAUNCH_IDS.monitor, "stopped");
    s.finish(LAUNCH_IDS.scheduled_wakeup);
    report = s.clean();
    expect(report.removed.sort()).toEqual([LAUNCH_IDS.monitor, LAUNCH_IDS.scheduled_wakeup].sort());
    expect(report.retained).toEqual([]);
    expect(report.copied).toHaveLength(1);
    const copy = report.copied[0]!;
    expect(copy).toMatchObject({ launchId: LAUNCH_IDS.monitor, bytes: "relaunched-once-XyZ".length, truncated: false });
    expect(readFileSync(copy.path, "utf8")).toBe("relaunched-once-XyZ");
    expect(statSync(copy.path).mode & 0o777).toBe(0o600);
    expect(report.fencesRemoved).toEqual([s.fence]);
    expect(existsSync(s.fence)).toBe(false);
    expect(alive(s.pid)).toBe(true);
    expect(s.store.getResult(T, LAUNCH_IDS.monitor)).toMatchObject({
      outcome: "stopped",
      artifact: { kind: "owned_copy", path: copy.path },
    });
    // Nothing open: the thread's generation tracking goes; every result and copy stays.
    expect(report.generationsRemoved).toBe(1);
    expect(s.store.listItems(T)).toEqual([]);
    expect(s.store.getGeneration(T, 1)).toBeNull();
    expect(
      s.store
        .listPendingResults(T)
        .map((r) => r.launchId)
        .sort(),
    ).toEqual(ALL_IDS.slice().sort());
    expect(s.copies()).toHaveLength(2);
    expect(itemStatus(s.store, T, LAUNCH_IDS.monitor)).toMatchObject({
      ok: true,
      status: { state: "terminal", terminal: { outcome: "stopped" } },
    });
    expect(s.otherState().items).toHaveLength(1);
    // Rerun over an empty thread: no-op.
    expect(s.clean()).toMatchObject({ removed: [], retained: [], copied: [], generationsRemoved: 0 });
    s.store.close();
  });

  it("TC-2.10c: identity change, copy failure, update failure, or a missing durable result retains the item and its original reference and deletes nothing", () => {
    const s = seed();
    s.finish(LAUNCH_IDS.background_shell);
    s.finish(LAUNCH_IDS.monitor, "stopped");
    s.finish(LAUNCH_IDS.agent);
    const shellBefore = s.store.getItem(T, LAUNCH_IDS.background_shell)!;
    const shellResultBefore = s.store.getResult(T, LAUNCH_IDS.background_shell)!;
    const monitorBefore = s.store.getItem(T, LAUNCH_IDS.monitor)!;
    const monitorResultBefore = s.store.getResult(T, LAUNCH_IDS.monitor)!;

    // Identity change: the shell's output path now names another file object.
    writeFileSync(`${s.shellOutput}.new`, "someone else");
    renameSync(`${s.shellOutput}.new`, s.shellOutput);
    // Copy failure for the monitor's fence.
    const failing = {
      copyBounded: () => {
        throw new Error("disk full");
      },
    };
    let report = s.clean(failing);
    expect(report.retained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ launchId: LAUNCH_IDS.background_shell, reason: "identity_changed" }),
        expect.objectContaining({ launchId: LAUNCH_IDS.monitor, reason: "copy_failed" }),
      ]),
    );
    expect(report.retained).toHaveLength(2);
    expect(report.removed).toEqual(expect.arrayContaining([LAUNCH_IDS.agent]));
    expect(report.copied).toEqual([]);
    expect(report.fencesRemoved).toEqual([]);
    expect(report.generationsRemoved).toBe(0);
    expect(s.store.getItem(T, LAUNCH_IDS.background_shell)).toEqual(shellBefore);
    expect(s.store.getResult(T, LAUNCH_IDS.background_shell)).toEqual(shellResultBefore);
    expect(s.store.getItem(T, LAUNCH_IDS.monitor)).toEqual(monitorBefore);
    expect(s.store.getResult(T, LAUNCH_IDS.monitor)).toEqual(monitorResultBefore);
    expect(readFileSync(s.shellOutput, "utf8")).toBe("someone else");
    expect(existsSync(s.fence)).toBe(true);
    expect(s.copies()).toEqual([]);
    expect(alive(s.pid)).toBe(true);
    expect(s.store.getGeneration(T, 1)).not.toBeNull();

    // Update failure: the copy is made, the result refuses it — the copy is withdrawn and the original reference kept.
    const refusing: ContinuityStore = {
      ...s.store,
      setResultArtifact: () => {
        throw new Error("database is locked");
      },
    };
    report = cleanupThread(refusing, T, s.continuityDir, { log: (m) => s.logs.push(m) });
    expect(report.retained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ launchId: LAUNCH_IDS.monitor, reason: "result_update_failed" }),
      ]),
    );
    expect(s.store.getItem(T, LAUNCH_IDS.monitor)).toEqual(monitorBefore);
    expect(s.store.getResult(T, LAUNCH_IDS.monitor)).toEqual(monitorResultBefore);
    expect(existsSync(s.fence)).toBe(true);
    expect(s.copies()).toEqual([]);

    // Missing durable result: a carried terminal item whose result row is gone is kept, not removed.
    const db = new DatabaseSync(s.dbPath);
    db.prepare("DELETE FROM cc_continuity_results WHERE thread_id = ? AND launch_id = ?").run(T, LAUNCH_IDS.monitor);
    db.close();
    report = s.clean();
    expect(report.retained).toEqual(
      expect.arrayContaining([expect.objectContaining({ launchId: LAUNCH_IDS.monitor, reason: "no_durable_result" })]),
    );
    expect(s.store.getItem(T, LAUNCH_IDS.monitor)).toEqual(monitorBefore);
    expect(existsSync(s.fence)).toBe(true);
    expect(alive(s.pid)).toBe(true);
    expect(s.logs.some((m) => m.includes("retained") && m.includes("no_durable_result"))).toBe(true);
    s.store.close();
  });
});
