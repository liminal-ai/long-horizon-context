// Thinking-signature capture + model identity (bu9 / u4z): fable-class models
// emit empty thinking text with an opaque signature; capture stores it
// verbatim, session-view round-trips it as thinkingSignature, and the text
// LLM path skips signature-only thinking (no carrier for the token there).
// Identity (provider/model/api) is frozen at capture so resume replays signed
// reasoning only under an exact identity match.
// Mirrors packages/lhc test/thinking-signature.test.ts at the contract pin
// (TS d0f00bb + 795da41), adapted to the Convex fixture surface.
import { beforeEach, describe, expect, it } from "vitest";
import type { Lhc } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

let fixture: ServiceFixture;
let sdk: Lhc;
let filePath: string;

beforeEach(async () => {
  fixture = serviceFixture();
  sdk = fixture.sdk;
  filePath = (await fixture.createThread()).filePath;
});

describe("assistant_thinking signature intake", () => {
  it("accepts optional signature and materializes it on the message block", async () => {
    const captured = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "hi" } }),
      validEvent("assistant_thinking", {
        payload: { text: "", signature: "enc-sig-abc" },
      }),
      validEvent("assistant_text", { payload: { text: "hello" } }),
      validEvent("turn_end"),
    ]);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const thinking = listed.value.find((row) => row.kind === "assistant_thinking");
    expect(thinking).toBeDefined();
    expect(thinking?.blocks[0]?.content).toEqual({ text: "", signature: "enc-sig-abc" });
  });

  it("rejects unknown payload fields on assistant_thinking (closed schema)", async () => {
    const result = await sdk.intakeStream.messageEvents({ filePath }, [
      {
        ...validEvent("assistant_thinking"),
        payload: { text: "x", signature: "s", extra: true },
      } as never,
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_event");
    expect(result.error.reason).toMatch(/extra|unexpected/i);
  });

  it("omitted signature stays omitted on the block (no empty key)", async () => {
    const captured = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("assistant_thinking", { payload: { text: "plain thought" } }),
      validEvent("turn_end"),
    ]);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const thinking = listed.value.find((row) => row.kind === "assistant_thinking");
    expect(thinking?.blocks[0]?.content).toEqual({ text: "plain thought" });
    expect("signature" in (thinking?.blocks[0]?.content ?? {})).toBe(false);
  });
});

describe("serving round-trip for signed thinking", () => {
  async function seedSignedEmpty(): Promise<void> {
    const captured = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "what changed?" } }),
      validEvent("assistant_thinking", {
        payload: { text: "", signature: "enc-fable-sig-001" },
      }),
      validEvent("assistant_text", { payload: { text: "Three files changed." } }),
      validEvent("turn_end"),
    ]);
    if (!captured.ok) throw new Error(captured.error.reason);
  }

  it("getSessionThreadView emits thinkingSignature on the thinking part", async () => {
    await seedSignedEmpty();
    const view = await sdk.threadView.getSessionThreadView({ filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const parts = view.value.entries.flatMap((entry) =>
      "role" in entry && entry.role === "assistant" && Array.isArray(entry.content) ? entry.content : [],
    );
    const thinking = parts.find((part) => part.type === "thinking");
    expect(thinking).toEqual({
      type: "thinking",
      thinking: "",
      thinkingSignature: "enc-fable-sig-001",
    });
  });

  it("getLlmRequestContext skips signature-only thinking (text path cannot carry the token)", async () => {
    await seedSignedEmpty();
    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const texts = context.value.messages.map((message) => message.content.map((part) => part.text).join("\n"));
    expect(texts.some((text) => text.includes("[thinking]"))).toBe(false);
    expect(texts.some((text) => text.includes("Three files changed."))).toBe(true);
  });

  it("non-empty thinking text with signature still serves on both exits", async () => {
    const captured = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "q" } }),
      validEvent("assistant_thinking", {
        payload: { text: "visible reasoning", signature: "enc-sig-2" },
      }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    const view = await sdk.threadView.getSessionThreadView({ filePath });
    expect(context.ok && view.ok).toBe(true);
    if (!context.ok || !view.ok) return;

    const texts = context.value.messages.map((message) => message.content.map((part) => part.text).join("\n"));
    expect(texts.some((text) => text.includes("[thinking]\nvisible reasoning"))).toBe(true);

    const parts = view.value.entries.flatMap((entry) =>
      "role" in entry && entry.role === "assistant" && Array.isArray(entry.content) ? entry.content : [],
    );
    expect(parts.some((part) => part.type === "thinking" && part.thinkingSignature === "enc-sig-2")).toBe(true);
  });
});

describe("assistant model identity for resume", () => {
  it("stores provider/model/api on thinking blocks and surfaces them on session-view", async () => {
    const captured = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "q" } }),
      validEvent("assistant_thinking", {
        payload: {
          text: "",
          signature: "enc-prov",
          provider: "anthropic",
          model: "claude-fable-5",
          api: "anthropic-messages",
        },
      }),
      validEvent("assistant_text", {
        payload: {
          text: "a",
          provider: "anthropic",
          model: "claude-fable-5",
          api: "anthropic-messages",
        },
      }),
      validEvent("turn_end"),
    ]);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const thinking = listed.value.find((row) => row.kind === "assistant_thinking");
    expect(thinking?.blocks[0]?.content).toMatchObject({
      text: "",
      signature: "enc-prov",
      provider: "anthropic",
      model: "claude-fable-5",
      api: "anthropic-messages",
    });

    const view = await sdk.threadView.getSessionThreadView({ filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const assistant = view.value.entries.find((entry) => "role" in entry && entry.role === "assistant") as
      | { provider?: string; model?: string; api?: string }
      | undefined;
    expect(assistant?.provider).toBe("anthropic");
    expect(assistant?.model).toBe("claude-fable-5");
    expect(assistant?.api).toBe("anthropic-messages");
  });
});
