import { resolveTokenFamily } from "lhc";
import { describe, expect, test } from "vitest";
import {
  formatTokenFamilyLog,
  isRealModelId,
  laterModelObservation,
  seedTokenFamilyFromStartModel,
} from "../src/token-family.ts";

describe("family resolution from the start options", () => {
  test("a real model id resolves through core with source model", () => {
    const resolved = seedTokenFamilyFromStartModel("claude-opus-4-6");
    expect(resolved).toEqual({ family: "claude-2025", source: "model" });
    expect(resolveTokenFamily("claude-opus-4-6", "anthropic")).toEqual(resolved);
    expect(formatTokenFamilyLog(resolved, "claude-opus-4-6")).toBe(
      "claude-lhc token family claude-2025 (model) model=claude-opus-4-6",
    );
  });

  test("claude-sonnet-5 resolves to claude-2026 from the model id", () => {
    expect(seedTokenFamilyFromStartModel("claude-sonnet-5")).toEqual({ family: "claude-2026", source: "model" });
  });

  test("empty or missing model is claude-2026 / provider-fallback", () => {
    expect(seedTokenFamilyFromStartModel("")).toEqual({ family: "claude-2026", source: "provider-fallback" });
    expect(seedTokenFamilyFromStartModel(undefined)).toEqual({ family: "claude-2026", source: "provider-fallback" });
    expect(formatTokenFamilyLog(seedTokenFamilyFromStartModel(undefined), undefined)).toBe(
      "claude-lhc token family claude-2026 (provider-fallback) model=",
    );
    expect(formatTokenFamilyLog(seedTokenFamilyFromStartModel(""), "")).toBe(
      "claude-lhc token family claude-2026 (provider-fallback) model=",
    );
  });

  test("a synthetic model id is ignored and falls back like a missing model", () => {
    expect(isRealModelId("<synthetic>")).toBe(false);
    expect(seedTokenFamilyFromStartModel("<synthetic>")).toEqual({
      family: "claude-2026",
      source: "provider-fallback",
    });
    expect(formatTokenFamilyLog(seedTokenFamilyFromStartModel("<synthetic>"), "<synthetic>")).toBe(
      "claude-lhc token family claude-2026 (provider-fallback) model=<synthetic>",
    );
  });
});

describe("later model ids are log-only", () => {
  test("synthetic and duplicate ids do not produce a log line", () => {
    const seeded = seedTokenFamilyFromStartModel("claude-sonnet-5");
    expect(laterModelObservation("claude-sonnet-5", "<synthetic>", seeded)).toBeNull();
    expect(laterModelObservation("claude-sonnet-5", "claude-sonnet-5", seeded)).toBeNull();
    expect(laterModelObservation("claude-sonnet-5", "", seeded)).toBeNull();
  });

  test("a real model change is one log line and does not imply an SDK rebuild", () => {
    const seeded = seedTokenFamilyFromStartModel("claude-sonnet-5");
    expect(laterModelObservation("claude-sonnet-5", "claude-opus-4-6", seeded)).toEqual({
      modelId: "claude-opus-4-6",
      log: "claude-lhc token family claude-2026 (model) -> claude-2025 (model) model=claude-opus-4-6",
    });
  });
});
