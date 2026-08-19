/**
 * Context policy and capability-limited governor types.
 *
 * Two things decide an automatic compact: the user's explicit `autoCompact`
 * policy and measured pressure. Everything else the wrapper knows — capture
 * health, descriptor state, receipts, input epochs — is diagnostics and has no
 * blocking authority here.
 *
 * Decisions name what would happen and why. Claude Code has no in-place
 * mid-agentic-turn request replacement: open-turn classifications are recorded
 * with wouldMutate=false; mutation/handoff only at a settled Claude-safe seam.
 */

/** Where each effective field came from (Slice 5 status/help). */
export type PolicyFieldSource = "builtin" | "user" | "project" | "session";

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
 * Effective context policy. Always usable: invalid fields fall back to
 * built-in defaults with a visible notice, never to a disabled product.
 */
export interface ContextPolicy {
  /**
   * Execute automatic compact at would_compact decisions. Defaults on; only an
   * explicit user choice (config file or panel edit) turns it off.
   */
  autoCompact: boolean;
  /** LHC compact construction target (tokens). */
  lowerBoundTokens: number;
  /** Provider-context pressure trigger (tokens). */
  upperBoundTokens: number;
  /** Canonical LHC band profile name (SDK built-in). */
  profile: string;
  /**
   * Combined compact-time prune; off by default. When enabled with coherent
   * threshold/target, an automatic or manual compact prunes first and
   * materializes once. There is no separate intermediate-prune trigger.
   */
  pruneEnabled: boolean;
  pruneThresholdTokens: number | null;
  pruneTargetTokens: number | null;
  /** Minimum upper − lower runway required at validation. */
  minRunwayTokens: number;
}

export type PolicyFieldKey = keyof ContextPolicy;

export type PolicyFieldSources = {
  [K in PolicyFieldKey]: PolicyFieldSource;
};

/**
 * The loaded policy plus what had to be replaced to get there. There is no
 * armed flag: bad configuration falls back per field and the product stays
 * automatically compactable.
 */
export interface ResolvedContextPolicy {
  policy: ContextPolicy;
  sources: PolicyFieldSources;
  /**
   * Per-field fallbacks applied because a configured value was unknown,
   * malformed, or incoherent. Empty when configuration was fully usable.
   */
  fallbacks: readonly ConfigFallback[];
}

/** One configured value replaced by its built-in default. */
export interface ConfigFallback {
  /** Where the bad value came from, e.g. `user config /path/config.json`. */
  origin: string;
  /** Field replaced, or null when a whole configuration layer was unreadable. */
  field: PolicyFieldKey | null;
  /** What was wrong, in the operator's terms. */
  detail: string;
}

/** Raw partial from JSON / session overrides (unknown fields rejected). */
export type ContextPolicyPartial = {
  autoCompact?: boolean;
  lowerBoundTokens?: number;
  upperBoundTokens?: number;
  profile?: string;
  pruneEnabled?: boolean;
  pruneThresholdTokens?: number | null;
  pruneTargetTokens?: number | null;
  minRunwayTokens?: number;
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
  | "below_threshold"
  | "turn_open"
  | "operation_in_flight"
  | "policy_disabled";

/** Observation phase: open agentic turn vs Claude-safe settled seam. */
export type GovernorObservePhase = "open_turn" | "settled_seam";

/**
 * Where the provider base of a pressure reading came from.
 *
 * `current_sampling` is this turn's own provider-reported usage.
 * `last_known` is the newest valid provider reading the session has seen,
 * carried forward because the latest sampling was missing or malformed — still
 * a provider-reported number, just an older one, and labelled so nobody reads
 * it as fresh.
 * `none` means no provider reading has ever arrived in this session.
 */
export type ProviderBaseFreshness = "current_sampling" | "last_known" | "none";

/**
 * Predicted next-request pressure receipt fields.
 * providerBase + estimate; estimate is never counted as provider usage.
 */
export interface GovernorPressureReceipt {
  /** null only when no provider reading has ever arrived. */
  providerBaseTokens: number | null;
  providerBaseDomain: "provider_reported_input";
  /** Whether the base is this turn's reading or a carried-forward one. */
  providerBaseFreshness: ProviderBaseFreshness;
  estimateTokens: number;
  estimateSource: string;
  estimateDomain: SourceLabelledEstimateDomain;
  /** Provider base (0 when none has ever arrived) plus the labelled estimate. */
  nextRequestPressureTokens: number;
  upperTriggerTokens: number;
  atOrAboveTrigger: boolean;
}

/**
 * Pure governor inputs at an observation point (open-turn or settled seam).
 * All fields are explicit; no I/O.
 */
export interface GovernorInput {
  policy: ContextPolicy;
  /** True when the agentic turn is still open (no mutation/handoff). */
  turnOpen: boolean;
  /** Newest valid provider reading; carried forward across turns. */
  providerContext: ProviderContextTokens | null;
  /** Whether providerContext is this turn's own sampling. */
  providerContextFreshness: ProviderBaseFreshness;
  /**
   * Source-labelled estimate of content captured after the last provider
   * measurement. Zero when nothing post-measurement has been captured.
   */
  postMeasurementEstimate: PostMeasurementEstimate;
  /** Compact/prune/handoff already in flight. */
  operationInFlight: boolean;
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
   * True only for would_compact under an enabled policy at a settled seam —
   * the wrapper's cue to start the automatic operation. Always false while the
   * turn is open (capability boundary).
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
  wouldMutate: boolean;
  /** Count of configured values replaced by built-in defaults at load. */
  configFallbackCount: number;
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

/**
 * Durable outcome attached to a governor receipt.
 *
 * `scheduled` means an automatic operation currently owns the receipt (or the
 * wrapper crashed after insert and before claim). If no operation starts, the
 * wrapper attaches a terminal outcome instead (mutation_deferred /
 * mutation_refused) so replay is inspectable.
 */
export type GovernorHandoffOutcome =
  | { kind: "not_applicable" }
  | { kind: "deferred_open_turn" }
  | { kind: "scheduled" }
  /**
   * The mutation never started — coalesced, the wrapper was busy, capture was
   * catching up. A deferral costs the next seam nothing: the same receipt is
   * retried on replay, and a later distinct receipt runs normally.
   */
  | { kind: "mutation_deferred"; detail: string; reason: GovernorMutationDeferReason }
  | { kind: "mutation_refused"; detail: string }
  | { kind: "mutation_partial"; detail: string }
  | { kind: "mutation_noop"; detail: string }
  | {
      kind: "handoff_success";
      newSessionId: string;
      /** Typed-ahead bytes dropped while compact owned input (never replayed). */
      droppedInputBytes: number;
      /** Old child that survived termination and was left running. */
      orphanPid?: number;
    }
  | { kind: "handoff_cancelled"; detail: string }
  /**
   * The replacement never became viable, so nothing was switched: the old
   * session is still live and untouched. There is no rolled-back or failed
   * outcome — a swap either happens or never starts.
   */
  | {
      kind: "handoff_replacement_nonviable";
      detail: string;
      oldSessionId: string;
      rebuiltSessionId: string;
      attempts: number;
    };

/** Stable reason codes for mutation_deferred (inspectable, not free-form only). */
export type GovernorMutationDeferReason =
  | "auto_operation_in_flight"
  | "handoff_in_progress"
  | "wrapper_exiting"
  | "command_guard_busy"
  /**
   * A one-shot seat compacts at the start of the next invocation, before any
   * Claude process exists (R9) — never by swapping the child that is running
   * the prompt this seat was launched for.
   */
  | "one_shot_next_invocation"
  /** Capture is rebuilding/catching up from the transcript; re-evaluated on ready. */
  | "capture_catching_up";
