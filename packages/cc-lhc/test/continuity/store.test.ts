/**
 * LIM-145 foundation: parent-owned continuity records in the real cc-lhc
 * SQLite database. Monotonic writes, generation scoping, coexistence with the
 * receipt tables, and persistence across reopen.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { openContinuityStore } from "../../src/continuity/store.js";
import { openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import { tempDbPath } from "./helpers.js";

const T = "th_store";
const launch = (launchId: string, nowMs: number) => ({
  threadId: T,
  launchId,
  family: "agent" as const,
  label: `background agent (${launchId})`,
  taskId: launchId,
  toolUseId: `toolu_${launchId}`,
  nowMs,
});

describe("continuity store: one database, additive tables", () => {
  it("creates its tables beside the governor receipts in the same file", () => {
    const path = tempDbPath();
    const receipts = openGovernorReceiptStore(path);
    const store = openContinuityStore(path);
    const db = new DatabaseSync(path, { readOnly: true });
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(["cc_governor_receipts", "cc_continuity_items", "cc_continuity_generations"]),
    );
    db.close();
    store.close();
    receipts.close();
  });

  it("records one row per launch identity and never rewrites it", () => {
    const store = openContinuityStore(tempDbPath());
    const first = store.recordLaunch(launch("a", 1_000));
    expect(first.inserted).toBe(true);
    expect(first.item).toMatchObject({
      threadId: T,
      launchId: "a",
      generation: 0,
      state: "active",
      carryMode: "unqualified",
      operations: [],
      terminal: null,
      createdAtMs: 1_000,
    });
    const again = store.recordLaunch({ ...launch("a", 2_000), label: "different" });
    expect(again.inserted).toBe(false);
    expect(again.item).toEqual(first.item);
    store.close();
  });

  it("terminal is absorbing: first evidence wins, later evidence and launches change nothing", () => {
    const store = openContinuityStore(tempDbPath());
    store.recordLaunch(launch("a", 1_000));
    const closed = store.recordTerminal({
      threadId: T,
      launchId: "a",
      outcome: "completed",
      evidence: "task-notification completed",
      nowMs: 2_000,
    });
    expect(closed?.applied).toBe(true);
    expect(closed?.item.terminal).toEqual({
      outcome: "completed",
      evidence: "task-notification completed",
      observedAtMs: 2_000,
    });
    const later = store.recordTerminal({
      threadId: T,
      launchId: "a",
      outcome: "killed",
      evidence: "task-notification killed",
      nowMs: 3_000,
    });
    expect(later?.applied).toBe(false);
    expect(later?.item.terminal?.outcome).toBe("completed");
    expect(store.recordProgress({ threadId: T, launchId: "a", nowMs: 4_000 })?.updatedAtMs).toBe(2_000);
    expect(store.recordLaunch(launch("a", 5_000)).item.state).toBe("terminal");
    expect(store.setVerified({ threadId: T, launchId: "a", verified: false, nowMs: 6_000 })?.state).toBe("terminal");
    store.close();
  });

  it("progress refreshes an open item and unknown launches are refused, not invented", () => {
    const store = openContinuityStore(tempDbPath());
    store.recordLaunch(launch("a", 1_000));
    expect(store.recordProgress({ threadId: T, launchId: "a", nowMs: 1_500 })).toMatchObject({
      state: "active",
      updatedAtMs: 1_500,
    });
    expect(store.recordProgress({ threadId: T, launchId: "nope", nowMs: 1_500 })).toBeNull();
    expect(
      store.recordTerminal({ threadId: T, launchId: "nope", outcome: "completed", evidence: "x", nowMs: 1_500 }),
    ).toBeNull();
    store.close();
  });

  it("verification and carry mode are recorded per item", () => {
    const store = openContinuityStore(tempDbPath());
    store.recordLaunch(launch("a", 1_000));
    expect(store.setVerified({ threadId: T, launchId: "a", verified: false, nowMs: 1_100 })?.state).toBe("unknown");
    expect(store.setVerified({ threadId: T, launchId: "a", verified: true, nowMs: 1_200 })?.state).toBe("active");
    const qualified = store.setCarryMode({
      threadId: T,
      launchId: "a",
      carryMode: "adopt",
      operations: ["status", "stop"],
      nowMs: 1_300,
    });
    expect(qualified).toMatchObject({ carryMode: "adopt", operations: ["status", "stop"] });
    store.close();
  });

  it("the adapter-facing setter cannot return an item to unqualified", () => {
    const store = openContinuityStore(tempDbPath());
    store.recordLaunch(launch("a", 1_000));
    store.setCarryMode({ threadId: T, launchId: "a", carryMode: "rearm", operations: ["status"], nowMs: 1_100 });
    expect(() =>
      store.setCarryMode({
        threadId: T,
        launchId: "a",
        carryMode: "unqualified" as never,
        operations: [],
        nowMs: 1_200,
      }),
    ).toThrow(/cannot be reset to unqualified/);
    expect(store.getItem(T, "a")).toMatchObject({ carryMode: "rearm", operations: ["status"], updatedAtMs: 1_100 });
    store.close();
  });

  it("generations only increase, stamp their members, and supersede earlier open ones", () => {
    const store = openContinuityStore(tempDbPath());
    store.recordLaunch(launch("a", 1_000));
    store.recordLaunch(launch("b", 1_001));
    const g1 = store.allocateGeneration({ threadId: T, oldSessionId: "s1", launchIds: ["a"], nowMs: 2_000 });
    expect(g1).toMatchObject({ generation: 1, state: "open", launchIds: ["a"] });
    expect(store.getItem(T, "a")?.generation).toBe(1);
    expect(store.getItem(T, "b")?.generation).toBe(0);
    const g2 = store.allocateGeneration({ threadId: T, oldSessionId: "s1", launchIds: ["a", "b", "b"], nowMs: 3_000 });
    expect(g2).toMatchObject({ generation: 2, launchIds: ["a", "b"] });
    expect(store.getGeneration(T, 1)?.state).toBe("superseded");
    expect(store.getItem(T, "a")?.generation).toBe(2);
    expect(store.latestGeneration(T)?.generation).toBe(2);
    // Another thread's counter is its own.
    expect(
      store.allocateGeneration({ threadId: "th_other", oldSessionId: "x", launchIds: [], nowMs: 4_000 }).generation,
    ).toBe(1);
    store.close();
  });

  it("everything survives closing and reopening the database", () => {
    const path = tempDbPath();
    const store = openContinuityStore(path);
    store.recordLaunch(launch("a", 1_000));
    store.recordTerminal({ threadId: T, launchId: "a", outcome: "stopped", evidence: "TaskStop", nowMs: 2_000 });
    store.allocateGeneration({ threadId: T, oldSessionId: "s1", launchIds: [], nowMs: 3_000 });
    const before = { items: store.listItems(T), generation: store.latestGeneration(T) };
    store.close();
    const reopened = openContinuityStore(path);
    expect({ items: reopened.listItems(T), generation: reopened.latestGeneration(T) }).toEqual(before);
    reopened.close();
  });

  it("a malformed row fails loud instead of being read as work", () => {
    const path = tempDbPath();
    const store = openContinuityStore(path);
    store.recordLaunch(launch("a", 1_000));
    const db = new DatabaseSync(path);
    db.exec("UPDATE cc_continuity_items SET state = 'paused' WHERE launch_id = 'a'");
    db.close();
    expect(() => store.listItems(T)).toThrow(/malformed/);
    store.close();
  });
});
