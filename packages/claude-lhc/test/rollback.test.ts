import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mapPrompt, mapSdkMessage } from "../src/capture/mapper.ts";
import { createLhc, resolveSession, threadRef } from "../src/lhcHome.ts";
import { nativeSessionPath } from "../src/nativeSessionFile.ts";
import { ClaudeLhcSession } from "../src/session.ts";

const opened: Options[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    renameSession: async () => {},
    query: ({ options }: { options: Options }) => {
      opened.push(options);
      const never = new Promise<IteratorResult<never>>(() => {});
      return {
        [Symbol.asyncIterator]() {
          return { next: () => never };
        },
        interrupt: async () => {},
        close: () => {},
      };
    },
  };
});

let dir: string;
let claudeHome: string;
const saved = { home: process.env.T3CODE_LHC_HOME, noInf: process.env.T3CODE_LHC_NO_INFERENCE };
beforeEach(() => {
  opened.length = 0;
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-rollback-"));
  claudeHome = join(dir, "claude-home");
  process.env.T3CODE_LHC_HOME = join(dir, "lhc-home");
  process.env.T3CODE_LHC_NO_INFERENCE = "1";
});
afterEach(() => {
  if (saved.home === undefined) delete process.env.T3CODE_LHC_HOME;
  else process.env.T3CODE_LHC_HOME = saved.home;
  if (saved.noInf === undefined) delete process.env.T3CODE_LHC_NO_INFERENCE;
  else process.env.T3CODE_LHC_NO_INFERENCE = saved.noInf;
  rmSync(dir, { recursive: true, force: true });
});

const lhc = () => createLhc({ claudeBin: "claude", env: {}, tokenFamily: "claude-2026" });

async function startSession(
  options: Record<string, unknown>,
  settings = { autoCompactWindow: 500_000, lhcLowerBound: 180_000 },
) {
  const logs: string[] = [];
  const session = new ClaudeLhcSession({
    emit(): void {},
    request: async () => ({}),
    end(): void {},
    fail(): void {},
    log: (line: string) => logs.push(line),
  });
  await session.start({
    cwd: dir,
    model: "claude-sonnet-5",
    settings,
    env: { CLAUDE_CONFIG_DIR: claudeHome },
    ...options,
  });
  return { session, logs, options: opened.at(-1)! };
}

const userMessage = (text: string): SDKUserMessage =>
  ({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  }) as SDKUserMessage;

const assistantMessage = (uuid: string, content: Array<Record<string, unknown>>): SDKMessage =>
  ({
    type: "assistant",
    uuid,
    parent_tool_use_id: null,
    session_id: "",
    message: { id: `msg_${uuid}`, model: "claude-sonnet-5", role: "assistant", content },
  }) as unknown as SDKMessage;

const toolResultMessage = (toolUseId: string, text: string): SDKMessage =>
  ({
    type: "user",
    uuid: randomUUID(),
    parent_tool_use_id: null,
    session_id: "",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] },
  }) as unknown as SDKMessage;

const resultMessage = (): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    uuid: randomUUID(),
    session_id: "",
  }) as unknown as SDKMessage;

async function capture(threadId: string, prompt: string, replies: SDKMessage[]): Promise<void> {
  const events = [
    ...mapPrompt(userMessage(prompt), randomUUID(), false),
    ...replies.flatMap((message) => mapSdkMessage(message, undefined).events),
    ...mapSdkMessage(resultMessage(), undefined).events,
  ];
  const sent = await lhc().intakeStream.messageEvents(threadRef(threadId), events);
  if (!sent.ok) throw new Error(sent.error.reason);
}

async function captureTurn(threadId: string, prompt: string, answer: string): Promise<string> {
  const uuid = randomUUID();
  await capture(threadId, prompt, [assistantMessage(uuid, [{ type: "text", text: answer }])]);
  return uuid;
}

function projectedText(options: Options): string {
  if (options.resume === undefined) throw new Error("the generation did not resume a projected file");
  const path = nativeSessionPath({ sessionId: options.resume, cwd: dir, env: { CLAUDE_CONFIG_DIR: claudeHome } });
  return readFileSync(path, "utf8");
}

async function servedText(threadId: string): Promise<string> {
  const view = await lhc().threadView.getSessionThreadView(threadRef(threadId));
  if (!view.ok) throw new Error(view.error.reason);
  return JSON.stringify(view.value.entries);
}

async function seedThread(): Promise<{ gen1: string; threadId: string }> {
  const gen1 = randomUUID();
  const { session } = await startSession({ sessionId: gen1 });
  await session.close();
  return { gen1, threadId: session.threadId };
}

describe("host rollback on resume", () => {
  test("the projected file and the served view end at the kept turn, and resumeSessionAt never reaches the CLI", async () => {
    const { gen1, threadId } = await seedThread();
    const kept = await captureTurn(threadId, "KEEP-PROMPT", "KEEP-ANSWER");
    await captureTurn(threadId, "REMOVED-PROMPT", "REMOVED-ANSWER");

    const { session, logs, options } = await startSession({ resume: gen1, resumeSessionAt: kept });

    expect(session.threadId).toBe(threadId);
    expect(options).not.toHaveProperty("resumeSessionAt");
    const projected = projectedText(options);
    expect(projected).toContain("KEEP-ANSWER");
    expect(projected).not.toContain("REMOVED");
    expect(await servedText(threadId)).not.toContain("REMOVED");
    expect(logs.some((line) => line.startsWith(`rollback to ${kept}: kept through event`))).toBe(true);
  });

  test("an anchor on a multi-block message keeps every block of that message and drops what followed", async () => {
    const { gen1, threadId } = await seedThread();
    const anchor = randomUUID();
    await capture(threadId, "KEEP-PROMPT", [
      assistantMessage(anchor, [
        { type: "text", text: "KEEP-PREAMBLE" },
        { type: "tool_use", id: "toolu_keep", name: "Read", input: { file: "KEEP-FILE" } },
      ]),
      toolResultMessage("toolu_keep", "REMOVED-RESULT"),
      assistantMessage(randomUUID(), [{ type: "text", text: "REMOVED-ANSWER" }]),
    ]);

    const { options } = await startSession({ resume: gen1, resumeSessionAt: anchor });

    const projected = projectedText(options);
    expect(projected).toContain("KEEP-PREAMBLE");
    expect(projected).toContain("KEEP-FILE");
    expect(projected).not.toContain("REMOVED");
  });

  test("an anchor no captured event carries projects the current view with a logged reason", async () => {
    const { gen1, threadId } = await seedThread();
    await captureTurn(threadId, "FIRST-PROMPT", "FIRST-ANSWER");
    await captureTurn(threadId, "SECOND-PROMPT", "SECOND-ANSWER");
    const unknown = randomUUID();

    const { logs, options } = await startSession({ resume: gen1, resumeSessionAt: unknown });

    expect(options).not.toHaveProperty("resumeSessionAt");
    expect(projectedText(options)).toContain("SECOND-ANSWER");
    expect(logs).toContain(
      `rollback to ${unknown} skipped: no captured event carries that message uuid; projecting the current view`,
    );
  });

  test("a rollback that leaves the served tail past the compact trigger compacts before projecting", async () => {
    const { gen1, threadId } = await seedThread();
    const filler = " filler".repeat(400);
    const anchors: string[] = [];
    for (let i = 0; i < 8; i += 1)
      anchors.push(await captureTurn(threadId, `KEEP-PROMPT-${i}${filler}`, `KEEP-ANSWER-${i}${filler}`));
    for (let i = 0; i < 4; i += 1)
      await captureTurn(threadId, `REMOVED-PROMPT-${i}${filler}`, `REMOVED-ANSWER-${i}${filler}`);
    const compactBefore = await startSession({ resume: gen1 }, { autoCompactWindow: 2_000, lhcLowerBound: 1_000 });
    await compactBefore.session.pushUser(userMessage("/compact"));
    await compactBefore.session.close();
    const before = await lhc().threadView.describe(threadRef(threadId));
    if (!before.ok || before.value === null) throw new Error("the seed compact stored no view");

    const settings = { autoCompactWindow: 2_000, lhcLowerBound: 1_000 };
    const { session, logs, options } = await startSession({ resume: gen1, resumeSessionAt: anchors[1] }, settings);

    expect(logs.some((line) => line.startsWith("[lhc compact:auto]"))).toBe(true);
    const after = await lhc().threadView.describe(threadRef(threadId));
    if (!after.ok || after.value === null) throw new Error("no view stored after the rollback");
    expect(after.value.compactPoint).toBeLessThan(before.value.compactPoint);
    expect(projectedText(options)).not.toContain("REMOVED");
    expect(projectedText(options)).not.toContain("KEEP-ANSWER-2");

    await session.pushUser(userMessage("/compact"));
    expect(projectedText(opened.at(-1)!)).not.toContain("REMOVED");
    expect(await servedText(threadId)).not.toContain("REMOVED");
  });

  test("a rollback that leaves the served tail under the trigger projects without compacting", async () => {
    const { gen1, threadId } = await seedThread();
    const kept = await captureTurn(threadId, "KEEP-PROMPT", "KEEP-ANSWER");
    await captureTurn(threadId, "REMOVED-PROMPT", "REMOVED-ANSWER");

    const { logs } = await startSession({ resume: gen1, resumeSessionAt: kept });

    expect(logs.some((line) => line.startsWith("[lhc compact"))).toBe(false);
  });
});

describe("thread start", () => {
  const threadFiles = () => readdirSync(join(dir, "lhc-home", "threads")).length;

  test("a fresh session id opens a new thread and the old thread keeps its aliases", async () => {
    const { gen1, threadId } = await seedThread();
    const restart = randomUUID();

    const { session } = await startSession({ sessionId: restart });

    expect(session.threadId).not.toBe(threadId);
    expect(await resolveSession(gen1)).toBe(threadId);
    expect(await resolveSession(restart)).toBe(session.threadId);
    expect(threadFiles()).toBe(2);
  });

  test("a fresh start that reuses a bound session id is refused before any thread is created", async () => {
    const { gen1, threadId } = await seedThread();

    await expect(startSession({ sessionId: gen1 })).rejects.toThrow(
      `Claude session ${gen1} already names LHC thread ${threadId}; a fresh start needs a new session id`,
    );
    expect(threadFiles()).toBe(1);
    expect(await resolveSession(gen1)).toBe(threadId);
  });

  test("resuming a thread with no served entries opens a fresh native session instead of an empty file", async () => {
    const { gen1, threadId } = await seedThread();

    const { session, options } = await startSession({ resume: gen1 });

    expect(session.threadId).toBe(threadId);
    expect(options).not.toHaveProperty("resume");
    if (options.sessionId === undefined) throw new Error("the generation has no session id");
    const path = nativeSessionPath({ sessionId: options.sessionId, cwd: dir, env: { CLAUDE_CONFIG_DIR: claudeHome } });
    expect(existsSync(path)).toBe(false);
    expect(await resolveSession(options.sessionId)).toBe(threadId);
  });
});
