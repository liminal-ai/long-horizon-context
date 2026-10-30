import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { threads } from "lhc";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mapPrompt, mapSdkMessage, messageKeyPrefix } from "../src/capture/mapper.ts";
import { createLhc, resolveSession, threadRef } from "../src/lhcHome.ts";
import { nativeProjectDir, nativeSessionPath } from "../src/nativeSessionFile.ts";
import { ClaudeLhcSession } from "../src/session.ts";

const opened: Options[] = [];
const fed: AsyncIterable<SDKUserMessage>[] = [];
const streams: Array<(message: SDKMessage) => void> = [];
let windowTokens = 1_000_000;
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    renameSession: async () => {},
    query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      opened.push(options);
      fed.push(prompt);
      const queued: SDKMessage[] = [];
      let wake: (() => void) | null = null;
      streams.push((message) => {
        queued.push(message);
        wake?.();
      });
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async (): Promise<IteratorResult<SDKMessage>> => {
              while (queued.length === 0) await new Promise<void>((resolve) => (wake = resolve));
              return { value: queued.shift()!, done: false };
            },
          };
        },
        getContextUsage: async () => {
          const resumed =
            options.resume === undefined
              ? null
              : nativeSessionPath({ sessionId: options.resume, cwd: options.cwd!, env: options.env ?? {} });
          const served = resumed !== null && existsSync(resumed) ? readFileSync(resumed, "utf8").length : 0;
          return { rawMaxTokens: windowTokens, totalTokens: Math.ceil(served / 4) };
        },
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
  streams.length = 0;
  windowTokens = 1_000_000;
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
    expect(logs).toContainEqual(expect.stringMatching(new RegExp(`^rollback to event \\d+ via ${kept}$`)));
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

  test("an anchor whose capture keys span several key pages keeps its last block", async () => {
    const { gen1, threadId } = await seedThread();
    const anchor = randomUUID();
    const blocks = Array.from({ length: 300 }, (_, i) => ({ type: "text", text: `KEEP-BLOCK-${i}-END` }));
    await capture(threadId, "KEEP-PROMPT", [assistantMessage(anchor, blocks)]);
    await captureTurn(threadId, "REMOVED-PROMPT", "REMOVED-ANSWER");

    const { options } = await startSession({ resume: gen1, resumeSessionAt: anchor });

    const projected = projectedText(options);
    expect(projected).toContain("KEEP-BLOCK-299-END");
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

  test("rollback before compact: a kept view past the trigger compacts before the first prompt", async () => {
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

    const { session, logs, options } = await startSession({ resume: gen1, resumeSessionAt: anchors[1] });

    const order = ["rollback to event", "[lhc compact:auto]", "resumed thread"].map((t) =>
      logs.findIndex((line) => line.startsWith(t)),
    );
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order[1]).toBeGreaterThan(order[0]!);
    expect(order[2]).toBeGreaterThan(order[1]!);
    expect(projectedText(options)).toContain("KEEP-ANSWER-1");
    expect(projectedText(options)).toContain("[context ·");
    expect(projectedText(options)).not.toContain("REMOVED");
    expect(projectedText(options)).not.toContain("KEEP-ANSWER-2");

    await session.pushUser(userMessage("/compact"));
    expect(projectedText(opened.at(-1)!)).not.toContain("REMOVED");
    expect(await servedText(threadId)).not.toContain("REMOVED");
  });

  test("a rollback compacts with the pair capped to the live window", async () => {
    const { gen1, threadId } = await seedThread();
    const filler = " filler".repeat(400);
    const anchors: string[] = [];
    for (let i = 0; i < 4; i += 1)
      anchors.push(await captureTurn(threadId, `KEEP-PROMPT-${i}${filler}`, `KEEP-ANSWER-${i}${filler}`));
    await captureTurn(threadId, `REMOVED-PROMPT${filler}`, `REMOVED-ANSWER${filler}`);
    const policy = await threads.setCompactPolicy(ref(threadId), SMALL_COMPACT);
    if (!policy.ok) throw new Error(policy.error.reason);
    windowTokens = 2_000;

    const { logs, options } = await startSession({ resume: gen1, resumeSessionAt: anchors[3] });

    expect(logs).toContain("compact policy capped to window 2000: trigger 1600 target 800");
    expect(logs.find((line) => line.startsWith("[lhc compact:auto]"))).toContain("(target 800)");
    expect(projectedText(options)).not.toContain("REMOVED");
  });

  test("a repeat rollback to an anchor that is already the visible tail writes nothing", async () => {
    const { gen1, threadId } = await seedThread();
    const kept = await captureTurn(threadId, "KEEP-PROMPT", "KEEP-ANSWER");
    await captureTurn(threadId, "REMOVED-PROMPT", "REMOVED-ANSWER");
    const first = await startSession({ resume: gen1, resumeSessionAt: kept });
    await first.session.close();
    const events = await eventKeys(threadId);

    const { logs, options } = await startSession({ resume: gen1, resumeSessionAt: kept });

    expect(logs).toContainEqual(expect.stringMatching(/skipped: the anchor is already the visible tail$/));
    expect(await eventKeys(threadId)).toBe(events);
    expect(projectedText(options)).toContain("KEEP-ANSWER");
    expect(projectedText(options)).not.toContain("REMOVED");
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

describe("capture uuids", () => {
  const capturedUnder = async (threadId: string, uuid: string | undefined): Promise<boolean> => {
    if (uuid === undefined) return false;
    const keys = await lhc().intakeStream.listEventKeysByPrefix(ref(threadId), { prefix: messageKeyPrefix(uuid) });
    return keys.ok && keys.value.keys.length > 0;
  };

  test("a uuid-less prompt and the mid-turn continuation note reach the CLI under the uuid they were captured with", async () => {
    const { session } = await startSession({ sessionId: randomUUID() });
    await session.pushUser(userMessage("WORK-PROMPT"));
    const prompt = await fed[0]![Symbol.asyncIterator]().next();
    expect(await capturedUnder(session.threadId, prompt.value?.uuid)).toBe(true);

    const toolTurn = randomUUID();
    streams[0]!(assistantMessage(toolTurn, [{ type: "tool_use", id: "toolu_mid", name: "Read", input: {} }]));
    await vi.waitFor(async () => expect(await capturedUnder(session.threadId, toolTurn)).toBe(true));
    await session.pushUser(userMessage("/compact"));
    const postToolUse = opened[0]!.hooks!.PostToolUse![0]!.hooks[0]!;
    const stop = await postToolUse(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: {},
        tool_response: "",
        tool_use_id: "toolu_mid",
      } as never,
      "toolu_mid",
      { signal: new AbortController().signal },
    );
    expect(stop).toMatchObject({ continue: false });
    streams[0]!({ ...(resultMessage() as object), terminal_reason: "hook_stopped" } as unknown as SDKMessage);

    await vi.waitFor(() => expect(fed).toHaveLength(2));
    const note = await fed[1]![Symbol.asyncIterator]().next();
    expect(JSON.stringify(note.value)).toContain("Context was compacted in the middle of this turn");
    expect(await capturedUnder(session.threadId, note.value?.uuid)).toBe(true);
  });
});

describe("prompts held during a mid-turn compact", () => {
  type Frame = Record<string, unknown>;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const textOf = (message: SDKUserMessage | undefined): string => {
    const content = message?.message.content;
    return typeof content === "string" ? content : JSON.stringify(content);
  };
  const answer = (text: string): SDKMessage => assistantMessage(randomUUID(), [{ type: "text", text }]);

  async function heldDuringMidTurnCompact(heldTexts: string[], lhcOptions: Record<string, unknown> = {}) {
    const frames: Frame[] = [];
    const timeline: string[] = [];
    const logs: string[] = [];
    let compacts = 0;
    const session: ClaudeLhcSession = new ClaudeLhcSession({
      emit(message): void {
        const frame = message as unknown as Frame;
        frames.push(frame);
        if (frame["type"] === "result") timeline.push(`result ${String(frame["uuid"])}`);
        if (frame["subtype"] === "status" && frame["status"] === "compacting" && compacts++ === 0)
          for (const text of heldTexts) void session.pushUser(userMessage(text));
      },
      request: async () => ({}),
      end(): void {},
      fail(): void {},
      log: (line: string) => logs.push(line),
    });
    await session.start({
      cwd: dir,
      model: "claude-sonnet-5",
      env: { CLAUDE_CONFIG_DIR: claudeHome },
      lhc: { home, compact: COMPACT, ...lhcOptions },
      sessionId: randomUUID(),
    });
    await session.pushUser(userMessage("WORK-PROMPT"));
    const first = fed[0]![Symbol.asyncIterator]();
    await first.next();
    await stopMidTurn(session, frames, 0);
    const cli = fed.length > 1 ? fed.at(-1)![Symbol.asyncIterator]() : first;
    expect(textOf((await cli.next()).value)).toContain("Context was compacted in the middle of this turn");
    const delivered = async (): Promise<SDKUserMessage | undefined> => {
      const next = await cli.next();
      if (!next.done) timeline.push(`claude got ${textOf(next.value)}`);
      return next.done ? undefined : next.value;
    };
    return { session, frames, timeline, logs, cli, delivered };
  }

  async function stopMidTurn(session: ClaudeLhcSession, frames: Frame[], gen: number): Promise<void> {
    const settled = () => frames.filter((frame) => frame["subtype"] === "status" && "compact_result" in frame).length;
    const settledBefore = settled();
    const toolUseId = `toolu_${gen}`;
    const toolTurn = randomUUID();
    streams[gen]!(assistantMessage(toolTurn, [{ type: "tool_use", id: toolUseId, name: "Read", input: {} }]));
    await vi.waitFor(() => expect(frames.some((frame) => frame["uuid"] === toolTurn)).toBe(true));
    await session.pushUser(userMessage("/compact"));
    const postToolUse = opened[gen]!.hooks!.PostToolUse![0]!.hooks[0]!;
    const stop = await postToolUse(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: {},
        tool_response: "",
        tool_use_id: toolUseId,
      } as never,
      toolUseId,
      { signal: new AbortController().signal },
    );
    expect(stop).toMatchObject({ continue: false });
    streams[gen]!({ ...(resultMessage() as object), terminal_reason: "hook_stopped" } as unknown as SDKMessage);
    await vi.waitFor(() => expect(settled()).toBe(settledBefore + 1));
  }

  const stillWaiting = async (next: Promise<unknown>): Promise<boolean> =>
    (await Promise.race([next.then(() => false), sleep(250).then(() => true)])) === true;

  test("the held prompt reaches Claude after the continued turn's result and gets a result of its own", async () => {
    const { timeline, delivered } = await heldDuringMidTurnCompact(["HELD-PROMPT"]);
    const held = delivered();
    expect(await stillWaiting(held)).toBe(true);

    const continued = resultMessage();
    streams[1]!(answer("CONTINUED"));
    streams[1]!(continued);
    expect(textOf(await held)).toBe("HELD-PROMPT");
    const heldAnswered = resultMessage();
    streams[1]!(answer("HELD-ANSWER"));
    streams[1]!(heldAnswered);

    await vi.waitFor(() =>
      expect(timeline).toEqual([
        `result ${String(continued.uuid)}`,
        "claude got HELD-PROMPT",
        `result ${String(heldAnswered.uuid)}`,
      ]),
    );
  });

  test("a prompt sent while held prompts wait queues behind them", async () => {
    const { session, delivered } = await heldDuringMidTurnCompact(["HELD-PROMPT"]);
    await session.pushUser(userMessage("LATER-PROMPT"));
    const first = delivered();
    expect(await stillWaiting(first)).toBe(true);

    streams[1]!(resultMessage());

    expect(textOf(await first)).toBe("HELD-PROMPT");
    expect(textOf(await delivered())).toBe("LATER-PROMPT");
  });

  test("an interrupted continued turn sends the held prompt once, after the interrupted turn's result", async () => {
    const { session, timeline, delivered } = await heldDuringMidTurnCompact(["HELD-PROMPT"]);
    const held = delivered();
    await session.control("interrupt", {});
    expect(await stillWaiting(held)).toBe(true);

    const interrupted = { ...(resultMessage(true) as object), subtype: "error_during_execution" } as SDKMessage;
    streams[1]!(interrupted);

    expect(textOf(await held)).toBe("HELD-PROMPT");
    expect(timeline).toEqual([`result ${String(interrupted.uuid)}`, "claude got HELD-PROMPT"]);
    streams[1]!(resultMessage());
    expect(await stillWaiting(delivered())).toBe(true);
  });

  test("after a failed mid-turn rebuild the held prompt goes once to the old generation, after the continued turn's result", async () => {
    const { timeline, delivered } = await heldDuringMidTurnCompact(["HELD-PROMPT"], { forceRebuildFailure: true });
    expect(fed).toHaveLength(1);
    const held = delivered();
    expect(await stillWaiting(held)).toBe(true);

    const continued = resultMessage();
    streams[0]!(continued);

    expect(textOf(await held)).toBe("HELD-PROMPT");
    expect(timeline).toEqual([`result ${String(continued.uuid)}`, "claude got HELD-PROMPT"]);
    streams[0]!(resultMessage());
    expect(await stillWaiting(delivered())).toBe(true);
  });

  test("a second mid-turn compact keeps the held prompt waiting for the turn it continues", async () => {
    const { session, frames, cli } = await heldDuringMidTurnCompact(["HELD-PROMPT"]);
    await stopMidTurn(session, frames, 1);
    expect((await cli.next()).done).toBe(true);
    const third = fed[2]![Symbol.asyncIterator]();
    expect(textOf((await third.next()).value)).toContain("Context was compacted in the middle of this turn");
    const held = third.next();
    expect(await stillWaiting(held)).toBe(true);

    streams[2]!(resultMessage());

    expect(textOf((await held).value)).toBe("HELD-PROMPT");
    expect(await stillWaiting(third.next())).toBe(true);
  });

  test("closing while a prompt is held sends nothing more and logs the unsent prompt", async () => {
    const { session, logs, delivered } = await heldDuringMidTurnCompact(["HELD-PROMPT"]);

    await session.close();
    streams[1]!(resultMessage());

    expect(await delivered()).toBeUndefined();
    expect(logs).toContain("closing with 1 held prompt(s) never sent");
  });

  test("a /compact with no open turn sends the held prompt as soon as the compact ends", async () => {
    const results: Frame[] = [];
    const session: ClaudeLhcSession = new ClaudeLhcSession({
      emit(message): void {
        const frame = message as unknown as Frame;
        if (frame["type"] === "result") results.push(frame);
        if (frame["subtype"] === "status" && frame["status"] === "compacting")
          void session.pushUser(userMessage("HELD-PROMPT"));
      },
      request: async () => ({}),
      end(): void {},
      fail(): void {},
      log(): void {},
    });
    await session.start({
      cwd: dir,
      model: "claude-sonnet-5",
      env: { CLAUDE_CONFIG_DIR: claudeHome },
      lhc: { home, compact: COMPACT },
      sessionId: randomUUID(),
    });

    await session.pushUser(userMessage("/compact"));

    expect(results).toHaveLength(1);
    const cli = fed.at(-1)![Symbol.asyncIterator]();
    expect(textOf((await cli.next()).value)).toBe("HELD-PROMPT");
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
