import type { ModelCallFailureKind, ModelCallInput } from "lhc";
import { describe, expect, it } from "vitest";
import { fakeModelCallFailure, fakeModelCallRouter, fakeModelCallText } from "./model-call.js";

const INPUT: ModelCallInput = {
  provider: "openai-codex",
  model: "gpt-5.4",
  messages: [{ role: "user", content: "hi" }],
};

describe("model-call fakes", () => {
  it("fakeModelCallText resolves to ok + text", async () => {
    const result = await fakeModelCallText("hello")(INPUT);
    expect(result).toEqual({ ok: true, text: "hello" });
  });

  it("fakeModelCallFailure resolves to each classified failure kind", async () => {
    const kinds: ModelCallFailureKind[] = ["auth", "invalid_request", "rate_limit", "timeout", "network", "other"];
    for (const kind of kinds) {
      const result = await fakeModelCallFailure(kind)(INPUT);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe(kind);
    }
  });

  it("fakeModelCallRouter routes by provider/model and fails closed on an unrouted key", async () => {
    const router = fakeModelCallRouter({
      "openai-codex/gpt-5.4": fakeModelCallText("from openai-codex"),
      "anthropic/claude-3": fakeModelCallText("from anthropic"),
    });
    expect(await router(INPUT)).toEqual({ ok: true, text: "from openai-codex" });
    expect(await router({ ...INPUT, provider: "anthropic", model: "claude-3" })).toEqual({
      ok: true,
      text: "from anthropic",
    });
    const missing = await router({ ...INPUT, provider: "unknown", model: "x" });
    expect(missing.ok).toBe(false); // never a silent success
  });
});
