/**
 * Compact-continuation contract v1 — provider-neutral state machine surface.
 *
 * This module defines the durable, versioned contract for LHC-owned context
 * relief at a settled model-turn seam when agentic work must continue across a
 * compact boundary. It is intentionally pure: no I/O, no thread database, no
 * host adapter.
 *
 * ## Pure-function protocol (LIM-60 oracle, not LIM-61 runtime)
 *
 * `decideCompactContinuation` is a **whole-seam parity and receipt oracle**.
 * It classifies a completed seam from:
 * - **pre-decision facts** known before any mutation (seam, usage, policy,
 *   continuation kind, invariants, pending forced boundary), and
 * - **attempt results** known only after stages run (compact/install material).
 *
 * A host runtime (LIM-61) must **not** call this once up front and then apply
 * every effect blindly. It executes `COMPACT_CONTINUATION_TRANSITION_ORDER`
 * stage-by-stage (claim writer, optional forced boundary, compact, marker,
 * install, …), gathers attempt results, then uses this oracle/contract to
 * classify the completed seam and emit the durable receipt. Fixtures pin the
 * oracle outputs for TypeScript/Rust parity.
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
 * The pure decision table is identical for both; capability-limited hosts
 * simply cannot perform some effects and must not fabricate them.
 */
export type CompactContinuationHostCapability = "full_state_machine" | "capability_limited";

export const COMPACT_CONTINUATION_HOST_CAPABILITIES: readonly CompactContinuationHostCapability[] = [
  "full_state_machine",
  "capability_limited",
] as const;

// ── Machine states ───────────────────────────────────────────────────────────

/**
 * Explicit machine states. Evaluation begins at `at_seam` only when seam
 * readiness holds; otherwise the host skips (not-at-seam / transport retry).
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
  /** Pressure was evaluated and is below upper trigger; no compact. */
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
  /** Terminal: forced turn_end (opens one continuation turn) + marker. */
  | "terminal_continue_turn"
  /** Terminal: normal work completion; no empty continuation turn. */
  | "terminal_normal_complete"
  /** Terminal: structurally valid compact with degraded fidelity. */
  | "terminal_degraded"
  /** Terminal: no useful reduction; structurally ok; continue without claiming success. */
  | "terminal_no_reduction"
  /**
   * Terminal: seam skipped without hard refuse — transport retry, input-epoch
   * change, or not-yet-settled seam (wait). Not record corruption.
   */
  | "terminal_skip"
  /** Terminal: hard refuse — untrustworthy record/request or structural failure. */
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

// ── Skip codes (closed; distinct from refuse) ────────────────────────────────

/**
 * Soft skip: do not mutate; re-evaluate later. Not a hard refuse.
 * - `not_at_settled_seam` — seam simply has not settled yet (wait), not record corruption.
 * - `transport_retry` — never mutate inside a transport retry.
 * - `input_epoch_changed` — steering race; skip this seam safely.
 */
export type CompactContinuationSkipCode = "not_at_settled_seam" | "transport_retry" | "input_epoch_changed";

export const COMPACT_CONTINUATION_SKIP_CODES: readonly CompactContinuationSkipCode[] = [
  "not_at_settled_seam",
  "transport_retry",
  "input_epoch_changed",
] as const;

// ── Refuse codes ─────────────────────────────────────────────────────────────

/**
 * Hard refuse codes. Missing/failed derivations are NOT refuse codes.
 *
 * ## Why record/request-health proofs refuse even below pressure
 *
 * After a host claims it reached a settled seam, the following mean the
 * **canonical record or next provider request is not trustworthy**, whether or
 * not pressure would have triggered compact:
 * - incomplete capture of the settled model turn
 * - invalid/unproven provider identity
 * - broken single-open-turn invariant
 * - invalid pending tool-call/result correlation
 *
 * This is an explicit ruling for this contract: those proofs are seam-health
 * checks on the record/request, not compact preconditions that only apply when
 * above trigger. Ordinary missing/failed **derivations** remain degraded and
 * non-blocking. A seam that has simply **not settled yet** is a **skip/wait**
 * (`not_at_settled_seam`), not record corruption.
 */
export type CompactContinuationRefuseCode =
  | "incomplete_capture"
  | "invalid_tool_correlation"
  | "invalid_provider_identity"
  | "open_turn_invariant_broken"
  | "native_writer_conflict"
  | "compact_failed"
  | "install_failed"
  | "no_valid_provider_request"
  /** Input contractVersion is not this oracle version; not an accepted v1 seam. */
  | "unsupported_contract_version";

export const COMPACT_CONTINUATION_REFUSE_CODES: readonly CompactContinuationRefuseCode[] = [
  "incomplete_capture",
  "invalid_tool_correlation",
  "invalid_provider_identity",
  "open_turn_invariant_broken",
  "native_writer_conflict",
  "compact_failed",
  "install_failed",
  "no_valid_provider_request",
  "unsupported_contract_version",
] as const;

// ── Effects (ordered, applied by runtime in later stories) ───────────────────

/**
 * Ordered effects the runtime applied (or attempted) on this seam.
 *
 * For active non-tool continuation the normative success order is:
 * claim LHC writer → force_turn_end (closes prior + opens exactly one
 * continuation turn) → compact → [degrade_fidelity] → insert marker → install
 * → receipt → release.
 *
 * Post-claim failure receipts must include effects already attempted and end
 * with writer release (see residual state).
 */
export type CompactContinuationEffect =
  | { type: "claim_writer"; writer: "lhc" }
  | { type: "release_writer" }
  | {
      /**
       * Force a canonical `turn_end` with reason `context_compact_continue`.
       *
       * **Turn mechanics:** LHC intake of one `turn_end` on a populated open
       * turn atomically closes that turn **and opens exactly one new empty
       * turn** (`turns.create`). This single effect models that atomic
       * boundary. Runtimes must not apply a second imperative "open turn"
       * action that would create another turn.
       */
      type: "force_turn_end";
      reason: typeof CONTEXT_COMPACT_CONTINUE_REASON;
      outcome: "completed";
      /** Always true: the atomic turn_end opens exactly one continuation turn. */
      opensContinuationTurn: true;
      /** Always 1: exactly one empty continuation turn after the boundary. */
      continuationTurnCount: 1;
    }
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
  | {
      type: "skip_seam";
      code: CompactContinuationSkipCode;
      reason: string;
    }
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
   * Mutation is forbidden; must skip the seam.
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

export const COMPACT_CONTINUATION_WRITER_CLAIMS: readonly WriterClaim[] = [
  "none",
  "lhc",
  "native",
  "conflict",
] as const;

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

/**
 * Attempt-result facts. Known only after the runtime has attempted compact
 * (and install when compact succeeded). Pre-decision classification uses these
 * only on paths that attempt those stages.
 */
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
 * Pre-decision facts (known before mutation) plus attempt results (known after
 * stages execute). See module protocol comment: this is an oracle bag, not a
 * pre-effect plan-only input.
 */
export type CompactContinuationInput = {
  /**
   * Must equal `COMPACT_CONTINUATION_CONTRACT_VERSION` for an accepted v1 seam.
   * Unsupported versions refuse with `unsupported_contract_version` and do not
   * claim acceptance of the input as v1.
   */
  contractVersion: string;
  // ── pre-decision facts ────────────────────────────────────────────────────
  seam: CompactContinuationSeam;
  providerUsage: ProviderUsageAuthority;
  postMeasurementEstimate: PostMeasurementEstimate;
  policy: CompactContinuationPolicy;
  continuation: WorkContinuation;
  invariants: CompactContinuationInvariants;
  /**
   * True when a prior seam attempt already applied `force_turn_end` with
   * `context_compact_continue` and left exactly one empty continuation turn
   * open, but compact/marker/install did not complete. Repair/retry must
   * **not** force a duplicate boundary or insert a second marker; it resumes
   * from compact onward with the boundary already durable.
   */
  pendingForcedContinuationBoundary: boolean;
  // ── attempt results ───────────────────────────────────────────────────────
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

/**
 * Residual durable/runtime state after the seam decision.
 * Post-claim failures always release the writer and never leave a partial install.
 */
export type CompactContinuationResidualState = {
  /** Writer claim released (or never held). Always true on terminal receipts. */
  writerReleased: boolean;
  /**
   * Prior serving view remains installed. True when install did not succeed
   * (including install_failed and pre-install refuses). False only when
   * `install_serving_view` was applied successfully.
   */
  priorServingViewIntact: boolean;
  /**
   * A forced `context_compact_continue` boundary was applied on this seam
   * (or already pending from a prior attempt). Durable even if compact/install fails.
   */
  forcedContinuationBoundaryApplied: boolean;
  /**
   * Exactly one empty continuation turn is open as a result of the forced
   * boundary (atomic turn_end). False when no forced boundary applies.
   */
  continuationTurnOpened: boolean;
  /** Typed continuation marker was served into the model-visible context. */
  markerServed: boolean;
  /**
   * Original agentic turn still open (tool-preserve path and early refuses/skips).
   * False after a forced continuation boundary.
   */
  originalAgenticTurnStillOpen: boolean;
  /**
   * Next provider request may be issued for this outcome. False on refuse and
   * on post-boundary failures that leave no installable request.
   */
  nextProviderRequestAllowed: boolean;
};

export type CompactContinuationReceipt = {
  /**
   * Oracle contract version that produced this receipt (`1.0.0`).
   * For `unsupported_contract_version`, this is still the oracle version that
   * classified the refuse — not acceptance of the input version. The rejected
   * input version appears only in `reasonCode` / refuse reason text.
   */
  contractVersion: typeof COMPACT_CONTINUATION_CONTRACT_VERSION;
  outcome: CompactContinuationOutcomeKind;
  reasonCode: string;
  /** Set when a continuation turn boundary was forced (success or post-boundary failure). */
  turnEndReason: typeof CONTEXT_COMPACT_CONTINUE_REASON | null;
  pressure: CompactContinuationPressureReceipt;
  lowerTarget: CompactContinuationLowerTargetReceipt;
  fidelity: "full" | "degraded";
  degradationReasons: string[];
  continuation: {
    /**
     * Exactly one continuation turn opened (via atomic force_turn_end), or
     * already open from a pending forced boundary on repair.
     */
    opened: boolean;
    markerServed: boolean;
    sameAgenticTurnPreserved: boolean;
  };
  /**
   * Ordered effects the runtime applied or attempted on this seam, including
   * post-claim failures (claim + attempted stages + refuse + receipt + release).
   */
  effects: CompactContinuationEffect[];
  residual: CompactContinuationResidualState;
  refused: boolean;
  refuseCode: CompactContinuationRefuseCode | null;
  skipped: boolean;
  skipCode: CompactContinuationSkipCode | null;
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
 * Normative evaluation order at a candidate seam. Hosts execute stages in this
 * order; the pure oracle classifies the completed seam for parity/receipts.
 *
 * 1. Seam eligibility — settled seam only; never inside transport retry (skips).
 * 2. Input-epoch stability — decision epoch must match apply epoch (skip).
 * 3. Writer exclusivity — one writer; native conflict refuses.
 * 4. Capture / identity / open-turn / tool-correlation proofs (hard refuse when
 *    the host claims a settled seam but record/request health fails — even
 *    below pressure; see refuse-code docs).
 * 5. Authoritative provider usage — missing/invalid ⇒ continue_normal without
 *    inventing pressure (no upper trigger fire).
 * 6. Pressure = provider base + source-labelled estimate (estimate not relabelled).
 * 7. Branch on pressure × work-continuation kind.
 * 8. Active non-tool: force turn boundary **before** compact so the just-closed
 *    turn is eligible; one turn_end closes prior and opens one continuation turn.
 *    Repair with `pendingForcedContinuationBoundary` skips re-forcing.
 * 9. Compact (closed history) with degraded-derivation tolerance; lower target
 *    is not a success gate. Fidelity degradation is classified at assembly.
 * 10. Preserve tool pair / insert marker / install serving view.
 * 11. Record durable receipt (not user chat); release writer.
 *
 * ### Residual state after post-claim failure
 * - **tool-preserve** compact/install failure: original agentic turn remains
 *   open; prior serving view intact; no marker; writer released.
 * - **active non-tool** compact/install failure **after** forced boundary:
 *   boundary and the one empty continuation turn remain durable; no marker
 *   served; no next provider request; prior serving view remains installed;
 *   writer released.
 * - **install_failed**: must not imply a partially installed view
 *   (`priorServingViewIntact: true`, no successful `install_serving_view`).
 * - **Repair/retry**: if `pendingForcedContinuationBoundary` is true, do not
 *   create a duplicate boundary or second marker; resume compact onward.
 */
export const COMPACT_CONTINUATION_TRANSITION_ORDER = [
  "seam_eligibility",
  "input_epoch",
  "writer_claim",
  "capture_identity_correlation",
  "provider_usage_authority",
  "pressure_evaluation",
  "continuation_branch",
  "force_boundary_if_continue_turn",
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
  "active_non_tool_forces_boundary_before_compact_one_turn_end_opens_one_turn",
  "normal_completion_creates_no_empty_continuation_turn",
  "missing_derivations_degrade_fidelity_not_block_valid_compact",
  "lower_target_is_not_a_success_gate",
  "record_request_health_refuses_even_below_pressure_after_claimed_seam",
  "unsettled_seam_is_skip_not_corruption",
  "refuse_only_when_no_valid_request_or_invariants_unproven",
  "one_writer_at_seam_no_silent_native_mid_turn_fallback",
  "post_claim_failures_release_writer_and_state_residual_truthfully",
  "pending_forced_boundary_repair_does_not_duplicate_boundary_or_marker",
  "receipts_are_not_user_chat",
  "stable_turn_end_reason_context_compact_continue",
  "no_false_parity_for_capability_limited_hosts",
  "pure_function_is_whole_seam_oracle_not_pre_effect_plan",
] as const;

export type CompactContinuationInvariantId = (typeof COMPACT_CONTINUATION_INVARIANTS)[number];
