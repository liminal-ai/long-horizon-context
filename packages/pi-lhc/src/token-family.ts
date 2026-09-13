/**
 * Tokenizer family for one pi-lhc session.
 *
 * The LHC SDK is constructed once per PI session with the family known
 * beforehand: resolveTokenFamily(modelId, mappedProvider) from ctx.model
 * `{provider, id}`. Empty, missing, or synthetic ids (`<synthetic>` and other
 * `<…>` stamps) resolve with "" so core's provider fallback (or unmapped)
 * applies. A later model_select is one log line and does not recreate the SDK.
 */
import { type ResolvedTokenFamily, resolveTokenFamily } from "lhc";

export type { ResolvedTokenFamily };

/** PI `{provider, id}` as the wire serves it. */
export interface PiModelRef {
  provider: string;
  id: string;
}

/**
 * Map a PI provider string onto core's `providerFallback` keys.
 * Unknown names are passed through unchanged — core then applies unmapped,
 * never a host-invented default. `local` has no core key; GLM still matches
 * by model id (`glm-`).
 */
export function mapPiProviderToCore(provider: string): string {
  switch (provider.trim().toLowerCase()) {
    case "anthropic":
      return "anthropic";
    case "openai":
    case "openai-codex":
      return "openai";
    case "xai":
      return "xai";
    case "google":
    case "google-vertex":
    case "google-gemini-cli":
      return "google";
    case "local":
      return "";
    default:
      return provider;
  }
}

/** A model id the wire actually served. Synthetic `<…>` stamps never seed a
 *  family and never log a change. */
export function isRealModelId(modelId: unknown): modelId is string {
  return typeof modelId === "string" && modelId !== "" && !modelId.startsWith("<");
}

export function isRealPiModel(model: unknown): model is PiModelRef {
  if (typeof model !== "object" || model === null) return false;
  const rec = model as { provider?: unknown; id?: unknown };
  return typeof rec.provider === "string" && isRealModelId(rec.id);
}

function coreProviderOf(model: { provider?: string } | null | undefined): string | undefined {
  if (typeof model?.provider !== "string" || model.provider === "") return undefined;
  const mapped = mapPiProviderToCore(model.provider);
  return mapped === "" ? undefined : mapped;
}

/** Resolve through core. Empty/missing/synthetic id → `""` plus the mapped
 *  provider so core's fallback applies. */
export function resolveHostTokenFamily(model?: { provider?: string; id?: unknown } | null): ResolvedTokenFamily {
  return resolveTokenFamily(isRealModelId(model?.id) ? model.id : "", coreProviderOf(model));
}

/** Seed family from the model PI has at SDK construction. */
export function seedTokenFamilyFromPiModel(model?: { provider?: string; id?: unknown } | null): ResolvedTokenFamily {
  return resolveHostTokenFamily(model);
}

/**
 * Resolve family from a concrete model, or with `""` plus provider when no
 * real model id is known so core's provider fallback applies. `usedFallback`
 * is true when the caller had no real model — they must log that line,
 * never a silent literal family.
 */
export function seedTokenFamilyOrProviderFallback(
  model: { provider: string; id: string } | undefined,
  provider?: string,
): { resolved: ResolvedTokenFamily; usedFallback: boolean } {
  if (model !== undefined && isRealModelId(model.id)) {
    return { resolved: seedTokenFamilyFromPiModel(model), usedFallback: false };
  }
  const fallbackProvider = (model?.provider !== undefined && model.provider !== "" ? model.provider : provider) ?? "";
  return {
    resolved: seedTokenFamilyFromPiModel({ provider: fallbackProvider, id: "" }),
    usedFallback: true,
  };
}

function modelLabel(model: { provider?: string; id?: unknown } | null | undefined): string {
  if (model === null || model === undefined) return "";
  const provider = typeof model.provider === "string" ? model.provider : "";
  const id = typeof model.id === "string" ? model.id : "";
  if (provider === "" && id === "") return "";
  return `${provider}/${id}`;
}

export function formatTokenFamilyLog(
  resolved: ResolvedTokenFamily,
  model?: { provider?: string; id?: unknown } | null,
): string {
  return `pi-lhc token family ${resolved.family} (${resolved.source}) model=${modelLabel(model)}`;
}

export function formatTokenFamilyChangeLog(
  previous: ResolvedTokenFamily,
  next: ResolvedTokenFamily,
  model: PiModelRef,
): string {
  return `pi-lhc token family ${previous.family} (${previous.source}) -> ${next.family} (${next.source}) model=${model.provider}/${model.id}`;
}

/**
 * Log-only observation of a later PI model. Returns null when the id is not
 * real or matches the last one already seen. Does not imply an SDK rebuild.
 */
export function laterModelObservation(
  lastModel: PiModelRef | null,
  model: unknown,
  seeded: ResolvedTokenFamily,
): { model: PiModelRef; log: string } | null {
  if (!isRealPiModel(model)) return null;
  if (lastModel !== null && lastModel.provider === model.provider && lastModel.id === model.id) return null;
  const previous = lastModel !== null ? resolveHostTokenFamily(lastModel) : seeded;
  return { model, log: formatTokenFamilyChangeLog(previous, resolveHostTokenFamily(model), model) };
}
