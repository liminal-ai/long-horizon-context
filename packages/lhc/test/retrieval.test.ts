// Retrieval ops (drill-down layer): getTurns serves tagged turn renderings by
// turn id; getMessages serves verbatim message content by message id. Both
// enforce a strict in-order token budget with explicit receipts and write one
// impression row per requested id. Deterministic — no inference in any path
// (stored renderings come from prior drains; fallback composition is pure).
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

  it("reports unknown ids as not_found without charging the budget", async () => {
    await seedTwoTurns();
    await drain();
    const result = await retrieval.getTurns({ filePath }, ["t99", "t1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unserved).toEqual([{ id: "t99", reason: "not_found" }]);
    expect(result.value.served.map((turn) => turn.turnId)).toEqual(["t1"]);
  });

  it("stops at the budget with an explicit partial receipt", async () => {
    await seedTwoTurns();
    await drain();
    const full = await retrieval.getTurns({ filePath }, ["t1", "t2"]);
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    // Budget fits either turn alone but not both — the blocked turn reports
    // "budget" (it would fit an empty budget), not "exceeds_budget".
    const t2Tokens = full.value.served[1]!.tokens;

    const partial = await retrieval.getTurns({ filePath }, ["t1", "t2"], { tokenBudget: t2Tokens });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.value.served.map((turn) => turn.turnId)).toEqual(["t1"]);
    expect(partial.value.unserved).toHaveLength(1);
    const blocked = partial.value.unserved[0]!;
    expect(blocked.id).toBe("t2");
    expect(blocked.reason).toBe("budget");
    expect(blocked.tokens).toBeGreaterThan(0);
  });

  it("marks a single oversized item exceeds_budget and serves nothing for it", async () => {
    await seedTwoTurns();
    await drain();
    const result = await retrieval.getTurns({ filePath }, ["t2"], { tokenBudget: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.served).toEqual([]);
    expect(result.value.unserved[0]!.reason).toBe("exceeds_budget");
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
