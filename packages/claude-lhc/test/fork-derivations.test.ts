import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { forkSession } from "../src/index.ts";
import { resolveSession, threadRef } from "../src/lhcHome.ts";
import { captureReplies, seedLhc, seedThread } from "./support/seedThread.ts";

let dir = "";
const saved = { config: process.env.CLAUDE_CONFIG_DIR, noInference: process.env.CLAUDE_LHC_NO_INFERENCE };
beforeEach(() => {
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
