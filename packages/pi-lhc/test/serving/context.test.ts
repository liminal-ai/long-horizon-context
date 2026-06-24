import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONNECTOR_HOOKS, CONTEXT_HOOK, createConnector, EPIC_1_HOOKS } from "../../src/index.js";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "../../src/pi/types.js";
import { eventsAfterShutdown, startCapture } from "../capture/support.js";
import { makeAgentEnd, makeAssistantMessage, makeMessageEnd, makeUserMessage } from "../fixtures/synthetic.js";
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
    });
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
