/**
 * LIM-145 AC-2.1 (TC-2.1a–d): launch, progress, and terminal evidence for all
 * five families recorded in the parent-owned store through the real fold.
 * Elapsed time never closes anything.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createContinuityObserver } from "../../src/continuity/observe.js";
import { openContinuityStore } from "../../src/continuity/store.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";
import {
  allLaunchLines,
  LAUNCH_IDS,
  LAUNCHES,
  monitorEvent,
  notification,
  tempDbPath,
  toolResult,
  toolUse,
} from "./helpers.js";

const T = "th_observe";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "async-work");

function rig(nowMs = 1_000) {
  const store = openContinuityStore(tempDbPath());
  let now = nowMs;
  const observer = createContinuityObserver({ store, threadId: T, nowFn: () => now });
  const feed = (lines: RolloutLineItem[]) => {
    for (const line of lines) {
      now += 1;
      observer.observeLine(line);
    }
  };
  return {
    store,
    observer,
    feed,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("TC-2.1a launch opens exactly one item per family", () => {
  it("records all five families with stable identity and sanitized labels", () => {
    const { store, feed } = rig();
    feed(allLaunchLines());
    const items = store.listItems(T);
    expect(items.map((item) => item.launchId)).toEqual([
      LAUNCH_IDS.agent,
      LAUNCH_IDS.workflow,
      LAUNCH_IDS.background_shell,
      LAUNCH_IDS.monitor,
      LAUNCH_IDS.scheduled_wakeup,
    ]);
    expect(
      items.every((item) => item.state === "active" && item.generation === 0 && item.carryMode === "unqualified"),
    ).toBe(true);
    const byFamily = Object.fromEntries(items.map((item) => [item.family, item]));
    expect(byFamily.agent).toMatchObject({
      taskId: "agent-1",
      toolUseId: "toolu_agent",
      label: 'background agent "reviewer" (agent-1)',
    });
    expect(byFamily.workflow).toMatchObject({ taskId: "wf-task-1", label: 'workflow "deploy" (wf-task-1)' });
    expect(byFamily.monitor).toMatchObject({ taskId: "mon-1", label: 'monitor "CI watch" (mon-1)' });
    expect(byFamily.scheduled_wakeup).toMatchObject({
      taskId: null,
      scheduledForMs: LAUNCHES.scheduled_wakeup.scheduledForMs,
      label: 'scheduled wakeup "poll CI"',
    });
    // Continuation facts arrive exactly as the host stated them (AC-2.2 inputs).
    expect(byFamily.agent?.continuation).toEqual({ outputFile: "/nonexistent/tasks/agent-1.output" });
    expect(byFamily.workflow?.continuation).toEqual({
      runId: "wf_run-1",
      scriptPath: "/nonexistent/projects/-x/session-old/workflows/scripts/deploy-wf_run-1.js",
      transcriptDir: "/nonexistent/projects/-x/session-old/subagents/workflows/wf_run-1",
    });
    expect(byFamily.background_shell?.continuation).toEqual({ outputFile: "/nonexistent/tasks/shell-1.output" });
    expect(byFamily.monitor?.continuation).toBeNull();
    expect(byFamily.scheduled_wakeup?.continuation).toBeNull();
    // The shell's command body never reaches the database.
    expect(byFamily.background_shell?.label).toBe("background command (shell-1)");
    expect(JSON.stringify(items)).not.toMatch(/SECRET|Authorization|curl/);
    store.close();
  });

  it("re-reading the same launch acknowledgement opens nothing new", () => {
    const { store, feed } = rig();
    feed(allLaunchLines());
    feed(allLaunchLines());
    expect(store.listItems(T)).toHaveLength(5);
    store.close();
  });

  it("a result without its launcher call, or a launcher that did not launch, opens nothing", () => {
    const { store, feed } = rig();
    feed([toolResult("toolu_unknown", { status: "async_launched", agentId: "ghost" })]);
    feed([toolUse("toolu_sync", "Agent", { description: "sync" }), toolResult("toolu_sync", { content: "done" })]);
    expect(store.listItems(T)).toEqual([]);
    store.close();
  });
});

describe("TC-2.1b progress does not close work", () => {
  it("a monitor event and a stall notice keep the item active and refresh it", () => {
    const { store, feed } = rig();
    feed(allLaunchLines());
    const before = store.getItem(T, LAUNCH_IDS.monitor)!;
    feed([notification({ taskIds: ["mon-1"], event: "line matched: build green" })]);
    feed([notification({ taskIds: ["agent-1"], summary: "still running" })]);
    const monitor = store.getItem(T, LAUNCH_IDS.monitor)!;
    expect(monitor.state).toBe("active");
    expect(monitor.updatedAtMs).toBeGreaterThan(before.updatedAtMs);
    expect(store.getItem(T, LAUNCH_IDS.agent)?.state).toBe("active");
    expect(store.listItems(T).filter((item) => item.state === "active")).toHaveLength(5);
    // A monitor learns its output file from the host's first event, once.
    feed([monitorEvent()]);
    feed([notification({ taskIds: ["mon-1"], event: "again", outputFile: "/nonexistent/tasks/other.output" })]);
    expect(store.getItem(T, LAUNCH_IDS.monitor)?.continuation).toEqual({
      outputFile: "/nonexistent/tasks/mon-1.output",
    });
    // Progress text is never persisted.
    expect(JSON.stringify(store.listItems(T))).not.toContain("build green");
    store.close();
  });
});

describe("TC-2.1c terminal evidence closes exactly the matching item", () => {
  it("closes each family on its own evidence and leaves the others open", () => {
    const { store, feed } = rig();
    feed(allLaunchLines());
    feed([notification({ taskIds: ["agent-1"], status: "completed", summary: "done" })]);
    expect(store.getItem(T, LAUNCH_IDS.agent)?.terminal).toMatchObject({
      outcome: "completed",
      evidence: "task-notification completed",
    });
    expect(store.listItems(T).filter((item) => item.state === "active")).toHaveLength(4);

    feed([notification({ taskIds: ["wf-task-1"], status: "failed" })]);
    expect(store.getItem(T, LAUNCH_IDS.workflow)?.terminal?.outcome).toBe("failed");

    feed([
      toolUse("toolu_stop", "TaskStop", { task_id: "shell-1" }),
      toolResult("toolu_stop", { message: "stopped", task_id: "shell-1", task_type: "local_bash" }),
    ]);
    expect(store.getItem(T, LAUNCH_IDS.background_shell)?.terminal).toMatchObject({
      outcome: "stopped",
      evidence: "TaskStop",
    });

    feed([notification({ taskIds: ["mon-1"], status: "killed" })]);
    expect(store.getItem(T, LAUNCH_IDS.monitor)?.terminal?.outcome).toBe("killed");
    expect(
      store
        .listItems(T)
        .filter((item) => item.state === "active")
        .map((item) => item.family),
    ).toEqual(["scheduled_wakeup"]);

    feed([
      toolUse("toolu_wake_stop", "ScheduleWakeup", { stop: true }),
      toolResult("toolu_wake_stop", { scheduledFor: 0, stopped: true, clampedDelaySeconds: 0, wasClamped: false }),
    ]);
    expect(store.getItem(T, LAUNCH_IDS.scheduled_wakeup)?.terminal).toMatchObject({
      outcome: "cancelled",
      evidence: "ScheduleWakeup stop",
    });
    expect(store.listItems(T).every((item) => item.state === "terminal")).toBe(true);
    store.close();
  });

  it("a later ScheduleWakeup cancels the pending one and opens a distinct item", () => {
    const { store, feed } = rig();
    feed(LAUNCHES.scheduled_wakeup.lines());
    feed([
      toolUse("toolu_wake2", "ScheduleWakeup", { delaySeconds: 120, reason: "poll again" }),
      toolResult("toolu_wake2", { scheduledFor: 1_800_000_120_000, clampedDelaySeconds: 120, wasClamped: false }),
    ]);
    const items = store.listItems(T);
    expect(items.map((item) => [item.launchId, item.state])).toEqual([
      [LAUNCH_IDS.scheduled_wakeup, "terminal"],
      ["scheduled_wakeup:scheduled_wakeup:toolu_wake2", "active"],
    ]);
    expect(items[0]?.terminal).toMatchObject({
      outcome: "cancelled",
      evidence: "superseded by a later ScheduleWakeup",
    });
    store.close();
  });

  it("terminal evidence is monotonic: a second notice or a repeated launch cannot reopen", () => {
    const { store, feed } = rig();
    feed(LAUNCHES.agent.lines());
    feed([notification({ taskIds: ["agent-1"], status: "completed" })]);
    feed([notification({ taskIds: ["agent-1"], status: "killed" })]);
    feed(LAUNCHES.agent.lines());
    const item = store.getItem(T, LAUNCH_IDS.agent)!;
    expect(item.state).toBe("terminal");
    expect(item.terminal?.outcome).toBe("completed");
    expect(store.listItems(T)).toHaveLength(1);
    store.close();
  });
});

describe("TC-2.1d elapsed time is not completion", () => {
  it("an overdue wakeup and a long-silent shell stay active with no terminal evidence", () => {
    const { store, feed, tick } = rig(1_800_000_000_000 - 30_000);
    feed(allLaunchLines());
    tick(7 * 24 * 60 * 60 * 1_000);
    for (const item of store.listItems(T)) {
      expect(item.state, item.launchId).toBe("active");
      expect(item.terminal).toBeNull();
    }
    store.close();
  });
});

describe("real Claude Code 2.1.252 records", () => {
  it("folds the scrubbed continuity probe: four launches, then the host's stopped notices close them", () => {
    const lines = readFileSync(join(FIXTURES, "claude-2.1.252-continuity-probe.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as RolloutLineItem);
    const { store, feed } = rig();
    feed(lines);
    const items = store.listItems(T);
    const stopped = items.filter((item) => item.terminal?.outcome === "stopped");
    expect(new Set(stopped.map((item) => item.family))).toEqual(
      new Set(["background_shell", "monitor", "agent", "workflow"]),
    );
    expect(stopped.every((item) => item.terminal?.evidence === "task-notification stopped")).toBe(true);
    // Nothing in the fixture is read as work twice.
    expect(new Set(items.map((item) => item.launchId)).size).toBe(items.length);
    store.close();
  });
});
