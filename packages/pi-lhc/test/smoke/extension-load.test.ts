import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activate, createConnector, disposeInstance, EPIC_1_HOOKS, initInstance } from "../../src/index.js";
import { createSessionState } from "../../src/lifecycle/state.js";
import type { ExtensionAPI, ExtensionContext, PiHookName } from "../../src/pi/types.js";
import { makeAgentEnd, makeMessageEnd, makeSessionStart, makeUserMessage } from "../fixtures/synthetic.js";
import { type TempStore, tempStore } from "../fixtures/thread.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

// A fake ExtensionAPI that records what the extension registers.
function recordingPi(): {
  pi: ExtensionAPI;
  registered: PiHookName[];
  handlers: Partial<Record<PiHookName, (...args: unknown[]) => unknown>>;
  commands: string[];
  tools: string[];
} {
  const registered: PiHookName[] = [];
  const handlers: Partial<Record<PiHookName, (...args: unknown[]) => unknown>> = {};
  const commands: string[] = [];
  const tools: string[] = [];
  const pi: ExtensionAPI = {
    on(name, handler) {
      registered.push(name);
      handlers[name] = handler as (...args: unknown[]) => unknown;
    },
    registerCommand(name) {
      commands.push(name);
    },
    registerTool(tool) {
      tools.push(tool.name);
    },
    appendEntry() {},
  };
  return { pi, registered, handlers, commands, tools };
}

// A synthetic per-hook ctx carrying METHODS (not plain data) and a unique
// marker — so a retained ctx would break the structuredClone plain-data guard.
function syntheticCtx(marker: string): ExtensionContext {
  return {
    cwd: `/tmp/${marker}`,
    hasUI: false,
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => false,
      getAvailable: () => [],
    },
    ui: { notify: () => {} },
    sessionManager: { getEntries: () => [] },
  };
}

describe("extension load + hook rail", () => {
  it("registers exactly the Epic 1 observe-only hook rail and not the context hook", () => {
    const { pi, registered, commands, tools } = recordingPi();
    activate(pi);

    expect(new Set(registered)).toEqual(new Set(EPIC_1_HOOKS));
    expect(registered).toHaveLength(9);
    expect(registered).not.toContain("context"); // context serving is Epic 2
    // observe-only: no operator commands / agent tools registered yet (Epic 3)
    expect(commands).toEqual([]);
    expect(tools).toEqual([]);
  });

  it("registers current PI-shape on(event, handler) handlers and accepts event before ctx", async () => {
    const { pi, handlers } = recordingPi();
    const connector = createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      parseLaunch: () => ({}),
      startupValidationReporter: () => {},
    });
    connector.register(pi);

    const ctx = syntheticCtx("current-pi-order");
    await handlers.session_start?.(makeSessionStart("startup"), ctx);
    await handlers.message_end?.(makeMessageEnd(makeUserMessage("hi")), ctx);

    expect(connector.getState()).not.toBeNull();
  });

  it("routes every hook to a guarded handler that never throws into PI and retains only plain data", async () => {
    // Production defaults, but the registry/thread-file are redirected to a temp
    // store so the smoke test never writes the real ~/.lhc.
    const connector = createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      parseLaunch: () => ({}),
      startupValidationReporter: () => {},
    });
    // fire several hooks with DISTINCT ctx objects carrying methods
    await connector.handlers.session_start(makeSessionStart("startup"), syntheticCtx("ctx-1"));
    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("hi")), syntheticCtx("ctx-2"));
    await connector.handlers.agent_end(makeAgentEnd([]), syntheticCtx("ctx-3"));

    // (the awaits above completing is the "never throws into PI" assertion)
    // retained state is plain data: structuredClone throws on a stored PI ctx (it
    // has methods); the live LhcInstance is held but excluded from the snapshot.
    expect(() => structuredClone(connector.snapshot())).not.toThrow();
  });

  it("keeps SessionState plain-data-only — it survives structuredClone with every field populated", () => {
    const state = createSessionState({ filePath: "/tmp/thread.sqlite" });
    state.flags.startupValidationReported = true;
    state.flags.toldUserAboutGap = true; // open index signature, still plain data
    state.health.lastCaptureFailure = { code: "malformed_event", message: "bad shape", recordedGap: true };
    state.health.startupValidation = { unreachable: [] };

    const clone = structuredClone(state);
    expect(clone).toEqual(state);
    expect(clone).not.toBe(state);
  });

  it("init/dispose seam is real and fails closed: init on a missing thread returns a typed error, dispose(null) is a no-op", async () => {
    // No thread file at this path: init validates the thread before any SDK
    // construction, so it fails closed with a typed result — never a throw into
    // a PI hook. (Story 1 implements the seam; the full lifecycle behavior is
    // covered in test/lifecycle/*.)
    const initResult = await initInstance(
      { filePath: "/tmp/pi-lhc-nonexistent-thread.sqlite" },
      { mode: "background" },
    );
    expect(initResult.ok).toBe(false);
    if (!initResult.ok) {
      expect(initResult.error.code).toBe("thread_not_found");
      expect(initResult.error.errorClass).toBe("caller_error");
    }

    // Disposing with no live instance is a successful no-op.
    const disposeResult = await disposeInstance(null);
    expect(disposeResult.ok).toBe(true);
  });
});
