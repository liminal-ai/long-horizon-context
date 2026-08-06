import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

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

/** Print available models from ModelRuntime for --list-models (mirrors upstream cli/list-models). */
export async function printLauncherListModels(
  modelRuntime: ModelRuntime,
  searchPattern?: string,
  signal?: AbortSignal,
): Promise<void> {
  const loadError = modelRuntime.getError();
  if (loadError) {
    console.error(`Warning: errors loading models.json:\n${loadError}`);
  }

  // Upstream lists auth-available models only (getAvailable), not the full catalog.
  let models = [...(await modelRuntime.getAvailable(undefined, signal === undefined ? {} : { signal }))];

  if (models.length === 0) {
    console.log("No models available. Configure PI auth/models before using pi-lhc.");
    return;
  }

  if (searchPattern) {
    models = models.filter((model) => matchesSearch(model, searchPattern));
  }

  if (models.length === 0) {
    console.log(`No models matching "${searchPattern}"`);
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
