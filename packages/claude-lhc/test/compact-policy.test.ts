import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threads } from "lhc";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { capCompactPolicyToWindow } from "../src/compactPolicy.ts";

let contextUsage: () => Promise<unknown> = async () => ({ rawMaxTokens: 1_000_000 });
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    renameSession: async () => {},
    query: () => {
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

  test("capCompactPolicyToWindow caps a trigger above 80% of the window and halves the target", () => {
    const stored = { trigger: 700_000, target: 140_000 };
    expect(capCompactPolicyToWindow({ stored, window: 200_000 })).toEqual({ trigger: 160_000, target: 80_000 });
    expect(capCompactPolicyToWindow({ stored, window: 1_000_000 })).toEqual(stored);
    expect(capCompactPolicyToWindow({ stored, window: null })).toEqual(stored);
    expect(capCompactPolicyToWindow({ stored: { trigger: 700_000, target: 50_000 }, window: 200_000 })).toEqual({
      trigger: 160_000,
      target: 50_000,
    });
  });
});
