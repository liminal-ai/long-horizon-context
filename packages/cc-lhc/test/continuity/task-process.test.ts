/**
 * LIM-149 TC-4.5d unit surface: Claude's task-output markers as the only
 * source of terminal outcomes, fail-closed liveness (an indeterminate probe
 * never advances state; disappearance is never an outcome), retained-host
 * settling that only ever signals an exact identity, the exit-record reader
 * and the task-process pin over the native addon (Linux, macOS, Windows).
 * Real-process cases use this test's own children with real signals — the
 * same process.kill(pid, signal) route node-pty's UnixTerminal.kill performs.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExactIdentityReader, createProcessControl } from "cc-lhc-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ContinuityStore, openContinuityStore, type RetainedHostRecord } from "../../src/continuity/store.js";
import {
  discoverAdoptedTaskProcess,
  parseTaskOutputMarker,
  readTaskExit,
  reconcileAdoptedShells,
  settleRetainedHost,
  terminateRetainedHostReal,
} from "../../src/continuity/task-process.js";

import { probeProcessIdentityNative } from "../../src/runtime/native-identity.js";
import type { ProcessLivenessResult } from "../../src/runtime/process-identity.js";
import { type ReapTarget, reapProcesses, trackForReap } from "./helpers.js";

const dirs: string[] = [];
const pids: ReapTarget[] = [];
afterEach(async () => {
  await reapProcesses(pids);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-lhc-taskproc-"));
  dirs.push(dir);
  return dir;
}

/** Spawn a real child of this process that opens `path` and holds it for ~20s. */
function spawnHolder(path: string): Promise<number> {
  const child = spawn(process.execPath, [
    "-e",
    `const fs=require("node:fs");const fd=fs.openSync(process.argv[1],"a");fs.writeSync(fd,"held\\n");setTimeout(()=>{},20_000);`,
    path,
  ]);
  trackForReap(pids, child.pid as number);
  return new Promise((resolve) => {
    const wait = (): void => {
      try {
        if (statSync(path).size > 0) resolve(child.pid as number);
        else setTimeout(wait, 20);
      } catch {
        setTimeout(wait, 20);
      }
    };
    wait();
  });
}

const T = "th_x";
const SHELL_ID = "background_shell:b1:toolu_b1";

function adoptedStore(
  dbPath: string,
  outputFile: string,
  opts: { taskProcess?: { pid: number; bootId: string; starttime: string }; host?: RetainedHostRecord } = {},
): ContinuityStore {
  const store = openContinuityStore(dbPath);
  store.recordLaunch({
    threadId: T,
    launchId: SHELL_ID,
    family: "background_shell",
    label: "background command (b1)",
    taskId: "b1",
    toolUseId: "toolu_b1",
    continuation: { outputFile, ...(opts.taskProcess === undefined ? {} : { taskProcess: opts.taskProcess }) },
    nowMs: 1,
  });
  const st = statSync(outputFile);
  store.setCarryMode({
    threadId: T,
    launchId: SHELL_ID,
    carryMode: "adopt",
    operations: ["output"],
    verifiedIdentity: { kind: "posix_output", path: outputFile, dev: String(st.dev), ino: String(st.ino) },
    nowMs: 2,
  });
  store.allocateGeneration({ threadId: T, oldSessionId: "old", launchIds: [SHELL_ID], nowMs: 3 });
  if (opts.host !== undefined) store.setRetainedHost({ threadId: T, generation: 1, host: opts.host, nowMs: 4 });
  return store;
}

const HOST: RetainedHostRecord = { pid: 4242, bootId: "boot-h", starttime: "st-h", retainedAtMs: 4 };
const gone: ProcessLivenessResult = { ok: false, code: "not_found", message: "no such process" };
const indeterminate: ProcessLivenessResult = { ok: false, code: "indeterminate", message: "procfs unreadable" };
const aliveAs = (proc: { pid: number; bootId: string; starttime: string }): ProcessLivenessResult => ({
  ok: true,
  identity: { pid: proc.pid, bootId: proc.bootId, starttime: proc.starttime },
});

describe("parseTaskOutputMarker", () => {
  it("preserves the real exit code and distinguishes claude's kill marker", () => {
    const dir = scratch();
    const f = (name: string, content: string): string => {
      const p = join(dir, name);
      writeFileSync(p, content);
      return p;
    };
    expect(parseTaskOutputMarker(f("ok.output", "DONE\n\n[exited with code 0]\n"))).toEqual({
      kind: "exited",
      code: 0,
    });
    expect(parseTaskOutputMarker(f("bad.output", "boom\n\n[exited with code 3]\n"))).toEqual({
      kind: "exited",
      code: 3,
    });
    expect(parseTaskOutputMarker(f("k.output", "partial\n[killed]\n"))).toEqual({ kind: "killed" });
    expect(parseTaskOutputMarker(f("run.output", "still running\n"))).toBeNull();
    expect(parseTaskOutputMarker(f("empty.output", ""))).toBeNull();
    expect(parseTaskOutputMarker(join(dir, "missing.output"))).toBeNull();
    // Marker text quoted mid-stream is not a trailing marker.
    expect(parseTaskOutputMarker(f("quoted.output", "[exited with code 0] mentioned\nmore output\n"))).toBeNull();
  });
});

describe("reconcileAdoptedShells", () => {
  it("claude's exit markers are the outcome: code 0 completed, nonzero failed, [killed] killed — once", () => {
    const dir = scratch();
    for (const [content, outcome, needle] of [
      ["x\n[exited with code 0]\n", "completed", "exited with code 0"],
      ["x\n[exited with code 3]\n", "failed", "exited with code 3"],
      ["x\n[killed]\n", "killed", "did not survive"],
    ] as const) {
      const out = join(dir, `${outcome}.output`);
      writeFileSync(out, content);
      const store = adoptedStore(join(dir, `${outcome}.sqlite`), out);
      const report = reconcileAdoptedShells(store, T);
      expect(report.reconciled).toHaveLength(1);
      expect(report.reconciled[0]).toMatchObject({ launchId: SHELL_ID, outcome });
      expect(report.reconciled[0]?.evidence).toContain(needle);
      expect(store.getItem(T, SHELL_ID)?.terminal?.outcome).toBe(outcome);
      // Idempotent: nothing new on a second pass.
      expect(reconcileAdoptedShells(store, T).reconciled).toEqual([]);
      store.close();
    }
  });

  it("no marker + live host: stays active untouched (still supervised)", () => {
    const dir = scratch();
    const out = join(dir, "t.output");
    writeFileSync(out, "running\n");
    const store = adoptedStore(join(dir, "db.sqlite"), out, { host: HOST });
    const report = reconcileAdoptedShells(store, T, { probeIdentity: () => aliveAs(HOST) });
    expect(report).toEqual({ reconciled: [], unsupervised: [] });
    expect(store.getItem(T, SHELL_ID)?.state).toBe("active");
    store.close();
  });

  it("FAIL CLOSED: an indeterminate probe never advances state — active stays active, no terminal, no unknown", () => {
    const dir = scratch();
    const out = join(dir, "t.output");
    writeFileSync(out, "running\n");
    const store = adoptedStore(join(dir, "db.sqlite"), out, { host: HOST });
    const report = reconcileAdoptedShells(store, T, { probeIdentity: () => indeterminate });
    expect(report).toEqual({ reconciled: [], unsupervised: [] });
    expect(store.getItem(T, SHELL_ID)?.state).toBe("active");
    store.close();
  });

  it("host gone with no marker is NOT an outcome: the item flips to unknown, never terminal, never completed", () => {
    const dir = scratch();
    const out = join(dir, "t.output");
    writeFileSync(out, "was running\n");
    const store = adoptedStore(join(dir, "db.sqlite"), out, { host: HOST });
    const report = reconcileAdoptedShells(store, T, { probeIdentity: () => gone });
    expect(report.reconciled).toEqual([]);
    expect(report.unsupervised).toEqual([SHELL_ID]);
    const item = store.getItem(T, SHELL_ID);
    expect(item?.state).toBe("unknown");
    expect(item?.terminal).toBeNull();
    expect(store.listPendingResults(T)).toEqual([]);
    store.close();
  });

  it("host gone but the discovered task process still lives: stays active (the work is real and running)", () => {
    const dir = scratch();
    const out = join(dir, "t.output");
    writeFileSync(out, "running\n");
    const task = { pid: 5151, bootId: "boot-t", starttime: "st-t" };
    const store = adoptedStore(join(dir, "db.sqlite"), out, { host: HOST, taskProcess: task });
    const probe = (pid: number): ProcessLivenessResult => (pid === task.pid ? aliveAs(task) : gone);
    const report = reconcileAdoptedShells(store, T, { probeIdentity: probe });
    expect(report).toEqual({ reconciled: [], unsupervised: [] });
    expect(store.getItem(T, SHELL_ID)?.state).toBe("active");
    // Both gone, still no marker: supervision is provably lost → unknown.
    const later = reconcileAdoptedShells(store, T, { probeIdentity: () => gone });
    expect(later.unsupervised).toEqual([SHELL_ID]);
    expect(store.getItem(T, SHELL_ID)?.state).toBe("unknown");
    store.close();
  });

  it("a pid reused by a stranger reads as gone (exact incarnation, never a bare pid)", () => {
    const dir = scratch();
    const out = join(dir, "t.output");
    writeFileSync(out, "was running\n");
    const store = adoptedStore(join(dir, "db.sqlite"), out, { host: HOST });
    const stranger: ProcessLivenessResult = {
      ok: true,
      identity: { pid: HOST.pid, bootId: HOST.bootId, starttime: "st-reused" },
    };
    const report = reconcileAdoptedShells(store, T, { probeIdentity: () => stranger });
    expect(report.unsupervised).toEqual([SHELL_ID]);
    expect(store.getItem(T, SHELL_ID)?.state).toBe("unknown");
    store.close();
  });
});

describe("settleRetainedHost", () => {
  function rig(probe: (pid: number) => ProcessLivenessResult, opts: { terminal?: boolean } = {}) {
    const dir = scratch();
    const out = join(dir, "t.output");
    writeFileSync(out, "x\n");
    const store = adoptedStore(join(dir, "db.sqlite"), out, { host: HOST });
    if (opts.terminal === true) {
      store.recordTerminal({ threadId: T, launchId: SHELL_ID, outcome: "completed", evidence: "marker", nowMs: 9 });
    }
    const terminate = vi.fn(async (_host: RetainedHostRecord) => true);
    return { store, terminate, probe };
  }

  it("keeps the host while any adopted item is open — no signal", async () => {
    const { store, terminate } = rig(() => aliveAs(HOST));
    const settle = await settleRetainedHost(store, T, { probeIdentity: () => aliveAs(HOST), terminateHost: terminate });
    expect(settle).toEqual({ kind: "kept", reason: "items_open" });
    expect(terminate).not.toHaveBeenCalled();
    expect(store.retainedHostGeneration(T)).not.toBeNull();
    store.close();
  });

  it("FAIL CLOSED: an indeterminate probe keeps everything — no signal, record kept", async () => {
    const { store, terminate } = rig(() => indeterminate, { terminal: true });
    const settle = await settleRetainedHost(store, T, { probeIdentity: () => indeterminate, terminateHost: terminate });
    expect(settle).toEqual({ kind: "kept", reason: "indeterminate" });
    expect(terminate).not.toHaveBeenCalled();
    expect(store.retainedHostGeneration(T)).not.toBeNull();
    store.close();
  });

  it("a reused pid is a stranger: record cleared, NEVER signalled", async () => {
    const stranger: ProcessLivenessResult = {
      ok: true,
      identity: { pid: HOST.pid, bootId: "boot-h", starttime: "st-other" },
    };
    const { store, terminate } = rig(() => stranger, { terminal: true });
    const settle = await settleRetainedHost(store, T, { probeIdentity: () => stranger, terminateHost: terminate });
    expect(settle).toEqual({ kind: "already_gone" });
    expect(terminate).not.toHaveBeenCalled();
    expect(store.retainedHostGeneration(T)).toBeNull();
    store.close();
  });

  it("all adopted items terminal + exact identity alive: terminates once and clears the record", async () => {
    const { store, terminate } = rig(() => aliveAs(HOST), { terminal: true });
    const settle = await settleRetainedHost(store, T, { probeIdentity: () => aliveAs(HOST), terminateHost: terminate });
    expect(settle).toEqual({ kind: "terminated" });
    expect(terminate).toHaveBeenCalledOnce();
    expect(terminate.mock.calls[0]?.[0]).toMatchObject({
      pid: HOST.pid,
      bootId: HOST.bootId,
      starttime: HOST.starttime,
    });
    expect(store.retainedHostGeneration(T)).toBeNull();
    store.close();
  });
});

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("terminateRetainedHostReal (real processes, real signals)", () => {
  posixOnly("terminates only the exact recorded incarnation — the pid-exact process.kill route", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20_000);"]);
    trackForReap(pids, child.pid as number);
    const pid = child.pid as number;
    const probed = probeProcessIdentityNative(pid);
    if (!probed.ok) throw new Error("probe failed");
    const host: RetainedHostRecord = {
      pid,
      bootId: probed.identity.bootId,
      starttime: probed.identity.starttime,
      retainedAtMs: 1,
    };
    expect(await terminateRetainedHostReal(host)).toBe(true);
    const after = probeProcessIdentityNative(pid);
    expect(after.ok && after.identity.starttime === host.starttime).toBe(false);
  });

  posixOnly(
    "a record whose identity no longer matches is treated as gone WITHOUT signalling the live stranger",
    async () => {
      const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20_000);"]);
      trackForReap(pids, child.pid as number);
      const pid = child.pid as number;
      const probed = probeProcessIdentityNative(pid);
      if (!probed.ok) throw new Error("probe failed");
      const staleRecord: RetainedHostRecord = {
        pid,
        bootId: probed.identity.bootId,
        starttime: "999999999",
        retainedAtMs: 1,
      };
      expect(await terminateRetainedHostReal(staleRecord)).toBe(true);
      // The real process at that pid was never signalled.
      const after = probeProcessIdentityNative(pid);
      expect(after.ok && after.identity.starttime === probed.identity.starttime).toBe(true);
    },
  );
});

/**
 * The suite-wide CC_LHC_IDENTITY_ADDON stub has no holder lookup or exit
 * reader; these cases go to the real compiled addon (the same bypass
 * test/runtime/native-identity.test.ts uses), so every native lane proves
 * its own platform path.
 */
const realControl = createProcessControl({ env: {} });
const realIdentity = createExactIdentityReader({ env: {} });
const realFind = (parent: number, path: string) => realControl.findChildHoldingFile(parent, path);

describe("discoverAdoptedTaskProcess (native addon, every platform)", () => {
  it("finds the real child holding the verified output file and records exact identity", async () => {
    const dir = scratch();
    const out = join(dir, "task.output");
    writeFileSync(out, "");
    const pid = await spawnHolder(out);
    const found = discoverAdoptedTaskProcess(process.pid, { path: out }, { findChildHoldingFile: realFind });
    expect(found?.pid).toBe(pid);
    const probed = probeProcessIdentityNative(pid);
    expect(probed.ok && probed.identity.starttime).toBe(found?.starttime);
  });

  it("returns null when no child holds the file", async () => {
    const dir = scratch();
    const other = join(dir, "other.output");
    writeFileSync(other, "x");
    expect(discoverAdoptedTaskProcess(process.pid, { path: other }, { findChildHoldingFile: realFind })).toBeNull();
    expect(
      discoverAdoptedTaskProcess(
        process.pid,
        { path: join(dir, "missing.output") },
        { findChildHoldingFile: realFind },
      ),
    ).toBeNull();
  });

  it("FAIL CLOSED: several holders, a lookup failure, or an unreadable identity all pin nothing", () => {
    const ambiguous = discoverAdoptedTaskProcess(
      1,
      { path: "/x" },
      { findChildHoldingFile: () => ({ ok: true, parentPid: 1, path: "/x", pid: null, matches: 2 }) },
    );
    expect(ambiguous).toBeNull();
    const failed = discoverAdoptedTaskProcess(
      1,
      { path: "/x" },
      { findChildHoldingFile: () => ({ ok: false, code: "native_error", message: "no" }) },
    );
    expect(failed).toBeNull();
    const unreadable = discoverAdoptedTaskProcess(
      1,
      { path: "/x" },
      {
        findChildHoldingFile: () => ({ ok: true, parentPid: 1, path: "/x", pid: 77, matches: 1 }),
        probeIdentity: () => indeterminate,
      },
    );
    expect(unreadable).toBeNull();
  });
});

describe("readTaskExit (paused-host exit record over the native addon)", () => {
  const proc = { pid: 77, starttime: "st" };
  it("maps the addon's exit record to a truthful outcome and fails closed on any failure", () => {
    expect(readTaskExit(proc, () => ({ ok: true, pid: 77, state: "exited", code: 3 }))).toEqual({
      kind: "exited",
      code: 3,
    });
    expect(readTaskExit(proc, () => ({ ok: true, pid: 77, state: "signaled", signal: 9 }))).toEqual({
      kind: "signaled",
      signal: 9,
    });
    expect(readTaskExit(proc, () => ({ ok: true, pid: 77, state: "running" }))).toEqual({ kind: "running" });
    for (const code of [
      "not_found",
      "identity_changed",
      "access_denied",
      "native_error",
      "addon_unavailable",
    ] as const) {
      expect(
        readTaskExit(proc, () => ({ ok: false, code, message: code })),
        code,
      ).toBeNull();
    }
  });

  it("reads a real finished task under a paused supervisor and releases it on resume", async () => {
    const dir = scratch();
    const out = join(dir, "task.output");
    writeFileSync(out, "");
    const supervisor = spawn(process.execPath, [
      "-e",
      `const {spawn}=require("node:child_process");const fs=require("node:fs");const fd=fs.openSync(process.argv[1],"a");` +
        `const g=spawn(process.execPath,["-e","setTimeout(()=>process.exit(3),500)"],{stdio:["ignore",fd,"ignore"]});` +
        `process.stdout.write(String(g.pid)+"\\n");setInterval(()=>{},1000);`,
      out,
    ]);
    trackForReap(pids, supervisor.pid as number);
    const grandchild = await new Promise<number>((resolve) => {
      supervisor.stdout.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim())));
    });
    const identity = realIdentity(grandchild);
    if (!identity.ok) throw new Error(identity.message);
    const read = (pid: number, starttime: string) => realControl.readChildExit(pid, starttime);
    expect(realControl.pause(supervisor.pid as number).ok).toBe(true);
    let outcome = readTaskExit({ pid: grandchild, starttime: identity.identity.starttime }, read);
    const start = Date.now();
    while (outcome?.kind === "running" && Date.now() - start < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      outcome = readTaskExit({ pid: grandchild, starttime: identity.identity.starttime }, read);
    }
    expect(outcome).toEqual({ kind: "exited", code: 3 });
    expect(readTaskExit({ pid: grandchild, starttime: "1" }, read)).toBeNull();
    expect(realControl.resume(supervisor.pid as number).ok).toBe(true);
  });
});
