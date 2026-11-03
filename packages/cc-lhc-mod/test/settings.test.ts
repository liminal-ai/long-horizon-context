import { describe, expect, it } from "vitest";
import { computePolicy, DEFAULT_SETTINGS, resolveSettings } from "../src/settings.ts";

const engineThreshold = (window: number, pct: number): number => Math.floor(((window - 20_000) * pct) / 100);

describe("computePolicy", () => {
  it("gives 800k / 140k on a 1M window", () => {
    const { policy, notices } = computePolicy(resolveSettings({}), 1_000_000);
    expect(policy).toEqual({
      window: 1_000_000,
      trigger: 800_000,
      target: 140_000,
      pct: 81.63265306122449,
      isClamped: false,
    });
    expect(notices).toEqual([]);
  });

  it("clamps the trigger to the engine's cap on a 200k window", () => {
    const { policy } = computePolicy(resolveSettings({}), 200_000);
    expect(policy).toMatchObject({ trigger: 167_000, target: 80_000, isClamped: true });
    expect(policy.pct).toBeLessThanOrEqual(100);
  });

  it("sets an override the engine floors back to exactly the trigger", () => {
    for (const window of [100_000, 200_000, 1_000_000]) {
      for (let upperBound = 600; upperBound < window; upperBound += 997) {
        const { policy } = computePolicy(resolveSettings({ upperBound, lowerBound: 500 }), window);
        expect(engineThreshold(window, policy.pct)).toBe(policy.trigger);
      }
    }
  });

  it("keeps a lowered trigger and halves it for the target", () => {
    for (const window of [100_000, 200_000]) {
      const { policy, notices } = computePolicy(resolveSettings({ compactPercent: 40 }), window);
      expect(policy).toMatchObject({ trigger: 0.4 * window, target: 0.2 * window });
      expect(notices).toEqual([]);
    }
  });

  it("keeps every target below its trigger", () => {
    for (const window of [100_000, 200_000, 1_000_000]) {
      for (let compactPercent = 1; compactPercent <= 100; compactPercent += 3) {
        const { policy } = computePolicy(resolveSettings({ compactPercent }), window);
        expect(policy.target).toBeLessThan(policy.trigger);
      }
    }
  });

  it("keeps a target below the trigger", () => {
    const { policy, notices } = computePolicy(resolveSettings({ compactPercent: 40, lowerBound: 20_000 }), 100_000);
    expect(policy).toMatchObject({ trigger: 40_000, target: 20_000, pct: 50 });
    expect(notices).toEqual([]);
  });
});

describe("resolveSettings", () => {
  it("replaces each invalid value with its default and says so", () => {
    const { settings, notices } = resolveSettings({ lowerBound: -5, upperBound: 1.5, compactPercent: 120 });
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(notices).toEqual([
      "lowerBound -5 is invalid; using 140000",
      "upperBound 1.5 is invalid; using 800000",
      "compactPercent 120 is invalid; using 90",
    ]);
  });

  it("refuses a percent below 1", () => {
    const { settings, notices } = resolveSettings({ compactPercent: 0.0001 });
    expect(settings.compactPercent).toBe(90);
    expect(notices).toEqual(["compactPercent 0.0001 is invalid; using 90"]);
  });

  it("keeps valid values, including a fractional percent", () => {
    expect(resolveSettings({ lowerBound: 100_000, upperBound: 600_000, compactPercent: 72.5 }).settings).toEqual({
      lowerBound: 100_000,
      upperBound: 600_000,
      compactPercent: 72.5,
    });
  });
});
