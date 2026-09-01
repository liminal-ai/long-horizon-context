/**
 * LIM-145 AC-2.2 shared adapter contract: every family, on every supported
 * platform identity shape from Story 0, through the real fold, the real
 * SQLite store, and the real adapters over real files. Proves carry mode,
 * stable logical identity, only currently supported operations, and
 * fail-before-claim when verification fails.
 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AdapterContext,
  FAMILY_ADAPTERS,
  qualifyActiveItems,
  resolveMonitorLaunch,
  sessionDirOfRollout,
} from "../../src/continuity/adapters.js";
import { createContinuityObserver } from "../../src/continuity/observe.js";
import { resolveRelaunchShell } from "../../src/continuity/relaunch-shell.js";
import { closeContinuitySnapshot, snapshotContinuity } from "../../src/continuity/snapshot.js";
import { type ContinuityItem, openContinuityStore, relaunchKey } from "../../src/continuity/store.js";
import type { AsyncWorkFamily } from "../../src/observation/async-work.js";
import {
  allLaunchLines,
  LAUNCH_IDS,
  LAUNCHES,
  type LaunchPaths,
  monitorEvent,
  notification,
  tempDbPath,
  toolResult,
  toolUse,
} from "./helpers.js";

const T = "th_adapters";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A disposable host layout in the 2.1.252 shape: rollout, session dir, tasks dir. */
function hostLayout(): LaunchPaths & { rolloutPath: string } {
  const root = mkdtempSync(join(tmpdir(), "cc-lhc-adapters-"));
  dirs.push(root);
  const sessionDir = join(root, "projects", "-x", "session-old");
  const tasksDir = join(root, "tmp", "-x", "session-old", "tasks");
  mkdirSync(join(sessionDir, "subagents", "workflows", "wf_run-1"), { recursive: true });
  mkdirSync(join(sessionDir, "workflows", "scripts"), { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(sessionDir, "subagents", "agent-agent-1.jsonl"), '{"type":"user"}\n');
  writeFileSync(join(sessionDir, "subagents", "workflows", "wf_run-1", "journal.jsonl"), '{"kind":"started"}\n');
  writeFileSync(join(sessionDir, "workflows", "scripts", "deploy-wf_run-1.js"), "export const meta = {}\n");
  writeFileSync(join(tasksDir, "shell-1.output"), "line\n");
  writeFileSync(join(tasksDir, "mon-1.output"), "tick\n");
  writeFileSync(join(tasksDir, "agent-1.output"), "");
  // The old session's rollout: the Monitor launch record the relaunch resolves from.
  const rolloutPath = `${sessionDir}.jsonl`;
  writeFileSync(
    rolloutPath,
    `${LAUNCHES.monitor
      .lines()
      .map((line) => JSON.stringify(line))
      .join("\n")}\n`,
  );
  return { sessionDir, tasksDir, rolloutPath };
}

function rig(paths: LaunchPaths & { rolloutPath: string }, platform: NodeJS.Platform) {
  const store = openContinuityStore(tempDbPath());
  let now = 1_000;
  const observer = createContinuityObserver({ store, threadId: T, nowFn: () => (now += 1) });
  for (const line of [...allLaunchLines(paths), monitorEvent(paths)]) observer.observeLine(line);
  const context: AdapterContext = { platform, sourceRolloutPath: paths.rolloutPath };
  const qualify = () => {
    now += 100;
    return qualifyActiveItems(store, T, context, now);
  };
  const snapshot = () => {
    now += 100;
    return snapshotContinuity(store, { threadId: T, oldSessionId: "old", nowMs: now });
  };
  const item = (family: AsyncWorkFamily): ContinuityItem => store.getItem(T, LAUNCH_IDS[family])!;
  return { store, observer, context, qualify, snapshot, item };
}

const POSIX: NodeJS.Platform[] = ["linux", "darwin"];
const QUALIFIABLE: AsyncWorkFamily[] = ["agent", "workflow", "background_shell", "monitor", "scheduled_wakeup"];
const MONITOR_COMMAND = "tail -f /tmp/x.log";

/**
 * The contract every family/platform pair must meet, from Story 0's
 * disposition matrix: a qualified result names a real continuation mechanism,
 * never only an identity artifact; a family without one is refused with the
 * exact accepted-contract impossibility.
 */
const CONTRACT: Record<
  AsyncWorkFamily,
  { mode: string; operations: string[]; identityKind: string; mechanism: string; win32: string | "same" }
> = {
  background_shell: {
    mode: "adopt",
    operations: ["output"],
    identityKind: "posix_output",
    mechanism: "parent_output_read",
    win32: "windows_shell_identity_not_exposed",
  },
  agent: {
    mode: "reconstruct",
    operations: [],
    identityKind: "agent_transcript",
    mechanism: "send_message",
    win32: "same",
  },
  workflow: {
    mode: "reconstruct",
    operations: [],
    identityKind: "workflow_run",
    mechanism: "workflow_resume",
    win32: "same",
  },
  monitor: {
    mode: "reconstruct",
    operations: [],
    identityKind: "monitor_launch",
    mechanism: "monitor_relaunch",
    win32: "same",
  },
  scheduled_wakeup: {
    mode: "rearm",
    operations: [],
    identityKind: "scheduled_time",
    mechanism: "rearm_at",
    win32: "same",
  },
};

/** Every mechanism kind a qualified result may name. */
const MECHANISMS = ["parent_output_read", "send_message", "workflow_resume", "rearm_at", "monitor_relaunch"];

describe("TC-2.2a shared adapter contract across families and platforms", () => {
  for (const platform of POSIX) {
    it(`${platform}: every qualifiable family names its mechanism, verified identity, and only supported operations`, () => {
      const { store, qualify, item } = rig(hostLayout(), platform);
      const outcome = qualify();
      expect(outcome.refused).toEqual([]);
      expect(outcome.terminalized).toEqual([]);
      expect(outcome.qualified.map((q) => [q.family, q.carryMode, q.continuation.kind]).sort()).toEqual(
        QUALIFIABLE.map((family) => [family, CONTRACT[family].mode, CONTRACT[family].mechanism]).sort(),
      );
      for (const q of outcome.qualified) expect(MECHANISMS, q.family).toContain(q.continuation.kind);
      for (const family of QUALIFIABLE) {
        const row = item(family);
        expect(row.state, family).toBe("active");
        expect(row.carryMode, family).toBe(CONTRACT[family].mode);
        expect([...row.operations], family).toEqual(CONTRACT[family].operations);
        expect(row.verifiedIdentity?.kind, family).toBe(CONTRACT[family].identityKind);
        expect(row.operations).not.toContain("stop");
        expect(row.operations).not.toContain("status");
      }
      // Mechanism parameters are the verified facts, not derived values.
      const shellIdentity = item("background_shell").verifiedIdentity as { path: string };
      expect(outcome.qualified.find((q) => q.family === "background_shell")?.continuation).toEqual({
        kind: "parent_output_read",
        path: shellIdentity.path,
      });
      expect(outcome.qualified.find((q) => q.family === "agent")?.continuation).toEqual({
        kind: "send_message",
        agentId: "agent-1",
      });
      expect(outcome.qualified.find((q) => q.family === "workflow")?.continuation).toEqual({
        kind: "workflow_resume",
        resumeFromRunId: "wf_run-1",
        scriptPath: expect.stringMatching(/deploy-wf_run-1\.js$/),
      });
      expect(outcome.qualified.find((q) => q.family === "scheduled_wakeup")?.continuation).toEqual({
        kind: "rearm_at",
        scheduledForMs: LAUNCHES.scheduled_wakeup.scheduledForMs,
      });
      // Identity facts are the host's own paths, verified, never derived from the command body.
      expect(item("background_shell").verifiedIdentity).toMatchObject({
        path: expect.stringMatching(/shell-1\.output$/),
        dev: expect.any(String),
        ino: expect.not.stringMatching(/^0$/),
      });
      expect(item("agent").verifiedIdentity).toMatchObject({
        agentId: "agent-1",
        path: expect.stringMatching(/subagents\/agent-agent-1\.jsonl$/),
      });
      expect(item("workflow").verifiedIdentity).toMatchObject({
        runId: "wf_run-1",
        journalPath: expect.stringMatching(/wf_run-1\/journal\.jsonl$/),
      });
      expect(item("scheduled_wakeup").verifiedIdentity).toEqual({
        kind: "scheduled_time",
        toolUseId: "toolu_wake",
        scheduledForMs: LAUNCHES.scheduled_wakeup.scheduledForMs,
      });
      expect(JSON.stringify(store.listItems(T))).not.toMatch(/SECRET|Authorization/);
      store.close();
    });

    it(`${platform}: the manifest carries all five families once each, the Monitor as a restart`, () => {
      const { store, qualify, snapshot } = rig(hostLayout(), platform);
      qualify();
      const result = snapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.snapshot.items.map((i) => [i.launchId, i.carryMode, [...i.operations], i.transition])).toEqual([
        [LAUNCH_IDS.agent, "reconstruct", [], "resumed"],
        [LAUNCH_IDS.workflow, "reconstruct", [], "resumed"],
        [LAUNCH_IDS.background_shell, "adopt", ["output"], "adopted"],
        [LAUNCH_IDS.monitor, "reconstruct", [], "restarted"],
        [LAUNCH_IDS.scheduled_wakeup, "rearm", [], "rearmed"],
      ]);
      store.close();
    });
  }

  it("monitor: qualifies only by resolving its exact launch from the rollout binding, keeping the reference and never the command", () => {
    for (const platform of ["linux", "darwin", "win32"] as NodeJS.Platform[]) {
      const paths = hostLayout();
      const { store, item, context, qualify, snapshot } = rig(paths, platform);
      const row = item("monitor");
      expect(FAMILY_ADAPTERS.monitor.qualify(row, context)).toEqual({
        ok: true,
        carryMode: "reconstruct",
        operations: [],
        verifiedIdentity: { kind: "monitor_launch", toolUseId: "toolu_mon", rolloutPath: paths.rolloutPath },
        continuation: { kind: "monitor_relaunch", toolUseId: "toolu_mon", rolloutPath: paths.rolloutPath },
      });
      const outcome = qualify();
      if (platform === "win32") {
        // This host has no Git Bash where Claude Code would look for it, so
        // the seam closes the Monitor truthfully instead of promising a restart.
        expect(outcome.terminalized).toEqual([
          {
            launchId: LAUNCH_IDS.monitor,
            family: "monitor",
            outcome: "failed",
            reason: "relaunch_shell_unavailable",
          },
        ]);
        expect(JSON.stringify([store.listItems(T), outcome])).not.toContain(MONITOR_COMMAND);
        store.close();
        continue;
      }
      expect(outcome.qualified.find((q) => q.family === "monitor")?.continuation.kind).toBe("monitor_relaunch");
      const result = snapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const carried = result.snapshot.items.find((i) => i.family === "monitor");
      expect(carried).toMatchObject({ launchId: LAUNCH_IDS.monitor, transition: "restarted" });
      // The raw command lives only in the rollout: not in the store, the outcome, the manifest, or the launch id.
      for (const surface of [store.listItems(T), outcome, result.snapshot, carried?.launchId]) {
        expect(JSON.stringify(surface)).not.toContain(MONITOR_COMMAND);
        expect(JSON.stringify(surface)).not.toMatch(/tail -f|x\.log/);
      }
      // At invocation time the exact specification resolves again from the reference alone.
      const relaunch = carried?.continuation;
      expect(relaunch?.kind).toBe("monitor_relaunch");
      if (relaunch?.kind !== "monitor_relaunch") return;
      expect(resolveMonitorLaunch(relaunch.rolloutPath, relaunch.toolUseId)).toEqual({
        ok: true,
        spec: { command: MONITOR_COMMAND, input: { command: MONITOR_COMMAND, description: "CI watch" } },
      });
      // One relaunch per carried item per handoff generation: the fence is the generation itself.
      expect(relaunchKey(carried?.launchId ?? "", result.snapshot.generation)).toBe(`${LAUNCH_IDS.monitor}#1`);
      store.close();
    }
  });

  it("win32: a Monitor qualifies through Git Bash exactly where Claude Code resolves it (native-shell seam)", () => {
    const paths = hostLayout();
    const { store, item, snapshot } = rig(paths, "win32");
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const context: AdapterContext = {
      platform: "win32",
      sourceRolloutPath: paths.rolloutPath,
      relaunchShell: resolveRelaunchShell("win32", { PATH: "" }, (p) => p === gitBash),
    };
    const outcome = qualifyActiveItems(store, T, context, 5_000);
    expect(outcome.terminalized).toEqual([]);
    expect(outcome.qualified.find((q) => q.family === "monitor")).toMatchObject({
      carryMode: "reconstruct",
      continuation: { kind: "monitor_relaunch", toolUseId: "toolu_mon", rolloutPath: paths.rolloutPath },
    });
    expect(item("monitor")).toMatchObject({
      carryMode: "reconstruct",
      state: "active",
      verifiedIdentity: { kind: "monitor_launch", toolUseId: "toolu_mon", rolloutPath: paths.rolloutPath },
    });
    // The Windows shell refusal is unchanged and still owns the snapshot outcome there.
    expect(snapshot()).toEqual({ ok: false, reason: "unqualified_items", launchIds: [LAUNCH_IDS.background_shell] });
    expect(JSON.stringify([store.listItems(T), outcome])).not.toContain(MONITOR_COMMAND);
    store.close();
  });

  it("monitor: resolution needs both the rollout binding and the launching tool-use id", () => {
    expect(resolveMonitorLaunch(undefined, "toolu_mon")).toEqual({ ok: false, reason: "no_rollout_binding" });
    expect(resolveMonitorLaunch("/nonexistent/s.jsonl", null)).toEqual({ ok: false, reason: "no_rollout_binding" });
    expect(resolveMonitorLaunch("/nonexistent/s.jsonl", "toolu_mon")).toEqual({
      ok: false,
      reason: "rollout_unreadable",
    });
  });

  it("monitor: an unresolvable launch is closed with one truthful failed outcome and Compact continues without it", () => {
    type Layout = ReturnType<typeof hostLayout>;
    const cases: Array<{ name: string; prepare: (paths: Layout) => Partial<AdapterContext>; reason: string }> = [
      {
        name: "rollout unreadable",
        prepare: (p) => {
          rmSync(p.rolloutPath);
          return {};
        },
        reason: "rollout_unreadable",
      },
      {
        name: "launch not in rollout",
        prepare: (p) => {
          writeFileSync(p.rolloutPath, "");
          return {};
        },
        reason: "launch_not_found",
      },
      {
        name: "launch recorded twice",
        prepare: (p) => {
          const once = readFileSync(p.rolloutPath, "utf8");
          writeFileSync(p.rolloutPath, `${once}${once}`);
          return {};
        },
        reason: "launch_ambiguous",
      },
      {
        name: "launch has no command",
        prepare: (p) => {
          writeFileSync(p.rolloutPath, `${JSON.stringify(toolUse("toolu_mon", "Monitor", { description: "x" }))}\n`);
          return {};
        },
        reason: "launch_incomplete",
      },
      {
        name: "tool-use id belongs to another tool",
        prepare: (p) => {
          writeFileSync(
            p.rolloutPath,
            `${JSON.stringify(toolUse("toolu_mon", "Bash", { command: MONITOR_COMMAND }))}\n`,
          );
          return {};
        },
        reason: "launch_incomplete",
      },
    ];
    for (const c of cases) {
      const paths = hostLayout();
      const override = c.prepare(paths);
      const { store, item, snapshot } = rig(paths, "linux");
      const context: AdapterContext = { platform: "linux", sourceRolloutPath: paths.rolloutPath, ...override };
      const outcome = qualifyActiveItems(store, T, context, 5_000);
      expect(outcome.terminalized, c.name).toEqual([
        { launchId: LAUNCH_IDS.monitor, family: "monitor", outcome: "failed", reason: c.reason },
      ]);
      expect(outcome.refused, c.name).toEqual([]);
      const row = item("monitor");
      expect(row.state, c.name).toBe("terminal");
      expect(row.terminal, c.name).toMatchObject({
        outcome: "failed",
        evidence: `monitor relaunch unavailable: ${c.reason}`,
      });
      expect(JSON.stringify(row), c.name).not.toContain(MONITOR_COMMAND);
      // Never blocks the seam: the rest carry, the Monitor is left behind as terminal.
      const result = snapshot();
      expect(result.ok, c.name).toBe(true);
      expect(result.ok && result.snapshot.items.map((i) => i.family), c.name).toEqual([
        "agent",
        "workflow",
        "background_shell",
        "scheduled_wakeup",
      ]);
      // Closed once: a second pass touches nothing.
      expect(qualifyActiveItems(store, T, context, 6_000).terminalized, c.name).toEqual([]);
      expect(item("monitor").terminal?.observedAtMs, c.name).toBe(5_000);
      store.close();
    }
  });

  it("win32: the normal-path shell record exposes no manifest identity, so shells stay unqualified with that exact mismatch", () => {
    const { store, qualify, snapshot, item } = rig(hostLayout(), "win32");
    const outcome = qualify();
    expect(outcome.refused.map((r) => [r.family, r.reason])).toEqual([
      ["background_shell", "windows_shell_identity_not_exposed"],
    ]);
    expect(outcome.qualified.map((q) => q.family).sort()).toEqual(["agent", "scheduled_wakeup", "workflow"]);
    expect(outcome.terminalized.map((t) => [t.family, t.reason])).toEqual([["monitor", "relaunch_shell_unavailable"]]);
    // No Node dev/ino substitution: nothing was verified, nothing claimed.
    expect(item("background_shell")).toMatchObject({
      carryMode: "unqualified",
      verifiedIdentity: null,
      state: "active",
    });
    expect(snapshot()).toEqual({ ok: false, reason: "unqualified_items", launchIds: [LAUNCH_IDS.background_shell] });
    store.close();
  });

  it("the shell record cc-lhc reads carries no pid: nothing here could consume a manifest identity", () => {
    const { store, item } = rig(hostLayout(), "linux");
    const row = item("background_shell");
    expect(Object.keys(row.continuation ?? {})).toEqual(["outputFile"]);
    expect(JSON.stringify(row)).not.toMatch(/"pid"|bootId|starttime|creation/);
    store.close();
  });

  it("qualification is stable: a second pass records the same logical identity and the same manifest", () => {
    const { store, qualify, snapshot, item } = rig(hostLayout(), "linux");
    qualify();
    const first = QUALIFIABLE.map((family) => ({ ...item(family), updatedAtMs: 0 }));
    const second = qualify();
    expect(second.refused).toEqual([]);
    const again = QUALIFIABLE.map((family) => ({ ...item(family), updatedAtMs: 0 }));
    expect(again).toEqual(first);
    const a = snapshot();
    const b = snapshot();
    expect(a.ok && b.ok && a.snapshot.items).toEqual(b.ok && b.snapshot.items);
    store.close();
  });

  it("each adapter is pure: qualify() never writes to the store", () => {
    const paths = hostLayout();
    const { store, context, item } = rig(paths, "linux");
    for (const family of Object.keys(CONTRACT) as AsyncWorkFamily[]) {
      const before = item(family);
      const result = FAMILY_ADAPTERS[family].qualify(before, context);
      expect(result.ok, family).toBe(true);
      expect(item(family)).toEqual(before);
    }
    store.close();
  });
});

describe("TC-2.5d verification failure leaves the item unqualified and the snapshot refuses", () => {
  const cases: Array<{ family: AsyncWorkFamily; break: (p: LaunchPaths) => void; reason: string }> = [
    {
      family: "background_shell",
      break: (p) => rmSync(join(p.tasksDir, "shell-1.output")),
      reason: "output_file_missing",
    },
    {
      family: "agent",
      break: (p) => rmSync(join(p.sessionDir, "subagents", "agent-agent-1.jsonl")),
      reason: "transcript_missing",
    },
    {
      family: "workflow",
      break: (p) => rmSync(join(p.sessionDir, "workflows", "scripts", "deploy-wf_run-1.js")),
      reason: "script_missing",
    },
    {
      family: "workflow",
      break: (p) => rmSync(join(p.sessionDir, "subagents", "workflows", "wf_run-1", "journal.jsonl")),
      reason: "journal_missing",
    },
  ];
  for (const c of cases) {
    it(`${c.family}: ${c.reason}`, () => {
      const paths = hostLayout();
      c.break(paths);
      const { store, qualify, snapshot, item } = rig(paths, "linux");
      const outcome = qualify();
      expect(outcome.refused).toEqual([{ launchId: LAUNCH_IDS[c.family], family: c.family, reason: c.reason }]);
      expect(item(c.family)).toMatchObject({ carryMode: "unqualified", verifiedIdentity: null, operations: [] });
      expect(snapshot()).toEqual({ ok: false, reason: "unqualified_items", launchIds: [LAUNCH_IDS[c.family]] });
      expect(store.latestGeneration(T)).toBeNull();
      store.close();
    });
  }

  it("a launch that named no continuation facts cannot qualify", () => {
    const store = openContinuityStore(tempDbPath());
    const observer = createContinuityObserver({ store, threadId: T, nowFn: () => 1 });
    observer.observeLine(toolUse("toolu_sh2", "Bash", { command: "true", run_in_background: true }));
    observer.observeLine(toolResult("toolu_sh2", { stdout: "", backgroundTaskId: "shell-2" }));
    observer.observeLine(toolUse("toolu_wf2", "Workflow", { scriptPath: "/x.js" }));
    observer.observeLine(
      toolResult("toolu_wf2", { status: "async_launched", taskType: "local_workflow", taskId: "wf-2" }),
    );
    const outcome = qualifyActiveItems(store, T, { platform: "linux", sourceRolloutPath: "/nonexistent/s.jsonl" }, 5);
    expect(outcome.refused.map((r) => r.reason).sort()).toEqual(["no_continuation_facts", "workflow_run_incomplete"]);
    expect(outcome.qualified).toEqual([]);
    store.close();
  });

  it("an agent cannot qualify without the old session's rollout binding", () => {
    const paths = hostLayout();
    const { store, item } = rig(paths, "linux");
    const outcome = qualifyActiveItems(store, T, { platform: "linux", sourceRolloutPath: undefined }, 5);
    expect(outcome.refused.find((r) => r.family === "agent")?.reason).toBe("no_session_binding");
    expect(item("agent").carryMode).toBe("unqualified");
    expect(sessionDirOfRollout("/p/-x/s.jsonl")).toBe("/p/-x/s");
    expect(sessionDirOfRollout("/p/-x/s")).toBeUndefined();
    store.close();
  });

  it("a wakeup with no valid scheduled time cannot be re-armed", () => {
    const store = openContinuityStore(tempDbPath());
    const observer = createContinuityObserver({ store, threadId: T, nowFn: () => 1 });
    observer.observeLine(toolUse("toolu_w0", "ScheduleWakeup", { delaySeconds: 1 }));
    observer.observeLine(toolResult("toolu_w0", { scheduledFor: 5, clampedDelaySeconds: 1, wasClamped: false }));
    store.recordLaunch({
      threadId: T,
      launchId: "scheduled_wakeup:x:",
      family: "scheduled_wakeup",
      label: "scheduled wakeup",
      nowMs: 2,
    });
    const outcome = qualifyActiveItems(store, T, { platform: "linux", sourceRolloutPath: undefined }, 5);
    expect(outcome.qualified.map((q) => [q.launchId, q.continuation])).toEqual([
      ["scheduled_wakeup:scheduled_wakeup:toolu_w0", { kind: "rearm_at", scheduledForMs: 5 }],
    ]);
    expect(outcome.refused).toEqual([
      { launchId: "scheduled_wakeup:x:", family: "scheduled_wakeup", reason: "scheduled_time_invalid" },
    ]);
    store.close();
  });
});

describe("durable continuation data survives snapshot and closure (what the next pass invokes)", () => {
  /** Per family: the exact verified identity and mechanism the manifest must carry, from the host layout. */
  const expectedFor = (paths: ReturnType<typeof hostLayout>) => ({
    background_shell: {
      verifiedIdentity: {
        kind: "posix_output",
        path: join(paths.tasksDir, "shell-1.output"),
        dev: expect.any(String),
        ino: expect.any(String),
      },
      continuation: { kind: "parent_output_read", path: join(paths.tasksDir, "shell-1.output") },
    },
    agent: {
      verifiedIdentity: {
        kind: "agent_transcript",
        agentId: "agent-1",
        path: join(paths.sessionDir, "subagents", "agent-agent-1.jsonl"),
      },
      continuation: { kind: "send_message", agentId: "agent-1" },
    },
    workflow: {
      verifiedIdentity: {
        kind: "workflow_run",
        runId: "wf_run-1",
        scriptPath: join(paths.sessionDir, "workflows", "scripts", "deploy-wf_run-1.js"),
        journalPath: join(paths.sessionDir, "subagents", "workflows", "wf_run-1", "journal.jsonl"),
      },
      continuation: {
        kind: "workflow_resume",
        resumeFromRunId: "wf_run-1",
        scriptPath: join(paths.sessionDir, "workflows", "scripts", "deploy-wf_run-1.js"),
      },
    },
    scheduled_wakeup: {
      verifiedIdentity: {
        kind: "scheduled_time",
        toolUseId: "toolu_wake",
        scheduledForMs: LAUNCHES.scheduled_wakeup.scheduledForMs,
      },
      continuation: { kind: "rearm_at", scheduledForMs: LAUNCHES.scheduled_wakeup.scheduledForMs },
    },
    monitor: {
      verifiedIdentity: { kind: "monitor_launch", toolUseId: "toolu_mon", rolloutPath: paths.rolloutPath },
      continuation: { kind: "monitor_relaunch", toolUseId: "toolu_mon", rolloutPath: paths.rolloutPath },
    },
  });

  for (const family of QUALIFIABLE) {
    it(`${family}: the carried item holds the verified identity and the invocable mechanism through closure`, () => {
      const paths = hostLayout();
      const { store, qualify, snapshot, item } = rig(paths, "linux");
      qualify();
      const expected = expectedFor(paths)[family as keyof ReturnType<typeof expectedFor>];
      const result = snapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const carried = result.snapshot.items.find((i) => i.family === family);
      expect(carried).toMatchObject({ launchId: LAUNCH_IDS[family], carryMode: CONTRACT[family].mode, ...expected });
      // The durable row and the manifest agree exactly; the mechanism is the identity's, not a re-derivation from the fold.
      expect(carried?.verifiedIdentity).toEqual(item(family).verifiedIdentity);
      // Closure rebuilds the same complete item from the store alone.
      const closure = closeContinuitySnapshot(store, {
        threadId: T,
        generation: result.snapshot.generation,
        nowMs: 9_000,
      });
      expect(closure.closed).toBe(true);
      expect(closure.carried.find((i) => i.family === family)).toEqual(carried);
      // Reopening the database yields the same identity, so a later process can invoke the same mechanism.
      store.close();
      const reopened = openContinuityStore(store.path);
      expect(reopened.getItem(T, LAUNCH_IDS[family])?.verifiedIdentity).toEqual(carried?.verifiedIdentity);
      reopened.close();
    });
  }

  it("a Monitor is reported restarted, never adopted or uninterrupted, under its original launch id", () => {
    const { store, qualify, snapshot, item } = rig(hostLayout(), "linux");
    qualify();
    const result = snapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const carried = result.snapshot.items.find((i) => i.family === "monitor");
    expect(carried?.launchId).toBe(item("monitor").launchId);
    expect(carried?.transition).toBe("restarted");
    expect(result.snapshot.items.filter((i) => i.transition === "adopted").map((i) => i.family)).toEqual([
      "background_shell",
    ]);
    store.close();
  });
});

describe("re-verification before the seam", () => {
  it("a replaced output file is a different identity: the adopted shell becomes unverified and is never claimed", () => {
    const paths = hostLayout();
    const { store, qualify, snapshot, item } = rig(paths, "linux");
    qualify();
    const before = item("background_shell").verifiedIdentity;
    // Hold the old inode (as Story 0 does) so the replacement provably gets another one.
    renameSync(join(paths.tasksDir, "shell-1.output"), join(paths.tasksDir, "shell-1.output.held"));
    writeFileSync(join(paths.tasksDir, "shell-1.output"), "replacement\n");
    const outcome = qualify();
    expect(outcome.refused).toEqual([
      { launchId: LAUNCH_IDS.background_shell, family: "background_shell", reason: "identity_changed" },
    ]);
    const after = item("background_shell");
    expect(after.state).toBe("unknown");
    expect(after.verifiedIdentity).toEqual(before);
    expect(snapshot()).toEqual({ ok: false, reason: "unverified_items", launchIds: [LAUNCH_IDS.background_shell] });
    // Still refused on every later pass: the recorded identity never matches the reused path.
    expect(qualify().refused.map((r) => r.reason)).toEqual(["identity_changed"]);
    store.close();
  });

  it("a qualified item whose transcript disappears becomes unverified, not silently carried", () => {
    const paths = hostLayout();
    const { store, qualify, snapshot, item } = rig(paths, "linux");
    qualify();
    rmSync(join(paths.sessionDir, "subagents", "agent-agent-1.jsonl"));
    expect(qualify().refused).toEqual([{ launchId: LAUNCH_IDS.agent, family: "agent", reason: "transcript_missing" }]);
    expect(item("agent").state).toBe("unknown");
    expect(snapshot()).toMatchObject({ ok: false, reason: "unverified_items" });
    store.close();
  });

  it("terminal items are never re-qualified or touched", () => {
    const paths = hostLayout();
    const { store, observer, qualify, item } = rig(paths, "linux");
    observer.observeLine(notification({ taskIds: ["agent-1"], status: "completed" }));
    const before = item("agent");
    const outcome = qualify();
    expect(outcome.qualified.map((q) => q.family)).not.toContain("agent");
    expect(item("agent")).toEqual(before);
    store.close();
  });
});
