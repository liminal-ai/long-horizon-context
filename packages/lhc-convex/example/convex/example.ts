import { createFunctionHandle } from "convex/server";
import { v } from "convex/values";
import { initLhc, type ModelCallHandle } from "@liminal/lhc-convex";
import { components, internal } from "./_generated/api";
import { action, type ActionCtx } from "./_generated/server";

async function configuredLhc(ctx: ActionCtx) {
  const call = (await createFunctionHandle(internal.fakeModel.call)) as ModelCallHandle;
  return initLhc(components.lhc, ctx, {
    componentInstanceId: "example",
    mode: "background",
    inference: {
      call,
      assignments: {
        smoothed_prompt: { provider: "openai", model: "gpt-5.4-mini", prompt: "smoothing-v1" },
        tool_result_summary: { provider: "openai", model: "gpt-5.4-mini", prompt: "tool-result-v2" },
        detailed_turn_compression: {
          provider: "openai",
          model: "gpt-5.4-mini",
          prompt: "detailed-turn-compression-v3",
        },
        chunk_summary_brief: { provider: "openai", model: "gpt-5.4-mini", prompt: "chunk-brief-v3" },
      },
    },
  });
}

export const createThread = action({
  args: { alias: v.string() },
  handler: async (ctx, args) => (await configuredLhc(ctx)).threads.newThread({ filePath: args.alias }),
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
