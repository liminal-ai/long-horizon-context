// Empty thinking husks (bu9): Anthropic models with omitted thinking display
// emit assistant_thinking blocks with empty text. The two serving exits used
// to disagree — getLlmRequestContext rendered a standalone "[thinking]" husk
// while getSessionThreadView emitted an empty thinking part — so session
// exports diverged and resume wasn't byte-exact on fable-class models. Both
// exits now skip empty-text unsigned thinking rows at serve time; capture is
// untouched (the row stays in the record).
// Mirrors packages/lhc test/empty-thinking-husk.test.ts at the contract pin
// (TS aa56b8b + f1f6323), adapted to the Convex fixture surface.
import { describe, expect, it } from "vitest";
import { isEmptyThinkingHusk, type TailMessageRow } from "../src/shared/view_render.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

async function newFixture(): Promise<{ fixture: ServiceFixture; filePath: string }> {
  const fixture = serviceFixture();
  const { filePath } = await fixture.createThread();
  return { fixture, filePath };
}

function thinkingRow(content: Record<string, unknown>): TailMessageRow {
  return {
    messageId: "m1",
    kind: "assistant_thinking",
    recordedAt: "2026-08-06T00:00:00.000Z",
    idempotencyKey: "k1",
    blocks: [{ blockType: "text", content }],
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
  async function seedTurnWithHusk(fixture: ServiceFixture, filePath: string, thinkingText: string): Promise<void> {
    const captured = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "what is in the file?" } }),
      validEvent("assistant_thinking", { payload: { text: thinkingText } }),
      validEvent("assistant_text", { payload: { text: "The file holds three entries." } }),
      validEvent("turn_end"),
    ]);
    if (!captured.ok) throw new Error(captured.error.reason);
  }

  it("getLlmRequestContext serves no [thinking] husk", async () => {
    const { fixture, filePath } = await newFixture();
    await seedTurnWithHusk(fixture, filePath, "");
    const context = await fixture.sdk.threadView.getLlmRequestContext({ filePath });
    if (!context.ok) throw new Error(context.error.reason);
    const texts = context.value.messages.map((message) => message.content.map((part) => part.text).join("\n"));
    expect(texts.some((text) => text.includes("[thinking]"))).toBe(false);
    expect(texts.some((text) => text.includes("The file holds three entries."))).toBe(true);
  });

  it("getSessionThreadView serves no empty thinking part", async () => {
    const { fixture, filePath } = await newFixture();
    await seedTurnWithHusk(fixture, filePath, "");
    const view = await fixture.sdk.threadView.getSessionThreadView({ filePath });
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
    const { fixture, filePath } = await newFixture();
    await seedTurnWithHusk(fixture, filePath, "real reasoning text");
    const context = await fixture.sdk.threadView.getLlmRequestContext({ filePath });
    const view = await fixture.sdk.threadView.getSessionThreadView({ filePath });
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
    const { fixture, filePath } = await newFixture();
    await seedTurnWithHusk(fixture, filePath, "");
    const detail = await fixture.sdk.messages.list({ filePath });
    if (!detail.ok) throw new Error(detail.error.reason);
    const kinds = detail.value.map((message) => message.kind);
    expect(kinds).toContain("assistant_thinking");
  });

  it("does not reintroduce husks through a compacted smooth-band rendering", async () => {
    const { fixture, filePath } = await newFixture();
    for (let turn = 1; turn <= 3; turn += 1) {
      await seedTurnWithHusk(fixture, filePath, "");
    }
    for (;;) {
      const drained = await fixture.sdk.work.drain({ filePath });
      if (!drained.ok) throw new Error(drained.error.reason);
      if (drained.value.remaining === 0) break;
    }
    const compacted = await fixture.sdk.threadView.compact(
      { filePath },
      { params: { lowerBound: 40, percentages: { full: 25, smooth: 75, detailed: 0, brief: 0 } } },
    );
    if (!compacted.ok) throw new Error(compacted.error.reason);
    expect(compacted.value.bands.smooth.entries).toBeGreaterThan(0);

    const context = await fixture.sdk.threadView.getLlmRequestContext({ filePath });
    const view = await fixture.sdk.threadView.getSessionThreadView({ filePath });
    if (!context.ok || !view.ok) throw new Error("serve failed");
    const contextText = context.value.messages
      .flatMap((message) => message.content.map((part) => part.text))
      .join("\n");
    const sessionText = view.value.entries
      .filter((entry) => "role" in entry && entry.role === "user")
      .map((entry) => String((entry as { content?: unknown }).content ?? ""))
      .join("\n");
    expect(contextText).not.toContain("Assistant thinking");
    expect(sessionText).not.toContain("Assistant thinking");
  });
});
