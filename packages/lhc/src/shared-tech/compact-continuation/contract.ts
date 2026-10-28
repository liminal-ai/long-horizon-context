export const COMPACT_CONTINUATION_CONTRACT_VERSION = "2.0.0" as const;

export const CONTEXT_COMPACT_CONTINUE_REASON = "context_compact_continue" as const;

export const COMPACT_CONTINUATION_MARKER_KIND = "lhc.compact_continuation" as const;

export const COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX = "lhc.compact_continuation:" as const;

export function compactContinuationMarkerIdempotencyKey(continuationTurnId: string): string {
  return `${COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX}${continuationTurnId}`;
}

export const COMPACT_CONTINUATION_MARKER_CAUSE = "context_compacted_task_in_progress" as const;

export const COMPACT_CONTINUATION_MARKER_ACTION = "continue_existing_task" as const;

export type CompactContinuationMarkerSemantics = {
  cause: typeof COMPACT_CONTINUATION_MARKER_CAUSE;
  action: typeof COMPACT_CONTINUATION_MARKER_ACTION;
  newUserRequest: false;
  waitForUser: false;
};

export type ProviderReportedInputAccounting = "provider_reported_input";

export type LhcRenderedHistoryAccounting = "lhc_rendered_history";

export type SourceLabelledEstimateAccounting = "source_labelled_estimate";

export type TokenAccountingDomain =
  | ProviderReportedInputAccounting
  | LhcRenderedHistoryAccounting
  | SourceLabelledEstimateAccounting;

export type CompactContinuationHostCapability = "full_state_machine" | "capability_limited";

export const COMPACT_CONTINUATION_HOST_CAPABILITIES: readonly CompactContinuationHostCapability[] = [
  "full_state_machine",
  "capability_limited",
] as const;

export type CompactContinuationState =
  | "idle"
  | "at_seam"
  | "checking_invariants"
  | "evaluating_pressure"
  | "below_trigger"
  | "path_preserve_tool"
  | "path_continue_turn"
  | "path_normal_complete"
  | "compacting"
  | "installing"
  | "terminal_continue_normal"
  | "terminal_preserve_tool"
  | "terminal_continue_turn"
  | "terminal_normal_complete"
  | "terminal_degraded"
  | "terminal_no_reduction"
  | "terminal_decline_ordinary"
  | "terminal_retry"
  | "terminal_continue_current_body"
  | "terminal_skip"
  | "terminal_refuse";

export const COMPACT_CONTINUATION_STATES: readonly CompactContinuationState[] = [
  "idle",
  "at_seam",
  "checking_invariants",
  "evaluating_pressure",
  "below_trigger",
  "path_preserve_tool",
  "path_continue_turn",
  "path_normal_complete",
  "compacting",
  "installing",
  "terminal_continue_normal",
  "terminal_preserve_tool",
  "terminal_continue_turn",
  "terminal_normal_complete",
  "terminal_degraded",
  "terminal_no_reduction",
  "terminal_decline_ordinary",
  "terminal_retry",
  "terminal_continue_current_body",
  "terminal_skip",
  "terminal_refuse",
] as const;

export type CompactContinuationOutcomeKind =
  | "continue_normal"
  | "compact_preserve_tool"
  | "compact_continue_turn"
  | "compact_preserve_tool_escalated"
  | "normal_complete"
  | "degraded_compact"
  | "no_reduction"
  | "decline_to_ordinary_compact"
  | "retry_compact"
  | "continue_current_body"
  | "skip_seam"
  | "refuse";

export const COMPACT_CONTINUATION_OUTCOME_KINDS: readonly CompactContinuationOutcomeKind[] = [
  "continue_normal",
  "compact_preserve_tool",
  "compact_continue_turn",
  "compact_preserve_tool_escalated",
  "normal_complete",
  "degraded_compact",
  "no_reduction",
  "decline_to_ordinary_compact",
  "retry_compact",
  "continue_current_body",
  "skip_seam",
  "refuse",
] as const;

export type CompactContinuationReliefPath =
  | "none"
  | "normal_preserve"
  | "protected_escalation"
  | "core_install_failed"
  | "host_validation_awaiting"
  | "host_validation_failed"
  | "host_validation_ok";

export const COMPACT_CONTINUATION_RELIEF_PATHS: readonly CompactContinuationReliefPath[] = [
  "none",
  "normal_preserve",
  "protected_escalation",
  "core_install_failed",
  "host_validation_awaiting",
  "host_validation_failed",
  "host_validation_ok",
] as const;

export type CompactContinuationSkipCode = "not_at_settled_seam" | "transport_retry";

export const COMPACT_CONTINUATION_SKIP_CODES: readonly CompactContinuationSkipCode[] = [
  "not_at_settled_seam",
  "transport_retry",
] as const;

export type CompactContinuationRefuseCode =
  | "incomplete_capture"
  | "invalid_tool_correlation"
  | "invalid_provider_identity"
  | "open_turn_invariant_broken"
  | "native_writer_conflict"
  | "compact_failed"
  | "install_failed"
  | "no_valid_provider_request"
  | "invalid_pending_boundary_continuation"
  | "unsupported_contract_version"
  | "invalid_protected_tool_pairs"
  | "unsafe_runway"
  | "host_validation_failed";

export const COMPACT_CONTINUATION_REFUSE_CODES: readonly CompactContinuationRefuseCode[] = [
  "incomplete_capture",
  "invalid_tool_correlation",
  "invalid_provider_identity",
  "open_turn_invariant_broken",
  "native_writer_conflict",
  "compact_failed",
  "install_failed",
  "no_valid_provider_request",
  "invalid_pending_boundary_continuation",
  "unsupported_contract_version",
  "invalid_protected_tool_pairs",
  "unsafe_runway",
  "host_validation_failed",
] as const;

export const COMPACT_CONTINUATION_REACHABLE_REFUSE_CODES: readonly CompactContinuationRefuseCode[] = [] as const;

export type CompactContinuationWarningCode =
  | "capture_incomplete"
  | "provider_identity_unproven"
  | "open_turn_invariant_unverified"
  | "stale_writer_row_reclaimed"
  | "writer_owned_elsewhere"
  | "tool_correlation_unproven"
  | "protected_tool_pairs_invalid"
  | "pending_boundary_discarded"
  | "boundary_marker_claim_untrusted"
  | "continuation_boundary_unavailable"
  | "unsupported_contract_version_omitted"
  | "compact_attempt_failed"
  | "install_attempt_failed"
  | "compact_retry_budget_exhausted"
  | "provider_request_unvalidated"
  | "unsafe_runway_projection"
  | "host_validation_failed";

export const COMPACT_CONTINUATION_WARNING_CODES: readonly CompactContinuationWarningCode[] = [
  "capture_incomplete",
  "provider_identity_unproven",
  "open_turn_invariant_unverified",
  "stale_writer_row_reclaimed",
  "writer_owned_elsewhere",
  "tool_correlation_unproven",
  "protected_tool_pairs_invalid",
  "pending_boundary_discarded",
  "boundary_marker_claim_untrusted",
  "continuation_boundary_unavailable",
  "unsupported_contract_version_omitted",
  "compact_attempt_failed",
  "install_attempt_failed",
  "compact_retry_budget_exhausted",
  "provider_request_unvalidated",
  "unsafe_runway_projection",
  "host_validation_failed",
] as const;

export type CompactContinuationWarning = {
  code: CompactContinuationWarningCode;
  reason: string;
};

export const DEFAULT_COMPACT_RETRY_BUDGET = 2 as const;

export type CompactContinuationEffect =
  | { type: "claim_writer"; writer: "lhc" }
  | { type: "release_writer" }
  | {
      type: "force_turn_end";
      reason: typeof CONTEXT_COMPACT_CONTINUE_REASON;
      outcome: "completed";
      opensContinuationTurn: true;
      continuationTurnCount: 1;
      continuationTurnId: string;
    }
  | {
      type: "compact";
      lowerTargetDomain: LhcRenderedHistoryAccounting;
      lowerTargetTokens: number;
      allowDegradedDerivations: true;
    }
  | {
      type: "preserve_tool_pairs_verbatim";
      protectedToolCallIds: string[];
      location: "open_turn_tail";
    }
  | {
      type: "advance_visibility_boundary";
      previousBoundary: number;
      newBoundary: number;
      compactPoint: number;
    }
  | {
      type: "await_host_validation";
      attemptIdScope: "current_attempt";
    }
  | {
      type: "record_host_validation";
      result: "ok" | "failed";
      reason?: string;
    }
  | {
      type: "insert_continuation_marker";
      kind: typeof COMPACT_CONTINUATION_MARKER_KIND;
      continuationTurnId: string;
      idempotencyKey: string;
      semantics: CompactContinuationMarkerSemantics;
      modelVisible: true;
      lhcInspectVisible: true;
      userChatVisible: false;
      hostMayInjectTransiently: true;
    }
  | { type: "install_serving_view" }
  | {
      type: "record_receipt";
      durable: true;
      userChatVisible: false;
    }
  | { type: "degrade_fidelity"; causes: string[] }
  | {
      type: "skip_seam";
      code: CompactContinuationSkipCode;
      reason: string;
    }
  | {
      type: "warn";
      code: CompactContinuationWarningCode;
      reason: string;
    }
  | {
      type: "omit_signed_reasoning";
      reason: string;
    }
  | {
      type: "reclaim_writer";
      priorClaim: "native" | "conflict";
      hostAuthority: "no_live_owner";
    }
  | {
      type: "discard_pending_boundary";
      continuationTurnId: string | null;
      reason: string;
    }
  | { type: "refuse"; code: CompactContinuationRefuseCode; reason: string };

export type CompactContinuationEffectType = CompactContinuationEffect["type"];

export type ProviderUsageAuthority =
  | {
      available: true;
      inputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      total: number;
      domain: ProviderReportedInputAccounting;
    }
  | {
      available: false;
      reason: "missing" | "invalid";
      domain: ProviderReportedInputAccounting;
    };

export type PostMeasurementEstimate = {
  tokens: number;
  source: string;
  domain: SourceLabelledEstimateAccounting;
};

export type CompactContinuationSeam = {
  modelResponseComplete: boolean;
  requestedToolsSettled: boolean;
  captureFlushed: boolean;
  beforeNextProviderRequest: boolean;
  insideTransportRetry: boolean;
  inputEpochAtDecision: number;
  inputEpochAtApply: number;
};

export type WorkContinuation =
  | { kind: "none" }
  | {
      kind: "pending_correlated_tool_result";
      protectedToolCallIds: string[];
      correlationValid: boolean;
    }
  | { kind: "active_non_tool" };

export function normalizeProtectedToolCallIds(ids: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  const out = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))].sort();
  return out;
}

export type ForcedContinuationBoundary =
  | { applied: false }
  | {
      applied: true;
      continuationTurnId: string;
      forcedThisSeam: boolean;
      markerAlreadyPersisted: boolean;
    };

export type WriterClaim = "none" | "lhc" | "native" | "conflict";

export const COMPACT_CONTINUATION_WRITER_CLAIMS: readonly WriterClaim[] = [
  "none",
  "lhc",
  "native",
  "conflict",
] as const;

export type CompactContinuationInvariants = {
  captureComplete: boolean;
  providerIdentityValid: boolean;
  singleOpenTurn: boolean;
  writerClaim: WriterClaim;
  writerOwnershipAuthority?: "no_live_owner" | "live_owner" | null;
};

export type CompactMaterialFacts = {
  derivationsMissingOrFailed: boolean;
  lowerTargetMet: boolean;
  compactStructurallyValid: boolean;
  installSucceeds: boolean;
  usefulReduction: boolean;
  canProduceValidProviderRequest: boolean;
  projectedPressureTokens: number | null;
  renderedSavingsTokens: number;
  renderedSavingsSource: string;
  renderedSavingsDomain: SourceLabelledEstimateAccounting;
  safeRunwayThresholdTokens: number | null;
  safeRunwayThresholdSource: string | null;
  projectedPressureSafe: boolean | null;
  protectedEscalationApplied: boolean;
  visibilityBoundaryBefore: number | null;
  visibilityBoundaryAfter: number | null;
  compactPointAtInstall: number | null;
  maximalPruneInsufficient: boolean;
  compactAttemptIndex?: number;
  hostValidationStatus: "not_required" | "awaiting" | "ok" | "failed";
};

export type CompactContinuationPolicy = {
  upperTriggerTokens: number;
  lowerTargetTokens: number;
  hostCapability: CompactContinuationHostCapability;
  safeRunwayThresholdTokens?: number;
  safeRunwayThresholdSource?: string;
  compactRetryBudget?: number;
};

export type CompactContinuationInput = {
  contractVersion: string;
  seam: CompactContinuationSeam;
  providerUsage: ProviderUsageAuthority;
  postMeasurementEstimate: PostMeasurementEstimate;
  policy: CompactContinuationPolicy;
  continuation: WorkContinuation;
  invariants: CompactContinuationInvariants;
  forcedContinuationBoundary: ForcedContinuationBoundary;
  compactMaterial: CompactMaterialFacts;
};

export type CompactContinuationPressureReceipt = {
  providerBaseTokens: number | null;
  providerBaseDomain: ProviderReportedInputAccounting;
  estimateTokens: number;
  estimateSource: string;
  estimateDomain: SourceLabelledEstimateAccounting;
  nextRequestPressureTokens: number | null;
  upperTriggerTokens: number;
  atOrAboveTrigger: boolean | null;
  projectedPressureTokens: number | null;
  renderedSavingsTokens: number | null;
  renderedSavingsSource: string | null;
  renderedSavingsDomain: SourceLabelledEstimateAccounting | null;
  safeRunwayThresholdTokens: number | null;
  safeRunwayThresholdSource: string | null;
  projectedPressureSafe: boolean | null;
};

export type CompactContinuationLowerTargetReceipt = {
  domain: LhcRenderedHistoryAccounting;
  tokens: number;
  met: boolean | null;
  isSuccessGate: false;
};

export type CompactContinuationResidualState = {
  writerReleased: boolean;
  priorServingViewIntact: boolean;
  forcedContinuationBoundaryApplied: boolean;
  continuationTurnOpened: boolean;
  continuationTurnId: string | null;
  markerPersisted: boolean;
  markerServed: boolean;
  originalAgenticTurnStillOpen: boolean;
  pendingBoundaryDiscarded: boolean;
  nextProviderRequestAllowed: boolean;
  reliefPath: CompactContinuationReliefPath;
  protectedToolCallIds: string[];
  visibilityBoundaryBefore: number | null;
  visibilityBoundaryAfter: number | null;
  hostValidationStatus: "not_required" | "awaiting" | "ok" | "failed";
  coreInstallRetainedPendingHostValidation: boolean;
};

export type CompactContinuationRetryReceipt = {
  attemptIndex: number;
  budget: number;
  retryAuthorized: boolean;
};

export type CompactContinuationReceipt = {
  contractVersion: typeof COMPACT_CONTINUATION_CONTRACT_VERSION;
  outcome: CompactContinuationOutcomeKind;
  reasonCode: string;
  turnEndReason: typeof CONTEXT_COMPACT_CONTINUE_REASON | null;
  pressure: CompactContinuationPressureReceipt;
  lowerTarget: CompactContinuationLowerTargetReceipt;
  fidelity: "full" | "degraded";
  degradationReasons: string[];
  warnings: CompactContinuationWarning[];
  retry: CompactContinuationRetryReceipt;
  continuation: {
    opened: boolean;
    markerServed: boolean;
    sameAgenticTurnPreserved: boolean;
  };
  reliefPath: CompactContinuationReliefPath;
  protectedToolCallIds: string[];
  effects: CompactContinuationEffect[];
  residual: CompactContinuationResidualState;
  refused: boolean;
  refuseCode: CompactContinuationRefuseCode | null;
  skipped: boolean;
  skipCode: CompactContinuationSkipCode | null;
  transitionPath: CompactContinuationState[];
};

export type CompactContinuationDecision = {
  outcome: CompactContinuationOutcomeKind;
  terminalState: CompactContinuationState;
  transitionPath: CompactContinuationState[];
  effects: CompactContinuationEffect[];
  receipt: CompactContinuationReceipt;
};

export const COMPACT_CONTINUATION_TRANSITION_ORDER = [
  "seam_eligibility",
  "forced_boundary_state_legality",
  "writer_claim",
  "capture_identity_correlation",
  "provider_usage_authority",
  "pressure_evaluation",
  "continuation_branch",
  "force_boundary_if_continue_turn",
  "compact_assembly",
  "install_or_preserve",
  "bounded_retry_or_decline",
  "receipt_and_release",
] as const;

export type CompactContinuationTransitionStep = (typeof COMPACT_CONTINUATION_TRANSITION_ORDER)[number];

export const COMPACT_CONTINUATION_INVARIANTS = [
  "provider_usage_is_sole_upper_trigger_base",
  "lhc_estimates_never_replace_missing_provider_usage",
  "upper_and_lower_use_distinct_accounting_domains",
  "post_measurement_estimate_is_source_labelled_not_provider_usage",
  "evaluate_only_at_settled_seam_never_in_transport_retry",
  "below_trigger_continues_normally",
  "pending_tool_result_keeps_agentic_turn_open_no_continuation_prompt",
  "active_non_tool_forces_boundary_before_compact_one_turn_end_opens_one_turn",
  "normal_completion_creates_no_empty_continuation_turn",
  "missing_derivations_degrade_fidelity_not_block_valid_compact",
  "lower_target_is_not_a_success_gate",
  "unsettled_seam_is_skip_not_corruption",
  "refuse_set_is_empty_no_stop_in_the_compact_path",
  "never_strand_a_session_every_condition_warns_and_continues",
  "record_request_health_warns_and_continues_never_refuses",
  "input_epoch_is_diagnostic_only_never_vetoes_a_settled_seam",
  "unproven_provider_identity_omits_signed_reasoning_only",
  "uncorrelatable_tool_pairs_decline_into_ordinary_compact",
  "invalid_protected_pair_set_declines_into_ordinary_compact",
  "unusable_pending_boundary_is_discarded_and_the_seam_starts_fresh",
  "unknown_contract_version_omits_continuation_state_in_its_entirety",
  "unknown_contract_version_is_never_partially_parsed",
  "compact_and_install_failure_are_bounded_retry_not_terminal",
  "retry_budget_exhaustion_continues_on_the_current_body",
  "stale_writer_row_reclaim_requires_host_ownership_authority",
  "writer_ownership_registry_lives_host_side_not_in_the_sdk",
  "live_writer_loser_continues_current_request_never_steals_never_strands",
  "unsafe_runway_is_diagnostic_not_a_gate",
  "best_available_body_is_sent_provider_is_final_authority",
  "host_validation_failure_degrades_and_never_blocks_next_request",
  "warnings_are_loud_diagnostics_that_never_govern",
  "forced_boundary_repair_takes_precedence_over_fresh_pressure",
  "applied_forced_boundary_residual_truthful_on_skip_and_decline",
  "install_failure_wins_over_no_reduction_classification",
  "marker_persisted_before_install_served_only_after_install",
  "marker_persisted_is_residual_state_not_attempt_scoped",
  "marker_idempotency_key_is_prefix_plus_continuation_turn_id",
  "skip_does_not_authorize_next_provider_request",
  "writer_claim_lhc_is_idempotent_reassert_not_second_lock",
  "post_claim_failures_release_writer_and_state_residual_truthfully",
  "preserve_tool_install_failure_includes_preserve_effect",
  "input_is_closed_shape_unknown_fields_rejected",
  "receipts_are_not_user_chat",
  "stable_turn_end_reason_context_compact_continue",
  "no_false_parity_for_capability_limited_hosts",
  "pure_function_is_whole_seam_oracle_not_pre_effect_plan",
  "protected_tool_call_ids_sorted_unique_nonempty",
  "projected_pressure_is_base_plus_growth_minus_savings",
  "safe_runway_threshold_is_not_lower_target",
  "protected_results_budgeted_full_before_prune",
  "visibility_boundary_monotonic_before_earliest_protected_result",
  "atomic_view_and_boundary_install_or_neither",
  "host_validation_never_claimed_inside_lhc_core",
  "host_validation_failure_does_not_rollback_core_install",
  "no_dual_field_toolcallid_shim",
] as const;

export type CompactContinuationInvariantId = (typeof COMPACT_CONTINUATION_INVARIANTS)[number];

export const COMPACT_CONTINUATION_INPUT_CLOSED_SHAPE = true as const;

export const COMPACT_CONTINUATION_RUST_CLOSED_UNION_NOTE =
  "per-variant closed structs required; deny_unknown_fields on enum derive is insufficient" as const;
