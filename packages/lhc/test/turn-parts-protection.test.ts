// Flow 5 — the newest closed turn is protected by placement (AC-5.1, AC-5.2)
// under the TDQ8 ruling: bound = min(fraction × lower bound, what the active
// turn's minimum verbatim tail leaves), default fraction 0.6, configured in
// the profile shape beside the band allocations. No readiness dependency;
// never an excerpt for the newest closed turn.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type MessageEventInput, type ViewCompactParams } from "../src/index.js";
import { estimateTokens } from "../src/shared-tech/token-counting/index.js";
import { createInferenceCallbacksDouble, openRaw, type TempStore, tempStore, validEvent } from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
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

const closedTurn = (label: string, weight = 4): MessageEventInput[] => [
  validEvent("user_prompt", { payload: { text: `${label} prompt` } }),
  validEvent("assistant_text", { payload: { text: `${label} answer `.repeat(weight).trim() } }),
  validEvent("turn_end"),
];

function turnTokens(filePath: string, turnId: string): number {
  const db = openRaw(filePath);
  try {
    return Number(
      (
        db.prepare(`SELECT COALESCE(SUM(token_estimate), 0) AS t FROM message WHERE turn_id = ?`).get(turnId) as {
          t: number;
        }
      ).t,
    );
  } finally {
    db.close();
  }
}

const shares = { full: 20, smooth: 30, detailed: 25, brief: 25 };

// Text whose stored estimate is exactly `tokens`.
function fill(tokens: number): string {
  const words = ["alpha", "beta", "gamma", "delta", "omega", "sigma"];
  let count = tokens;
  for (let i = 0; i < 200; i += 1) {
    const text = Array.from({ length: count }, (_, j) => words[j % words.length]).join(" ");
    const measured = estimateTokens(text);
    if (measured === tokens) return text;
    count += measured < tokens ? 1 : -1;
  }
  throw new Error(`fill(${tokens}) did not converge`);
}

// Older history well over budget; a large research turn closes last; the
// open turn is empty (agent settled). Nothing drained: no rendering exists.
async function researchThread(sdk: Lhc): Promise<string> {
  const filePath = await newThread(sdk);
  for (let i = 1; i <= 6; i += 1) await send(sdk, filePath, closedTurn(`old${i}`, 3));
  await send(sdk, filePath, closedTurn("research", 40));
  return filePath;
}

describe("Flow 5: newest closed turn protected by placement", () => {
  it("TC-5.1a/b: fits the bound → served full, readiness-independent; older turns compress", async () => {
    const sdk = sdkFor();
    const filePath = await researchThread(sdk);
    const research = turnTokens(filePath, "t7");
    const lowerBound = Math.ceil(research / 0.6) + 10; // fits 0.6 × lowerBound
    const params: ViewCompactParams = { lowerBound, percentages: shares };
    const receipt = await sdk.threadView.compact({ filePath }, { params });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.protectedTurn).toEqual({ turnId: "t7", representation: "full" });
    // Full = verbatim: the compact point sits before t7 and t7 is not banded.
    const db = openRaw(filePath);
    const t7Start = Number(
      (db.prepare(`SELECT MIN(source_event_order) AS o FROM message WHERE turn_id = 't7'`).get() as { o: number }).o,
    );
    db.close();
    expect(receipt.value.compactPoint).toBeLessThan(t7Start);
    const described = await sdk.threadView.describe({ filePath });
    expect(described.ok && described.value?.arrangement.some((e) => e.subjectId === "t7")).toBe(false);
    expect(receipt.value.tailTokens).toBeGreaterThanOrEqual(research);
    // Precedence (4): the elders compress as needed — here the protected tail
    // consumes their shares — and the served view stays within the bound.
    expect(receipt.value.totalTokens).toBeLessThanOrEqual(
      lowerBound + Math.max(0, ...receipt.value.renderedBands.map((b) => estimateTokens(b.text))),
    );
  });

  it("TC-5.1c/5.2a: over the bound → whole rendering composed in-walk (stored when ready), never an excerpt; older turns may still excerpt", async () => {
    const sdk = sdkFor();
    const filePath = await researchThread(sdk);
    const research = turnTokens(filePath, "t7");
    // A full share too small for t7 (so Rule 1 bands it), smooth wide enough
    // for the older turns to render (as excerpts: nothing drained), and a
    // fraction too small for t7 to be kept full.
    const params: ViewCompactParams = {
      lowerBound: research * 6,
      percentages: { full: 8, smooth: 42, detailed: 25, brief: 25 },
      newestClosedProtection: 0.1,
    };
    const overflow = await sdk.threadView.compact({ filePath }, { params });
    expect(overflow.ok).toBe(true);
    if (!overflow.ok) return;
    expect(overflow.value.protectedTurn).toEqual({ turnId: "t7", representation: "whole_rendering" });
    const described = await sdk.threadView.describe({ filePath });
    expect(described.ok).toBe(true);
    if (!described.ok || described.value === null) return;
    const t7 = described.value.arrangement.filter((e) => e.subjectId === "t7");
    expect(t7).toHaveLength(1);
    expect(t7[0]).toMatchObject({ band: "smooth", derivationUsed: "composed_in_walk", degraded: false });
    // The prohibition is specific to the newest closed turn: older undrained
    // turns still take the excerpt rung.
    expect(described.value.arrangement.some((e) => e.derivationUsed === "message_excerpt")).toBe(true);

    // With the stored rendering ready, the stored construction is used.
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok && drained.value.remaining).toBe(0);
    const stored = await sdk.threadView.compact({ filePath }, { params });
    expect(stored.ok && stored.value.protectedTurn).toEqual({ turnId: "t7", representation: "whole_rendering" });
    const again = await sdk.threadView.describe({ filePath });
    expect(again.ok && again.value?.arrangement.find((e) => e.subjectId === "t7")?.derivationUsed).toBe(
      "turn_rendering",
    );
  });

  it("precedence: under a planned split the whole active turn is reserved first (a full newest closed turn would put it in the tail); the bound is what it leaves", async () => {
    const sdk = sdkFor();
    const filePath = await researchThread(sdk);
    // Open turn with two complete stamped steps: a split would keep step 1 in
    // the tail, but keeping t7 full means no split, so the reserve is all of t8.
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "task" } }),
      validEvent("assistant_text", { payload: { text: "step 0 ".repeat(30), stepIndex: 0 } }),
      validEvent("assistant_text", { payload: { text: "step 1 ".repeat(60), stepIndex: 1 } }),
    ]);
    const research = turnTokens(filePath, "t7");
    const db = openRaw(filePath);
    const step1 = Number(
      (
        db.prepare(`SELECT token_estimate AS t FROM message WHERE turn_id = 't8' AND step_index = 1`).get() as {
          t: number;
        }
      ).t,
    );
    db.close();
    // lowerBound leaves less than t7 after the reserve even though
    // fraction × lowerBound alone would admit it.
    const lowerBound = step1 + Math.floor(research / 2);
    expect(0.6 * lowerBound).toBeGreaterThan(research * 0.45);
    expect(lowerBound - turnTokens(filePath, "t8")).toBeLessThan(research);
    const params: ViewCompactParams = { lowerBound, percentages: { full: 10, smooth: 30, detailed: 30, brief: 30 } };
    const receipt = await sdk.threadView.compact({ filePath }, { params });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.parts).toEqual([{ turnId: "t8", fromStep: 0, toStep: 0 }]);
    expect(receipt.value.protectedTurn).toEqual({ turnId: "t7", representation: "whole_rendering" });
  });

  it("M1: the served view stays within the bound — a full newest closed turn's overrun cascades smooth → detailed → brief and a consumed share yields an empty band", async () => {
    // The reviewer's reproduction: 24 chunked elders, protected R = 142,
    // open W = 303 in two complete steps, lowerBound 447 at 25/25/25/25.
    // Before the cascade this served 784 tokens (tail 445 + 72 + 156 + 111).
    const sdk = initLhc({
      inferenceCallbacks: createInferenceCallbacksDouble(),
      mode: "manual",
      chunkPolicy: { targetProjectedTokens: 30, maxProjectedTokens: 4400 },
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
    });
    const filePath = await newThread(sdk);
    for (let i = 1; i <= 24; i += 1) {
      await send(sdk, filePath, [
        validEvent("user_prompt", { payload: { text: `elder ${i}` } }),
        validEvent("assistant_text", { payload: { text: fill(10) } }),
        validEvent("turn_end"),
      ]);
    }
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: fill(12) } }),
      validEvent("assistant_text", { payload: { text: fill(130) } }),
      validEvent("turn_end"),
    ]);
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok && drained.value.remaining).toBe(0);
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: fill(23) } }),
      validEvent("assistant_text", { payload: { text: fill(140), stepIndex: 0 } }),
      validEvent("assistant_text", { payload: { text: fill(140), stepIndex: 1 } }),
    ]);
    expect(turnTokens(filePath, "t25")).toBe(142);
    expect(turnTokens(filePath, "t26")).toBe(303);
    const params: ViewCompactParams = {
      lowerBound: 447,
      percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
    };

    // The elders have material to compress into: closed chunks with ready
    // summaries. The empty bands below are the cascade, not absence.
    const material = openRaw(filePath);
    const chunks = Number(
      (material.prepare(`SELECT COUNT(*) AS n FROM chunk WHERE status = 'closed'`).get() as { n: number }).n,
    );
    const summaries = Number(
      (
        material
          .prepare(`SELECT COUNT(*) AS n FROM derivation WHERE subject_kind = 'chunk' AND state = 'ready'`)
          .get() as { n: number }
      ).n,
    );
    material.close();
    expect(chunks).toBeGreaterThan(0);
    expect(summaries).toBeGreaterThan(0);

    const receipt = await sdk.threadView.compact({ filePath }, { params });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.protectedTurn).toEqual({ turnId: "t25", representation: "full" });
    expect(receipt.value.parts).toBeUndefined();
    expect(receipt.value.tailTokens).toBe(445);
    // Overrun 333 over the full share of 111: smooth (111) and detailed (111)
    // are consumed and stay empty; brief keeps 2 tokens of share and may admit
    // its first entry — the one-entry slack.
    expect(receipt.value.bands.smooth.entries).toBe(0);
    expect(receipt.value.bands.detailed.entries).toBe(0);
    expect(receipt.value.bands.brief.entries).toBeLessThanOrEqual(1);
    const slack = Math.max(0, ...receipt.value.renderedBands.map((b) => estimateTokens(b.text)));
    expect(receipt.value.totalTokens).toBeLessThanOrEqual(447 + slack);
    expect(receipt.value.totalTokens).toBeLessThan(784);
  });

  it("the fraction lives beside the band allocations and is validated at construction and at compact", async () => {
    expect(() =>
      initLhc({
        inferenceCallbacks: createInferenceCallbacksDouble(),
        mode: "manual",
        view: { profiles: [{ name: "coding", newestClosedProtection: 1.5 }] },
      }),
    ).toThrow(/newestClosedProtection must be a fraction from 0 to 1, got 1.5/);
    const sdk = sdkFor();
    const filePath = await researchThread(sdk);
    const bad = await sdk.threadView.compact(
      { filePath },
      { params: { lowerBound: 1000, percentages: shares, newestClosedProtection: -0.2 } },
    );
    expect(!bad.ok && bad.error.code).toBe("invalid_view_config");
  });
});
