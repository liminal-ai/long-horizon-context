import { resolveTokenFamily } from "lhc";
import { describe, expect, it } from "vitest";
import {
  formatTokenFamilyLog,
  isRealModelId,
  laterModelObservation,
  mapPiProviderToCore,
  seedTokenFamilyFromPiModel,
  seedTokenFamilyOrProviderFallback,
} from "../src/token-family.js";

describe("PI provider mapping", () => {
  it("maps each PI provider to the expected family for a known model id", () => {
    const cases: Array<{
      provider: string;
      id: string;
      coreProvider: string;
      family: string;
      source: "model";
    }> = [
      {
        provider: "anthropic",
        id: "claude-opus-4-6",
        coreProvider: "anthropic",
        family: "claude-2025",
        source: "model",
      },
      { provider: "openai", id: "gpt-4o", coreProvider: "openai", family: "o200k", source: "model" },
      { provider: "openai-codex", id: "gpt-5.4-mini", coreProvider: "openai", family: "o200k", source: "model" },
      { provider: "xai", id: "grok-4.5", coreProvider: "xai", family: "grok", source: "model" },
      { provider: "google", id: "gemini-2.5-flash", coreProvider: "google", family: "gemini-4", source: "model" },
      { provider: "local", id: "glm-4.6", coreProvider: "", family: "glm-5", source: "model" },
    ];
    for (const row of cases) {
      expect(mapPiProviderToCore(row.provider)).toBe(row.coreProvider);
      const resolved = seedTokenFamilyFromPiModel({ provider: row.provider, id: row.id });
      expect(resolved).toEqual({ family: row.family, source: row.source });
      expect(resolveTokenFamily(row.id, row.coreProvider === "" ? undefined : row.coreProvider)).toEqual(resolved);
    }
  });

  it("an unknown provider with no model match is core's unmapped fallback", () => {
    expect(mapPiProviderToCore("not-a-provider")).toBe("not-a-provider");
    expect(seedTokenFamilyFromPiModel({ provider: "not-a-provider", id: "mystery-1" })).toEqual({
      family: "o200k",
      source: "unmapped",
    });
    expect(seedTokenFamilyFromPiModel({ provider: "not-a-provider", id: "" })).toEqual({
      family: "o200k",
      source: "unmapped",
    });
  });

  it("launch/replay seed uses the model when present and falls back through the provider otherwise", () => {
    expect(seedTokenFamilyOrProviderFallback({ provider: "anthropic", id: "claude-opus-4-6" })).toEqual({
      resolved: { family: "claude-2025", source: "model" },
      usedFallback: false,
    });
    expect(seedTokenFamilyOrProviderFallback(undefined, "anthropic")).toEqual({
      resolved: { family: "claude-2026", source: "provider-fallback" },
      usedFallback: true,
    });
    expect(seedTokenFamilyOrProviderFallback({ provider: "openai", id: "<synthetic>" }, "openai")).toEqual({
      resolved: { family: "o200k", source: "provider-fallback" },
      usedFallback: true,
    });
    expect(seedTokenFamilyOrProviderFallback(undefined)).toEqual({
      resolved: { family: "o200k", source: "unmapped" },
      usedFallback: true,
    });
  });

  it("a known provider with no real model id uses core's provider fallback", () => {
    expect(seedTokenFamilyFromPiModel({ provider: "anthropic", id: "" })).toEqual({
      family: "claude-2026",
      source: "provider-fallback",
    });
    expect(seedTokenFamilyFromPiModel({ provider: "openai-codex" })).toEqual({
      family: "o200k",
      source: "provider-fallback",
    });
    expect(seedTokenFamilyFromPiModel({ provider: "xai", id: "<synthetic>" })).toEqual({
      family: "grok",
      source: "provider-fallback",
    });
    expect(seedTokenFamilyFromPiModel({ provider: "google", id: "" })).toEqual({
      family: "gemini-4",
      source: "provider-fallback",
    });
  });
});

describe("seed log format", () => {
  it("prints slug, source, and provider/id", () => {
    const resolved = seedTokenFamilyFromPiModel({ provider: "anthropic", id: "claude-opus-4-6" });
    expect(formatTokenFamilyLog(resolved, { provider: "anthropic", id: "claude-opus-4-6" })).toBe(
      "pi-lhc token family claude-2025 (model) model=anthropic/claude-opus-4-6",
    );
  });

  it("missing model is unmapped and model= is empty", () => {
    expect(seedTokenFamilyFromPiModel(undefined)).toEqual({ family: "o200k", source: "unmapped" });
    expect(seedTokenFamilyFromPiModel(null)).toEqual({ family: "o200k", source: "unmapped" });
    expect(formatTokenFamilyLog(seedTokenFamilyFromPiModel(undefined), undefined)).toBe(
      "pi-lhc token family o200k (unmapped) model=",
    );
  });

  it("synthetic id is ignored for resolution but still printed", () => {
    expect(isRealModelId("<synthetic>")).toBe(false);
    const resolved = seedTokenFamilyFromPiModel({ provider: "anthropic", id: "<synthetic>" });
    expect(resolved).toEqual({ family: "claude-2026", source: "provider-fallback" });
    expect(formatTokenFamilyLog(resolved, { provider: "anthropic", id: "<synthetic>" })).toBe(
      "pi-lhc token family claude-2026 (provider-fallback) model=anthropic/<synthetic>",
    );
  });
});

describe("later model ids are log-only", () => {
  it("synthetic and duplicate ids do not produce a log line", () => {
    const seeded = seedTokenFamilyFromPiModel({ provider: "anthropic", id: "claude-sonnet-5" });
    const last = { provider: "anthropic", id: "claude-sonnet-5" };
    expect(laterModelObservation(last, { provider: "anthropic", id: "<synthetic>" }, seeded)).toBeNull();
    expect(laterModelObservation(last, { provider: "anthropic", id: "claude-sonnet-5" }, seeded)).toBeNull();
    expect(laterModelObservation(last, { provider: "anthropic", id: "" }, seeded)).toBeNull();
    expect(laterModelObservation(last, undefined, seeded)).toBeNull();
  });

  it("a real model change is one log line and does not imply an SDK rebuild", () => {
    const seeded = seedTokenFamilyFromPiModel({ provider: "anthropic", id: "claude-sonnet-5" });
    expect(
      laterModelObservation(
        { provider: "anthropic", id: "claude-sonnet-5" },
        { provider: "xai", id: "grok-4.5" },
        seeded,
      ),
    ).toEqual({
      model: { provider: "xai", id: "grok-4.5" },
      log: "pi-lhc token family claude-2026 (model) -> grok (model) model=xai/grok-4.5",
    });
  });
});
