import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Options, getSessionMessages as sdkSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { captureTurn, seedLhc, seedThread } from "./support/seedThread.ts";

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

const { getSessionMessages, getSubagentMessages } = await import("../src/index.ts");
const { ClaudeLhcSession } = await import("../src/session.ts");
const { threadRef } = await import("../src/lhcHome.ts");
const { nativeProjectDir, nativeSessionPath } = await import("../src/nativeSessionFile.ts");

let dir = "";
let home = "";
let cwd = "";
const saved = { config: process.env.CLAUDE_CONFIG_DIR, noInference: process.env.CLAUDE_LHC_NO_INFERENCE };

beforeEach(() => {
  opened.length = 0;
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-history-"));
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

async function compactedThread(): Promise<{ gen1: string; current: string }> {
  const { gen1, threadId } = await seedThread(home, cwd);
  await captureTurn(home, threadId, "FIRST-PROMPT", "FIRST-ANSWER");
  await seedLhc().work.drain(threadRef(threadId, home));
  const session = new ClaudeLhcSession({
    emit(): void {},
    request: async () => ({}),
    end(): void {},
    fail(): void {},
    log(): void {},
  });
  await session.start({ resume: gen1, cwd, model: "claude-sonnet-5", env: { ...process.env }, lhc: { home } });
  await session.pushUser({
    type: "user",
    message: { role: "user", content: "/compact" },
    parent_tool_use_id: null,
    session_id: "",
  });
  await session.close();
  const current = opened.at(-1)!.resume!;
  expect(opened).toHaveLength(2);
  return { gen1, current };
}

function writeSession(sessionId: string, prompt: string): void {
  const path = nativeSessionPath({ sessionId, cwd, env: process.env });
  mkdirSync(dirname(path), { recursive: true });
  const line = { parentUuid: null, isSidechain: false, type: "user", uuid: randomUUID(), sessionId, cwd };
  writeFileSync(path, `${JSON.stringify({ ...line, message: { role: "user", content: prompt } })}\n`);
}

function writeSubagent(
  sessionId: string,
  agentId: string,
  toolUseId: string,
  nested: string[] = [],
  reply = "AGENT-REPLY",
): string {
  const subagents = join(nativeProjectDir({ cwd, env: process.env }), sessionId, "subagents", ...nested);
  mkdirSync(subagents, { recursive: true });
  const first = randomUUID();
  const line = (uuid: string, parentUuid: string | null, role: "user" | "assistant", text: string) =>
    JSON.stringify({
      parentUuid,
      isSidechain: true,
      agentId,
      type: role,
      uuid,
      sessionId,
      cwd,
      message: { role, content: [{ type: "text", text }] },
    });
  writeFileSync(
    join(subagents, `agent-${agentId}.jsonl`),
    `${line(first, null, "user", "AGENT-TASK")}\n${line(randomUUID(), first, "assistant", reply)}\n`,
  );
  writeFileSync(join(subagents, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general", toolUseId }));
  return join(subagents, `agent-${agentId}.jsonl`);
}

describe("getSessionMessages", () => {
  test("a superseded session id reads the thread's current generation", async () => {
    const { gen1, current } = await compactedThread();

    const messages = await getSessionMessages(gen1, store());

    expect(messages.length).toBeGreaterThan(0);
    expect(messages).toEqual(await sdkSessionMessages(current));
    expect(messages.every((message) => message.session_id === current)).toBe(true);
    expect(JSON.stringify(messages)).toContain("FIRST-ANSWER");
  });

  test("a session id no LHC thread holds fails by name, even with a stock transcript under it", async () => {
    await seedThread(home, cwd);
    const plain = randomUUID();
    writeSession(plain, "PLAIN-PROMPT");
    expect(await sdkSessionMessages(plain)).toHaveLength(1);

    await expect(getSessionMessages(plain, store())).rejects.toThrow(`no LHC thread holds the Claude session ${plain}`);
  });
});

describe("getSubagentMessages", () => {
  test("the thread's first session id finds a subagent launched after a compact", async () => {
    const { gen1, current } = await compactedThread();
    const agentId = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    writeSubagent(current, agentId, "toolu_after_compact");

    const messages = await getSubagentMessages(gen1, agentId, store());

    expect(messages.map((message) => message.type)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(messages)).toContain("AGENT-REPLY");
    expect(messages[0]?.parent_tool_use_id).toBe("toolu_after_compact");
  });

  test("a nested subagent transcript in a later generation is found too", async () => {
    const { gen1, current } = await compactedThread();
    const agentId = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    writeSubagent(current, agentId, "toolu_nested", ["workflows", "wf_1"]);

    const messages = await getSubagentMessages(gen1, agentId, store());

    expect(JSON.stringify(messages)).toContain("AGENT-REPLY");
  });

  test("an agent id under two generations reads the newest transcript", async () => {
    const { gen1, current } = await compactedThread();
    writeSession(gen1, "FIRST-PROMPT");
    const agentId = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const files = new Map(
      [gen1, current].map((sessionId) => [sessionId, writeSubagent(sessionId, agentId, "toolu_x")]),
    );
    const projectDir = nativeProjectDir({ cwd, env: process.env });
    const [listedFirst, listedSecond] = readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && files.has(entry.name))
      .map((entry) => entry.name);
    writeSubagent(listedFirst!, agentId, "toolu_x", [], "OLDER-REPLY");
    writeSubagent(listedSecond!, agentId, "toolu_x", [], "NEWER-REPLY");
    utimesSync(files.get(listedFirst!)!, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    const messages = await getSubagentMessages(gen1, agentId, store());

    expect(JSON.stringify(messages)).toContain("NEWER-REPLY");
  });

  test("a session id no LHC thread holds fails by name, even with a stock subagent under it", async () => {
    await seedThread(home, cwd);
    const plain = randomUUID();
    writeSession(plain, "PLAIN-PROMPT");
    const agentId = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    writeSubagent(plain, agentId, "toolu_plain");

    await expect(getSubagentMessages(plain, agentId, store())).rejects.toThrow(
      `no LHC thread holds the Claude session ${plain}`,
    );
  });

  test("a subagent another thread launched is not returned", async () => {
    const { gen1 } = await compactedThread();
    const other = await seedThread(home, cwd);
    writeSession(other.gen1, "OTHER-PROMPT");
    const agentId = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    writeSubagent(other.gen1, agentId, "toolu_other");

    expect(await getSubagentMessages(gen1, agentId, store())).toEqual([]);
    expect(JSON.stringify(await getSubagentMessages(other.gen1, agentId, store()))).toContain("AGENT-REPLY");
  });
});
