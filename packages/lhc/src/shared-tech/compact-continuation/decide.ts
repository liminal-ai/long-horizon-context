/**
 * Pure compact-continuation decision function — whole-seam parity/receipt oracle.
 *
 * Deterministic: same input ⇒ same Decision (including transition path and
 * ordered effects). No I/O. LIM-61 executes stages, then uses this oracle to
 * classify and receipt the completed seam. See contract.ts protocol comment.
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
  type CompactContinuationResidualState,
  type CompactContinuationSkipCode,
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
  // Validator rejects unsafe combined sums; oracle assumes validated inputs.
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

function residual(parts: CompactContinuationResidualState): CompactContinuationResidualState {
  return parts;
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
    residual: CompactContinuationResidualState;
    refused: boolean;
    refuseCode: CompactContinuationRefuseCode | null;
    skipped: boolean;
    skipCode: CompactContinuationSkipCode | null;
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
    residual: parts.residual,
    refused: parts.refused,
    refuseCode: parts.refuseCode,
    skipped: parts.skipped,
    skipCode: parts.skipCode,
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
    residual: CompactContinuationResidualState;
    refused: boolean;
    refuseCode: CompactContinuationRefuseCode | null;
    skipped: boolean;
    skipCode: CompactContinuationSkipCode | null;
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
    residual: parts.residual,
    refused: parts.refused,
    refuseCode: parts.refuseCode,
    skipped: parts.skipped,
    skipCode: parts.skipCode,
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

/** Pre-claim refuse: no writer claimed, prior view intact, original turn open. */
function refuseEarly(
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
    residual: residual({
      writerReleased: true,
      priorServingViewIntact: true,
      forcedContinuationBoundaryApplied: false,
      continuationTurnOpened: false,
      markerServed: false,
      originalAgenticTurnStillOpen: true,
      nextProviderRequestAllowed: false,
    }),
    refused: true,
    refuseCode: code,
    skipped: false,
    skipCode: null,
    compactRan: false,
  });
}

/**
 * Unsupported contract version: refuse without claiming the input was accepted
 * as v1. Receipt contractVersion is the oracle version that classified the
 * refuse; reasonCode carries the rejected input version.
 */
function refuseUnsupportedVersion(input: CompactContinuationInput): CompactContinuationDecision {
  const rejected = String(input.contractVersion);
  const reason = `unsupported compact-continuation contract version ${rejected}; oracle is ${COMPACT_CONTINUATION_CONTRACT_VERSION}`;
  const effects: CompactContinuationEffect[] = [
    { type: "refuse", code: "unsupported_contract_version", reason },
    { type: "record_receipt", durable: true, userChatVisible: false },
  ];
  // Minimal pressure/lower receipts without trusting policy arithmetic.
  const pressure: CompactContinuationPressureReceipt = {
    providerBaseTokens: null,
    providerBaseDomain: "provider_reported_input",
    estimateTokens: 0,
    estimateSource: "none",
    estimateDomain: "source_labelled_estimate",
    nextRequestPressureTokens: null,
    upperTriggerTokens: 0,
    atOrAboveTrigger: null,
  };
  const receipt: CompactContinuationReceipt = {
    contractVersion: COMPACT_CONTINUATION_CONTRACT_VERSION,
    outcome: "refuse",
    reasonCode: `unsupported_contract_version:${rejected}`,
    turnEndReason: null,
    pressure,
    lowerTarget: {
      domain: "lhc_rendered_history",
      tokens: 0,
      met: null,
      isSuccessGate: false,
    },
    fidelity: "full",
    degradationReasons: [],
    continuation: {
      opened: false,
      markerServed: false,
      sameAgenticTurnPreserved: true,
    },
    effects,
    residual: residual({
      writerReleased: true,
      priorServingViewIntact: true,
      forcedContinuationBoundaryApplied: false,
      continuationTurnOpened: false,
      markerServed: false,
      originalAgenticTurnStillOpen: true,
      nextProviderRequestAllowed: false,
    }),
    refused: true,
    refuseCode: "unsupported_contract_version",
    skipped: false,
    skipCode: null,
    transitionPath: ["idle", "terminal_refuse"],
  };
  return {
    outcome: "refuse",
    terminalState: "terminal_refuse",
    transitionPath: ["idle", "terminal_refuse"],
    effects,
    receipt,
  };
}

function skip(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  code: CompactContinuationSkipCode,
  reason: string,
): CompactContinuationDecision {
  const effects: CompactContinuationEffect[] = [
    { type: "skip_seam", code, reason },
    { type: "record_receipt", durable: true, userChatVisible: false },
  ];
  return decide(input, {
    outcome: "skip_seam",
    terminalState: "terminal_skip",
    transitionPath: [...path, "terminal_skip"],
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
    residual: residual({
      writerReleased: true,
      priorServingViewIntact: true,
      forcedContinuationBoundaryApplied: false,
      continuationTurnOpened: false,
      markerServed: false,
      originalAgenticTurnStillOpen: true,
      nextProviderRequestAllowed: true,
    }),
    refused: false,
    refuseCode: null,
    skipped: true,
    skipCode: code,
    compactRan: false,
  });
}

function continueNormal(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  reasonCode: string,
  viaBelowTrigger: boolean,
): CompactContinuationDecision {
  const effects: CompactContinuationEffect[] = [{ type: "record_receipt", durable: true, userChatVisible: false }];
  const transitionPath: CompactContinuationState[] = viaBelowTrigger
    ? [...path, "below_trigger", "terminal_continue_normal"]
    : [...path, "terminal_continue_normal"];
  return decide(input, {
    outcome: "continue_normal",
    terminalState: "terminal_continue_normal",
    transitionPath,
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
    residual: residual({
      writerReleased: true,
      priorServingViewIntact: true,
      forcedContinuationBoundaryApplied: false,
      continuationTurnOpened: false,
      markerServed: false,
      originalAgenticTurnStillOpen: true,
      nextProviderRequestAllowed: true,
    }),
    refused: false,
    refuseCode: null,
    skipped: false,
    skipCode: null,
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
    residual: residual({
      writerReleased: true,
      priorServingViewIntact: true,
      forcedContinuationBoundaryApplied: false,
      continuationTurnOpened: false,
      markerServed: false,
      originalAgenticTurnStillOpen: false,
      nextProviderRequestAllowed: true,
    }),
    refused: false,
    refuseCode: null,
    skipped: false,
    skipCode: null,
    compactRan: false,
  });
}

function forceTurnEndEffect(): CompactContinuationEffect {
  return {
    type: "force_turn_end",
    reason: CONTEXT_COMPACT_CONTINUE_REASON,
    outcome: "completed",
    opensContinuationTurn: true,
    continuationTurnCount: 1,
  };
}

function compactEffect(input: CompactContinuationInput): CompactContinuationEffect {
  return {
    type: "compact",
    lowerTargetDomain: "lhc_rendered_history",
    lowerTargetTokens: input.policy.lowerTargetTokens,
    allowDegradedDerivations: true,
  };
}

function degradationReasonsOf(input: CompactContinuationInput): string[] {
  const reasons: string[] = [];
  if (input.compactMaterial.derivationsMissingOrFailed) {
    reasons.push("derivations_missing_or_failed");
  }
  if (!input.compactMaterial.lowerTargetMet) {
    reasons.push("lower_target_missed");
  }
  return reasons;
}

/**
 * Post-claim failure on tool-preserve path: original turn still open; prior
 * view intact; no marker; writer released.
 */
function refuseAfterPreserveAttempt(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  code: CompactContinuationRefuseCode,
  reason: string,
  effectsSoFar: CompactContinuationEffect[],
  compactRan: boolean,
): CompactContinuationDecision {
  const effects: CompactContinuationEffect[] = [
    ...effectsSoFar,
    { type: "refuse", code, reason },
    { type: "record_receipt", durable: true, userChatVisible: false },
    { type: "release_writer" },
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
    residual: residual({
      writerReleased: true,
      priorServingViewIntact: true,
      forcedContinuationBoundaryApplied: false,
      continuationTurnOpened: false,
      markerServed: false,
      originalAgenticTurnStillOpen: true,
      nextProviderRequestAllowed: false,
    }),
    refused: true,
    refuseCode: code,
    skipped: false,
    skipCode: null,
    compactRan,
  });
}

/**
 * Post-claim failure on continue-turn path after forced boundary: boundary and
 * one empty continuation turn remain durable; no marker; prior view intact;
 * no next provider request; writer released.
 */
function refuseAfterContinueAttempt(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  code: CompactContinuationRefuseCode,
  reason: string,
  effectsSoFar: CompactContinuationEffect[],
  compactRan: boolean,
  boundaryAppliedThisSeam: boolean,
): CompactContinuationDecision {
  const effects: CompactContinuationEffect[] = [
    ...effectsSoFar,
    { type: "refuse", code, reason },
    { type: "record_receipt", durable: true, userChatVisible: false },
    { type: "release_writer" },
  ];
  const boundaryApplied = boundaryAppliedThisSeam || input.pendingForcedContinuationBoundary;
  return decide(input, {
    outcome: "refuse",
    terminalState: "terminal_refuse",
    transitionPath: [...path, "terminal_refuse"],
    effects,
    reasonCode: code,
    turnEndReason: boundaryApplied ? CONTEXT_COMPACT_CONTINUE_REASON : null,
    fidelity: "full",
    degradationReasons: [],
    continuation: {
      opened: boundaryApplied,
      markerServed: false,
      sameAgenticTurnPreserved: !boundaryApplied,
    },
    residual: residual({
      writerReleased: true,
      priorServingViewIntact: true,
      forcedContinuationBoundaryApplied: boundaryApplied,
      continuationTurnOpened: boundaryApplied,
      markerServed: false,
      originalAgenticTurnStillOpen: !boundaryApplied,
      nextProviderRequestAllowed: false,
    }),
    refused: true,
    refuseCode: code,
    skipped: false,
    skipCode: null,
    compactRan,
  });
}

function insertDegradeAfterCompact(effects: CompactContinuationEffect[], degradationReasons: string[]): void {
  if (degradationReasons.length === 0) return;
  const compactIdx = effects.findIndex((e) => e.type === "compact");
  const insertAt = compactIdx >= 0 ? compactIdx + 1 : effects.length;
  effects.splice(insertAt, 0, {
    type: "degrade_fidelity",
    causes: degradationReasons,
  });
}

function postCompactTail(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  branch: "preserve_tool" | "continue_turn",
): CompactContinuationDecision {
  const material = input.compactMaterial;
  const degradationReasons = degradationReasonsOf(input);
  const branchState: CompactContinuationState =
    branch === "preserve_tool" ? "path_preserve_tool" : "path_continue_turn";
  const branchPath: CompactContinuationState[] = [...path, branchState];

  // ── continue_turn: claim → [force boundary if not pending] → compact → … ──
  if (branch === "continue_turn") {
    const boundaryAlreadyPending = input.pendingForcedContinuationBoundary;
    const effectsSoFar: CompactContinuationEffect[] = [{ type: "claim_writer", writer: "lhc" }];
    if (!boundaryAlreadyPending) {
      effectsSoFar.push(forceTurnEndEffect());
    }
    // Compact only after the just-closed turn is eligible (or already closed
    // on a pending-boundary repair).
    effectsSoFar.push(compactEffect(input));

    const pathAfterClaim: CompactContinuationState[] = [...branchPath, "compacting"];

    if (!material.compactStructurallyValid) {
      return refuseAfterContinueAttempt(
        input,
        pathAfterClaim,
        "compact_failed",
        "compact assembly could not produce a structurally valid view",
        effectsSoFar,
        true,
        !boundaryAlreadyPending,
      );
    }
    if (!material.canProduceValidProviderRequest) {
      // Structurally compacted but cannot form a valid request — no install.
      return refuseAfterContinueAttempt(
        input,
        pathAfterClaim,
        "no_valid_provider_request",
        "no structurally valid provider request can be produced",
        effectsSoFar,
        true,
        !boundaryAlreadyPending,
      );
    }

    // Fidelity degradation classified at compact assembly, before install.
    insertDegradeAfterCompact(effectsSoFar, degradationReasons);

    if (!material.usefulReduction) {
      // Install still proceeds when structure is valid; no_reduction is non-error.
      const effects: CompactContinuationEffect[] = [
        ...effectsSoFar,
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
      return decide(input, {
        outcome: "no_reduction",
        terminalState: "terminal_no_reduction",
        transitionPath: [...pathAfterClaim, "installing", "terminal_no_reduction"],
        effects,
        reasonCode: "no_useful_reduction",
        turnEndReason: CONTEXT_COMPACT_CONTINUE_REASON,
        fidelity: degradationReasons.length > 0 ? "degraded" : "full",
        degradationReasons,
        continuation: {
          opened: true,
          markerServed: true,
          sameAgenticTurnPreserved: false,
        },
        residual: residual({
          writerReleased: true,
          priorServingViewIntact: false,
          forcedContinuationBoundaryApplied: true,
          continuationTurnOpened: true,
          markerServed: true,
          originalAgenticTurnStillOpen: false,
          nextProviderRequestAllowed: true,
        }),
        refused: false,
        refuseCode: null,
        skipped: false,
        skipCode: null,
        compactRan: true,
      });
    }

    if (!material.installSucceeds) {
      // No marker, no install_serving_view — prior view intact.
      return refuseAfterContinueAttempt(
        input,
        [...pathAfterClaim, "installing"],
        "install_failed",
        "post-compact serving view could not be installed",
        effectsSoFar,
        true,
        !boundaryAlreadyPending,
      );
    }

    const effects: CompactContinuationEffect[] = [
      ...effectsSoFar,
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
    const outcome: CompactContinuationOutcomeKind = degraded ? "degraded_compact" : "compact_continue_turn";
    const terminal: CompactContinuationState = degraded ? "terminal_degraded" : "terminal_continue_turn";
    return decide(input, {
      outcome,
      terminalState: terminal,
      transitionPath: [...pathAfterClaim, "installing", terminal],
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
      residual: residual({
        writerReleased: true,
        priorServingViewIntact: false,
        forcedContinuationBoundaryApplied: true,
        continuationTurnOpened: true,
        markerServed: true,
        originalAgenticTurnStillOpen: false,
        nextProviderRequestAllowed: true,
      }),
      refused: false,
      refuseCode: null,
      skipped: false,
      skipCode: null,
      compactRan: true,
    });
  }

  // ── preserve_tool: claim → compact → preserve pair → install → … ──────────
  if (input.continuation.kind !== "pending_correlated_tool_result") {
    throw new Error("preserve_tool branch requires pending_correlated_tool_result");
  }
  const toolCallId = input.continuation.toolCallId;
  const effectsSoFar: CompactContinuationEffect[] = [{ type: "claim_writer", writer: "lhc" }, compactEffect(input)];
  const pathAfterClaim: CompactContinuationState[] = [...branchPath, "compacting"];

  if (!material.compactStructurallyValid) {
    return refuseAfterPreserveAttempt(
      input,
      pathAfterClaim,
      "compact_failed",
      "compact assembly could not produce a structurally valid view",
      effectsSoFar,
      true,
    );
  }
  if (!material.canProduceValidProviderRequest) {
    return refuseAfterPreserveAttempt(
      input,
      pathAfterClaim,
      "no_valid_provider_request",
      "no structurally valid provider request can be produced",
      effectsSoFar,
      true,
    );
  }

  insertDegradeAfterCompact(effectsSoFar, degradationReasons);

  if (!material.usefulReduction) {
    const effects: CompactContinuationEffect[] = [
      ...effectsSoFar,
      {
        type: "preserve_tool_pair_verbatim",
        toolCallId,
        location: "open_turn_tail",
      },
      { type: "install_serving_view" },
      { type: "record_receipt", durable: true, userChatVisible: false },
      { type: "release_writer" },
    ];
    return decide(input, {
      outcome: "no_reduction",
      terminalState: "terminal_no_reduction",
      transitionPath: [...pathAfterClaim, "installing", "terminal_no_reduction"],
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
      residual: residual({
        writerReleased: true,
        priorServingViewIntact: false,
        forcedContinuationBoundaryApplied: false,
        continuationTurnOpened: false,
        markerServed: false,
        originalAgenticTurnStillOpen: true,
        nextProviderRequestAllowed: true,
      }),
      refused: false,
      refuseCode: null,
      skipped: false,
      skipCode: null,
      compactRan: true,
    });
  }

  if (!material.installSucceeds) {
    // Preserve pair is a structural serve rule, not an install of a new view —
    // failure before install: prior view intact, no install effect.
    return refuseAfterPreserveAttempt(
      input,
      [...pathAfterClaim, "installing"],
      "install_failed",
      "post-compact serving view could not be installed",
      effectsSoFar,
      true,
    );
  }

  const effects: CompactContinuationEffect[] = [
    ...effectsSoFar,
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
  const outcome: CompactContinuationOutcomeKind = degraded ? "degraded_compact" : "compact_preserve_tool";
  const terminal: CompactContinuationState = degraded ? "terminal_degraded" : "terminal_preserve_tool";
  return decide(input, {
    outcome,
    terminalState: terminal,
    transitionPath: [...pathAfterClaim, "installing", terminal],
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
    residual: residual({
      writerReleased: true,
      priorServingViewIntact: false,
      forcedContinuationBoundaryApplied: false,
      continuationTurnOpened: false,
      markerServed: false,
      originalAgenticTurnStillOpen: true,
      nextProviderRequestAllowed: true,
    }),
    refused: false,
    refuseCode: null,
    skipped: false,
    skipCode: null,
    compactRan: true,
  });
}

/**
 * Evaluate compact-continuation for a completed (or classifiable) seam.
 *
 * Ordering is fixed (see COMPACT_CONTINUATION_TRANSITION_ORDER). Capability-
 * limited hosts still receive the full decision table; they must not claim
 * effects they cannot perform (host adapter concern, not decision rewriting).
 */
export function decideCompactContinuation(input: CompactContinuationInput): CompactContinuationDecision {
  if (input.contractVersion !== COMPACT_CONTINUATION_CONTRACT_VERSION) {
    return refuseUnsupportedVersion(input);
  }

  const seam = input.seam;

  // Transport retry is never a seam — skip without mutating.
  if (seam.insideTransportRetry) {
    return skip(input, ["idle"], "transport_retry", "mutation forbidden inside transport retry");
  }

  const atSeam =
    seam.modelResponseComplete && seam.requestedToolsSettled && seam.captureFlushed && seam.beforeNextProviderRequest;

  // Not yet settled: skip/wait — not record corruption, not a hard refuse.
  if (!atSeam) {
    return skip(
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

  // Writer exclusivity — hard refuse (story acceptance).
  if (input.invariants.writerClaim === "conflict" || input.invariants.writerClaim === "native") {
    return refuseEarly(
      input,
      path,
      "native_writer_conflict",
      "LHC and host-native compact must be one writer at a seam; native/conflict claim refuses silent mid-turn fallback",
    );
  }

  // Record/request-health proofs after a claimed settled seam — hard refuse
  // even below pressure (see refuse-code docs on contract.ts).
  if (!input.invariants.captureComplete) {
    return refuseEarly(
      input,
      path,
      "incomplete_capture",
      "capture of the settled model turn is incomplete; canonical record is not trustworthy",
    );
  }

  if (!input.invariants.providerIdentityValid) {
    return refuseEarly(
      input,
      path,
      "invalid_provider_identity",
      "required provider/model identity cannot be proven; next provider request is not trustworthy",
    );
  }

  if (!input.invariants.singleOpenTurn) {
    return refuseEarly(input, path, "open_turn_invariant_broken", "exactly-one-open-turn invariant does not hold");
  }

  if (input.continuation.kind === "pending_correlated_tool_result" && !input.continuation.correlationValid) {
    return refuseEarly(
      input,
      path,
      "invalid_tool_correlation",
      "pending tool-result continuation requires proven call/result correlation",
    );
  }

  // Provider usage authority — never fabricate upper-trigger base.
  // Missing usage does NOT route through below_trigger (pressure never evaluated).
  const evalPath: CompactContinuationState[] = [...path, "evaluating_pressure"];
  if (!input.providerUsage.available) {
    if (input.continuation.kind === "none") {
      return normalComplete(input, evalPath, "no_provider_usage_work_complete");
    }
    return continueNormal(input, evalPath, "no_provider_usage", false);
  }

  const pressure = pressureReceipt(input);
  if (pressure.atOrAboveTrigger !== true) {
    if (input.continuation.kind === "none") {
      return normalComplete(input, evalPath, "below_trigger_work_complete");
    }
    return continueNormal(input, evalPath, "below_trigger", true);
  }

  // Above trigger.
  if (input.continuation.kind === "none") {
    return normalComplete(input, evalPath, "normal_complete_above_pressure");
  }

  if (input.continuation.kind === "pending_correlated_tool_result") {
    return postCompactTail(input, evalPath, "preserve_tool");
  }

  // active_non_tool — pendingForcedContinuationBoundary skips re-forcing.
  return postCompactTail(input, evalPath, "continue_turn");
}
