import { type ResolvedTokenFamily, resolveTokenFamily } from "lhc";

export const CLAUDE_LHC_TOKEN_PROVIDER = "anthropic";

export type { ResolvedTokenFamily };

export function isRealModelId(modelId: unknown): modelId is string {
  return typeof modelId === "string" && modelId !== "" && !modelId.startsWith("<");
}

export function resolveHostTokenFamily(modelId: unknown): ResolvedTokenFamily {
  return resolveTokenFamily(isRealModelId(modelId) ? modelId : "", CLAUDE_LHC_TOKEN_PROVIDER);
}

export function seedTokenFamilyFromStartModel(modelId: unknown): ResolvedTokenFamily {
  return resolveHostTokenFamily(modelId);
}

export function formatTokenFamilyLog(resolved: ResolvedTokenFamily, modelId: unknown): string {
  const id = typeof modelId === "string" ? modelId : "";
  return `claude-lhc token family ${resolved.family} (${resolved.source}) model=${id}`;
}

export function formatTokenFamilyChangeLog(
  previous: ResolvedTokenFamily,
  next: ResolvedTokenFamily,
  modelId: string,
): string {
  return `claude-lhc token family ${previous.family} (${previous.source}) -> ${next.family} (${next.source}) model=${modelId}`;
}

export function laterModelObservation(
  lastModelId: string | null,
  modelId: unknown,
  seeded: ResolvedTokenFamily,
): { modelId: string; log: string } | null {
  if (!isRealModelId(modelId) || modelId === lastModelId) return null;
  const previous = lastModelId !== null ? resolveHostTokenFamily(lastModelId) : seeded;
  return { modelId, log: formatTokenFamilyChangeLog(previous, resolveHostTokenFamily(modelId), modelId) };
}
