/// <reference types="vite/client" />

import type { GenericSchema, SchemaDefinition } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";
import { api } from "../../convex/_generated/api.js";
import schema from "../../convex/schema.js";
import {
  type EventKind,
  initLhc,
  type Lhc,
  type LhcExecutor,
  type MessageEventInput,
  type ModelCallHandle,
  type SdkConfig,
} from "../../src/client/index.js";

export const modules = {
  ...import.meta.glob("../../convex/**/*.ts"),
  "../../convex/test_model.ts": () => import("../convex/model.js"),
};
export const dummyModelCall = "test_model:call" as ModelCallHandle;

export type ConvexHarness = TestConvex<SchemaDefinition<GenericSchema, boolean>>;
export type EventByKind<K extends EventKind> = Extract<MessageEventInput, { eventKind: K }>;

const defaultPayloads: { [K in EventKind]: () => EventByKind<K>["payload"] } = {
  user_prompt: () => ({ text: "please read the file" }),
  assistant_text: () => ({ text: "here is what I found" }),
  assistant_thinking: () => ({ text: "considering the file contents" }),
  runtime_note: () => ({ text: "harness restarted mid-turn" }),
  model_change: () => ({ previousModel: "gpt-5", newModel: "gpt-5.1" }),
  thinking_level_change: () => ({ previousLevel: "medium", newLevel: "high" }),
  tool_call: () => ({
    toolCallId: "call-1",
    toolName: "read_file",
    arguments: { path: "notes.txt" },
  }),
  tool_result: () => ({
    toolCallId: "call-1",
    content: "contents of notes.txt",
    isError: false,
  }),
  turn_end: () => ({}),
};

let keyCounter = 0;

export function validEvent<K extends EventKind>(
  kind: K,
  overrides: Partial<Omit<EventByKind<K>, "eventKind">> = {},
): EventByKind<K> {
  keyCounter += 1;
  return {
    eventKind: kind,
    idempotencyKey: `convex-fixture-key-${keyCounter}`,
    actor: "fixture-actor",
    harness: "fixture-harness",
    payload: defaultPayloads[kind](),
    ...overrides,
  } as unknown as EventByKind<K>;
}

export function eventBatch(kinds: readonly EventKind[]): MessageEventInput[] {
  return kinds.map((kind) => validEvent(kind));
}

export function conversationTurn(): MessageEventInput[] {
  return eventBatch(["user_prompt", "assistant_text", "tool_call", "tool_result", "turn_end"]);
}

export function executor(test: ConvexHarness): LhcExecutor {
  return {
    runQuery: ((reference: Parameters<ConvexHarness["query"]>[0], args: unknown) =>
      test.query(reference, args as never)) as LhcExecutor["runQuery"],
    runMutation: ((reference: Parameters<ConvexHarness["mutation"]>[0], args: unknown) =>
      test.mutation(reference, args as never)) as LhcExecutor["runMutation"],
    runAction: ((reference: Parameters<ConvexHarness["action"]>[0], args: unknown) =>
      test.action(reference, args as never)) as LhcExecutor["runAction"],
  };
}

export interface ServiceFixture {
  test: ConvexHarness;
  sdk: Lhc;
  instance: string;
  createThread(
    alias?: string,
    input?: { title?: string; cwd?: string },
  ): Promise<{ threadId: string; filePath: string }>;
}

export interface DerivedThreadFixture extends ServiceFixture {
  filePath: string;
  threadId: string;
  turnIds: string[];
}

interface ServiceFixtureOptions extends Partial<Omit<SdkConfig, "componentInstanceId" | "inference">> {
  models?: Partial<
    Record<"smoothed_prompt" | "tool_result_summary" | "detailed_turn_compression" | "chunk_summary_brief", string>
  >;
  inference?: { timeoutMs?: number; maxInputChars?: number };
}

let fixtureCounter = 0;

export function serviceFixture(overrides: ServiceFixtureOptions = {}): ServiceFixture {
  fixtureCounter += 1;
  const test = convexTest(schema, modules);
  const instance = `service-fixture-${fixtureCounter}`;
  const sdk = initLhc(api, executor(test), {
    componentInstanceId: instance,
    mode: overrides.mode ?? "manual",
    inference: {
      call: dummyModelCall,
      ...(overrides.inference?.timeoutMs === undefined ? {} : { timeoutMs: overrides.inference.timeoutMs }),
      ...(overrides.inference?.maxInputChars === undefined ? {} : { maxInputChars: overrides.inference.maxInputChars }),
      assignments: {
        smoothed_prompt: {
          provider: "test",
          model: overrides.models?.smoothed_prompt ?? "model-smoothed_prompt",
          prompt: "smoothing-v1",
        },
        tool_result_summary: {
          provider: "test",
          model: overrides.models?.tool_result_summary ?? "model-tool_result_summary",
          prompt: "tool-result-v2",
        },
        detailed_turn_compression: {
          provider: "test",
          model: overrides.models?.detailed_turn_compression ?? "model-detailed_turn_compression",
          prompt: "detailed-turn-compression-v3",
        },
        chunk_summary_brief: {
          provider: "test",
          model: overrides.models?.chunk_summary_brief ?? "model-chunk_summary_brief",
          prompt: "chunk-brief-v3",
        },
      },
    },
    ...(overrides.guards === undefined ? {} : { guards: overrides.guards }),
    ...(overrides.toolResult === undefined ? {} : { toolResult: overrides.toolResult }),
    ...(overrides.chunkPolicy === undefined ? {} : { chunkPolicy: overrides.chunkPolicy }),
    ...(overrides.view === undefined ? {} : { view: overrides.view }),
  });
  let threadCounter = 0;
  return {
    test,
    sdk,
    instance,
    async createThread(alias, input = {}) {
      threadCounter += 1;
      const filePath = alias ?? `thread-${threadCounter}`;
      const created = await sdk.threads.newThread({ filePath, ...input });
      if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
      return created.value;
    },
  };
}

const TOOL_HEAVY_TURNS = new Set([5, 6, 7, 8]);

function derivedTurnEvents(turn: number): MessageEventInput[] {
  const events: MessageEventInput[] = [
    validEvent("user_prompt", { payload: { text: `turn ${turn}: please investigate area ${turn}` } }),
    validEvent("assistant_thinking", { payload: { text: `considering what area ${turn} contains` } }),
  ];
  if (TOOL_HEAVY_TURNS.has(turn)) {
    for (const run of [1, 2]) {
      const toolCallId = `call-fx-${turn}-${run}`;
      events.push(
        validEvent("tool_call", {
          payload: { toolCallId, toolName: "read_file", arguments: { path: `area-${turn}/file-${run}.txt` } },
        }),
        validEvent("tool_result", {
          payload: {
            toolCallId,
            content: `contents of area-${turn}/file-${run}.txt: detail ${turn}.${run} with enough text to summarize`,
            isError: false,
          },
        }),
      );
    }
  }
  events.push(validEvent("assistant_text", { payload: { text: `findings for area ${turn}` } }), validEvent("turn_end"));
  return events;
}

// Optional overrides let a caller bake a non-default view config (e.g. a low
// compactThreshold) or host mode into the committed derived corpus without
// re-deriving it by hand — the frozen suite overlays those at read time via a
// second SDK, which the per-instance Convex config cannot do.
export async function derivedThreadFixture(
  overrides: Pick<ServiceFixtureOptions, "view" | "mode"> = {},
): Promise<DerivedThreadFixture> {
  const fixture = serviceFixture({
    models: { smoothed_prompt: `success:${"smoothed ".repeat(8).trim()}` },
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
    chunkPolicy: { targetProjectedTokens: 90, maxProjectedTokens: 4_400 },
    toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
    ...(overrides.view === undefined ? {} : { view: overrides.view }),
    ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
  });
  const { filePath, threadId } = await fixture.createThread();
  for (let turn = 1; turn <= 12; turn += 1) {
    const accepted = await fixture.sdk.intakeStream.messageEvents({ filePath }, derivedTurnEvents(turn));
    if (!accepted.ok) throw new Error(`derived fixture intake failed: ${accepted.error.reason}`);
    const drained = await fixture.sdk.work.drain({ filePath });
    if (!drained.ok || drained.value.remaining !== 0) throw new Error("derived fixture drain did not settle");
  }
  const chunks = await fixture.sdk.turns.listChunks({ filePath });
  if (!chunks.ok) throw new Error(chunks.error.reason);
  if (chunks.value.length !== 4 || chunks.value.filter((chunk) => chunk.status === "closed").length !== 3) {
    throw new Error(
      `derived fixture chunk policy no longer produces three closed chunks and one open chunk: ${JSON.stringify(
        chunks.value.map(({ chunkId, status, accumulatedProjectedTokens, memberTurnIds }) => ({
          chunkId,
          status,
          accumulatedProjectedTokens,
          memberTurnIds,
        })),
      )}`,
    );
  }
  return { ...fixture, filePath, threadId, turnIds: Array.from({ length: 12 }, (_, index) => `t${index + 1}`) };
}
