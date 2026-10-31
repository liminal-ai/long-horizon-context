import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ClaudeLhcSession } from "../src/session.ts";

interface Generation {
  options: Options;
  queued: SDKUserMessage[];
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
      const gen: Generation = {
        options,
        queued: [],
        emit(message) {
          out.push(message);
          wake?.();
        },
      };
      generations.push(gen);
      void (async () => {
        for await (const message of prompt) {
          gen.queued.push(message);
          gen.emit(lifecycle(message.uuid, "queued"));
        }
      })();
      return {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<SDKMessage>> => {
            while (out.length === 0) await new Promise<void>((resolve) => (wake = resolve));
            return { value: out.shift() as SDKMessage, done: false };
          },
        }),
        getContextUsage: async () => ({ rawMaxTokens: WINDOW, totalTokens: 0 }),
        close: () => {},
      };
    },
  };
});

const WINDOW = 200_000;
const TRIGGER = 0.8 * WINDOW;
const FIRST_REQUEST = 130_000;
const TOOL_RESULT = 50_000;
const TOOL_STEPS = 8;

let dir = "";
const savedNoInference = process.env.CLAUDE_LHC_NO_INFERENCE;
beforeEach(() => {
  generations.length = 0;
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-steer-headroom-"));
  process.env.CLAUDE_LHC_NO_INFERENCE = "1";
});
afterEach(() => {
  if (savedNoInference === undefined) delete process.env.CLAUDE_LHC_NO_INFERENCE;
  else process.env.CLAUDE_LHC_NO_INFERENCE = savedNoInference;
  rmSync(dir, { recursive: true, force: true });
});

const lifecycle = (uuid: string | undefined, state: string): SDKMessage =>
  ({
    type: "command_lifecycle",
    command_uuid: uuid,
    state,
    uuid: randomUUID(),
    session_id: "",
  }) as unknown as SDKMessage;

const user = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

async function requestsUntilStop(steerAt: (step: number) => boolean): Promise<number[]> {
  const seen = new Set<string>();
  const session = new ClaudeLhcSession({
    emit: (message) => seen.add((message as { uuid?: string }).uuid ?? ""),
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
    lhc: { home: join(dir, "lhc"), compact: { trigger: 190_000, target: 100_000 } },
  });
  const gen = generations.at(-1) as Generation;
  await session.pushUser(user("WORK"));
  await vi.waitFor(() => expect(gen.queued).toHaveLength(1));
  const work = gen.queued.shift() as SDKUserMessage;
  gen.emit(lifecycle(work.uuid, "started"));

  const requests: number[] = [];
  let context = FIRST_REQUEST;
  for (let step = 0; step < TOOL_STEPS; step++) {
    requests.push(context);
    const toolUseId = `toolu_${step}`;
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
        usage: { input_tokens: context, output_tokens: 10 },
      },
    } as unknown as SDKMessage;
    gen.emit(reply);
    await vi.waitFor(() => expect(seen.has((reply as { uuid: string }).uuid)).toBe(true));
    if (steerAt(step)) {
      await session.pushUser(user(`STEER-${step}`));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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
    if ((answer as { continue?: boolean }).continue === false) break;
    const started = gen.queued.splice(0);
    for (const steer of started) gen.emit(lifecycle(steer.uuid, "started"));
    if (started.length > 0) await new Promise((resolve) => setTimeout(resolve, 20));
    context += TOOL_RESULT;
  }
  await session.close();
  return requests;
}

test("a steer the CLI has not started delays the automatic compact by at most one more request", async () => {
  const quiet = await requestsUntilStop(() => false);
  const crossing = quiet.findIndex((tokens) => tokens >= TRIGGER);
  const once = await requestsUntilStop((step) => step === crossing);
  const always = await requestsUntilStop(() => true);
  if (process.env.HEADROOM_REPORT !== undefined)
    writeFileSync(
      process.env.HEADROOM_REPORT,
      `${JSON.stringify({ window: WINDOW, trigger: TRIGGER, toolResult: TOOL_RESULT, quiet, once, always }, null, 2)}\n`,
    );

  expect(Math.max(...quiet)).toBe(FIRST_REQUEST + TOOL_RESULT);
  expect(Math.max(...once)).toBe(FIRST_REQUEST + 2 * TOOL_RESULT);
  expect(always).toEqual(once);
});
