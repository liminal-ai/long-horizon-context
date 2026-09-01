/**
 * LIM-145 AC-2.8 (TC-2.8a/b/c): work that changes state around the snapshot is
 * represented by its last verified state, once, never lost. Closure is a pure
 * read of the store — repeated calls give the same answer.
 */
import { describe, expect, it } from "vitest";

import { createContinuityObserver } from "../../src/continuity/observe.js";
import { closeContinuitySnapshot, snapshotContinuity } from "../../src/continuity/snapshot.js";
import { openContinuityStore } from "../../src/continuity/store.js";
import { LAUNCH_IDS, LAUNCHES, notification, qualifyAll, tempDbPath, toolResult, toolUse } from "./helpers.js";

const T = "th_closure";

function rig() {
  const store = openContinuityStore(tempDbPath());
  let now = 1_000;
  const observer = createContinuityObserver({ store, threadId: T, nowFn: () => (now += 1) });
  /** Feed lines and qualify every new active launch, as an adapter would before the seam. */
  const feed = (lines: Parameters<typeof observer.observeLine>[0][], qualify = true) => {
    for (const line of lines) observer.observeLine(line);
    now += 1;
    if (qualify) qualifyAll(store, T, now);
  };
  const snapshot = () => {
    now += 100;
    const result = snapshotContinuity(store, { threadId: T, oldSessionId: "old", nowMs: now });
    if (!result.ok) throw new Error(result.reason);
    return result.snapshot;
  };
  const close = (generation: number) => {
    now += 100;
    return closeContinuitySnapshot(store, { threadId: T, generation, nowMs: now });
  };
  return { store, feed, snapshot, close };
}

describe("TC-2.8a completes before snapshot", () => {
  it("is not represented as active carryover and is not reported as terminal-since", () => {
    const { store, feed, snapshot, close } = rig();
    feed([...LAUNCHES.agent.lines(), ...LAUNCHES.background_shell.lines()]);
    feed([notification({ taskIds: ["agent-1"], status: "completed" })]);
    const snap = snapshot();
    expect(snap.items.map((item) => item.launchId)).toEqual([LAUNCH_IDS.background_shell]);
    const closure = close(snap.generation);
    expect(closure).toMatchObject({
      closed: true,
      refusal: null,
      terminalSinceSnapshot: [],
      newWork: [],
      unverified: [],
      unqualified: [],
    });
    expect(closure.carried.map((item) => item.launchId)).toEqual([LAUNCH_IDS.background_shell]);
    expect(store.getGeneration(T, snap.generation)?.state).toBe("closed");
    store.close();
  });
});

describe("TC-2.8b completes during replacement construction", () => {
  it("is delivered once as terminal, not carried as a permanently active entry", () => {
    const { store, feed, snapshot, close } = rig();
    feed([...LAUNCHES.agent.lines(), ...LAUNCHES.workflow.lines()]);
    const snap = snapshot();
    expect(snap.items).toHaveLength(2);
    feed([notification({ taskIds: ["agent-1"], status: "failed", summary: "boom" })]);
    const closure = close(snap.generation);
    expect(closure.closed).toBe(true);
    expect(closure.carried.map((item) => item.launchId)).toEqual([LAUNCH_IDS.workflow]);
    expect(closure.terminalSinceSnapshot).toEqual([
      {
        launchId: LAUNCH_IDS.agent,
        family: "agent",
        label: 'background agent "reviewer" (agent-1)',
        terminal: { outcome: "failed", evidence: "task-notification failed", observedAtMs: expect.any(Number) },
      },
    ]);
    // Once: a second read of the closed generation says the same thing.
    expect(close(snap.generation)).toEqual(closure);
    store.close();
  });
});

describe("TC-2.8c new work starts before ownership", () => {
  it("refuses closure so the handoff cannot claim a complete transfer, and a fresh snapshot includes it", () => {
    const { store, feed, snapshot, close } = rig();
    feed(LAUNCHES.agent.lines());
    const first = snapshot();
    feed(LAUNCHES.background_shell.lines());
    const refused = close(first.generation);
    expect(refused).toMatchObject({ closed: false, refusal: "new_work", unverified: [] });
    expect(refused.newWork.map((item) => item.launchId)).toEqual([LAUNCH_IDS.background_shell]);
    expect(refused.newWork[0]?.carryMode).toBe("adopt");
    expect(refused.carried.map((item) => item.launchId)).toEqual([LAUNCH_IDS.agent]);
    expect(store.getGeneration(T, first.generation)?.state).toBe("open");

    const second = snapshot();
    expect(second.generation).toBe(first.generation + 1);
    expect(second.items.map((item) => item.launchId)).toEqual([LAUNCH_IDS.agent, LAUNCH_IDS.background_shell]);
    expect(store.getGeneration(T, first.generation)?.state).toBe("superseded");
    expect(close(first.generation)).toMatchObject({ closed: false, refusal: "superseded" });
    expect(close(second.generation)).toMatchObject({ closed: true, refusal: null, newWork: [] });
    store.close();
  });

  it("unqualified new work refuses closure by identity and is never carried", () => {
    const { store, feed, snapshot, close } = rig();
    feed(LAUNCHES.agent.lines());
    const snap = snapshot();
    feed(LAUNCHES.monitor.lines(), false);
    const refused = close(snap.generation);
    expect(refused).toMatchObject({
      closed: false,
      refusal: "unqualified_items",
      unqualified: [LAUNCH_IDS.monitor],
      newWork: [],
    });
    expect(refused.carried.map((item) => item.launchId)).toEqual([LAUNCH_IDS.agent]);
    // A fresh snapshot cannot claim it either until an adapter qualifies it.
    expect(snapshotContinuity(store, { threadId: T, oldSessionId: "old", nowMs: 9_000 })).toEqual({
      ok: false,
      reason: "unqualified_items",
      launchIds: [LAUNCH_IDS.monitor],
    });
    expect(store.getGeneration(T, snap.generation)?.state).toBe("open");
    store.close();
  });

  it("new work that already finished was never carried and does not block closure", () => {
    const { store, feed, snapshot, close } = rig();
    feed(LAUNCHES.agent.lines());
    const snap = snapshot();
    feed(
      [
        toolUse("toolu_late", "Bash", { command: "true", run_in_background: true }),
        toolResult("toolu_late", { stdout: "", stderr: "", backgroundTaskId: "late-1" }),
      ],
      false,
    );
    feed([notification({ taskIds: ["late-1"], status: "completed" })], false);
    expect(close(snap.generation)).toMatchObject({ closed: true, newWork: [], terminalSinceSnapshot: [] });
    store.close();
  });
});

describe("verification during construction", () => {
  it("an item that stops being verified refuses closure without a claim", () => {
    const { store, feed, snapshot, close } = rig();
    feed(LAUNCHES.workflow.lines());
    const snap = snapshot();
    store.setVerified({ threadId: T, launchId: LAUNCH_IDS.workflow, verified: false, nowMs: 9_000 });
    expect(close(snap.generation)).toMatchObject({
      closed: false,
      refusal: "unverified_items",
      unverified: [LAUNCH_IDS.workflow],
      carried: [],
    });
    expect(store.getGeneration(T, snap.generation)?.state).toBe("open");
    store.close();
  });

  it("an unknown generation is refused, never fabricated", () => {
    const { store, close } = rig();
    expect(close(7)).toMatchObject({ closed: false, refusal: "unknown_generation" });
    store.close();
  });
});
