/**
 * Generates LIM-60 compact-continuation parity fixtures from the pure decision function.
 * Usage (from packages/lhc): pnpm exec tsx scripts/gen-compact-continuation-fixtures.mjs
 *
 * Regeneration with an unchanged decision table must leave a clean git diff.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const mod = await import(join(pkgRoot, "src/shared-tech/compact-continuation/index.ts"));
const { COMPACT_CONTINUATION_CONTRACT_VERSION, decideCompactContinuation } = mod;

const V = COMPACT_CONTINUATION_CONTRACT_VERSION;
const baseDir = join(pkgRoot, "fixtures/compact-continuation/v2");

const basePolicy = {
  upperTriggerTokens: 100_000,
  lowerTargetTokens: 40_000,
  hostCapability: "full_state_machine",
  safeRunwayThresholdTokens: 120_000,
  safeRunwayThresholdSource: "host_safe_runway",
};

const goodSeam = {
  modelResponseComplete: true,
  requestedToolsSettled: true,
  captureFlushed: true,
  beforeNextProviderRequest: true,
  insideTransportRetry: false,
  inputEpochAtDecision: 1,
  inputEpochAtApply: 1,
};

const goodInvariants = {
  captureComplete: true,
  providerIdentityValid: true,
  singleOpenTurn: true,
  writerClaim: "none",
};

const goodMaterial = {
  derivationsMissingOrFailed: false,
  lowerTargetMet: true,
  compactStructurallyValid: true,
  installSucceeds: true,
  usefulReduction: true,
  canProduceValidProviderRequest: true,
  projectedPressureTokens: 107_000,
  renderedSavingsTokens: 0,
  renderedSavingsSource: "lhc_rendered_history_estimate",
  renderedSavingsDomain: "source_labelled_estimate",
  safeRunwayThresholdTokens: 120_000,
  safeRunwayThresholdSource: "host_safe_runway",
  projectedPressureSafe: true,
  protectedEscalationApplied: false,
  visibilityBoundaryBefore: null,
  visibilityBoundaryAfter: null,
  compactPointAtInstall: null,
  maximalPruneInsufficient: false,
  hostValidationStatus: "not_required",
};

const providerAbove = {
  available: true,
  inputTokens: 90_000,
  cacheCreationTokens: 5_000,
  cacheReadTokens: 10_000,
  total: 105_000,
  domain: "provider_reported_input",
};

const providerBelow = {
  available: true,
  inputTokens: 70_000,
  cacheCreationTokens: 0,
  cacheReadTokens: 5_000,
  total: 75_000,
  domain: "provider_reported_input",
};

const est = (tokens = 0, source = "lhc_token_estimate") => ({
  tokens,
  source,
  domain: "source_labelled_estimate",
});

function appliedBoundary(continuationTurnId, forcedThisSeam, markerAlreadyPersisted = false) {
  return { applied: true, continuationTurnId, forcedThisSeam, markerAlreadyPersisted };
}

function makeInput(over = {}) {
  return {
    contractVersion: over.contractVersion ?? V,
    seam: { ...goodSeam, ...(over.seam || {}) },
    providerUsage: over.providerUsage ?? providerAbove,
    postMeasurementEstimate: over.postMeasurementEstimate ?? est(0),
    policy: { ...basePolicy, ...(over.policy || {}) },
    continuation: over.continuation ?? { kind: "active_non_tool" },
    invariants: { ...goodInvariants, ...(over.invariants || {}) },
    forcedContinuationBoundary: over.forcedContinuationBoundary ?? { applied: false },
    compactMaterial: { ...goodMaterial, ...(over.compactMaterial || {}) },
  };
}

const cases = [
  {
    name: "no_authoritative_provider_usage",
    coverage: ["no_authoritative_provider_usage"],
    description: "Missing provider usage never fabricates an upper trigger; continue normally (not via below_trigger).",
    input: makeInput({
      providerUsage: { available: false, reason: "missing", domain: "provider_reported_input" },
      continuation: { kind: "active_non_tool" },
    }),
  },
  {
    name: "below_trigger",
    coverage: ["below_trigger"],
    description: "Provider base + estimate below upper trigger continues normally.",
    input: makeInput({
      providerUsage: providerBelow,
      postMeasurementEstimate: est(10_000),
      continuation: { kind: "active_non_tool" },
    }),
  },
  {
    name: "normal_completion_below_pressure",
    coverage: ["normal_completion"],
    description: "Work complete below pressure: normal_complete, no empty continuation turn.",
    input: makeInput({
      providerUsage: providerBelow,
      postMeasurementEstimate: est(0),
      continuation: { kind: "none" },
    }),
  },
  {
    name: "normal_completion_above_pressure",
    coverage: ["normal_completion"],
    description: "Work complete above pressure still closes normally; no empty continuation turn.",
    input: makeInput({
      providerUsage: providerAbove,
      postMeasurementEstimate: est(5_000),
      continuation: { kind: "none" },
    }),
  },
  {
    name: "pending_tool_result_above_trigger",
    coverage: ["pending_tool_result_continuation"],
    description: "Above trigger with pending correlated tool result: keep turn open, preserve pair, no marker.",
    input: makeInput({
      providerUsage: providerAbove,
      postMeasurementEstimate: est(2_000),
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: ["call-42"],
        correlationValid: true,
      },
    }),
  },
  {
    name: "active_non_tool_above_trigger",
    coverage: ["active_non_tool_continuation"],
    description:
      "Above trigger active non-tool: force_turn_end then compact, one continuation turn via atomic turn_end, marker.",
    input: makeInput({
      forcedContinuationBoundary: appliedBoundary("t2", true),
      providerUsage: providerAbove,
      postMeasurementEstimate: est(1_000),
      continuation: { kind: "active_non_tool" },
    }),
  },
  {
    name: "derivation_gaps_degraded_compact",
    coverage: ["derivation_gaps_degraded"],
    description: "Missing/failed derivations degrade fidelity at compact assembly; do not block a valid compact.",
    input: makeInput({
      forcedContinuationBoundary: appliedBoundary("t2", true),
      providerUsage: providerAbove,
      continuation: { kind: "active_non_tool" },
      compactMaterial: {
        ...goodMaterial,
        derivationsMissingOrFailed: true,
        lowerTargetMet: true,
      },
    }),
  },
  {
    name: "lower_target_missed_valid_request",
    coverage: ["lower_target_missed"],
    description: "Lower target missed is not a success gate; valid request still installs (degraded).",
    input: makeInput({
      forcedContinuationBoundary: appliedBoundary("t2", true),
      providerUsage: providerAbove,
      continuation: { kind: "active_non_tool" },
      compactMaterial: {
        ...goodMaterial,
        lowerTargetMet: false,
        usefulReduction: true,
      },
    }),
  },
  {
    name: "incomplete_capture",
    coverage: ["incomplete_capture"],
    description: "Incomplete capture refuses even below pressure; claimed seam is untrustworthy.",
    input: makeInput({
      providerUsage: providerBelow,
      invariants: { ...goodInvariants, captureComplete: false },
    }),
  },
  {
    name: "invalid_tool_correlation",
    coverage: ["invalid_tool_correlation"],
    description: "Pending tool path with unproven correlation refuses.",
    input: makeInput({
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: ["call-bad"],
        correlationValid: false,
      },
    }),
  },
  {
    name: "invalid_provider_identity",
    coverage: ["invalid_provider_identity"],
    description: "Unproven provider identity refuses.",
    input: makeInput({
      invariants: { ...goodInvariants, providerIdentityValid: false },
    }),
  },
  {
    name: "compact_failed_preserve_tool",
    coverage: ["compact_install_failure", "pending_tool_result_continuation"],
    description:
      "Tool-preserve compact failure: claim+compact attempted; original turn open; prior view intact; writer released.",
    input: makeInput({
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: ["call-42"],
        correlationValid: true,
      },
      compactMaterial: { ...goodMaterial, compactStructurallyValid: false },
    }),
  },
  {
    name: "compact_failed_continue_turn",
    coverage: ["compact_install_failure", "active_non_tool_continuation", "post_boundary_failure"],
    description:
      "Active non-tool compact failure after forced boundary: boundary durable; no marker; prior view intact; writer released.",
    input: makeInput({
      forcedContinuationBoundary: appliedBoundary("t2", true),
      continuation: { kind: "active_non_tool" },
      compactMaterial: { ...goodMaterial, compactStructurallyValid: false },
    }),
  },
  {
    name: "install_failed_continue_turn",
    coverage: ["compact_install_failure", "active_non_tool_continuation", "post_boundary_failure"],
    description:
      "Install failure after forced boundary: no partial install; boundary durable; canonical marker persisted but not served; writer released.",
    input: makeInput({
      forcedContinuationBoundary: appliedBoundary("t2", true),
      continuation: { kind: "active_non_tool" },
      compactMaterial: { ...goodMaterial, installSucceeds: false },
    }),
  },
  {
    name: "install_failed_preserve_tool",
    coverage: ["compact_install_failure", "pending_tool_result_continuation", "preserve_tool_on_install_failure"],
    description:
      "Tool-preserve install failure: preserve pair before refuse; no marker; original turn open; prior view intact; writer released.",
    input: makeInput({
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: ["call-42"],
        correlationValid: true,
      },
      compactMaterial: { ...goodMaterial, installSucceeds: false },
    }),
  },
  {
    name: "native_writer_conflict",
    coverage: ["native_writer_conflict"],
    description: "Native/conflict writer claim refuses silent mid-turn fallback.",
    input: makeInput({
      invariants: { ...goodInvariants, writerClaim: "conflict" },
    }),
  },
  {
    name: "input_epoch_changed",
    coverage: ["stale_epoch_or_transport_retry"],
    description: "Input epoch change between decision and apply skips the seam safely.",
    input: makeInput({
      seam: { ...goodSeam, inputEpochAtDecision: 1, inputEpochAtApply: 2 },
    }),
  },
  {
    name: "transport_retry_attempt",
    coverage: ["stale_epoch_or_transport_retry"],
    description: "Inside transport retry: skip; never mutate.",
    input: makeInput({
      seam: { ...goodSeam, insideTransportRetry: true },
    }),
  },
  {
    name: "not_at_settled_seam",
    coverage: ["stale_epoch_or_transport_retry"],
    description: "Seam not yet settled is a skip/wait, not record corruption.",
    input: makeInput({
      seam: { ...goodSeam, captureFlushed: false },
    }),
  },
  {
    name: "no_useful_reduction",
    coverage: ["no_useful_reduction"],
    description: "No useful reduction without structural failure is a first-class non-error outcome.",
    input: makeInput({
      forcedContinuationBoundary: appliedBoundary("t2", true),
      continuation: { kind: "active_non_tool" },
      compactMaterial: { ...goodMaterial, usefulReduction: false },
    }),
  },
  {
    name: "pressure_from_estimate_crosses_trigger",
    coverage: ["active_non_tool_continuation"],
    description: "Provider base alone below trigger; labelled estimate pushes next-request pressure over.",
    input: makeInput({
      forcedContinuationBoundary: appliedBoundary("t2", true),
      providerUsage: {
        available: true,
        inputTokens: 80_000,
        cacheCreationTokens: 10_000,
        cacheReadTokens: 5_000,
        total: 95_000,
        domain: "provider_reported_input",
      },
      postMeasurementEstimate: est(10_000, "host_byte_estimate"),
      continuation: { kind: "active_non_tool" },
    }),
  },
  {
    name: "capability_limited_identical_decision",
    coverage: ["capability_limited", "active_non_tool_continuation"],
    description: "capability_limited host capability does not change the decision table or fabricate host effects.",
    input: makeInput({
      forcedContinuationBoundary: appliedBoundary("t2", true),
      policy: { ...basePolicy, hostCapability: "capability_limited" },
      continuation: { kind: "active_non_tool" },
    }),
  },
  {
    name: "pending_forced_boundary_repair",
    coverage: ["pending_boundary_repair", "active_non_tool_continuation"],
    description:
      "Repair after prior forced boundary: do not re-force turn_end or duplicate marker; resume compact onward.",
    input: makeInput({
      continuation: { kind: "active_non_tool" },
      forcedContinuationBoundary: appliedBoundary("t2", false),
    }),
  },
  {
    name: "pending_forced_boundary_compact_failed",
    coverage: ["pending_boundary_repair", "post_boundary_failure", "compact_install_failure"],
    description:
      "Repair compact failure with pending boundary: no duplicate force_turn_end; boundary remains; writer released.",
    input: makeInput({
      continuation: { kind: "active_non_tool" },
      forcedContinuationBoundary: appliedBoundary("t2", false),
      compactMaterial: { ...goodMaterial, compactStructurallyValid: false },
    }),
  },
  {
    name: "install_failed_no_reduction_continue_turn",
    coverage: ["compact_install_failure", "active_non_tool_continuation", "install_over_no_reduction"],
    description:
      "Install failure wins over no-reduction on continue-turn: no install_serving_view; marker persisted not served.",
    input: makeInput({
      forcedContinuationBoundary: appliedBoundary("t2", true),
      continuation: { kind: "active_non_tool" },
      compactMaterial: {
        ...goodMaterial,
        usefulReduction: false,
        installSucceeds: false,
      },
    }),
  },
  {
    name: "install_failed_no_reduction_preserve_tool",
    coverage: ["compact_install_failure", "pending_tool_result_continuation", "install_over_no_reduction"],
    description: "Install failure wins over no-reduction on preserve-tool: prior view intact; no next request.",
    input: makeInput({
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: ["call-42"],
        correlationValid: true,
      },
      compactMaterial: {
        ...goodMaterial,
        usefulReduction: false,
        installSucceeds: false,
      },
    }),
  },
  {
    name: "pending_boundary_missing_provider_usage",
    coverage: ["pending_boundary_repair", "pending_boundary_pressure_precedence"],
    description: "Pending boundary resumes repair despite missing provider usage (sunk cost; not continue_normal).",
    input: makeInput({
      providerUsage: { available: false, reason: "missing", domain: "provider_reported_input" },
      continuation: { kind: "active_non_tool" },
      forcedContinuationBoundary: appliedBoundary("t2", false),
    }),
  },
  {
    name: "pending_boundary_below_trigger",
    coverage: ["pending_boundary_repair", "pending_boundary_pressure_precedence"],
    description: "Pending boundary resumes repair despite now-below-trigger pressure.",
    input: makeInput({
      providerUsage: {
        available: true,
        inputTokens: 70_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 5_000,
        total: 75_000,
        domain: "provider_reported_input",
      },
      postMeasurementEstimate: est(0),
      continuation: { kind: "active_non_tool" },
      forcedContinuationBoundary: appliedBoundary("t2", false),
    }),
  },
  {
    name: "pending_boundary_illegal_kind_vs_native",
    coverage: ["invalid_pending_boundary_continuation", "forced_boundary_legality_precedence"],
    description:
      "forced_boundary_state_legality precedes writer_claim: applied+kind none refuses invalid_pending even when native conflict also present.",
    input: makeInput({
      continuation: { kind: "none" },
      forcedContinuationBoundary: appliedBoundary("t2", false),
      invariants: { ...goodInvariants, writerClaim: "native" },
    }),
  },
  {
    name: "pending_boundary_illegal_kind_none",
    coverage: ["invalid_pending_boundary_continuation"],
    description: "forcedContinuationBoundary with kind none is invalid continuation state.",
    input: makeInput({
      continuation: { kind: "none" },
      forcedContinuationBoundary: appliedBoundary("t2", false),
    }),
  },
  {
    name: "pending_boundary_protected_tool_escalation",
    coverage: ["protected_escalation", "pending_tool_result_continuation"],
    description: "v2: forced boundary + protected tool set is protected escalation (legal).",
    input: makeInput({
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: ["call-42"],
        correlationValid: true,
      },
      forcedContinuationBoundary: appliedBoundary("t2", false),
      compactMaterial: {
        protectedEscalationApplied: true,
        hostValidationStatus: "awaiting",
        projectedPressureSafe: true,
        projectedPressureTokens: 80_000,
        renderedSavingsTokens: 20_000,
        visibilityBoundaryBefore: 10,
        visibilityBoundaryAfter: 40,
        compactPointAtInstall: 5,
      },
    }),
  },
  {
    name: "fresh_force_marker_already_persisted_illegal",
    // Input is intentionally invalid; total-evaluator residual is still pinned for
    // direct typed callers. Harness branches on inputValidation, not coverage tags.
    inputValidation: "reject",
    coverage: [
      "invalid_pending_boundary_continuation",
      "fresh_force_marker_already_persisted_illegal",
      "forced_boundary_legality_precedence",
    ],
    description:
      "forcedThisSeam true + markerAlreadyPersisted true is illegal v1: forced_boundary_state_legality refuses invalid_pending without trusting the marker claim (residual markerPersisted/markerServed false; applied boundary/turn facts preserved). Input validation also rejects; fixture pins total-evaluator residual for direct callers.",
    // Intentionally input-invalid (validateForcedBoundary rejects). decide still
    // refuses at forced_boundary_state_legality for typed/direct callers.
    input: makeInput({
      continuation: { kind: "active_non_tool" },
      forcedContinuationBoundary: appliedBoundary("t2", true, true),
      // Native conflict also present: legality must still win (same stage precedence).
      invariants: { ...goodInvariants, writerClaim: "native" },
    }),
  },
  {
    name: "writer_claim_lhc_idempotent",
    coverage: ["writer_claim_lhc_idempotent", "active_non_tool_continuation"],
    description: "writerClaim lhc is an already-established claim; claim_writer in receipt is idempotent reassert.",
    input: makeInput({
      forcedContinuationBoundary: appliedBoundary("t2", true),
      invariants: { ...goodInvariants, writerClaim: "lhc" },
      continuation: { kind: "active_non_tool" },
    }),
  },
  {
    name: "pending_boundary_skip_preserves_residual",
    coverage: ["pending_boundary_residual_on_skip"],
    description: "Skip with pending boundary keeps forced boundary residual true and does not authorize next request.",
    input: makeInput({
      seam: { ...goodSeam, captureFlushed: false },
      continuation: { kind: "active_non_tool" },
      forcedContinuationBoundary: appliedBoundary("t2", false),
    }),
  },
  {
    name: "active_non_tool_missing_forced_boundary",
    coverage: ["invalid_pending_boundary_continuation", "missing_forced_boundary_above_trigger"],
    description:
      "active_non_tool above trigger with forcedContinuationBoundary.applied false refuses invalid_pending_boundary_continuation (runtime must force first).",
    input: makeInput({
      continuation: { kind: "active_non_tool" },
      forcedContinuationBoundary: { applied: false },
    }),
  },
  {
    name: "open_turn_invariant_broken",
    coverage: ["open_turn_invariant_broken", "record_request_health_refuse"],
    description: "singleOpenTurn false at a settled seam refuses open_turn_invariant_broken.",
    input: makeInput({
      invariants: { ...goodInvariants, singleOpenTurn: false },
    }),
  },
  {
    name: "repair_prior_marker_compact_failed",
    coverage: ["pending_boundary_repair", "post_boundary_failure", "marker_residual_state"],
    description:
      "Repair after prior marker persistence with compact failure: markerPersisted true, markerServed false; reassert key idempotently; no force_turn_end.",
    input: makeInput({
      continuation: { kind: "active_non_tool" },
      forcedContinuationBoundary: appliedBoundary("t4", false, true),
      compactMaterial: { ...goodMaterial, compactStructurallyValid: false },
    }),
  },
  {
    name: "writer_claim_lhc_incomplete_capture",
    coverage: ["writer_claim_lhc_idempotent", "settled_seam_lhc_claim_early_refuse"],
    description:
      "writerClaim lhc at settled seam with incomplete capture: claim_writer then refuse then release_writer; residual writerReleased true.",
    input: makeInput({
      invariants: { ...goodInvariants, writerClaim: "lhc", captureComplete: false },
    }),
  },
  // ── LIM-67 v2.0.0 ────────────────────────────────────────────────────────
  {
    name: "preserve_sufficient_safe_runway",
    coverage: ["pending_tool_result_continuation", "preserve_sufficient", "projected_pressure_formula"],
    description:
      "Pending preserve with useful reduction and projected pressure below safe runway installs normal preserve.",
    input: makeInput({
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: ["call-42"],
        correlationValid: true,
      },
      postMeasurementEstimate: est(2000),
      compactMaterial: {
        usefulReduction: true,
        projectedPressureTokens: 80_000,
        renderedSavingsTokens: 27_000,
        renderedSavingsSource: "lhc_rendered_history_estimate",
        renderedSavingsDomain: "source_labelled_estimate",
        safeRunwayThresholdTokens: 100_000,
        safeRunwayThresholdSource: "host_safe_runway",
        projectedPressureSafe: true,
        protectedEscalationApplied: false,
        hostValidationStatus: "not_required",
      },
    }),
  },
  {
    name: "no_reduction_escalation_material",
    coverage: ["pending_tool_result_continuation", "no_reduction_escalation", "protected_escalation"],
    description:
      "Escalated pending path with no useful reduction after protected boundary still installs (no_reduction).",
    input: makeInput({
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: ["call-a", "call-b"],
        correlationValid: true,
      },
      forcedContinuationBoundary: appliedBoundary("t3", true, false),
      compactMaterial: {
        usefulReduction: false,
        protectedEscalationApplied: true,
        projectedPressureTokens: 90_000,
        renderedSavingsTokens: 15_000,
        renderedSavingsSource: "lhc_rendered_history_estimate",
        renderedSavingsDomain: "source_labelled_estimate",
        safeRunwayThresholdTokens: 100_000,
        safeRunwayThresholdSource: "host_safe_runway",
        projectedPressureSafe: true,
        visibilityBoundaryBefore: 10,
        visibilityBoundaryAfter: 40,
        compactPointAtInstall: 5,
        hostValidationStatus: "awaiting",
      },
    }),
  },
  {
    name: "unsafe_runway_refuse",
    coverage: ["unsafe_runway", "maximal_prune_unsafe", "projected_pressure_formula"],
    description: "Maximal eligible pruning still leaves projected pressure unsafe — refuse without install.",
    input: makeInput({
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: ["call-42"],
        correlationValid: true,
      },
      compactMaterial: {
        compactStructurallyValid: true,
        canProduceValidProviderRequest: true,
        installSucceeds: false,
        usefulReduction: false,
        projectedPressureTokens: 150_000,
        renderedSavingsTokens: 5_000,
        renderedSavingsSource: "lhc_rendered_history_estimate",
        renderedSavingsDomain: "source_labelled_estimate",
        safeRunwayThresholdTokens: 100_000,
        safeRunwayThresholdSource: "host_safe_runway",
        projectedPressureSafe: false,
        maximalPruneInsufficient: true,
        protectedEscalationApplied: false,
        hostValidationStatus: "not_required",
      },
    }),
  },
  {
    name: "parallel_protected_ids",
    coverage: ["parallel_protected_ids", "pending_tool_result_continuation"],
    description: "Multiple sorted protected IDs preserved on normal preserve path.",
    input: makeInput({
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: ["call-a", "call-b", "call-c"],
        correlationValid: true,
      },
      compactMaterial: {
        projectedPressureTokens: 70_000,
        renderedSavingsTokens: 40_000,
        renderedSavingsSource: "lhc_rendered_history_estimate",
        renderedSavingsDomain: "source_labelled_estimate",
        safeRunwayThresholdTokens: 100_000,
        safeRunwayThresholdSource: "host_safe_runway",
        projectedPressureSafe: true,
      },
    }),
  },
  {
    name: "protected_ids_empty_reject",
    coverage: ["invalid_protected_pairs"],
    description: "Empty protectedToolCallIds is input-invalid / fails closed.",
    inputValidation: "reject",
    input: makeInput({
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: [],
        correlationValid: true,
      },
    }),
  },
  {
    name: "legacy_toolCallId_reject",
    coverage: ["no_dual_field_shim"],
    description: "Legacy single toolCallId field is rejected (no dual-field shim).",
    inputValidation: "reject",
    input: {
      contractVersion: V,
      seam: { ...goodSeam },
      providerUsage: providerAbove,
      postMeasurementEstimate: est(0),
      policy: { ...basePolicy },
      continuation: {
        kind: "pending_correlated_tool_result",
        toolCallId: "call-legacy",
        correlationValid: true,
      },
      invariants: { ...goodInvariants },
      forcedContinuationBoundary: { applied: false },
      compactMaterial: { ...goodMaterial },
    },
  },
  {
    name: "unsupported_contract_version_1",
    coverage: ["unsupported_contract_version"],
    description: "Contract 1.0.0 inputs fail closed under 2.0.0 oracle.",
    input: makeInput({
      contractVersion: "1.0.0",
      continuation: { kind: "active_non_tool" },
    }),
  },
  {
    name: "lower_target_miss_safe_runway",
    coverage: ["lower_target_missed", "safe_runway_not_lower_target"],
    description: "Lower target miss is not a refuse when projected pressure is under safe runway.",
    input: makeInput({
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: ["call-42"],
        correlationValid: true,
      },
      compactMaterial: {
        lowerTargetMet: false,
        usefulReduction: true,
        projectedPressureTokens: 90_000,
        renderedSavingsTokens: 20_000,
        renderedSavingsSource: "lhc_rendered_history_estimate",
        renderedSavingsDomain: "source_labelled_estimate",
        safeRunwayThresholdTokens: 100_000,
        safeRunwayThresholdSource: "host_safe_runway",
        projectedPressureSafe: true,
      },
    }),
  },
  {
    name: "host_validation_failed_after_core_install",
    coverage: ["host_validation_failed", "protected_escalation"],
    description: "Host validation failure after successful core install refuses without rolling back core install.",
    input: makeInput({
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: ["call-a", "call-b"],
        correlationValid: true,
      },
      forcedContinuationBoundary: appliedBoundary("t4", true, false),
      compactMaterial: {
        installSucceeds: true,
        usefulReduction: true,
        protectedEscalationApplied: true,
        projectedPressureTokens: 80_000,
        renderedSavingsTokens: 30_000,
        renderedSavingsSource: "lhc_rendered_history_estimate",
        renderedSavingsDomain: "source_labelled_estimate",
        safeRunwayThresholdTokens: 100_000,
        safeRunwayThresholdSource: "host_safe_runway",
        projectedPressureSafe: true,
        visibilityBoundaryBefore: 10,
        visibilityBoundaryAfter: 50,
        compactPointAtInstall: 8,
        hostValidationStatus: "failed",
      },
    }),
  },
];

mkdirSync(join(baseDir, "cases"), { recursive: true });

/** Closed vocabulary: whether validateCompactContinuationInput must accept or reject `input`. */
const INPUT_VALIDATION = Object.freeze({ accept: "accept", reject: "reject" });

const manifestCases = [];
for (const c of cases) {
  const inputValidation = c.inputValidation ?? INPUT_VALIDATION.accept;
  if (inputValidation !== INPUT_VALIDATION.accept && inputValidation !== INPUT_VALIDATION.reject) {
    throw new Error(
      `case ${c.name}: inputValidation must be "accept" | "reject", got ${JSON.stringify(inputValidation)}`,
    );
  }
  let expected;
  try {
    expected = decideCompactContinuation(c.input);
  } catch (err) {
    if (inputValidation !== INPUT_VALIDATION.reject) throw err;
    // Placeholder expected for pure validation-reject fixtures (not parity-compared).
    expected = {
      outcome: "refuse",
      terminalState: "terminal_refuse",
      transitionPath: ["idle", "terminal_refuse"],
      effects: [],
      receipt: {
        contractVersion: V,
        outcome: "refuse",
        reasonCode: "input_rejected",
        turnEndReason: null,
        pressure: {
          providerBaseTokens: null,
          providerBaseDomain: "provider_reported_input",
          estimateTokens: 0,
          estimateSource: "none",
          estimateDomain: "source_labelled_estimate",
          nextRequestPressureTokens: null,
          upperTriggerTokens: 0,
          atOrAboveTrigger: null,
          projectedPressureTokens: null,
          renderedSavingsTokens: null,
          renderedSavingsSource: null,
          renderedSavingsDomain: null,
          safeRunwayThresholdTokens: null,
          safeRunwayThresholdSource: null,
          projectedPressureSafe: null,
        },
        lowerTarget: { domain: "lhc_rendered_history", tokens: 0, met: null, isSuccessGate: false },
        fidelity: "full",
        degradationReasons: [],
        continuation: { opened: false, markerServed: false, sameAgenticTurnPreserved: true },
        reliefPath: "none",
        protectedToolCallIds: [],
        effects: [],
        residual: {
          writerReleased: true,
          priorServingViewIntact: true,
          forcedContinuationBoundaryApplied: false,
          continuationTurnOpened: false,
          continuationTurnId: null,
          markerPersisted: false,
          markerServed: false,
          originalAgenticTurnStillOpen: true,
          nextProviderRequestAllowed: false,
          reliefPath: "none",
          protectedToolCallIds: [],
          visibilityBoundaryBefore: null,
          visibilityBoundaryAfter: null,
          hostValidationStatus: "not_required",
          coreInstallRetainedPendingHostValidation: false,
        },
        refused: true,
        refuseCode: "unsupported_contract_version",
        skipped: false,
        skipCode: null,
        transitionPath: ["idle", "terminal_refuse"],
      },
    };
  }
  const body = {
    name: c.name,
    contractVersion: V,
    description: c.description,
    coverage: c.coverage,
    inputValidation,
    input: c.input,
    expected,
  };
  const file = `cases/${c.name}.json`;
  writeFileSync(join(baseDir, file), JSON.stringify(body, null, 2) + "\n");
  manifestCases.push({ file, name: c.name, coverage: c.coverage, inputValidation });
  console.log(
    "wrote",
    file,
    "→",
    inputValidation,
    expected.outcome,
    expected.receipt.refuseCode ?? expected.receipt.skipCode ?? "",
  );
}

const requiredCoverage = [
  "no_authoritative_provider_usage",
  "below_trigger",
  "normal_completion",
  "pending_tool_result_continuation",
  "active_non_tool_continuation",
  "derivation_gaps_degraded",
  "lower_target_missed",
  "incomplete_capture",
  "invalid_tool_correlation",
  "invalid_provider_identity",
  "compact_install_failure",
  "native_writer_conflict",
  "stale_epoch_or_transport_retry",
  "no_useful_reduction",
  "capability_limited",
  "pending_boundary_repair",
  "post_boundary_failure",
  "install_over_no_reduction",
  "pending_boundary_pressure_precedence",
  "invalid_pending_boundary_continuation",
  "fresh_force_marker_already_persisted_illegal",
  "writer_claim_lhc_idempotent",
  "pending_boundary_residual_on_skip",
  "missing_forced_boundary_above_trigger",
  "open_turn_invariant_broken",
  "record_request_health_refuse",
  "marker_residual_state",
  "settled_seam_lhc_claim_early_refuse",
  "preserve_tool_on_install_failure",
  "preserve_sufficient",
  "no_reduction_escalation",
  "protected_escalation",
  "unsafe_runway",
  "maximal_prune_unsafe",
  "projected_pressure_formula",
  "parallel_protected_ids",
  "invalid_protected_pairs",
  "no_dual_field_shim",
  "unsupported_contract_version",
  "safe_runway_not_lower_target",
  "host_validation_failed",
];

const manifest = {
  contractVersion: V,
  contractId: "lhc.compact_continuation",
  description:
    "Table-driven parity fixtures for the compact-continuation state machine (LIM-60). TypeScript and Rust consumers must match expected decisions exactly.",
  cases: manifestCases,
  requiredCoverage,
};
writeFileSync(join(baseDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("manifest:", manifestCases.length, "cases");
