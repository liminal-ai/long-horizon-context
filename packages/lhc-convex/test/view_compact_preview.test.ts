import { describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput, PreviewCompactOutcome } from "../src/client/index.js";
import { derivedThreadFixture, eventBatch, serviceFixture, validEvent } from "./fixtures/index.js";

const TARGET = { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } };
const GRADIENT = { lowerBound: 400, percentages: { full: 25, smooth: 16, detailed: 10, brief: 49 } };
const ALL_FITS = {
  lowerBound: 1_000_000,
  percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
};
const NEAR_NO_OP = { lowerBound: 50, percentages: { full: 10, smooth: 10, detailed: 10, brief: 70 } };

function okPreview(
  result: Awaited<ReturnType<Lhc["threadView"]["previewCompact"]>>,
): NonNullable<PreviewCompactOutcome["preview"]> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.reason);
  expect(result.value.kind).toBe("ok");
  if (result.value.kind !== "ok" || result.value.preview === undefined) throw new Error("preview missing");
  return result.value.preview;
}

async function previewAndCompact(sdk: Lhc, filePath: string, params: typeof TARGET) {
  const preview = await sdk.threadView.previewCompact({ filePath }, { params });
  const compact = await sdk.threadView.compact({ filePath }, { params });
  return { preview, compact };
}

async function fourTurnFixture() {
  const fixture = serviceFixture();
  const { filePath } = await fixture.createThread();
  const events: MessageEventInput[] = [];
  for (let turn = 1; turn <= 4; turn += 1) {
    events.push(
      validEvent("user_prompt", { payload: { text: `brief turn ${turn}` } }),
      validEvent("assistant_text", { payload: { text: `ok ${turn}` } }),
      validEvent("turn_end"),
    );
  }
  const accepted = await fixture.sdk.intakeStream.messageEvents({ filePath }, events);
  if (!accepted.ok) throw new Error(accepted.error.reason);
  const drained = await fixture.sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
  return { ...fixture, filePath };
}

async function viewCount(fixture: ReturnType<typeof serviceFixture>, thread: string) {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("threadViews").collect();
    return rows.filter((row) => row.instance === fixture.instance && row.thread === thread).length;
  });
}

describe("compact preview parity", () => {
  test("all-fit corpus previews and compacts at the origin with the first message anchor", async () => {
    const fixture = serviceFixture();
    const { filePath } = await fixture.createThread();
    for (let turn = 0; turn < 3; turn += 1) {
      const accepted = await fixture.sdk.intakeStream.messageEvents(
        { filePath },
        eventBatch(["user_prompt", "assistant_text", "turn_end"]),
      );
      expect(accepted.ok).toBe(true);
    }
    const { preview, compact } = await previewAndCompact(fixture.sdk, filePath, ALL_FITS);
    const value = okPreview(preview);
    expect(value).toMatchObject({ compactPoint: 0, wouldProduceBands: false, firstKeptMessageId: "m1" });
    expect(compact.ok && compact.value).toMatchObject({ compactPoint: 0, firstKeptMessageId: "m1" });
  });

  test("the committed derived corpus snaps preview and compact to t8 close", async () => {
    const fixture = await derivedThreadFixture();
    const { preview, compact } = await previewAndCompact(fixture.sdk, fixture.filePath, TARGET);
    const value = okPreview(preview);
    expect(value).toMatchObject({ compactPoint: 48, wouldProduceBands: true });
    expect(compact.ok && compact.value.compactPoint).toBe(48);
    const turns = await fixture.sdk.turns.listTurns({ filePath: fixture.filePath });
    expect(turns.ok && turns.value.find((turn) => turn.turnId === "t8")?.closedAtEventOrder).toBe(48);
  });

  test("near-no-op keeps one brief band and snaps to t3 close", async () => {
    const fixture = await fourTurnFixture();
    const { preview, compact } = await previewAndCompact(fixture.sdk, fixture.filePath, NEAR_NO_OP);
    expect(okPreview(preview)).toMatchObject({
      compactPoint: 9,
      wouldProduceBands: true,
      firstKeptMessageId: "m10",
    });
    expect(compact.ok && compact.value.compactPoint).toBe(9);
  });

  test("preview compactPoint, band intent, and anchor agree with compact", async () => {
    const fixture = await derivedThreadFixture();
    const { preview, compact } = await previewAndCompact(fixture.sdk, fixture.filePath, TARGET);
    const value = okPreview(preview);
    expect(compact.ok).toBe(true);
    if (!compact.ok) return;
    expect(value.compactPoint).toBe(compact.value.compactPoint);
    expect(value.wouldProduceBands).toBe(compact.value.compactPoint > 0);
    expect(value.firstKeptMessageId).toBe(compact.value.firstKeptMessageId);
  });

  test("re-compact may move backward to zero while preview and stored snapshot stay coherent", async () => {
    const fixture = await derivedThreadFixture();
    expect((await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: TARGET })).ok).toBe(true);
    const preview = okPreview(
      await fixture.sdk.threadView.previewCompact({ filePath: fixture.filePath }, { params: ALL_FITS }),
    );
    expect(preview).toMatchObject({ compactPoint: 0, wouldProduceBands: false, firstKeptMessageId: "m1" });
    const compact = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: ALL_FITS });
    expect(compact.ok && compact.value).toMatchObject({ compactPoint: 0, firstKeptMessageId: "m1" });
    const stored = await fixture.sdk.threadView.describe({ filePath: fixture.filePath });
    expect(stored.ok && stored.value?.compactPoint).toBe(0);
  });

  test("same-point preview detects and compact repairs a damaged stored arrangement", async () => {
    const fixture = await derivedThreadFixture();
    const first = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: TARGET });
    expect(first.ok).toBe(true);
    const omitted = first.ok ? (first.value.degraded[0]?.subjectId ?? "t7") : "t7";
    await fixture.test.run(async (ctx) => {
      const rows = await ctx.db.query("threadViews").collect();
      const row = rows.find(
        (candidate) => candidate.instance === fixture.instance && candidate.thread === fixture.threadId,
      );
      if (row === undefined) throw new Error("stored view missing");
      await ctx.db.patch("threadViews", row._id, {
        arrangement: (row.arrangement as unknown[]).filter(
          (entry: unknown) => (entry as { subjectId?: string }).subjectId !== omitted,
        ),
        gaps: [],
      });
    });
    const preview = okPreview(
      await fixture.sdk.threadView.previewCompact({ filePath: fixture.filePath }, { params: TARGET }),
    );
    expect(preview).toMatchObject({ compactPoint: 48, wouldProduceBands: true });
    const repaired = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: TARGET });
    expect(repaired.ok && repaired.value.compactPoint).toBe(48);
    const stored = await fixture.sdk.threadView.describe({ filePath: fixture.filePath });
    expect(stored.ok && stored.value?.arrangement.some((entry) => entry["subjectId"] === omitted)).toBe(true);
  });

  test("preview and compact agree across no-op, target, gradient, and repeat compaction", async () => {
    for (const params of [ALL_FITS, TARGET, GRADIENT]) {
      const fixture = await derivedThreadFixture();
      for (let pass = 0; pass < 2; pass += 1) {
        const { preview, compact } = await previewAndCompact(fixture.sdk, fixture.filePath, params);
        const value = okPreview(preview);
        expect(compact.ok).toBe(true);
        if (!compact.ok) continue;
        expect(value.compactPoint).toBe(compact.value.compactPoint);
      }
    }
  });

  test("near-no-op preview alone reports the small band", async () => {
    const fixture = await fourTurnFixture();
    expect(
      okPreview(await fixture.sdk.threadView.previewCompact({ filePath: fixture.filePath }, { params: NEAR_NO_OP })),
    ).toMatchObject({
      wouldProduceBands: true,
      compactPoint: 9,
    });
  });

  test("preview writes no thread view row", async () => {
    const fixture = await derivedThreadFixture();
    const before = await viewCount(fixture, fixture.threadId);
    expect((await fixture.sdk.threadView.previewCompact({ filePath: fixture.filePath }, { params: TARGET })).ok).toBe(
      true,
    );
    expect(await viewCount(fixture, fixture.threadId)).toBe(before);
  });

  test("a dangling tool call in the latest open turn stays after the preview point", async () => {
    const fixture = serviceFixture();
    const { filePath, threadId } = await fixture.createThread();
    for (let turn = 1; turn <= 3; turn += 1) {
      const accepted = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
        validEvent("user_prompt", { payload: { text: `closed turn ${turn}` } }),
        validEvent("assistant_text", { payload: { text: `closed answer ${turn}` } }),
        validEvent("turn_end"),
      ]);
      expect(accepted.ok).toBe(true);
    }
    await fixture.sdk.work.drain({ filePath });
    await fixture.sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "render the plan locally" } }),
      validEvent("assistant_text", { payload: { text: "Lint passed. Now let me serve it." } }),
      validEvent("tool_call", {
        payload: {
          toolCallId: "call-open-serve",
          toolName: "bash",
          arguments: { command: `serve ${" --verbose".repeat(200)}` },
        },
      }),
    ]);
    const before = await viewCount(fixture, threadId);
    const preview = okPreview(await fixture.sdk.threadView.previewCompact({ filePath }, { params: TARGET }));
    expect(preview).toMatchObject({ compactPoint: 9, wouldProduceBands: true, firstKeptMessageId: "m10" });
    expect(preview.tailTokens).toBeGreaterThan(100);
    expect(await viewCount(fixture, threadId)).toBe(before);
  });

  test("an empty thread previews as an ok no-op", async () => {
    const fixture = serviceFixture();
    const { filePath } = await fixture.createThread();
    expect(okPreview(await fixture.sdk.threadView.previewCompact({ filePath }, { params: TARGET }))).toMatchObject({
      compactPoint: 0,
      wouldProduceBands: false,
    });
  });

  test("compact receipts expose rendered bands and the tail anchor", async () => {
    const fixture = await derivedThreadFixture();
    const compact = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: GRADIENT });
    expect(compact.ok).toBe(true);
    if (!compact.ok) return;
    expect(compact.value.renderedBands.length).toBeGreaterThan(0);
    expect(compact.value.firstKeptMessageId).toMatch(/^m\d+$/);
    for (const band of compact.value.renderedBands) {
      expect(band.text.length).toBeGreaterThan(0);
      expect(compact.value.bands[band.band].entries).toBeGreaterThan(0);
    }
  });

  test("background preview neither schedules nor consumes pending work", async () => {
    const fixture = serviceFixture({ mode: "background" });
    const { filePath, threadId } = await fixture.createThread();
    await fixture.sdk.intakeStream.messageEvents({ filePath }, eventBatch(["user_prompt"]));
    const before = await fixture.test.run(async (ctx) => {
      const threads = await ctx.db.query("threads").collect();
      const work = await ctx.db.query("workItems").collect();
      const thread = threads.find((row) => row.instance === fixture.instance && row.thread === threadId);
      return { scheduledDrainId: thread?.scheduledDrainId, work: work.map((row) => row._id) };
    });
    expect((await fixture.sdk.threadView.previewCompact({ filePath }, { params: ALL_FITS })).ok).toBe(true);
    const after = await fixture.test.run(async (ctx) => {
      const threads = await ctx.db.query("threads").collect();
      const work = await ctx.db.query("workItems").collect();
      const thread = threads.find((row) => row.instance === fixture.instance && row.thread === threadId);
      return { scheduledDrainId: thread?.scheduledDrainId, work: work.map((row) => row._id) };
    });
    expect(after).toEqual(before);
  });
});
