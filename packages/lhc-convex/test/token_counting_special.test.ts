import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/shared/token_counting/index.js";
import { serviceFixture, validEvent } from "./fixtures/index.js";

// Captured text is data: literal special-token strings must count and intake,
// never throw. Mirrors packages/lhc test/token-counting-special.test.ts at the
// contract pin (TS f274cea; regression for the capture-path panic found
// 2026-08-08 when a transcript contained "<|endoftext|>").
// The frozen sliceTokens leg lands with convex-wave S5 (bounded retrieval
// formatting), which introduces the port's sliceTokens.
describe("token counting with literal special-token text", () => {
  const hostile = "before <|endoftext|> after <|fim_prefix|> tail";

  it("estimateTokens counts instead of throwing", () => {
    expect(estimateTokens(hostile)).toBeGreaterThan(0);
  });

  it("intake captures special-token text and stamps a token estimate (capture must be total)", async () => {
    const fixture = serviceFixture();
    const { filePath } = await fixture.createThread();
    const result = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: hostile } }),
    ]);
    expect(result.ok).toBe(true);
    const listed = await fixture.sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const prompt = listed.value.find((m) => m.kind === "user_prompt");
    expect(prompt).toBeDefined();
    expect(prompt?.tokenEstimate ?? 0).toBeGreaterThan(0);
  });
});
