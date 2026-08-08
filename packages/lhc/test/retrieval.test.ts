// Retrieval ops (drill-down layer): getTurns serves tagged turn renderings by
// turn id; getMessages serves verbatim message content by message id. Both
// enforce an in-order token budget: the item crossing the budget is served as
// an exact token slice with a continuation receipt (fromToken), later items
// get explicit "budget" receipts, and every requested id writes one impression
// row. Deterministic — no inference in any path (stored renderings come from
// prior drains; fallback composition is pure).
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDeterministicInferenceCallbacks,
  estimateTokens,
  initLhc,
  intakeStream,
  type Lhc,
  retrieval,
} from "../src/index.js";
import { type TempStore, tempStore, validEvent } from "./fixtures/index.js";

let store: TempStore;
let sdk: Lhc;
let filePath: string;

async function newThread(): Promise<string> {
  const path = store.threadPath();
  const created = await sdk.threads.newThread({ filePath: path, registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  return path;
}

async function send(events: Parameters<typeof intakeStream.messageEvents>[1]): Promise<void> {
  const result = await intakeStream.messageEvents({ filePath }, events);
  if (!result.ok) throw new Error(`intake failed: ${result.error.reason}`);
}

async function drain(): Promise<void> {
  const result = await sdk.work.drain({ filePath });
  if (!result.ok) throw new Error(`drain failed: ${result.error.reason}`);
}

beforeEach(async () => {
  store = tempStore();
  sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
  filePath = await newThread();
});
afterEach(() => {
  store.cleanup();
});

/** One closed turn whose rendering is large enough to force slicing. The bulk
 *  rides assistant text because renderings keep model output whole while tool
 *  results get truncated. */
async function seedBigTurn(): Promise<void> {
  const bigBody = Array.from({ length: 400 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join(
    "\n",
  );
  await send([
    validEvent("user_prompt", { payload: { text: "dump the log please" } }),
    validEvent("assistant_text", { payload: { text: `full log follows\n${bigBody}` } }),
    validEvent("turn_end"),
  ]);
}

/** Two closed turns: t1 (prompt/answer) and t2 (prompt, tool run, answer). */
async function seedTwoTurns(): Promise<void> {
  await send([
    validEvent("user_prompt", { payload: { text: "first question" } }),
    validEvent("assistant_text", { payload: { text: "first answer" } }),
    validEvent("turn_end"),
    validEvent("user_prompt", { payload: { text: "read the file please" } }),
    validEvent("tool_call", {
      payload: { toolCallId: "call-1", toolName: "read", arguments: { path: "notes.txt" } },
    }),
    validEvent("tool_result", {
      payload: { toolCallId: "call-1", content: "the file says hello", isError: false },
    }),
    validEvent("assistant_text", { payload: { text: "done reading" } }),
    validEvent("turn_end"),
  ]);
}

describe("getTurns", () => {
  it("serves stored tagged renderings after drain, in request order", async () => {
    await seedTwoTurns();
    await drain();

    const result = await retrieval.getTurns({ filePath }, ["t2", "t1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt = result.value;
    expect(receipt.served.map((turn) => turn.turnId)).toEqual(["t2", "t1"]);
    expect(receipt.unserved).toEqual([]);
    const t2 = receipt.served[0]!;
    expect(t2.source).toBe("stored");
    expect(t2.text).toContain("<t2>");
    expect(t2.text).toContain("</t2>");
    expect(t2.text).toContain("read the file please");
    // Message tags inside the rendering are the get_messages handles.
    expect(t2.text).toMatch(/<m\d+>/);
    expect(receipt.totalTokens).toBe(receipt.served.reduce((sum, turn) => sum + turn.tokens, 0));
  });

  it("composes a live fallback when the rendering derivation is not ready", async () => {
    await seedTwoTurns();
    // No drain: turn_rendering rows are pending.
    const result = await retrieval.getTurns({ filePath }, ["t1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const turn = result.value.served[0]!;
    expect(turn.source).toBe("composed");
    expect(turn.text).toContain("<t1>");
    expect(turn.text).toContain("first question");
  });

  it("composes a tagged fallback for a ready legacy rendering without turn labels", async () => {
    await seedTwoTurns();
    await drain();
    const db = new DatabaseSync(filePath);
    try {
      db.prepare(
        `UPDATE derivation SET content = 'legacy untagged rendering'
         WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'turn_rendering'`,
      ).run();
    } finally {
      db.close();
    }

    const result = await retrieval.getTurns({ filePath }, ["t1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const turn = result.value.served[0]!;
    expect(turn.source).toBe("composed");
    expect(turn.text).toContain("<t1>");
    expect(turn.text).toContain("<m1>");
    expect(turn.text).not.toContain("legacy untagged rendering");
  });

  it("reports unknown ids as not_found without charging the budget", async () => {
    await seedTwoTurns();
    await drain();
    const result = await retrieval.getTurns({ filePath }, ["t99", "t1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unserved).toEqual([{ id: "t99", reason: "not_found" }]);
    expect(result.value.served.map((turn) => turn.turnId)).toEqual(["t1"]);
  });

  it('reports "budget" for the crossing item when too little budget remains to slice', async () => {
    await seedTwoTurns();
    await drain();
    const full = await retrieval.getTurns({ filePath }, ["t1", "t2"]);
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    // Budget fits either fixture turn alone but not both; the leftover after
    // t1 is far below RETRIEVAL_SLICE_FLOOR, so t2 is refused, not slivered.
    const t2Tokens = full.value.served[1]!.tokens;

    const partial = await retrieval.getTurns({ filePath }, ["t1", "t2"], { tokenBudget: t2Tokens });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.value.served.map((turn) => turn.turnId)).toEqual(["t1"]);
    expect(partial.value.served[0]!.slice).toBeUndefined();
    expect(partial.value.unserved).toHaveLength(1);
    const blocked = partial.value.unserved[0]!;
    expect(blocked.id).toBe("t2");
    expect(blocked.reason).toBe("budget");
    expect(blocked.tokens).toBeGreaterThan(0);
  });

  it("slices an oversized turn to the budget with a continuation receipt", async () => {
    await seedBigTurn();
    await drain();
    const result = await retrieval.getTurns({ filePath }, ["t1"], { tokenBudget: 500 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const turn = result.value.served[0]!;
    expect(turn.slice).toBeDefined();
    expect(turn.slice!.fromToken).toBe(0);
    expect(turn.slice!.toToken).toBe(500);
    expect(turn.slice!.totalTokens).toBeGreaterThan(500);
    expect(turn.tokens).toBe(500);
    expect(result.value.totalTokens).toBe(500);
  });

  it("fromToken continuation slices reassemble the full text", async () => {
    await seedBigTurn();
    await drain();
    const whole = await retrieval.getTurns({ filePath }, ["t1"]);
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    const fullText = whole.value.served[0]!.text;

    let assembled = "";
    let from = 0;
    for (let hop = 0; hop < 20; hop += 1) {
      const part = await retrieval.getTurns({ filePath }, ["t1"], { tokenBudget: 400, fromToken: from });
      expect(part.ok).toBe(true);
      if (!part.ok) return;
      const slice = part.value.served[0]!;
      expect(slice.slice).toBeDefined();
      assembled += slice.text;
      from = slice.slice!.toToken;
      if (from >= slice.slice!.totalTokens) break;
    }
    expect(assembled).toBe(fullText);
  });

  it("serves the crossing item sliced and later items with budget receipts", async () => {
    await seedBigTurn();
    await send([
      validEvent("user_prompt", { payload: { text: "small follow-up" } }),
      validEvent("assistant_text", { payload: { text: "small answer" } }),
      validEvent("turn_end"),
    ]);
    await drain();
    // t1 is huge, t2 tiny. Budget 500: t1 slice fills the whole budget, t2
    // reports "budget" with its size instead of being silently starved.
    const result = await retrieval.getTurns({ filePath }, ["t1", "t2"], { tokenBudget: 500 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.served).toHaveLength(1);
    expect(result.value.served[0]!.turnId).toBe("t1");
    expect(result.value.served[0]!.slice).toBeDefined();
    expect(result.value.unserved).toEqual([{ id: "t2", reason: "budget", tokens: expect.any(Number) }]);
  });

  it("rejects a negative or fractional fromToken", async () => {
    await seedTwoTurns();
    const negative = await retrieval.getTurns({ filePath }, ["t1"], { fromToken: -1 });
    expect(negative.ok).toBe(false);
    const fractional = await retrieval.getTurns({ filePath }, ["t1"], { fromToken: 1.5 });
    expect(fractional.ok).toBe(false);
  });

  it("collapses duplicate ids to one serve", async () => {
    await seedTwoTurns();
    await drain();
    const result = await retrieval.getTurns({ filePath }, ["t1", "t1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.served).toHaveLength(1);
  });

  it("rejects an empty id list and a non-positive budget", async () => {
    const empty = await retrieval.getTurns({ filePath }, []);
    expect(empty.ok).toBe(false);
    const bad = await retrieval.getTurns({ filePath }, ["t1"], { tokenBudget: 0 });
    expect(bad.ok).toBe(false);
  });
});

describe("getMessages", () => {
  it("serves verbatim text, tool calls, and tool results with pairing ids", async () => {
    await seedTwoTurns();
    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const firstOf = (kind: string) => listed.value.find((record) => record.kind === kind)!;
    const promptId = firstOf("user_prompt").messageId;
    const callId = firstOf("tool_call").messageId;
    const resultId = firstOf("tool_result").messageId;

    const result = await retrieval.getMessages({ filePath }, [promptId, callId, resultId]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [prompt, call, toolResult] = result.value.served;
    expect(prompt!.text).toBe("first question");
    expect(prompt!.kind).toBe("user_prompt");
    expect(prompt!.turnId).toBe("t1");
    expect(call!.text).toContain("[tool_call read call-1]");
    expect(call!.text).toContain('"path": "notes.txt"');
    expect(toolResult!.text).toContain("[tool_result call-1]");
    expect(toolResult!.text).toContain("the file says hello");
  });

  it("reports unknown message ids as not_found", async () => {
    await seedTwoTurns();
    const result = await retrieval.getMessages({ filePath }, ["m999"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.served).toEqual([]);
    expect(result.value.unserved).toEqual([{ id: "m999", reason: "not_found" }]);
  });

  it("enforces the token budget across messages in order", async () => {
    await seedTwoTurns();
    const listed = await sdk.messages.list({ filePath });
    if (!listed.ok) throw new Error("list failed");
    const prompts = listed.value.filter((record) => record.kind === "user_prompt").map((r) => r.messageId);
    // Fits the larger prompt alone but not both.
    const budget = estimateTokens("read the file please");

    const result = await retrieval.getMessages({ filePath }, prompts, { tokenBudget: budget });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.served).toHaveLength(1);
    expect(result.value.unserved[0]!.reason).toBe("budget");
  });
});

describe("byteBudget", () => {
  it("slices token-cheap byte-heavy content to fit the byte allowance", async () => {
    // Long '=' runs: BPE packs many bytes per token, so a token budget alone
    // cannot bound bytes — the codex-core truncation hazard.
    const dense = `${"=".repeat(80)}\n`.repeat(1_500);
    await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "dump" } }),
      validEvent("assistant_text", { payload: { text: dense } }),
      validEvent("turn_end"),
    ]);
    const listed = await sdk.messages.list({ filePath });
    if (!listed.ok) throw new Error("list failed");
    const denseId = listed.value.find((r) => r.kind === "assistant_text")!.messageId;

    const byteBudget = 12_000;
    const result = await retrieval.getMessages({ filePath }, [denseId], { byteBudget });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.served).toHaveLength(1);
    const served = result.value.served[0]!;
    expect(Buffer.byteLength(served.text, "utf8")).toBeLessThanOrEqual(byteBudget);
    // Receipt stays token-denominated and continues correctly.
    expect(served.slice).toBeDefined();
    expect(served.slice!.fromToken).toBe(0);
    expect(served.slice!.toToken).toBe(served.tokens);
    expect(served.slice!.toToken).toBeLessThan(served.slice!.totalTokens);

    // Continuation from the receipt serves the NEXT window, still byte-fit.
    const next = await retrieval.getMessages({ filePath }, [denseId], {
      byteBudget,
      fromToken: served.slice!.toToken,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const nextServed = next.value.served[0]!;
    expect(nextServed.slice!.fromToken).toBe(served.slice!.toToken);
    expect(Buffer.byteLength(nextServed.text, "utf8")).toBeLessThanOrEqual(byteBudget);
  });

  it("whole-serves when bytes fit and rejects non-positive byteBudget", async () => {
    await seedTwoTurns();
    const listed = await sdk.messages.list({ filePath });
    if (!listed.ok) throw new Error("list failed");
    const promptId = listed.value.find((r) => r.kind === "user_prompt")!.messageId;

    const whole = await retrieval.getMessages({ filePath }, [promptId], { byteBudget: 1_000_000 });
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    expect(whole.value.served[0]!.slice).toBeUndefined();

    const bad = await retrieval.getMessages({ filePath }, [promptId], { byteBudget: 0 });
    expect(bad.ok).toBe(false);
  });

  it("byte-spent budget marks later items unserved as budget", async () => {
    const dense = `${"=".repeat(80)}\n`.repeat(900);
    await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "dump" } }),
      validEvent("assistant_text", { payload: { text: dense } }),
      validEvent("assistant_text", { payload: { text: `${"=".repeat(80)}\n`.repeat(40) } }),
      validEvent("turn_end"),
    ]);
    const listed = await sdk.messages.list({ filePath });
    if (!listed.ok) throw new Error("list failed");
    const ids = listed.value.filter((r) => r.kind === "assistant_text").map((r) => r.messageId);

    const result = await retrieval.getMessages({ filePath }, ids, { byteBudget: 8_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // First item consumed the byte allowance as a slice; the second's
    // byte-fitting window would be a sub-floor sliver, so it reports budget.
    expect(result.value.served).toHaveLength(1);
    expect(result.value.unserved[0]!.reason).toBe("budget");
    const servedBytes = result.value.served.reduce((sum, item) => sum + Buffer.byteLength(item.text, "utf8"), 0);
    expect(servedBytes).toBeLessThanOrEqual(8_000);
  });
});

describe("impression log", () => {
  it("writes one row per requested id with served flags, sizes, and call correlation", async () => {
    await seedTwoTurns();
    await drain();
    const first = await retrieval.getTurns({ filePath }, ["t1", "t99"]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const listed = await sdk.messages.list({ filePath });
    if (!listed.ok) throw new Error("list failed");
    const promptId = listed.value.find((record) => record.kind === "user_prompt")!.messageId;
    const second = await retrieval.getMessages({ filePath }, [promptId], { surface: "board" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const impressions = await retrieval.listImpressions({ filePath });
    expect(impressions.ok).toBe(true);
    if (!impressions.ok) return;
    expect(impressions.value).toHaveLength(3);

    const [servedTurn, missingTurn, servedMessage] = impressions.value;
    expect(servedTurn).toMatchObject({
      callId: first.value.callId,
      surface: "get_turns",
      entityKind: "turn",
      entityId: "t1",
      requestIdx: 0,
      served: true,
    });
    expect(servedTurn!.tokens).toBeGreaterThan(0);
    expect(missingTurn).toMatchObject({
      entityId: "t99",
      served: false,
      reason: "not_found",
    });
    expect(servedMessage).toMatchObject({
      callId: second.value.callId,
      surface: "board",
      entityKind: "message",
      entityId: promptId,
      served: true,
    });
  });

  it("retrieval writes nothing to record tables", async () => {
    await seedTwoTurns();
    await drain();
    const before = await sdk.messages.list({ filePath });
    if (!before.ok) throw new Error("list failed");

    await retrieval.getTurns({ filePath }, ["t1", "t2"]);
    await retrieval.getMessages({ filePath }, [before.value[0]!.messageId]);

    const after = await sdk.messages.list({ filePath });
    if (!after.ok) throw new Error("list failed");
    expect(after.value).toEqual(before.value);
  });
});
