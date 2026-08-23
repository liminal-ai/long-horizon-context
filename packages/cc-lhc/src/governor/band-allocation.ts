/**
 * Product Band % allocations. CC-LHC exposes exactly three presets; the
 * bounded selector stays in core LHC. Mapping to an internal core profile
 * happens only at mutation preparation.
 */
import type { ViewProfileOverride } from "lhc";

import type { ContextPolicy, ResolvedContextPolicy } from "./types.js";

export type BandAllocationId = "default" | "balanced" | "historical";

export type InternalCoreProfile = "continuation" | "cc-lhc-balanced" | "cc-lhc-historical";

export interface BandAllocation {
  id: BandAllocationId;
  label: "Default" | "Balanced" | "Historical";
  description: string;
  low: number;
  medium: number;
  high: number;
  full: number;
  coreProfile: InternalCoreProfile;
}

/** Construction default for host-supplied profiles; mutation passes the active target explicitly. */
export const HOST_PROFILE_CONSTRUCTION_LOWER_BOUND = 120_000;

export const ACCEPTED_BOUNDED_CORE_SOURCE_COMMIT = "1cfce5d5b45258150278a5699657a2481de5a48e";

/** Campaign HEAD onto which the accepted core source patch was applied. Final Story-2 commit is a later qualification receipt. */
export const ADAPTATION_BASE_COMMIT = "da5e9bbb6a66728e78ae57fce4c51268b40731a6";

export const BAND_ALLOCATIONS: readonly BandAllocation[] = [
  {
    id: "default",
    label: "Default",
    description: "favors recent history",
    low: 20,
    medium: 20,
    high: 30,
    full: 30,
    coreProfile: "continuation",
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "equal fidelity distribution",
    low: 25,
    medium: 25,
    high: 25,
    full: 25,
    coreProfile: "cc-lhc-balanced",
  },
  {
    id: "historical",
    label: "Historical",
    description: "broader low-fidelity history",
    low: 30,
    medium: 20,
    high: 30,
    full: 20,
    coreProfile: "cc-lhc-historical",
  },
];

export const PRODUCT_PRESET_IDS: readonly BandAllocationId[] = BAND_ALLOCATIONS.map((allocation) => allocation.id);

const BY_ID = new Map(BAND_ALLOCATIONS.map((allocation) => [allocation.id, allocation]));

export function isBandAllocationId(value: string): value is BandAllocationId {
  return BY_ID.has(value as BandAllocationId);
}

export function allocationById(id: BandAllocationId): BandAllocation {
  const allocation = BY_ID.get(id);
  if (allocation === undefined) {
    throw new TypeError(`cc-lhc: unknown product preset ${JSON.stringify(id)}`);
  }
  return allocation;
}

export function mutationCoreProfile(profile: string): InternalCoreProfile {
  if (!isBandAllocationId(profile)) {
    throw new TypeError(
      `cc-lhc: unknown product preset ${JSON.stringify(profile)}; expected ${PRODUCT_PRESET_IDS.join(", ")}`,
    );
  }
  return allocationById(profile).coreProfile;
}

/** SDK compact construction: internal profile plus the active policy target. */
export function compactConstruction(policy: Pick<ContextPolicy, "profile" | "lowerBoundTokens">): {
  profile: InternalCoreProfile;
  params: { lowerBound: number };
} {
  return {
    profile: mutationCoreProfile(policy.profile),
    params: { lowerBound: policy.lowerBoundTokens },
  };
}

function hostProfile(allocation: BandAllocation): ViewProfileOverride {
  return {
    name: allocation.coreProfile,
    lowerBound: HOST_PROFILE_CONSTRUCTION_LOWER_BOUND,
    percentages: {
      brief: allocation.low,
      detailed: allocation.medium,
      smooth: allocation.high,
      full: allocation.full,
    },
  };
}

/** Complete host-supplied profiles injected into every mutation-capable SDK. */
export const HOST_VIEW_PROFILES: readonly ViewProfileOverride[] = BAND_ALLOCATIONS.filter(
  (allocation) => allocation.id !== "default",
).map(hostProfile);

export const CAPTURE_VIEW_CONFIG = { profiles: [...HOST_VIEW_PROFILES] };

export function applySessionAllocation(
  resolved: ResolvedContextPolicy,
  id: BandAllocationId,
): ResolvedContextPolicy {
  return {
    policy: { ...resolved.policy, profile: id },
    sources: { ...resolved.sources, profile: "session" },
    fallbacks: resolved.fallbacks.filter((fallback) => fallback.field !== "profile"),
  };
}
