import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { captureTurn } from "./support/seedThread.ts";

const opened: Options[] = [];

// Writes each prompt and reply to the native transcript under the uuid it streams, as the CLI does.
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  const { nativeSessionPath } = await import("../src/nativeSessionFile.ts");
  return {
    ...real,
    renameSession: async () => {},
    query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      opened.push(options);
      const sessionId = options.resume ?? options.sessionId ?? randomUUID();
      const path = nativeSessionPath({ sessionId, cwd: options.cwd!, env: options.env ?? {} });
      let parentUuid = existsSync(path)
        ? (readFileSync(path, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { uuid?: string })
            .findLast((line) => typeof line.uuid === "string")?.uuid ?? null)
        : null;
      const write = (type: "user" | "assistant", uuid: string, content: unknown): void => {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(
          path,
          `${JSON.stringify({ parentUuid, isSidechain: false, type, uuid, sessionId, message: { role: type, content } })}\n`,
        );
        parentUuid = uuid;
      };
      const out: SDKMessage[] = [];
      let wake: (() => void) | null = null;
      const push = (message: SDKMessage): void => {
        out.push(message);
        wake?.();
      };
      void (async () => {
        for await (const user of prompt) {
          const text = JSON.stringify(user.message.content);
          write("user", user.uuid!, user.message.content);
          const reply = randomUUID();
          const content = [{ type: "text", text: `echo ${text}` }];
          write("assistant", reply, content);
          push({
            type: "assistant",
            uuid: reply,
            session_id: sessionId,
            parent_tool_use_id: null,
            message: { id: `msg_${reply}`, model: "claude-sonnet-5", role: "assistant", content },
          } as unknown as SDKMessage);
          push({
            type: "result",
            subtype: "success",
            is_error: false,
            uuid: randomUUID(),
            session_id: sessionId,
          } as unknown as SDKMessage);
        }
      })();
      return {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<SDKMessage>> => {
            while (out.length === 0) await new Promise<void>((resolve) => (wake = resolve));
            return { value: out.shift() as SDKMessage, done: false };
          },
        }),
        getContextUsage: async () => ({ rawMaxTokens: 1_000_000, totalTokens: 0 }),
        close: () => {},
      };
    },
  };
});

const { forkSession } = await import("../src/index.ts");
const { ClaudeLhcSession } = await import("../src/session.ts");
const { currentSession } = await import("../src/lhcHome.ts");
const { nativeProjectDir, nativeSessionPath } = await import("../src/nativeSessionFile.ts");

let dir = "";
let home = "";
let cwd = "";
const saved = { config: process.env.CLAUDE_CONFIG_DIR, noInference: process.env.CLAUDE_LHC_NO_INFERENCE };
beforeEach(() => {
  opened.length = 0;
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-reopen-"));
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

const COMPACT = { trigger: 500_000, target: 180_000 };
const transcript = (sessionId: string) => nativeSessionPath({ sessionId, cwd, env: process.env });
const transcripts = () => readdirSync(nativeProjectDir({ cwd, env: process.env })).filter((f) => f.endsWith(".jsonl"));

async function open(options: Record<string, unknown>, compact = COMPACT) {
  const logs: string[] = [];
  const frames: SDKMessage[] = [];
  const session = new ClaudeLhcSession({
    emit: (message) => frames.push(message),
    request: async () => ({}),
    end(): void {},
    fail(reason): void {
      throw new Error(reason);
    },
    log: (line) => logs.push(line),
  });
  await session.start({ cwd, model: "claude-sonnet-5", env: { ...process.env }, lhc: { home, compact }, ...options });
  return { session, logs, frames, generation: opened.at(-1)!.resume ?? opened.at(-1)!.sessionId! };
}

type Opened = Awaited<ReturnType<typeof open>>;

async function turn({ session, frames }: Opened, text: string): Promise<string> {
  const results = frames.filter((frame) => frame.type === "result").length;
  await session.pushUser({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  });
  await vi.waitFor(() => expect(frames.filter((frame) => frame.type === "result")).toHaveLength(results + 1));
  return frames.findLast((frame) => frame.type === "assistant")!.uuid!;
}

async function threadWithTurns(
  texts: string[],
  compact = COMPACT,
): Promise<{ gen1: string; threadId: string; replies: string[] }> {
  const gen1 = randomUUID();
  const first = await open({ sessionId: gen1 }, compact);
  const replies: string[] = [];
  for (const text of texts) replies.push(await turn(first, text));
  await first.session.close();
  return { gen1, threadId: first.session.threadId, replies };
}

describe("a reopen keeps the current generation's session id", () => {
  test("a thread restarted twice with no compact opens on one session id all three times", async () => {
    const { gen1 } = await threadWithTurns(["ONE"]);

    const second = await open({ resume: gen1 });
    await turn(second, "TWO");
    await second.session.close();
    const third = await open({ resume: gen1 });
    await third.session.close();

    expect([second.generation, third.generation]).toEqual([gen1, gen1]);
    expect(opened.slice(1).map((options) => options.resume)).toEqual([gen1, gen1]);
    expect(third.logs).toContain(`generation ${gen1}: kept, its native transcript holds the 4 served messages`);
    expect(transcripts()).toEqual([`${gen1}.jsonl`]);
    expect(await currentSession(gen1, home)).toBe(gen1);
  });

  test("a compact mints a new id, and the next reopen keeps that one, also through the old alias", async () => {
    const { gen1 } = await threadWithTurns(["ONE"]);
    const live = await open({ resume: gen1 });
    await live.session.pushUser({
      type: "user",
      message: { role: "user", content: "/compact" },
      parent_tool_use_id: null,
      session_id: "",
    });
    const boundary = live.frames.find((frame) => frame.type === "system" && frame.subtype === "compact_boundary");
    await turn(live, "AFTER-COMPACT");
    await live.session.close();

    const reopened = await open({ resume: gen1 });
    await reopened.session.close();

    expect(boundary?.session_id).toBeDefined();
    expect(boundary?.session_id).not.toBe(gen1);
    expect(reopened.generation).toBe(boundary?.session_id);
    expect(reopened.logs).toContainEqual(expect.stringMatching(`^generation ${boundary?.session_id}: kept,`));
  });

  test("a compact whose view opens with summary bands is kept on the next reopen", async () => {
    const small = { trigger: 2_000, target: 1_000 };
    const { gen1 } = await threadWithTurns(
      Array.from({ length: 8 }, (_, i) => `TURN-${i}${" filler".repeat(400)}`),
      small,
    );
    const live = await open({ resume: gen1 });
    await live.session.pushUser({
      type: "user",
      message: { role: "user", content: "/compact" },
      parent_tool_use_id: null,
      session_id: "",
    });
    const compacted = live.frames.find((frame) => frame.type === "system" && frame.subtype === "compact_boundary")!;
    await live.session.close();

    const reopened = await open({ resume: compacted.session_id });
    await reopened.session.close();

    expect(readFileSync(transcript(compacted.session_id), "utf8")).toContain("[context · ");
    expect(reopened.generation).toBe(compacted.session_id);
  });

  test("a rollback mints a new id whose transcript ends at the kept turn", async () => {
    const { gen1, replies } = await threadWithTurns(["KEEP", "REMOVED"]);

    const rolled = await open({ resume: gen1, resumeSessionAt: replies[0] });
    await rolled.session.close();

    expect(rolled.generation).not.toBe(gen1);
    expect(rolled.logs).toContain(
      `generation ${gen1}: not kept, its native transcript differs from the served view at message 3 (4 held, 2 served)`,
    );
    const projected = readFileSync(transcript(rolled.generation), "utf8");
    expect(projected).toContain("KEEP");
    expect(projected).not.toContain("REMOVED");
  });

  test("a fork mints a new id, and reopening the fork or its source keeps each one's own", async () => {
    const { gen1 } = await threadWithTurns(["ONE"]);

    const fork = await forkSession(gen1, { lhc: { home } });
    const forkReopened = await open({ resume: fork.sessionId });
    await forkReopened.session.close();
    const sourceReopened = await open({ resume: gen1 });
    await sourceReopened.session.close();

    expect(fork.sessionId).not.toBe(gen1);
    expect(forkReopened.generation).toBe(fork.sessionId);
    expect(sourceReopened.generation).toBe(gen1);
  });

  test("a missing native transcript falls back to a fresh projection", async () => {
    const { gen1 } = await threadWithTurns(["ONE"]);
    rmSync(transcript(gen1));

    const reopened = await open({ resume: gen1 });
    await reopened.session.close();

    expect(reopened.generation).not.toBe(gen1);
    expect(reopened.logs).toContain(`generation ${gen1}: not kept, it has no native transcript`);
    expect(readFileSync(transcript(reopened.generation), "utf8")).toContain("ONE");
  });

  test("a message the transcript lacks, or one LHC never captured, mints a new id", async () => {
    const { gen1, threadId } = await threadWithTurns(["ONE"]);
    await captureTurn(home, threadId, "CAPTURED-ONLY", "CAPTURED-ONLY-ANSWER");
    const lacking = await open({ resume: gen1 });
    await lacking.session.close();

    const leaf = readFileSync(transcript(lacking.generation), "utf8").trim().split("\n").at(-1)!;
    appendFileSync(
      transcript(lacking.generation),
      `${JSON.stringify({ parentUuid: JSON.parse(leaf).uuid, isSidechain: false, type: "assistant", uuid: randomUUID(), message: { role: "assistant", content: [{ type: "text", text: "UNCAPTURED" }] } })}\n`,
    );
    const extra = await open({ resume: gen1 });
    await extra.session.close();

    expect(lacking.generation).not.toBe(gen1);
    expect(readFileSync(transcript(lacking.generation), "utf8")).toContain("CAPTURED-ONLY-ANSWER");
    expect(extra.generation).not.toBe(lacking.generation);
    expect(readFileSync(transcript(extra.generation), "utf8")).not.toContain("UNCAPTURED");
  });
});
