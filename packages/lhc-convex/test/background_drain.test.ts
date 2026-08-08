/**
 * Background-mode drain durability: enqueued work settles without any manual
 * drain, an exiting drain re-checks the queue transactionally, and a drain
 * that dies mid-item neither gates the queue nor leaves phantom running work.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api.js";
import { conversationTurn, serviceFixture } from "./fixtures/index.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function threadRow(fixture: ReturnType<typeof serviceFixture>, threadId: string) {
  return await fixture.test.run(async (ctx) => {
    const threads = await ctx.db.query("threads").collect();
    return threads.find((row) => row.instance === fixture.instance && row.thread === threadId)!;
  });
}

async function workItems(fixture: ReturnType<typeof serviceFixture>, threadId: string) {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    return rows.filter((row) => row.instance === fixture.instance && row.thread === threadId);
  });
}

async function derivationStates(fixture: ReturnType<typeof serviceFixture>, threadId: string) {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("derivations").collect();
    return rows.filter((row) => row.instance === fixture.instance && row.thread === threadId).map((row) => row.state);
  });
}

/** Live (pending/inProgress) scheduler entries whose function name matches. */
async function liveScheduled(fixture: ReturnType<typeof serviceFixture>, nameFragment: string) {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.system.query("_scheduled_functions").collect();
    return rows.filter(
      (row) => row.name.includes(nameFragment) && (row.state.kind === "pending" || row.state.kind === "inProgress"),
    );
  });
}

describe("background drain durability", () => {
  test("a full intake turn settles through scheduled drains alone", async () => {
    const fixture = serviceFixture({
      mode: "background",
      models: { smoothed_prompt: "success:smoothed prompt" },
    });
    const { filePath, threadId } = await fixture.createThread();
    const intake = await fixture.sdk.intakeStream.messageEvents({ filePath }, conversationTurn());
    expect(intake.ok).toBe(true);

    await fixture.test.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await workItems(fixture, threadId)).toEqual([]);
    const states = await derivationStates(fixture, threadId);
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((state) => state === "ready" || state === "failed")).toBe(true);

    const status = await fixture.sdk.work.status({ filePath });
    expect(status).toEqual({
      ok: true,
      value: { queued: 0, running: 0, drainScheduled: false },
    });
    // The settled thread records no drain: a later enqueue schedules afresh
    // instead of trusting an action that may be past its final claim.
    expect((await threadRow(fixture, threadId)).scheduledDrainId).toBeUndefined();
  });

  test("drainExit reschedules while work remains queued and stands down when empty", async () => {
    const fixture = serviceFixture({ mode: "background" });
    const { filePath, threadId } = await fixture.createThread();
    await fixture.sdk.intakeStream.messageEvents({ filePath }, conversationTurn());

    const before = await threadRow(fixture, threadId);
    const withWork = await fixture.test.mutation(internal.queue.drainExit, {
      instance: fixture.instance,
      thread: threadId,
    });
    expect(withWork).toEqual({ rescheduled: true });
    const rescheduled = await threadRow(fixture, threadId);
    expect(rescheduled.scheduledDrainId).not.toBe(before.scheduledDrainId);

    await fixture.test.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await workItems(fixture, threadId)).toEqual([]);

    const settled = await fixture.test.mutation(internal.queue.drainExit, {
      instance: fixture.instance,
      thread: threadId,
    });
    expect(settled).toEqual({ rescheduled: false });
    expect((await threadRow(fixture, threadId)).scheduledDrainId).toBeUndefined();

    // The empty-queue exit clears the recorded drain id in the same mutation —
    // the enqueue-at-exit race closes here, not eventually via the reaper.
    await fixture.test.run(async (ctx) => {
      const threads = await ctx.db.query("threads").collect();
      const thread = threads.find((row) => row.instance === fixture.instance && row.thread === threadId)!;
      await ctx.db.patch(thread._id, { scheduledDrainId: rescheduled.scheduledDrainId });
    });
    const cleared = await fixture.test.mutation(internal.queue.drainExit, {
      instance: fixture.instance,
      thread: threadId,
    });
    expect(cleared).toEqual({ rescheduled: false });
    expect((await threadRow(fixture, threadId)).scheduledDrainId).toBeUndefined();
  });

  test("the reaper autonomously fails a dead drain's running item and restarts queued work", async () => {
    const fixture = serviceFixture({
      mode: "background",
      models: { smoothed_prompt: "success:smoothed prompt" },
    });
    const { filePath, threadId } = await fixture.createThread();
    await fixture.sdk.intakeStream.messageEvents({ filePath }, conversationTurn());
    const deadDrainId = (await threadRow(fixture, threadId)).scheduledDrainId!;
    await fixture.test.finishAllScheduledFunctions(vi.runAllTimers);

    // A drain that died before its exit gate: the terminal drain id is still
    // recorded while one item sits "running" and another sits "queued".
    const planted = await fixture.test.run(async (ctx) => {
      const derivations = await ctx.db.query("derivations").collect();
      const mine = derivations.filter(
        (row) => row.instance === fixture.instance && row.thread === threadId && row.state === "ready",
      );
      const abandoned = mine.find((row) => row.deriv === "tool_result_summary")!;
      const requeued = mine.find((row) => row.deriv === "smoothed_prompt")!;
      for (const target of [abandoned, requeued]) {
        await ctx.db.patch(target._id, { state: "pending", content: undefined });
      }
      const threads = await ctx.db.query("threads").collect();
      const thread = threads.find((row) => row.instance === fixture.instance && row.thread === threadId)!;
      await ctx.db.patch(thread._id, { scheduledDrainId: deadDrainId });
      const base = {
        instance: fixture.instance,
        thread: threadId,
        owner: "messages" as const,
        queuedAt: new Date(0).toISOString(),
      };
      await ctx.db.insert("workItems", {
        ...base,
        workItem: "w-dead-running",
        seq: 9_998,
        kind: "tool_result_summary",
        sourceRef: { messageId: abandoned.subject },
        sourceVersion: abandoned.sourceVersion,
        status: "running",
        startedAt: new Date(0).toISOString(),
        derivs: [{ scope: abandoned.scope, subject: abandoned.subject, deriv: abandoned.deriv }],
      });
      await ctx.db.insert("workItems", {
        ...base,
        workItem: "w-dead-queued",
        seq: 9_999,
        kind: "prompt_smoothing",
        sourceRef: { messageId: requeued.subject },
        sourceVersion: requeued.sourceVersion,
        status: "queued",
        derivs: [{ scope: requeued.scope, subject: requeued.subject, deriv: requeued.deriv }],
      });
      return {
        abandoned: { subject: abandoned.subject, deriv: abandoned.deriv },
        requeued: { subject: requeued.subject, deriv: requeued.deriv },
      };
    });

    const reaped = await fixture.test.mutation(internal.queue.reapDrain, {
      instance: fixture.instance,
      thread: threadId,
      drain: deadDrainId,
    });
    expect(reaped).toEqual({ outcome: "restarted" });

    const afterReap = await fixture.test.run(async (ctx) => {
      const derivations = await ctx.db.query("derivations").collect();
      const state = (target: { subject: string; deriv: string }) =>
        derivations.find(
          (row) =>
            row.instance === fixture.instance &&
            row.thread === threadId &&
            row.subject === target.subject &&
            row.deriv === target.deriv,
        )!.state;
      return { abandoned: state(planted.abandoned), requeued: state(planted.requeued) };
    });
    expect(afterReap.abandoned).toBe("failed");
    expect(afterReap.requeued).toBe("pending");
    expect((await workItems(fixture, threadId)).filter((row) => row.status === "running")).toEqual([]);

    // The restarted drain settles the queued item with no drain/touch call.
    await fixture.test.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await workItems(fixture, threadId)).toEqual([]);
    expect((await threadRow(fixture, threadId)).scheduledDrainId).toBeUndefined();

    // One-shot means one shot: the abandoned derivation stayed failed with its
    // original reason through the restart — it was never retried to ready.
    const afterSettle = await fixture.test.run(async (ctx) => {
      const derivations = await ctx.db.query("derivations").collect();
      const state = (target: { subject: string; deriv: string }) => {
        const row = derivations.find(
          (candidate) =>
            candidate.instance === fixture.instance &&
            candidate.thread === threadId &&
            candidate.subject === target.subject &&
            candidate.deriv === target.deriv,
        )!;
        return { state: row.state, reason: row.reason };
      };
      return { abandoned: state(planted.abandoned), requeued: state(planted.requeued) };
    });
    expect(afterSettle.abandoned).toEqual({
      state: "failed",
      reason: "drain died while the item was running",
    });
    expect(afterSettle.requeued.state).toBe("ready");
  });

  test("starting a drain arms its reaper on the scheduler", async () => {
    const fixture = serviceFixture({ mode: "background" });
    const { filePath, threadId } = await fixture.createThread();
    expect(await liveScheduled(fixture, "reapDrain")).toEqual([]);

    await fixture.sdk.intakeStream.messageEvents({ filePath }, conversationTurn());

    const drainId = (await threadRow(fixture, threadId)).scheduledDrainId!;
    const reapers = await liveScheduled(fixture, "reapDrain");
    expect(reapers.length).toBe(1);
    expect(reapers[0]!.args).toEqual([{ instance: fixture.instance, thread: threadId, drain: drainId }]);
    expect((await liveScheduled(fixture, "drainLoop")).length).toBe(1);
  });

  test("a reaper watching a still-live drain re-arms another reaper", async () => {
    const fixture = serviceFixture({ mode: "background" });
    const { filePath, threadId } = await fixture.createThread();
    await fixture.sdk.intakeStream.messageEvents({ filePath }, conversationTurn());
    const drainId = (await threadRow(fixture, threadId)).scheduledDrainId!;
    expect((await liveScheduled(fixture, "reapDrain")).length).toBe(1);

    const watched = await fixture.test.mutation(internal.queue.reapDrain, {
      instance: fixture.instance,
      thread: threadId,
      drain: drainId,
    });
    expect(watched).toEqual({ outcome: "watching" });
    expect((await liveScheduled(fixture, "reapDrain")).length).toBe(2);
  });

  test("the reaper stands down for a superseded or unrecorded drain", async () => {
    const fixture = serviceFixture({
      mode: "background",
      models: { smoothed_prompt: "success:smoothed prompt" },
    });
    const { filePath, threadId } = await fixture.createThread();
    await fixture.sdk.intakeStream.messageEvents({ filePath }, conversationTurn());
    const drainId = (await threadRow(fixture, threadId)).scheduledDrainId!;
    await fixture.test.finishAllScheduledFunctions(vi.runAllTimers);

    const reaped = await fixture.test.mutation(internal.queue.reapDrain, {
      instance: fixture.instance,
      thread: threadId,
      drain: drainId,
    });
    expect(reaped).toEqual({ outcome: "superseded" });
  });

  test("a dead drain's running item is failed, logged, and does not gate new work", async () => {
    const fixture = serviceFixture({
      mode: "background",
      models: { smoothed_prompt: "success:smoothed prompt" },
    });
    const { filePath, threadId } = await fixture.createThread();
    await fixture.sdk.intakeStream.messageEvents({ filePath }, conversationTurn());
    const deadDrainId = (await threadRow(fixture, threadId)).scheduledDrainId!;
    await fixture.test.finishAllScheduledFunctions(vi.runAllTimers);

    // Simulate a drain that died mid-item: a terminal drain id is still
    // recorded while an item sits in "running" with its derivation pending —
    // then the next enqueue-side scheduleDrain (via touch) observes the death.
    const planted = await fixture.test.run(async (ctx) => {
      const derivations = await ctx.db.query("derivations").collect();
      const target = derivations.find(
        (row) => row.instance === fixture.instance && row.thread === threadId && row.state === "ready",
      )!;
      await ctx.db.patch(target._id, { state: "pending", content: undefined });
      const threads = await ctx.db.query("threads").collect();
      const thread = threads.find((row) => row.instance === fixture.instance && row.thread === threadId)!;
      await ctx.db.patch(thread._id, { scheduledDrainId: deadDrainId });
      await ctx.db.insert("workItems", {
        instance: fixture.instance,
        thread: threadId,
        workItem: "w-dead-drain",
        seq: 9_999,
        owner: "messages",
        kind: "message_derivation",
        sourceRef: { messageId: target.subject },
        sourceVersion: target.sourceVersion,
        status: "running",
        queuedAt: new Date(0).toISOString(),
        startedAt: new Date(0).toISOString(),
        derivs: [{ scope: target.scope, subject: target.subject, deriv: target.deriv }],
      });
      return { scope: target.scope, subject: target.subject, deriv: target.deriv };
    });

    const touched = await fixture.sdk.work.touch({ filePath });
    expect(touched.ok).toBe(true);

    const remaining = await workItems(fixture, threadId);
    expect(remaining.filter((row) => row.status === "running")).toEqual([]);

    const failure = await fixture.test.run(async (ctx) => {
      const derivations = await ctx.db.query("derivations").collect();
      const row = derivations.find(
        (candidate) =>
          candidate.instance === fixture.instance &&
          candidate.thread === threadId &&
          candidate.subject === planted.subject &&
          candidate.deriv === planted.deriv,
      )!;
      const logs = await ctx.db.query("logs").collect();
      const warning = logs.find(
        (entry) =>
          entry.instance === fixture.instance &&
          entry.thread === threadId &&
          entry.level === "warning" &&
          entry.subject === planted.subject,
      );
      return { state: row.state, reason: row.reason, warned: warning !== undefined };
    });
    expect(failure.state).toBe("failed");
    expect(failure.reason).toBe("drain died while the item was running");
    expect(failure.warned).toBe(true);

    await fixture.test.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await fixture.sdk.work.status({ filePath });
    expect(status).toEqual({
      ok: true,
      value: { queued: 0, running: 0, drainScheduled: false },
    });
  });
});
