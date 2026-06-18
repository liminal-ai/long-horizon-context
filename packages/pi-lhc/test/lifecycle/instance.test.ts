// Story 1 — instance lifecycle. TC-1.1 drives the PRODUCTION connector path:
// createConnector with only environment overrides (temp registry/thread-file,
// scripted launch) and the REAL default SDK config + selector — proving
// session_start resolves, creates a cwd/title-registered thread, and initializes
// one background instance with no placeholder injection. TC-1.4 proves shutdown
// flush + reattach at the instance level (Story 1 does not capture through hooks
// yet, so events are written directly through the instance). Real temp
// registry/thread throughout (the store is never mocked).
import { existsSync } from "node:fs";
import { createDeterministicProvider, inspect, type SdkConfig, type ThreadRef, threads } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnector } from "../../src/index.js";
import { disposeInstance, initInstance } from "../../src/lifecycle/instance.js";
import { defaultThreadTitle, resolveThread } from "../../src/lifecycle/thread-resolution.js";
import type { ExtensionContext } from "../../src/pi/types.js";
import { eventBatch, makeSessionStart } from "../fixtures/synthetic.js";
import { type TempStore, tempStore } from "../fixtures/thread.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

function backgroundConfig(): SdkConfig {
  return { provider: createDeterministicProvider(), mode: "background" };
}

function idOf(ref: ThreadRef): string {
  if (!("threadId" in ref)) throw new Error("expected a { threadId } ref");
  return ref.threadId;
}

// A per-hook ctx carrying methods (not plain data), like PI hands each hook.
function syntheticCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
    ui: { notify: () => {} },
    sessionManager: { getEntries: () => [] },
  };
}

describe("Story 1: instance lifecycle", () => {
  it("TC-1.1: a no-flag session_start (production defaults) creates one cwd/title thread and one background instance", async () => {
    const cwd = "/work/tc-1-1";
    // Only environment overrides are injected; buildSdkConfig and selectThread
    // use the real production defaults, so this exercises the activate path's
    // lifecycle, not a placeholder branch.
    const connector = createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      parseLaunch: () => ({}),
    });

    await connector.handlers.session_start(syntheticCtx(cwd), makeSessionStart("new"));

    // A real instance was constructed in background scheduler mode (no
    // fail-closed early return).
    const instance = connector.getInstance();
    expect(instance).not.toBeNull();
    expect(instance?.sdk.config.mode).toBe("background");

    const state = connector.getState();
    expect(state).not.toBeNull();
    if (state === null) return;

    // Exactly one thread, registered with BOTH cwd and title metadata (A-8 / TC-1.1).
    const all = await threads.listThreads({ registryPath: store.registryPath });
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.value).toHaveLength(1);

    const row = await threads.resolve({
      threadId: idOf(state.threadRef),
      registryPath: store.registryPath,
    });
    expect(row.ok).toBe(true);
    if (!row.ok) return;
    expect(row.value.cwd).toBe(cwd);
    expect(row.value.title).toBe(defaultThreadTitle(cwd)); // "tc-1-1"
    expect(existsSync(row.value.filePath)).toBe(true);

    // Observe-only: the connector did not capture or drive the derivation queue
    // on start (capture is Story 2) — the instance only auto-drains in the
    // background, which has nothing to do here.
    const overview = await inspect.overview(state.threadRef);
    expect(overview.ok).toBe(true);
    if (overview.ok) expect(overview.value.events.count).toBe(0);

    // Shutdown disposes the live instance.
    await connector.handlers.session_shutdown(syntheticCtx(cwd), { reason: "shutdown" });
    expect(connector.getInstance()).toBeNull();
  });

  it("TC-1.4: shutdown disposes with flush; re-resolving the thread reads every pre-shutdown event", async () => {
    const resolved = await resolveThread(
      {},
      { cwd: "/work/tc-1-4", registryPath: store.registryPath, newThreadFilePath: () => store.threadPath() },
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const threadId = idOf(resolved.value);

    const built = await initInstance(resolved.value, backgroundConfig());
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // Capture N raw intake events through the instance (the converter is Story 2;
    // the lifecycle proof needs only that recorded events survive shutdown).
    const batch = eventBatch(["user_prompt", "assistant_text", "turn_end"]);
    const captured = await built.value.sdk.intakeStream.messageEvents(built.value.threadRef, batch);
    expect(captured.ok).toBe(true);

    // Dispose with flush.
    const disposed = await disposeInstance(built.value);
    expect(disposed.ok).toBe(true);

    // Reattach: resolve the same thread by id (no retained instance) and read
    // back — every pre-shutdown event is present, no trailing loss.
    const reattached = await resolveThread(
      { session: threadId },
      { cwd: "/work/tc-1-4", registryPath: store.registryPath, newThreadFilePath: () => store.threadPath() },
    );
    expect(reattached.ok).toBe(true);
    if (!reattached.ok) return;

    const overview = await inspect.overview(reattached.value);
    expect(overview.ok).toBe(true);
    if (overview.ok) expect(overview.value.events.count).toBe(batch.length);
  });
});
