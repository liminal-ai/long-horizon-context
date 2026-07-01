import type { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import { createDeterministicInferenceCallbacks, intakeStream, type ThreadRef } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingRehydrate,
  createConnector,
  LHC_REHYDRATE_COMMAND,
  LHC_THREAD_ENTRY_TYPE,
  rehydratePiSessionFromLhc,
  setPendingRehydrate,
  takePendingRehydrateModelPrefs,
  takePendingRehydrateSetup,
} from "../../src/index.js";
import { initInstance } from "../../src/lifecycle/instance.js";
import type { ExtensionAPI, ExtensionCommandContext, ModelHandle } from "../../src/pi/types.js";
import { eventBatch } from "../fixtures/synthetic.js";
import { makeTempThread, type TempStore, tempStore } from "../fixtures/thread.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
  clearPendingRehydrate();
});
afterEach(() => {
  store.cleanup();
  clearPendingRehydrate();
});

function threadRef(threadId: string): ThreadRef {
  return { threadId, registryPath: store.registryPath };
}

function captureConfig() {
  return {
    ok: true as const,
    value: { inferenceCallbacks: createDeterministicInferenceCallbacks(), mode: "background" as const },
  };
}

describe("rehydratePiSessionFromLhc", () => {
  it("seeds replacement session from latest thread-view and re-appends durable thread entry", async () => {
    const created = await makeTempThread(store, { title: "rehydrate-target" });
    const ref = threadRef(created.threadId);

    const instance = await initInstance(ref, captureConfig().value);
    if (!instance.ok) throw new Error(instance.error.reason);

    const captured = await intakeStream.messageEvents(ref, eventBatch(["user_prompt", "assistant_text"]));
    if (!captured.ok) throw new Error(captured.error.reason);

    const sessionManager = {
      messages: [] as unknown[],
      customEntries: [] as Array<{ type: string; data: unknown }>,
      appendMessage(message: unknown) {
        this.messages.push(message);
        return "m1";
      },
      appendCustomEntry(type: string, data?: unknown) {
        this.customEntries.push({ type, data });
        return "c1";
      },
    };

    const rehydrated = await rehydratePiSessionFromLhc(
      instance.value,
      ref,
      sessionManager as unknown as import("@earendil-works/pi-coding-agent").SessionManager,
    );
    expect(rehydrated.ok).toBe(true);
    if (!rehydrated.ok) return;
    expect(rehydrated.value.messageCount).toBe(2);
    expect(sessionManager.messages).toHaveLength(2);
    expect(sessionManager.customEntries).toEqual([
      {
        type: "pi-lhc.seed-entry-map",
        data: expect.objectContaining({
          customType: "pi-lhc.seed-entry-map",
          threadId: created.threadId,
          entries: expect.arrayContaining([
            expect.objectContaining({ lhcMessageId: "m1", piEntryId: "m1" }),
            expect.objectContaining({ lhcMessageId: "m2", piEntryId: "m1" }),
          ]),
        }),
      },
      {
        type: LHC_THREAD_ENTRY_TYPE,
        data: { threadId: created.threadId, registryPath: store.registryPath },
      },
    ]);

    await instance.value.dispose();
  });
});

describe("pending rehydrate handoff", () => {
  it("carries setup and model prefs across connector recreation", () => {
    const ref = threadRef("th_0000000000000001");
    const sdkConfig = captureConfig().value;
    setPendingRehydrate({
      threadRef: ref,
      sdkConfig,
      modelPrefs: { model: { provider: "openai", id: "gpt-test" }, thinkingLevel: "high" },
    });

    expect(takePendingRehydrateSetup()).toEqual({ threadRef: ref, sdkConfig });
    expect(takePendingRehydrateModelPrefs()).toEqual({
      model: { provider: "openai", id: "gpt-test" },
      thinkingLevel: "high",
    });
  });
});

describe("/lhc-rehydrate command", () => {
  it("fails clearly when no LHC thread is attached", async () => {
    const notifications: Array<{ message: string; type?: string }> = [];
    let commandHandler: ((args: string[], ctx: ExtensionCommandContext) => Promise<void>) | undefined;

    const connector = createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      buildSdkConfig: () => captureConfig(),
      readLaunchFlags: () => ({ ok: true, value: {} }),
      startupValidationReporter: () => {},
    });

    const pi = {
      on: () => {},
      registerCommand: (_name: string, options: { handler: typeof commandHandler }) => {
        commandHandler = options.handler;
      },
      registerTool: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      appendEntry: () => {},
      getThinkingLevel: () => "medium",
      setThinkingLevel: () => {},
      setModel: async () => true,
    } as ExtensionAPI;

    connector.register(pi);
    expect(commandHandler).toBeDefined();
    if (commandHandler === undefined) return;

    const newSession = vi.fn();
    await commandHandler([], {
      cwd: "/work/rehydrate",
      hasUI: true,
      ui: {
        notify: (message, type) => {
          notifications.push({ message, ...(type === undefined ? {} : { type }) });
        },
      },
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
      sessionManager: { getEntries: () => [] },
      waitForIdle: async () => {},
      newSession,
    });

    expect(newSession).not.toHaveBeenCalled();
    expect(notifications).toEqual([
      {
        message: "pi-lhc: no active LHC thread",
        type: "error",
      },
    ]);
  });

  it("calls ctx.newSession with setup that hydrates from LHC when a thread is attached", async () => {
    const created = await makeTempThread(store);

    const connector = createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      buildSdkConfig: () => captureConfig(),
      readLaunchFlags: () => ({ ok: true, value: { thread: created.threadId } }),
      startupValidationReporter: () => {},
    });

    let commandHandler: ((args: string[], ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = {
      on: () => {},
      registerCommand: (name: string, options: { handler: typeof commandHandler }) => {
        if (name === LHC_REHYDRATE_COMMAND) commandHandler = options.handler;
      },
      registerTool: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      appendEntry: () => {},
      getThinkingLevel: () => "high",
      setThinkingLevel: vi.fn(),
      setModel: vi.fn(async () => true),
    } as ExtensionAPI;

    connector.register(pi);
    await connector.handlers.session_start(
      { type: "session_start", reason: "startup" },
      {
        cwd: "/work/rehydrate",
        hasUI: false,
        modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
        ui: { notify: () => {} },
        sessionManager: { getEntries: () => [] },
      },
    );

    expect(commandHandler).toBeDefined();
    if (commandHandler === undefined) return;

    const setupCalls: Array<{
      messages: unknown[];
      customEntries: unknown[];
    }> = [];
    const model: ModelHandle = { provider: "openai", id: "gpt-test" };
    const replacementCtx = {
      cwd: "/work/rehydrate",
      hasUI: false,
      modelRegistry: { find: () => model, hasConfiguredAuth: () => true, getAvailable: () => [model] },
      ui: { notify: () => {} },
      sessionManager: { getEntries: () => [] },
    };
    const newSession = vi.fn(async (options?: { setup?: (sm: unknown) => Promise<void> }) => {
      await connector.handlers.session_start({ type: "session_start", reason: "new" }, replacementCtx);

      const sm = {
        messages: [] as unknown[],
        customEntries: [] as unknown[],
        appendMessage(message: unknown) {
          this.messages.push(message);
          return "m1";
        },
        appendCustomEntry(type: string, data?: unknown) {
          this.customEntries.push({ type, data });
          return "c1";
        },
      };
      setupCalls.push(sm);
      await options?.setup?.(sm as unknown as PiSessionManager);
      return { cancelled: false };
    });

    await commandHandler([], {
      cwd: "/work/rehydrate",
      hasUI: true,
      model,
      ui: { notify: () => {} },
      modelRegistry: { find: () => model, hasConfiguredAuth: () => true, getAvailable: () => [model] },
      sessionManager: { getEntries: () => [] },
      waitForIdle: async () => {},
      newSession,
    });

    expect(newSession).toHaveBeenCalledTimes(1);
    expect(setupCalls).toHaveLength(1);
    const seeded = setupCalls[0];
    expect(seeded?.messages.length).toBeGreaterThanOrEqual(0);
    expect(seeded?.customEntries).toEqual([
      {
        type: LHC_THREAD_ENTRY_TYPE,
        data: { threadId: created.threadId, registryPath: store.registryPath },
      },
    ]);

    expect(pi.setModel).toHaveBeenCalledWith(model);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(takePendingRehydrateModelPrefs()).toBeNull();
  });
});
