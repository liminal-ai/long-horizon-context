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

const modules = {
  ...import.meta.glob("../../convex/**/*.ts"),
  "../../convex/test_model.ts": () => import("../convex/model.js"),
};
const dummyModelCall = "test_model:call" as ModelCallHandle;

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

function executor(test: ConvexHarness): LhcExecutor {
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
