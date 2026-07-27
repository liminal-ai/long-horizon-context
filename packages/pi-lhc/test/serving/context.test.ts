import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONNECTOR_HOOKS, createConnector, rehydratePiSessionFromLhc, seedPiSessionFromLhc } from "../../src/index.js";
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

  it("folds parallel tool-result omission runtime_notes so results stay consecutive on rehydrate", async () => {
    // Exact production shape: assistant with 4 parallel image-read calls; each
    // PI toolResult fans out as tool_result + omission runtime_note sharing the
    // same PI entry identity (legacy entryId → capture entry-tier keys).
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;

    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("read four images")), ctx);
    await connector.handlers.message_end(
      makeMessageEnd(
        makeAssistantMessage({
          toolCalls: [1, 2, 3, 4].map((n) => ({
            id: `call_${n}`,
            name: "read",
            arguments: { path: `img${n}.png` },
          })),
        }),
        "pi-asst-parallel",
      ),
      ctx,
    );

    for (const n of [1, 2, 3, 4]) {
      await connector.handlers.message_end(
        makeMessageEnd(
          {
            role: "toolResult",
            toolCallId: `call_${n}`,
            content: [
              { type: "text", text: `meta ${n}` },
              { type: "image", mimeType: "image/png" },
            ],
            timestamp: 1_700_000_000_000,
          },
          `pi-tool-result-${n}`,
        ),
        ctx,
      );
    }
    await connector.handlers.agent_end(makeAgentEnd([]), ctx);

    const instance = connector.getInstance();
    expect(instance).not.toBeNull();
    if (instance === null) return;

    // SessionThreadView still surfaces omission notes as independent user
    // entries — the fold is PI reconstruction only.
    const sessionView = await instance.sdk.threadView.getSessionThreadView(threadRef);
    expect(sessionView.ok).toBe(true);
    if (!sessionView.ok) return;
    const viewRoles = sessionView.value.entries
      .filter((entry) => "role" in entry)
      .map((entry) => ("role" in entry ? entry.role : ""));
    expect(viewRoles).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
      "toolResult",
      "user",
      "toolResult",
      "user",
      "toolResult",
      "user",
    ]);

    const sessionManager = {
      messages: [] as Array<{ role: string; content?: unknown; toolCallId?: string }>,
      appendMessage(message: { role: string; content?: unknown; toolCallId?: string }) {
        this.messages.push(message);
        return `seed_${this.messages.length}`;
      },
      appendCustomEntry() {
        return "seed_map";
      },
    };

    const rehydrated = await rehydratePiSessionFromLhc(instance, threadRef, sessionManager as never);
    expect(rehydrated.ok).toBe(true);
    if (!rehydrated.ok) return;

    // Invariant: assistant(with tool calls) immediately followed by 4 consecutive
    // toolResult messages — no interleaved runtime-note user entries.
    expect(sessionManager.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "toolResult",
      "toolResult",
    ]);

    const assistant = sessionManager.messages[1];
    expect(Array.isArray(assistant?.content)).toBe(true);
    expect((assistant?.content as Array<{ type: string }>).filter((p) => p.type === "toolCall")).toHaveLength(4);

    for (let n = 1; n <= 4; n += 1) {
      const result = sessionManager.messages[n + 1];
      expect(result).toMatchObject({ role: "toolResult", toolCallId: `call_${n}` });
      const textParts = (result?.content as Array<{ type: string; text?: string }>) ?? [];
      const text = textParts.map((p) => p.text ?? "").join("");
      expect(text).toContain(`meta ${n}`);
      expect(text).toContain("[tool-result omission]");
      expect(text).toContain("unsupported content omitted: image part");
    }
  });

  it("keeps structurally unassociated runtime notes as independent user entries after a tool result", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;

    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("run tool")), ctx);
    await connector.handlers.message_end(
      makeMessageEnd(
        makeAssistantMessage({ toolCalls: [{ id: "call_a", name: "read_file", arguments: { path: "a.txt" } }] }),
        "pi-asst-a",
      ),
      ctx,
    );
    await connector.handlers.message_end(
      makeMessageEnd(makeToolResult({ id: "call_a", content: "file body" }), "pi-tr-a"),
      ctx,
    );
    await connector.handlers.agent_end(makeAgentEnd([]), ctx);

    const instance = connector.getInstance();
    expect(instance).not.toBeNull();
    if (instance === null) return;

    // Adjacent runtime_note with a different PI entry identity — must not fold.
    const note = await instance.sdk.intakeStream.messageEvents(threadRef, [
      {
        eventKind: "runtime_note",
        idempotencyKey: "pi:sess:entry:task-note:block:0:kind:runtime_note",
        actor: "system",
        harness: "pi",
        payload: { text: "<task-notification>task t-1 completed</task-notification>" },
      },
    ]);
    expect(note.ok).toBe(true);

    const sessionManager = {
      messages: [] as Array<{ role: string; content?: unknown; toolCallId?: string }>,
      appendMessage(message: { role: string; content?: unknown; toolCallId?: string }) {
        this.messages.push(message);
        return `seed_${this.messages.length}`;
      },
      appendCustomEntry() {
        return "seed_map";
      },
    };

    const rehydrated = await rehydratePiSessionFromLhc(instance, threadRef, sessionManager as never);
    expect(rehydrated.ok).toBe(true);
    if (!rehydrated.ok) return;

    expect(sessionManager.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
    const noteMsg = sessionManager.messages[3];
    expect(noteMsg).toMatchObject({
      role: "user",
      content: "[runtime note] <task-notification>task t-1 completed</task-notification>",
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
