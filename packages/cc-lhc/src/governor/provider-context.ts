/**
 * Provider-context arithmetic for one unique sampling attempt.
 * Formula: input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * Uses only finite safe integers; invalid components fail closed (null).
 */

import type { ProviderContextTokens } from "./types.js";

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
    if (Object.prototype.hasOwnProperty.call(usage, key)) {
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

  const hasInputKey = USAGE_KEYS.input.some((k) =>
    Object.prototype.hasOwnProperty.call(usage, k),
  );
  if (!hasInputKey) return null;

  const inputTokens = pickField(usage, USAGE_KEYS.input);
  if (inputTokens === null) return null;

  let cacheCreationInputTokens = 0;
  if (USAGE_KEYS.cacheCreation.some((k) => Object.prototype.hasOwnProperty.call(usage, k))) {
    const v = pickField(usage, USAGE_KEYS.cacheCreation);
    if (v === null) return null;
    cacheCreationInputTokens = v;
  }

  let cacheReadInputTokens = 0;
  if (USAGE_KEYS.cacheRead.some((k) => Object.prototype.hasOwnProperty.call(usage, k))) {
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
