import { threads } from "lhc";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempThread, type TempStore, tempStore } from "./thread.js";

// The temp-thread factory drives REAL lhc threads against a real temp SQLite
// file — the persistence/reattach substrate every lifecycle and verification
// test stands on (tech design §Testing Strategy). Proven here by creating a
// thread and reopening it after the fact, both from the registry and the file.
describe("temp-thread factory", () => {
  let store: TempStore | undefined;
  afterEach(() => {
    store?.cleanup();
    store = undefined;
  });

  it("creates a real SQLite thread and reopens it from the registry and the file", async () => {
    store = tempStore();
    const { threadId, filePath } = await makeTempThread(store, { title: "foundation smoke" });
    expect(threadId).toBeTruthy();

    // reopen via the registry (resolve by id)
    const resolved = await threads.resolve({ threadId, registryPath: store.registryPath });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.threadId).toBe(threadId);
      expect(resolved.value.title).toBe("foundation smoke");
    }

    // reopen via the thread file's own identity header (info by file path)
    const info = await threads.info({ filePath });
    expect(info.ok).toBe(true);
    if (info.ok) expect(info.value.threadId).toBe(threadId);
  });

  it("isolates each created thread under its own temp store", async () => {
    store = tempStore();
    const a = await makeTempThread(store);
    const b = await makeTempThread(store);
    expect(a.threadId).not.toBe(b.threadId);
    expect(a.filePath).not.toBe(b.filePath);
  });
});
