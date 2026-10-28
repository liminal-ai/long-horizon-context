import { describe, expect, it } from "vitest";
import { estimateTokens, o200k } from "./fixtures/tokens.js";

describe("token counting with literal special-token text", () => {
  const hostile = "before <|endoftext|> after <|fim_prefix|> tail";

  it("estimate counts instead of throwing", () => {
    expect(estimateTokens(hostile)).toBeGreaterThan(0);
  });

  it("sliceTokens slices and reassembles byte-identically", () => {
    const total = estimateTokens(hostile);
    const a = o200k.sliceTokens(hostile, 0, 3);
    const b = o200k.sliceTokens(hostile, a.toToken, total - a.toToken);
    expect(a.totalTokens).toBe(total);
    expect(a.text + b.text).toBe(hostile);
  });
});
