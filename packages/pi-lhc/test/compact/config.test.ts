import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_PI_MODEL } from "../../src/inference/model-call.js";

const sampleModelsPath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "models.example.json");

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

  it("ships the lightweight LHC default model in the PI registry", () => {
    expect(builtInModel().id).toBe("gpt-5.4-mini");
  });

  it("overrides only contextWindow on the smart-compact development model", () => {
    const sample = loadSampleConfig() as {
      providers: Record<string, { modelOverrides?: Record<string, Record<string, unknown>> }>;
    };
    const override = sample.providers[provider]?.modelOverrides?.["gpt-5.4"];
    expect(override).toEqual({ contextWindow: 250_000 });

    const baseline = ModelRegistry.inMemory(AuthStorage.inMemory()).find(provider, "gpt-5.4");
    const overridden = registryFindWithOverride("gpt-5.4");
    expect(overridden?.contextWindow).toBe(250_000);
    expect(overridden?.contextWindow).not.toBe(baseline?.contextWindow);
    expect(modelWithSampleOverride().id).toBe("gpt-5.4-mini");
  });
});

function registryFindWithOverride(modelId: string) {
  const registry = ModelRegistry.create(AuthStorage.inMemory(), sampleModelsPath);
  return registry.find(provider, modelId);
}
