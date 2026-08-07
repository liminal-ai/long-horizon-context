// Thinking-signature capture: PI ThinkingPart.thinkingSignature → LHC
// assistant_thinking.payload.signature → session-view thinkingSignature →
// PI resume part. Closes the fable resume gap where empty-text signed thinking
// was dropped at capture and could not be replayed.
import { createDeterministicInferenceCallbacks, initLhc, threads } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapMessage } from "../../src/capture/map-message.js";
import { applySessionThreadViewToSessionManager } from "../../src/serving/context.js";
import { makeAssistantMessage, makeUserMessage } from "../fixtures/synthetic.js";
import { type TempStore, tempStore } from "../fixtures/thread.js";

describe("mapMessage thinkingSignature", () => {
  it("stores opaque thinkingSignature as payload.signature on assistant_thinking", () => {
    const events = mapMessage(
      makeAssistantMessage({
        thinking: "",
        thinkingSignature: "enc-anthropic-abc",
        text: "done",
        provider: "anthropic",
        model: "claude-fable-5",
        api: "anthropic-messages",
      }),
      { piSessionId: "s", entryId: "e1" },
    );
    const thinking = events.find((event) => event.eventKind === "assistant_thinking");
    expect(thinking).toBeDefined();
    expect(thinking!.payload).toEqual({
      text: "",
      signature: "enc-anthropic-abc",
      provider: "anthropic",
      model: "claude-fable-5",
      api: "anthropic-messages",
    });
  });

  it("omits signature key when the PI part has none", () => {
    const events = mapMessage(makeAssistantMessage({ thinking: "plain", text: "x" }), {
      piSessionId: "s",
      entryId: "e2",
    });
    const thinking = events.find((event) => event.eventKind === "assistant_thinking");
    expect(thinking!.payload).toEqual({ text: "plain", provider: "test", model: "test-model" });
    expect("signature" in thinking!.payload).toBe(false);
  });

  it("keeps thinking-only signed messages (no text vehicle) without inventing usage", () => {
    const events = mapMessage(
      makeAssistantMessage({
        thinking: "",
        thinkingSignature: "enc-only",
      }),
      { piSessionId: "s", entryId: "e3" },
    );
    expect(events.map((event) => event.eventKind)).toEqual(["assistant_thinking"]);
    expect(events[0]!.payload).toEqual({
      text: "",
      signature: "enc-only",
      provider: "test",
      model: "test-model",
    });
  });
});

describe("resume round-trip restores thinkingSignature onto PI session parts", () => {
  let store: TempStore;
  beforeEach(() => {
    store = tempStore();
  });
  afterEach(() => {
    store.cleanup();
  });

  it("capture → getSessionThreadView → applySessionThreadView keeps signature and model identity", async () => {
    const sdk = initLhc({
      mode: "manual",
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
    });
    const threadPath = store.threadPath();
    const created = await threads.newThread({
      filePath: threadPath,
      registryPath: store.registryPath,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const mapped = [
      ...mapMessage(makeUserMessage("resume me"), { piSessionId: "s", entryId: "u1" }),
      ...mapMessage(
        makeAssistantMessage({
          thinking: "",
          thinkingSignature: "enc-round-trip-99",
          text: "restored",
          provider: "anthropic",
          model: "claude-fable-5",
          api: "anthropic-messages",
        }),
        { piSessionId: "s", entryId: "a1" },
      ),
    ];
    // turn_end so the turn closes cleanly for serving
    mapped.push({
      eventKind: "turn_end",
      idempotencyKey: "pi:s:turn-end",
      actor: "system",
      harness: "pi",
      payload: {},
    });

    const recorded = await sdk.intakeStream.messageEvents({ filePath: threadPath }, mapped);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const view = await sdk.threadView.getSessionThreadView({ filePath: threadPath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    const appended: Array<{ role: string; content: unknown }> = [];
    const sessionManager = {
      appendMessage(message: { role: string; content: unknown }) {
        appended.push(message);
        return `pi-entry-${appended.length}`;
      },
      appendModelChange() {
        return "pi-model";
      },
      appendThinkingLevelChange() {
        return "pi-thinking-level";
      },
      appendCustomEntry() {
        return "pi-custom";
      },
    };

    applySessionThreadViewToSessionManager(sessionManager as never, view.value.entries, "th_sig");

    const assistant = appended.find((message) => message.role === "assistant") as
      | {
          role: string;
          content: Array<{ type: string; thinking?: string; thinkingSignature?: string; text?: string }>;
          provider?: string;
          model?: string;
          api?: string;
        }
      | undefined;
    expect(assistant).toBeDefined();
    const parts = assistant!.content;
    const thinking = parts.find((part) => part.type === "thinking");
    expect(thinking).toEqual({
      type: "thinking",
      thinking: "",
      thinkingSignature: "enc-round-trip-99",
    });
    expect(parts.some((part) => part.type === "text" && part.text === "restored")).toBe(true);
    // Real identity — not the synthetic lhc/thread-view fallback — so PI's
    // same-model check can keep the signature on the live provider path.
    expect(assistant!.provider).toBe("anthropic");
    expect(assistant!.model).toBe("claude-fable-5");
    expect(assistant!.api).toBe("anthropic-messages");
  });
});
