import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { threads } from "lhc";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mapPrompt, mapSdkMessage } from "../src/capture/mapper.ts";
import { createLhc, resolveSession, threadRef } from "../src/lhcHome.ts";
import { nativeProjectDir, nativeSessionPath } from "../src/nativeSessionFile.ts";
import { ClaudeLhcSession } from "../src/session.ts";

const opened: Options[] = [];
const fed: AsyncIterable<SDKUserMessage>[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    renameSession: async () => {},
    query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      opened.push(options);
      fed.push(prompt);
      const never = new Promise<IteratorResult<never>>(() => {});
      return {
        [Symbol.asyncIterator]() {
          return { next: () => never };
        },
        getContextUsage: async () => ({ rawMaxTokens: 1_000_000 }),
        interrupt: async () => {},
        close: () => {},
      };
    },
  };
});

const COMPACT = { trigger: 500_000, target: 180_000 };
const SMALL_COMPACT = { trigger: 2_000, target: 1_000 };

let dir: string;
let home: string;
let claudeHome: string;
const savedNoInference = process.env.CLAUDE_LHC_NO_INFERENCE;
beforeEach(() => {
  opened.length = 0;
  fed.length = 0;
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-rollback-"));
  home = join(dir, "lhc-home");
  claudeHome = join(dir, "claude-home");
  process.env.CLAUDE_LHC_NO_INFERENCE = "1";
});
afterEach(() => {
  if (savedNoInference === undefined) delete process.env.CLAUDE_LHC_NO_INFERENCE;
  else process.env.CLAUDE_LHC_NO_INFERENCE = savedNoInference;
  rmSync(dir, { recursive: true, force: true });
});

const lhc = () => createLhc({ claudeBin: "claude", env: {}, tokenFamily: "claude-2026" });
const ref = (threadId: string) => threadRef(threadId, home);

async function startSession(options: Record<string, unknown>, compact = COMPACT) {
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
    env: { CLAUDE_CONFIG_DIR: claudeHome },
    lhc: { home, compact },
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

const resultMessage = (isError = false): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: isError,
    uuid: randomUUID(),
    session_id: "",
  }) as unknown as SDKMessage;

async function intake(threadId: string, events: ReturnType<typeof mapPrompt>): Promise<void> {
  const sent = await lhc().intakeStream.messageEvents(ref(threadId), events);
  if (!sent.ok) throw new Error(sent.error.reason);
}

async function capture(threadId: string, prompt: string, replies: SDKMessage[]): Promise<void> {
  await intake(threadId, [
    ...mapPrompt(userMessage(prompt), randomUUID(), false),
    ...replies.flatMap((message) => mapSdkMessage(message, undefined).events),
    ...mapSdkMessage(resultMessage(), undefined).events,
  ]);
}

async function captureTurn(threadId: string, prompt: string, answer: string): Promise<string> {
  const uuid = randomUUID();
  await capture(threadId, prompt, [assistantMessage(uuid, [{ type: "text", text: answer }])]);
  return uuid;
}

async function eventKeys(threadId: string): Promise<number> {
  const keys = await lhc().intakeStream.listEventKeysByPrefix(ref(threadId), { prefix: "claude-lhc:" });
  if (!keys.ok) throw new Error(keys.error.reason);
  return keys.value.keys.length;
}

const nativeEnv = () => ({ CLAUDE_CONFIG_DIR: claudeHome });

function projectedText(options: Options): string {
  if (options.resume === undefined) throw new Error("the generation did not resume a projected file");
  return readFileSync(nativeSessionPath({ sessionId: options.resume, cwd: dir, env: nativeEnv() }), "utf8");
}

async function servedText(threadId: string): Promise<string> {
  const view = await lhc().threadView.getSessionThreadView(ref(threadId));
  if (!view.ok) throw new Error(view.error.reason);
  return JSON.stringify(view.value.entries);
}

const nativeFiles = () => {
  const root = nativeProjectDir({ cwd: dir, env: nativeEnv() });
  return existsSync(root) ? readdirSync(root, { recursive: true }).map(String) : [];
};

type NativeLine = { uuid: string; type: "user" | "assistant" | "attachment"; text?: string; model?: string };

function appendNative(
  sessionId: string,
  lines: NativeLine[],
  path = nativeSessionPath({ sessionId, cwd: dir, env: nativeEnv() }),
) {
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
  let parentUuid: string | null = existing.length === 0 ? null : JSON.parse(existing.at(-1)!).uuid;
  const body = lines.map(({ uuid, type, text, model }) => {
    const message =
      type === "attachment"
        ? undefined
        : { role: type, content: [{ type: "text", text }], ...(model ? { model } : {}) };
    const line = JSON.stringify({
      parentUuid,
      isSidechain: false,
      type,
      uuid,
      sessionId,
      ...(message ? { message } : {}),
    });
    parentUuid = uuid;
    return line;
  });
  appendFileSync(path, `${body.join("\n")}\n`);
}

async function seedThread(): Promise<{ gen1: string; threadId: string }> {
  const gen1 = randomUUID();
  const { session } = await startSession({ sessionId: gen1 });
  await session.close();
  return { gen1, threadId: session.threadId };
}

describe("host rollback on resume", () => {
  test("a captured anchor: the projected file and served view end at the kept turn, and resumeSessionAt never reaches the CLI", async () => {
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
    expect(logs.some((line) => /^rollback to event \d+ via /.test(line) && line.includes(`via ${kept};`))).toBe(true);
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

  test("ancestor walk: a synthetic notice anchor keeps through its turn's prompt across compact and restart", async () => {
    const { gen1, threadId } = await seedThread();
    await captureTurn(threadId, "KEEP-PROMPT", "KEEP-ANSWER");
    const live = await startSession({ resume: gen1 });
    const liveGen = live.options.resume!;
    const promptUuid = randomUUID();
    await live.session.pushUser({ ...userMessage("FAILED-PROMPT"), uuid: promptUuid });
    await fed.at(-1)![Symbol.asyncIterator]().next();
    await intake(threadId, mapSdkMessage(resultMessage(true), undefined).events);
    await live.session.close();
    const removed = await captureTurn(threadId, "REMOVED-PROMPT", "REMOVED-ANSWER");
    const synthetic = randomUUID();
    appendNative(liveGen, [
      { uuid: promptUuid, type: "user", text: "FAILED-PROMPT" },
      { uuid: randomUUID(), type: "attachment" },
      { uuid: synthetic, type: "assistant", text: "API Error: 401", model: "<synthetic>" },
      { uuid: randomUUID(), type: "user", text: "REMOVED-PROMPT" },
      { uuid: removed, type: "assistant", text: "REMOVED-ANSWER" },
    ]);

    const { session, logs, options } = await startSession({ resume: gen1, resumeSessionAt: synthetic });

    expect(options).not.toHaveProperty("resumeSessionAt");
    const projected = projectedText(options);
    expect(projected).toContain("KEEP-ANSWER");
    expect(projected).toContain("FAILED-PROMPT");
    expect(projected).not.toContain("REMOVED");
    expect(await servedText(threadId)).not.toContain("REMOVED");
    expect(logs.some((line) => line.includes(`via ${promptUuid} (nearest captured ancestor of ${synthetic})`))).toBe(
      true,
    );

    await session.pushUser(userMessage("/compact"));
    const compacted = opened.at(-1)!;
    expect(projectedText(compacted)).not.toContain("REMOVED");
    await session.close();
    const restarted = await startSession({ resume: compacted.resume });
    expect(projectedText(restarted.options)).not.toContain("REMOVED");
    expect(await servedText(threadId)).not.toContain("REMOVED");
  });

  test("ancestor walk: a synthetic notice after an uncaptured prompt keeps through the last real assistant message", async () => {
    const { gen1, threadId } = await seedThread();
    const kept = await captureTurn(threadId, "KEEP-PROMPT", "KEEP-ANSWER");
    await intake(threadId, [
      ...mapPrompt(userMessage("FAILED-PROMPT"), randomUUID(), false),
      ...mapSdkMessage(resultMessage(true), undefined).events,
    ]);
    const removed = await captureTurn(threadId, "REMOVED-PROMPT", "REMOVED-ANSWER");
    const synthetic = randomUUID();
    appendNative(gen1, [
      { uuid: randomUUID(), type: "user", text: "KEEP-PROMPT" },
      { uuid: kept, type: "assistant", text: "KEEP-ANSWER" },
      { uuid: randomUUID(), type: "user", text: "FAILED-PROMPT" },
      { uuid: synthetic, type: "assistant", text: "API Error: 401", model: "<synthetic>" },
      { uuid: randomUUID(), type: "user", text: "REMOVED-PROMPT" },
      { uuid: removed, type: "assistant", text: "REMOVED-ANSWER" },
    ]);

    const { logs, options } = await startSession({ resume: gen1, resumeSessionAt: synthetic });

    const projected = projectedText(options);
    expect(projected).toContain("KEEP-ANSWER");
    expect(projected).not.toContain("FAILED-PROMPT");
    expect(projected).not.toContain("REMOVED");
    expect(logs.some((line) => line.includes(`via ${kept} (nearest captured ancestor of ${synthetic})`))).toBe(true);
  });

  test("unknown anchor: a subagent line with no captured ancestor is refused before anything reaches the CLI", async () => {
    const { gen1, threadId } = await seedThread();
    const kept = await captureTurn(threadId, "KEEP-PROMPT", "KEEP-ANSWER");
    const removed = await captureTurn(threadId, "REMOVED-PROMPT", "REMOVED-ANSWER");
    appendNative(gen1, [
      { uuid: randomUUID(), type: "user", text: "KEEP-PROMPT" },
      { uuid: kept, type: "assistant", text: "KEEP-ANSWER" },
      { uuid: randomUUID(), type: "user", text: "REMOVED-PROMPT" },
      { uuid: removed, type: "assistant", text: "REMOVED-ANSWER" },
    ]);
    const subagent = randomUUID();
    const sidechain = join(nativeProjectDir({ cwd: dir, env: nativeEnv() }), gen1, "subagents", "agent-a1.jsonl");
    appendNative(gen1, [{ uuid: subagent, type: "assistant", text: "SUBAGENT-ANSWER" }], sidechain);
    const files = nativeFiles();
    const queries = opened.length;
    const events = await eventKeys(threadId);

    await expect(startSession({ resume: gen1, resumeSessionAt: subagent })).rejects.toThrow(
      `rollback anchor ${subagent} not found`,
    );
    expect(opened.length).toBe(queries);
    expect(nativeFiles()).toEqual(files);
    expect(await eventKeys(threadId)).toBe(events);
  });

  test("unknown anchor: an anchor no transcript carries is refused and writes no event, even with an open turn to settle", async () => {
    const { gen1, threadId } = await seedThread();
    await captureTurn(threadId, "FIRST-PROMPT", "FIRST-ANSWER");
    await intake(threadId, mapPrompt(userMessage("OPEN-PROMPT"), randomUUID(), false));
    const unknown = randomUUID();
    const queries = opened.length;
    const events = await eventKeys(threadId);

    await expect(startSession({ resume: gen1, resumeSessionAt: unknown })).rejects.toThrow(
      `rollback anchor ${unknown} not found`,
    );
    expect(opened.length).toBe(queries);
    expect(await eventKeys(threadId)).toBe(events);
  });

  test("rollback before compact: a kept tail past the trigger compacts before projecting", async () => {
    const { gen1, threadId } = await seedThread();
    const filler = " filler".repeat(400);
    const anchors: string[] = [];
    for (let i = 0; i < 8; i += 1)
      anchors.push(await captureTurn(threadId, `KEEP-PROMPT-${i}${filler}`, `KEEP-ANSWER-${i}${filler}`));
    for (let i = 0; i < 4; i += 1)
      await captureTurn(threadId, `REMOVED-PROMPT-${i}${filler}`, `REMOVED-ANSWER-${i}${filler}`);
    const policy = await threads.setCompactPolicy(ref(threadId), SMALL_COMPACT);
    if (!policy.ok) throw new Error(policy.error.reason);
    const compactBefore = await startSession({ resume: gen1 });
    await compactBefore.session.pushUser(userMessage("/compact"));
    await compactBefore.session.close();
    const before = await lhc().threadView.describe(ref(threadId));
    if (!before.ok || before.value === null) throw new Error("the seed compact stored no view");

    const { session, logs, options } = await startSession({ resume: gen1, resumeSessionAt: anchors[1] });

    expect(logs.some((line) => line.startsWith("[lhc compact:auto]"))).toBe(true);
    const after = await lhc().threadView.describe(ref(threadId));
    if (!after.ok || after.value === null) throw new Error("no view stored after the rollback");
    expect(after.value.compactPoint).toBeLessThan(before.value.compactPoint);
    expect(projectedText(options)).not.toContain("REMOVED");
    expect(projectedText(options)).not.toContain("KEEP-ANSWER-2");

    await session.pushUser(userMessage("/compact"));
    expect(projectedText(opened.at(-1)!)).not.toContain("REMOVED");
    expect(await servedText(threadId)).not.toContain("REMOVED");
  });

  test("a kept tail under the trigger projects without compacting", async () => {
    const { gen1, threadId } = await seedThread();
    const kept = await captureTurn(threadId, "KEEP-PROMPT", "KEEP-ANSWER");
    await captureTurn(threadId, "REMOVED-PROMPT", "REMOVED-ANSWER");

    const { logs } = await startSession({ resume: gen1, resumeSessionAt: kept });

    expect(logs.some((line) => line.startsWith("[lhc compact"))).toBe(false);
  });

  test("rollback then restart: a plain restart after the rollback still ends at the anchor", async () => {
    const { gen1, threadId } = await seedThread();
    const kept = await captureTurn(threadId, "KEEP-PROMPT", "KEEP-ANSWER");
    await captureTurn(threadId, "REMOVED-PROMPT", "REMOVED-ANSWER");
    const rolled = await startSession({ resume: gen1, resumeSessionAt: kept });
    await rolled.session.close();

    const { session, options } = await startSession({ resume: rolled.options.resume });

    expect(session.threadId).toBe(threadId);
    const projected = projectedText(options);
    expect(projected).toContain("KEEP-ANSWER");
    expect(projected).not.toContain("REMOVED");
    const afterOld = await startSession({ resume: gen1 });
    expect(projectedText(afterOld.options)).not.toContain("REMOVED");
  });
});

describe("thread start", () => {
  const threadFiles = () => readdirSync(join(home, "threads")).length;

  test("a fresh session id opens a new thread and the old thread keeps its aliases", async () => {
    const { gen1, threadId } = await seedThread();
    const restart = randomUUID();

    const { session } = await startSession({ sessionId: restart });

    expect(session.threadId).not.toBe(threadId);
    expect(await resolveSession(gen1, home)).toBe(threadId);
    expect(await resolveSession(restart, home)).toBe(session.threadId);
    expect(threadFiles()).toBe(2);
  });

  test("a fresh start that reuses a bound session id is refused before any thread is created", async () => {
    const { gen1, threadId } = await seedThread();

    await expect(startSession({ sessionId: gen1 })).rejects.toThrow(
      `Claude session ${gen1} already names LHC thread ${threadId}; a fresh start needs a new session id`,
    );
    expect(threadFiles()).toBe(1);
    expect(await resolveSession(gen1, home)).toBe(threadId);
  });

  test("resuming a thread with no served entries opens a fresh native session instead of an empty file", async () => {
    const { gen1, threadId } = await seedThread();

    const { session, options } = await startSession({ resume: gen1 });

    expect(session.threadId).toBe(threadId);
    expect(options).not.toHaveProperty("resume");
    if (options.sessionId === undefined) throw new Error("the generation has no session id");
    expect(existsSync(nativeSessionPath({ sessionId: options.sessionId, cwd: dir, env: nativeEnv() }))).toBe(false);
    expect(await resolveSession(options.sessionId, home)).toBe(threadId);
  });
});
