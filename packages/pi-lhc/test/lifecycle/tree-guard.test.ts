import { createDeterministicInferenceCallbacks, type ThreadRef } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearLauncherOwnedStartup, createConnector, setLauncherOwnedStartup } from "../../src/index.js";
import type { ExtensionContext, SessionBeforeTreeEvent } from "../../src/pi/types.js";
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

function syntheticCtx(cwd: string, notices: string[]): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
    ui: {
      notify: (message: string) => {
        notices.push(message);
      },
    },
    sessionManager: { getEntries: () => [] },
  };
}

function treeEvent(): SessionBeforeTreeEvent {
  return { type: "session_before_tree", preparation: {}, signal: new AbortController().signal };
}

describe("session_before_tree guard", () => {
  it("passes through when no LHC thread is attached", async () => {
    const connector = createConnector({ registryPath: store.registryPath });
    const notices: string[] = [];
    const result = await connector.treeHandler(treeEvent(), syntheticCtx("/work/tree", notices));
    expect(result).toEqual({});
    expect(notices).toHaveLength(0);
  });

  it("cancels /tree navigation with a loud notice while a thread is attached — the record is linear", async () => {
    const created = await makeTempThread(store);
    const ref: ThreadRef = { threadId: created.threadId, registryPath: store.registryPath };
    setLauncherOwnedStartup({ threadRef: ref, launchFlags: { thread: created.threadId } });
    const connector = createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      buildSdkConfig: () => ({
        ok: true,
        value: { inferenceCallbacks: createDeterministicInferenceCallbacks(), mode: "background" },
      }),
    });
    const notices: string[] = [];
    const ctx = syntheticCtx("/work/tree", notices);
    await connector.handlers.session_start(makeSessionStart("startup"), ctx);
    expect(connector.getState()).not.toBeNull();

    const result = await connector.treeHandler(treeEvent(), ctx);
    expect(result).toEqual({ cancel: true });
    expect(notices.some((n) => n.includes("/tree navigation is blocked"))).toBe(true);
  });
});
