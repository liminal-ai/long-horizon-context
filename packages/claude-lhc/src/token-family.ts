/**
 * Tokenizer family for one claude-lhc session.
 *
 * The LHC SDK is constructed once per start() with the family known beforehand:
 * resolveTokenFamily(model, "anthropic") from the start-option model id. Empty,
 * missing, or synthetic ids (`<synthetic>` and other `<…>` stamps) use the
 * Anthropic provider fallback (claude-2026). A later model id is one log line
 * and does not recreate the SDK.
 */
import { type ResolvedTokenFamily, resolveTokenFamily } from "lhc";

export const CLAUDE_LHC_TOKEN_PROVIDER = "anthropic";

export type { ResolvedTokenFamily };

/** A model id the wire actually served. Claude Code stamps `<synthetic>` on
 *  lines it fabricates locally; those never seed a family and never log a change. */
export function isRealModelId(modelId: unknown): modelId is string {
  return typeof modelId === "string" && modelId !== "" && !modelId.startsWith("<");
}

export function resolveHostTokenFamily(modelId: unknown): ResolvedTokenFamily {
  return resolveTokenFamily(isRealModelId(modelId) ? modelId : "", CLAUDE_LHC_TOKEN_PROVIDER);
}

/** Seed family from the start-option model. Empty, missing, or synthetic → provider fallback. */
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

/**
 * Log-only observation of a later model id. Returns null when the id is not a
 * real model or matches the last one already seen. Does not imply an SDK rebuild.
 */
export function laterModelObservation(
  lastModelId: string | null,
  modelId: unknown,
  seeded: ResolvedTokenFamily,
): { modelId: string; log: string } | null {
  if (!isRealModelId(modelId) || modelId === lastModelId) return null;
  const previous = lastModelId !== null ? resolveHostTokenFamily(lastModelId) : seeded;
  return { modelId, log: formatTokenFamilyChangeLog(previous, resolveHostTokenFamily(modelId), modelId) };
}
