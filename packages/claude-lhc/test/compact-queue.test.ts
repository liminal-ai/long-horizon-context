import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ClaudeLhcSession } from "../src/session.ts";

const streams: Array<(message: SDKMessage) => void> = [];
const pulled: string[][] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    renameSession: async () => {},
    query: ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
      const texts: string[] = [];
      pulled.push(texts);
      void (async () => {
        for await (const message of prompt) texts.push(String(message.message.content));
      })();
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
              return { value: queued.shift() as SDKMessage, done: false };
            },
          };
        },
        getContextUsage: async () => ({ rawMaxTokens: 1_000_000, totalTokens: 0 }),
        interrupt: async () => {},
        close: () => {},
      };
    },
  };
});

let dir = "";
const savedNoInference = process.env.CLAUDE_LHC_NO_INFERENCE;
beforeEach(() => {
  streams.length = 0;
  pulled.length = 0;
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-compact-queue-"));
  process.env.CLAUDE_LHC_NO_INFERENCE = "1";
});
afterEach(() => {
  if (savedNoInference === undefined) delete process.env.CLAUDE_LHC_NO_INFERENCE;
  else process.env.CLAUDE_LHC_NO_INFERENCE = savedNoInference;
  rmSync(dir, { recursive: true, force: true });
});

const user = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});
const assistant = (text: string): SDKMessage =>
  ({
    type: "assistant",
    uuid: randomUUID(),
    parent_tool_use_id: null,
    session_id: "",
    message: {
      id: `msg_${randomUUID()}`,
      model: "claude-sonnet-5",
      role: "assistant",
      content: [{ type: "text", text }],
    },
  }) as unknown as SDKMessage;
const result = (): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    uuid: randomUUID(),
    session_id: "",
  }) as unknown as SDKMessage;

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a /compact sent while a compact runs does not strand the prompts after it", async () => {
  let ended = false;
  const later: Promise<void>[] = [];
  let session: ClaudeLhcSession;
  const io = {
    emit(message: SDKMessage): void {
      const status = message as unknown as { subtype?: string; status?: string };
      if (status.subtype === "status" && status.status === "compacting" && later.length === 0)
        later.push(session.pushUser(user("/compact")), session.pushUser(user("two")));
    },
    request: async () => ({}),
    end(): void {
      ended = true;
    },
    fail(message: string): void {
      throw new Error(message);
    },
    log(): void {},
  };
  session = new ClaudeLhcSession(io);
  await session.start({
    cwd: dir,
    model: "claude-sonnet-5",
    env: { CLAUDE_CONFIG_DIR: join(dir, "claude") },
    lhc: { home: join(dir, "lhc"), compact: { trigger: 500_000, target: 180_000 } },
  });
  await session.pushUser(user("one"));
  await session.pushUser(user("/compact"));
  await until(() => pulled[0]?.includes("one") === true, "the first prompt to reach the CLI");
  streams[0]?.(assistant("echo one"));
  streams[0]?.(result());
  await until(() => later.length > 0, "the first compact to start");
  await Promise.all(later);
  session.endInput();

  await until(
    () => pulled.some((texts) => texts.includes("two")),
    "the prompt sent after the second /compact to reach a generation",
  );
  const live = streams.length - 1;
  streams[live]?.(assistant("echo two"));
  streams[live]?.(result());
  await until(() => ended, "the finished input to end the sidecar");
  await session.close();
});
