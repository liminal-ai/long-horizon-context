// Turn parts — recovery and reproducibility (epic Flow 8: AC-8.2, AC-8.3,
// AC-8.4) plus the retrieval-across-the-seam and rendered-pricing seams
// (AC-2.2, AC-1.8b). Parts live only inside the installed snapshot, so
// "resume" is a fresh SDK reading the file, "crash before install" is a
// prepare that never installs, and "reproducibility" is the walk re-run on
// the frozen inputs matching the placement the receipt recorded.
import { copyFileSync } from "node:fs";
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

function step(stepIndex: number, label: string): MessageEventInput[] {
  const body = `${label} `.repeat(6).trim();
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

async function pressuredThread(sdk: Lhc): Promise<string> {
  const filePath = await newThread(sdk);
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "t1 prompt" } }),
    validEvent("assistant_text", { payload: { text: "t1 answer" } }),
    validEvent("turn_end"),
  ]);
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "long task" } }),
    ...step(0, "alpha"),
    ...step(1, "bravo"),
    ...step(2, "charlie"),
  ]);
  return filePath;
}

function tokensAfterStep(filePath: string, turnId: string, stepIndex: number): number {
  const db = openRaw(filePath);
  try {
    const edge = (
      db
        .prepare(`SELECT MAX(source_event_order) AS e FROM message WHERE turn_id = ? AND step_index = ?`)
        .get(turnId, stepIndex) as { e: number }
    ).e;
    return Number(
      (
        db
          .prepare(`SELECT COALESCE(SUM(token_estimate), 0) AS t FROM message WHERE source_event_order > ?`)
          .get(edge) as {
          t: number;
        }
      ).t,
    );
  } finally {
    db.close();
  }
}

const params = (lowerBound: number): ViewCompactParams => ({
  lowerBound,
  percentages: { full: 50, smooth: 20, detailed: 15, brief: 15 },
  newestClosedProtection: 0,
});

async function servedText(sdk: Lhc, filePath: string): Promise<string> {
  const context = await sdk.threadView.getLlmRequestContext({ filePath });
  if (!context.ok) throw new Error(context.error.reason);
  return JSON.stringify(context.value.messages);
}

describe("turn parts: recovery and reproducibility", () => {
  it("TC-8.3a/8.3b: a fresh process serves the installed parts byte-identically, and the walk re-run on the frozen inputs reproduces the receipt's placement", async () => {
    const sdk = sdkFor();
    const filePath = await pressuredThread(sdk);
    const p = params(tokensAfterStep(filePath, "t2", 0) * 2);
    const receipt = await sdk.threadView.compact({ filePath }, { params: p });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.parts).toEqual([{ turnId: "t2", fromStep: 0, toStep: 0 }]);
    const before = await servedText(sdk, filePath);

    // Resume: a new SDK instance over the same file — nothing is process-resident.
    const resumed = sdkFor();
    expect(await servedText(resumed, filePath)).toBe(before);
    const described = await resumed.threadView.describe({ filePath });
    expect(described.ok && described.value?.viewId).toBe(receipt.value.viewId);

    // Reproducibility: the walk over a frozen copy of the inputs makes the
    // same decisions the receipt recorded, in every placement field.
    const frozen = store.threadPath("frozen");
    copyFileSync(filePath, frozen);
    const rerun = await resumed.threadView.prepareCompact({ filePath: frozen }, { params: p });
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) return;
    const decisions = (s: {
      parts?: unknown;
      splitPoint?: unknown;
      settled?: unknown;
      protectedTurn?: unknown;
      compactPoint: number;
    }) =>
      JSON.stringify({
        parts: s.parts ?? null,
        splitPoint: s.splitPoint ?? null,
        settled: s.settled ?? null,
        protectedTurn: s.protectedTurn ?? null,
        compactPoint: s.compactPoint,
      });
    expect(decisions(rerun.value.selection)).toBe(decisions(receipt.value));
    expect(rerun.value.bands.map((b) => b.renderedText)).toEqual(receipt.value.renderedBands.map((b) => b.text));

    // TC-1.8b: the part is priced by its rendered construction, not by the
    // raw estimates of the messages it covers.
    const part = rerun.value.selection.entries.find((e) => e.part !== undefined)!;
    expect(part.tokens).toBe(estimateTokens(part.text));
    const db = openRaw(filePath);
    const raw = Number(
      (
        db.prepare(`SELECT SUM(token_estimate) AS t FROM message WHERE turn_id = 't2' AND step_index = 0`).get() as {
          t: number;
        }
      ).t,
    );
    db.close();
    expect(part.tokens).not.toBe(raw);
  });

  it("TC-8.2a: a compact interrupted before install leaves the prior view — parts included — serving exactly as before", async () => {
    const sdk = sdkFor();
    const filePath = await pressuredThread(sdk);
    const first = await sdk.threadView.compact(
      { filePath },
      { params: params(tokensAfterStep(filePath, "t2", 0) * 2) },
    );
    expect(first.ok && first.value.parts?.length).toBe(1);
    const before = await servedText(sdk, filePath);
    const stored = await sdk.threadView.describe({ filePath });

    // More steps, tighter pressure: prepared, never installed.
    await send(sdk, filePath, [...step(3, "delta"), ...step(4, "echo")]);
    const prepared = await sdk.threadView.prepareCompact(
      { filePath },
      { params: params(tokensAfterStep(filePath, "t2", 2) * 2) },
    );
    expect(prepared.ok && prepared.value.selection.parts?.length).toBe(2);

    const after = await sdk.threadView.describe({ filePath });
    expect(JSON.stringify(after)).toBe(JSON.stringify(stored));
    // The tail grew (new canonical steps serve verbatim); the bands, parts, and
    // compact point did not move.
    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const isBand = (m: { content: Array<{ text: string }> }): boolean =>
      m.content[0]?.text.startsWith("[context ·") === true;
    const bands = JSON.stringify(context.value.messages.filter(isBand));
    expect(JSON.stringify((JSON.parse(before) as Array<{ content: Array<{ text: string }> }>).filter(isBand))).toBe(
      bands,
    );
  });

  it("TC-8.4a: a turn that closes between prepare and install is recomputed under newest-closed protection — never an excerpt, invariant intact", async () => {
    const sdk = sdkFor();
    const filePath = await pressuredThread(sdk);
    // Protection off so the frozen prepare splits t2 (with it on, tiny t1 plus
    // the whole of t2 fits the bound and the walk rightly would not split);
    // the excerpt prohibition for the newest closed turn is unconditional. A
    // small full share so that, once closed, t2 is banded rather than left in
    // the tail by Rule 1's straddle rounding.
    const p: ViewCompactParams = {
      lowerBound: tokensAfterStep(filePath, "t2", 0) * 2,
      percentages: { full: 10, smooth: 60, detailed: 15, brief: 15 },
      newestClosedProtection: 0,
    };
    const prepared = await sdk.threadView.prepareCompact({ filePath }, { params: p });
    expect(prepared.ok && prepared.value.selection.parts?.length).toBe(1);
    if (!prepared.ok) return;

    // The turn closes (host reports turn end) before install; nothing drained.
    await send(sdk, filePath, [validEvent("turn_end")]);
    const installed = await sdk.threadView.installPreparedCompact({ filePath }, prepared.value);
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    expect(installed.value.parts).toBeUndefined();
    expect(installed.value.protectedTurn?.turnId).toBe("t2");
    const described = await sdk.threadView.describe({ filePath });
    expect(described.ok).toBe(true);
    if (!described.ok || described.value === null) return;
    const t2 = described.value.arrangement.filter((e) => e.subjectId === "t2");
    expect(t2.every((e) => e.derivationUsed !== "message_excerpt" && e.part === undefined)).toBe(true);
    if (installed.value.protectedTurn?.representation === "full") expect(t2).toHaveLength(0);
    else expect(t2.map((e) => e.derivationUsed)).toEqual(["composed_in_walk"]);
    const meta = await sdk.threadView.hostMetadata({ filePath });
    expect(meta.ok && meta.value.unsettledTurn).toBeNull();
  });

  it("TC-2.2a/b: retrieval through the seam is exact — any message in a summarized step, and the whole split turn from canonical", async () => {
    const sdk = sdkFor();
    const filePath = await pressuredThread(sdk);
    const receipt = await sdk.threadView.compact(
      { filePath },
      { params: params(tokensAfterStep(filePath, "t2", 0) * 2) },
    );
    expect(receipt.ok && receipt.value.parts).toEqual([{ turnId: "t2", fromStep: 0, toStep: 0 }]);
    const db = openRaw(filePath);
    const row = db
      .prepare(
        `SELECT m.message_id, mb.content FROM message m JOIN message_block mb ON mb.message_id = m.message_id AND mb.block_index = 0 WHERE m.turn_id = 't2' AND m.step_index = 0 AND m.kind = 'tool_result'`,
      )
      .get() as { message_id: string; content: string };
    db.close();
    const exact = await sdk.retrieval.getMessages({ filePath }, [row.message_id]);
    const canonical = (JSON.parse(row.content) as { content: string }).content;
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(exact.value.served[0]?.messageId).toBe(row.message_id);
    expect(exact.value.served[0]?.text.endsWith(canonical)).toBe(true);
    expect(exact.value.served[0]?.slice).toBeUndefined();
    const whole = await sdk.retrieval.getTurns({ filePath }, ["t2"]);
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    const turn = whole.value.served[0]!;
    expect(turn.source).toBe("composed");
    expect(turn.text).toContain("step 0: alpha");
    expect(turn.text).toContain("step 2: charlie");
    expect(turn.text).not.toContain("[seam ·");
  });
});
