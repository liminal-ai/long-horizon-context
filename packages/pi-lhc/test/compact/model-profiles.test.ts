import { describe, expect, it } from "vitest";
import {
  AUTO_COMPACT_RETRY_GROWTH_TOKENS,
  CompactSettingsValidationError,
  DEFAULT_MODEL_COMPACT_SETTINGS,
  FALLBACK_COMPACT_SETTINGS,
  loadModelCompactSettings,
  resolveModelCompactSettings,
  shouldTriggerModelCompact,
  toCompactParams,
} from "../../src/compact/model-profiles.js";

describe("resolveModelCompactSettings", () => {
  it("matches shipped models by substring, case-insensitive", () => {
    expect(resolveModelCompactSettings("claude-fable-5")).toMatchObject({
      triggerTokens: 400_000,
      lowerBound: 200_000,
    });
    expect(resolveModelCompactSettings("GLM-5.2")).toMatchObject({ triggerTokens: 350_000, lowerBound: 140_000 });
    expect(resolveModelCompactSettings("grok-4.5")).toMatchObject({ triggerTokens: 300_000, lowerBound: 100_000 });
    // sol ships without a connector trigger: PI's native threshold
    // (272k − 16,384 ≈ 255.6k) already sits at the intended trigger point,
    // and a connector trigger at the same point double-fires and races it.
    const sol = resolveModelCompactSettings("gpt-5.6-sol");
    expect(sol.triggerTokens).toBeUndefined();
    expect(sol.lowerBound).toBe(120_000);
  });

  it("falls back to the default profile with no trigger for unmatched or missing models", () => {
    for (const modelId of ["gpt-5.4-mini", undefined, ""]) {
      const resolved = resolveModelCompactSettings(modelId);
      expect(resolved).toBe(FALLBACK_COMPACT_SETTINGS);
      expect(resolved.triggerTokens).toBeUndefined();
      expect(resolved.lowerBound).toBe(120_000);
    }
  });

  it("first match wins in table order", () => {
    const table = loadModelCompactSettings([
      { match: "sol", lowerBound: 90_000 },
      { match: "gpt", lowerBound: 80_000 },
    ]);
    expect(resolveModelCompactSettings("gpt-5.6-sol", table).lowerBound).toBe(90_000);
    expect(resolveModelCompactSettings("gpt-4o", table).lowerBound).toBe(80_000);
  });

  it("toCompactParams carries lowerBound and percentages only", () => {
    const params = toCompactParams(resolveModelCompactSettings("claude-fable-5"));
    expect(params).toEqual({
      lowerBound: 200_000,
      percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 },
    });
  });
});

describe("loadModelCompactSettings", () => {
  it("undefined config returns shipped defaults", () => {
    expect(loadModelCompactSettings(undefined)).toBe(DEFAULT_MODEL_COMPACT_SETTINGS);
  });

  it("fails loud on unknown keys — the Hermes workspace_id lesson", () => {
    expect(() => loadModelCompactSettings([{ match: "x", lowerBound: 100_000, trigger: 1 }])).toThrow(
      CompactSettingsValidationError,
    );
  });

  it("fails loud on band percentages not summing to 100", () => {
    expect(() =>
      loadModelCompactSettings([
        { match: "x", lowerBound: 100_000, percentages: { full: 50, smooth: 30, detailed: 15, brief: 10 } },
      ]),
    ).toThrow(/sum to 100/);
  });

  it("fails loud when triggerTokens does not exceed lowerBound", () => {
    expect(() => loadModelCompactSettings([{ match: "x", lowerBound: 100_000, triggerTokens: 90_000 }])).toThrow(
      /must exceed lowerBound/,
    );
  });

  it("accepts entries without percentages (defaulted) and without trigger", () => {
    const table = loadModelCompactSettings([{ match: "custom", lowerBound: 60_000 }]);
    expect(table[0]).toMatchObject({
      match: "custom",
      lowerBound: 60_000,
      percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 },
    });
    expect(table[0]?.triggerTokens).toBeUndefined();
  });
});

describe("shouldTriggerModelCompact", () => {
  const base = {
    triggerTokens: 350_000,
    inFlight: false,
    lastAttemptTokens: null,
  };

  it("triggers at or above the threshold", () => {
    expect(shouldTriggerModelCompact({ ...base, contextTokens: 350_000 })).toBe(true);
    expect(shouldTriggerModelCompact({ ...base, contextTokens: 400_000 })).toBe(true);
  });

  it("does not trigger below the threshold, with unknown tokens, or without a trigger", () => {
    expect(shouldTriggerModelCompact({ ...base, contextTokens: 349_999 })).toBe(false);
    expect(shouldTriggerModelCompact({ ...base, contextTokens: null })).toBe(false);
    expect(shouldTriggerModelCompact({ ...base, contextTokens: undefined })).toBe(false);
    expect(shouldTriggerModelCompact({ ...base, contextTokens: 400_000, triggerTokens: undefined })).toBe(false);
  });

  it("does not trigger while a triggered compact is in flight", () => {
    expect(shouldTriggerModelCompact({ ...base, contextTokens: 400_000, inFlight: true })).toBe(false);
  });

  it("after a failed attempt, retriggers only after real growth", () => {
    const lastAttemptTokens = 360_000;
    expect(shouldTriggerModelCompact({ ...base, contextTokens: 360_000, lastAttemptTokens })).toBe(false);
    expect(
      shouldTriggerModelCompact({
        ...base,
        contextTokens: 360_000 + AUTO_COMPACT_RETRY_GROWTH_TOKENS - 1,
        lastAttemptTokens,
      }),
    ).toBe(false);
    expect(
      shouldTriggerModelCompact({
        ...base,
        contextTokens: 360_000 + AUTO_COMPACT_RETRY_GROWTH_TOKENS,
        lastAttemptTokens,
      }),
    ).toBe(true);
  });
});
