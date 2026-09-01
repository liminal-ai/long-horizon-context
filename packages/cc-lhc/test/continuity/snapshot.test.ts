/**
 * LIM-145 AC-2.5 (TC-2.5a/b/d): one and many items are represented once, with
 * identity, family, carry mode, state, and operations; an unverified item is
 * never claimed.
 */
import { describe, expect, it } from "vitest";

import { createContinuityObserver } from "../../src/continuity/observe.js";
import { snapshotContinuity } from "../../src/continuity/snapshot.js";
import { openContinuityStore, type QualifiedCarryMode } from "../../src/continuity/store.js";
import { allLaunchLines, LAUNCH_IDS, LAUNCHES, notification, QUALIFIED, qualifyAll, tempDbPath } from "./helpers.js";

const T = "th_snapshot";

/** Seeded and, unless `qualify` is false, explicitly qualified by family. */
function seeded(lines = allLaunchLines(), qualify = true) {
  const store = openContinuityStore(tempDbPath());
  let now = 1_000;
  const observer = createContinuityObserver({ store, threadId: T, nowFn: () => (now += 1) });
  for (const line of lines) observer.observeLine(line);
  if (qualify) qualifyAll(store, T, 3_000);
  return { store, observer };
}

describe("TC-2.5a one active item", () => {
  it("is carried once with identity, family, carry mode, state, and operations", () => {
    const { store } = seeded(LAUNCHES.agent.lines());
    const result = snapshotContinuity(store, { threadId: T, oldSessionId: "old", nowMs: 5_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot).toEqual({
      threadId: T,
      generation: 1,
      oldSessionId: "old",
      createdAtMs: 5_000,
      items: [
        {
          launchId: LAUNCH_IDS.agent,
          family: "agent",
          label: 'background agent "reviewer" (agent-1)',
          state: "active",
          carryMode: "reconstruct",
          operations: ["status", "stop"],
          taskId: "agent-1",
          toolUseId: "toolu_agent",
          scheduledForMs: null,
        },
      ],
    });
    expect(store.getItem(T, LAUNCH_IDS.agent)?.generation).toBe(1);
    expect(store.latestGeneration(T)).toMatchObject({ generation: 1, state: "open", launchIds: [LAUNCH_IDS.agent] });
    store.close();
  });

  it("carries the mode and operations a qualified adapter recorded", () => {
    const { store } = seeded(LAUNCHES.background_shell.lines(), false);
    store.setCarryMode({
      threadId: T,
      launchId: LAUNCH_IDS.background_shell,
      carryMode: "adopt",
      operations: ["status", "output", "stop"],
      nowMs: 2_000,
    });
    const result = snapshotContinuity(store, { threadId: T, oldSessionId: "old", nowMs: 5_000 });
    expect(result.ok && result.snapshot.items[0]).toMatchObject({
      carryMode: "adopt",
      operations: ["status", "output", "stop"],
    });
    store.close();
  });
});

describe("TC-2.5b several active items", () => {
  it("represents each item once, in launch order, distinguishable by identity", () => {
    const { store } = seeded();
    const result = snapshotContinuity(store, { threadId: T, oldSessionId: "old", nowMs: 5_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.snapshot.items.map((item) => item.launchId);
    expect(ids).toEqual(Object.values(LAUNCH_IDS));
    expect(new Set(ids).size).toBe(5);
    expect(new Set(result.snapshot.items.map((item) => item.family)).size).toBe(5);
    expect(result.snapshot.items.map((item) => item.carryMode)).toEqual(Object.values(QUALIFIED));
    store.close();
  });

  it("leaves terminal items behind, qualified or not", () => {
    const { store, observer } = seeded(allLaunchLines(), false);
    observer.observeLine(notification({ taskIds: ["agent-1"], status: "completed" }));
    qualifyAll(store, T, 3_000);
    expect(store.getItem(T, LAUNCH_IDS.agent)?.carryMode).toBe("unqualified");
    const result = snapshotContinuity(store, { threadId: T, oldSessionId: "old", nowMs: 5_000 });
    expect(result.ok && result.snapshot.items.map((item) => item.family)).toEqual([
      "workflow",
      "background_shell",
      "monitor",
      "scheduled_wakeup",
    ]);
    expect(store.getItem(T, LAUNCH_IDS.agent)?.generation).toBe(0);
    store.close();
  });
});

describe("TC-2.5d no false carryover claim", () => {
  it("refuses the whole snapshot while any active item has no qualified carry mode, allocating nothing", () => {
    const { store } = seeded(allLaunchLines(), false);
    store.setCarryMode({
      threadId: T,
      launchId: LAUNCH_IDS.background_shell,
      carryMode: "adopt",
      operations: ["status"],
      nowMs: 2_000,
    });
    const result = snapshotContinuity(store, { threadId: T, oldSessionId: "old", nowMs: 5_000 });
    expect(result).toEqual({
      ok: false,
      reason: "unqualified_items",
      launchIds: [LAUNCH_IDS.agent, LAUNCH_IDS.workflow, LAUNCH_IDS.monitor, LAUNCH_IDS.scheduled_wakeup],
    });
    expect(store.latestGeneration(T)).toBeNull();
    expect(store.listItems(T).every((item) => item.generation === 0)).toBe(true);
    // Every family qualified: the same set snapshots, and only qualified modes reach the manifest.
    qualifyAll(store, T, 6_000);
    const accepted = snapshotContinuity(store, { threadId: T, oldSessionId: "old", nowMs: 7_000 });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.snapshot.items).toHaveLength(5);
    // The manifest type itself excludes the launch default: only adopt/reconstruct/rearm can appear.
    const modes: QualifiedCarryMode[] = accepted.snapshot.items.map((item) => item.carryMode);
    expect(modes).toEqual(Object.values(QUALIFIED));
    store.close();
  });

  it("a fresh launch with no adapter is the launch default and refuses on its own", () => {
    const { store } = seeded(LAUNCHES.agent.lines(), false);
    expect(store.getItem(T, LAUNCH_IDS.agent)?.carryMode).toBe("unqualified");
    const result = snapshotContinuity(store, { threadId: T, oldSessionId: "old", nowMs: 5_000 });
    expect(result).toEqual({ ok: false, reason: "unqualified_items", launchIds: [LAUNCH_IDS.agent] });
    expect(store.latestGeneration(T)).toBeNull();
    store.close();
  });

  it("refuses the whole snapshot while any item is unverified, allocating nothing", () => {
    const { store } = seeded();
    store.setVerified({ threadId: T, launchId: LAUNCH_IDS.monitor, verified: false, nowMs: 2_000 });
    const result = snapshotContinuity(store, { threadId: T, oldSessionId: "old", nowMs: 5_000 });
    expect(result).toEqual({ ok: false, reason: "unverified_items", launchIds: [LAUNCH_IDS.monitor] });
    expect(store.latestGeneration(T)).toBeNull();
    expect(store.listItems(T).every((item) => item.generation === 0)).toBe(true);
    // Verified again: the same set snapshots normally.
    store.setVerified({ threadId: T, launchId: LAUNCH_IDS.monitor, verified: true, nowMs: 6_000 });
    expect(snapshotContinuity(store, { threadId: T, oldSessionId: "old", nowMs: 7_000 }).ok).toBe(true);
    store.close();
  });
});
