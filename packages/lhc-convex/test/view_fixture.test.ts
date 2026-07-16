import { describe, expect, test } from "vitest";
import type { DerivationReportEntry } from "../src/client/index.js";
import { derivedThreadFixture, serviceFixture, validEvent } from "./fixtures/index.js";

const TRANSIENT_REASON = "rate_limit: scripted failure (fixture)";
const PERMANENT_REASON = "content_refusal: scripted permanent failure (fixture)";

async function failedDerivedFixture() {
  const fixture = await derivedThreadFixture();
  const subjects = await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("derivations").collect();
    const summaries = rows.filter(
      (row) =>
        row.instance === fixture.instance &&
        row.thread === fixture.threadId &&
        row.scope === "message" &&
        row.deriv === "tool_result_summary",
    );
    const transient = summaries[2];
    const permanent = summaries[4];
    if (transient === undefined || permanent === undefined) throw new Error("fixture tool summaries missing");
    await ctx.db.patch("derivations", transient._id, {
      state: "failed",
      content: undefined,
      reason: TRANSIENT_REASON,
      metadata: undefined,
      derivedAt: "2026-01-01T00:00:00.000Z",
    });
    await ctx.db.patch("derivations", permanent._id, {
      state: "failed",
      content: undefined,
      reason: PERMANENT_REASON,
      metadata: undefined,
      derivedAt: "2026-01-01T00:00:00.000Z",
    });
    return { transient: transient.subject, permanent: permanent.subject };
  });
  return { ...fixture, ...subjects };
}

async function blockedSibling() {
  const fixture = serviceFixture();
  const { filePath, threadId } = await fixture.createThread();
  const accepted = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "blocked turn" } }),
    validEvent("assistant_text", { payload: { text: "answer" } }),
    validEvent("turn_end"),
  ]);
  if (!accepted.ok) throw new Error(accepted.error.reason);
  await fixture.test.run(async (ctx) => {
    const turns = await ctx.db.query("turns").collect();
    const turn = turns.find((row) => row.instance === fixture.instance && row.thread === threadId && row.turn === "t1");
    if (turn === undefined) throw new Error("turn missing");
    await ctx.db.patch("turns", turn._id, { deletedAt: "2026-01-01T00:00:00.000Z" });
  });
  const drained = await fixture.sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
  return { ...fixture, filePath, threadId };
}

function find(rows: readonly DerivationReportEntry[], subjectId: string) {
  return rows.find((row) => row.subjectId === subjectId && row.derivationType === "tool_result_summary");
}

describe("view fixture and configuration parity", () => {
  test("rejects a profile whose percentages do not sum to 100", () => {
    expect(() =>
      serviceFixture({
        view: {
          profiles: [
            {
              name: "skewed",
              lowerBound: 50_000,
              percentages: { full: 30, smooth: 35, detailed: 20, brief: 20 },
            },
          ],
        },
      }),
    ).toThrow(/profile "skewed" percentages must be non-negative and sum to 100/);
  });

  test("rejects visibility budgets violating max greater than target", () => {
    expect(() => serviceFixture({ view: { visibility: { maxTokens: 24_000, targetTokens: 24_000 } } })).toThrow(
      /visibility\.maxTokens \(24000\) must be greater than targetTokens \(24000\)/,
    );
  });

  test("rejects a non-positive profile lower bound", () => {
    expect(() =>
      serviceFixture({
        view: {
          profiles: [
            {
              name: "hollow",
              lowerBound: 0,
              percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 },
            },
          ],
        },
      }),
    ).toThrow(/profile "hollow" lowerBound must be a positive number, got 0/);
  });

  test("rejects a partial profile that overrides no built-in", () => {
    expect(() => serviceFixture({ view: { profiles: [{ name: "mystery", lowerBound: 64_000 }] } })).toThrow(
      /profile "mystery" is partial but overrides no built-in/,
    );
  });

  test("normalization applies defaults and merges a built-in override field-wise", async () => {
    const fixture = serviceFixture({ view: { profiles: [{ name: "coding", lowerBound: 64_000 }] } });
    await fixture.createThread();
    const view = await fixture.test.run(async (ctx) => {
      const instances = await ctx.db.query("instances").collect();
      const row = instances.find((candidate) => candidate.instance === fixture.instance);
      return (row?.config as { view?: unknown } | undefined)?.view;
    });
    expect(view).toMatchObject({
      compactThreshold: 160_000,
      visibility: { maxTokens: 64_000, targetTokens: 32_000 },
      profiles: {
        coding: {
          name: "coding",
          lowerBound: 64_000,
          percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 },
        },
        continuation: {
          name: "continuation",
          lowerBound: 120_000,
          percentages: { full: 30, smooth: 30, detailed: 20, brief: 20 },
        },
        conversation: { percentages: { full: 12, smooth: 48, detailed: 20, brief: 20 } },
      },
    });
  });

  test("the committed fixture exposes ready turn and closed-chunk artifacts through reports", async () => {
    const fixture = await derivedThreadFixture();
    const report = await fixture.sdk.turns.report({ filePath: fixture.filePath });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const renderings = report.value.filter((row) => row.derivationType === "turn_rendering");
    expect(renderings.map((row) => row.subjectId).sort()).toEqual([...fixture.turnIds].sort());
    expect(renderings.every((row) => row.state === "ready" && row.content !== undefined)).toBe(true);
    const chunks = await fixture.sdk.turns.listChunks({ filePath: fixture.filePath });
    expect(chunks.ok && chunks.value.map((chunk) => `${chunk.chunkId}:${chunk.status}`)).toEqual([
      "c1:closed",
      "c2:closed",
      "c3:closed",
      "c4:open",
    ]);
    for (const chunkId of ["c1", "c2", "c3"]) {
      const summaries = await fixture.sdk.turns.report({ filePath: fixture.filePath }, { chunkId });
      expect(
        summaries.ok &&
          summaries.value.filter((row) => row.derivationType.startsWith("chunk_summary_")).map((row) => row.state),
      ).toEqual(["ready", "ready"]);
    }
  });

  test("the fixture's transient and permanent failures read back with no live queue detail", async () => {
    const fixture = await failedDerivedFixture();
    const report = await fixture.sdk.messages.report({ filePath: fixture.filePath }, { notReady: true });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(find(report.value, fixture.transient)).toMatchObject({ state: "failed", reason: TRANSIENT_REASON });
    expect(find(report.value, fixture.permanent)).toMatchObject({ state: "failed", reason: PERMANENT_REASON });
    expect(find(report.value, fixture.transient)?.queue).toBeUndefined();
    expect(find(report.value, fixture.permanent)?.queue).toBeUndefined();
  });

  test("real turn source damage lands both turn-owned derivations blocked", async () => {
    const fixture = await blockedSibling();
    const report = await fixture.sdk.turns.report({ filePath: fixture.filePath }, { turnId: "t1" });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const blocked = report.value.filter((row) => row.state === "blocked");
    expect(blocked.map((row) => row.derivationType).sort()).toEqual(["pre_detailed_assembly", "turn_rendering"]);
    expect(blocked.every((row) => row.reason?.startsWith("source_damaged: turn t1 not found"))).toBe(true);
  });

  test("failed derivations preserve distinguishable reason classes", async () => {
    const fixture = await failedDerivedFixture();
    const report = await fixture.sdk.messages.report({ filePath: fixture.filePath }, { notReady: true });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const transient = find(report.value, fixture.transient)?.reason;
    const permanent = find(report.value, fixture.permanent)?.reason;
    expect(transient).toBe(TRANSIENT_REASON);
    expect(permanent).toBe(PERMANENT_REASON);
    expect(transient).not.toBe(permanent);
  });

  test("two open turns refuse canonical intake with state corruption", async () => {
    const fixture = serviceFixture();
    const { filePath, threadId } = await fixture.createThread();
    await fixture.test.run(async (ctx) => {
      await ctx.db.insert("turns", {
        instance: fixture.instance,
        thread: threadId,
        turn: "t-corrupt",
        turnOrder: 999,
        status: "open",
        openedAtEventOrder: 999,
      });
    });
    const refused = await fixture.sdk.intakeStream.messageEvents({ filePath }, [validEvent("user_prompt")]);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatchObject({ errorClass: "state_corruption", code: "turn_state_corrupt" });
    expect(refused.error.reason).toContain("2 open turns");
  });
});
