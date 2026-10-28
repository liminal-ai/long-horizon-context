import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { intakeStream, messages, type ThreadRef, threads, turns } from "../src/index.js";
import { type TempStore, tempStore } from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

const READ_SURFACES: ReadonlyArray<{
  name: string;
  call: (ref: ThreadRef) => Promise<{ ok: boolean; error?: { errorClass: string; code: string } }>;
}> = [
  { name: "intakeStream.listEvents", call: (ref) => intakeStream.listEvents(ref) },
  { name: "messages.list", call: (ref) => messages.list(ref) },
  { name: "turns.listTurns", call: (ref) => turns.listTurns(ref) },
];

describe("F-EPIC-001 (SDK): blank file path is refused before any storage touch", () => {
  it("newThread({ filePath: '' }) → caller_error, nothing created, no registry row", async () => {
    const result = await threads.newThread({
      filePath: "",
      registryPath: store.registryPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("invalid_thread_ref");

    expect(existsSync(store.registryPath)).toBe(false);
    const listed = await threads.listThreads({ registryPath: store.registryPath });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toEqual([]);
  });

  it("newThread with a whitespace-only path is refused the same way", async () => {
    const result = await threads.newThread({
      filePath: "   ",
      registryPath: store.registryPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("invalid_thread_ref");
    expect(existsSync(store.registryPath)).toBe(false);
  });

  it("resolveThreadRef({ filePath: '' }) fails closed with caller_error", async () => {
    const result = await threads.resolveThreadRef({ filePath: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("invalid_thread_ref");
  });
});

describe("F-EPIC-002 (SDK): read surfaces validate the thread reference", () => {
  for (const surface of READ_SURFACES) {
    it(`${surface.name}: empty path → caller_error (no storage open)`, async () => {
      const result = await surface.call({ filePath: "" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error?.errorClass).toBe("caller_error");
    });

    it(`${surface.name}: unknown id → thread_not_found`, async () => {
      const result = await surface.call({
        threadId: "th_unknown",
        registryPath: store.registryPath,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error?.errorClass).toBe("caller_error");
      expect(result.error?.code).toBe("thread_not_found");
    });
  }
});
