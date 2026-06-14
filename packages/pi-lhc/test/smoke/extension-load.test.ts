import { describe, expect, it } from "vitest";
import { activate, createConnector, disposeInstance, EPIC_1_HOOKS, initInstance } from "../../src/index.js";
import { createSessionState } from "../../src/lifecycle/state.js";
import type { ExtensionAPI, ExtensionContext, PiHookName } from "../../src/pi/types.js";
import { makeAgentEnd, makeMessageEnd, makeSessionStart, makeUserMessage } from "../fixtures/synthetic.js";

// A fake ExtensionAPI that records what the extension registers.
function recordingPi(): {
  pi: ExtensionAPI;
  registered: PiHookName[];
  commands: string[];
  tools: string[];
} {
  const registered: PiHookName[] = [];
  const commands: string[] = [];
  const tools: string[] = [];
  const pi: ExtensionAPI = {
    registerHook(name) {
      registered.push(name);
    },
    registerCommand(name) {
      commands.push(name);
    },
    registerTool(tool) {
      tools.push(tool.name);
    },
    appendEntry() {},
  };
  return { pi, registered, commands, tools };
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

  it("routes every hook to a guarded handler that never throws into PI and retains only plain data", async () => {
    const connector = createConnector();
    // fire several hooks with DISTINCT ctx objects carrying methods
    await connector.handlers.session_start(syntheticCtx("ctx-1"), makeSessionStart("startup"));
    await connector.handlers.message_end(syntheticCtx("ctx-2"), makeMessageEnd(makeUserMessage("hi")));
    await connector.handlers.agent_end(syntheticCtx("ctx-3"), makeAgentEnd([]));

    // (the awaits above completing is the "never throws into PI" assertion)
    // retained state is plain data: structuredClone throws on a stored PI ctx (it has methods)
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

  it("exposes a stubbed init/dispose seam that returns a typed fail-closed result", async () => {
    const initResult = await initInstance({ filePath: "/tmp/thread.sqlite" }, { mode: "background" });
    expect(initResult.ok).toBe(false);
    if (!initResult.ok) {
      expect(initResult.error).toEqual({
        errorClass: "system_error",
        code: "not_implemented",
        reason: "lifecycle.initInstance is not implemented yet (Epic 1 foundation stub)",
      });
    }

    const disposeResult = await disposeInstance(null);
    expect(disposeResult.ok).toBe(false);
    if (!disposeResult.ok) {
      expect(disposeResult.error).toEqual({
        errorClass: "system_error",
        code: "not_implemented",
        reason: "lifecycle.disposeInstance is not implemented yet (Epic 1 foundation stub)",
      });
    }
  });
});
