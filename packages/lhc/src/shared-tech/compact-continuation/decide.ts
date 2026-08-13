/**
 * Pure compact-continuation decision function.
 *
 * Deterministic: same input ⇒ same Decision (including transition path and
 * ordered effects). No I/O. This is the contract-definition evaluator for
 * fixture parity; LIM-61 will call the same rules from host runtime.
 */

import {
  COMPACT_CONTINUATION_CONTRACT_VERSION,
  COMPACT_CONTINUATION_MARKER_KIND,
  CONTEXT_COMPACT_CONTINUE_REASON,
  type CompactContinuationDecision,
  type CompactContinuationEffect,
  type CompactContinuationInput,
  type CompactContinuationLowerTargetReceipt,
  type CompactContinuationOutcomeKind,
  type CompactContinuationPressureReceipt,
  type CompactContinuationReceipt,
  type CompactContinuationRefuseCode,
  type CompactContinuationState,
} from "./contract.js";

function pressureReceipt(input: CompactContinuationInput): CompactContinuationPressureReceipt {
  const { providerUsage, postMeasurementEstimate, policy } = input;
  if (!providerUsage.available) {
    return {
      providerBaseTokens: null,
      providerBaseDomain: "provider_reported_input",
      estimateTokens: postMeasurementEstimate.tokens,
      estimateSource: postMeasurementEstimate.source,
      estimateDomain: "source_labelled_estimate",
      nextRequestPressureTokens: null,
      upperTriggerTokens: policy.upperTriggerTokens,
      atOrAboveTrigger: null,
    };
  }
  const next = providerUsage.total + postMeasurementEstimate.tokens;
  return {
    providerBaseTokens: providerUsage.total,
    providerBaseDomain: "provider_reported_input",
    estimateTokens: postMeasurementEstimate.tokens,
    estimateSource: postMeasurementEstimate.source,
    estimateDomain: "source_labelled_estimate",
    nextRequestPressureTokens: next,
    upperTriggerTokens: policy.upperTriggerTokens,
    atOrAboveTrigger: next >= policy.upperTriggerTokens,
  };
}

function lowerTargetReceipt(
  input: CompactContinuationInput,
  compactRan: boolean,
): CompactContinuationLowerTargetReceipt {
  return {
    domain: "lhc_rendered_history",
    tokens: input.policy.lowerTargetTokens,
    met: compactRan ? input.compactMaterial.lowerTargetMet : null,
    isSuccessGate: false,
  };
}

function baseReceipt(
  input: CompactContinuationInput,
  parts: {
    outcome: CompactContinuationOutcomeKind;
    reasonCode: string;
    turnEndReason: typeof CONTEXT_COMPACT_CONTINUE_REASON | null;
    fidelity: "full" | "degraded";
    degradationReasons: string[];
    continuation: CompactContinuationReceipt["continuation"];
    effects: CompactContinuationEffect[];
    refused: boolean;
    refuseCode: CompactContinuationRefuseCode | null;
    transitionPath: CompactContinuationState[];
    compactRan: boolean;
  },
): CompactContinuationReceipt {
  return {
    contractVersion: COMPACT_CONTINUATION_CONTRACT_VERSION,
    outcome: parts.outcome,
    reasonCode: parts.reasonCode,
    turnEndReason: parts.turnEndReason,
    pressure: pressureReceipt(input),
    lowerTarget: lowerTargetReceipt(input, parts.compactRan),
    fidelity: parts.fidelity,
    degradationReasons: parts.degradationReasons,
    continuation: parts.continuation,
    effects: parts.effects,
    refused: parts.refused,
    refuseCode: parts.refuseCode,
    transitionPath: parts.transitionPath,
  };
}

function decide(
  input: CompactContinuationInput,
  parts: {
    outcome: CompactContinuationOutcomeKind;
    terminalState: CompactContinuationState;
    transitionPath: CompactContinuationState[];
    effects: CompactContinuationEffect[];
    reasonCode: string;
    turnEndReason: typeof CONTEXT_COMPACT_CONTINUE_REASON | null;
    fidelity: "full" | "degraded";
    degradationReasons: string[];
    continuation: CompactContinuationReceipt["continuation"];
    refused: boolean;
    refuseCode: CompactContinuationRefuseCode | null;
    compactRan: boolean;
  },
): CompactContinuationDecision {
  const receipt = baseReceipt(input, {
    outcome: parts.outcome,
    reasonCode: parts.reasonCode,
    turnEndReason: parts.turnEndReason,
    fidelity: parts.fidelity,
    degradationReasons: parts.degradationReasons,
    continuation: parts.continuation,
    effects: parts.effects,
    refused: parts.refused,
    refuseCode: parts.refuseCode,
    transitionPath: parts.transitionPath,
    compactRan: parts.compactRan,
  });
  return {
    outcome: parts.outcome,
    terminalState: parts.terminalState,
    transitionPath: parts.transitionPath,
    effects: parts.effects,
    receipt,
  };
}

function refuse(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  code: CompactContinuationRefuseCode,
  reason: string,
): CompactContinuationDecision {
  const effects: CompactContinuationEffect[] = [
    { type: "refuse", code, reason },
    { type: "record_receipt", durable: true, userChatVisible: false },
  ];
  return decide(input, {
    outcome: "refuse",
    terminalState: "terminal_refuse",
    transitionPath: [...path, "terminal_refuse"],
    effects,
    reasonCode: code,
    turnEndReason: null,
    fidelity: "full",
    degradationReasons: [],
    continuation: {
      opened: false,
      markerServed: false,
      sameAgenticTurnPreserved: true,
    },
    refused: true,
    refuseCode: code,
    compactRan: false,
  });
}

function skip(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  reasonCode: string,
  reason: string,
): CompactContinuationDecision {
  const effects: CompactContinuationEffect[] = [
    { type: "skip_seam", reason },
    { type: "record_receipt", durable: true, userChatVisible: false },
  ];
  return decide(input, {
    outcome: "skip_seam",
    terminalState: "terminal_skip",
    transitionPath: [...path, "terminal_skip"],
    effects,
    reasonCode,
    turnEndReason: null,
    fidelity: "full",
    degradationReasons: [],
    continuation: {
      opened: false,
      markerServed: false,
      sameAgenticTurnPreserved: true,
    },
    refused: false,
    refuseCode: null,
    compactRan: false,
  });
}

function continueNormal(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  reasonCode: string,
): CompactContinuationDecision {
  const effects: CompactContinuationEffect[] = [{ type: "record_receipt", durable: true, userChatVisible: false }];
  return decide(input, {
    outcome: "continue_normal",
    terminalState: "terminal_continue_normal",
    transitionPath: [...path, "below_trigger", "terminal_continue_normal"],
    effects,
    reasonCode,
    turnEndReason: null,
    fidelity: "full",
    degradationReasons: [],
    continuation: {
      opened: false,
      markerServed: false,
      sameAgenticTurnPreserved: true,
    },
    refused: false,
    refuseCode: null,
    compactRan: false,
  });
}

function normalComplete(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  reasonCode: string,
): CompactContinuationDecision {
  const effects: CompactContinuationEffect[] = [{ type: "record_receipt", durable: true, userChatVisible: false }];
  return decide(input, {
    outcome: "normal_complete",
    terminalState: "terminal_normal_complete",
    transitionPath: [...path, "path_normal_complete", "terminal_normal_complete"],
    effects,
    reasonCode,
    turnEndReason: null,
    fidelity: "full",
    degradationReasons: [],
    continuation: {
      opened: false,
      markerServed: false,
      sameAgenticTurnPreserved: false,
    },
    refused: false,
    refuseCode: null,
    compactRan: false,
  });
}

function compactEffects(input: CompactContinuationInput): CompactContinuationEffect[] {
  return [
    { type: "claim_writer", writer: "lhc" },
    {
      type: "compact",
      lowerTargetDomain: "lhc_rendered_history",
      lowerTargetTokens: input.policy.lowerTargetTokens,
      allowDegradedDerivations: true,
    },
  ];
}

function postCompactTail(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  branch: "preserve_tool" | "continue_turn",
): CompactContinuationDecision {
  const material = input.compactMaterial;
  const degradationReasons: string[] = [];
  if (material.derivationsMissingOrFailed) {
    degradationReasons.push("derivations_missing_or_failed");
  }
  if (!material.lowerTargetMet) {
    degradationReasons.push("lower_target_missed");
  }

  // Hard refuse after attempting compact path only when structure/install fails
  // or no valid request can be produced.
  if (!material.compactStructurallyValid) {
    return refuse(
      input,
      [...path, "compacting"],
      "compact_failed",
      "compact assembly could not produce a structurally valid view",
    );
  }
  if (!material.installSucceeds) {
    return refuse(
      input,
      [...path, "compacting", "installing"],
      "install_failed",
      "post-compact serving view could not be installed",
    );
  }
  if (!material.canProduceValidProviderRequest) {
    return refuse(
      input,
      [...path, "compacting", "installing"],
      "no_valid_provider_request",
      "no structurally valid provider request can be produced",
    );
  }

  if (!material.usefulReduction) {
    const effects: CompactContinuationEffect[] = [
      ...compactEffects(input),
      { type: "install_serving_view" },
      { type: "record_receipt", durable: true, userChatVisible: false },
      { type: "release_writer" },
    ];
    if (degradationReasons.length > 0) {
      effects.splice(effects.length - 2, 0, {
        type: "degrade_fidelity",
        causes: degradationReasons,
      });
    }
    return decide(input, {
      outcome: "no_reduction",
      terminalState: "terminal_no_reduction",
      transitionPath: [...path, "compacting", "installing", "terminal_no_reduction"],
      effects,
      reasonCode: "no_useful_reduction",
      turnEndReason: null,
      fidelity: degradationReasons.length > 0 ? "degraded" : "full",
      degradationReasons,
      continuation: {
        opened: false,
        markerServed: false,
        sameAgenticTurnPreserved: true,
      },
      refused: false,
      refuseCode: null,
      compactRan: true,
    });
  }

  if (branch === "preserve_tool") {
    if (input.continuation.kind !== "pending_correlated_tool_result") {
      throw new Error("preserve_tool branch requires pending_correlated_tool_result");
    }
    const toolCallId = input.continuation.toolCallId;
    const effects: CompactContinuationEffect[] = [
      ...compactEffects(input),
      {
        type: "preserve_tool_pair_verbatim",
        toolCallId,
        location: "open_turn_tail",
      },
      { type: "install_serving_view" },
      { type: "record_receipt", durable: true, userChatVisible: false },
      { type: "release_writer" },
    ];
    const degraded = degradationReasons.length > 0;
    if (degraded) {
      effects.splice(effects.length - 2, 0, {
        type: "degrade_fidelity",
        causes: degradationReasons,
      });
    }
    const outcome: CompactContinuationOutcomeKind = degraded ? "degraded_compact" : "compact_preserve_tool";
    const terminal: CompactContinuationState = degraded ? "terminal_degraded" : "terminal_preserve_tool";
    return decide(input, {
      outcome,
      terminalState: terminal,
      transitionPath: [...path, "path_preserve_tool", "compacting", "installing", terminal],
      effects,
      reasonCode: degraded ? "degraded_preserve_tool" : "compact_preserve_tool",
      turnEndReason: null,
      fidelity: degraded ? "degraded" : "full",
      degradationReasons,
      continuation: {
        opened: false,
        markerServed: false,
        sameAgenticTurnPreserved: true,
      },
      refused: false,
      refuseCode: null,
      compactRan: true,
    });
  }

  // continue_turn
  const effects: CompactContinuationEffect[] = [
    ...compactEffects(input),
    {
      type: "force_turn_end",
      reason: CONTEXT_COMPACT_CONTINUE_REASON,
      outcome: "completed",
    },
    { type: "open_continuation_turn", count: 1 },
    {
      type: "insert_continuation_marker",
      kind: COMPACT_CONTINUATION_MARKER_KIND,
      modelVisible: true,
      lhcInspectVisible: true,
      userChatVisible: false,
      hostMayInjectTransiently: true,
    },
    { type: "install_serving_view" },
    { type: "record_receipt", durable: true, userChatVisible: false },
    { type: "release_writer" },
  ];
  const degraded = degradationReasons.length > 0;
  if (degraded) {
    effects.splice(effects.length - 2, 0, {
      type: "degrade_fidelity",
      causes: degradationReasons,
    });
  }
  const outcome: CompactContinuationOutcomeKind = degraded ? "degraded_compact" : "compact_continue_turn";
  const terminal: CompactContinuationState = degraded ? "terminal_degraded" : "terminal_continue_turn";
  return decide(input, {
    outcome,
    terminalState: terminal,
    transitionPath: [...path, "path_continue_turn", "compacting", "installing", terminal],
    effects,
    reasonCode: degraded ? "degraded_continue_turn" : CONTEXT_COMPACT_CONTINUE_REASON,
    turnEndReason: CONTEXT_COMPACT_CONTINUE_REASON,
    fidelity: degraded ? "degraded" : "full",
    degradationReasons,
    continuation: {
      opened: true,
      markerServed: true,
      sameAgenticTurnPreserved: false,
    },
    refused: false,
    refuseCode: null,
    compactRan: true,
  });
}

/**
 * Evaluate compact-continuation at a candidate seam.
 *
 * Ordering is fixed (see COMPACT_CONTINUATION_TRANSITION_ORDER). Capability-
 * limited hosts still receive the full decision table; they must not claim
 * effects they cannot perform (host adapter concern, not decision rewriting).
 */
export function decideCompactContinuation(input: CompactContinuationInput): CompactContinuationDecision {
  if (input.contractVersion !== COMPACT_CONTINUATION_CONTRACT_VERSION) {
    return refuse(
      input,
      ["idle"],
      "no_valid_provider_request",
      `unsupported compact-continuation contract version ${input.contractVersion}`,
    );
  }

  const seam = input.seam;
  const atSeam =
    seam.modelResponseComplete &&
    seam.requestedToolsSettled &&
    seam.captureFlushed &&
    seam.beforeNextProviderRequest &&
    !seam.insideTransportRetry;

  // Transport retry is never a seam — skip without mutating.
  if (seam.insideTransportRetry) {
    return skip(input, ["idle"], "transport_retry", "mutation forbidden inside transport retry");
  }

  if (!atSeam) {
    return refuse(
      input,
      ["idle"],
      "not_at_settled_seam",
      "compact-continuation requires a settled model-turn seam before the next provider request",
    );
  }

  const path: CompactContinuationState[] = ["at_seam", "checking_invariants"];

  // Input epoch: decision and apply must match (steering race).
  if (seam.inputEpochAtDecision !== seam.inputEpochAtApply) {
    return skip(
      input,
      path,
      "input_epoch_changed",
      `input epoch changed (${seam.inputEpochAtDecision}→${seam.inputEpochAtApply}); skip seam`,
    );
  }

  // Writer exclusivity.
  if (input.invariants.writerClaim === "conflict" || input.invariants.writerClaim === "native") {
    return refuse(
      input,
      path,
      "native_writer_conflict",
      "LHC and host-native compact must be one writer at a seam; native/conflict claim refuses silent mid-turn fallback",
    );
  }

  if (!input.invariants.captureComplete) {
    return refuse(
      input,
      path,
      "incomplete_capture",
      "capture of the settled model turn is incomplete; invariants cannot be proven",
    );
  }

  if (!input.invariants.providerIdentityValid) {
    return refuse(
      input,
      path,
      "invalid_provider_identity",
      "required provider/model identity cannot be proven for a valid request",
    );
  }

  if (!input.invariants.singleOpenTurn) {
    return refuse(input, path, "open_turn_invariant_broken", "exactly-one-open-turn invariant does not hold");
  }

  if (input.continuation.kind === "pending_correlated_tool_result" && !input.continuation.correlationValid) {
    return refuse(
      input,
      path,
      "invalid_tool_correlation",
      "pending tool-result continuation requires proven call/result correlation",
    );
  }

  // Provider usage authority — never fabricate upper-trigger base.
  const evalPath: CompactContinuationState[] = [...path, "evaluating_pressure"];
  if (!input.providerUsage.available) {
    // Without authoritative measurement: no trigger fire; continue normally
    // (or normal_complete if work already done).
    if (input.continuation.kind === "none") {
      return normalComplete(input, evalPath, "no_provider_usage_work_complete");
    }
    return continueNormal(input, evalPath, "no_provider_usage");
  }

  const pressure = pressureReceipt(input);
  if (pressure.atOrAboveTrigger !== true) {
    if (input.continuation.kind === "none") {
      return normalComplete(input, evalPath, "below_trigger_work_complete");
    }
    return continueNormal(input, evalPath, "below_trigger");
  }

  // Above trigger.
  if (input.continuation.kind === "none") {
    // Work finished: close normally — no empty continuation turn, no compact
    // forced solely by residual pressure at completion.
    return normalComplete(input, evalPath, "normal_complete_above_pressure");
  }

  if (input.continuation.kind === "pending_correlated_tool_result") {
    return postCompactTail(input, evalPath, "preserve_tool");
  }

  // active_non_tool
  return postCompactTail(input, evalPath, "continue_turn");
}
