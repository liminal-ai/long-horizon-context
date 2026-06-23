// Profile config resolution and validation: built-in profiles, user profiles
// merged over them by name, and the budget rules. Band shares sum to 100, lower
// bound is positive, visibility max is greater than target. Pure functions, no
// IO. Config mistakes are programmer errors at SDK construction and throw
// naming the violation; nothing here returns OpResults.
import type {
  ResolvedViewConfig,
  SdkViewConfig,
  ViewProfile,
  ViewProfileOverride,
  VisibilityBudgets,
} from "../../shared-tech/index.js";

// Built-in profiles: defaults and knobs, not architecture.
export const BUILT_IN_PROFILES: readonly ViewProfile[] = [
  {
    name: "continuation",
    lowerBound: 120000,
    percentages: { full: 30, smooth: 30, detailed: 20, brief: 20 },
  },
  {
    name: "conversation",
    lowerBound: 120000,
    percentages: { full: 12, smooth: 48, detailed: 20, brief: 20 },
  },
  {
    name: "coding",
    lowerBound: 120000,
    percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 },
  },
];

export const DEFAULT_VISIBILITY: VisibilityBudgets = {
  maxTokens: 64000,
  targetTokens: 32000,
};

export const DEFAULT_COMPACT_THRESHOLD = 160000;

function fail(detail: string): never {
  throw new TypeError(`initLhc config: view: ${detail}`);
}

const BAND_KEYS = ["full", "smooth", "detailed", "brief"] as const;

// The violated constraint, named, or null when the profile is sound: one
// rule set shared by both rejection surfaces — SDK construction (throws,
// below) and compact invocation (caller-error result).
export function profileViolation(profile: ViewProfile): string | null {
  if (!Number.isFinite(profile.lowerBound) || profile.lowerBound <= 0) {
    return `profile "${profile.name}": lowerBound must be a positive number, got ${profile.lowerBound}`;
  }
  for (const key of BAND_KEYS) {
    const share = profile.percentages[key];
    if (!Number.isFinite(share) || share < 0) {
      return `profile "${profile.name}": percentage ${key} must be a non-negative number, got ${share}`;
    }
  }
  const sum = BAND_KEYS.reduce((total, key) => total + profile.percentages[key], 0);
  if (sum !== 100) {
    return `profile "${profile.name}": percentages must sum to 100, got ${sum}`;
  }
  return null;
}

// A complete, merged profile validates whole: positive lower bound, finite
// non-negative shares, shares summing to exactly 100. Errors name the
// violated constraint and the profile.
export function validateProfile(profile: ViewProfile): void {
  const violation = profileViolation(profile);
  if (violation !== null) fail(violation);
}

function isCompleteOverride(entry: ViewProfileOverride): boolean {
  return (
    entry.lowerBound !== undefined &&
    entry.percentages !== undefined &&
    BAND_KEYS.every((key) => entry.percentages?.[key] !== undefined)
  );
}

// Merge one configured entry: field-wise over the built-in it names, or — for
// a name no built-in carries — the entry must be complete, since there is
// nothing to merge over.
function mergeProfile(entry: ViewProfileOverride, base: ViewProfile | undefined): ViewProfile {
  if (base === undefined) {
    if (!isCompleteOverride(entry)) {
      fail(
        `profile "${entry.name}" is partial but overrides no built-in (unknown built-in override target); built-ins are ${BUILT_IN_PROFILES.map((p) => `"${p.name}"`).join(", ")} — a new profile must carry lowerBound and all four percentages`,
      );
    }
    return {
      name: entry.name,
      lowerBound: entry.lowerBound as number,
      percentages: {
        full: entry.percentages?.full as number,
        smooth: entry.percentages?.smooth as number,
        detailed: entry.percentages?.detailed as number,
        brief: entry.percentages?.brief as number,
      },
    };
  }
  return {
    name: entry.name,
    lowerBound: entry.lowerBound ?? base.lowerBound,
    percentages: {
      full: entry.percentages?.full ?? base.percentages.full,
      smooth: entry.percentages?.smooth ?? base.percentages.smooth,
      detailed: entry.percentages?.detailed ?? base.percentages.detailed,
      brief: entry.percentages?.brief ?? base.percentages.brief,
    },
  };
}

const BUDGET_KEYS = ["maxTokens", "targetTokens"] as const;

function resolveVisibility(partial: Partial<VisibilityBudgets> | undefined): VisibilityBudgets {
  // Unknown budget fields are config mistakes, not silent passengers.
  for (const key of Object.keys(partial ?? {})) {
    if (!(BUDGET_KEYS as readonly string[]).includes(key)) {
      fail(`visibility.${key} is not a budget field (budgets are maxTokens and targetTokens)`);
    }
  }
  const visibility: VisibilityBudgets = {
    maxTokens: partial?.maxTokens ?? DEFAULT_VISIBILITY.maxTokens,
    targetTokens: partial?.targetTokens ?? DEFAULT_VISIBILITY.targetTokens,
  };
  for (const key of BUDGET_KEYS) {
    if (!Number.isFinite(visibility[key]) || visibility[key] <= 0) {
      fail(`visibility.${key} must be a positive number, got ${visibility[key]}`);
    }
  }
  // The budget ordering rule: max > target.
  if (visibility.maxTokens <= visibility.targetTokens) {
    fail(
      `visibility.maxTokens (${visibility.maxTokens}) must be greater than targetTokens (${visibility.targetTokens})`,
    );
  }
  return visibility;
}

// The one resolution path: built-ins, user profiles merged by name, every
// resolved profile validated, visibility and threshold defaulted and checked.
// Called from initLhc so validation runs through real construction.
export function resolveViewConfig(config?: SdkViewConfig): ResolvedViewConfig {
  const profiles: Record<string, ViewProfile> = {};
  for (const builtIn of BUILT_IN_PROFILES) {
    profiles[builtIn.name] = builtIn;
  }
  for (const entry of config?.profiles ?? []) {
    if (typeof entry.name !== "string" || entry.name.length === 0) {
      fail(`profile entries must carry a non-empty name`);
    }
    profiles[entry.name] = mergeProfile(entry, profiles[entry.name]);
  }
  for (const profile of Object.values(profiles)) {
    validateProfile(profile);
  }

  const compactThreshold = config?.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
  if (!Number.isFinite(compactThreshold) || compactThreshold <= 0) {
    fail(`compactThreshold must be a positive number, got ${compactThreshold}`);
  }

  return {
    profiles,
    visibility: resolveVisibility(config?.visibility),
    compactThreshold,
  };
}
