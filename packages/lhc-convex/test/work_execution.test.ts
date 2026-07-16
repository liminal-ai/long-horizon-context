// Queue execution and drain — the applicable in-process lifecycle matrix:
// TC-1.1 (serial FIFO drain; rows removed at terminal transition; derivedAt
// monotone across completion order), TC-1.6 (manual accumulation until drain),
// TC-1.7 (an unknown kind does not gate the drain — crash-never-gates), TC-1.8
// (a terminal failure is durable and the drain continues), and the maxItems
// bound.
//
// Substrate-only / removed-upstream frozen legs (documented n/a in the ledger):
//   - ALL lease/claim-fencing legs — `claimHeadWorkItem`, `setHeadClaimExpiry`,
//     "an expired claim is failed without rerunning it", the claim-ownership
//     and "shared durable claim" concurrency tests — exercise a lease/claim
//     model that was REMOVED upstream (one-shot execution, no retry/backoff/
//     lease). No such rows or timers exist on Convex.
//   - The background-scheduling legs (TC-1.2 coalescing, TC-1.5 first-touch
//     catch-up, "sync derive wakes the background scheduler", "reopening
//     recovers leftover rows when the process engages") drive a scheduled
//     background drain, which convex-test cannot advance (harness limitation).
//     Durable recovery of leftover rows is covered by work_queue.test.ts.
//   - The completion-exactness legs ("missing one expected write rolls back",
//     "partial targets rolls back", "an extra handler write target fails
//     closed", "a stale queued terminal failure … without stamping the newer
//     derivation") inject mismatched handler results through
//     `registerTestWorkHandlers`. The Convex handler is the component's own and
//     cannot be swapped for a partial-write double; the version-check /
//     supersede behavior those legs protect is covered by mutations.test.ts.
//   - The sync-derive collision-policy and concurrent-derive legs assert
//     version-race fencing under true concurrency (convex-test runs serially).
//     The derive happy-paths are covered by report_repair.test.ts.
//
// Disposition strings are aggregated on Convex: `work.drain` returns
// `{ claimed, completed, failed, blocked, staleDiscarded, remaining }` rather
// than the frozen per-item `ran[]`, so per-item dispositions are asserted as
// those aggregate counts plus the durable derivation states.
import { beforeEach, describe, expect, test } from "vitest";
import type { DrainReport, Lhc, MessageEventInput } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

let fixture: ServiceFixture;
let sdk: Lhc;

beforeEach(() => {
  fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1 } } });
  sdk = fixture.sdk;
});

async function send(target: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await target.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`batch failed: ${result.error.reason}`);
}

async function drain(target: Lhc, filePath: string, opts?: { maxItems?: number }): Promise<DrainReport> {
  const result = await target.work.drain({ filePath }, opts);
  if (!result.ok) throw new Error(`drain failed: ${result.error.reason}`);
  return result.value;
}

async function forms(thread: string): Promise<Map<string, Record<string, unknown>>> {
  const rows = await fixture.test.run(async (ctx) => {
    const all = await ctx.db.query("derivations").collect();
    return all.filter((row) => row.instance === fixture.instance && row.thread === thread);
  });
  return new Map(rows.map((row) => [`${row.scope}/${row.subject}/${row.deriv}`, row as Record<string, unknown>]));
}

async function liveCount(thread: string): Promise<number> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    return rows.filter((row) => row.instance === fixture.instance && row.thread === thread).length;
  });
}

describe("TC-1.1: a drain runs queued items one at a time, in queue order, deleting rows at terminal transition", () => {
  test("items across both owners run to ready; rows are deleted; derivedAt is monotone in completion order", async () => {
    const { filePath, threadId } = await fixture.createThread();
    await send(sdk, filePath, [validEvent("user_prompt"), validEvent("assistant_text"), validEvent("turn_end")]);

    const report = await drain(sdk, filePath);
    // Aggregate dispositions: three items (prompt smoothing, turn derivation,
    // and the turn's detailed compression enqueued at completion) all done.
    expect(report.claimed).toBe(3);
    expect(report.completed).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.blocked).toBe(0);
    expect(report.remaining).toBe(0);

    const derived = await forms(threadId);
    for (const key of [
      "message/m1/smoothed_prompt",
      "turn/t1/turn_rendering",
      "turn/t1/pre_detailed_assembly",
      "turn/t1/detailed_turn_compression",
    ]) {
      expect(derived.get(key)?.["state"]).toBe("ready");
    }
    // Terminal transition removed every work row.
    expect(await liveCount(threadId)).toBe(0);

    // derivedAt is monotone across the serial completion order: the prompt
    // completes before the turn, which completes before the detailed compression.
    const at = (key: string) => String(derived.get(key)?.["derivedAt"] ?? "");
    expect(at("message/m1/smoothed_prompt") <= at("turn/t1/turn_rendering")).toBe(true);
    expect(at("turn/t1/turn_rendering") <= at("turn/t1/detailed_turn_compression")).toBe(true);
  });
});

describe("TC-1.6: manual mode — rows accumulate durably and run only when drain is invoked", () => {
  test("queued work sits until work.drain; artifacts land after", async () => {
    const { filePath, threadId } = await fixture.createThread();
    await send(sdk, filePath, [validEvent("user_prompt")]);

    // Before drain: the row is durable and the derivation is pending.
    expect(await liveCount(threadId)).toBe(1);
    expect((await forms(threadId)).get("message/m1/smoothed_prompt")?.["state"]).toBe("pending");

    await drain(sdk, filePath);
    expect(await liveCount(threadId)).toBe(0);
    expect((await forms(threadId)).get("message/m1/smoothed_prompt")?.["state"]).toBe("ready");
  });
});

describe("TC-1.7: an unregistered kind does not gate the drain (crash-never-gates)", () => {
  test("a bogus-kind row ahead of a valid item does not stop the valid item running", async () => {
    const { filePath, threadId } = await fixture.createThread();
    await send(sdk, filePath, [validEvent("user_prompt")]); // prompt_smoothing at seq 1

    // Seed a bogus-kind work item ahead of the valid one (lower seq claims first).
    await fixture.test.run(async (ctx) => {
      await ctx.db.insert("workItems", {
        instance: fixture.instance,
        thread: threadId,
        workItem: "w-bogus",
        seq: 0,
        owner: "messages",
        kind: "bogus_kind",
        sourceRef: {},
        sourceVersion: 1,
        status: "queued",
        queuedAt: new Date().toISOString(),
        derivs: [],
      });
    });

    const report = await drain(sdk, filePath);
    // The bogus item is recognized as an unknown kind (blocked, terminal), and
    // the valid item behind it still runs to ready.
    expect(report.claimed).toBe(2);
    expect(report.blocked).toBe(1);
    expect(report.completed).toBe(1);
    expect(report.remaining).toBe(0);
    expect((await forms(threadId)).get("message/m1/smoothed_prompt")?.["state"]).toBe("ready");
    expect(await liveCount(threadId)).toBe(0);
  });
});

describe("TC-1.8: failed work is terminal and the drain continues", () => {
  test("the first failure marks the derivation failed and the next item still runs", async () => {
    const scripted = serviceFixture({
      models: { smoothed_prompt: "fail" },
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
    });
    const { filePath, threadId } = await scripted.createThread();
    // Prompt smoothing (fails) at seq 1, tool_result summary (canned success) at
    // seq 2; the turn stays open so no turn derivation recovers the failed prompt.
    await send(scripted.sdk, filePath, [validEvent("user_prompt"), validEvent("tool_result")]);

    const report = await scripted.sdk.work.drain({ filePath });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.claimed).toBe(2);
    expect(report.value.failed).toBe(1);
    expect(report.value.completed).toBe(1);
    expect(report.value.remaining).toBe(0);

    const derived = await scripted.test.run(async (ctx) => {
      const rows = await ctx.db.query("derivations").collect();
      return rows.filter((row) => row.instance === scripted.instance && row.thread === threadId);
    });
    const byKey = new Map(derived.map((row) => [`${row.scope}/${row.subject}/${row.deriv}`, row]));
    // The failure is durable and terminal; the next item ran to ready.
    expect(byKey.get("message/m1/smoothed_prompt")?.state).toBe("failed");
    expect(byKey.get("message/m2/tool_result_summary")?.state).toBe("ready");
    // Both work rows were deleted at their terminal transition.
    const live = await scripted.test.run(async (ctx) => {
      const rows = await ctx.db.query("workItems").collect();
      return rows.filter((row) => row.instance === scripted.instance && row.thread === threadId).length;
    });
    expect(live).toBe(0);
  });
});

describe("maxItems bounds the drain", () => {
  test("maxItems stops the drain and reports the remainder still queued", async () => {
    const { filePath, threadId } = await fixture.createThread();
    await send(sdk, filePath, [validEvent("user_prompt"), validEvent("tool_result")]); // two message items

    const report = await drain(sdk, filePath, { maxItems: 1 });
    expect(report.claimed).toBe(1);
    expect(report.remaining).toBe(1);

    // One item ran; one is still durably queued.
    expect(await liveCount(threadId)).toBe(1);
    const status = await sdk.work.status({ filePath });
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value.queued).toBe(1);
  });
});

describe("crash-never-gates: a running row left by a crashed drain never blocks queued work", () => {
  test("the stuck head stays running (never rerun) while all queued work behind it drains", async () => {
    const { filePath, threadId } = await fixture.createThread();
    await send(sdk, filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);

    // Simulate a drain that claimed the head item and then crashed before
    // completing it: the row is left status=running, never terminally resolved.
    const stuck = await fixture.test.run(async (ctx) => {
      const queued = (await ctx.db.query("workItems").collect())
        .filter((row) => row.instance === fixture.instance && row.thread === threadId && row.status === "queued")
        .sort((a, b) => a.seq - b.seq);
      const head = queued[0];
      if (head === undefined) throw new Error("expected queued work");
      await ctx.db.patch(head._id, { status: "running", startedAt: "2026-01-01T00:00:00.000Z" });
      return { seq: head.seq };
    });

    await drain(sdk, filePath);

    const after = await fixture.test.run(async (ctx) => {
      const rows = (await ctx.db.query("workItems").collect()).filter(
        (row) => row.instance === fixture.instance && row.thread === threadId,
      );
      return {
        stuckStillRunning: rows.some((row) => row.seq === stuck.seq && row.status === "running"),
        queuedRemaining: rows.filter((row) => row.status === "queued").length,
      };
    });

    // The crashed item is neither rerun nor removed — it stays running forever.
    expect(after.stuckStillRunning).toBe(true);
    // And it never gated: every queued item behind it drained to a terminal state.
    expect(after.queuedRemaining).toBe(0);
  });
});
