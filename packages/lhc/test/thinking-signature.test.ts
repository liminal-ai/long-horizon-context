// Thinking-signature capture (resume fidelity on fable-class models):
// assistant_thinking may carry an opaque provider signature. Capture stores it
// verbatim; session-view round-trips it as thinkingSignature; the text LLM
// path still skips signature-only blocks (no place to put the token).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeterministicInferenceCallbacks, initLhc, intakeStream, type Lhc, messages } from "../src/index.js";
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

beforeEach(async () => {
  store = tempStore();
  sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
  filePath = await newThread();
});
afterEach(() => {
  store.cleanup();
});

describe("assistant_thinking signature intake", () => {
  it("accepts optional signature and materializes it on the message block", async () => {
    const captured = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "hi" } }),
      validEvent("assistant_thinking", {
        payload: { text: "", signature: "enc-sig-abc" },
      }),
      validEvent("assistant_text", { payload: { text: "hello" } }),
      validEvent("turn_end"),
    ]);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    const listed = await messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const thinking = listed.value.find((row) => row.kind === "assistant_thinking");
    expect(thinking).toBeDefined();
    expect(thinking!.blocks[0]?.content).toEqual({ text: "", signature: "enc-sig-abc" });
  });

  it("rejects unknown payload fields on assistant_thinking (closed schema)", async () => {
    const result = await intakeStream.messageEvents({ filePath }, [
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
    const captured = await intakeStream.messageEvents({ filePath }, [
      validEvent("assistant_thinking", { payload: { text: "plain thought" } }),
      validEvent("turn_end"),
    ]);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const listed = await messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const thinking = listed.value.find((row) => row.kind === "assistant_thinking");
    expect(thinking!.blocks[0]?.content).toEqual({ text: "plain thought" });
    expect("signature" in (thinking!.blocks[0]?.content ?? {})).toBe(false);
  });
});

describe("serving round-trip for signed thinking", () => {
  async function seedSignedEmpty(): Promise<void> {
    const captured = await intakeStream.messageEvents({ filePath }, [
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
    const captured = await intakeStream.messageEvents({ filePath }, [
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
