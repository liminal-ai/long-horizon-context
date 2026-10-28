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
  const wouldMutate = options.forceNoMutate === true ? false : kind === "would_compact" && !input.turnOpen;
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

function pressurePhrase(input: GovernorInput, pressureTokens: number): string {
  const base = input.providerContext?.total;
  const estimate = normalizePostMeasurementEstimate(input.postMeasurementEstimate).tokens;
  if (base === undefined) {
    return `next-request pressure ${pressureTokens} (no provider reading yet + estimate ${estimate})`;
  }
  const label = input.providerContextFreshness === "last_known" ? "last known provider" : "provider";
  return `next-request pressure ${pressureTokens} (${label} ${base} + estimate ${estimate})`;
}

export function decideGovernor(input: GovernorInput): GovernorDecision {
  const estimate = normalizePostMeasurementEstimate(input.postMeasurementEstimate);
  const inputWithEstimate: GovernorInput = { ...input, postMeasurementEstimate: estimate };

  if (inputWithEstimate.turnOpen) {
    return decideOpenTurn(inputWithEstimate);
  }

  if (inputWithEstimate.operationInFlight) {
    return decide("operation_in_flight", "Smart Compact, Tool Prune, or handoff already in flight", inputWithEstimate);
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
      `${pressurePhrase(inputWithEstimate, pressureTokens)} >= upperBoundTokens ${inputWithEstimate.policy.upperBoundTokens}; capability-limited Smart Compact eligible at settled seam`,
      inputWithEstimate,
    );
  }

  if (inputWithEstimate.contextLimitRejected) {
    return decide(
      "would_compact",
      `Claude rejected the request (Prompt is too long); capability-limited Smart Compact eligible at settled seam while ${pressurePhrase(inputWithEstimate, pressureTokens)} is below upperBoundTokens ${inputWithEstimate.policy.upperBoundTokens}`,
      inputWithEstimate,
    );
  }

  return decide(
    "below_threshold",
    `${pressurePhrase(inputWithEstimate, pressureTokens)} is below upperBoundTokens ${inputWithEstimate.policy.upperBoundTokens}`,
    inputWithEstimate,
  );
}

function decideOpenTurn(input: GovernorInput): GovernorDecision {
  if (input.operationInFlight) {
    return decide(
      "operation_in_flight",
      "Smart Compact, Tool Prune, or handoff already in flight; no concurrent open-turn action",
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
    return decide(
      "turn_open",
      `turn is still open; ${pressurePhrase(input, pressureTokens)} below upperBoundTokens ${input.policy.upperBoundTokens}; Smart Compact only at settled boundary`,
      input,
      { forceNoMutate: true },
    );
  }

  return decide(
    "would_compact",
    `${pressurePhrase(input, pressureTokens)} >= upperBoundTokens ${input.policy.upperBoundTokens} during open turn; classified only — Claude Code cannot replace the in-flight request mid-agentic-turn`,
    input,
    { forceNoMutate: true },
  );
}
