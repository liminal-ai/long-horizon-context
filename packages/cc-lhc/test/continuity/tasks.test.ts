/**
 * LIM-146 AC-2.6 (TC-2.6a–d): the replacement session manages carried work
 * through `cc-lhc tasks` — the production CLI path bound to a real ready
 * descriptor, a real SQLite continuity record, real bounded artifacts, and a
 * real parent relaunch (the same `invokeCarryover` the handoff runs).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { qualifyActiveItems, statPathReal } from "../../src/continuity/adapters.js";
import { invokeCarryover, relaunchOutputPath } from "../../src/continuity/handoff.js";
import { stopItem } from "../../src/continuity/manage.js";
import { createContinuityObserver } from "../../src/continuity/observe.js";
import { snapshotContinuity } from "../../src/continuity/snapshot.js";
import { openContinuityStore } from "../../src/continuity/store.js";
import { executeTasks, parseTasksArgv, runTasksCli } from "../../src/continuity/tasks-cli.js";
import {
  createOpeningDescriptor,
  type DescriptorIo,
  defaultDescriptorIo,
  markReady,
  newDescriptorPath,
} from "../../src/runtime/descriptor.js";
import { LAUNCH_IDS, LAUNCHES, reapProcesses, toolResult, toolUse } from "./helpers.js";

const T = "th_tasks";
const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const dirs: string[] = [];
const pids: number[] = [];
afterEach(async () => {
  await reapProcesses(pids);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One session: adopted shell (real output file), relaunched Monitor (real detached process), and an agent with no parent operations. */
function session(monitorCommand: string) {
  const root = mkdtempSync(join(tmpdir(), "cc-lhc-tasks-"));
  dirs.push(root);
  const sessionDir = join(root, "projects", "-x", "session-old");
  const tasksDir = join(root, "tmp", "-x", "session-old", "tasks");
  mkdirSync(join(sessionDir, "subagents"), { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(sessionDir, "subagents", "agent-agent-1.jsonl"), "");
  const shellOutput = join(tasksDir, "shell-1.output");
  writeFileSync(shellOutput, "shell line 1\nshell line 2\n");
  const paths = { tasksDir, sessionDir };
  const rolloutPath = `${sessionDir}.jsonl`;
  const monitorLines = [
    toolUse("toolu_mon", "Monitor", { command: monitorCommand, description: "CI watch" }),
    toolResult("toolu_mon", { taskId: "mon-1", timeoutMs: 60_000, persistent: false }),
  ];
  writeFileSync(rolloutPath, `${monitorLines.map((l) => JSON.stringify(l)).join("\n")}\n`);

  const dbPath = join(root, "cc-lhc.sqlite");
  const store = openContinuityStore(dbPath);
  let now = 1_000;
  const observer = createContinuityObserver({ store, threadId: T, nowFn: () => (now += 1) });
  for (const line of [...LAUNCHES.agent.lines(paths), ...LAUNCHES.background_shell.lines(paths), ...monitorLines]) {
    observer.observeLine(line);
  }
  const context = { platform: process.platform, sourceRolloutPath: rolloutPath, statPath: statPathReal };
  const qualified = qualifyActiveItems(store, T, context, 2_000);
  expect(qualified.refused).toEqual([]);
  const snap = snapshotContinuity(store, { threadId: T, oldSessionId: "old", nowMs: 3_000 });
  if (!snap.ok) throw new Error(snap.reason);
  const monitorOutputDir = join(root, "continuity");
  const transfer = invokeCarryover(store, snap.snapshot, { monitorOutputDir, cwd: root, log: () => {} }, 4_000);
  const relaunched = transfer.results.find((r) => r.launchId === LAUNCH_IDS.monitor);
  if (relaunched?.kind === "relaunched") pids.push(relaunched.pid);
  store.close();

  // The wrapper's ready descriptor names the thread; the live session id matches it.
  const io: DescriptorIo = defaultDescriptorIo();
  const descPath = newDescriptorPath(root, io);
  const desc = createOpeningDescriptor(descPath, io);
  markReady(descPath, desc, {
    threadId: T,
    registryPath: join(root, "registry.sqlite"),
    sessionId: SESSION,
    rolloutPath,
  });
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION };
  const tasks = (argv: string[]) =>
    executeTasks(["tasks", ...argv], { env, descriptorPath: descPath, continuityDbPath: dbPath });
  return { root, dbPath, shellOutput, monitorOutputDir, descPath, env, tasks, transfer, relaunched };
}

function stdoutOf(result: ReturnType<typeof executeTasks>): string {
  if (!result.ok) throw new Error(result.reason);
  return result.stdout + (result.bytes === undefined ? "" : `\n${result.bytes.toString("utf8")}`);
}

describe("parseTasksArgv", () => {
  it("accepts the three operations and output ranges only", () => {
    expect(parseTasksArgv(["tasks", "status", "a:b:c"])).toEqual({
      ok: true,
      request: { op: "status", launchId: "a:b:c" },
    });
    expect(parseTasksArgv(["tasks", "output", "a", "--offset", "-100", "--max", "10"])).toEqual({
      ok: true,
      request: { op: "output", launchId: "a", offset: -100, maxBytes: 10 },
    });
    expect(parseTasksArgv(["tasks", "stop"]).ok).toBe(false);
    expect(parseTasksArgv(["tasks", "status", "a", "--max", "1"]).ok).toBe(false);
    expect(parseTasksArgv(["tasks", "restart", "a"]).ok).toBe(false);
    expect(parseTasksArgv(["tasks", "output", "a", "--max", "x"]).ok).toBe(false);
  });
});

describe("TC-2.6a inspect active work", () => {
  it("status names the same logical item and reports it active with its verified identity and live relaunched process", () => {
    const s = session("sleep 30");
    expect(s.relaunched?.kind).toBe("relaunched");
    const shell = s.tasks(["status", LAUNCH_IDS.background_shell]);
    expect(stdoutOf(shell)).toContain(`launch id: ${LAUNCH_IDS.background_shell}`);
    expect(stdoutOf(shell)).toMatch(
      /state: active\ncarry mode: adopt\n.*\noperations: (status, )?output\nidentity: verified\nprocess: none/,
    );
    const monitor = s.tasks(["status", LAUNCH_IDS.monitor]);
    expect(stdoutOf(monitor)).toMatch(/family: monitor\n.*\nstate: active\ncarry mode: reconstruct\n/);
    expect(stdoutOf(monitor)).toContain("operations: status, output, stop");
    expect(stdoutOf(monitor)).toContain("process: live");
    const agent = s.tasks(["status", LAUNCH_IDS.agent]);
    expect(stdoutOf(agent)).toMatch(
      /family: agent\n.*\nstate: active\ncarry mode: reconstruct\n.*\noperations: none\nidentity: verified\nprocess: none/,
    );
    expect(s.tasks(["status", "agent:nobody:toolu_x"])).toMatchObject({
      ok: false,
      exitCode: 4,
      reason: expect.stringContaining("unknown_item"),
    });
  });
});

describe("TC-2.6b read output", () => {
  it("returns a bounded range of the item's own verified output file — adopted shell and relaunched Monitor — never via a child handle", async () => {
    const s = session("printf 'mon-out-%s' ABC");
    const all = s.tasks(["output", LAUNCH_IDS.background_shell]);
    expect(all.ok && all.bytes?.toString("utf8")).toBe("shell line 1\nshell line 2\n");
    expect(all.ok && all.stdout).toContain("bytes 0..26 of 26 (end)");
    const sliced = s.tasks(["output", LAUNCH_IDS.background_shell, "--offset", "6", "--max", "6"]);
    expect(sliced.ok && sliced.bytes?.toString("utf8")).toBe("line 1");
    expect(sliced.ok && sliced.stdout).toContain(
      `next: cc-lhc tasks output ${LAUNCH_IDS.background_shell} --offset 12`,
    );
    const tail = s.tasks(["output", LAUNCH_IDS.background_shell, "--offset", "-7"]);
    expect(tail.ok && tail.bytes?.toString("utf8")).toBe("line 2\n");
    expect(s.tasks(["output", LAUNCH_IDS.background_shell, "--max", "0"])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("range_invalid"),
    });

    const monitorPath = relaunchOutputPath(s.monitorOutputDir, LAUNCH_IDS.monitor, 1);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (!existsSync(monitorPath) || readFileSync(monitorPath, "utf8") !== "mon-out-ABC")) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const monitor = s.tasks(["output", LAUNCH_IDS.monitor]);
    expect(monitor.ok && monitor.bytes?.toString("utf8")).toBe("mon-out-ABC");
    // An item with no parent-readable artifact refuses as unsupported; nothing is read.
    expect(s.tasks(["output", LAUNCH_IDS.agent])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("unsupported"),
    });

    // The real CLI stream path prints header then bytes.
    let out = "";
    const stdout = new Writable({
      write: (chunk, _e, cb) => {
        out += chunk.toString();
        cb();
      },
    });
    const code = await runTasksCli(
      ["tasks", "output", LAUNCH_IDS.background_shell, "--max", "12"],
      { stdout, stderr: stdout },
      { env: s.env, descriptorPath: s.descPath, continuityDbPath: s.dbPath },
    );
    expect(code).toBe(0);
    expect(out).toBe(
      `output ${LAUNCH_IDS.background_shell}: bytes 0..12 of 26 · next: cc-lhc tasks output ${LAUNCH_IDS.background_shell} --offset 12\nshell line 1\n`,
    );
  });
});

describe("TC-2.6c stop carried work", () => {
  it("stops only the exact re-verified relaunched process and records the item stopped; the shell (no stop mechanism) is refused", async () => {
    const s = session("sleep 30");
    if (s.relaunched?.kind !== "relaunched") throw new Error("no relaunch");
    const pid = s.relaunched.pid;
    expect(s.tasks(["stop", LAUNCH_IDS.background_shell])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("unsupported"),
    });
    expect(s.tasks(["stop", LAUNCH_IDS.agent])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("unsupported"),
    });
    const stopped = s.tasks(["stop", LAUNCH_IDS.monitor]);
    expect(stopped.ok && stopped.stdout).toBe(`stopped ${LAUNCH_IDS.monitor} (pid ${pid}); recorded as stopped`);
    const deadline = Date.now() + 5_000;
    let gone = false;
    while (Date.now() < deadline && !gone) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 25));
      } catch {
        gone = true;
      }
    }
    expect(gone).toBe(true);
    const status = stdoutOf(s.tasks(["status", LAUNCH_IDS.monitor]));
    expect(status).toContain("state: terminal");
    expect(status).toContain("terminal: stopped (stopped by the replacement session (cc-lhc tasks stop, pid");
    // Terminal now: a second stop signals nothing.
    expect(s.tasks(["stop", LAUNCH_IDS.monitor])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not_active"),
    });
    // Other items untouched.
    expect(stdoutOf(s.tasks(["status", LAUNCH_IDS.background_shell]))).toContain("state: active");
  });
});

describe("TC-2.6d stale identity", () => {
  it("a replaced output file refuses output as identity_changed; a removed one as identity_missing; neither is read", () => {
    const s = session("sleep 30");
    renameSync(s.shellOutput, `${s.shellOutput}.held`);
    writeFileSync(s.shellOutput, "UNRELATED WORK\n");
    const changed = s.tasks(["output", LAUNCH_IDS.background_shell]);
    expect(changed).toMatchObject({ ok: false, exitCode: 4, reason: expect.stringContaining("identity_changed") });
    expect((changed as { bytes?: Buffer }).bytes).toBeUndefined();
    expect(stdoutOf(s.tasks(["status", LAUNCH_IDS.background_shell]))).toContain("identity: changed");
    rmSync(s.shellOutput);
    expect(s.tasks(["output", LAUNCH_IDS.background_shell])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("identity_missing"),
    });
    expect(stdoutOf(s.tasks(["status", LAUNCH_IDS.background_shell]))).toContain("identity: missing");
  });

  it("a pid that now names a different process, or none, refuses stop without signalling", () => {
    const s = session("sleep 30");
    if (s.relaunched?.kind !== "relaunched") throw new Error("no relaunch");
    const store = openContinuityStore(s.dbPath);
    const recorded = store.getItem(T, LAUNCH_IDS.monitor)?.relaunch?.process;
    if (!recorded) throw new Error("no process identity recorded");
    const signals: number[] = [];
    const ports = {
      signal: (pid: number) => {
        signals.push(pid);
        return { ok: true as const };
      },
    };
    // Same pid, different incarnation.
    const reused = stopItem(store, T, LAUNCH_IDS.monitor, {
      ...ports,
      probeIdentity: () => ({
        ok: true,
        identity: { pid: recorded.pid, bootId: recorded.bootId, starttime: `${recorded.starttime}9` },
      }),
    });
    expect(reused).toMatchObject({ ok: false, reason: "process_identity_changed" });
    // Exited.
    const exited = stopItem(store, T, LAUNCH_IDS.monitor, {
      ...ports,
      probeIdentity: () => ({ ok: false, code: "not_found", message: "gone" }),
    });
    expect(exited).toMatchObject({ ok: false, reason: "process_not_live" });
    // Indeterminate.
    const unknown = stopItem(store, T, LAUNCH_IDS.monitor, {
      ...ports,
      probeIdentity: () => ({ ok: false, code: "indeterminate", message: "?" }),
    });
    expect(unknown).toMatchObject({ ok: false, reason: "identity_unverifiable" });
    expect(signals).toEqual([]);
    expect(store.getItem(T, LAUNCH_IDS.monitor)).toMatchObject({ state: "active" });
    store.close();
  });

  it("a foreign thread's item and an unbound or mismatched session are refused before any lookup", () => {
    const s = session("sleep 30");
    // Another wrapper's descriptor names another thread: the same launch id is unknown there.
    const io = defaultDescriptorIo();
    const otherPath = newDescriptorPath(s.root, io);
    markReady(otherPath, createOpeningDescriptor(otherPath, io), {
      threadId: "th_other",
      registryPath: join(s.root, "registry.sqlite"),
      sessionId: SESSION,
      rolloutPath: join(s.root, "other.jsonl"),
    });
    expect(
      executeTasks(["tasks", "status", LAUNCH_IDS.monitor], {
        env: s.env,
        descriptorPath: otherPath,
        continuityDbPath: s.dbPath,
      }),
    ).toMatchObject({
      ok: false,
      exitCode: 4,
      reason: expect.stringContaining("unknown_item"),
    });
    expect(
      executeTasks(["tasks", "status", LAUNCH_IDS.monitor], {
        env: { ...s.env, CLAUDE_CODE_SESSION_ID: "ffffffff-0000-0000-0000-000000000000" },
        descriptorPath: s.descPath,
        continuityDbPath: s.dbPath,
      }),
    ).toMatchObject({
      ok: false,
      exitCode: 3,
      reason: expect.stringContaining("session mismatch"),
    });
    expect(
      executeTasks(["tasks", "status", LAUNCH_IDS.monitor], {
        env: { ...s.env, CC_LHC_RUNTIME_DESCRIPTOR: "" },
        continuityDbPath: s.dbPath,
      }),
    ).toMatchObject({ ok: false, exitCode: 3 });
  });
});
