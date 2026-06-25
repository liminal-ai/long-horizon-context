import { createDeterministicInferenceCallbacks, intakeStream, type ThreadRef } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LHC_THREAD_ENTRY_TYPE, prepareLhcLauncherStartup } from "../../src/index.js";
import { eventBatch } from "../fixtures/synthetic.js";
import { makeTempThread, type TempStore, tempStore } from "../fixtures/thread.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

function threadRef(threadId: string): ThreadRef {
  return { threadId, registryPath: store.registryPath };
}

describe("prepareLhcLauncherStartup", () => {
  it("seeds in-memory PI messages and durable thread entry from LHC thread-view", async () => {
    const created = await makeTempThread(store, { title: "launcher-startup" });
    const ref = threadRef(created.threadId);

    const { initInstance } = await import("../../src/lifecycle/instance.js");
    const instance = await initInstance(ref, {
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
      mode: "background",
    });
    if (!instance.ok) throw new Error(instance.error.reason);

    const captured = await intakeStream.messageEvents(ref, eventBatch(["user_prompt"]));
    if (!captured.ok) throw new Error(captured.error.reason);
    await instance.value.dispose();

    const startup = await prepareLhcLauncherStartup({
      cwd: "/work/launcher",
      launchFlags: { thread: created.threadId },
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      sdkConfig: {
        inferenceCallbacks: createDeterministicInferenceCallbacks(),
        mode: "background",
      },
    });

    expect(startup.ok).toBe(true);
    if (!startup.ok) return;
    expect(startup.value.seededMessageCount).toBe(1);
    expect(startup.value.sessionManager.getSessionFile()).toBeUndefined();

    const context = startup.value.sessionManager.buildSessionContext();
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]?.role).toBe("user");

    const entries = startup.value.sessionManager.getEntries();
    const threadEntry = entries.find((entry) => entry.type === "custom" && entry.customType === LHC_THREAD_ENTRY_TYPE);
    expect(threadEntry).toBeDefined();
  });
});
