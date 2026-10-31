import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ClaudeLhcSession } from "../src/session.ts";

interface Generation {
  input: AsyncIterator<SDKUserMessage>;
  emit(message: SDKMessage): void;
}

const generations: Generation[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    renameSession: async () => {},
    query: ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
      const queued: SDKMessage[] = [];
      let wake: (() => void) | null = null;
      generations.push({
        input: prompt[Symbol.asyncIterator](),
        emit(message) {
          queued.push(message);
          wake?.();
        },
      });
      return {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<SDKMessage>> => {
            while (queued.length === 0) await new Promise<void>((resolve) => (wake = resolve));
            return { value: queued.shift() as SDKMessage, done: false };
          },
        }),
        getContextUsage: async () => ({ rawMaxTokens: 1_000_000, totalTokens: 0 }),
        close: () => {},
      };
    },
  };
});

let dir = "";
const savedNoInference = process.env.CLAUDE_LHC_NO_INFERENCE;
beforeEach(() => {
  generations.length = 0;
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-swap-order-"));
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
const lifecycle = (uuid: string | undefined, state: string): SDKMessage =>
  ({
    type: "command_lifecycle",
    command_uuid: uuid,
    state,
    uuid: randomUUID(),
    session_id: "",
  }) as unknown as SDKMessage;

const result = (text: string): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    uuid: randomUUID(),
    session_id: "",
  }) as unknown as SDKMessage;

test("an automatic compact waits until the CLI holds no prompt it has not started", async () => {
  const results: string[] = [];
  const session = new ClaudeLhcSession({
    emit(message: SDKMessage): void {
      if (message.type === "result") results.push(String((message as unknown as { result: unknown }).result));
    },
    request: async () => ({}),
    end(): void {},
    fail(message: string): void {
      throw new Error(message);
    },
    log(): void {},
  });
  await session.start({
    cwd: dir,
    model: "claude-sonnet-5",
    env: { CLAUDE_CONFIG_DIR: join(dir, "claude") },
    lhc: { home: join(dir, "lhc"), compact: { trigger: 2_000, target: 1_000 } },
  });
  for (const text of ["A", "B", "C"]) await session.pushUser(user(text));
  const first = generations[0] as Generation;
  const a = (await first.input.next()).value as SDKUserMessage;
  first.emit(lifecycle(a.uuid, "queued"));
  first.emit(lifecycle(a.uuid, "started"));
  const b = (await first.input.next()).value as SDKUserMessage;
  first.emit(lifecycle(b.uuid, "queued"));
  first.emit({
    type: "assistant",
    uuid: randomUUID(),
    session_id: "",
    parent_tool_use_id: null,
    message: {
      id: `msg_${randomUUID()}`,
      model: "claude-sonnet-5",
      role: "assistant",
      content: [{ type: "text", text: "answer A" }],
      usage: { input_tokens: 5_000, output_tokens: 1 },
    },
  } as unknown as SDKMessage);
  first.emit(result("answer A"));
  await vi.waitFor(() => expect(results).toEqual(["answer A"]));
  expect(generations).toHaveLength(1);

  first.emit(lifecycle(b.uuid, "started"));
  first.emit(result("answer B"));
  const c = (await first.input.next()).value as SDKUserMessage;
  expect([a, b, c].map((m) => m.message.content)).toEqual(["A", "B", "C"]);
  first.emit(lifecycle(c.uuid, "queued"));
  first.emit(lifecycle(c.uuid, "started"));
  first.emit(result("answer C"));

  await vi.waitFor(() => expect(generations).toHaveLength(2), { timeout: 10_000 });
  expect(results).toEqual(["answer A", "answer B", "answer C"]);
  await session.close();
});
