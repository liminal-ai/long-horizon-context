import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { threads } from "lhc";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { capturePrompt, captureTurn, SEED_POLICY, seedLhc, seedThread } from "./support/seedThread.ts";

const opened: Options[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    query: ({ options }: { options: Options }) => {
      opened.push(options);
      const never = new Promise<IteratorResult<never>>(() => {});
      return {
        [Symbol.asyncIterator]() {
          return { next: () => never };
        },
        getContextUsage: async () => ({ rawMaxTokens: 1_000_000, totalTokens: 0 }),
        interrupt: async () => {},
        close: () => {},
      };
    },
  };
});

const { forkSession, getSessionMessages } = await import("../src/index.ts");
const { ClaudeLhcSession } = await import("../src/session.ts");
const { resolveSession, threadRef } = await import("../src/lhcHome.ts");
const { nativeSessionPath } = await import("../src/nativeSessionFile.ts");

let dir = "";
let home = "";
let cwd = "";
const saved = { config: process.env.CLAUDE_CONFIG_DIR, noInference: process.env.CLAUDE_LHC_NO_INFERENCE };

beforeEach(() => {
  opened.length = 0;
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-fork-"));
  home = join(dir, "lhc");
  cwd = mkdtempSync(join(dir, "cwd-"));
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

const store = () => ({ lhc: { home } });
const threadFiles = () => readdirSync(join(home, "threads")).filter((name) => name.endsWith(".sqlite"));
const projected = (sessionId: string) => readFileSync(nativeSessionPath({ sessionId, cwd, env: process.env }), "utf8");

async function served(threadId: string): Promise<string> {
  const view = await seedLhc().threadView.getSessionThreadView(threadRef(threadId, home));
  if (!view.ok) throw new Error(view.error.reason);
  return JSON.stringify(view.value.entries);
}

async function resume(sessionId: string): Promise<{ threadId: string; projected: string }> {
  const session = new ClaudeLhcSession({
    emit(): void {},
    request: async () => ({}),
    end(): void {},
    fail(): void {},
    log(): void {},
  });
  await session.start({ resume: sessionId, cwd, model: "claude-sonnet-5", env: { ...process.env }, lhc: { home } });
  await session.close();
  return { threadId: session.threadId, projected: projected(opened.at(-1)!.resume!) };
}

async function twoTurns() {
  const { gen1, threadId } = await seedThread(home, cwd);
  const kept = await captureTurn(home, threadId, "KEEP-PROMPT", "KEEP-ANSWER");
  const removed = await captureTurn(home, threadId, "LATER-PROMPT", "LATER-ANSWER");
  return { gen1, threadId, kept, removed };
}

describe("forkSession", () => {
  test("a whole-thread fork serves every turn under a new session and thread, with the source's compact policy", async () => {
    const { gen1, threadId } = await twoTurns();

    const forked = await forkSession(gen1, store());

    expect(forked.sessionId).not.toBe(gen1);
    const forkThread = await resolveSession(forked.sessionId, home);
    expect(forkThread).not.toBeNull();
    expect(forkThread).not.toBe(threadId);
    const messages = await getSessionMessages(forked.sessionId, store());
    expect(JSON.stringify(messages)).toContain("KEEP-ANSWER");
    expect(JSON.stringify(messages)).toContain("LATER-ANSWER");
    expect(forked.headMessageId).toBe(messages.at(-1)?.uuid);
    const policy = await threads.getCompactPolicy(threadRef(forkThread!, home));
    expect(policy.ok && policy.value).toEqual(SEED_POLICY);
  });

  test("a fork at message M ends at M, and resuming the fork projects a session that ends at M", async () => {
    const { gen1, kept } = await twoTurns();

    const forked = await forkSession(gen1, { ...store(), upToMessageId: kept });

    expect(projected(forked.sessionId)).toContain("KEEP-ANSWER");
    expect(projected(forked.sessionId)).not.toContain("LATER");
    const resumed = await resume(forked.sessionId);
    expect(resumed.threadId).toBe(await resolveSession(forked.sessionId, home));
    expect(resumed.projected).toContain("KEEP-ANSWER");
    expect(resumed.projected).not.toContain("LATER");
  });

  test("a fork into another dir records that dir, so a fork of the fork lands there too", async () => {
    const { gen1 } = await twoTurns();
    const elsewhere = mkdtempSync(join(dir, "elsewhere-"));

    const first = await forkSession(gen1, { ...store(), dir: elsewhere });
    const second = await forkSession(first.sessionId, store());

    expect(existsSync(nativeSessionPath({ sessionId: second.sessionId, cwd: elsewhere, env: process.env }))).toBe(true);
  });

  test("forking leaves the source thread, its aliases and its served view unchanged", async () => {
    const { gen1, threadId, kept } = await twoTurns();
    const before = await served(threadId);

    await forkSession(gen1, { ...store(), upToMessageId: kept });

    expect(await served(threadId)).toBe(before);
    expect(await resolveSession(gen1, home)).toBe(threadId);
    const resumed = await resume(gen1);
    expect(resumed.threadId).toBe(threadId);
    expect(resumed.projected).toContain("LATER-ANSWER");
  });

  test("a source mid-turn is refused and leaves no copy", async () => {
    const { gen1, threadId } = await twoTurns();
    await capturePrompt(home, threadId, "OPEN-PROMPT");

    await expect(forkSession(gen1, store())).rejects.toThrow(/mid_turn: source \S+ is mid-turn/);
    expect(threadFiles()).toHaveLength(1);
  });

  test("an anchor no thread captured is refused and leaves no copy", async () => {
    const { gen1 } = await twoTurns();
    const unknown = randomUUID();

    await expect(forkSession(gen1, { ...store(), upToMessageId: unknown })).rejects.toThrow(
      `rollback anchor ${unknown} not found`,
    );
    expect(threadFiles()).toHaveLength(1);
  });

  test("a session no LHC thread holds is refused", async () => {
    await seedThread(home, cwd);
    const stranger = randomUUID();

    await expect(forkSession(stranger, store())).rejects.toThrow(`no LHC thread holds the Claude session ${stranger}`);
  });
});
