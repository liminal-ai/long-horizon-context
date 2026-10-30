import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threads } from "lhc";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let contextUsage: () => Promise<unknown> = async () => ({ rawMaxTokens: 1_000_000 });
const prompts: AsyncIterable<unknown>[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    renameSession: async () => {},
    query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      prompts.push(prompt);
      const never = new Promise<IteratorResult<never>>(() => {});
      return {
        [Symbol.asyncIterator]() {
          return { next: () => never };
        },
        getContextUsage: () => contextUsage(),
        setModel: async () => {},
        interrupt: async () => {},
        close: () => {},
      };
    },
  };
});

const { ClaudeLhcSession } = await import("../src/session.ts");
const { bindSession, createThread, threadRef } = await import("../src/lhcHome.ts");

let dir = "";
let home = "";
let logs: string[] = [];
const savedNoInference = process.env.CLAUDE_LHC_NO_INFERENCE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-compact-policy-"));
  home = join(dir, "lhc");
  logs = [];
  prompts.length = 0;
  contextUsage = async () => ({ rawMaxTokens: 1_000_000 });
  process.env.CLAUDE_LHC_NO_INFERENCE = "1";
});
afterEach(() => {
  if (savedNoInference === undefined) delete process.env.CLAUDE_LHC_NO_INFERENCE;
  else process.env.CLAUDE_LHC_NO_INFERENCE = savedNoInference;
  rmSync(dir, { recursive: true, force: true });
});

function session() {
  return new ClaudeLhcSession({
    emit(): void {},
    request: async () => ({}),
    end(): void {},
    fail(): void {},
    log: (line: string) => logs.push(line),
  });
}

const start = (s: InstanceType<typeof ClaudeLhcSession>, lhc: unknown, extra: Record<string, unknown> = {}) =>
  s.start({
    cwd: dir,
    model: "claude-sonnet-4-6",
    env: { CLAUDE_CONFIG_DIR: join(dir, "claude") },
    lhc,
    ...extra,
  } as never);

const prompt = (text: string) =>
  ({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: "",
  }) as never;

const compactPrompt = {
  type: "user",
  message: { role: "user", content: [{ type: "text", text: "/compact" }] },
  parent_tool_use_id: null,
  session_id: "",
} as never;

async function storedPolicy(threadId: string) {
  const read = await threads.getCompactPolicy(threadRef(threadId, home));
  if (!read.ok) throw new Error(read.error.reason);
  return read.value;
}

async function resumable(threadId: string): Promise<string> {
  const alias = "33333333-3333-4333-8333-333333333333";
  await bindSession(threadId, alias, home);
  return alias;
}

describe("thread compact policy at start", () => {
  test("create stores the host's pair on the thread", async () => {
    const s = session();
    await start(s, { home, compact: { trigger: 700_000, target: 140_000 } });
    expect(await storedPolicy(s.threadId)).toEqual({ trigger: 700_000, target: 140_000 });
  });

  test("resume with a different pair keeps the thread's pair and says so", async () => {
    const first = session();
    await start(first, { home, compact: { trigger: 700_000, target: 140_000 } });
    await first.close();
    const resume = await resumable(first.threadId);
    logs = [];
    const second = session();
    await start(second, { home, compact: { trigger: 300_000, target: 100_000 } }, { resume });
    expect(second.threadId).toBe(first.threadId);
    expect(logs).toContain("compact policy from thread: trigger 700000 target 140000");
    expect(await storedPolicy(first.threadId)).toEqual({ trigger: 700_000, target: 140_000 });
  });

  test("resume with the same pair logs nothing about the policy", async () => {
    const first = session();
    await start(first, { home, compact: { trigger: 700_000, target: 140_000 } });
    await first.close();
    const resume = await resumable(first.threadId);
    logs = [];
    await start(session(), { home, compact: { trigger: 700_000, target: 140_000 } }, { resume });
    expect(logs.some((line) => line.startsWith("compact policy from thread"))).toBe(false);
  });

  test("resume of a thread with no stored pair stores the host's pair", async () => {
    const threadId = await createThread(dir, home);
    const resume = await resumable(threadId);
    await start(session(), { home, compact: { trigger: 400_000, target: 120_000 } }, { resume });
    expect(logs).toContain("compact policy stored on thread: trigger 400000 target 120000");
    expect(await storedPolicy(threadId)).toEqual({ trigger: 400_000, target: 120_000 });
  });

  test("a start with neither a stored pair nor lhc.compact is refused", async () => {
    await expect(start(session(), { home })).rejects.toThrow("lhc.compact is required to create a thread");
    expect(existsSync(home)).toBe(false);

    const threadId = await createThread(dir, home);
    const resume = await resumable(threadId);
    await expect(start(session(), { home }, { resume })).rejects.toThrow(/no stored compact policy.*lhc\.compact/);
    expect(await storedPolicy(threadId)).toBeNull();
  });

  test("a start without lhc.home is refused before any store is touched", async () => {
    await expect(start(session(), { compact: { trigger: 700_000, target: 140_000 } })).rejects.toThrow(/^lhc\.home /);
    await expect(start(session(), undefined)).rejects.toThrow(/^lhc\.home /);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a malformed lhc.compact is refused naming the field", async () => {
    await expect(start(session(), { home, compact: { trigger: 100_000, target: 100_000 } })).rejects.toThrow(
      /^lhc\.compact /,
    );
    await expect(start(session(), { home, compact: { trigger: "700000", target: 140_000 } })).rejects.toThrow(
      /^lhc\.compact /,
    );
    expect(existsSync(home)).toBe(false);
  });
});

describe("compact policy against the live window", () => {
  test("a 200k window caps the pair and leaves the stored pair alone", async () => {
    contextUsage = async () => ({ rawMaxTokens: 200_000 });
    const s = session();
    await start(s, { home, compact: { trigger: 700_000, target: 140_000 } });
    await vi.waitFor(() =>
      expect(logs).toContain("compact policy capped to window 200000: trigger 160000 target 80000"),
    );
    expect(await storedPolicy(s.threadId)).toEqual({ trigger: 700_000, target: 140_000 });
  });

  test("a 1M window leaves the pair uncapped", async () => {
    await start(session(), { home, compact: { trigger: 700_000, target: 140_000 } });
    await vi.waitFor(() => expect(logs).toContain("context window 1000000 for model claude-sonnet-4-6"));
    expect(logs.some((line) => line.startsWith("compact policy capped"))).toBe(false);
  });

  test("setModel re-reads the window and caps to the new model", async () => {
    const s = session();
    await start(s, { home, compact: { trigger: 700_000, target: 140_000 } });
    await vi.waitFor(() => expect(logs).toContain("context window 1000000 for model claude-sonnet-4-6"));
    contextUsage = async () => ({ rawMaxTokens: 200_000 });
    await s.control("setModel", { model: "claude-sonnet-4-5" });
    expect(logs).toContain("context window 200000 for model claude-sonnet-4-5");
    expect(logs).toContain("compact policy capped to window 200000: trigger 160000 target 80000");
  });

  test("a /compact sent before the first window read lands still rebuilds to the capped target", async () => {
    contextUsage = () => new Promise((resolve) => setTimeout(() => resolve({ rawMaxTokens: 200_000 }), 200));
    const s = session();
    await start(s, { home, compact: { trigger: 700_000, target: 140_000 } });
    await s.pushUser(compactPrompt);
    expect(logs.find((line) => line.startsWith("[lhc compact:manual]"))).toContain("(target 80000)");
  });

  test("an older window read that answers late does not undo the cap from setModel", async () => {
    let answerStartupRead: (usage: unknown) => void = () => {};
    contextUsage = () => new Promise((resolve) => (answerStartupRead = resolve));
    const s = session();
    await start(s, { home, compact: { trigger: 700_000, target: 140_000 } });
    contextUsage = async () => ({ rawMaxTokens: 200_000 });
    await s.control("setModel", { model: "claude-sonnet-4-5" });
    answerStartupRead({ rawMaxTokens: 1_000_000 });
    await s.pushUser(compactPrompt);
    expect(logs).not.toContain("context window 1000000 for model claude-sonnet-4-5");
    expect(logs.find((line) => line.startsWith("[lhc compact:manual]"))).toContain("(target 80000)");
  });

  test("with no window known the pair stays as stored", async () => {
    contextUsage = async () => {
      throw new Error("control request failed");
    };
    await start(session(), { home, compact: { trigger: 700_000, target: 140_000 } });
    await vi.waitFor(() =>
      expect(logs).toContain(
        "context window read failed: control request failed; compact policy stays trigger 700000 target 140000",
      ),
    );
  });

  test("a capped trigger keeps a stored target already below half of it", async () => {
    contextUsage = async () => ({ rawMaxTokens: 200_000 });
    await start(session(), { home, compact: { trigger: 700_000, target: 50_000 } });
    await vi.waitFor(() =>
      expect(logs).toContain("compact policy capped to window 200000: trigger 160000 target 50000"),
    );
  });

  test("setModel returns only after its window read lands", async () => {
    const s = session();
    await start(s, { home, compact: { trigger: 700_000, target: 140_000 } });
    await vi.waitFor(() => expect(logs).toContain("context window 1000000 for model claude-sonnet-4-6"));
    let answerModelRead: (usage: unknown) => void = () => {};
    contextUsage = () => new Promise((resolve) => (answerModelRead = resolve));
    let returned = false;
    const switched = s.control("setModel", { model: "claude-sonnet-4-5" }).then(() => {
      returned = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(returned).toBe(false);
    answerModelRead({ rawMaxTokens: 200_000 });
    await switched;
    expect(logs).toContain("compact policy capped to window 200000: trigger 160000 target 80000");
  });

  test.each([
    1,
    2,
    1.5,
    0,
    -200_000,
    "200000",
    Number.NaN,
  ])("a rawMaxTokens of %s is no window and leaves the pair as stored", async (rawMaxTokens) => {
    contextUsage = async () => ({ rawMaxTokens });
    const s = session();
    await start(s, { home, compact: { trigger: 700_000, target: 140_000 } });
    await vi.waitFor(() =>
      expect(logs).toContain(
        `context window read returned rawMaxTokens ${typeof rawMaxTokens === "string" ? JSON.stringify(rawMaxTokens) : String(rawMaxTokens)}, not a usable window; compact policy stays trigger 700000 target 140000`,
      ),
    );
    await s.pushUser(compactPrompt);
    expect(logs.find((line) => line.startsWith("[lhc compact:manual]"))).toContain("(target 140000)");
  });
});

describe("served context after the window shrinks", () => {
  const SERVED =
    "served context 300000 tokens is at or past the compact trigger 160000; compacting before the next prompt";
  const servedThenCompacted = (window: number) => {
    let reads = 0;
    return async () => ({ rawMaxTokens: window, totalTokens: reads++ === 0 ? 300_000 : 40_000 });
  };

  test("a resume onto a smaller window compacts the projection before start returns", async () => {
    const first = session();
    await start(first, { home, compact: { trigger: 700_000, target: 140_000 } });
    await first.close();
    const resume = await resumable(first.threadId);
    logs = [];
    prompts.length = 0;
    contextUsage = servedThenCompacted(200_000);

    await start(session(), { home }, { resume });

    const served = logs.indexOf(SERVED);
    const compacted = logs.findIndex((line) => line.startsWith("[lhc compact:auto]"));
    const resumed = logs.findIndex((line) => line.startsWith("resumed thread"));
    expect(served).toBeGreaterThanOrEqual(0);
    expect(compacted).toBeGreaterThan(served);
    expect(resumed).toBeGreaterThan(compacted);
    expect(logs[compacted]).toContain("(target 80000)");
    expect(prompts).toHaveLength(2);
  });

  test("a resume whose served context fits the smaller window does not compact", async () => {
    const first = session();
    await start(first, { home, compact: { trigger: 700_000, target: 140_000 } });
    await first.close();
    const resume = await resumable(first.threadId);
    logs = [];
    contextUsage = async () => ({ rawMaxTokens: 200_000, totalTokens: 100_000 });

    await start(session(), { home }, { resume });

    expect(logs.some((line) => line.startsWith("[lhc compact"))).toBe(false);
  });

  test("a served context past a trigger the window did not cap leaves the resume to the turn-end check", async () => {
    const first = session();
    await start(first, { home, compact: { trigger: 50_000, target: 20_000 } });
    await first.close();
    const resume = await resumable(first.threadId);
    logs = [];
    contextUsage = async () => ({ rawMaxTokens: 200_000, totalTokens: 60_000 });

    await start(session(), { home }, { resume });

    expect(logs.some((line) => line.startsWith("served context"))).toBe(false);
    expect(logs.some((line) => line.startsWith("[lhc compact"))).toBe(false);
  });

  test("a setModel back to a larger window before the next prompt drops the queued compact", async () => {
    const s = session();
    contextUsage = async () => ({ rawMaxTokens: 1_000_000, totalTokens: 300_000 });
    await start(s, { home, compact: { trigger: 700_000, target: 140_000 } });
    await vi.waitFor(() => expect(logs).toContain("context window 1000000 for model claude-sonnet-4-6"));
    contextUsage = async () => ({ rawMaxTokens: 200_000, totalTokens: 300_000 });
    await s.control("setModel", { model: "claude-sonnet-4-5" });
    expect(logs).toContain(SERVED);
    contextUsage = async () => ({ rawMaxTokens: 1_000_000, totalTokens: 300_000 });

    await s.control("setModel", { model: "claude-sonnet-5" });
    await s.pushUser(prompt("NEXT-PROMPT"));

    expect(logs.some((line) => line.startsWith("[lhc compact"))).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify((await prompts[0]![Symbol.asyncIterator]().next()).value)).toContain("NEXT-PROMPT");
  });

  test("a /compact after the shrink satisfies the queued compact", async () => {
    const s = session();
    contextUsage = async () => ({ rawMaxTokens: 1_000_000, totalTokens: 300_000 });
    await start(s, { home, compact: { trigger: 700_000, target: 140_000 } });
    await vi.waitFor(() => expect(logs).toContain("context window 1000000 for model claude-sonnet-4-6"));
    contextUsage = servedThenCompacted(200_000);
    await s.control("setModel", { model: "claude-sonnet-4-5" });

    await s.pushUser(compactPrompt);
    await s.pushUser(prompt("NEXT-PROMPT"));

    expect(logs.filter((line) => line.startsWith("[lhc compact"))).toHaveLength(1);
    expect(prompts).toHaveLength(2);
  });

  test("setModel to a smaller window queues a compact that runs before the next prompt goes out", async () => {
    const s = session();
    contextUsage = async () => ({ rawMaxTokens: 1_000_000, totalTokens: 300_000 });
    await start(s, { home, compact: { trigger: 700_000, target: 140_000 } });
    await vi.waitFor(() => expect(logs).toContain("context window 1000000 for model claude-sonnet-4-6"));
    expect(logs.some((line) => line.startsWith("served context"))).toBe(false);
    contextUsage = servedThenCompacted(200_000);

    await s.control("setModel", { model: "claude-sonnet-4-5" });

    expect(logs).toContain(SERVED);
    expect(logs.some((line) => line.startsWith("[lhc compact"))).toBe(false);
    expect(prompts).toHaveLength(1);

    await s.pushUser(prompt("NEXT-PROMPT"));

    expect(logs.find((line) => line.startsWith("[lhc compact:auto]"))).toContain("(target 80000)");
    expect(prompts).toHaveLength(2);
    expect(await prompts[0]![Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
    const delivered = await prompts[1]![Symbol.asyncIterator]().next();
    expect(JSON.stringify(delivered.value)).toContain("NEXT-PROMPT");
  });
});
