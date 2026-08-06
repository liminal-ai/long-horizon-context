import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_PI_MODEL } from "../../src/inference/model-call.js";

const sampleModelsPath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "models.example.json");

const { provider, id: modelId } = DEFAULT_PI_MODEL;

function loadSampleConfig(): unknown {
  return JSON.parse(readFileSync(sampleModelsPath, "utf8"));
}

async function createRegistry(modelsPath: string | null): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({
    modelsPath,
    // Keep the runtime's models-store side-effect file out of the repo
    // (default placement is next to modelsPath, i.e. inside test/fixtures).
    modelsStorePath: join(tmpdir(), `pi-lhc-models-store-${process.pid}-${Math.random().toString(16).slice(2)}.json`),
    allowModelNetwork: false,
  });
  return new ModelRegistry(runtime);
}

async function builtInModel() {
  const registry = await createRegistry(null);
  const model = registry.find(provider, modelId);
  if (!model) {
    throw new Error(`built-in model not found: ${provider}/${modelId}`);
  }
  return model;
}

async function modelWithSampleOverride() {
  const registry = await createRegistry(sampleModelsPath);
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
  it("is accepted by PI ModelRegistry (ModelsConfigSchema validation on load)", async () => {
    const registry = await createRegistry(sampleModelsPath);
    expect(registry.getError()).toBeUndefined();
    expect(registry.find(provider, modelId)).toBeDefined();
  });

  it("ships the lightweight LHC default model in the PI registry", async () => {
    expect((await builtInModel()).id).toBe("gpt-5.4-mini");
  });

  it("overrides only contextWindow on the smart-compact development model", async () => {
    const sample = loadSampleConfig() as {
      providers: Record<string, { modelOverrides?: Record<string, Record<string, unknown>> }>;
    };
    const override = sample.providers[provider]?.modelOverrides?.["gpt-5.4"];
    expect(override).toEqual({ contextWindow: 250_000 });

    const baseline = (await createRegistry(null)).find(provider, "gpt-5.4");
    const overridden = await registryFindWithOverride("gpt-5.4");
    expect(overridden?.contextWindow).toBe(250_000);
    expect(overridden?.contextWindow).not.toBe(baseline?.contextWindow);
    expect((await modelWithSampleOverride()).id).toBe("gpt-5.4-mini");
  });
});

async function registryFindWithOverride(modelId: string) {
  const registry = await createRegistry(sampleModelsPath);
  return registry.find(provider, modelId);
}
