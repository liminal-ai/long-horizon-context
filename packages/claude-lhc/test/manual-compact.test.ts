import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-manual-compact-"));
  process.env.CLAUDE_LHC_NO_INFERENCE = "1";
});
afterEach(() => {
  if (savedNoInference === undefined) delete process.env.CLAUDE_LHC_NO_INFERENCE;
  else process.env.CLAUDE_LHC_NO_INFERENCE = savedNoInference;
  rmSync(dir, { recursive: true, force: true });
});

type Frame = Record<string, unknown>;
type StockCase = "success" | "failed" | "queued" | "empty";

const stockLines = readFileSync(new URL("./fixtures/stock-compact.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { case: StockCase; sent?: { text: string; uuid: string }[]; frame?: Frame });

function stock(name: StockCase): { sent: { text: string; uuid: string }[]; frames: Frame[] } {
  const lines = stockLines.filter((line) => line.case === name);
  return {
    sent: lines.find((line) => line.sent !== undefined)?.sent ?? [],
    frames: lines.flatMap((line) => (line.frame === undefined ? [] : [line.frame])),
  };
}

const COMPACT_ERROR_PREFIX = "Error during compaction: ";

const UNCOMPARED_FIELDS = new Map([
  ["uuid", "fresh for every frame"],
  ["session_id", "a generation id; the success case checks that the boundary and result name the new generation"],
  ["duration_ms", "wall time"],
  ["logical_parent_uuid", "links a stock boundary to the message before it; a projected generation has none"],
  ["total_cost_usd", "stock bills its summary call to the result; claude-lhc's summary workers run outside the CLI"],
  ["usage", "as total_cost_usd"],
  ["modelUsage", "as total_cost_usd"],
  ["model_usage_since_last_result", "as total_cost_usd"],
  ["fast_mode_state", "CLI session telemetry that claude-lhc does not synthesize"],
  ["fast_mode_disabled_reason", "as fast_mode_state"],
  ["subagent_stats", "as fast_mode_state"],
  ["safety_stops", "as fast_mode_state"],
  ["queued_turn_count", "CLI result counters; a host pairs a result with its input by user_message_uuids"],
  ["result_index", "as queued_turn_count"],
]);
const UNCOMPARED_COMPACT_METADATA = new Map([
  ["pre_tokens", "measured"],
  ["post_tokens", "measured"],
  ["duration_ms", "wall time"],
  ["cumulative_dropped_tokens", "claude-lhc does not report it"],
]);

function compactSettlementFields(
  frames: readonly Frame[],
  labels: ReadonlyMap<string, string>,
  compactUuid: string,
): Frame[] {
  const label = (uuid: unknown): unknown => (typeof uuid === "string" ? (labels.get(uuid) ?? "<unknown>") : uuid);
  const maskErrorReason = (text: unknown): unknown =>
    typeof text === "string" && text.startsWith(COMPACT_ERROR_PREFIX) ? `${COMPACT_ERROR_PREFIX}<reason>` : text;
  const compared = (fields: Frame, skip: ReadonlyMap<string, string>): Frame =>
    Object.fromEntries(Object.entries(fields).filter(([key]) => !skip.has(key)));
  const settlement = (frame: Frame): Frame => {
    const fields = compared(frame, UNCOMPARED_FIELDS);
    for (const key of ["command_uuid", "user_message_uuid"]) if (key in fields) fields[key] = label(fields[key]);
    if (Array.isArray(fields["user_message_uuids"]))
      fields["user_message_uuids"] = fields["user_message_uuids"].map(label);
    if ("compact_error" in fields) fields["compact_error"] = "<reason>";
    if ("result" in fields) fields["result"] = maskErrorReason(fields["result"]);
    if ("compact_metadata" in fields)
      fields["compact_metadata"] = compared(fields["compact_metadata"] as Frame, UNCOMPARED_COMPACT_METADATA);
    return fields;
  };
  return frames.flatMap((frame): Frame[] => {
    if (frame["type"] === "command_lifecycle") return frame["command_uuid"] === compactUuid ? [settlement(frame)] : [];
    if (frame["type"] === "system" && (frame["subtype"] === "status" || frame["subtype"] === "compact_boundary"))
      return [settlement(frame)];
    if (frame["type"] !== "result") return [];
    if (frame["local_command"] !== "compact") return [{ type: "result", answers: label(frame["user_message_uuid"]) }];
    return [settlement(frame)];
  });
}

function stockSettlement(name: StockCase): Frame[] {
  const { sent, frames } = stock(name);
  const compact = sent.find((input) => input.text === "/compact");
  if (compact === undefined) throw new Error(`stock case ${name} sent no /compact`);
  return compactSettlementFields(frames, new Map(sent.map((input) => [input.uuid, input.text])), compact.uuid);
}

const user = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  uuid: randomUUID(),
});

function answer(gen: Generation, prompt: SDKUserMessage): void {
  gen.emit({
    type: "command_lifecycle",
    command_uuid: prompt.uuid,
    state: "started",
    uuid: randomUUID(),
    session_id: "",
  } as unknown as SDKMessage);
  gen.emit({
    type: "assistant",
    uuid: randomUUID(),
    session_id: "",
    parent_tool_use_id: null,
    message: {
      id: `msg_${randomUUID()}`,
      model: "claude-sonnet-5",
      role: "assistant",
      content: [{ type: "text", text: `echo ${String(prompt.message.content)}` }],
    },
  } as unknown as SDKMessage);
  gen.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `echo ${String(prompt.message.content)}`,
    user_message_uuid: prompt.uuid,
    user_message_uuids: [prompt.uuid],
    uuid: randomUUID(),
    session_id: "",
  } as unknown as SDKMessage);
  gen.emit({
    type: "command_lifecycle",
    command_uuid: prompt.uuid,
    state: "completed",
    uuid: randomUUID(),
    session_id: "",
  } as unknown as SDKMessage);
}

async function openSession(lhc: Record<string, unknown> = {}): Promise<{ session: ClaudeLhcSession; frames: Frame[] }> {
  const frames: Frame[] = [];
  const session = new ClaudeLhcSession({
    emit: (message) => frames.push(message as unknown as Frame),
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
    lhc: { home: join(dir, "lhc"), compact: { trigger: 500_000, target: 180_000 }, ...lhc },
  });
  return { session, frames };
}

const results = (frames: readonly Frame[]): Frame[] => frames.filter((frame) => frame["type"] === "result");

test("an idle /compact settles like stock: lifecycle around it and a result carrying its uuid", async () => {
  const { session, frames } = await openSession();
  const prompt = user("Reply with exactly the word ALPHA and nothing else.");
  const compact = user("/compact");
  await session.pushUser(prompt);
  const first = generations[0] as Generation;
  await first.input.next();
  answer(first, prompt);
  await vi.waitFor(() => expect(results(frames)).toHaveLength(1));
  await session.pushUser(compact);
  await vi.waitFor(() => expect(results(frames)).toHaveLength(2), { timeout: 10_000 });

  const labels = new Map([
    [prompt.uuid as string, String(prompt.message.content)],
    [compact.uuid as string, "/compact"],
  ]);
  expect(compactSettlementFields(frames, labels, compact.uuid as string)).toEqual(stockSettlement("success"));
  const boundary = frames.find((frame) => frame["subtype"] === "compact_boundary");
  expect(boundary?.["session_id"]).toBe(generations[1]?.options.resume ?? generations[1]?.options.sessionId);
  expect(results(frames)[1]?.["session_id"]).toBe(boundary?.["session_id"]);
  await session.close();
});

test("a failed rebuild settles like a failed stock compact, with the error as the result text", async () => {
  const { session, frames } = await openSession({ forceRebuildFailure: true });
  const prompt = user("Reply with exactly the word ALPHA and nothing else.");
  const compact = user("/compact");
  await session.pushUser(prompt);
  const first = generations[0] as Generation;
  await first.input.next();
  answer(first, prompt);
  await vi.waitFor(() => expect(results(frames)).toHaveLength(1));
  await session.pushUser(compact);
  await vi.waitFor(() => expect(results(frames)).toHaveLength(2), { timeout: 10_000 });

  const labels = new Map([
    [prompt.uuid as string, String(prompt.message.content)],
    [compact.uuid as string, "/compact"],
  ]);
  expect(compactSettlementFields(frames, labels, compact.uuid as string)).toEqual(stockSettlement("failed"));
  expect(generations).toHaveLength(1);
  await session.close();
});

test("a /compact on a session with no turns settles like stock, plus the rebuild frames stock skips", async () => {
  const { session, frames } = await openSession();
  const compact = user("/compact");
  await session.pushUser(compact);
  await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ type: "command_lifecycle", state: "completed" }), {
    timeout: 10_000,
  });

  const settled = compactSettlementFields(
    frames,
    new Map([[compact.uuid as string, "/compact"]]),
    compact.uuid as string,
  );
  const completedAfterStockCaptureEnded = settled.pop();
  const rebuild = (frame: Frame): boolean => frame["subtype"] === "status" || frame["subtype"] === "compact_boundary";
  expect(settled.filter((frame) => !rebuild(frame))).toEqual(stockSettlement("empty"));
  expect(settled.filter(rebuild)).toEqual([
    { type: "system", subtype: "status", status: "compacting" },
    { type: "system", subtype: "status", status: null, compact_result: "success" },
    { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } },
  ]);
  expect(completedAfterStockCaptureEnded).toEqual({
    type: "command_lifecycle",
    command_uuid: "/compact",
    state: "completed",
  });
  await session.close();
});

test("a /compact queued behind a running prompt settles in input order, before the prompt after it", async () => {
  const { session, frames } = await openSession();
  const alpha = user("Reply with exactly the word ALPHA and nothing else.");
  const compact = user("/compact");
  const bravo = user("Reply with exactly the word BRAVO and nothing else.");
  await session.pushUser(alpha);
  await session.pushUser(compact);
  await session.pushUser(bravo);
  const first = generations[0] as Generation;
  await first.input.next();
  answer(first, alpha);
  await vi.waitFor(() => expect(generations).toHaveLength(2), { timeout: 10_000 });
  const second = generations[1] as Generation;
  const sent = (await second.input.next()).value as SDKUserMessage;
  expect(sent.uuid).toBe(bravo.uuid);
  answer(second, bravo);
  await vi.waitFor(() => expect(results(frames)).toHaveLength(3));

  const labels = new Map(
    [alpha, compact, bravo].map((input) => [input.uuid as string, String(input.message.content)] as const),
  );
  expect(compactSettlementFields(frames, labels, compact.uuid as string)).toEqual(stockSettlement("queued"));
  await session.close();
});

test("a mid-turn automatic compact still settles the outer turn with one result and no compact lifecycle", async () => {
  const { session, frames } = await openSession({ compact: { trigger: 1_000, target: 500 } });
  const work = user("WORK");
  await session.pushUser(work);
  const first = generations[0] as Generation;
  await first.input.next();
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
      usage: { input_tokens: 36_000, output_tokens: 10 },
    },
  } as unknown as SDKMessage;
  first.emit(reply);
  await vi.waitFor(() => expect(frames.some((frame) => frame["uuid"] === (reply as { uuid: string }).uuid)).toBe(true));
  const hook = first.options.hooks?.PostToolUse?.[0]?.hooks[0] as HookCallback;
  const decision = await hook(
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
  expect((decision as { continue?: boolean }).continue).toBe(false);
  first.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    terminal_reason: "hook_stopped",
    uuid: randomUUID(),
    session_id: "",
  } as unknown as SDKMessage);
  await vi.waitFor(() => expect(generations).toHaveLength(2), { timeout: 10_000 });
  const second = generations[1] as Generation;
  await second.input.next();
  second.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    uuid: randomUUID(),
    session_id: "",
  } as unknown as SDKMessage);
  await vi.waitFor(() => expect(results(frames)).toHaveLength(1));

  expect(frames.filter((frame) => frame["subtype"] === "compact_boundary")).toHaveLength(1);
  expect(results(frames)[0]).toMatchObject({ result: "done" });
  expect(results(frames)[0]?.["local_command"]).toBeUndefined();
  expect(frames.filter((frame) => frame["type"] === "command_lifecycle")).toEqual([]);
  await session.close();
});
