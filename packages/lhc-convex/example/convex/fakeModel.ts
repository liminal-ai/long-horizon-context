import { v } from "convex/values";
import { internalAction } from "./_generated/server";

export const call = internalAction({
  args: {
    provider: v.string(),
    model: v.string(),
    messages: v.array(
      v.object({
        role: v.union(v.literal("system"), v.literal("user")),
        content: v.string(),
      }),
    ),
    thinking: v.optional(
      v.union(v.literal("none"), v.literal("minimal"), v.literal("medium"), v.literal("high")),
    ),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), text: v.string() }),
    v.object({
      ok: v.literal(false),
      kind: v.union(
        v.literal("rate_limit"),
        v.literal("timeout"),
        v.literal("network"),
        v.literal("other"),
        v.literal("auth"),
        v.literal("invalid_request"),
      ),
      message: v.string(),
    }),
  ),
  handler: async (_ctx, input) => {
    const user = [...input.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    return { ok: true as const, text: `fake:${user.slice(0, 240)}` };
  },
});
