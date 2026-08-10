/**
 * Pure observe-only governor decision.
 * No I/O, no mutation. Returns a named decision/reason.
 */

import { atOrAboveUpper } from "./provider-context.js";
import type { GovernorDecision, GovernorInput } from "./types.js";

function decide(
  kind: GovernorDecision["kind"],
  reason: string,
  input: GovernorInput,
): GovernorDecision {
  return {
    kind,
    reason,
    providerContextTotal: input.providerContext?.total ?? null,
    upperBoundTokens: input.policy.upperBoundTokens,
    lowerBoundTokens: input.policy.lowerBoundTokens,
    wouldMutate:
      kind === "would_compact" &&
      input.policyArmed &&
      input.policy.autoCompact &&
      !input.policy.observeOnly,
  };
}

/**
 * Deterministic decision at a settled-turn observation point.
 * Order of checks is intentional: invalid/disabled first, then safety gates,
 * then pressure, then would_compact.
 */
export function decideGovernor(input: GovernorInput): GovernorDecision {
  if (!input.policyArmed) {
    return decide("policy_invalid", "context policy is invalid or failed to load", input);
  }

  if (!input.policy.autoCompact) {
    return decide("policy_disabled", "autoCompact is disabled", input);
  }

  if (input.turnOpen) {
    return decide("turn_open", "turn is still open; compact only at settled boundary", input);
  }

  if (input.settleStale) {
    return decide("settle_stale", "settled observation is stale or already decided", input);
  }

  if (input.currentInputEpoch !== input.inputEpochAtTurnOpen) {
    return decide(
      "input_epoch_changed",
      `input epoch changed during turn (${input.inputEpochAtTurnOpen}→${input.currentInputEpoch})`,
      input,
    );
  }

  if (!input.captureHealthy) {
    return decide("capture_degraded", "capture is degraded or not healthy", input);
  }

  if (!input.descriptorReady) {
    return decide("descriptor_not_ready", "runtime descriptor is not ready", input);
  }

  if (input.operationInFlight) {
    return decide(
      "operation_in_flight",
      "compact, prune, or handoff already in flight",
      input,
    );
  }

  if (input.nativeSummaryAttention) {
    return decide(
      "native_summary_attention",
      "native compact summary requires operator attention",
      input,
    );
  }

  if (input.providerContext === null) {
    return decide("no_provider_usage", "no authoritative provider usage for this turn", input);
  }

  const total = input.providerContext.total;

  // Retry-growth / cooldown after a prior would_compact on the same generation.
  if (
    input.lastWouldCompactProviderTotal !== null &&
    input.lastWouldCompactCaptureGeneration === input.captureGeneration
  ) {
    const growth = total - input.lastWouldCompactProviderTotal;
    if (growth < input.policy.retryGrowthTokens) {
      return decide(
        "retry_growth_guard",
        `provider context grew only ${growth} tokens since last would_compact; need ${input.policy.retryGrowthTokens}`,
        input,
      );
    }
  }

  if (!atOrAboveUpper(total, input.policy.upperBoundTokens)) {
    return decide(
      "below_threshold",
      `provider context ${total} is below upperBoundTokens ${input.policy.upperBoundTokens}`,
      input,
    );
  }

  return decide(
    "would_compact",
    input.policy.observeOnly
      ? `provider context ${total} >= upperBoundTokens ${input.policy.upperBoundTokens}; observe-only (no mutation)`
      : `provider context ${total} >= upperBoundTokens ${input.policy.upperBoundTokens}; automatic compact eligible`,
    input,
  );
}
