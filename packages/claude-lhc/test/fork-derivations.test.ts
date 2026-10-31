import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threads } from "lhc";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { forkSession } from "../src/index.ts";
import { registryPath, resolveSession, threadRef } from "../src/lhcHome.ts";
import { captureReplies, captureTurn, seedLhc, seedThread } from "./support/seedThread.ts";

let failDrain = false;
vi.mock("../src/lhcHome.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lhcHome.ts")>();
  return {
    ...real,
    createLhc: (options: Parameters<typeof real.createLhc>[0]) => {
      const lhc = real.createLhc(options);
      if (!failDrain) return lhc;
      const drain = async () => ({
        ok: false as const,
        error: {
          errorClass: "system_error" as const,
          code: "storage_failure" as const,
          reason: "forced drain failure",
        },
      });
      return { ...lhc, work: { drain } };
    },
  };
});

let dir = "";
const saved = { config: process.env.CLAUDE_CONFIG_DIR, noInference: process.env.CLAUDE_LHC_NO_INFERENCE };
beforeEach(() => {
  failDrain = false;
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-fork-derivations-"));
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-home");
  process.env.CLAUDE_LHC_NO_INFERENCE = "1";
});
afterEach(() => {
  for (const [key, value] of [
    ["CLAUDE_CONFIG_DIR", saved.config],
    ["CLAUDE_LHC_NO_INFERENCE", saved.noInference],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function pending(home: string, threadId: string): Promise<number> {
  const status = await seedLhc().threadView.status(threadRef(threadId, home));
  if (!status.ok) throw new Error(status.error.reason);
  return status.value.derivation.pending;
}

test("a fork settles the derivation work it carries and its rollback queues, and leaves the source's queue alone", async () => {
  const home = join(dir, "lhc");
  const { gen1, threadId } = await seedThread(home, dir);
  const [kept] = await captureReplies(home, threadId, "SPLIT-PROMPT", ["KEEP-PART", "LATER-PART"]);
  const queued = await pending(home, threadId);
  expect(queued).toBeGreaterThan(0);

  const forked = await forkSession(gen1, { lhc: { home }, dir, upToMessageId: kept! });

  expect(await pending(home, (await resolveSession(forked.sessionId, home))!)).toBe(0);
  expect(await pending(home, threadId)).toBe(queued);
});

test("a fork that fails after the copy leaves no copied thread, registry row or session file", async () => {
  const home = join(dir, "lhc");
  const { gen1, threadId } = await seedThread(home, dir);
  await captureTurn(home, threadId, "KEEP-PROMPT", "KEEP-ANSWER");
  failDrain = true;

  await expect(forkSession(gen1, { lhc: { home }, dir })).rejects.toThrow("forced drain failure");

  const listed = await threads.listThreads({ registryPath: registryPath(home) });
  expect(listed.ok && listed.value.map((thread) => thread.threadId)).toEqual([threadId]);
  expect(readdirSync(join(home, "threads")).filter((name) => name.endsWith(".sqlite"))).toHaveLength(1);
  const projects = join(process.env.CLAUDE_CONFIG_DIR!, "projects");
  expect(existsSync(projects) ? readdirSync(projects, { recursive: true }).map(String) : []).toEqual([]);
});
