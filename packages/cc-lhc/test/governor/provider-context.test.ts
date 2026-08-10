import { describe, expect, it } from "vitest";

import { atOrAboveUpper, providerContextFromUsage } from "../../src/governor/provider-context.js";

describe("providerContextFromUsage", () => {
  it("sums input + cache_creation + cache_read", () => {
    const ctx = providerContextFromUsage({
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 999,
    });
    expect(ctx).toEqual({
      inputTokens: 100,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 30,
      total: 150,
    });
  });

  it("treats absent cache fields as zero when input present", () => {
    const ctx = providerContextFromUsage({ input_tokens: 50 });
    expect(ctx?.total).toBe(50);
    expect(ctx?.cacheCreationInputTokens).toBe(0);
    expect(ctx?.cacheReadInputTokens).toBe(0);
  });

  it("returns null without input_tokens authority", () => {
    expect(providerContextFromUsage({})).toBeNull();
    expect(providerContextFromUsage({ output_tokens: 1 })).toBeNull();
    expect(providerContextFromUsage(null)).toBeNull();
    expect(providerContextFromUsage(undefined)).toBeNull();
  });

  it("rejects invalid numbers (NaN, Infinity, non-integer, negative, unsafe)", () => {
    expect(providerContextFromUsage({ input_tokens: Number.NaN })).toBeNull();
    expect(providerContextFromUsage({ input_tokens: Number.POSITIVE_INFINITY })).toBeNull();
    expect(providerContextFromUsage({ input_tokens: 1.5 })).toBeNull();
    expect(providerContextFromUsage({ input_tokens: -1 })).toBeNull();
    expect(providerContextFromUsage({ input_tokens: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(
      providerContextFromUsage({
        input_tokens: 1,
        cache_creation_input_tokens: -2,
      }),
    ).toBeNull();
  });

  it("exact threshold and one-below", () => {
    expect(atOrAboveUpper(500_000, 500_000)).toBe(true);
    expect(atOrAboveUpper(499_999, 500_000)).toBe(false);
  });

  it("accepts large safe integers", () => {
    const n = Number.MAX_SAFE_INTEGER - 10;
    const ctx = providerContextFromUsage({ input_tokens: n });
    expect(ctx?.total).toBe(n);
  });
});
