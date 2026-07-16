import { v } from "convex/values";
import { internalAction } from "../../convex/_generated/server.js";

const scriptCalls = new Map<string, number>();

// Capture of every model call this fake host receives, in call order. The
// routing keys (provider, model, thinking) and rendered messages are the only
// facts a test can observe about how the component reached the host, so a
// suite that needs the frozen recordingCall's log reads this array. Module
// state is shared with the test process because convex-test runs the action
// in-process against the same module registry.
export interface CapturedModelCall {
  provider: string;
  model: string;
  thinking?: "none" | "minimal" | "medium" | "high";
  messages: Array<{ role: "system" | "user"; content: string }>;
}

export const capturedCalls: CapturedModelCall[] = [];

export function resetCapturedCalls(): void {
  capturedCalls.length = 0;
}

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
    thinking: v.optional(v.union(v.literal("none"), v.literal("minimal"), v.literal("medium"), v.literal("high"))),
  },
  handler: async (_ctx, args) => {
    capturedCalls.push({
      provider: args.provider,
      model: args.model,
      ...(args.thinking === undefined ? {} : { thinking: args.thinking }),
      messages: args.messages,
    });
    if (args.model === "fail") return { ok: false as const, kind: "other" as const, message: "scripted failure" };
    if (args.model.startsWith("failure:")) {
      const [, kind = "other", ...messageParts] = args.model.split(":");
      return {
        ok: false as const,
        kind: kind as "rate_limit" | "timeout" | "network" | "other" | "auth" | "invalid_request",
        message: messageParts.join(":"),
      };
    }
    if (args.model.startsWith("script:")) {
      const [, kind = "other", key = args.model] = args.model.split(":");
      const calls = (scriptCalls.get(key) ?? 0) + 1;
      scriptCalls.set(key, calls);
      if (calls === 1) {
        return {
          ok: false as const,
          kind: kind as "rate_limit" | "timeout" | "network" | "other" | "auth" | "invalid_request",
          message: `scripted ${kind} failure`,
        };
      }
      return { ok: true as const, text: `unexpected second call for ${key}` };
    }
    if (args.model.startsWith("throw:")) throw new Error(args.model.slice("throw:".length));
    if (args.model === "hang") return await new Promise<never>(() => {});
    if (args.model.startsWith("success:")) {
      return { ok: true as const, text: args.model.slice("success:".length) };
    }
    if (args.model === "whitespace") return { ok: true as const, text: "  \n\t  " };
    const kind = args.model.startsWith("model-") ? args.model.slice("model-".length) : args.model;
    return { ok: true as const, text: `canned ${kind} text from the fake host` };
  },
});
