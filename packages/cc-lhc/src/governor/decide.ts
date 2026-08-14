/**
 * Pure capability-limited governor decision (LIM-64).
 * No I/O, no mutation. Returns a named decision/reason and pressure receipt.
 *
 * Claude Code cannot replace the in-flight request mid-agentic-turn.
 * wouldMutate is true only at a settled seam for would_compact under an armed,
 * enabled, non-observe policy.
 */

import { atOrAboveUpper, buildPressureReceipt, normalizePostMeasurementEstimate } from "./provider-context.js";
import type { GovernorDecision, GovernorInput } from "./types.js";

function decide(
  kind: GovernorDecision["kind"],
  reason: string,
  input: GovernorInput,
  options: { forceNoMutate?: boolean } = {},
): GovernorDecision {
  const pressure = buildPressureReceipt(
    input.providerContext,
    input.postMeasurementEstimate,
    input.policy.upperBoundTokens,
  );
  const wouldMutate =
    options.forceNoMutate === true
      ? false
      : kind === "would_compact" &&
        !input.turnOpen &&
        input.policyArmed &&
        input.policy.autoCompact &&
        !input.policy.observeOnly;
  return {
    kind,
    reason,
    providerContextTotal: input.providerContext?.total ?? null,
    pressure,
    upperBoundTokens: input.policy.upperBoundTokens,
    lowerBoundTokens: input.policy.lowerBoundTokens,
    wouldMutate,
  };
}

/**
 * Deterministic decision at an observation point (open-turn or settled seam).
 * Order of checks is intentional: invalid/disabled first, then open-turn gate
 * (classify without mutation), then safety gates, then pressure, then would_compact.
 *
 * When turnOpen is true and pressure is at/above the upper trigger with gates
 * otherwise clear, the decision is still `would_compact` with wouldMutate=false
 * so the threshold crossing is classified and receipted without mutating mid-turn.
 */
export function decideGovernor(input: GovernorInput): GovernorDecision {
  const estimate = normalizePostMeasurementEstimate(input.postMeasurementEstimate);
  const inputWithEstimate: GovernorInput = { ...input, postMeasurementEstimate: estimate };

  if (!inputWithEstimate.policyArmed) {
    return decide("policy_invalid", "context policy is invalid or failed to load", inputWithEstimate);
  }

  if (!inputWithEstimate.policy.autoCompact) {
    return decide("policy_disabled", "autoCompact is disabled", inputWithEstimate);
  }

  // Open turn: still classify pressure / gates, but never mutate.
  // Explicit turn_open only when pressure is not yet actionable so callers can
  // distinguish "waiting for settle with no pressure" from threshold-crossed-open.
  if (inputWithEstimate.turnOpen) {
    return decideOpenTurn(inputWithEstimate);
  }

  if (inputWithEstimate.settleStale) {
    return decide("settle_stale", "settled observation is stale or already decided", inputWithEstimate);
  }

  if (inputWithEstimate.currentInputEpoch !== inputWithEstimate.inputEpochAtTurnOpen) {
    return decide(
      "input_epoch_changed",
      `input epoch changed during turn (${inputWithEstimate.inputEpochAtTurnOpen}→${inputWithEstimate.currentInputEpoch})`,
      inputWithEstimate,
    );
  }

  if (!inputWithEstimate.captureHealthy) {
    return decide("capture_degraded", "capture is degraded or not healthy", inputWithEstimate);
  }

  if (!inputWithEstimate.descriptorReady) {
    return decide("descriptor_not_ready", "runtime descriptor is not ready", inputWithEstimate);
  }

  if (inputWithEstimate.operationInFlight) {
    return decide("operation_in_flight", "compact, prune, or handoff already in flight", inputWithEstimate);
  }

  if (inputWithEstimate.nativeSummaryAttention) {
    return decide(
      "native_summary_attention",
      "native compact summary requires operator attention; LHC will not race the writer",
      inputWithEstimate,
    );
  }

  if (inputWithEstimate.providerContext === null) {
    return decide(
      "no_provider_usage",
      "no authoritative provider usage for this turn (missing/invalid latest usage clears stale authority)",
      inputWithEstimate,
    );
  }

  const pressure = buildPressureReceipt(
    inputWithEstimate.providerContext,
    estimate,
    inputWithEstimate.policy.upperBoundTokens,
  );
  const pressureTokens = pressure.nextRequestPressureTokens;
  if (pressureTokens === null) {
    return decide("no_provider_usage", "provider pressure could not be computed", inputWithEstimate);
  }

  // Retry-growth / cooldown after a prior would_compact on the same generation.
  // Compare predicted next-request pressure growth (provider + estimate).
  if (
    inputWithEstimate.lastWouldCompactProviderTotal !== null &&
    inputWithEstimate.lastWouldCompactCaptureGeneration === inputWithEstimate.captureGeneration
  ) {
    const growth = pressureTokens - inputWithEstimate.lastWouldCompactProviderTotal;
    if (growth < inputWithEstimate.policy.retryGrowthTokens) {
      return decide(
        "retry_growth_guard",
        `next-request pressure grew only ${growth} tokens since last would_compact; need ${inputWithEstimate.policy.retryGrowthTokens}`,
        inputWithEstimate,
      );
    }
  }

  if (!atOrAboveUpper(pressureTokens, inputWithEstimate.policy.upperBoundTokens)) {
    return decide(
      "below_threshold",
      `next-request pressure ${pressureTokens} (provider ${inputWithEstimate.providerContext.total} + estimate ${estimate.tokens}) is below upperBoundTokens ${inputWithEstimate.policy.upperBoundTokens}`,
      inputWithEstimate,
    );
  }

  return decide(
    "would_compact",
    inputWithEstimate.policy.observeOnly
      ? `next-request pressure ${pressureTokens} >= upperBoundTokens ${inputWithEstimate.policy.upperBoundTokens}; observe-only (no mutation)`
      : `next-request pressure ${pressureTokens} >= upperBoundTokens ${inputWithEstimate.policy.upperBoundTokens}; capability-limited compact eligible at settled seam`,
    inputWithEstimate,
  );
}

/**
 * Open-turn classification: record pressure and gate reasons; never mutate.
 * Threshold crossings use would_compact with wouldMutate=false so fixtures can
 * assert "threshold crossed while open" without mid-turn handoff.
 */
function decideOpenTurn(input: GovernorInput): GovernorDecision {
  if (input.currentInputEpoch !== input.inputEpochAtTurnOpen) {
    return decide(
      "input_epoch_changed",
      `input epoch changed during open turn (${input.inputEpochAtTurnOpen}→${input.currentInputEpoch}); no mid-turn mutation`,
      input,
      { forceNoMutate: true },
    );
  }

  if (!input.captureHealthy) {
    return decide("capture_degraded", "capture is degraded during open turn; no mid-turn mutation", input, {
      forceNoMutate: true,
    });
  }

  if (!input.descriptorReady) {
    return decide(
      "descriptor_not_ready",
      "runtime descriptor is not ready during open turn; no mid-turn mutation",
      input,
      { forceNoMutate: true },
    );
  }

  if (input.operationInFlight) {
    return decide(
      "operation_in_flight",
      "compact, prune, or handoff already in flight; no concurrent open-turn action",
      input,
      { forceNoMutate: true },
    );
  }

  if (input.nativeSummaryAttention) {
    return decide(
      "native_summary_attention",
      "native compact summary requires operator attention; no LHC writer race during open turn",
      input,
      { forceNoMutate: true },
    );
  }

  if (input.providerContext === null) {
    return decide(
      "no_provider_usage",
      "no authoritative provider usage during open turn (missing/invalid latest usage clears stale authority)",
      input,
      { forceNoMutate: true },
    );
  }

  const pressure = buildPressureReceipt(
    input.providerContext,
    input.postMeasurementEstimate,
    input.policy.upperBoundTokens,
  );
  const pressureTokens = pressure.nextRequestPressureTokens;
  if (pressureTokens === null) {
    return decide("no_provider_usage", "provider pressure could not be computed during open turn", input, {
      forceNoMutate: true,
    });
  }

  if (!atOrAboveUpper(pressureTokens, input.policy.upperBoundTokens)) {
    // Not yet at trigger: explicit turn_open (waiting for settle / more pressure).
    return decide(
      "turn_open",
      `turn is still open; next-request pressure ${pressureTokens} below upperBoundTokens ${input.policy.upperBoundTokens}; compact only at settled boundary`,
      input,
      { forceNoMutate: true },
    );
  }

  // Threshold crossed while open: classify would_compact, never mutate.
  return decide(
    "would_compact",
    `next-request pressure ${pressureTokens} >= upperBoundTokens ${input.policy.upperBoundTokens} during open turn; classified only — Claude Code cannot replace the in-flight request mid-agentic-turn`,
    input,
    { forceNoMutate: true },
  );
}
