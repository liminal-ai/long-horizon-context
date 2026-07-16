import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// A real ModelCall host: the component hands us provider/model/messages and
// expects a single-turn completion back. provider and model are routing keys
// the host interprets — here, anything but "openai" is a configuration error.
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

type Failure = {
  ok: false;
  kind: "rate_limit" | "timeout" | "network" | "other" | "auth" | "invalid_request";
  message: string;
};

function classify(status: number, body: string): Failure {
  if (status === 401 || status === 403) return { ok: false, kind: "auth", message: body };
  if (status === 429) return { ok: false, kind: "rate_limit", message: body };
  if (status === 400 || status === 404 || status === 422) return { ok: false, kind: "invalid_request", message: body };
  return { ok: false, kind: "other", message: `http ${status}: ${body}` };
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
    if (input.provider !== "openai") {
      return { ok: false as const, kind: "invalid_request" as const, message: `unknown provider ${input.provider}` };
    }
    const key = process.env["OPENAI_API_KEY"];
    if (key === undefined || key === "") {
      return { ok: false as const, kind: "auth" as const, message: "OPENAI_API_KEY is not set" };
    }

    try {
      const response = await fetch(OPENAI_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
        }),
      });
      if (!response.ok) return classify(response.status, (await response.text()).slice(0, 400));

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.trim() === "") {
        // The adapter turns empty output into its own failure class; report it
        // as a plain miss rather than inventing text.
        return { ok: false as const, kind: "other" as const, message: "model returned no text" };
      }
      return { ok: true as const, text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false as const, kind: "network" as const, message };
    }
  },
});
