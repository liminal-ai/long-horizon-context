import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeterministicInferenceCallbacks, initLhc } from "../src/index.js";
import {
  FAMILIES_CATALOG,
  type FamiliesOverlay,
  resolveTokenFamily,
  TokenEstimator,
} from "../src/shared-tech/token-counting/index.js";
import { type TempStore, tempStore, validEvent } from "./fixtures/index.js";

const FIXED = "the quick brown fox jumps over the lazy dog";

describe("TokenEstimator", () => {
  it("weights claude-2026 as ceil(o200k × 1.55) on a fixed string", () => {
    const o200k = new TokenEstimator("o200k");
    const claude = new TokenEstimator("claude-2026");
    expect(claude.estimate(FIXED)).toBe(Math.ceil(o200k.rawCount(FIXED) * 1.55));
  });

  it("uses the family signature rate", () => {
    const claude = new TokenEstimator("claude-2026");
    const o200k = new TokenEstimator("o200k");
    const claude2025 = new TokenEstimator("claude-2025");
    const signature = "A".repeat(1_400);
    expect(claude.estimateSignature(signature)).toBe(Math.ceil(1_400 / 5.74));
    expect(claude2025.estimateSignature(signature)).toBe(Math.ceil(1_400 / 5.74));
    expect(o200k.estimateSignature(signature)).toBe(Math.ceil(1_400 / 1.47));
    expect(claude.estimateSignature("")).toBe(0);
  });

  it("weigh() matches estimate() for text and does not re-scale billed signatures", () => {
    const claude = new TokenEstimator("claude-2026");
    const raw = claude.rawCount(FIXED);
    expect(claude.weigh(raw)).toBe(claude.estimate(FIXED));
    const billedSig = claude.estimateSignature("B".repeat(500));
    expect(claude.weighStored(raw + billedSig, billedSig)).toBe(claude.weigh(raw) + billedSig);
    expect(claude.weighStored(raw + billedSig, billedSig)).not.toBe(claude.weigh(raw + billedSig));
  });

  it("lets a host overlay override a core weight", () => {
    const overlay: FamiliesOverlay = {
      families: {
        "claude-2026": {
          name: "host override",
          textWeight: 2,
          signatureCharsPerToken: 5.74,
          measured: "test overlay",
        },
      },
    };
    const core = new TokenEstimator("claude-2026");
    const host = new TokenEstimator("claude-2026", overlay);
    expect(host.textWeight).toBe(2);
    expect(host.label).toBe("host override");
    expect(host.estimate(FIXED)).toBe(Math.ceil(core.rawCount(FIXED) * 2));
    expect(host.estimate(FIXED)).not.toBe(core.estimate(FIXED));
  });
});

describe("resolveTokenFamily", () => {
  it.each([
    ["claude-opus-4-6", "claude-2025"],
    ["claude-sonnet-4-6", "claude-2025"],
    ["claude-haiku-4-5", "claude-2025"],
    ["claude-sonnet-5", "claude-2026"],
    ["claude-opus-4-7", "claude-2026"],
    ["grok-4.6", "grok"],
    ["gemini-3.5-flash", "gemini-4"],
    ["gemma-4-26b", "gemini-4"],
    ["qwen3.5", "qwen-3.5"],
    ["glm-5-flash", "glm-5"],
    ["kimi-k2", "kimi-k2"],
    ["deepseek-v4", "deepseek-v4"],
    ["gpt-5.4-mini", "o200k"],
    ["o1-preview", "o200k"],
    ["o3-mini", "o200k"],
    ["o4-mini", "o200k"],
    ["codex-mini", "o200k"],
  ] as const)("maps %s → %s from the model id", (modelId, family) => {
    expect(resolveTokenFamily(modelId)).toEqual({ family, source: "model" });
  });

  it("returns unmapped o200k without a provider, and provider-fallback with one", () => {
    expect(resolveTokenFamily("mystery-model-xyz")).toEqual({ family: "o200k", source: "unmapped" });
    expect(resolveTokenFamily("mystery-model-xyz", "anthropic")).toEqual({
      family: "claude-2026",
      source: "provider-fallback",
    });
    expect(resolveTokenFamily("mystery-model-xyz", "unknown-provider")).toEqual({
      family: "o200k",
      source: "unmapped",
    });
  });
});

describe("families.json", () => {
  it("points every model mapping at an existing family with finite weights > 0", () => {
    const slugs = new Set(Object.keys(FAMILIES_CATALOG.families));
    expect(slugs.size).toBeGreaterThan(0);
    for (const [slug, spec] of Object.entries(FAMILIES_CATALOG.families)) {
      expect(Number.isFinite(spec.textWeight) && spec.textWeight > 0, slug).toBe(true);
      expect(Number.isFinite(spec.signatureCharsPerToken) && spec.signatureCharsPerToken > 0, slug).toBe(true);
    }
    for (const entry of FAMILIES_CATALOG.models) {
      expect(slugs.has(entry.family), `${entry.match} → ${entry.family}`).toBe(true);
    }
    for (const [provider, family] of Object.entries(FAMILIES_CATALOG.providerFallback)) {
      expect(slugs.has(family), `${provider} → ${family}`).toBe(true);
    }
  });
});

describe("whole-view compact under claude-2026", () => {
  let store: TempStore;
  beforeEach(() => {
    store = tempStore();
  });
  afterEach(() => {
    store.cleanup();
  });

  it("receipts the weighted total and carries tokenFamily claude-2026", async () => {
    const claude = new TokenEstimator("claude-2026");
    const sdk = initLhc({
      tokenFamily: "claude-2026",
      mode: "manual",
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
    });
    const filePath = store.threadPath();
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    if (!created.ok) throw new Error(created.error.reason);

    for (let turn = 1; turn <= 6; turn += 1) {
      const result = await sdk.intakeStream.messageEvents({ filePath }, [
        validEvent("user_prompt", { payload: { text: `prompt ${turn} ${"alpha ".repeat(40)}` } }),
        validEvent("assistant_text", { payload: { text: `answer ${turn} ${"bravo ".repeat(40)}` } }),
        validEvent("turn_end"),
      ]);
      if (!result.ok) throw new Error(result.error.reason);
    }
    const drained = await sdk.work.drain({ filePath });
    if (!drained.ok) throw new Error(drained.error.reason);

    const compacted = await sdk.threadView.compact(
      { filePath },
      { params: { lowerBound: 80, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(compacted.ok).toBe(true);
    if (!compacted.ok) throw new Error(compacted.error.reason);

    expect(compacted.value.tokenFamily).toBe("claude-2026");
    const bandTokens = compacted.value.renderedBands.reduce((sum, band) => sum + claude.estimate(band.text), 0);
    expect(
      compacted.value.bands.brief.tokens + compacted.value.bands.detailed.tokens + compacted.value.bands.smooth.tokens,
    ).toBe(bandTokens);
    expect(compacted.value.totalTokens).toBe(bandTokens + compacted.value.tailTokens);
    expect(compacted.value.totalTokens).toBeGreaterThan(0);

    const o200k = new TokenEstimator("o200k");
    for (const band of compacted.value.renderedBands) {
      expect(claude.estimate(band.text)).toBe(Math.ceil(o200k.rawCount(band.text) * 1.55));
    }
  });
});
