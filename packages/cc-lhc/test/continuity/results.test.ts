/**
 * LIM-146 AC-2.7 foundation: one durable terminal result per carried item in
 * the real cc-lhc SQLite, written by the same terminal write that closes the
 * item; the rebuilt session's fold seeded from the record so terminal evidence
 * is recognized; read-only panel visibility of pending results.
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { carriedOpenWork, createContinuityObserver } from "../../src/continuity/observe.js";
import {
  boundedEvidence,
  MAX_RESULT_EVIDENCE_CHARS,
  openContinuityStore,
  type TerminalOutcome,
} from "../../src/continuity/store.js";
import {
  type AsyncWorkEvent,
  asyncWorkIdentity,
  createAsyncWorkFold,
  observeAsyncWorkLine,
} from "../../src/observation/async-work.js";
import { formatPendingResultRows } from "../../src/wrapper/panel-commands.js";
import { allLaunchLines, LAUNCH_IDS, LAUNCHES, notification, qualifyAll, tempDbPath } from "./helpers.js";

const T = "th_results";
const OUTCOMES: readonly TerminalOutcome[] = [
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "killed",
  "stopped",
  "unknown",
];

const launch = (launchId: string, nowMs: number) => ({
  threadId: T,
  launchId,
  family: "agent" as const,
  label: `background agent (${launchId})`,
  taskId: launchId,
  toolUseId: `toolu_${launchId}`,
  nowMs,
});

/** Carried items: launched, qualified, and stamped into generation 1. */
function carried(ids: readonly string[]) {
  const path = tempDbPath();
  const store = openContinuityStore(path);
  ids.forEach((id, i) => {
    store.recordLaunch(launch(id, 1_000 + i));
  });
  qualifyAll(store, T, 2_000);
  store.allocateGeneration({ threadId: T, oldSessionId: "old", launchIds: ids, nowMs: 3_000 });
  return { path, store };
}

function resultRows(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  const n = (db.prepare("SELECT COUNT(*) AS n FROM cc_continuity_results").get() as { n: number }).n;
  db.close();
  return n;
}

function dbBytes(path: string): string {
  let wal = "";
  try {
    wal = readFileSync(`${path}-wal`, "latin1");
  } catch {
    // no WAL file
  }
  return readFileSync(path, "latin1") + wal;
}

describe("one durable result per carried terminal item", () => {
  it("every terminal outcome writes exactly one pending result with the item's identity, label, and bounded evidence", () => {
    const ids = OUTCOMES.map((outcome) => `a-${outcome}`);
    const { path, store } = carried(ids);
    OUTCOMES.forEach((outcome, i) => {
      const id = ids[i]!;
      const terminal = store.recordTerminal({
        threadId: T,
        launchId: id,
        outcome,
        evidence: `task-notification ${outcome}`,
        nowMs: 5_000 + i,
      });
      expect(terminal?.applied).toBe(true);
      expect(store.getResult(T, id)).toEqual({
        threadId: T,
        launchId: id,
        generation: 1,
        family: "agent",
        label: `background agent (${id})`,
        outcome,
        evidence: `task-notification ${outcome}`,
        artifact: null,
        observedAtMs: 5_000 + i,
        delivery: "pending",
        createdAtMs: 5_000 + i,
      });
    });
    expect(store.listPendingResults(T).map((r) => r.outcome)).toEqual(OUTCOMES);
    expect(resultRows(path)).toBe(OUTCOMES.length);
    store.close();
  });

  it("a repeated terminal observation is absorbed: no second result, first outcome and evidence kept", () => {
    const { path, store } = carried(["a"]);
    store.recordTerminal({ threadId: T, launchId: "a", outcome: "completed", evidence: "first", nowMs: 5_000 });
    const again = store.recordTerminal({
      threadId: T,
      launchId: "a",
      outcome: "failed",
      evidence: "second",
      nowMs: 6_000,
    });
    expect(again?.applied).toBe(false);
    const third = store.recordTerminal({
      threadId: T,
      launchId: "a",
      outcome: "completed",
      evidence: "first",
      nowMs: 7_000,
    });
    expect(third?.applied).toBe(false);
    expect(store.getResult(T, "a")).toMatchObject({ outcome: "completed", evidence: "first", observedAtMs: 5_000 });
    expect(resultRows(path)).toBe(1);
    expect(store.listPendingResults(T)).toHaveLength(1);
    store.close();
  });

  it("work that was never carried (generation 0) closes without a result; an unknown launch writes nothing", () => {
    const { path, store } = carried(["carried"]);
    store.recordLaunch(launch("local", 4_000));
    expect(
      store.recordTerminal({ threadId: T, launchId: "local", outcome: "completed", evidence: "done", nowMs: 5_000 })
        ?.applied,
    ).toBe(true);
    expect(store.getResult(T, "local")).toBeNull();
    expect(
      store.recordTerminal({ threadId: T, launchId: "nobody", outcome: "completed", evidence: "done", nowMs: 5_000 }),
    ).toBeNull();
    expect(resultRows(path)).toBe(0);
    store.close();
  });

  it("the result references only the item's owned artifact: adopted output, relaunch output, or none", () => {
    const path = tempDbPath();
    const store = openContinuityStore(path);
    const observer = createContinuityObserver({ store, threadId: T, nowFn: () => 1_000 });
    for (const line of allLaunchLines()) observer.observeLine(line);
    store.setCarryMode({
      threadId: T,
      launchId: LAUNCH_IDS.background_shell,
      carryMode: "adopt",
      operations: ["output"],
      verifiedIdentity: { kind: "posix_output", path: "/nonexistent/tasks/shell-1.output", dev: "1", ino: "2" },
      nowMs: 2_000,
    });
    qualifyAll(store, T, 2_000);
    store.setRelaunched({
      threadId: T,
      launchId: LAUNCH_IDS.monitor,
      relaunch: {
        outputPath: "/parent/continuity/mon.output",
        output: { kind: "posix_output", path: "/parent/continuity/mon.output", dev: "1", ino: "3" },
        process: null,
      },
      nowMs: 2_500,
    });
    store.allocateGeneration({ threadId: T, oldSessionId: "old", launchIds: Object.values(LAUNCH_IDS), nowMs: 3_000 });
    for (const id of [LAUNCH_IDS.background_shell, LAUNCH_IDS.monitor, LAUNCH_IDS.agent]) {
      store.recordTerminal({
        threadId: T,
        launchId: id,
        outcome: "completed",
        evidence: "task-notification completed",
        nowMs: 5_000,
      });
    }
    expect(store.getResult(T, LAUNCH_IDS.background_shell)?.artifact).toEqual({
      kind: "adopted_output",
      path: "/nonexistent/tasks/shell-1.output",
    });
    expect(store.getResult(T, LAUNCH_IDS.monitor)?.artifact).toEqual({
      kind: "relaunch_output",
      path: "/parent/continuity/mon.output",
    });
    expect(store.getResult(T, LAUNCH_IDS.agent)?.artifact).toBeNull();
    store.close();
  });

  it("carries no command text or output: the shell's launch command never reaches the result table or the database file", () => {
    const path = tempDbPath();
    const store = openContinuityStore(path);
    const observer = createContinuityObserver({ store, threadId: T, nowFn: () => 1_000 });
    for (const line of LAUNCHES.background_shell.lines()) observer.observeLine(line);
    qualifyAll(store, T, 2_000);
    store.allocateGeneration({
      threadId: T,
      oldSessionId: "old",
      launchIds: [LAUNCH_IDS.background_shell],
      nowMs: 3_000,
    });
    const long = `x${" \n\t".repeat(50)}${"y".repeat(5_000)} TRAILING-MARKER`;
    store.recordTerminal({
      threadId: T,
      launchId: LAUNCH_IDS.background_shell,
      outcome: "failed",
      evidence: long,
      nowMs: 5_000,
    });
    const result = store.getResult(T, LAUNCH_IDS.background_shell)!;
    expect(result.label).toBe("background command (shell-1)");
    expect(result.evidence.length).toBeLessThanOrEqual(MAX_RESULT_EVIDENCE_CHARS);
    expect(result.evidence).toMatch(/^[ -~]+$/);
    expect(result.evidence).not.toContain("TRAILING-MARKER");
    store.close();
    const bytes = dbBytes(path);
    // The launch command (with its bearer token) is never persisted anywhere in the database.
    expect(bytes).not.toContain("Bearer sk-SECRET");
    expect(bytes).not.toContain("curl -H");
  });

  it("boundedEvidence flattens whitespace, replaces non-printables, and truncates with a marker", () => {
    expect(boundedEvidence("  a \n b\t c ")).toBe("a b c");
    expect(boundedEvidence("éx")).toBe("?x");
    expect(boundedEvidence("z".repeat(200), 10)).toBe("zzzzzzzzz~");
  });

  it("results survive reopening, and reading pending results never changes their delivery state", () => {
    const { path, store } = carried(["a"]);
    store.recordTerminal({ threadId: T, launchId: "a", outcome: "killed", evidence: "orphan", nowMs: 5_000 });
    store.close();
    const reopened = openContinuityStore(path);
    expect(reopened.listPendingResults(T)).toHaveLength(1);
    expect(reopened.listPendingResults(T)).toHaveLength(1);
    expect(reopened.getResult(T, "a")).toMatchObject({ delivery: "pending", outcome: "killed" });
    reopened.close();
  });

  it("a malformed result row fails loud", () => {
    const { path, store } = carried(["a"]);
    store.recordTerminal({ threadId: T, launchId: "a", outcome: "completed", evidence: "ok", nowMs: 5_000 });
    store.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE cc_continuity_results SET outcome = 'vanished' WHERE launch_id = 'a'").run();
    db.close();
    const reopened = openContinuityStore(path);
    expect(() => reopened.listPendingResults(T)).toThrow(/malformed result row/);
    expect(() => reopened.getResult(T, "a")).toThrow(/malformed result row/);
    reopened.close();
  });
});

describe("the rebuilt session recognizes carried work", () => {
  it("carriedOpenWork reproduces every carried item's fold key and launch identity, skipping terminal and never-carried work", () => {
    const path = tempDbPath();
    const store = openContinuityStore(path);
    const observer = createContinuityObserver({ store, threadId: T, nowFn: () => 1_000 });
    for (const line of allLaunchLines()) observer.observeLine(line);
    qualifyAll(store, T, 2_000);
    const ids = Object.values(LAUNCH_IDS);
    store.allocateGeneration({ threadId: T, oldSessionId: "old", launchIds: ids, nowMs: 3_000 });
    store.recordTerminal({
      threadId: T,
      launchId: LAUNCH_IDS.workflow,
      outcome: "completed",
      evidence: "done",
      nowMs: 4_000,
    });
    store.recordLaunch(launch("local", 4_500));
    const seed = carriedOpenWork(store, T);
    expect(seed.map(asyncWorkIdentity)).toEqual([
      LAUNCH_IDS.agent,
      LAUNCH_IDS.background_shell,
      LAUNCH_IDS.monitor,
      LAUNCH_IDS.scheduled_wakeup,
    ]);
    expect(seed.map((w) => w.key)).toEqual(["agent-1", "shell-1", "mon-1", "scheduled_wakeup"]);
    expect(seed.find((w) => w.family === "scheduled_wakeup")?.scheduledForMs).toBe(
      LAUNCHES.scheduled_wakeup.scheduledForMs,
    );

    // A fresh fold seeded with them closes the same durable items on terminal evidence — and emits no launches.
    const events: AsyncWorkEvent[] = [];
    const fold = createAsyncWorkFold((event) => events.push(event), seed);
    observeAsyncWorkLine(notification({ taskIds: ["agent-1"], status: "completed" }), fold);
    observeAsyncWorkLine(notification({ taskIds: ["shell-1"], status: "killed" }), fold);
    expect(events.map((e) => [e.kind, asyncWorkIdentity(e.work)])).toEqual([
      ["terminal", LAUNCH_IDS.agent],
      ["terminal", LAUNCH_IDS.background_shell],
    ]);
    expect(fold.open.size).toBe(2);
    // An unseeded fold sees the same lines as nothing.
    const bare = createAsyncWorkFold();
    observeAsyncWorkLine(notification({ taskIds: ["agent-1"], status: "completed" }), bare);
    expect(bare.open.size).toBe(0);
    store.close();
  });
});

describe("Control Panel visibility", () => {
  it("names up to three finished carried items by their stored label and outcome, then counts the rest", () => {
    expect(formatPendingResultRows([])).toEqual([]);
    expect(formatPendingResultRows([{ label: 'monitor "CI watch" (mon-1)', outcome: "stopped" }])).toEqual([
      'carried work finished: monitor "CI watch" (mon-1) — stopped',
    ]);
    const five = ["a", "b", "c", "d", "e"].map((id) => ({ label: `background agent (${id})`, outcome: "completed" }));
    expect(formatPendingResultRows(five)).toEqual([
      "carried work finished: background agent (a) — completed",
      "carried work finished: background agent (b) — completed",
      "carried work finished: background agent (c) — completed",
      "2 more carried item(s) finished — see cc-lhc tasks status",
    ]);
  });
});
