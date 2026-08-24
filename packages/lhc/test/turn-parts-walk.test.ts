// Turn parts — the walk (epic Flows 1, 3, 4, 6): split the open turn at the
// newest admissible complete step edge, serve parts behind seam lines inside
// the installed snapshot, keep the split point monotone and prior part bytes
// stable, settle a closed transition turn whole before any other turn splits,
// and never emit a part on the legacy plan. One invariant, exercised by the
// scenario matrix: at most one unsettled turn at compact completion.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type MessageEventInput, type ViewCompactParams } from "../src/index.js";
import { createInferenceCallbacksDouble, openRaw, type TempStore, tempStore, validEvent } from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
const AMBIENT_ALGORITHM = process.env["LHC_COMPACT_ALGORITHM"];
afterEach(() => {
  store.cleanup();
  if (AMBIENT_ALGORITHM === undefined) delete process.env["LHC_COMPACT_ALGORITHM"];
  else process.env["LHC_COMPACT_ALGORITHM"] = AMBIENT_ALGORITHM;
});

function sdkFor(): Lhc {
  return initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
}

async function newThread(sdk: Lhc): Promise<string> {
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  return filePath;
}

async function send(sdk: Lhc, filePath: string, events: MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, events);
  if (!result.ok) throw new Error(result.error.reason);
}

// One complete step: text, a call, its result. `stepIndex` is the host fact.
function step(stepIndex: number, label: string, weight = 6): MessageEventInput[] {
  const body = `${label} `.repeat(weight).trim();
  return [
    validEvent("assistant_text", { payload: { text: `step ${stepIndex}: ${body}`, stepIndex } }),
    validEvent("tool_call", {
      payload: { toolCallId: `c${stepIndex}-${label}`, toolName: "read", arguments: { step: stepIndex }, stepIndex },
    }),
    validEvent("tool_result", {
      payload: { toolCallId: `c${stepIndex}-${label}`, content: `result ${stepIndex}: ${body}`, stepIndex },
    }),
  ];
}

// Over the construction cap: an oversized step the tail must carry verbatim.
const GIANT = Array.from({ length: 300 }, (_, i) => `line ${i} of a very long assistant message body`).join("\n");

const closedTurn = (label: string): MessageEventInput[] => [
  validEvent("user_prompt", { payload: { text: `${label} prompt` } }),
  validEvent("assistant_text", { payload: { text: `${label} answer` } }),
  validEvent("turn_end"),
];

interface Sums {
  // token sum of live messages after each step's edge, by host step index
  after: Map<number, number>;
  edge: Map<number, number>;
}

function stepSums(filePath: string, turnId: string): Sums {
  const db = openRaw(filePath);
  try {
    const edges = db
      .prepare(
        `SELECT step_index AS s, MAX(source_event_order) AS edge FROM message
         WHERE turn_id = ? AND step_index IS NOT NULL GROUP BY step_index ORDER BY step_index`,
      )
      .all(turnId) as Array<{ s: number; edge: number }>;
    const after = new Map<number, number>();
    const edge = new Map<number, number>();
    for (const row of edges) {
      const sum = db
        .prepare(
          `SELECT COALESCE(SUM(token_estimate), 0) AS t FROM message WHERE source_event_order > ? AND deleted_at IS NULL`,
        )
        .get(Number(row.edge)) as { t: number };
      after.set(Number(row.s), Number(sum.t));
      edge.set(Number(row.s), Number(row.edge));
    }
    return { after, edge };
  } finally {
    db.close();
  }
}

// The split rule is proven with newest-closed protection off (Flow 5 has its
// own seam file); with it on, the tiny closed t1 plus the whole open turn
// would fit the bound and the walk would rightly not split.
const params = (lowerBound: number): ViewCompactParams => ({
  lowerBound,
  percentages: { full: 50, smooth: 20, detailed: 15, brief: 15 },
  newestClosedProtection: 0,
});

async function compact(sdk: Lhc, filePath: string, p: ViewCompactParams) {
  const prepared = await sdk.threadView.prepareCompact({ filePath }, { params: p });
  if (!prepared.ok) throw new Error(prepared.error.reason);
  const receipt = await sdk.threadView.installPreparedCompact({ filePath }, prepared.value, {
    createdAt: "2026-08-24T00:00:00.000Z",
  });
  if (!receipt.ok) throw new Error(receipt.error.reason);
  return { entries: prepared.value.selection.entries, receipt: receipt.value };
}

describe("turn parts: the walk splits the open turn", () => {
  it("splits at the smallest complete step edge whose tail fits (inclusive tie), closes nothing, serves the part behind a seam", async () => {
    const sdk = sdkFor();
    const filePath = await newThread(sdk);
    await send(sdk, filePath, closedTurn("t1"));
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "long task" } }),
      ...step(0, "alpha"),
      ...step(1, "bravo"),
      ...step(2, "charlie"),
      ...step(3, "delta"),
      // in-flight step: a call with no result yet
      validEvent("assistant_text", { payload: { text: "step 4: working", stepIndex: 4 } }),
      validEvent("tool_call", { payload: { toolCallId: "c4", toolName: "read", arguments: {}, stepIndex: 4 } }),
    ]);
    // Exact tie on step 1's edge: the full share equals the tail after it, so
    // k = 2 (steps 0–1 in the part) by the inclusive rule; an off-by-one
    // (strict <) would select step 2's edge instead. lastEdge is 3 (three
    // complete steps 0..3 → k ≤ 3), so the tie is well inside the admissible range.
    const sums = stepSums(filePath, "t2");
    const tie = sums.after.get(1)!;
    expect(sums.after.get(0)!).toBeGreaterThan(tie);
    const { entries, receipt } = await compact(sdk, filePath, params(tie * 2));

    expect(receipt.splitPoint).toEqual({ turnId: "t2", stepIndex: 1 });
    expect(receipt.parts).toEqual([{ turnId: "t2", fromStep: 0, toStep: 1 }]);
    expect(receipt.compactPoint).toBe(sums.edge.get(1));
    expect(receipt.settled).toBeUndefined();

    // Nothing closed, nothing opened.
    const turns = await sdk.turns.listTurns({ filePath });
    expect(turns.ok && turns.value.map((t) => [t.turnId, t.status])).toEqual([
      ["t1", "closed"],
      ["t2", "open"],
    ]);

    // The part: one smooth entry over steps 0–1, labeled, raw prompt, seam line last.
    const part = entries.find((entry) => entry.part !== undefined)!;
    expect(part).toMatchObject({ band: "smooth", subjectKind: "turn", subjectId: "t2", derivationUsed: "part" });
    expect(part.text.startsWith("<t2>\n")).toBe(true);
    expect(part.text).toContain("long task");
    expect(part.text).toContain("step 1: bravo");
    expect(part.text).not.toContain("step 2: charlie");
    expect(part.text.endsWith("\n[seam · t2 · steps 0–1 summarized above · t2 resumes below]\n</t2>")).toBe(true);
    expect(part.text).toMatch(/<m\d+>/);

    // Served view: bands, then the verbatim tail from the first message of step 2.
    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const texts = context.value.messages.map((m) => m.content.map((c) => c.text).join(""));
    const firstTail = texts.find((t) => t.startsWith("step 2: charlie"));
    expect(firstTail).toBeDefined();
    expect(texts.some((t) => t.startsWith("step 1: bravo"))).toBe(false);
    expect(receipt.firstKeptMessageId).toBe(`m${sums.edge.get(1)! + 1}`);

    const metadata = await sdk.threadView.hostMetadata({ filePath });
    expect(metadata.ok && metadata.value.unsettledTurn).toEqual({ turnId: "t2" });
  });

  it("grows monotonically: a later compact appends a new part and keeps the prior part's bytes", async () => {
    const sdk = sdkFor();
    const filePath = await newThread(sdk);
    await send(sdk, filePath, closedTurn("t1"));
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "long task" } }),
      ...step(0, "alpha"),
      ...step(1, "bravo"),
      ...step(2, "charlie"),
    ]);
    const first = await compact(sdk, filePath, params(stepSums(filePath, "t2").after.get(0)! * 2));
    expect(first.receipt.parts).toEqual([{ turnId: "t2", fromStep: 0, toStep: 0 }]);
    const firstPart = first.entries.find((e) => e.part !== undefined)!;

    // Pressure relaxes (huge budget): k never moves backward.
    const relaxed = await compact(sdk, filePath, params(100_000));
    expect(relaxed.receipt.parts).toEqual([{ turnId: "t2", fromStep: 0, toStep: 0 }]);
    expect(relaxed.entries.find((e) => e.part !== undefined)!.text).toBe(firstPart.text);

    // More steps, tighter budget: coverage extends with a NEW part over the new range only.
    await send(sdk, filePath, [...step(3, "delta"), ...step(4, "echo"), ...step(5, "foxtrot")]);
    const sums = stepSums(filePath, "t2");
    const second = await compact(sdk, filePath, params(sums.after.get(3)! * 2));
    expect(second.receipt.parts).toEqual([
      { turnId: "t2", fromStep: 0, toStep: 0 },
      { turnId: "t2", fromStep: 1, toStep: 3 },
    ]);
    const parts = second.entries.filter((e) => e.part !== undefined);
    expect(parts[0]!.text).toBe(firstPart.text);
    expect(parts[1]!.text).toContain("step 1: bravo");
    expect(parts[1]!.text).toContain("step 3: delta");
    expect(parts[1]!.text).not.toContain("step 0: alpha");
    expect(parts[1]!.text.endsWith("[seam · t2 · steps 1–3 summarized above · t2 resumes below]\n</t2>")).toBe(true);
    expect(second.receipt.compactPoint).toBe(sums.edge.get(3));
  });

  it("does not split a turn with any NULL step index, and the legacy plan never splits", async () => {
    const sdk = sdkFor();
    const filePath = await newThread(sdk);
    await send(sdk, filePath, closedTurn("t1"));
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "long task" } }),
      ...step(0, "alpha"),
      ...step(1, "bravo"),
      validEvent("assistant_text", { payload: { text: "unstamped" } }),
      ...step(2, "charlie"),
    ]);
    const tight = params(stepSums(filePath, "t2").after.get(1)! * 2);
    const unstamped = await compact(sdk, filePath, tight);
    expect(unstamped.receipt.parts).toBeUndefined();
    expect(unstamped.receipt.splitPoint).toBeUndefined();
    expect(unstamped.entries.some((e) => e.part !== undefined)).toBe(false);

    // Stamped but legacy: identical no-split outcome, no part vocabulary anywhere.
    const legacyPath = await newThread(sdk);
    await send(sdk, legacyPath, closedTurn("t1"));
    await send(sdk, legacyPath, [
      validEvent("user_prompt", { payload: { text: "long task" } }),
      ...step(0, "alpha"),
      ...step(1, "bravo"),
      ...step(2, "charlie"),
    ]);
    process.env["LHC_COMPACT_ALGORITHM"] = "legacy";
    const legacy = await compact(sdk, legacyPath, params(stepSums(legacyPath, "t2").after.get(0)! * 2));
    delete process.env["LHC_COMPACT_ALGORITHM"];
    expect(legacy.receipt.parts).toBeUndefined();
    expect(legacy.receipt.splitPoint).toBeUndefined();
    expect(legacy.entries.some((e) => e.part !== undefined)).toBe(false);
    const described = await sdk.threadView.describe({ filePath: legacyPath });
    expect(described.ok && described.value?.arrangement.every((e) => !("part" in e))).toBe(true);
  });
});

describe("turn parts: no edge fits (TC-1.8c)", () => {
  it("serves the oversized newest complete step uncapped in the verbatim tail and moves the complete prefix into a part", async () => {
    const sdk = sdkFor();
    const filePath = await newThread(sdk);
    await send(sdk, filePath, closedTurn("t1"));
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "long task" } }),
      ...step(0, "alpha"),
      validEvent("assistant_text", { payload: { text: GIANT, stepIndex: 1 } }),
      validEvent("tool_call", { payload: { toolCallId: "c1", toolName: "read", arguments: {}, stepIndex: 1 } }),
      validEvent("tool_result", { payload: { toolCallId: "c1", content: "result 1", stepIndex: 1 } }),
      // In flight: step 2's call has no result yet, so step 1 is the newest
      // complete step and k may reach at most 1.
      validEvent("assistant_text", { payload: { text: "step 2: charlie", stepIndex: 2 } }),
      validEvent("tool_call", { payload: { toolCallId: "c2", toolName: "read", arguments: {}, stepIndex: 2 } }),
    ]);
    const sums = stepSums(filePath, "t2");
    // The full share is under the tail behind step 0's edge: no edge fits.
    const { receipt, entries } = await compact(sdk, filePath, params(sums.after.get(0)!));
    expect(receipt.parts).toEqual([{ turnId: "t2", fromStep: 0, toStep: 0 }]);
    expect(receipt.compactPoint).toBe(sums.edge.get(0));
    expect(receipt.tailTokens).toBeGreaterThan(receipt.config.lowerBound * (receipt.config.full / 100));
    const part = entries.find((e) => e.part !== undefined)!;
    expect(part.text).toContain("step 0: alpha");
    expect(part.text).not.toContain("line 0 of a very long");
    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const tailTexts = context.value.messages.map((m) => m.content.map((c) => c.text).join(""));
    expect(tailTexts).toContain(GIANT);
    expect(tailTexts.some((t) => t.includes("elided at construction"))).toBe(false);
  });
});

describe("turn parts: close, lazy settle, settle-before-split, byte equivalence", () => {
  async function splitThenClose(sdk: Lhc): Promise<{ filePath: string; partText: string }> {
    const filePath = await newThread(sdk);
    await send(sdk, filePath, closedTurn("t1"));
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "long task" } }),
      ...step(0, "alpha"),
      ...step(1, "bravo"),
      ...step(2, "charlie"),
    ]);
    const split = await compact(sdk, filePath, params(stepSums(filePath, "t2").after.get(0)! * 2));
    expect(split.receipt.parts).toEqual([{ turnId: "t2", fromStep: 0, toStep: 0 }]);
    await send(sdk, filePath, [validEvent("turn_end")]);
    return { filePath, partText: split.entries.find((e) => e.part !== undefined)!.text };
  }

  it("a closed transition turn keeps its parts until a compact bands it; a split elsewhere settles it first", async () => {
    const sdk = sdkFor();
    const { filePath, partText } = await splitThenClose(sdk);
    await send(sdk, filePath, [validEvent("user_prompt", { payload: { text: "next" } })]);

    // Lazy: a generous budget would leave t2 in the tail — the walk keeps its
    // installed edge and parts instead of serving it whole-unsettled.
    const lazy = await compact(sdk, filePath, params(100_000));
    expect(lazy.receipt.parts).toEqual([{ turnId: "t2", fromStep: 0, toStep: 0 }]);
    expect(lazy.receipt.settled).toBeUndefined();
    expect(lazy.entries.find((e) => e.part !== undefined)!.text).toBe(partText);
    const lazyMeta = await sdk.threadView.hostMetadata({ filePath });
    expect(lazyMeta.ok && lazyMeta.value.unsettledTurn).toEqual({ turnId: "t2" });

    // t3 grows past the full share: t2 settles whole (composed in-walk — no
    // drain ran, so no stored rendering exists), then t3 splits.
    await send(sdk, filePath, [...step(0, "golf"), ...step(1, "hotel"), ...step(2, "india"), ...step(3, "juliet")]);
    const sums = stepSums(filePath, "t3");
    const settled = await compact(sdk, filePath, params(sums.after.get(1)! * 2));
    expect(settled.receipt.settled).toEqual({
      turnId: "t2",
      construction: { kind: "composed_in_walk", turnId: "t2" },
    });
    expect(settled.receipt.parts).toEqual([{ turnId: "t3", fromStep: 0, toStep: 1 }]);
    const t2 = settled.entries.filter((e) => e.subjectId === "t2");
    expect(t2).toHaveLength(1);
    expect(t2[0]).toMatchObject({ band: "smooth", derivationUsed: "composed_in_walk", degraded: false });
    expect(t2[0]!.part).toBeUndefined();
    expect(t2[0]!.text).toContain("step 2: charlie");
    expect(new Set(settled.entries.filter((e) => e.part !== undefined).map((e) => e.subjectId))).toEqual(
      new Set(["t3"]),
    );
    const meta = await sdk.threadView.hostMetadata({ filePath });
    expect(meta.ok && meta.value.unsettledTurn).toEqual({ turnId: "t3" });
  });

  it("split-equals-never-split: the settled construction is byte-identical to the never-split turn's stored rendering", async () => {
    const sdk = sdkFor();
    const script = async (filePath: string, midTurnCompact: boolean): Promise<void> => {
      await send(sdk, filePath, closedTurn("t1"));
      await send(sdk, filePath, [
        validEvent("user_prompt", { payload: { text: "long task" } }),
        ...step(0, "alpha"),
        ...step(1, "bravo"),
        ...step(2, "charlie"),
      ]);
      if (midTurnCompact) {
        const split = await compact(sdk, filePath, params(stepSums(filePath, "t2").after.get(0)! * 2));
        expect(split.receipt.parts).toHaveLength(1);
      }
      await send(sdk, filePath, [validEvent("turn_end")]);
      await send(sdk, filePath, [validEvent("user_prompt", { payload: { text: "next" } }), ...step(0, "golf")]);
      // Pin derivation state on both copies: every queued derivation lands.
      const drained = await sdk.work.drain({ filePath });
      if (!drained.ok || drained.value.remaining !== 0) throw new Error("drain left work behind");
    };
    const split = await newThread(sdk);
    const whole = await newThread(sdk);
    await script(split, true);
    await script(whole, false);

    // The split copy settles through the composed-in-walk rung: clear its
    // stored rendering (what an edit cascade does) so the walk must compose.
    const db = openRaw(split);
    try {
      db.prepare(`DELETE FROM derivation WHERE subject_id = 't2' AND derivation_type = 'turn_rendering'`).run();
    } finally {
      db.close();
    }
    const budget = params(stepSums(whole, "t3").after.get(0)! * 2 + 1);
    const settled = await compact(sdk, split, budget);
    const never = await compact(sdk, whole, budget);
    expect(settled.receipt.settled?.construction).toEqual({ kind: "composed_in_walk", turnId: "t2" });
    expect(never.receipt.settled).toBeUndefined();
    const settledEntry = settled.entries.find((e) => e.subjectId === "t2")!;
    const wholeEntry = never.entries.find((e) => e.subjectId === "t2")!;
    expect(wholeEntry.derivationUsed).toBe("turn_rendering");
    expect(settledEntry.text).toBe(wholeEntry.text);
  });
});

describe("turn parts: named contract cases", () => {
  it("TC-1.4a: a part renders the unsmoothed prompt — its text is identical whether or not a READY smoothed derivation exists", async () => {
    const sdk = sdkFor();
    const build = async (drainFirst: boolean) => {
      const filePath = await newThread(sdk);
      await send(sdk, filePath, closedTurn("t1"));
      await send(sdk, filePath, [
        validEvent("user_prompt", { payload: { text: "long task" } }),
        ...step(0, "alpha"),
        ...step(1, "bravo"),
        ...step(2, "charlie"),
      ]);
      if (drainFirst) {
        const drained = await sdk.work.drain({ filePath });
        if (!drained.ok || drained.value.remaining !== 0) throw new Error("drain left work behind");
        const db = openRaw(filePath);
        const row = db
          .prepare(
            `SELECT state, content FROM derivation WHERE subject_id = 'm4' AND derivation_type = 'smoothed_prompt'`,
          )
          .get() as { state: string; content: string } | undefined;
        db.close();
        expect(row?.state).toBe("ready");
        expect(row?.content).toContain("smoothed(");
      }
      const { receipt, entries } = await compact(sdk, filePath, params(stepSums(filePath, "t2").after.get(0)! * 2));
      expect(receipt.parts).toEqual([{ turnId: "t2", fromStep: 0, toStep: 0 }]);
      return entries.find((e) => e.part !== undefined)!.text;
    };
    const unsmoothed = await build(false);
    const smoothed = await build(true);
    expect(smoothed).toBe(unsmoothed);
    expect(smoothed).toContain("long task");
    expect(smoothed).not.toContain("smoothed(");
    expect(smoothed).not.toContain("[fallback");
  });

  it("AC-4.2: a multi-part turn settles exactly like the single-part case — one whole construction from canonical, every part superseded", async () => {
    const sdk = sdkFor();
    const settleAfter = async (splits: 1 | 2): Promise<{ text: string; receiptParts: number }> => {
      const filePath = await newThread(sdk);
      await send(sdk, filePath, closedTurn("t1"));
      await send(sdk, filePath, [
        validEvent("user_prompt", { payload: { text: "long task" } }),
        ...step(0, "alpha"),
        ...step(1, "bravo"),
      ]);
      if (splits === 2) {
        const first = await compact(sdk, filePath, params(stepSums(filePath, "t2").after.get(0)! * 2));
        expect(first.receipt.parts).toEqual([{ turnId: "t2", fromStep: 0, toStep: 0 }]);
      }
      await send(sdk, filePath, [...step(2, "charlie"), ...step(3, "delta")]);
      const sums = stepSums(filePath, "t2");
      const split = await compact(
        sdk,
        filePath,
        params(splits === 2 ? sums.after.get(2)! * 2 : sums.after.get(0)! * 2),
      );
      expect(split.receipt.parts).toEqual(
        splits === 2
          ? [
              { turnId: "t2", fromStep: 0, toStep: 0 },
              { turnId: "t2", fromStep: 1, toStep: 2 },
            ]
          : [{ turnId: "t2", fromStep: 0, toStep: 0 }],
      );
      await send(sdk, filePath, [validEvent("turn_end")]);
      await send(sdk, filePath, [
        validEvent("user_prompt", { payload: { text: "next" } }),
        ...step(0, "golf"),
        ...step(1, "hotel"),
      ]);
      const settled = await compact(sdk, filePath, params(stepSums(filePath, "t3").after.get(0)! * 2));
      expect(settled.receipt.settled).toEqual({
        turnId: "t2",
        construction: { kind: "composed_in_walk", turnId: "t2" },
      });
      const t2 = settled.entries.filter((e) => e.subjectId === "t2");
      expect(t2).toHaveLength(1);
      expect(t2[0]!.part).toBeUndefined();
      const meta = await sdk.threadView.hostMetadata({ filePath });
      expect(meta.ok && meta.value.unsettledTurn).toEqual({ turnId: "t3" });
      return { text: t2[0]!.text, receiptParts: split.receipt.parts!.length };
    };
    const multi = await settleAfter(2);
    const single = await settleAfter(1);
    expect(multi.receiptParts).toBe(2);
    expect(multi.text).toBe(single.text);
    expect(multi.text).toContain("step 3: delta");
    expect(multi.text).not.toContain("[seam ·");
  });

  it("TC-8.1a: install is the whole commitment — after a settle nothing outside superseded snapshots holds part content and no cleanup is pending", async () => {
    const sdk = sdkFor();
    const filePath = await newThread(sdk);
    await send(sdk, filePath, closedTurn("t1"));
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "long task" } }),
      ...step(0, "alpha"),
      ...step(1, "bravo"),
    ]);
    const split = await compact(sdk, filePath, params(stepSums(filePath, "t2").after.get(0)! * 2));
    expect(split.receipt.parts).toHaveLength(1);
    await send(sdk, filePath, [validEvent("turn_end")]);
    await send(sdk, filePath, [validEvent("user_prompt", { payload: { text: "next" } }), ...step(0, "golf")]);
    // A full share just over t3 bands t2 whole: settle, no part anywhere.
    const settled = await compact(sdk, filePath, params(stepSums(filePath, "t2").after.get(1)! * 2 + 2));
    expect(settled.receipt.settled?.turnId).toBe("t2");
    expect(settled.receipt.parts).toBeUndefined();

    // "Interrupted immediately after install": a fresh process serves from the
    // snapshot alone.
    const resumed = sdkFor();
    const served = await resumed.threadView.getLlmRequestContext({ filePath });
    const described = await resumed.threadView.describe({ filePath });
    expect(described.ok && described.value?.viewId).toBe(settled.receipt.viewId);
    expect(described.ok && described.value?.arrangement.every((e) => e.part === undefined)).toBe(true);
    const db = openRaw(filePath);
    try {
      const views = db.prepare(`SELECT COUNT(*) AS n FROM thread_view`).get() as { n: number };
      const bands = db
        .prepare(`SELECT COUNT(*) AS n FROM thread_view_band WHERE view_id <> ?`)
        .get(settled.receipt.viewId) as {
        n: number;
      };
      const seams = db
        .prepare(`SELECT COUNT(*) AS n FROM thread_view_band WHERE rendered_text LIKE '%[seam ·%'`)
        .get() as { n: number };
      const derivedSeams = db.prepare(`SELECT COUNT(*) AS n FROM derivation WHERE content LIKE '%[seam ·%'`).get() as {
        n: number;
      };
      expect([Number(views.n), Number(bands.n), Number(seams.n), Number(derivedSeams.n)]).toEqual([1, 0, 0, 0]);
    } finally {
      db.close();
    }
    // Nothing is pending on the view's behalf: the queue drains to zero and
    // the installed snapshot is exactly what it was.
    const drained = await resumed.work.drain({ filePath });
    expect(drained.ok && drained.value.remaining).toBe(0);
    const after = await resumed.threadView.describe({ filePath });
    expect(JSON.stringify(after)).toBe(JSON.stringify(described));
    expect(JSON.stringify(await resumed.threadView.getLlmRequestContext({ filePath }))).toBe(JSON.stringify(served));
  });
});
