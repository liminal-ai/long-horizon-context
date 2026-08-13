/**
 * Compact-continuation contract v1 — provider-neutral state machine surface.
 *
 * This module defines the durable, versioned contract for LHC-owned context
 * relief at a settled model-turn seam when agentic work must continue across a
 * compact boundary. It is intentionally pure: no I/O, no thread database, no
 * host adapter. LIM-61 wires a runtime evaluator that gathers these inputs and
 * applies the effects; LIM-62 ports the same decision table to Rust.
 *
 * Owner rulings (2026-08-13) supersede earlier research-package designs that
 * kept the agentic turn open for every mid-turn relief path. When work continues
 * without a pending correlated tool-result pair, the contract forces a canonical
 * turn boundary with reason `context_compact_continue`.
 *
 * Self-contained enough for a fresh implementer: read this file, README.md, and
 * the parity fixtures under packages/lhc/fixtures/compact-continuation/v1/.
 */

// ── Version and stable strings ───────────────────────────────────────────────

/** Semver of this contract surface. Fixtures pin the same string. */
export const COMPACT_CONTINUATION_CONTRACT_VERSION = "1.0.0" as const;

/** Canonical turn_end / outcome reason when a continuation turn is opened. */
export const CONTEXT_COMPACT_CONTINUE_REASON = "context_compact_continue" as const;

/**
 * Stable typed marker kind served to the model after a continuation compact.
 * Model-visible and LHC inspection/retrieval-visible; hidden from normal user chat.
 */
export const COMPACT_CONTINUATION_MARKER_KIND = "lhc.compact_continuation" as const;

// ── Accounting domains (intentionally distinct) ──────────────────────────────

/**
 * Upper-trigger base domain: provider-reported input context only.
 * For Claude this is input + cache creation + cache read. LHC token estimates
 * never substitute for a missing provider measurement.
 */
export type ProviderReportedInputAccounting = "provider_reported_input";

/**
 * Lower-target domain: LHC rendered-history tokens after compact assembly.
 * Upper and lower use different accounting domains by design.
 */
export type LhcRenderedHistoryAccounting = "lhc_rendered_history";

/**
 * Post-measurement pressure delta: source-labelled estimate of messages
 * captured after the last provider request. Must never be relabelled as
 * provider usage.
 */
export type SourceLabelledEstimateAccounting = "source_labelled_estimate";

export type TokenAccountingDomain =
  | ProviderReportedInputAccounting
  | LhcRenderedHistoryAccounting
  | SourceLabelledEstimateAccounting;

// ── Host capability (truthful; no false parity) ──────────────────────────────

/**
 * Host capability posture for this contract.
 * - `full_state_machine`: Codex (and similar) implement every branch.
 * - `capability_limited`: cc-lhc later — truthful limited governance + handoff;
 *   must not claim in-place request replacement it cannot perform.
 */
export type CompactContinuationHostCapability = "full_state_machine" | "capability_limited";

// ── Machine states ───────────────────────────────────────────────────────────

/**
 * Explicit machine states. Evaluation begins at `at_seam` only when seam
 * readiness holds; otherwise the host must not enter the machine.
 *
 * Terminal states are the leaf outcomes. Intermediate states document ordered
 * evaluation; pure `decideCompactContinuation` folds them into a single
 * Decision for parity fixtures.
 */
export type CompactContinuationState =
  | "idle"
  /** Settled model-turn seam: response complete, tools settled, capture flushed. */
  | "at_seam"
  /** Checking writer exclusivity, capture, identity, correlation, epoch. */
  | "checking_invariants"
  /** Authoritative provider usage + labelled post-measurement estimate. */
  | "evaluating_pressure"
  /** Pressure below upper trigger; no compact. */
  | "below_trigger"
  /** Above trigger; pending correlated tool-result path. */
  | "path_preserve_tool"
  /** Above trigger; active non-tool work continues. */
  | "path_continue_turn"
  /** Work finished; close normally without continuation. */
  | "path_normal_complete"
  /** Compact assembly in progress (closed history only). */
  | "compacting"
  /** Installing/serving the post-compact request context. */
  | "installing"
  /** Terminal: continue without compact. */
  | "terminal_continue_normal"
  /** Terminal: same agentic turn; tool pair preserved; no continuation marker. */
  | "terminal_preserve_tool"
  /** Terminal: forced turn_end + one continuation turn + marker. */
  | "terminal_continue_turn"
  /** Terminal: normal work completion; no empty continuation turn. */
  | "terminal_normal_complete"
  /** Terminal: structurally valid compact with degraded fidelity. */
  | "terminal_degraded"
  /** Terminal: no useful reduction; structurally ok; continue without claiming success. */
  | "terminal_no_reduction"
  /** Terminal: seam skipped (stale epoch / transport retry / not at seam). */
  | "terminal_skip"
  /** Terminal: hard refuse — no valid installable request or invariant unprovable. */
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
  "terminal_skip",
  "terminal_refuse",
] as const;

// ── Outcome kinds (fixture-stable) ───────────────────────────────────────────

export type CompactContinuationOutcomeKind =
  | "continue_normal"
  | "compact_preserve_tool"
  | "compact_continue_turn"
  | "normal_complete"
  | "degraded_compact"
  | "no_reduction"
  | "skip_seam"
  | "refuse";

export const COMPACT_CONTINUATION_OUTCOME_KINDS: readonly CompactContinuationOutcomeKind[] = [
  "continue_normal",
  "compact_preserve_tool",
  "compact_continue_turn",
  "normal_complete",
  "degraded_compact",
  "no_reduction",
  "skip_seam",
  "refuse",
] as const;

// ── Refuse codes ─────────────────────────────────────────────────────────────

/**
 * Hard refuse only when no structurally valid provider request can be produced
 * or installed, or required capture/identity/correlation invariants cannot be
 * proven. Missing derivations are NOT refuse codes.
 */
export type CompactContinuationRefuseCode =
  | "not_at_settled_seam"
  | "transport_retry"
  | "input_epoch_changed"
  | "incomplete_capture"
  | "invalid_tool_correlation"
  | "invalid_provider_identity"
  | "open_turn_invariant_broken"
  | "native_writer_conflict"
  | "compact_failed"
  | "install_failed"
  | "no_valid_provider_request";

export const COMPACT_CONTINUATION_REFUSE_CODES: readonly CompactContinuationRefuseCode[] = [
  "not_at_settled_seam",
  "transport_retry",
  "input_epoch_changed",
  "incomplete_capture",
  "invalid_tool_correlation",
  "invalid_provider_identity",
  "open_turn_invariant_broken",
  "native_writer_conflict",
  "compact_failed",
  "install_failed",
  "no_valid_provider_request",
] as const;

// ── Effects (ordered, applied by runtime in later stories) ───────────────────

export type CompactContinuationEffect =
  | { type: "claim_writer"; writer: "lhc" }
  | { type: "release_writer" }
  | {
      type: "force_turn_end";
      reason: typeof CONTEXT_COMPACT_CONTINUE_REASON;
      outcome: "completed";
    }
  | { type: "open_continuation_turn"; count: 1 }
  | {
      type: "compact";
      lowerTargetDomain: LhcRenderedHistoryAccounting;
      lowerTargetTokens: number;
      /** Missing/failed derivations degrade fidelity; never block a valid compact. */
      allowDegradedDerivations: true;
    }
  | {
      type: "preserve_tool_pair_verbatim";
      toolCallId: string;
      /** Current call/result pair stays in the open-turn tail. */
      location: "open_turn_tail";
    }
  | {
      type: "insert_continuation_marker";
      kind: typeof COMPACT_CONTINUATION_MARKER_KIND;
      modelVisible: true;
      lhcInspectVisible: true;
      userChatVisible: false;
      /**
       * Hosts that cannot mirror the typed item may inject transiently while
       * preserving the canonical boundary and cause.
       */
      hostMayInjectTransiently: true;
    }
  | { type: "install_serving_view" }
  | {
      type: "record_receipt";
      durable: true;
      /** Receipts/cause are inspectable but are not ordinary user chat. */
      userChatVisible: false;
    }
  | { type: "degrade_fidelity"; causes: string[] }
  | { type: "skip_seam"; reason: string }
  | { type: "refuse"; code: CompactContinuationRefuseCode; reason: string };

export type CompactContinuationEffectType = CompactContinuationEffect["type"];

// ── Inputs ───────────────────────────────────────────────────────────────────

export type ProviderUsageAuthority =
  | {
      available: true;
      /** Provider input tokens (authoritative component). */
      inputTokens: number;
      /** Claude cache creation; 0 when absent/unsupported. */
      cacheCreationTokens: number;
      /** Claude cache read; 0 when absent/unsupported. */
      cacheReadTokens: number;
      /**
       * Authoritative total for upper-trigger base.
       * Claude: input + cache_creation + cache_read.
       */
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
  /**
   * Host-owned source label (e.g. "lhc_token_estimate", "host_byte_estimate").
   * The estimate is never relabelled as provider usage.
   */
  source: string;
  domain: SourceLabelledEstimateAccounting;
};

export type CompactContinuationSeam = {
  /** Model response for model turn N is complete (terminal stop). */
  modelResponseComplete: boolean;
  /** Every tool the model requested for that response has returned. */
  requestedToolsSettled: boolean;
  /** Host flushed capture of response + tools (+ steering) to LHC. */
  captureFlushed: boolean;
  /** Evaluation is before the next provider request is issued. */
  beforeNextProviderRequest: boolean;
  /**
   * True when inside a transport-retry loop for the current provider request.
   * Mutation is forbidden; must skip/refuse the seam.
   */
  insideTransportRetry: boolean;
  /** Input epoch at decision time. */
  inputEpochAtDecision: number;
  /** Input epoch re-checked at apply time; must match decision. */
  inputEpochAtApply: number;
};

export type WorkContinuation =
  | { kind: "none" }
  | {
      kind: "pending_correlated_tool_result";
      toolCallId: string;
      /** Call/result correlation can be proven for the protected pair. */
      correlationValid: boolean;
    }
  | { kind: "active_non_tool" };

export type WriterClaim = "none" | "lhc" | "native" | "conflict";

export type CompactContinuationInvariants = {
  /** Capture of the settled model turn is complete and proven. */
  captureComplete: boolean;
  /** Provider/model identity required for a valid request is proven. */
  providerIdentityValid: boolean;
  /** Exactly one open agentic turn (RECORD-12). */
  singleOpenTurn: boolean;
  /**
   * LHC and host-native compact are one writer at a seam.
   * `conflict` or unexpected `native` claim refuses silent mid-turn fallback.
   */
  writerClaim: WriterClaim;
};

export type CompactMaterialFacts = {
  /** Missing/failed derivations degrade fidelity but do not block. */
  derivationsMissingOrFailed: boolean;
  /** After compact attempt: lower target met? Target is not a success gate. */
  lowerTargetMet: boolean;
  /** Compact assembly can run to a structurally valid band arrangement. */
  compactStructurallyValid: boolean;
  /** Host can install/serve the resulting request body. */
  installSucceeds: boolean;
  /**
   * Whether the compact reclaims useful served size. False is a first-class
   * non-error outcome when structure is still valid (`no_reduction`).
   */
  usefulReduction: boolean;
  /**
   * When false, no structurally valid provider request can be produced even
   * after best-effort compact — hard refuse.
   */
  canProduceValidProviderRequest: boolean;
};

export type CompactContinuationPolicy = {
  /** Upper trigger in provider-reported input domain. */
  upperTriggerTokens: number;
  /** Lower target in LHC rendered-history domain. */
  lowerTargetTokens: number;
  hostCapability: CompactContinuationHostCapability;
};

/**
 * Pure decision input. All fields explicit; no I/O.
 * Runtime (LIM-61) is responsible for populating this from live host/LHC state.
 */
export type CompactContinuationInput = {
  contractVersion: typeof COMPACT_CONTINUATION_CONTRACT_VERSION;
  seam: CompactContinuationSeam;
  providerUsage: ProviderUsageAuthority;
  postMeasurementEstimate: PostMeasurementEstimate;
  policy: CompactContinuationPolicy;
  continuation: WorkContinuation;
  invariants: CompactContinuationInvariants;
  compactMaterial: CompactMaterialFacts;
};

// ── Receipt ──────────────────────────────────────────────────────────────────

export type CompactContinuationPressureReceipt = {
  providerBaseTokens: number | null;
  providerBaseDomain: ProviderReportedInputAccounting;
  estimateTokens: number;
  estimateSource: string;
  estimateDomain: SourceLabelledEstimateAccounting;
  /**
   * last provider measurement + labelled estimate when provider base exists;
   * null when no authoritative provider measurement (never fabricated).
   */
  nextRequestPressureTokens: number | null;
  upperTriggerTokens: number;
  /** null when pressure cannot be evaluated (no provider base). */
  atOrAboveTrigger: boolean | null;
};

export type CompactContinuationLowerTargetReceipt = {
  domain: LhcRenderedHistoryAccounting;
  tokens: number;
  /** null when compact did not run. */
  met: boolean | null;
  /** Always false — lower bound is a target, never a pass/fail gate. */
  isSuccessGate: false;
};

export type CompactContinuationReceipt = {
  contractVersion: typeof COMPACT_CONTINUATION_CONTRACT_VERSION;
  outcome: CompactContinuationOutcomeKind;
  reasonCode: string;
  /** Set only when a continuation turn boundary was forced. */
  turnEndReason: typeof CONTEXT_COMPACT_CONTINUE_REASON | null;
  pressure: CompactContinuationPressureReceipt;
  lowerTarget: CompactContinuationLowerTargetReceipt;
  fidelity: "full" | "degraded";
  degradationReasons: string[];
  continuation: {
    opened: boolean;
    markerServed: boolean;
    sameAgenticTurnPreserved: boolean;
  };
  /** Ordered effects the runtime must apply (or would have applied). */
  effects: CompactContinuationEffect[];
  refused: boolean;
  refuseCode: CompactContinuationRefuseCode | null;
  /**
   * Transition path through named states (documentation + parity).
   * Always starts with `at_seam` or a skip/refuse that never entered it.
   */
  transitionPath: CompactContinuationState[];
};

// ── Decision ─────────────────────────────────────────────────────────────────

export type CompactContinuationDecision = {
  outcome: CompactContinuationOutcomeKind;
  terminalState: CompactContinuationState;
  transitionPath: CompactContinuationState[];
  effects: CompactContinuationEffect[];
  receipt: CompactContinuationReceipt;
};

// ── Transition ordering (normative) ──────────────────────────────────────────

/**
 * Normative evaluation order at a candidate seam. Hosts and the pure decision
 * function must follow this order; fixtures encode the resulting path.
 *
 * 1. Seam eligibility — settled seam only; never inside transport retry.
 * 2. Input-epoch stability — decision epoch must match apply epoch.
 * 3. Writer exclusivity — one writer (LHC claim); native conflict refuses.
 * 4. Capture / identity / open-turn / tool-correlation proofs.
 * 5. Authoritative provider usage — missing/invalid ⇒ continue_normal without
 *    inventing pressure (no upper trigger fire).
 * 6. Pressure = provider base + source-labelled estimate (estimate not relabelled).
 * 7. Branch on pressure × work-continuation kind.
 * 8. Compact (closed history) with degraded-derivation tolerance; lower target
 *    is not a success gate.
 * 9. Install serving view / preserve tool pair / open continuation + marker.
 * 10. Record durable receipt (not user chat); release writer.
 */
export const COMPACT_CONTINUATION_TRANSITION_ORDER = [
  "seam_eligibility",
  "input_epoch",
  "writer_claim",
  "capture_identity_correlation",
  "provider_usage_authority",
  "pressure_evaluation",
  "continuation_branch",
  "compact_assembly",
  "install_or_preserve",
  "receipt_and_release",
] as const;

export type CompactContinuationTransitionStep = (typeof COMPACT_CONTINUATION_TRANSITION_ORDER)[number];

// ── Invariants (normative, prose + machine-checkable) ────────────────────────

export const COMPACT_CONTINUATION_INVARIANTS = [
  "provider_usage_is_sole_upper_trigger_base",
  "lhc_estimates_never_replace_missing_provider_usage",
  "upper_and_lower_use_distinct_accounting_domains",
  "post_measurement_estimate_is_source_labelled_not_provider_usage",
  "evaluate_only_at_settled_seam_never_in_transport_retry",
  "below_trigger_continues_normally",
  "pending_tool_result_keeps_agentic_turn_open_no_continuation_prompt",
  "active_non_tool_forces_context_compact_continue_and_one_continuation_turn",
  "normal_completion_creates_no_empty_continuation_turn",
  "missing_derivations_degrade_fidelity_not_block_valid_compact",
  "lower_target_is_not_a_success_gate",
  "refuse_only_when_no_valid_request_or_invariants_unproven",
  "one_writer_at_seam_no_silent_native_mid_turn_fallback",
  "receipts_are_not_user_chat",
  "stable_turn_end_reason_context_compact_continue",
  "no_false_parity_for_capability_limited_hosts",
] as const;

export type CompactContinuationInvariantId = (typeof COMPACT_CONTINUATION_INVARIANTS)[number];
