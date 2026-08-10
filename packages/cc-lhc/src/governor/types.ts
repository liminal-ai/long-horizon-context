/**
 * Slice 3 context policy and observe-only governor types.
 * No mutation; decisions name what would happen and why.
 */

/** Where each effective field came from (Slice 5 status/help). */
export type PolicyFieldSource = "builtin" | "user" | "project" | "session";

/** Native Claude compact posture. Strict DISABLE_COMPACT is optional later. */
export type NativeCompactMode = "emergency_backstop";

/**
 * Validated effective context policy.
 * `observeOnly` is always true in Slice 3 regardless of autoCompact intent.
 */
export interface ContextPolicy {
  /** Intent to auto-compact when Slice 4 activates; Slice 3 never executes. */
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
  /** Intermediate automatic prune; off by default; never executed in Slice 3. */
  pruneEnabled: boolean;
  pruneThresholdTokens: number | null;
  pruneTargetTokens: number | null;
  /** Always true in Slice 3. */
  observeOnly: true;
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

/**
 * Pure governor inputs at a settled-turn observation point.
 * All fields are explicit; no I/O.
 */
export interface GovernorInput {
  policy: ContextPolicy;
  policyArmed: boolean;
  /** True when the turn is still open (should not decide compact). */
  turnOpen: boolean;
  /**
   * When true, this settle observation is considered stale (e.g. already
   * decided for this settle generation, or fold says open after settle).
   */
  settleStale: boolean;
  /** Provider context for the latest completed sampling attempt of the turn. */
  providerContext: ProviderContextTokens | null;
  /** Capture healthy and ready. */
  captureHealthy: boolean;
  captureGeneration: number;
  /** Runtime descriptor ready for this session. */
  descriptorReady: boolean;
  /** Compact/prune/handoff already in flight (Slice 4; always false in S3). */
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
   * Provider total at the last would_compact for this capture generation.
   * Null if never would_compact in this generation.
   */
  lastWouldCompactProviderTotal: number | null;
  lastWouldCompactCaptureGeneration: number | null;
}

export interface GovernorDecision {
  kind: GovernorDecisionKind;
  reason: string;
  providerContextTotal: number | null;
  upperBoundTokens: number;
  lowerBoundTokens: number;
  wouldMutate: false;
}

/** Structured observe record written to the wrapper log (not PTY). */
export interface GovernorObserveRecord {
  event: "governor_observe";
  decision: GovernorDecisionKind;
  reason: string;
  providerContextTotal: number | null;
  providerContext: ProviderContextTokens | null;
  upperBoundTokens: number;
  lowerBoundTokens: number;
  profile: string;
  autoCompactIntent: boolean;
  observeOnly: true;
  wouldMutate: false;
  policyArmed: boolean;
  policySourcesSummary: string;
  captureGeneration: number;
  inputEpoch: number;
  inputEpochAtTurnOpen: number;
  settleSequence: number;
  samplingId: string | null;
}
