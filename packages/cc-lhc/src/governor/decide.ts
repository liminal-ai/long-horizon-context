/**
 * Pure capability-limited governor decision.
 * No I/O, no mutation. Returns a named decision/reason and pressure receipt.
 *
 * Exactly two things decide whether an automatic compact happens: the user's
 * `autoCompact` policy and measured pressure. Capture health, descriptor
 * readiness, receipt storage, and typed-ahead input are diagnostics the
 * wrapper records and recovers from — none of them may suppress the treatment
 * from here. The remaining non-pressure kinds are sequencing, not vetoes:
 * `turn_open` says *not at this instant* and `operation_in_flight` says
 * *already running*; each is followed by another seam.
 *
 * Claude Code cannot replace the in-flight request mid-agentic-turn.
 * wouldMutate is true only at a settled seam for would_compact under an
 * enabled policy.
 */

import { buildPressureReceipt, normalizePostMeasurementEstimate } from "./provider-context.js";
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
    input.providerContextFreshness,
  );
  const wouldMutate =
    options.forceNoMutate === true ? false : kind === "would_compact" && !input.turnOpen && input.policy.autoCompact;
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

/** How the pressure base is described in a decision reason. */
function pressurePhrase(input: GovernorInput, pressureTokens: number): string {
  const base = input.providerContext?.total;
  const estimate = normalizePostMeasurementEstimate(input.postMeasurementEstimate).tokens;
  if (base === undefined) {
    return `next-request pressure ${pressureTokens} (no provider reading yet + estimate ${estimate})`;
  }
  const label = input.providerContextFreshness === "last_known" ? "last known provider" : "provider";
  return `next-request pressure ${pressureTokens} (${label} ${base} + estimate ${estimate})`;
}

/**
 * Deterministic decision at an observation point (open-turn or settled seam).
 * Order: explicit user policy, then the open-turn capability boundary, then
 * sequencing, then pressure.
 *
 * When turnOpen is true and pressure is at/above the upper trigger, the
 * decision is still `would_compact` with wouldMutate=false so the threshold
 * crossing is classified and receipted without mutating mid-turn.
 */
export function decideGovernor(input: GovernorInput): GovernorDecision {
  const estimate = normalizePostMeasurementEstimate(input.postMeasurementEstimate);
  const inputWithEstimate: GovernorInput = { ...input, postMeasurementEstimate: estimate };

  // The one legitimate stop: the user turned automatic compact off.
  if (!inputWithEstimate.policy.autoCompact) {
    return decide("policy_disabled", "autoCompact is disabled", inputWithEstimate);
  }

  if (inputWithEstimate.turnOpen) {
    return decideOpenTurn(inputWithEstimate);
  }

  if (inputWithEstimate.operationInFlight) {
    return decide("operation_in_flight", "compact, prune, or handoff already in flight", inputWithEstimate);
  }

  const pressure = buildPressureReceipt(
    inputWithEstimate.providerContext,
    estimate,
    inputWithEstimate.policy.upperBoundTokens,
    inputWithEstimate.providerContextFreshness,
  );
  const pressureTokens = pressure.nextRequestPressureTokens;

  if (pressure.atOrAboveTrigger) {
    return decide(
      "would_compact",
      `${pressurePhrase(inputWithEstimate, pressureTokens)} >= upperBoundTokens ${inputWithEstimate.policy.upperBoundTokens}; capability-limited compact eligible at settled seam`,
      inputWithEstimate,
    );
  }

  if (inputWithEstimate.contextLimitRejected) {
    return decide(
      "would_compact",
      `Claude rejected the request (Prompt is too long); capability-limited compact eligible at settled seam while ${pressurePhrase(inputWithEstimate, pressureTokens)} is below upperBoundTokens ${inputWithEstimate.policy.upperBoundTokens}`,
      inputWithEstimate,
    );
  }

  return decide(
    "below_threshold",
    `${pressurePhrase(inputWithEstimate, pressureTokens)} is below upperBoundTokens ${inputWithEstimate.policy.upperBoundTokens}`,
    inputWithEstimate,
  );
}

/**
 * Open-turn classification: record pressure; never mutate.
 * Threshold crossings use would_compact with wouldMutate=false so fixtures can
 * assert "threshold crossed while open" without mid-turn handoff.
 */
function decideOpenTurn(input: GovernorInput): GovernorDecision {
  if (input.operationInFlight) {
    return decide(
      "operation_in_flight",
      "compact, prune, or handoff already in flight; no concurrent open-turn action",
      input,
      { forceNoMutate: true },
    );
  }

  const pressure = buildPressureReceipt(
    input.providerContext,
    input.postMeasurementEstimate,
    input.policy.upperBoundTokens,
    input.providerContextFreshness,
  );
  const pressureTokens = pressure.nextRequestPressureTokens;

  if (!pressure.atOrAboveTrigger) {
    // Not yet at trigger: explicit turn_open (waiting for settle / more pressure).
    return decide(
      "turn_open",
      `turn is still open; ${pressurePhrase(input, pressureTokens)} below upperBoundTokens ${input.policy.upperBoundTokens}; compact only at settled boundary`,
      input,
      { forceNoMutate: true },
    );
  }

  // Threshold crossed while open: classify would_compact, never mutate.
  return decide(
    "would_compact",
    `${pressurePhrase(input, pressureTokens)} >= upperBoundTokens ${input.policy.upperBoundTokens} during open turn; classified only — Claude Code cannot replace the in-flight request mid-agentic-turn`,
    input,
    { forceNoMutate: true },
  );
}
