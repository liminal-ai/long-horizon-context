import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildContextServePreview,
  CONNECTOR_HOOKS,
  CONTEXT_SERVE_PREVIEW_MAX_MESSAGES,
  CONTEXT_SERVE_PREVIEW_MAX_TEXT,
  createConnector,
  rehydratePiSessionFromLhc,
  seedPiSessionFromLhc,
} from "../../src/index.js";
import type { ExtensionAPI } from "../../src/pi/types.js";
import { startCapture } from "../capture/support.js";
import {
  makeAgentEnd,
  makeAssistantMessage,
  makeMessageEnd,
  makeModelSelect,
  makeThinkingLevelSelect,
  makeToolResult,
  makeUserMessage,
} from "../fixtures/synthetic.js";
import { type TempStore, tempStore } from "../fixtures/thread.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

function recordingPi(): { pi: ExtensionAPI; registered: string[] } {
  const registered: string[] = [];
  const pi = {
    on(name: string) {
      registered.push(name);
    },
    registerCommand: () => {},
    registerTool: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    appendEntry: () => {},
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
    setModel: async () => true,
  } as ExtensionAPI;
  return { pi, registered };
}

describe("connector hook rail", () => {
  it("registers Epic 1 capture hooks and compact hooks without the context hook", () => {
    const { pi, registered } = recordingPi();
    createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      readLaunchFlags: () => ({ ok: true, value: {} }),
      startupValidationReporter: () => {},
    }).register(pi);

    expect(new Set(registered)).toEqual(new Set(CONNECTOR_HOOKS));
    expect(registered).toHaveLength(CONNECTOR_HOOKS.length);
    expect(registered).not.toContain("context");
  });
});

describe("session thread view seeding", () => {
  it("seeds captured user/assistant tail into PI session message order", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;

    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("first question")), ctx);
    await connector.handlers.message_end(makeMessageEnd(makeAssistantMessage({ text: "first answer" })), ctx);
    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("second question")), ctx);
    await connector.handlers.message_end(makeMessageEnd(makeAssistantMessage({ text: "second answer" })), ctx);
    await connector.handlers.agent_end(makeAgentEnd([]), ctx);

    const instance = connector.getInstance();
    expect(instance).not.toBeNull();
    if (instance === null) return;

    const sessionView = await instance.sdk.threadView.getSessionThreadView(threadRef);
    expect(sessionView.ok).toBe(true);
    if (!sessionView.ok) return;

    const sessionManager = {
      messages: [] as unknown[],
      appendMessage(message: unknown) {
        this.messages.push(message);
        return "m1";
      },
      appendCustomEntry() {
        return "seed_map";
      },
    };

    const messageEntries = sessionView.value.entries.filter((entry) => "role" in entry);
    const seeded = await seedPiSessionFromLhc(instance, threadRef, sessionManager as never);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.value.messageCount).toBe(messageEntries.length);
    expect(sessionManager.messages).toHaveLength(4);
    expect(sessionManager.messages.map((message) => (message as { role: string }).role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("restores native assistant and toolResult shapes for tool-heavy turns", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;

    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("read notes.txt")), ctx);
    await connector.handlers.message_end(
      makeMessageEnd(
        makeAssistantMessage({
          thinking: "I should open the file",
          text: "opening the file",
          toolCalls: [{ id: "call_x", name: "read_file", arguments: { path: "notes.txt" } }],
        }),
      ),
      ctx,
    );
    await connector.handlers.message_end(makeMessageEnd(makeToolResult({ id: "call_x", content: "file body" })), ctx);
    await connector.handlers.message_end(makeMessageEnd(makeAssistantMessage({ text: "here is the summary" })), ctx);
    await connector.handlers.agent_end(makeAgentEnd([]), ctx);

    const instance = connector.getInstance();
    expect(instance).not.toBeNull();
    if (instance === null) return;

    const sessionView = await instance.sdk.threadView.getSessionThreadView(threadRef);
    expect(sessionView.ok).toBe(true);
    if (!sessionView.ok) return;

    expect(
      sessionView.value.entries.filter((entry) => "role" in entry).map((entry) => ("role" in entry ? entry.role : "")),
    ).toEqual(["user", "assistant", "toolResult", "assistant"]);

    const assistant = sessionView.value.entries[1];
    expect(assistant !== undefined && "role" in assistant && assistant.role).toBe("assistant");
    if (assistant === undefined || !("role" in assistant) || assistant.role !== "assistant") return;
    expect(assistant.content.map((part) => part.type)).toEqual(["thinking", "text", "toolCall"]);

    const sessionManager = {
      messages: [] as Array<{ role: string; content?: unknown; toolCallId?: string }>,
      customEntries: [] as unknown[],
      appendMessage(message: { role: string; content?: unknown; toolCallId?: string }) {
        this.messages.push(message);
        return "m1";
      },
      appendCustomEntry() {
        return "c1";
      },
    };

    const rehydrated = await rehydratePiSessionFromLhc(instance, threadRef, sessionManager as never);
    expect(rehydrated.ok).toBe(true);
    if (!rehydrated.ok) return;

    expect(sessionManager.messages[1]?.role).toBe("assistant");
    const piAssistant = sessionManager.messages[1];
    expect(Array.isArray(piAssistant?.content)).toBe(true);
    expect((piAssistant?.content as Array<{ type: string }>).map((part) => part.type)).toEqual([
      "thinking",
      "text",
      "toolCall",
    ]);
    expect(sessionManager.messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_x",
    });
  });

  it("restores model and thinking-level changes through SessionManager entries", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;

    ctx.sessionManager
      .getEntries()
      .push({ type: "model_change", id: "pi-model-1", parentId: null, provider: "openai", modelId: "gpt-4o" });
    await connector.handlers.model_select(
      makeModelSelect({ provider: "openai", id: "gpt-4o" }, { provider: "anthropic", id: "claude-3" }),
      ctx,
    );
    ctx.sessionManager
      .getEntries()
      .push({ type: "thinking_level_change", id: "pi-thinking-1", parentId: "pi-model-1", thinkingLevel: "high" });
    await connector.handlers.thinking_level_select(makeThinkingLevelSelect("high", "medium"), ctx);
    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("after runtime changes")), ctx);
    await connector.handlers.agent_end(makeAgentEnd([]), ctx);

    const instance = connector.getInstance();
    expect(instance).not.toBeNull();
    if (instance === null) return;

    const sessionManager = {
      modelChanges: [] as Array<{ provider: string; modelId: string }>,
      thinkingChanges: [] as string[],
      messages: [] as unknown[],
      appendMessage(message: unknown) {
        this.messages.push(message);
        return "m1";
      },
      appendModelChange(provider: string, modelId: string) {
        this.modelChanges.push({ provider, modelId });
        return "mc1";
      },
      appendThinkingLevelChange(level: string) {
        this.thinkingChanges.push(level);
        return "tl1";
      },
      appendCustomEntry() {
        return "seed_map";
      },
    };

    const seeded = await seedPiSessionFromLhc(instance, threadRef, sessionManager as never);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    expect(sessionManager.modelChanges).toEqual([{ provider: "openai", modelId: "gpt-4o" }]);
    expect(sessionManager.thinkingChanges).toEqual(["high"]);
    expect(sessionManager.messages).toHaveLength(1);
  });
});

describe("buildContextServePreview", () => {
  it("is bounded, deterministic, and plain-data serializable", () => {
    const longText = "x".repeat(CONTEXT_SERVE_PREVIEW_MAX_TEXT + 40);
    const messages = Array.from({ length: CONTEXT_SERVE_PREVIEW_MAX_MESSAGES + 3 }, (_, index) => ({
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: [{ type: "text" as const, text: `${index}:${longText}` }],
    }));

    const built = buildContextServePreview(messages);
    expect(built.previewWindow).toBe("last");
    expect(built.preview).toHaveLength(CONTEXT_SERVE_PREVIEW_MAX_MESSAGES);
    expect(built.preview[0]?.textPreview).toMatch(/^3:x+…$/);
    expect(built.preview[0]?.textPreview.length).toBe(CONTEXT_SERVE_PREVIEW_MAX_TEXT);
    expect(built.preview.every((entry) => entry.textPreview.length <= CONTEXT_SERVE_PREVIEW_MAX_TEXT)).toBe(true);

    const clone = structuredClone(built);
    expect(clone).toEqual(built);
    expect(() => JSON.stringify(built)).not.toThrow();
  });
});
