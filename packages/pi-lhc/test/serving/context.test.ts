import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildContextServePreview,
  CONNECTOR_HOOKS,
  CONTEXT_HOOK,
  CONTEXT_SERVE_PREVIEW_MAX_MESSAGES,
  CONTEXT_SERVE_PREVIEW_MAX_TEXT,
  createConnector,
  EPIC_1_HOOKS,
  mapLlmMessagesToPi,
} from "../../src/index.js";
import type { AgentMessage, ContextEvent, ExtensionAPI, ExtensionContext } from "../../src/pi/types.js";
import { eventsAfterShutdown, kindsOf, startCapture } from "../capture/support.js";
import {
  makeAgentEnd,
  makeAssistantMessage,
  makeMessageEnd,
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

function recordingPi(): {
  pi: ExtensionAPI;
  registered: string[];
  handlers: Partial<Record<string, (...args: unknown[]) => unknown>>;
} {
  const registered: string[] = [];
  const handlers: Partial<Record<string, (...args: unknown[]) => unknown>> = {};
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      registered.push(name);
      handlers[name] = handler;
    },
    registerCommand: () => {},
    registerTool: () => {},
    appendEntry: () => {},
  } as ExtensionAPI;
  return { pi, registered, handlers };
}

function syntheticCtx(): ExtensionContext {
  return {
    cwd: "/work/context",
    hasUI: false,
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
    ui: { notify: () => {} },
    sessionManager: { getEntries: () => [] },
  };
}

function contextEvent(messages: ContextEvent["messages"]): ContextEvent {
  return { type: "context", messages };
}

function userText(message: AgentMessage): string {
  if (message.role !== "user") throw new Error("expected user");
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function assistantText(message: AgentMessage): string {
  if (message.role !== "assistant") throw new Error("expected assistant");
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function hasNativeToolParts(messages: readonly AgentMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some((part) => part.type === "toolCall" || part.type === "thinking"),
  );
}

function appendPiMessage(ctx: ExtensionContext, id: string, message: AgentMessage): void {
  ctx.sessionManager.getEntries().push({ type: "message", id, parentId: null, message });
}

function eventText(event: { payload: unknown }): string {
  return (event.payload as { text?: string }).text ?? "";
}

describe("context hook smoke path", () => {
  it("registers the context hook alongside Epic 1 capture hooks", () => {
    const { pi, registered } = recordingPi();
    createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      parseLaunch: () => ({}),
      startupValidationReporter: () => {},
    }).register(pi);

    expect(new Set(registered)).toEqual(new Set(CONNECTOR_HOOKS));
    expect(registered).toHaveLength(EPIC_1_HOOKS.length + 1);
    expect(registered).toContain(CONTEXT_HOOK);
  });

  it("accepts current PI handler argument order (event before ctx) and returns replacement messages", async () => {
    const started = await startCapture(store);
    const { connector: active, ctx } = started;
    await active.handlers.message_end(makeMessageEnd(makeUserMessage("capture me")), ctx);
    await active.handlers.agent_end(makeAgentEnd([]), ctx);

    const original = [makeUserMessage("pi original"), makeAssistantMessage({ text: "pi tail" })];
    const result = await active.handlers.context(contextEvent(original), syntheticCtx());

    expect(result).toBeDefined();
    expect(result?.messages).toBeDefined();
    expect(result?.messages?.length).toBeGreaterThan(0);
    expect(result?.messages).not.toEqual(original);

    const diagnostic = active.getLastContextServe();
    expect(diagnostic?.served).toBe(true);
    expect(diagnostic?.reason).toBe("thread_view");
    expect(diagnostic?.threadId).toMatch(/^th_/);
    expect(diagnostic?.messageCount).toBeGreaterThan(0);
    expect(diagnostic?.preview.length).toBeGreaterThan(0);
    expect(diagnostic?.preview[0]?.textPreview).toContain("capture me");
  });

  it("degrades without throwing when no active session (returns void, records fallback)", async () => {
    const connector = createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      parseLaunch: () => ({}),
      startupValidationReporter: () => {},
    });
    const original = [makeUserMessage("unchanged")];

    const result = await connector.handlers.context(contextEvent(original), syntheticCtx());

    expect(result).toBeUndefined();
    expect(connector.getLastContextServe()).toEqual({
      served: false,
      reason: "no_active_session",
      messageCount: 1,
      preview: [],
    });
  });

  it("malformed context input does not throw and records fallback diagnostic", async () => {
    const connector = createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      parseLaunch: () => ({}),
      startupValidationReporter: () => {},
    });

    const result = await connector.handlers.context({ type: "context" } as unknown as ContextEvent, syntheticCtx());

    expect(result).toBeUndefined();
    expect(connector.getLastContextServe()).toEqual({
      served: false,
      reason: "malformed_context_event",
      messageCount: 0,
      preview: [],
    });
  });

  it("serves a user prompt queued by message_end when context runs before agent_end", async () => {
    const started = await startCapture(store);
    const { connector, ctx } = started;
    const prompt = "fresh prompt before context";
    const userMessage = makeUserMessage(prompt);
    const entryId = "pi-fresh-user";

    await connector.handlers.message_end(makeMessageEnd(userMessage, entryId, 0), ctx);
    appendPiMessage(ctx, entryId, userMessage);

    const result = await connector.handlers.context(contextEvent([makeUserMessage("pi original")]), ctx);

    expect(result?.messages?.some((message) => message.role === "user" && userText(message) === prompt)).toBe(true);

    const diagnostic = connector.getLastContextServe();
    expect(diagnostic).toMatchObject({ served: true, reason: "thread_view" });
    expect(diagnostic?.preview.some((entry) => entry.textPreview === prompt)).toBe(true);

    const events = await eventsAfterShutdown(started);
    expect(kindsOf(events)).toContain("user_prompt");
    expect(events.some((event) => event.eventKind === "user_prompt" && eventText(event) === prompt)).toBe(true);
  });

  it("serves a tool result queued by message_end when context runs before agent_end", async () => {
    const started = await startCapture(store);
    const { connector, ctx } = started;
    const toolBody = "fresh tool body before context";

    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("read notes.txt")), ctx);
    appendPiMessage(ctx, "pi-user", makeUserMessage("read notes.txt"));
    await connector.handlers.message_end(
      makeMessageEnd(
        makeAssistantMessage({
          toolCalls: [{ id: "call_ctx", name: "read_file", arguments: { path: "notes.txt" } }],
        }),
      ),
      ctx,
    );
    appendPiMessage(
      ctx,
      "pi-assistant",
      makeAssistantMessage({
        toolCalls: [{ id: "call_ctx", name: "read_file", arguments: { path: "notes.txt" } }],
      }),
    );
    const toolResult = makeToolResult({ id: "call_ctx", content: toolBody });
    await connector.handlers.message_end(makeMessageEnd(toolResult), ctx);
    appendPiMessage(ctx, "pi-tool-result", toolResult);

    const result = await connector.handlers.context(contextEvent([makeUserMessage("pi original")]), ctx);

    expect(result?.messages?.some((message) => message.role === "user" && userText(message).includes(toolBody))).toBe(
      true,
    );

    const diagnostic = connector.getLastContextServe();
    expect(diagnostic).toMatchObject({ served: true, reason: "thread_view" });
    expect(diagnostic?.preview.some((entry) => entry.textPreview.includes(toolBody))).toBe(true);

    const events = await eventsAfterShutdown(started);
    expect(kindsOf(events)).toContain("tool_result");
    expect(
      events.some(
        (event) =>
          event.eventKind === "tool_result" && (event.payload as { content?: string }).content?.includes(toolBody),
      ),
    ).toBe(true);
  });

  it("keeps capture working while context serving is registered", async () => {
    const started = await startCapture(store);
    const { connector, ctx } = started;

    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("still captured")), ctx);
    await connector.handlers.agent_end(makeAgentEnd([]), ctx);

    const contextResult = await connector.handlers.context(contextEvent([makeUserMessage("pi side")]), ctx);
    expect(contextResult?.messages?.length).toBeGreaterThan(0);

    const events = await eventsAfterShutdown(started);
    expect(events.map((event) => event.eventKind)).toEqual(["user_prompt", "turn_end"]);
  });
});

describe("text-only served tail correctness", () => {
  it("serves a captured user/assistant tail in LHC order as text-only PI messages", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;

    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("first question")), ctx);
    await connector.handlers.message_end(makeMessageEnd(makeAssistantMessage({ text: "first answer" })), ctx);
    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("second question")), ctx);
    await connector.handlers.message_end(makeMessageEnd(makeAssistantMessage({ text: "second answer" })), ctx);
    await connector.handlers.agent_end(makeAgentEnd([]), ctx);

    const instance = connector.getInstance();
    expect(instance).not.toBeNull();
    const lhcContext = await instance!.sdk.threadView.getLlmRequestContext(threadRef);
    expect(lhcContext.ok).toBe(true);
    if (!lhcContext.ok) return;

    const result = await connector.handlers.context(contextEvent([makeUserMessage("pi original")]), ctx);
    expect(result?.messages).toEqual(mapLlmMessagesToPi(lhcContext.value.messages));
    expect(result?.messages?.map((message) => message.role)).toEqual(lhcContext.value.messages.map((m) => m.role));
    expect(
      result?.messages?.map((message) => (message.role === "user" ? userText(message) : assistantText(message))),
    ).toEqual(lhcContext.value.messages.map((message) => message.content.map((part) => part.text).join("")));
    expect(hasNativeToolParts(result?.messages ?? [])).toBe(false);

    const diagnostic = connector.getLastContextServe();
    expect(diagnostic).toMatchObject({
      served: true,
      reason: "thread_view",
      messageCount: lhcContext.value.messages.length,
    });
    expect(diagnostic?.preview.map((entry) => entry.textPreview)).toEqual(
      lhcContext.value.messages.map((message) => message.content.map((part) => part.text).join("")),
    );
  });

  it("serves tool-heavy captured turns as LHC-rendered text in order without native tool parts", async () => {
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
    const lhcContext = await instance!.sdk.threadView.getLlmRequestContext(threadRef);
    expect(lhcContext.ok).toBe(true);
    if (!lhcContext.ok) return;

    const rendered = lhcContext.value.messages.map((message) => message.content.map((part) => part.text).join(""));
    expect(rendered.some((text) => text.includes("[tool call · read_file]"))).toBe(true);
    expect(rendered.some((text) => text.includes("[tool result · read_file]"))).toBe(true);
    expect(rendered.some((text) => text.includes("file body"))).toBe(true);

    const result = await connector.handlers.context(contextEvent([makeUserMessage("pi side")]), ctx);
    expect(result?.messages).toEqual(mapLlmMessagesToPi(lhcContext.value.messages));
    expect(hasNativeToolParts(result?.messages ?? [])).toBe(false);
    expect(
      result?.messages?.map((message) => (message.role === "user" ? userText(message) : assistantText(message))),
    ).toEqual(rendered);

    const diagnostic = connector.getLastContextServe();
    expect(diagnostic?.preview.some((entry) => entry.textPreview.includes("[tool call · read_file]"))).toBe(true);
    expect(diagnostic?.preview.some((entry) => entry.textPreview.includes("[tool result · read_file]"))).toBe(true);
  });

  it("buildContextServePreview is bounded, deterministic, and plain-data serializable", () => {
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

  it("records an empty preview on serve failure paths", async () => {
    const connector = createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      parseLaunch: () => ({}),
      startupValidationReporter: () => {},
    });

    await connector.handlers.context(contextEvent([makeUserMessage("unchanged")]), syntheticCtx());
    expect(connector.getLastContextServe()?.preview).toEqual([]);
  });
});
