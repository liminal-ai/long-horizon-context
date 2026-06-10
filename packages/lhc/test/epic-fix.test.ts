// Epic Fix Batch 1: blank-path rejection (F-EPIC-001), read-surface reference
// validation (F-EPIC-002), and strict CLI flag parsing (NB-2). New Green-phase
// suite — the Red-committed files stay byte-identical.
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  intakeStream,
  messages,
  runCli,
  threads,
  turns,
  type ThreadRef,
} from "../src/index.js";
import { tempStore, type TempStore } from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

// Every read-back surface, exercised through one signature so the empty-path
// and unknown-id legs prove the same fail-closed contract on each.
const READ_SURFACES: ReadonlyArray<{
  name: string;
  call: (ref: ThreadRef) => Promise<{ ok: boolean; error?: { errorClass: string; code: string } }>;
}> = [
  { name: "intakeStream.listEvents", call: (ref) => intakeStream.listEvents(ref) },
  { name: "messages.listMessages", call: (ref) => messages.listMessages(ref) },
  { name: "messages.listQueuedWork", call: (ref) => messages.listQueuedWork(ref) },
  { name: "turns.listTurns", call: (ref) => turns.listTurns(ref) },
  { name: "turns.listQueuedWork", call: (ref) => turns.listQueuedWork(ref) },
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

    // No durable file, and no registry row — the registry was never opened.
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

describe("F-EPIC-001 / NB-2 (CLI in-process): usage errors are named, not swallowed", () => {
  interface CliErr {
    ok: false;
    error: { errorClass: string; code: string; reason: string };
  }
  function parseErr(stdout: string): CliErr {
    return JSON.parse(stdout) as CliErr;
  }

  it("new-thread with an empty --file-path exits 1, JSON error, clean registry", async () => {
    const result = await runCli([
      "threads",
      "new-thread",
      "--file-path",
      "",
      "--registry",
      store.registryPath,
    ]);
    expect(result.exitCode).toBe(1);
    const parsed = parseErr(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.errorClass).toBe("caller_error");
    expect(parsed.error.code).toBe("invalid_thread_ref");
    expect(existsSync(store.registryPath)).toBe(false);
  });

  it("an unknown/misspelled flag is rejected by name, exit 1, nothing created", async () => {
    const result = await runCli([
      "threads",
      "new-thread",
      "--file-path",
      store.threadPath(),
      "--titel",
      "typo",
      "--registry",
      store.registryPath,
    ]);
    expect(result.exitCode).toBe(1);
    const parsed = parseErr(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("unknown_flag");
    expect(parsed.error.reason).toContain("--titel");
    // Strict parse fails before the SDK call, so no thread was created.
    expect(existsSync(store.registryPath)).toBe(false);
  });

  for (const command of [
    "messages list",
    "messages list-queued-work",
    "turns list",
    "turns list-queued-work",
  ]) {
    it(`${command} without a thread reference is a missing-flag usage error`, async () => {
      const result = await runCli(command.split(" "));
      expect(result.exitCode).toBe(1);
      const parsed = parseErr(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("missing_flag");
      expect(parsed.error.reason).toContain("--thread-id or --file-path");
    });
  }
});
