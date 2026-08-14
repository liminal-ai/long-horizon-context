import { describe, expect, it } from "vitest";

import {
  atOrAboveUpper,
  buildPressureReceipt,
  estimateTokensFromCapturedBytes,
  normalizePostMeasurementEstimate,
  providerContextFromUsage,
} from "../../src/governor/provider-context.js";

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

  it("uses the Claude 2.1.228 usage triad without double-counting diagnostics", () => {
    const ctx = providerContextFromUsage({
      input_tokens: 210_000,
      cache_creation_input_tokens: 25_000,
      cache_read_input_tokens: 85_000,
      output_tokens: 12_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 20_000,
        ephemeral_1h_input_tokens: 5_000,
      },
      iterations: [{ input_tokens: 999_999 }],
      output_tokens_details: { text_tokens: 12_000 },
    });
    expect(ctx).toEqual({
      inputTokens: 210_000,
      cacheCreationInputTokens: 25_000,
      cacheReadInputTokens: 85_000,
      total: 320_000,
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

describe("buildPressureReceipt / post-measurement estimate", () => {
  it("adds source-labelled estimate without double-counting into provider base", () => {
    const provider = providerContextFromUsage({
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
    });
    const pressure = buildPressureReceipt(
      provider,
      { tokens: 15, source: "lhc_token_estimate", domain: "source_labelled_estimate" },
      200,
    );
    expect(pressure.providerBaseTokens).toBe(150);
    expect(pressure.providerBaseDomain).toBe("provider_reported_input");
    expect(pressure.estimateTokens).toBe(15);
    expect(pressure.estimateSource).toBe("lhc_token_estimate");
    expect(pressure.estimateDomain).toBe("source_labelled_estimate");
    expect(pressure.nextRequestPressureTokens).toBe(165);
    expect(pressure.atOrAboveTrigger).toBe(false);
  });

  it("estimate can push next-request pressure across the trigger", () => {
    const provider = providerContextFromUsage({ input_tokens: 190 });
    const pressure = buildPressureReceipt(
      provider,
      { tokens: 20, source: "host_byte_estimate", domain: "source_labelled_estimate" },
      200,
    );
    expect(pressure.nextRequestPressureTokens).toBe(210);
    expect(pressure.atOrAboveTrigger).toBe(true);
  });

  it("missing provider clears pressure authority even when estimate is present", () => {
    const pressure = buildPressureReceipt(
      null,
      { tokens: 50_000, source: "lhc_token_estimate", domain: "source_labelled_estimate" },
      360_000,
    );
    expect(pressure.providerBaseTokens).toBeNull();
    expect(pressure.nextRequestPressureTokens).toBeNull();
    expect(pressure.atOrAboveTrigger).toBeNull();
    expect(pressure.estimateTokens).toBe(50_000);
  });

  it("normalizePostMeasurementEstimate fails closed on invalid tokens", () => {
    expect(
      normalizePostMeasurementEstimate({
        tokens: -1,
        source: "x",
        domain: "source_labelled_estimate",
      }).tokens,
    ).toBe(0);
    expect(normalizePostMeasurementEstimate(null).domain).toBe("source_labelled_estimate");
  });

  it("estimateTokensFromCapturedBytes is source-labelled and roughly 4 bytes/token", () => {
    const est = estimateTokensFromCapturedBytes(400);
    expect(est.tokens).toBe(100);
    expect(est.source).toBe("host_byte_estimate");
    expect(est.domain).toBe("source_labelled_estimate");
  });
});
