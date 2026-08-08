import { describe, expect, it } from "vitest";
import { estimateTokens, sliceTokens } from "../src/shared-tech/token-counting/index.js";

// Captured text is data: literal special-token strings must count and slice,
// never throw. Regression for the capture-path panic found 2026-08-08 when a
// transcript contained "<|endoftext|>" (grok fork, vendored lhc-rs — the rs
// panic faithfully ported this TS throw).
describe("token counting with literal special-token text", () => {
  const hostile = "before <|endoftext|> after <|fim_prefix|> tail";

  it("estimateTokens counts instead of throwing", () => {
    expect(estimateTokens(hostile)).toBeGreaterThan(0);
  });

  it("sliceTokens slices and reassembles byte-identically", () => {
    const total = estimateTokens(hostile);
    const a = sliceTokens(hostile, 0, 3);
    const b = sliceTokens(hostile, a.toToken, total - a.toToken);
    expect(a.totalTokens).toBe(total);
    expect(a.text + b.text).toBe(hostile);
  });
});
