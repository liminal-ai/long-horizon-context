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
      verifiedIdentity: { kind: "scheduled_time", toolUseId: "t", scheduledForMs: 1 },
      nowMs: 1_300,
    });
    expect(qualified).toMatchObject({ carryMode: "adopt", operations: ["status", "stop"] });
    store.close();
  });

  it("the adapter-facing setter cannot return an item to unqualified", () => {
    const store = openContinuityStore(tempDbPath());
    store.recordLaunch(launch("a", 1_000));
    store.setCarryMode({
      threadId: T,
      launchId: "a",
      carryMode: "rearm",
      operations: ["status"],
      verifiedIdentity: { kind: "scheduled_time", toolUseId: "t", scheduledForMs: 1 },
      nowMs: 1_100,
    });
    expect(() =>
      store.setCarryMode({
        threadId: T,
        launchId: "a",
        carryMode: "unqualified" as never,
        operations: [],
        verifiedIdentity: { kind: "scheduled_time", toolUseId: "t", scheduledForMs: 1 },
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

  it("opens a database written by the foundation schema and adds the adapter columns additively", () => {
    const path = tempDbPath();
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE cc_continuity_items (
      thread_id TEXT NOT NULL, launch_id TEXT NOT NULL, generation INTEGER NOT NULL, family TEXT NOT NULL,
      label TEXT NOT NULL, state TEXT NOT NULL, carry_mode TEXT NOT NULL, operations_json TEXT NOT NULL,
      task_id TEXT, tool_use_id TEXT, scheduled_for_ms INTEGER, terminal_outcome TEXT, terminal_evidence TEXT,
      terminal_observed_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (thread_id, launch_id))`);
    db.exec(
      `INSERT INTO cc_continuity_items VALUES ('${T}','a',0,'agent','background agent (a)','active','unqualified','[]','a','toolu_a',NULL,NULL,NULL,NULL,1,1)`,
    );
    db.close();
    const store = openContinuityStore(path);
    expect(store.getItem(T, "a")).toMatchObject({
      continuation: null,
      verifiedIdentity: null,
      carryMode: "unqualified",
    });
    const cols = (
      new DatabaseSync(path, { readOnly: true }).prepare("PRAGMA table_info(cc_continuity_items)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["continuation_json", "identity_json"]));
    store.close();
  });

  it("continuation facts are learned once and never rewritten", () => {
    const store = openContinuityStore(tempDbPath());
    store.recordLaunch({ ...launch("a", 1_000), continuation: { outputFile: "/t/a.output" } });
    expect(store.getItem(T, "a")?.continuation).toEqual({ outputFile: "/t/a.output" });
    store.recordProgress({
      threadId: T,
      launchId: "a",
      continuation: { outputFile: "/t/other.output", runId: "r1" },
      nowMs: 1_100,
    });
    expect(store.getItem(T, "a")?.continuation).toEqual({ outputFile: "/t/a.output", runId: "r1" });
    store.close();
  });

  it("a qualified row must carry the identity it verified, and a bare qualified row is malformed", () => {
    const path = tempDbPath();
    const store = openContinuityStore(path);
    store.recordLaunch(launch("a", 1_000));
    expect(() =>
      store.setCarryMode({
        threadId: T,
        launchId: "a",
        carryMode: "adopt",
        operations: [],
        verifiedIdentity: { kind: "posix_output", path: "", dev: "1", ino: "2" },
        nowMs: 2,
      }),
    ).toThrow(/verified identity malformed/);
    store.setCarryMode({
      threadId: T,
      launchId: "a",
      carryMode: "adopt",
      operations: ["output"],
      verifiedIdentity: { kind: "posix_output", path: "/t/a", dev: "1", ino: "2" },
      nowMs: 2,
    });
    expect(store.getItem(T, "a")?.verifiedIdentity).toEqual({ kind: "posix_output", path: "/t/a", dev: "1", ino: "2" });
    const db = new DatabaseSync(path);
    db.exec("UPDATE cc_continuity_items SET identity_json = NULL WHERE launch_id = 'a'");
    db.close();
    expect(() => store.getItem(T, "a")).toThrow(/malformed/);
    store.close();
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
