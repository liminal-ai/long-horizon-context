// Empty thinking husks (bu9): Anthropic models with omitted thinking display
// emit assistant_thinking blocks with empty text. The two serving exits used
// to disagree — getLlmRequestContext rendered a standalone "[thinking]" husk
// while getSessionThreadView emitted an empty thinking part — so session
// exports diverged and resume wasn't byte-exact on fable-class models. Both
// exits now skip empty-text unsigned thinking rows at serve time; capture is
// untouched (the row stays in the record).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeterministicInferenceCallbacks, initLhc, type Lhc } from "../src/index.js";
import { isEmptyThinkingHusk } from "../src/thread-view/internal/render.js";
import type { TailMessageRow } from "../src/thread-view/internal/snapshot.js";
import { type TempStore, tempStore, validEvent } from "./fixtures/index.js";

let store: TempStore;
let sdk: Lhc;
let filePath: string;

async function newThread(sdk: Lhc): Promise<string> {
  const path = store.threadPath();
  const created = await sdk.threads.newThread({ filePath: path, registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  return path;
}

beforeEach(async () => {
  store = tempStore();
  sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
  filePath = await newThread(sdk);
});
afterEach(() => {
  store.cleanup();
});

function thinkingRow(content: Record<string, unknown>): TailMessageRow {
  return {
    messageId: "m1",
    kind: "assistant_thinking",
    recordedAt: "2026-08-06T00:00:00.000Z",
    idempotencyKey: "k1",
    blocks: [{ blockType: "assistant_thinking", content }],
  } as unknown as TailMessageRow;
}

describe("isEmptyThinkingHusk predicate", () => {
  it("skips empty-text unsigned thinking", () => {
    expect(isEmptyThinkingHusk(thinkingRow({ text: "" }))).toBe(true);
  });
  it("skips whitespace-only unsigned thinking", () => {
    expect(isEmptyThinkingHusk(thinkingRow({ text: "  \n\t" }))).toBe(true);
  });
  it("serves thinking with real text", () => {
    expect(isEmptyThinkingHusk(thinkingRow({ text: "reasoning here" }))).toBe(false);
  });
  it("serves empty-text thinking that carries a signature (future signature capture)", () => {
    expect(isEmptyThinkingHusk(thinkingRow({ text: "", signature: "enc-abc123" }))).toBe(false);
    expect(isEmptyThinkingHusk(thinkingRow({ text: "", thinkingSignature: "enc-abc123" }))).toBe(false);
  });
  it("never matches non-thinking kinds", () => {
    const row = { ...thinkingRow({ text: "" }), kind: "assistant_text" } as unknown as TailMessageRow;
    expect(isEmptyThinkingHusk(row)).toBe(false);
  });
});

describe("serving exits agree on empty thinking husks", () => {
  async function seedTurnWithHusk(thinkingText: string): Promise<void> {
    const captured = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "what is in the file?" } }),
      validEvent("assistant_thinking", { payload: { text: thinkingText } }),
      validEvent("assistant_text", { payload: { text: "The file holds three entries." } }),
      validEvent("turn_end"),
    ]);
    if (!captured.ok) throw new Error(captured.error.reason);
  }

  it("getLlmRequestContext serves no [thinking] husk", async () => {
    await seedTurnWithHusk("");
    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    if (!context.ok) throw new Error(context.error.reason);
    const texts = context.value.messages.map((message) => message.content.map((part) => part.text).join("\n"));
    expect(texts.some((text) => text.includes("[thinking]"))).toBe(false);
    expect(texts.some((text) => text.includes("The file holds three entries."))).toBe(true);
  });

  it("getSessionThreadView serves no empty thinking part", async () => {
    await seedTurnWithHusk("");
    const view = await sdk.threadView.getSessionThreadView({ filePath });
    if (!view.ok) throw new Error(view.error.reason);
    const parts = view.value.entries.flatMap((entry) =>
      "role" in entry && entry.role === "assistant" && Array.isArray(entry.content)
        ? (entry.content as ReadonlyArray<{ type: string }>)
        : [],
    );
    expect(parts.some((part) => part.type === "thinking")).toBe(false);
    expect(parts.some((part) => part.type === "text")).toBe(true);
  });

  it("non-empty thinking still serves through both exits", async () => {
    await seedTurnWithHusk("real reasoning text");
    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    const view = await sdk.threadView.getSessionThreadView({ filePath });
    if (!context.ok || !view.ok) throw new Error("serve failed");
    const texts = context.value.messages.map((message) => message.content.map((part) => part.text).join("\n"));
    expect(texts.some((text) => text.includes("[thinking]\nreal reasoning text"))).toBe(true);
    const parts = view.value.entries.flatMap((entry) =>
      "role" in entry && entry.role === "assistant" && Array.isArray(entry.content)
        ? (entry.content as ReadonlyArray<{ type: string; thinking?: string }>)
        : [],
    );
    expect(parts.some((part) => part.type === "thinking" && part.thinking === "real reasoning text")).toBe(true);
  });

  it("the record keeps the husk row (capture untouched)", async () => {
    await seedTurnWithHusk("");
    const detail = await sdk.messages.list({ filePath });
    if (!detail.ok) throw new Error(detail.error.reason);
    const kinds = detail.value.map((message) => message.kind);
    expect(kinds).toContain("assistant_thinking");
  });

  it("does not reintroduce husks through a compacted smooth-band rendering", async () => {
    for (let turn = 1; turn <= 3; turn += 1) {
      await seedTurnWithHusk("");
    }
    const drained = await sdk.work.drain({ filePath });
    if (!drained.ok) throw new Error(drained.error.reason);
    const compacted = await sdk.threadView.compact(
      { filePath },
      { params: { lowerBound: 40, percentages: { full: 25, smooth: 75, detailed: 0, brief: 0 } } },
    );
    if (!compacted.ok) throw new Error(compacted.error.reason);
    expect(compacted.value.bands.smooth.entries).toBeGreaterThan(0);

    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    const view = await sdk.threadView.getSessionThreadView({ filePath });
    if (!context.ok || !view.ok) throw new Error("serve failed");
    const contextText = context.value.messages
      .flatMap((message) => message.content.map((part) => part.text))
      .join("\n");
    const sessionText = view.value.entries
      .filter((entry) => "role" in entry && entry.role === "user")
      .map((entry) => entry.content)
      .join("\n");
    expect(contextText).not.toContain("Assistant thinking");
    expect(sessionText).not.toContain("Assistant thinking");
  });
});
