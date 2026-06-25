import { createDeterministicInferenceCallbacks, type ThreadRef } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearLauncherOwnedStartup, createConnector, setLauncherOwnedStartup } from "../../src/index.js";
import type { ExtensionContext } from "../../src/pi/types.js";
import { makeSessionStart } from "../fixtures/synthetic.js";
import { makeTempThread, type TempStore, tempStore } from "../fixtures/thread.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
  clearLauncherOwnedStartup();
});
afterEach(() => {
  store.cleanup();
  clearLauncherOwnedStartup();
});

function threadRef(threadId: string): ThreadRef {
  return { threadId, registryPath: store.registryPath };
}

function syntheticCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
    ui: { notify: () => {} },
    sessionManager: { getEntries: () => [] },
  };
}

describe("launcher-owned connector handoff", () => {
  it("session_start uses launcher-resolved thread without re-resolving launch flags", async () => {
    const created = await makeTempThread(store);
    const ref = threadRef(created.threadId);
    setLauncherOwnedStartup({ threadRef: ref, launchFlags: { thread: created.threadId } });

    const connector = createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      buildSdkConfig: () => ({
        ok: true,
        value: { inferenceCallbacks: createDeterministicInferenceCallbacks(), mode: "background" },
      }),
      readLaunchFlags: () => ({
        ok: false,
        error: {
          errorClass: "caller_error",
          code: "conflicting_lhc_launch_flags",
          reason: "readLaunchFlags should not run in launcher-owned mode",
        },
      }),
    });

    await connector.handlers.session_start(makeSessionStart("startup"), syntheticCtx("/work/handoff"));

    const state = connector.getState();
    expect(state).not.toBeNull();
    if (state === null) return;
    expect("threadId" in state.threadRef && state.threadRef.threadId).toBe(created.threadId);
    expect(connector.getInstance()).not.toBeNull();
  });
});
