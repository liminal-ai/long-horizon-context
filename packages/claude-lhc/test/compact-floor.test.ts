import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ClaudeLhcSession } from "../src/session.ts";

interface Generation {
  options: Options;
  input: AsyncIterator<SDKUserMessage>;
  emit(message: SDKMessage): void;
}

const generations: Generation[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    renameSession: async () => {},
    query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const out: SDKMessage[] = [];
      let wake: (() => void) | null = null;
      generations.push({
        options,
        input: prompt[Symbol.asyncIterator](),
        emit(message) {
          out.push(message);
          wake?.();
        },
      });
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

let dir = "";
const savedNoInference = process.env.CLAUDE_LHC_NO_INFERENCE;
beforeEach(() => {
  generations.length = 0;
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-compact-floor-"));
  process.env.CLAUDE_LHC_NO_INFERENCE = "1";
});
afterEach(() => {
  if (savedNoInference === undefined) delete process.env.CLAUDE_LHC_NO_INFERENCE;
  else process.env.CLAUDE_LHC_NO_INFERENCE = savedNoInference;
  rmSync(dir, { recursive: true, force: true });
});

test("a rebuilt view that is still past the trigger compacts again only after new context", async () => {
  const seen = new Set<string>();
  const logs: string[] = [];
  const session = new ClaudeLhcSession({
    emit: (message) => seen.add((message as { uuid?: string }).uuid ?? ""),
    request: async () => ({}),
    end(): void {},
    fail(message: string): void {
      throw new Error(message);
    },
    log: (line) => logs.push(line),
  });
  await session.start({
    cwd: dir,
    model: "claude-sonnet-5",
    env: { CLAUDE_CONFIG_DIR: join(dir, "claude") },
    lhc: { home: join(dir, "lhc"), compact: { trigger: 1_000, target: 500 } },
  });
  await session.pushUser({ type: "user", message: { role: "user", content: "WORK" }, parent_tool_use_id: null });

  const boundary = async (gen: Generation, contextTokens: number): Promise<boolean> => {
    const toolUseId = `toolu_${randomUUID()}`;
    const reply = {
      type: "assistant",
      uuid: randomUUID(),
      session_id: "",
      parent_tool_use_id: null,
      message: {
        id: `msg_${randomUUID()}`,
        model: "claude-sonnet-5",
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "Read", input: {} }],
        usage: { input_tokens: contextTokens, output_tokens: 10 },
      },
    } as unknown as SDKMessage;
    gen.emit(reply);
    await vi.waitFor(() => expect(seen.has((reply as { uuid: string }).uuid)).toBe(true));
    const hook = gen.options.hooks?.PostToolUse?.[0]?.hooks[0] as HookCallback;
    const answer = await hook(
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
    return (answer as { continue?: boolean }).continue !== false;
  };
  const compactMidTurn = async (gen: Generation): Promise<Generation> => {
    gen.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      terminal_reason: "hook_stopped",
      uuid: randomUUID(),
      session_id: "",
    } as unknown as SDKMessage);
    await vi.waitFor(() => expect(generations).toHaveLength(generations.indexOf(gen) + 2), { timeout: 10_000 });
    return generations.at(-1) as Generation;
  };

  const first = generations[0] as Generation;
  await first.input.next();
  expect(await boundary(first, 36_000)).toBe(false);
  const second = await compactMidTurn(first);

  expect(await boundary(second, 36_400)).toBe(true);
  expect(logs.some((line) => line.includes("waits for new context"))).toBe(true);
  expect(await boundary(second, 36_900)).toBe(false);
  await session.close();
});
