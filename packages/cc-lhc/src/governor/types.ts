import type { TokenFamilySource } from "lhc";

export type { TokenFamilySource };

export type PolicyFieldSource = "builtin" | "user" | "project" | "session";

export type CcLhcHostCapability = "capability_limited";

export const CC_LHC_HOST_CAPABILITY: CcLhcHostCapability = "capability_limited";

export type SourceLabelledEstimateDomain = "source_labelled_estimate";

export interface PostMeasurementEstimate {
  tokens: number;
  source: string;
  domain: SourceLabelledEstimateDomain;
}

export const EMPTY_POST_MEASUREMENT_ESTIMATE: PostMeasurementEstimate = {
  tokens: 0,
  source: "lhc_token_estimate",
  domain: "source_labelled_estimate",
};

export interface ContextPolicy {
  lowerBoundTokens: number;
  upperBoundTokens: number;
  profile: string;
  pruneEnabled: boolean;
  pruneThresholdTokens: number | null;
  pruneTargetTokens: number | null;
  minRunwayTokens: number;
}

export type PolicyFieldKey = keyof ContextPolicy;

export type PolicyFieldSources = {
  [K in PolicyFieldKey]: PolicyFieldSource;
};

export interface ResolvedContextPolicy {
  policy: ContextPolicy;
  sources: PolicyFieldSources;
  fallbacks: readonly ConfigFallback[];
}

export interface ConfigFallback {
  origin: string;
  field: PolicyFieldKey | null;
  detail: string;
}

export type ContextPolicyPartial = {
  lowerBoundTokens?: number;
  upperBoundTokens?: number;
  profile?: string;
  pruneEnabled?: boolean;
  pruneThresholdTokens?: number | null;
  pruneTargetTokens?: number | null;
  minRunwayTokens?: number;
};

export interface ProviderContextTokens {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  total: number;
}

export type GovernorDecisionKind = "would_compact" | "below_threshold" | "turn_open" | "operation_in_flight";

export type GovernorObservePhase = "open_turn" | "settled_seam";

export type ProviderBaseFreshness = "current_sampling" | "last_known" | "none";

export interface GovernorPressureReceipt {
  providerBaseTokens: number | null;
  providerBaseDomain: "provider_reported_input";
  providerBaseFreshness: ProviderBaseFreshness;
  estimateTokens: number;
  estimateSource: string;
  estimateDomain: SourceLabelledEstimateDomain;
  nextRequestPressureTokens: number;
  upperTriggerTokens: number;
  atOrAboveTrigger: boolean;
}

export interface GovernorInput {
  policy: ContextPolicy;
  turnOpen: boolean;
  providerContext: ProviderContextTokens | null;
  providerContextFreshness: ProviderBaseFreshness;
  postMeasurementEstimate: PostMeasurementEstimate;
  operationInFlight: boolean;
  contextLimitRejected: boolean;
}

export interface GovernorDecision {
  kind: GovernorDecisionKind;
  reason: string;
  providerContextTotal: number | null;
  pressure: GovernorPressureReceipt;
  upperBoundTokens: number;
  lowerBoundTokens: number;
  wouldMutate: boolean;
}

export interface GovernorObserveRecord {
  event: "governor_observe";
  hostCapability: CcLhcHostCapability;
  observePhase: GovernorObservePhase;
  decision: GovernorDecisionKind;
  reason: string;
  providerContextTotal: number | null;
  providerContext: ProviderContextTokens | null;
  postMeasurementEstimate: PostMeasurementEstimate;
  pressure: GovernorPressureReceipt;
  upperBoundTokens: number;
  lowerBoundTokens: number;
  profile: string;
  tokenFamily: string;
  tokenFamilySource: TokenFamilySource;
  wouldMutate: boolean;
  configFallbackCount: number;
  policySourcesSummary: string;
  captureGeneration: number;
  inputEpoch: number;
  inputEpochAtTurnOpen: number;
  observeSequence: number;
  settleSequence: number | null;
  samplingId: string | null;
}

export interface GovernorDurableReceipt {
  receiptId: string;
  sessionId: string | null;
  threadId: string | null;
  observePhase: GovernorObservePhase;
  decision: GovernorDecisionKind;
  reason: string;
  wouldMutate: boolean;
  hostCapability: CcLhcHostCapability;
  providerContextTotal: number | null;
  postMeasurementEstimate: PostMeasurementEstimate;
  pressure: GovernorPressureReceipt;
  captureGeneration: number;
  inputEpoch: number;
  inputEpochAtTurnOpen: number;
  observeSequence: number;
  settleSequence: number | null;
  samplingId: string | null;
  handoffOutcome: GovernorHandoffOutcome | null;
  observe: GovernorObserveRecord;
  createdAt: string;
  updatedAt: string;
}

export type GovernorHandoffOutcome =
  | { kind: "not_applicable" }
  | { kind: "deferred_open_turn" }
  | { kind: "scheduled" }
  | { kind: "mutation_deferred"; detail: string; reason: GovernorMutationDeferReason }
  | { kind: "mutation_refused"; detail: string }
  | { kind: "mutation_partial"; detail: string }
  | { kind: "mutation_noop"; detail: string }
  | {
      kind: "handoff_success";
      newSessionId: string;
      droppedInputBytes: number;
      orphanPid?: number;
      handoffId?: string;
    }
  | { kind: "handoff_cancelled"; detail: string }
  | {
      kind: "handoff_replacement_nonviable";
      detail: string;
      oldSessionId: string;
      rebuiltSessionId: string;
      attempts: number;
    };

export type GovernorMutationDeferReason =
  | "auto_operation_in_flight"
  | "handoff_in_progress"
  | "wrapper_exiting"
  | "command_guard_busy"
  | "one_shot_next_invocation"
  | "capture_catching_up";
