import type { ViewCompactParams } from "lhc";
import { DEFAULT_COMPACT_PROFILE } from "./profile.js";

// Per-model compact settings: how large the PI context may grow before the
// connector triggers a smart compact (triggerTokens), and how much survives
// one (lowerBound + band percentages). Models are matched by case-insensitive
// substring against the active model id, first match wins; unmatched models
// get the default profile with NO connector-side trigger (PI's own
// contextWindow − reserveTokens threshold remains the backstop for those).
//
// Rationale for shipping triggers well under the model window: the first few
// compacts on a young thread fill only the full and smooth bands, so waiting
// for the native threshold (~984k on a 1M model) means working degraded for
// hundreds of thousands of tokens before the first compact.

export interface CompactPercentages {
  full: number;
  smooth: number;
  detailed: number;
  brief: number;
}

export interface ModelCompactSettings {
  /** Case-insensitive substring matched against the active model id. */
  match: string;
  /** Auto-trigger a smart compact when PI context usage reaches this many
   *  tokens. Omitted → no connector-side trigger for this model. */
  triggerTokens?: number;
  /** Post-compact target size in tokens (ViewCompactParams.lowerBound). */
  lowerBound: number;
  percentages: CompactPercentages;
}

const DEFAULT_PERCENTAGES: CompactPercentages = { ...DEFAULT_COMPACT_PROFILE.percentages };

/** Shipped per-model settings (first match wins). */
export const DEFAULT_MODEL_COMPACT_SETTINGS: readonly ModelCompactSettings[] = [
  // fable: tightened 2026-08-10 (was 500k/240k; before that 350k/140k). The
  // 500k trial showed degraded coherence in the upper range; 400k caps that.
  // 200k floor observed to land ~230k post-compact. Not tighter: every
  // compact is a near-total prompt-cache miss, so cycles must stay long
  // enough to amortize it.
  { match: "fable", triggerTokens: 400_000, lowerBound: 200_000, percentages: { ...DEFAULT_PERCENTAGES } },
  { match: "glm", triggerTokens: 350_000, lowerBound: 140_000, percentages: { ...DEFAULT_PERCENTAGES } },
  { match: "grok", triggerTokens: 300_000, lowerBound: 100_000, percentages: { ...DEFAULT_PERCENTAGES } },
  // sol: no connector trigger. Its 272k window puts PI's native threshold at
  // 272,000 − 16,384 = 255,616 — the intended ~255k trigger already. A
  // connector trigger at the same point double-fires and races PI's own
  // compaction check; the native trigger alone routes through
  // session_before_compact, where this lowerBound still applies.
  { match: "sol", lowerBound: 120_000, percentages: { ...DEFAULT_PERCENTAGES } },
];

/** Fallback when no entry matches: default profile, no connector trigger. */
export const FALLBACK_COMPACT_SETTINGS: ModelCompactSettings = {
  match: "",
  lowerBound: DEFAULT_COMPACT_PROFILE.lowerBound,
  percentages: { ...DEFAULT_PERCENTAGES },
};

export class CompactSettingsValidationError extends Error {
  constructor(detail: string) {
    super(`Invalid model compact settings: ${detail}`);
    this.name = "CompactSettingsValidationError";
  }
}

/** Parse the per-session CLI/env form in full,smooth,detailed,brief order. */
export function parseCompactPercentages(value: string): CompactPercentages {
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    throw new CompactSettingsValidationError(
      "band percentages must be four non-negative numbers in full,smooth,detailed,brief order",
    );
  }
  const [full, smooth, detailed, brief] = parts as [number, number, number, number];
  const sum = full + smooth + detailed + brief;
  if (sum !== 100) {
    throw new CompactSettingsValidationError(`band percentages must sum to 100 (got ${sum})`);
  }
  return { full, smooth, detailed, brief };
}

export function withCompactPercentages(
  settings: ModelCompactSettings,
  percentages: CompactPercentages | null,
): ModelCompactSettings {
  return percentages === null ? settings : { ...settings, percentages: { ...percentages } };
}

function validateEntry(entry: ModelCompactSettings, label: string): void {
  if (entry.match.trim() === "" && label !== "fallback") {
    throw new CompactSettingsValidationError(`${label}: match must be a non-empty string`);
  }
  if (!Number.isFinite(entry.lowerBound) || entry.lowerBound <= 0) {
    throw new CompactSettingsValidationError(`${label}: lowerBound must be a positive number`);
  }
  const p = entry.percentages;
  const sum = p.full + p.smooth + p.detailed + p.brief;
  if (sum !== 100) {
    throw new CompactSettingsValidationError(`${label}: band percentages must sum to 100 (got ${sum})`);
  }
  if (entry.triggerTokens !== undefined) {
    if (!Number.isFinite(entry.triggerTokens) || entry.triggerTokens <= 0) {
      throw new CompactSettingsValidationError(`${label}: triggerTokens must be a positive number`);
    }
    if (entry.triggerTokens <= entry.lowerBound) {
      throw new CompactSettingsValidationError(
        `${label}: triggerTokens (${entry.triggerTokens}) must exceed lowerBound (${entry.lowerBound}) — compacting would reclaim nothing`,
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Load operator config for model compact settings. `undefined` → shipped
 *  defaults. A config replaces the whole table (like host-level maps in
 *  other operator config: explicit ownership, no per-entry merging).
 *  Fails loud on malformed entries — never silently drops a key. */
export function loadModelCompactSettings(config: unknown): readonly ModelCompactSettings[] {
  if (config === undefined || config === null) {
    for (const [i, entry] of DEFAULT_MODEL_COMPACT_SETTINGS.entries()) validateEntry(entry, `defaults[${i}]`);
    return DEFAULT_MODEL_COMPACT_SETTINGS;
  }
  if (!Array.isArray(config)) {
    throw new CompactSettingsValidationError("config must be an array of entries");
  }
  const entries: ModelCompactSettings[] = config.map((raw, i) => {
    if (!isRecord(raw)) throw new CompactSettingsValidationError(`entry[${i}] must be an object`);
    const known = new Set(["match", "triggerTokens", "lowerBound", "percentages"]);
    for (const key of Object.keys(raw)) {
      if (!known.has(key)) throw new CompactSettingsValidationError(`entry[${i}] has unknown key '${key}'`);
    }
    if (typeof raw.match !== "string") throw new CompactSettingsValidationError(`entry[${i}].match must be a string`);
    if (typeof raw.lowerBound !== "number") {
      throw new CompactSettingsValidationError(`entry[${i}].lowerBound must be a number`);
    }
    const pct = raw.percentages ?? { ...DEFAULT_PERCENTAGES };
    if (
      !isRecord(pct) ||
      typeof pct.full !== "number" ||
      typeof pct.smooth !== "number" ||
      typeof pct.detailed !== "number" ||
      typeof pct.brief !== "number"
    ) {
      throw new CompactSettingsValidationError(`entry[${i}].percentages must have numeric full/smooth/detailed/brief`);
    }
    const entry: ModelCompactSettings = {
      match: raw.match,
      lowerBound: raw.lowerBound,
      percentages: { full: pct.full, smooth: pct.smooth, detailed: pct.detailed, brief: pct.brief },
      ...(raw.triggerTokens !== undefined ? { triggerTokens: raw.triggerTokens as number } : {}),
    };
    validateEntry(entry, `entry[${i}]`);
    return entry;
  });
  return entries;
}

/** Resolve the compact settings for a model id (first substring match wins). */
export function resolveModelCompactSettings(
  modelId: string | undefined,
  table: readonly ModelCompactSettings[] = DEFAULT_MODEL_COMPACT_SETTINGS,
): ModelCompactSettings {
  if (modelId !== undefined && modelId !== "") {
    const haystack = modelId.toLowerCase();
    for (const entry of table) {
      if (entry.match !== "" && haystack.includes(entry.match.toLowerCase())) return entry;
    }
  }
  return FALLBACK_COMPACT_SETTINGS;
}

/** The ViewCompactParams slice of a settings entry, for preview/compact calls. */
export function toCompactParams(settings: ModelCompactSettings): ViewCompactParams {
  return { lowerBound: settings.lowerBound, percentages: { ...settings.percentages } };
}

/** Retrigger only after real growth: a cancelled attempt (e.g. capture
 *  incomplete) must not be hammered every turn at the same size. */
export const AUTO_COMPACT_RETRY_GROWTH_TOKENS = 25_000;

/** Pure decision: should the connector trigger a smart compact now? */
export function shouldTriggerModelCompact(args: {
  contextTokens: number | null | undefined;
  triggerTokens: number | undefined;
  inFlight: boolean;
  lastAttemptTokens: number | null;
  retryGrowthTokens?: number;
}): boolean {
  const { contextTokens, triggerTokens, inFlight, lastAttemptTokens } = args;
  if (triggerTokens === undefined) return false;
  if (contextTokens === null || contextTokens === undefined) return false;
  if (inFlight) return false;
  if (contextTokens < triggerTokens) return false;
  const growth = args.retryGrowthTokens ?? AUTO_COMPACT_RETRY_GROWTH_TOKENS;
  if (lastAttemptTokens !== null && contextTokens < lastAttemptTokens + growth) return false;
  return true;
}
