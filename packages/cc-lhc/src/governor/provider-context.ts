/**
 * Provider-context arithmetic for one unique sampling attempt, plus
 * source-labelled next-request pressure (LIM-64).
 *
 * Provider formula: input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * Uses only finite safe integers; invalid components fail closed (null).
 *
 * Predicted next-request pressure = provider total + post-measurement estimate.
 * The estimate is never relabelled as provider usage.
 */

import type { GovernorPressureReceipt, PostMeasurementEstimate, ProviderContextTokens } from "./types.js";
import { EMPTY_POST_MEASUREMENT_ESTIMATE } from "./types.js";

const USAGE_KEYS = {
  input: ["input_tokens", "inputTokens"],
  cacheCreation: ["cache_creation_input_tokens", "cacheCreationInputTokens"],
  cacheRead: ["cache_read_input_tokens", "cacheReadInputTokens"],
} as const;

function readNonNegInt(raw: unknown): number | null {
  if (typeof raw !== "number") return null;
  if (!Number.isFinite(raw)) return null;
  if (!Number.isSafeInteger(raw)) return null;
  if (raw < 0) return null;
  return raw;
}

function pickField(usage: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    if (Object.hasOwn(usage, key)) {
      return readNonNegInt(usage[key]);
    }
  }
  // Absent field counts as 0 only when at least one of the triad is present
  // via the caller; we treat missing key as 0 for the optional cache fields
  // once input_tokens is established.
  return null;
}

/**
 * Extract provider context tokens from a sampling_observed usage object.
 * Returns null when usage is missing, empty of input authority, or invalid.
 */
export function providerContextFromUsage(
  usage: Record<string, unknown> | null | undefined,
): ProviderContextTokens | null {
  if (usage === null || usage === undefined) return null;
  if (typeof usage !== "object" || Array.isArray(usage)) return null;

  const hasInputKey = USAGE_KEYS.input.some((k) => Object.hasOwn(usage, k));
  if (!hasInputKey) return null;

  const inputTokens = pickField(usage, USAGE_KEYS.input);
  if (inputTokens === null) return null;

  let cacheCreationInputTokens = 0;
  if (USAGE_KEYS.cacheCreation.some((k) => Object.hasOwn(usage, k))) {
    const v = pickField(usage, USAGE_KEYS.cacheCreation);
    if (v === null) return null;
    cacheCreationInputTokens = v;
  }

  let cacheReadInputTokens = 0;
  if (USAGE_KEYS.cacheRead.some((k) => Object.hasOwn(usage, k))) {
    const v = pickField(usage, USAGE_KEYS.cacheRead);
    if (v === null) return null;
    cacheReadInputTokens = v;
  }

  const total = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  if (!Number.isSafeInteger(total)) return null;

  return {
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    total,
  };
}

/** True when total is at or above the upper trigger. */
export function atOrAboveUpper(total: number, upperBoundTokens: number): boolean {
  return total >= upperBoundTokens;
}

/**
 * Normalize a host-supplied estimate. Invalid numbers fail closed to zero
 * tokens with the empty estimate shape (never invent provider usage).
 */
export function normalizePostMeasurementEstimate(
  estimate: PostMeasurementEstimate | null | undefined,
): PostMeasurementEstimate {
  if (estimate === null || estimate === undefined) {
    return { ...EMPTY_POST_MEASUREMENT_ESTIMATE };
  }
  const tokens = readNonNegInt(estimate.tokens);
  const source =
    typeof estimate.source === "string" && estimate.source.trim() !== ""
      ? estimate.source
      : EMPTY_POST_MEASUREMENT_ESTIMATE.source;
  if (tokens === null) {
    return { tokens: 0, source, domain: "source_labelled_estimate" };
  }
  return { tokens, source, domain: "source_labelled_estimate" };
}

/**
 * Build a pressure receipt from authoritative provider usage + labelled estimate.
 * Does not double-count: estimate is a separate domain.
 */
export function buildPressureReceipt(
  providerContext: ProviderContextTokens | null,
  estimate: PostMeasurementEstimate | null | undefined,
  upperTriggerTokens: number,
): GovernorPressureReceipt {
  const est = normalizePostMeasurementEstimate(estimate);
  if (providerContext === null) {
    return {
      providerBaseTokens: null,
      providerBaseDomain: "provider_reported_input",
      estimateTokens: est.tokens,
      estimateSource: est.source,
      estimateDomain: "source_labelled_estimate",
      nextRequestPressureTokens: null,
      upperTriggerTokens,
      atOrAboveTrigger: null,
    };
  }
  const next = providerContext.total + est.tokens;
  if (!Number.isSafeInteger(next)) {
    return {
      providerBaseTokens: providerContext.total,
      providerBaseDomain: "provider_reported_input",
      estimateTokens: est.tokens,
      estimateSource: est.source,
      estimateDomain: "source_labelled_estimate",
      nextRequestPressureTokens: null,
      upperTriggerTokens,
      atOrAboveTrigger: null,
    };
  }
  return {
    providerBaseTokens: providerContext.total,
    providerBaseDomain: "provider_reported_input",
    estimateTokens: est.tokens,
    estimateSource: est.source,
    estimateDomain: "source_labelled_estimate",
    nextRequestPressureTokens: next,
    upperTriggerTokens,
    atOrAboveTrigger: next >= upperTriggerTokens,
  };
}

/**
 * Exact provenance for a trigger token total. A full next-request pressure keeps
 * provider input and the actual estimate source distinct. A recovery fallback to
 * provider context alone is labelled provider-only rather than inventing an estimate.
 */
export function triggerPressureSource(receipt: GovernorPressureReceipt): string | null {
  if (receipt.nextRequestPressureTokens !== null) {
    return `${receipt.providerBaseDomain}+${receipt.estimateDomain}:${receipt.estimateSource}`;
  }
  return receipt.providerBaseTokens === null ? null : receipt.providerBaseDomain;
}

/**
 * Heuristic host estimate: ~4 bytes per token for UTF-8 captured text after
 * the provider request. Labelled so it is never confused with provider usage.
 *
 * Prefer measuring only canonical captured payload bytes and labelling the
 * source exactly (e.g. `accepted_lhc_canonical_payload_byte_estimate`). This is not
 * provider billing usage and can drift vs real tokenizer counts.
 */
export function estimateTokensFromCapturedBytes(
  bytes: number,
  source = "accepted_lhc_canonical_payload_byte_estimate",
): PostMeasurementEstimate {
  const safe = readNonNegInt(bytes) ?? 0;
  const tokens = Math.floor(safe / 4);
  return {
    tokens: Number.isSafeInteger(tokens) ? tokens : 0,
    source,
    domain: "source_labelled_estimate",
  };
}
