import type {
  GovernorPressureReceipt,
  PostMeasurementEstimate,
  ProviderBaseFreshness,
  ProviderContextTokens,
} from "./types.js";
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
  return null;
}

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
  // All-zero input triad is a blocked/error placeholder, never a measurement.
  if (total === 0) return null;

  return {
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    total,
  };
}

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

export function buildPressureReceipt(
  providerContext: ProviderContextTokens | null,
  estimate: PostMeasurementEstimate | null | undefined,
  upperTriggerTokens: number,
  freshness: ProviderBaseFreshness = providerContext === null ? "none" : "current_sampling",
): GovernorPressureReceipt {
  const est = normalizePostMeasurementEstimate(estimate);
  const base = providerContext?.total ?? 0;
  const summed = base + est.tokens;
  const next = Number.isSafeInteger(summed) ? summed : base;
  return {
    providerBaseTokens: providerContext === null ? null : base,
    providerBaseDomain: "provider_reported_input",
    providerBaseFreshness: providerContext === null ? "none" : freshness,
    estimateTokens: est.tokens,
    estimateSource: est.source,
    estimateDomain: "source_labelled_estimate",
    nextRequestPressureTokens: next,
    upperTriggerTokens,
    atOrAboveTrigger: next >= upperTriggerTokens,
  };
}

export function estimateTokensFromCapturedBytes(
  bytes: number,
  source = "host_canonical_payload_byte_estimate",
): PostMeasurementEstimate {
  const safe = readNonNegInt(bytes) ?? 0;
  const tokens = Math.floor(safe / 4);
  return {
    tokens: Number.isSafeInteger(tokens) ? tokens : 0,
    source,
    domain: "source_labelled_estimate",
  };
}
