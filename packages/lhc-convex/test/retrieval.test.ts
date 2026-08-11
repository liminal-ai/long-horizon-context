// Retrieval ops (drill-down layer): getTurns serves tagged turn renderings by
// turn id; getMessages serves verbatim message content by message id. Both
// enforce an in-order token budget: the item crossing the budget is served as
// an exact token slice with a continuation receipt (fromToken), later items
// get explicit "budget" receipts, and every requested id writes one impression
// row. Deterministic — no inference in any path (stored renderings come from
// prior drains; fallback composition is pure).
// Mirrors packages/lhc test/retrieval.test.ts at the contract pin.
import { beforeEach, describe, expect, it } from "vitest";
import { estimateTokens, type Lhc, type MessageEventInput } from "../src/client/index.js";
import { utf8ByteLength } from "../src/shared/token_counting/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

let fixture: ServiceFixture;
let sdk: Lhc;
let filePath: string;

async function send(events: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, events);
  if (!result.ok) throw new Error(`intake failed: ${result.error.reason}`);
}

async function drain(): Promise<void> {
  for (;;) {
    const result = await sdk.work.drain({ filePath });
    if (!result.ok) throw new Error(`drain failed: ${result.error.reason}`);
    if (result.value.remaining === 0) return;
  }
}

beforeEach(async () => {
  fixture = serviceFixture();
  sdk = fixture.sdk;
  filePath = (await fixture.createThread()).filePath;
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

    const result = await sdk.retrieval.getTurns({ filePath }, ["t2", "t1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt = result.value;
    expect(receipt.served.map((turn) => turn.turnId)).toEqual(["t2", "t1"]);
    expect(receipt.unserved).toEqual([]);
    const t2 = receipt.served[0];
    expect(t2?.source).toBe("stored");
    expect(t2?.text).toContain("<t2>");
    expect(t2?.text).toContain("</t2>");
    // [calibrated] The frozen double's smoothing is input-preserving, so the
    // frozen leg asserts the prompt text; the Convex fake host serves canned
    // smoothed output. Same behavioral claim: the READY smoothed derivation
    // (not the raw prompt) flows into the stored rendering.
    expect(t2?.text).toContain("canned smoothed_prompt text");
    // Message tags inside the rendering are the get_messages handles.
    expect(t2?.text).toMatch(/<m\d+>/);
    expect(receipt.totalTokens).toBe(receipt.served.reduce((sum, turn) => sum + turn.tokens, 0));
  });

  it("composes a live fallback when the rendering derivation is not ready", async () => {
    await seedTwoTurns();
    // No drain: turn_rendering rows are pending.
    const result = await sdk.retrieval.getTurns({ filePath }, ["t1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const turn = result.value.served[0];
    expect(turn?.source).toBe("composed");
    expect(turn?.text).toContain("<t1>");
    expect(turn?.text).toContain("first question");
  });

  it("composes a tagged fallback for a ready legacy rendering without turn labels", async () => {
    await seedTwoTurns();
    await drain();
    // Raw-state seam: rewrite the stored rendering to a pre-label legacy body.
    await fixture.test.run(async (ctx) => {
      const rows = await ctx.db.query("derivations").collect();
      const row = rows.find(
        (candidate) =>
          candidate.instance === fixture.instance &&
          candidate.scope === "turn" &&
          candidate.subject === "t1" &&
          candidate.deriv === "turn_rendering",
      );
      if (row === undefined) throw new Error("turn_rendering row missing");
      await ctx.db.patch("derivations", row._id, { content: "legacy untagged rendering" });
    });

    const result = await sdk.retrieval.getTurns({ filePath }, ["t1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const turn = result.value.served[0];
    expect(turn?.source).toBe("composed");
    expect(turn?.text).toContain("<t1>");
    expect(turn?.text).toContain("<m1>");
    expect(turn?.text).not.toContain("legacy untagged rendering");
  });

  it("reports unknown ids as not_found without charging the budget", async () => {
    await seedTwoTurns();
    await drain();
    const result = await sdk.retrieval.getTurns({ filePath }, ["t99", "t1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unserved).toEqual([{ id: "t99", reason: "not_found" }]);
    expect(result.value.served.map((turn) => turn.turnId)).toEqual(["t1"]);
  });

  it('reports "budget" for the crossing item when too little budget remains to slice', async () => {
    await seedTwoTurns();
    await drain();
    const full = await sdk.retrieval.getTurns({ filePath }, ["t1", "t2"]);
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    // Budget fits either fixture turn alone but not both; the leftover after
    // t1 is far below RETRIEVAL_SLICE_FLOOR, so t2 is refused, not slivered.
    const t2Tokens = full.value.served[1]?.tokens ?? 0;

    const partial = await sdk.retrieval.getTurns({ filePath }, ["t1", "t2"], { tokenBudget: t2Tokens });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.value.served.map((turn) => turn.turnId)).toEqual(["t1"]);
    expect(partial.value.served[0]?.slice).toBeUndefined();
    expect(partial.value.unserved).toHaveLength(1);
    const blocked = partial.value.unserved[0];
    expect(blocked?.id).toBe("t2");
    expect(blocked?.reason).toBe("budget");
    expect(blocked?.tokens ?? 0).toBeGreaterThan(0);
  });

  it("slices an oversized turn to the budget with a continuation receipt", async () => {
    await seedBigTurn();
    await drain();
    const result = await sdk.retrieval.getTurns({ filePath }, ["t1"], { tokenBudget: 500 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const turn = result.value.served[0];
    expect(turn?.slice).toBeDefined();
    expect(turn?.slice?.fromToken).toBe(0);
    expect(turn?.slice?.toToken).toBe(500);
    expect(turn?.slice?.totalTokens ?? 0).toBeGreaterThan(500);
    expect(turn?.tokens).toBe(500);
    expect(result.value.totalTokens).toBe(500);
  });

  it("fromToken continuation slices reassemble the full text", async () => {
    await seedBigTurn();
    await drain();
    const whole = await sdk.retrieval.getTurns({ filePath }, ["t1"]);
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    const fullText = whole.value.served[0]?.text ?? "";

    let assembled = "";
    let from = 0;
    for (let hop = 0; hop < 20; hop += 1) {
      const part = await sdk.retrieval.getTurns({ filePath }, ["t1"], { tokenBudget: 400, fromToken: from });
      expect(part.ok).toBe(true);
      if (!part.ok) return;
      const slice = part.value.served[0];
      expect(slice?.slice).toBeDefined();
      if (slice?.slice === undefined) return;
      assembled += slice.text;
      from = slice.slice.toToken;
      if (from >= slice.slice.totalTokens) break;
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
    const result = await sdk.retrieval.getTurns({ filePath }, ["t1", "t2"], { tokenBudget: 500 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.served).toHaveLength(1);
    expect(result.value.served[0]?.turnId).toBe("t1");
    expect(result.value.served[0]?.slice).toBeDefined();
    expect(result.value.unserved).toEqual([{ id: "t2", reason: "budget", tokens: expect.any(Number) }]);
  });

  it("rejects a negative or fractional fromToken", async () => {
    await seedTwoTurns();
    const negative = await sdk.retrieval.getTurns({ filePath }, ["t1"], { fromToken: -1 });
    expect(negative.ok).toBe(false);
    const fractional = await sdk.retrieval.getTurns({ filePath }, ["t1"], { fromToken: 1.5 });
    expect(fractional.ok).toBe(false);
  });

  it("collapses duplicate ids to one serve", async () => {
    await seedTwoTurns();
    await drain();
    const result = await sdk.retrieval.getTurns({ filePath }, ["t1", "t1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.served).toHaveLength(1);
  });

  it("rejects an empty id list and a non-positive budget", async () => {
    const empty = await sdk.retrieval.getTurns({ filePath }, []);
    expect(empty.ok).toBe(false);
    const bad = await sdk.retrieval.getTurns({ filePath }, ["t1"], { tokenBudget: 0 });
    expect(bad.ok).toBe(false);
  });
});

describe("getMessages", () => {
  it("serves verbatim text, tool calls, and tool results with pairing ids", async () => {
    await seedTwoTurns();
    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const firstOf = (kind: string) => listed.value.find((record) => record.kind === kind);
    const promptId = firstOf("user_prompt")?.messageId ?? "";
    const callId = firstOf("tool_call")?.messageId ?? "";
    const resultId = firstOf("tool_result")?.messageId ?? "";

    const result = await sdk.retrieval.getMessages({ filePath }, [promptId, callId, resultId]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [prompt, call, toolResult] = result.value.served;
    expect(prompt?.text).toBe("first question");
    expect(prompt?.kind).toBe("user_prompt");
    expect(prompt?.turnId).toBe("t1");
    expect(call?.text).toContain("[tool_call read call-1]");
    expect(call?.text).toContain('"path": "notes.txt"');
    expect(toolResult?.text).toContain("[tool_result call-1]");
    expect(toolResult?.text).toContain("the file says hello");
  });

  it("reports unknown message ids as not_found", async () => {
    await seedTwoTurns();
    const result = await sdk.retrieval.getMessages({ filePath }, ["m999"]);
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

    const result = await sdk.retrieval.getMessages({ filePath }, prompts, { tokenBudget: budget });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.served).toHaveLength(1);
    expect(result.value.unserved[0]?.reason).toBe("budget");
  });
});

describe("byteBudget", () => {
  it("slices token-cheap byte-heavy content to fit the byte allowance", async () => {
    // Long '=' runs: BPE packs many bytes per token, so a token budget alone
    // cannot bound bytes — the codex-core truncation hazard.
    const dense = `${"=".repeat(80)}\n`.repeat(1_500);
    await send([
      validEvent("user_prompt", { payload: { text: "dump" } }),
      validEvent("assistant_text", { payload: { text: dense } }),
      validEvent("turn_end"),
    ]);
    const listed = await sdk.messages.list({ filePath });
    if (!listed.ok) throw new Error("list failed");
    const denseId = listed.value.find((r) => r.kind === "assistant_text")?.messageId ?? "";

    const byteBudget = 12_000;
    const result = await sdk.retrieval.getMessages({ filePath }, [denseId], { byteBudget });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.served).toHaveLength(1);
    const served = result.value.served[0];
    if (served?.slice === undefined) throw new Error("expected slice");
    expect(utf8ByteLength(served.text)).toBeLessThanOrEqual(byteBudget);
    // Receipt stays token-denominated and continues correctly.
    expect(served.slice.fromToken).toBe(0);
    expect(served.slice.toToken).toBe(served.tokens);
    expect(served.slice.toToken).toBeLessThan(served.slice.totalTokens);

    // Continuation from the receipt serves the NEXT window, still byte-fit.
    const next = await sdk.retrieval.getMessages({ filePath }, [denseId], {
      byteBudget,
      fromToken: served.slice.toToken,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const nextServed = next.value.served[0];
    expect(nextServed?.slice?.fromToken).toBe(served.slice.toToken);
    expect(utf8ByteLength(nextServed?.text ?? "")).toBeLessThanOrEqual(byteBudget);
  });

  it("multi-byte content never splits a char at the slice tail", async () => {
    // Each crab is 4 UTF-8 bytes and >1 token; byte caps that land inside a
    // char must shrink to the clean boundary — no U+FFFD, no mid-char
    // continuation offset (round-5 finding 1).
    const crabs = `${"\u{1F980}".repeat(20)}\n`.repeat(200);
    await send([
      validEvent("user_prompt", { payload: { text: "dump" } }),
      validEvent("assistant_text", { payload: { text: crabs } }),
      validEvent("turn_end"),
    ]);
    const listed = await sdk.messages.list({ filePath });
    if (!listed.ok) throw new Error("list failed");
    const crabId = listed.value.find((r) => r.kind === "assistant_text")?.messageId ?? "";

    let from = 0;
    let reassembled = "";
    for (let i = 0; i < 40 && reassembled.length < crabs.length; i += 1) {
      const page = await sdk.retrieval.getMessages({ filePath }, [crabId], {
        byteBudget: 1_001,
        fromToken: from,
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      const served = page.value.served[0];
      if (served === undefined) return;
      expect(served.text).not.toContain("�");
      expect(utf8ByteLength(served.text)).toBeLessThanOrEqual(1_001);
      if (served.slice === undefined || served.slice.toToken === served.slice.totalTokens) {
        reassembled += served.text;
        break;
      }
      expect(served.slice.toToken).toBeGreaterThan(from);
      reassembled += served.text;
      from = served.slice.toToken;
    }
    expect(reassembled.startsWith("\u{1F980}")).toBe(true);
    expect(reassembled).not.toContain("�");
  });

  it("byte-dense content stays retrievable when bytes bind below the token floor", async () => {
    // Hundreds of '=' lines are thousands of bytes but few o200k tokens: the
    // byte-fit window sits under the 256-token floor. Byte-bound serves must
    // not be refused as slivers — that would make the content permanently
    // unretrievable (round-5 finding 2).
    const dense = `${"=".repeat(80)}\n`.repeat(900);
    await send([
      validEvent("user_prompt", { payload: { text: "dump" } }),
      validEvent("assistant_text", { payload: { text: dense } }),
      validEvent("turn_end"),
    ]);
    const listed = await sdk.messages.list({ filePath });
    if (!listed.ok) throw new Error("list failed");
    const denseId = listed.value.find((r) => r.kind === "assistant_text")?.messageId ?? "";

    const result = await sdk.retrieval.getMessages({ filePath }, [denseId], { byteBudget: 8_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.served).toHaveLength(1);
    const served = result.value.served[0];
    expect(utf8ByteLength(served?.text ?? "")).toBeLessThanOrEqual(8_000);
    expect(served?.slice).toBeDefined();
    expect(served?.slice?.toToken ?? 0).toBeGreaterThan(0);
  });

  it("whole-serves when bytes fit and rejects non-positive byteBudget", async () => {
    await seedTwoTurns();
    const listed = await sdk.messages.list({ filePath });
    if (!listed.ok) throw new Error("list failed");
    const promptId = listed.value.find((r) => r.kind === "user_prompt")?.messageId ?? "";

    const whole = await sdk.retrieval.getMessages({ filePath }, [promptId], { byteBudget: 1_000_000 });
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    expect(whole.value.served[0]?.slice).toBeUndefined();

    const bad = await sdk.retrieval.getMessages({ filePath }, [promptId], { byteBudget: 0 });
    expect(bad.ok).toBe(false);
  });

  it("byte-spent budget marks later items unserved as budget", async () => {
    const dense = `${"=".repeat(80)}\n`.repeat(900);
    await send([
      validEvent("user_prompt", { payload: { text: "dump" } }),
      validEvent("assistant_text", { payload: { text: dense } }),
      validEvent("assistant_text", { payload: { text: `${"=".repeat(80)}\n`.repeat(40) } }),
      validEvent("turn_end"),
    ]);
    const listed = await sdk.messages.list({ filePath });
    if (!listed.ok) throw new Error("list failed");
    const ids = listed.value.filter((r) => r.kind === "assistant_text").map((r) => r.messageId);

    const result = await sdk.retrieval.getMessages({ filePath }, ids, { byteBudget: 8_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The first item consumes most of the byte allowance as a slice; the
    // second gets the byte-bound remainder — small, but served with a
    // continuation receipt (byte-bound serves are exempt from the sliver
    // floor: re-pulling alone cannot yield more bytes).
    expect(result.value.served).toHaveLength(2);
    expect(result.value.served[1]?.slice).toBeDefined();
    const servedBytes = result.value.served.reduce((sum, item) => sum + utf8ByteLength(item.text), 0);
    expect(servedBytes).toBeLessThanOrEqual(8_000);
  });
});

describe("impression log", () => {
  it("writes one row per requested id with served flags, sizes, and call correlation", async () => {
    await seedTwoTurns();
    await drain();
    const first = await sdk.retrieval.getTurns({ filePath }, ["t1", "t99"]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const listed = await sdk.messages.list({ filePath });
    if (!listed.ok) throw new Error("list failed");
    const promptId = listed.value.find((record) => record.kind === "user_prompt")?.messageId ?? "";
    const second = await sdk.retrieval.getMessages({ filePath }, [promptId], { surface: "board" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const impressions = await sdk.retrieval.listImpressions({ filePath });
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
    expect(servedTurn?.tokens ?? 0).toBeGreaterThan(0);
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

    await sdk.retrieval.getTurns({ filePath }, ["t1", "t2"]);
    await sdk.retrieval.getMessages({ filePath }, [before.value[0]?.messageId ?? ""]);

    const after = await sdk.messages.list({ filePath });
    if (!after.ok) throw new Error("list failed");
    expect(after.value).toEqual(before.value);
  });
});
