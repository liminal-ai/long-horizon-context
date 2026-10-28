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

export const HOST_PROFILE_CONSTRUCTION_LOWER_BOUND = 120_000;

export const ACCEPTED_BOUNDED_CORE_SOURCE_COMMIT = "1cfce5d5b45258150278a5699657a2481de5a48e";

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

export function segmentThresholdTokens(policy: Pick<ContextPolicy, "profile" | "lowerBoundTokens">): number {
  const allocation = allocationById(policy.profile as BandAllocationId);
  return (policy.lowerBoundTokens * allocation.full) / 100 / 2;
}

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

export const HOST_VIEW_PROFILES: readonly ViewProfileOverride[] = BAND_ALLOCATIONS.filter(
  (allocation) => allocation.id !== "default",
).map(hostProfile);

export const CAPTURE_VIEW_CONFIG = { profiles: [...HOST_VIEW_PROFILES] };

export function applySessionAllocation(resolved: ResolvedContextPolicy, id: BandAllocationId): ResolvedContextPolicy {
  return {
    ...resolved,
    policy: { ...resolved.policy, profile: id },
    sources: { ...resolved.sources, profile: "session" },
    fallbacks: resolved.fallbacks.filter((fallback) => fallback.field !== "profile"),
  };
}
