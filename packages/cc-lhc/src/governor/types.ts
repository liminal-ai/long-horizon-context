/**
 * Context policy and capability-limited governor types (LIM-64).
 *
 * Decisions name what would happen and why. Claude Code has no in-place
 * mid-agentic-turn request replacement: open-turn classifications are recorded
 * with wouldMutate=false; mutation/handoff only at a settled Claude-safe seam.
 */

/** Where each effective field came from (Slice 5 status/help). */
export type PolicyFieldSource = "builtin" | "user" | "project" | "session";

/** Native Claude compact posture. Strict DISABLE_COMPACT is optional later. */
export type NativeCompactMode = "emergency_backstop";

/**
 * cc-lhc host capability for compact governance.
 * Distinct from Codex `full_state_machine`: no same-agentic-turn continuation,
 * no tool-tail preservation claim, no in-place request replacement.
 */
export type CcLhcHostCapability = "capability_limited";

export const CC_LHC_HOST_CAPABILITY: CcLhcHostCapability = "capability_limited";

/** Shared LIM-60 domain label for post-measurement estimates. */
export type SourceLabelledEstimateDomain = "source_labelled_estimate";

/**
 * Source-labelled estimate of content captured after the last authoritative
 * provider request. Never relabelled as provider usage.
 */
export interface PostMeasurementEstimate {
  tokens: number;
  /** Host-owned label, e.g. "lhc_token_estimate". */
  source: string;
  domain: SourceLabelledEstimateDomain;
}

export const EMPTY_POST_MEASUREMENT_ESTIMATE: PostMeasurementEstimate = {
  tokens: 0,
  source: "lhc_token_estimate",
  domain: "source_labelled_estimate",
};

/**
 * Validated effective context policy.
 * Slice 4: `observeOnly` is a real mode — true logs decisions without executing.
 */
export interface ContextPolicy {
  /** Execute automatic compact at would_compact decisions (Slice 4 active). */
  autoCompact: boolean;
  /** LHC compact construction target (tokens). */
  lowerBoundTokens: number;
  /** Provider-context pressure trigger (tokens). */
  upperBoundTokens: number;
  /** Canonical LHC band profile name (SDK built-in). */
  profile: string;
  nativeCompactMode: NativeCompactMode;
  /** Documented native backstop (1e6 for supported Claude context). */
  nativeBackstopTokens: number;
  /**
   * Combined compact-time prune; off by default. When enabled with coherent
   * threshold/target, an automatic or manual compact prunes first and
   * materializes once. There is no separate intermediate-prune trigger.
   */
  pruneEnabled: boolean;
  pruneThresholdTokens: number | null;
  pruneTargetTokens: number | null;
  /** Log decisions without executing (session-only escape hatch). */
  observeOnly: boolean;
  /**
   * After a would_compact observation, require this much additional provider
   * context (or a new sampling generation) before another would_compact.
   */
  retryGrowthTokens: number;
  /** Minimum upper − lower runway required at validation. */
  minRunwayTokens: number;
}

export type PolicyFieldKey = keyof ContextPolicy;

export type PolicyFieldSources = {
  [K in PolicyFieldKey]: PolicyFieldSource;
};

export interface ResolvedContextPolicy {
  policy: ContextPolicy;
  sources: PolicyFieldSources;
  /** False when load/validate failed; governor cannot arm automatic intent. */
  armed: boolean;
  /** Human-readable validation/load errors (empty when armed). */
  errors: readonly string[];
}

/** Raw partial from JSON / session overrides (unknown fields rejected). */
export type ContextPolicyPartial = {
  autoCompact?: boolean;
  lowerBoundTokens?: number;
  upperBoundTokens?: number;
  profile?: string;
  nativeCompactMode?: NativeCompactMode;
  nativeBackstopTokens?: number;
  pruneEnabled?: boolean;
  pruneThresholdTokens?: number | null;
  pruneTargetTokens?: number | null;
  retryGrowthTokens?: number;
  minRunwayTokens?: number;
  /** Session-only; cannot be set in files. */
  observeOnly?: boolean;
};

/** Provider context for one unique sampling attempt. */
export interface ProviderContextTokens {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** input + cache_creation + cache_read */
  total: number;
}

/**
 * Explicit named governor decision kinds.
 * Open-turn threshold crossings still use these kinds with wouldMutate=false.
 */
export type GovernorDecisionKind =
  | "would_compact"
  | "no_provider_usage"
  | "below_threshold"
  | "turn_open"
  | "settle_stale"
  | "input_epoch_changed"
  | "capture_degraded"
  | "descriptor_not_ready"
  | "operation_in_flight"
  | "retry_growth_guard"
  | "policy_disabled"
  | "policy_invalid"
  | "native_summary_attention";

/** Observation phase: open agentic turn vs Claude-safe settled seam. */
export type GovernorObservePhase = "open_turn" | "settled_seam";

/**
 * Predicted next-request pressure receipt fields.
 * providerBase + estimate; estimate is never counted as provider usage.
 */
export interface GovernorPressureReceipt {
  providerBaseTokens: number | null;
  providerBaseDomain: "provider_reported_input";
  estimateTokens: number;
  estimateSource: string;
  estimateDomain: SourceLabelledEstimateDomain;
  /** null when provider usage is missing/invalid. */
  nextRequestPressureTokens: number | null;
  upperTriggerTokens: number;
  /** null when provider usage is missing/invalid. */
  atOrAboveTrigger: boolean | null;
}

/**
 * Pure governor inputs at an observation point (open-turn or settled seam).
 * All fields are explicit; no I/O.
 */
export interface GovernorInput {
  policy: ContextPolicy;
  policyArmed: boolean;
  /** True when the agentic turn is still open (no mutation/handoff). */
  turnOpen: boolean;
  /**
   * When true, this settle observation is considered stale (e.g. already
   * decided for this settle generation, or fold says open after settle).
   */
  settleStale: boolean;
  /** Provider context for the latest completed sampling attempt of the turn. */
  providerContext: ProviderContextTokens | null;
  /**
   * Source-labelled estimate of content captured after the last provider
   * measurement. Zero when nothing post-measurement has been captured.
   */
  postMeasurementEstimate: PostMeasurementEstimate;
  /** Capture healthy and ready. */
  captureHealthy: boolean;
  captureGeneration: number;
  /** Runtime descriptor ready for this session. */
  descriptorReady: boolean;
  /** Compact/prune/handoff already in flight. */
  operationInFlight: boolean;
  /**
   * Input epoch when the current turn opened. If currentInputEpoch differs,
   * user typed or queued input during the turn.
   */
  inputEpochAtTurnOpen: number;
  currentInputEpoch: number;
  /** Native compact summary needs operator attention. */
  nativeSummaryAttention: boolean;
  /**
   * Predicted next-request pressure at the last would_compact for this capture
   * generation (provider base used for hysteresis when estimate was zero).
   * Null if never would_compact in this generation.
   */
  lastWouldCompactProviderTotal: number | null;
  lastWouldCompactCaptureGeneration: number | null;
}

export interface GovernorDecision {
  kind: GovernorDecisionKind;
  reason: string;
  /** Authoritative provider total only (never includes estimate). */
  providerContextTotal: number | null;
  pressure: GovernorPressureReceipt;
  upperBoundTokens: number;
  lowerBoundTokens: number;
  /**
   * True only for would_compact under an armed, enabled, non-observe policy
   * at a settled seam — the wrapper's cue to start the automatic operation.
   * Always false while the turn is open (capability boundary).
   */
  wouldMutate: boolean;
}

/** Structured observe record: log line + durable receipt payload. */
export interface GovernorObserveRecord {
  event: "governor_observe";
  /** Stable contract posture for this host. */
  hostCapability: CcLhcHostCapability;
  /** open_turn = classified during an open agentic turn; settled_seam = Claude-safe. */
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
  autoCompactIntent: boolean;
  observeOnly: boolean;
  wouldMutate: boolean;
  policyArmed: boolean;
  policySourcesSummary: string;
  captureGeneration: number;
  inputEpoch: number;
  inputEpochAtTurnOpen: number;
  /** Monotonic observe counter (open-turn + settled). */
  observeSequence: number;
  /** Settle counter; null for open-turn observations. */
  settleSequence: number | null;
  samplingId: string | null;
}

/**
 * Durable receipt row: structured, restart-inspectable record of a
 * classification (and optional later handoff outcome).
 */
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
  /** Linked handoff/mutation outcome when known. */
  handoffOutcome: GovernorHandoffOutcome | null;
  /** Full observe payload for replay. */
  observe: GovernorObserveRecord;
  createdAt: string;
  updatedAt: string;
}

export type GovernorHandoffOutcome =
  | { kind: "not_applicable" }
  | { kind: "deferred_open_turn" }
  | { kind: "scheduled" }
  | { kind: "mutation_refused"; detail: string }
  | { kind: "mutation_partial"; detail: string }
  | { kind: "mutation_noop"; detail: string }
  | { kind: "handoff_success"; newSessionId: string; flushedInputBytes: number }
  | { kind: "handoff_cancelled"; detail: string }
  | { kind: "handoff_rolled_back"; detail: string; oldSessionId: string }
  | { kind: "handoff_failed"; detail: string; oldSessionId: string; rebuiltSessionId: string };
