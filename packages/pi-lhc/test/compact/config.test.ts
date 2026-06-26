import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_PI_MODEL } from "../../src/inference/model-call.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const sampleModelsPath = join(repoRoot, "docs/specs/02-pi-lhc/02-smart-compact/models.example.json");

const { provider, id: modelId } = DEFAULT_PI_MODEL;

function loadSampleConfig(): unknown {
  return JSON.parse(readFileSync(sampleModelsPath, "utf8"));
}

function builtInModel() {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const model = registry.find(provider, modelId);
  if (!model) {
    throw new Error(`built-in model not found: ${provider}/${modelId}`);
  }
  return model;
}

function modelWithSampleOverride() {
  const registry = ModelRegistry.create(AuthStorage.inMemory(), sampleModelsPath);
  const loadError = registry.getError();
  if (loadError) {
    throw new Error(`models.example.json failed to load: ${loadError}`);
  }
  const model = registry.find(provider, modelId);
  if (!model) {
    throw new Error(`model not found after override load: ${provider}/${modelId}`);
  }
  return model;
}

describe("smart compact models.example.json", () => {
  it("is accepted by PI ModelRegistry (ModelsConfigSchema validation on load)", () => {
    const registry = ModelRegistry.create(AuthStorage.inMemory(), sampleModelsPath);
    expect(registry.getError()).toBeUndefined();
    expect(registry.find(provider, modelId)).toBeDefined();
  });

  it("overrides only contextWindow on the primary development model", () => {
    const sample = loadSampleConfig() as {
      providers: Record<string, { modelOverrides?: Record<string, Record<string, unknown>> }>;
    };
    const override = sample.providers[provider]?.modelOverrides?.[modelId];
    expect(override).toEqual({ contextWindow: 250_000 });

    const baseline = builtInModel();
    const overridden = modelWithSampleOverride();

    expect(overridden.contextWindow).toBe(250_000);
    expect(overridden.contextWindow).not.toBe(baseline.contextWindow);

    const { contextWindow: _baselineWindow, ...baselineRest } = baseline;
    const { contextWindow: _overrideWindow, ...overrideRest } = overridden;
    expect(overrideRest).toEqual(baselineRest);
  });
});
