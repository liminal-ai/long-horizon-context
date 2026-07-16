import { createFunctionHandle } from "convex/server";
import { v } from "convex/values";
import { initLhc, type ModelCallHandle } from "@liminal/lhc-convex";
import { components, internal } from "./_generated/api";
import { action, type ActionCtx } from "./_generated/server";

// The host picks which ModelCall it hands the component: the canned fake, or a
// real OpenAI call. Same handle contract either way.
async function configuredLhc(ctx: ActionCtx, host: "fake" | "openai" = "fake", model = "gpt-5.4-mini") {
  const target = host === "openai" ? internal.openaiModel.call : internal.fakeModel.call;
  const call = (await createFunctionHandle(target)) as ModelCallHandle;
  return initLhc(components.lhc, ctx, {
    componentInstanceId: host === "openai" ? `example-openai-${model}` : "example",
    mode: "background",
    // The fake host caps its summaries at 240 chars, so the shipped defaults
    // (2200/4400) would need dozens of turns to close a chunk. These thresholds
    // close one every few turns so the chunk and compaction paths exercise.
    chunkPolicy: { targetProjectedTokens: 200, maxProjectedTokens: 400 },
    inference: {
      call,
      assignments: {
        smoothed_prompt: { provider: "openai", model, prompt: "smoothing-v1" },
        tool_result_summary: { provider: "openai", model, prompt: "tool-result-v2" },
        detailed_turn_compression: { provider: "openai", model, prompt: "detailed-turn-compression-v3" },
        chunk_summary_brief: { provider: "openai", model, prompt: "chunk-brief-v3" },
      },
    },
  });
}

const hostArgs = {
  host: v.optional(v.union(v.literal("fake"), v.literal("openai"))),
  model: v.optional(v.string()),
};

export const createThread = action({
  args: { alias: v.string(), ...hostArgs },
  handler: async (ctx, args) =>
    (await configuredLhc(ctx, args.host, args.model)).threads.newThread({ filePath: args.alias }),
});

export const appendPrompt = action({
  args: { threadId: v.string(), text: v.string() },
  handler: async (ctx, args) =>
    (await configuredLhc(ctx)).intakeStream.messageEvents(
      { threadId: args.threadId },
      [
        {
          eventKind: "user_prompt",
          idempotencyKey: `example:${args.threadId}:${Date.now()}`,
          actor: "example-user",
          harness: "example",
          payload: { text: args.text },
        },
      ],
    ),
});

export const context = action({
  args: { threadId: v.string() },
  handler: async (ctx, args) =>
    (await configuredLhc(ctx)).threadView.getLlmRequestContext({ threadId: args.threadId }),
});

// Observability for driving the host against a live backend: whether the
// scheduled drain is pending and what the queue and derived forms look like.
export const status = action({
  args: { threadId: v.string(), ...hostArgs },
  handler: async (ctx, args) => {
    const lhc = await configuredLhc(ctx, args.host, args.model);
    const ref = { threadId: args.threadId };
    const [work, overview, health] = await Promise.all([
      lhc.work.status(ref),
      lhc.inspect.overview(ref),
      lhc.inspect.health(ref),
    ]);
    return { work, overview, health };
  },
});

export const compact = action({
  args: { threadId: v.string(), lowerBound: v.optional(v.number()) },
  handler: async (ctx, args) =>
    (await configuredLhc(ctx)).threadView.compact(
      { threadId: args.threadId },
      args.lowerBound === undefined ? undefined : { params: { lowerBound: args.lowerBound } },
    ),
});

export const appendTurn = action({
  args: { threadId: v.string(), text: v.string(), reply: v.string(), ...hostArgs },
  handler: async (ctx, args) => {
    const stamp = Date.now();
    return (await configuredLhc(ctx, args.host, args.model)).intakeStream.messageEvents({ threadId: args.threadId }, [
      {
        eventKind: "user_prompt",
        idempotencyKey: `example:${args.threadId}:${stamp}:prompt`,
        actor: "example-user",
        harness: "example",
        payload: { text: args.text },
      },
      {
        eventKind: "assistant_text",
        idempotencyKey: `example:${args.threadId}:${stamp}:reply`,
        actor: "example-assistant",
        harness: "example",
        payload: { text: args.reply },
      },
      {
        eventKind: "turn_end",
        idempotencyKey: `example:${args.threadId}:${stamp}:end`,
        actor: "example-assistant",
        harness: "example",
        payload: {},
      },
    ]);
  },
});

export const forms = action({
  args: { threadId: v.string(), chunkId: v.optional(v.string()), ...hostArgs },
  handler: async (ctx, args) => {
    const lhc = await configuredLhc(ctx, args.host, args.model);
    const ref = { threadId: args.threadId };
    const [messages, turns] = await Promise.all([
      lhc.messages.report(ref),
      args.chunkId === undefined ? lhc.turns.report(ref) : lhc.turns.report(ref, { chunkId: args.chunkId }),
    ]);
    return { messages, turns };
  },
});
