import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACT_PROFILE } from "../../src/compact/profile.js";

describe("DEFAULT_COMPACT_PROFILE", () => {
  it("uses integer band percentages that sum to 100 with a positive lowerBound", () => {
    const { percentages, lowerBound } = DEFAULT_COMPACT_PROFILE;
    expect(lowerBound).toBeGreaterThan(0);
    expect(percentages.full + percentages.smooth + percentages.detailed + percentages.brief).toBe(100);
    for (const share of Object.values(percentages)) {
      expect(Number.isInteger(share)).toBe(true);
      expect(share).toBeGreaterThan(0);
    }
  });
});
