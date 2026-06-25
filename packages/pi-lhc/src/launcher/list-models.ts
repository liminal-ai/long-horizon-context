import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
  }
  return count.toString();
}

function matchesSearch(model: Model<Api>, searchPattern: string): boolean {
  const haystack = `${model.provider} ${model.id}`.toLowerCase();
  return haystack.includes(searchPattern.toLowerCase());
}

/** Print available models from ModelRegistry for --list-models. */
export function printLauncherListModels(modelRegistry: ModelRegistry, searchPattern?: string): void {
  const loadError = modelRegistry.getError();
  if (loadError) {
    console.error(`Warning: errors loading models.json:\n${loadError}`);
  }

  let models = modelRegistry.getAvailable();
  if (models.length === 0) {
    models = modelRegistry.getAll();
  }
  if (searchPattern) {
    models = models.filter((model) => matchesSearch(model, searchPattern));
  }

  if (models.length === 0) {
    if (searchPattern) {
      console.log(`No models matching "${searchPattern}"`);
    } else {
      console.log("No models available. Configure PI auth/models before using pi-lhc.");
    }
    return;
  }

  models.sort((left, right) => {
    const providerCmp = left.provider.localeCompare(right.provider);
    if (providerCmp !== 0) return providerCmp;
    return left.id.localeCompare(right.id);
  });

  for (const model of models) {
    const thinking = model.reasoning ? "yes" : "no";
    const images = model.input.includes("image") ? "yes" : "no";
    console.log(
      `${model.provider}/${model.id}  context=${formatTokenCount(model.contextWindow)}  max-out=${formatTokenCount(model.maxTokens)}  thinking=${thinking}  images=${images}`,
    );
  }
}
