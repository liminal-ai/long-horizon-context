/**
 * Pure compact-continuation decision function — whole-seam parity/receipt oracle.
 *
 * Deterministic: same input ⇒ same Decision (including transition path and
 * ordered effects). No I/O. LIM-61 executes stages, then uses this oracle to
 * classify and receipt the completed seam. See contract.ts protocol comment.
 */

import {
  COMPACT_CONTINUATION_CONTRACT_VERSION,
  COMPACT_CONTINUATION_MARKER_ACTION,
  COMPACT_CONTINUATION_MARKER_CAUSE,
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
  type CompactContinuationReliefPath,
  type CompactContinuationResidualState,
  type CompactContinuationSkipCode,
  type CompactContinuationState,
  compactContinuationMarkerIdempotencyKey,
  type ForcedContinuationBoundary,
  normalizeProtectedToolCallIds,
} from "./contract.js";

function isAppliedBoundary(b: ForcedContinuationBoundary): b is Extract<ForcedContinuationBoundary, { applied: true }> {
  return b.applied === true;
}

function pressureReceipt(input: CompactContinuationInput): CompactContinuationPressureReceipt {
  const { providerUsage, postMeasurementEstimate, policy, compactMaterial } = input;
  const savings =
    typeof compactMaterial.renderedSavingsTokens === "number" ? compactMaterial.renderedSavingsTokens : null;
  const savingsSource = compactMaterial.renderedSavingsSource ?? null;
  const projected =
    compactMaterial.projectedPressureTokens !== undefined ? compactMaterial.projectedPressureTokens : null;
  const safeThreshold =
    compactMaterial.safeRunwayThresholdTokens !== undefined
      ? compactMaterial.safeRunwayThresholdTokens
      : (policy.safeRunwayThresholdTokens ?? null);
  const safeSource =
    compactMaterial.safeRunwayThresholdSource !== undefined
      ? compactMaterial.safeRunwayThresholdSource
      : (policy.safeRunwayThresholdSource ?? null);
  const projectedSafe =
    compactMaterial.projectedPressureSafe !== undefined ? compactMaterial.projectedPressureSafe : null;

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
      projectedPressureTokens: null,
      renderedSavingsTokens: savings,
      renderedSavingsSource: savingsSource,
      renderedSavingsDomain: savings === null ? null : "source_labelled_estimate",
      safeRunwayThresholdTokens: safeThreshold,
      safeRunwayThresholdSource: safeSource,
      projectedPressureSafe: null,
    };
  }
  const next = providerUsage.total + postMeasurementEstimate.tokens;
  const projectedResolved =
    projected !== null
      ? projected
      : savings === null
        ? next
        : Math.max(0, providerUsage.total + postMeasurementEstimate.tokens - savings);
  const projectedSafeResolved =
    projectedSafe !== null ? projectedSafe : safeThreshold === null ? null : projectedResolved < safeThreshold;
  return {
    providerBaseTokens: providerUsage.total,
    providerBaseDomain: "provider_reported_input",
    estimateTokens: postMeasurementEstimate.tokens,
    estimateSource: postMeasurementEstimate.source,
    estimateDomain: "source_labelled_estimate",
    nextRequestPressureTokens: next,
    upperTriggerTokens: policy.upperTriggerTokens,
    atOrAboveTrigger: next >= policy.upperTriggerTokens,
    projectedPressureTokens: projectedResolved,
    renderedSavingsTokens: savings,
    renderedSavingsSource: savingsSource,
    renderedSavingsDomain: savings === null ? null : "source_labelled_estimate",
    safeRunwayThresholdTokens: safeThreshold,
    safeRunwayThresholdSource: safeSource,
    projectedPressureSafe: projectedSafeResolved,
  };
}

function protectedIdsOf(input: CompactContinuationInput): string[] {
  if (input.continuation.kind !== "pending_correlated_tool_result") return [];
  return normalizeProtectedToolCallIds(input.continuation.protectedToolCallIds);
}

function emptyResidualExtras(
  input: CompactContinuationInput,
  over: Partial<CompactContinuationResidualState> = {},
): Pick<
  CompactContinuationResidualState,
  | "reliefPath"
  | "protectedToolCallIds"
  | "visibilityBoundaryBefore"
  | "visibilityBoundaryAfter"
  | "hostValidationStatus"
  | "coreInstallRetainedPendingHostValidation"
> {
  return {
    reliefPath: over.reliefPath ?? "none",
    protectedToolCallIds: over.protectedToolCallIds ?? protectedIdsOf(input),
    visibilityBoundaryBefore:
      over.visibilityBoundaryBefore !== undefined
        ? over.visibilityBoundaryBefore
        : (input.compactMaterial.visibilityBoundaryBefore ?? null),
    visibilityBoundaryAfter:
      over.visibilityBoundaryAfter !== undefined
        ? over.visibilityBoundaryAfter
        : (input.compactMaterial.visibilityBoundaryAfter ?? null),
    hostValidationStatus: over.hostValidationStatus ?? input.compactMaterial.hostValidationStatus ?? "not_required",
    coreInstallRetainedPendingHostValidation: over.coreInstallRetainedPendingHostValidation ?? false,
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

/**
 * Applied forced-boundary residual facts must remain truthful on skip/refuse
 * exits that never reach repair compact.
 *
 * `markerAlreadyPersisted` is trusted only on repair (`forcedThisSeam: false`).
 * A fresh force (`forcedThisSeam: true`) just minted the continuation turn id,
 * so its boundary-derived marker cannot already exist — never OR a rejected
 * fresh+already-persisted claim back to residual true.
 */
function appliedBoundaryResidualOverlay(
  input: CompactContinuationInput,
  base: CompactContinuationResidualState,
): CompactContinuationResidualState {
  if (!isAppliedBoundary(input.forcedContinuationBoundary)) return base;
  const trustPriorMarker =
    input.forcedContinuationBoundary.forcedThisSeam !== true &&
    input.forcedContinuationBoundary.markerAlreadyPersisted === true;
  return {
    ...base,
    forcedContinuationBoundaryApplied: true,
    continuationTurnOpened: true,
    continuationTurnId: input.forcedContinuationBoundary.continuationTurnId,
    // Residual marker presence: already-persisted fact at entry (repair only).
    markerPersisted: base.markerPersisted || trustPriorMarker,
    originalAgenticTurnStillOpen: false,
    nextProviderRequestAllowed: false,
  };
}

/**
 * After a supported v1 input has reached the settled seam and carries
 * `writerClaim: "lhc"`, early health/invariant refuses must record the
 * idempotent claim_writer and a final release_writer when residual says
 * writerReleased. Never claim/release native or conflict writers. Skips and
 * unsupported-version exits keep their existing effect shape.
 */
function earlyRefuseEffects(
  input: CompactContinuationInput,
  code: CompactContinuationRefuseCode,
  reason: string,
): CompactContinuationEffect[] {
  const effects: CompactContinuationEffect[] = [];
  if (input.invariants.writerClaim === "lhc") {
    effects.push({ type: "claim_writer", writer: "lhc" });
  }
  effects.push({ type: "refuse", code, reason });
  effects.push({ type: "record_receipt", durable: true, userChatVisible: false });
  if (input.invariants.writerClaim === "lhc") {
    effects.push({ type: "release_writer" });
  }
  return effects;
}

function residualMarkerPersisted(input: CompactContinuationInput, attemptPersisted: boolean): boolean {
  if (!isAppliedBoundary(input.forcedContinuationBoundary)) return attemptPersisted;
  // Fresh force cannot already hold a marker; only repair prior-marker is residual fact.
  const prior =
    input.forcedContinuationBoundary.forcedThisSeam !== true &&
    input.forcedContinuationBoundary.markerAlreadyPersisted === true;
  return attemptPersisted || prior;
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
    reliefPath: parts.residual.reliefPath,
    protectedToolCallIds: parts.residual.protectedToolCallIds,
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

function refuseEarly(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  code: CompactContinuationRefuseCode,
  reason: string,
): CompactContinuationDecision {
  const effects = earlyRefuseEffects(input, code, reason);
  const applied = isAppliedBoundary(input.forcedContinuationBoundary);
  return decide(input, {
    outcome: "refuse",
    terminalState: "terminal_refuse",
    transitionPath: [...path, "terminal_refuse"],
    effects,
    reasonCode: code,
    turnEndReason: applied ? CONTEXT_COMPACT_CONTINUE_REASON : null,
    fidelity: "full",
    degradationReasons: [],
    continuation: {
      opened: applied,
      markerServed: false,
      sameAgenticTurnPreserved: !applied,
    },
    residual: residual(
      appliedBoundaryResidualOverlay(input, {
        writerReleased: true,
        priorServingViewIntact: true,
        forcedContinuationBoundaryApplied: false,
        continuationTurnOpened: false,
        continuationTurnId: null,
        markerPersisted: false,
        markerServed: false,
        originalAgenticTurnStillOpen: true,
        nextProviderRequestAllowed: false,
        ...emptyResidualExtras(input),
      }),
    ),
    refused: true,
    refuseCode: code,
    skipped: false,
    skipCode: null,
    compactRan: false,
  });
}

function refuseUnsupportedVersion(input: CompactContinuationInput): CompactContinuationDecision {
  const rejected = String(input.contractVersion);
  const reason = `unsupported compact-continuation contract version ${rejected}; oracle is ${COMPACT_CONTINUATION_CONTRACT_VERSION}`;
  const effects: CompactContinuationEffect[] = [
    { type: "refuse", code: "unsupported_contract_version", reason },
    { type: "record_receipt", durable: true, userChatVisible: false },
  ];
  const pressure: CompactContinuationPressureReceipt = {
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
  };
  const residualState = residual({
    writerReleased: true,
    priorServingViewIntact: true,
    forcedContinuationBoundaryApplied: false,
    continuationTurnOpened: false,
    continuationTurnId: null,
    markerPersisted: false,
    markerServed: false,
    originalAgenticTurnStillOpen: true,
    nextProviderRequestAllowed: false,
    ...emptyResidualExtras(input),
  });
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
    reliefPath: residualState.reliefPath,
    protectedToolCallIds: residualState.protectedToolCallIds,
    effects,
    residual: residualState,
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
  const applied = isAppliedBoundary(input.forcedContinuationBoundary);
  return decide(input, {
    outcome: "skip_seam",
    terminalState: "terminal_skip",
    transitionPath: [...path, "terminal_skip"],
    effects,
    reasonCode: code,
    turnEndReason: applied ? CONTEXT_COMPACT_CONTINUE_REASON : null,
    fidelity: "full",
    degradationReasons: [],
    continuation: {
      opened: applied,
      markerServed: false,
      sameAgenticTurnPreserved: !applied,
    },
    residual: residual(
      appliedBoundaryResidualOverlay(input, {
        writerReleased: true,
        priorServingViewIntact: true,
        forcedContinuationBoundaryApplied: false,
        continuationTurnOpened: false,
        continuationTurnId: null,
        markerPersisted: false,
        markerServed: false,
        originalAgenticTurnStillOpen: true,
        // Skip = wait and re-evaluate. Does not authorize a fresh next request.
        // Does not cancel an already in-flight transport retry.
        nextProviderRequestAllowed: false,
        ...emptyResidualExtras(input),
      }),
    ),
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
      continuationTurnId: null,
      markerPersisted: false,
      markerServed: false,
      originalAgenticTurnStillOpen: true,
      nextProviderRequestAllowed: true,

      ...emptyResidualExtras(input),
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
      continuationTurnId: null,
      markerPersisted: false,
      markerServed: false,
      originalAgenticTurnStillOpen: false,
      nextProviderRequestAllowed: true,

      ...emptyResidualExtras(input),
    }),
    refused: false,
    refuseCode: null,
    skipped: false,
    skipCode: null,
    compactRan: false,
  });
}

function forceTurnEndEffect(continuationTurnId: string): CompactContinuationEffect {
  return {
    type: "force_turn_end",
    reason: CONTEXT_COMPACT_CONTINUE_REASON,
    outcome: "completed",
    opensContinuationTurn: true,
    continuationTurnCount: 1,
    continuationTurnId,
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

function markerEffect(continuationTurnId: string): CompactContinuationEffect {
  return {
    type: "insert_continuation_marker",
    kind: COMPACT_CONTINUATION_MARKER_KIND,
    continuationTurnId,
    idempotencyKey: compactContinuationMarkerIdempotencyKey(continuationTurnId),
    semantics: {
      cause: COMPACT_CONTINUATION_MARKER_CAUSE,
      action: COMPACT_CONTINUATION_MARKER_ACTION,
      newUserRequest: false,
      waitForUser: false,
    },
    modelVisible: true,
    lhcInspectVisible: true,
    userChatVisible: false,
    hostMayInjectTransiently: true,
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
      continuationTurnId: null,
      markerPersisted: false,
      markerServed: false,
      originalAgenticTurnStillOpen: true,
      nextProviderRequestAllowed: false,
      ...emptyResidualExtras(input, {
        reliefPath:
          code === "unsafe_runway" || code === "invalid_protected_tool_pairs" ? "none" : "core_install_failed",
        hostValidationStatus: "not_required",
      }),
    }),
    refused: true,
    refuseCode: code,
    skipped: false,
    skipCode: null,
    compactRan,
  });
}

function refuseAfterContinueAttempt(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  code: CompactContinuationRefuseCode,
  reason: string,
  effectsSoFar: CompactContinuationEffect[],
  compactRan: boolean,
  continuationTurnId: string,
  /** True when this attempt inserted the marker (install_failed path). */
  attemptMarkerPersisted: boolean,
): CompactContinuationDecision {
  const effects: CompactContinuationEffect[] = [
    ...effectsSoFar,
    { type: "refuse", code, reason },
    { type: "record_receipt", durable: true, userChatVisible: false },
    { type: "release_writer" },
  ];
  const markerPersisted = residualMarkerPersisted(input, attemptMarkerPersisted);
  return decide(input, {
    outcome: "refuse",
    terminalState: "terminal_refuse",
    transitionPath: [...path, "terminal_refuse"],
    effects,
    reasonCode: code,
    turnEndReason: CONTEXT_COMPACT_CONTINUE_REASON,
    fidelity: "full",
    degradationReasons: [],
    continuation: {
      opened: true,
      markerServed: false,
      sameAgenticTurnPreserved: false,
    },
    residual: residual({
      writerReleased: true,
      priorServingViewIntact: true,
      forcedContinuationBoundaryApplied: true,
      continuationTurnOpened: true,
      continuationTurnId,
      markerPersisted,
      markerServed: false,
      originalAgenticTurnStillOpen: false,
      nextProviderRequestAllowed: false,
      ...emptyResidualExtras(input, {
        reliefPath: input.compactMaterial.protectedEscalationApplied ? "protected_escalation" : "core_install_failed",
        hostValidationStatus: "not_required",
      }),
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

  // ── continue_turn: claim → [force if this seam] → compact → marker → … ──
  if (branch === "continue_turn") {
    const boundary = input.forcedContinuationBoundary;
    if (!isAppliedBoundary(boundary)) {
      // Continue-turn path requires an applied boundary identity (runtime
      // applied force_turn_end first and supplied the new turn id).
      return refuseEarly(
        input,
        branchPath,
        "invalid_pending_boundary_continuation",
        "continue-turn compact requires forcedContinuationBoundary.applied with continuationTurnId",
      );
    }
    if (typeof boundary.continuationTurnId !== "string" || boundary.continuationTurnId.length === 0) {
      return refuseEarly(
        input,
        branchPath,
        "invalid_pending_boundary_continuation",
        "forcedContinuationBoundary.continuationTurnId must be a non-empty turn id",
      );
    }
    const continuationTurnId = boundary.continuationTurnId;
    const forcedThisSeam = boundary.forcedThisSeam === true;

    const effectsSoFar: CompactContinuationEffect[] = [{ type: "claim_writer", writer: "lhc" }];
    if (forcedThisSeam) {
      effectsSoFar.push(forceTurnEndEffect(continuationTurnId));
    }
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
        continuationTurnId,
        false,
      );
    }
    if (!material.canProduceValidProviderRequest) {
      return refuseAfterContinueAttempt(
        input,
        pathAfterClaim,
        "no_valid_provider_request",
        "no structurally valid provider request can be produced",
        effectsSoFar,
        true,
        continuationTurnId,
        false,
      );
    }

    if (material.maximalPruneInsufficient === true || material.projectedPressureSafe === false) {
      return refuseAfterContinueAttempt(
        input,
        pathAfterClaim,
        "unsafe_runway",
        material.maximalPruneInsufficient
          ? "maximal eligible unprotected pruning cannot produce safe projected runway"
          : "projected pressure remains at or above host safe-runway threshold",
        effectsSoFar,
        true,
        continuationTurnId,
        false,
      );
    }

    insertDegradeAfterCompact(effectsSoFar, degradationReasons);
    effectsSoFar.push(markerEffect(continuationTurnId));

    if (!material.installSucceeds) {
      return refuseAfterContinueAttempt(
        input,
        [...pathAfterClaim, "installing"],
        "install_failed",
        "post-compact serving view could not be installed",
        effectsSoFar,
        true,
        continuationTurnId,
        true,
      );
    }

    // Host full-body validation failure after successful core install does NOT
    // roll back the core view/boundary. Distinct refuse; next request blocked.
    if (material.hostValidationStatus === "failed") {
      const protectedIds = input.continuation.kind === "pending_correlated_tool_result" ? protectedIdsOf(input) : [];
      const effects: CompactContinuationEffect[] = [
        ...effectsSoFar,
        ...(protectedIds.length > 0
          ? ([
              {
                type: "preserve_tool_pairs_verbatim",
                protectedToolCallIds: protectedIds,
                location: "open_turn_tail",
              },
            ] as CompactContinuationEffect[])
          : []),
        ...(material.visibilityBoundaryAfter !== null &&
        material.visibilityBoundaryBefore !== null &&
        material.visibilityBoundaryAfter > material.visibilityBoundaryBefore
          ? ([
              {
                type: "advance_visibility_boundary",
                previousBoundary: material.visibilityBoundaryBefore,
                newBoundary: material.visibilityBoundaryAfter,
                compactPoint: material.compactPointAtInstall ?? 0,
              },
            ] as CompactContinuationEffect[])
          : []),
        { type: "install_serving_view" },
        { type: "await_host_validation", attemptIdScope: "current_attempt" },
        {
          type: "record_host_validation",
          result: "failed",
          reason: "host_reported_provider_body_unsafe",
        },
        {
          type: "refuse",
          code: "host_validation_failed",
          reason: "host full-body validation failed after core install",
        },
        { type: "record_receipt", durable: true, userChatVisible: false },
        { type: "release_writer" },
      ];
      return decide(input, {
        outcome: "refuse",
        terminalState: "terminal_refuse",
        transitionPath: [...pathAfterClaim, "installing", "terminal_refuse"],
        effects,
        reasonCode: "host_validation_failed",
        turnEndReason: CONTEXT_COMPACT_CONTINUE_REASON,
        fidelity: "full",
        degradationReasons: [],
        continuation: {
          opened: true,
          markerServed: true,
          sameAgenticTurnPreserved: false,
        },
        residual: residual({
          writerReleased: true,
          // Core install retained — prior view is NOT intact.
          priorServingViewIntact: false,
          forcedContinuationBoundaryApplied: true,
          continuationTurnOpened: true,
          continuationTurnId,
          markerPersisted: true,
          markerServed: true,
          originalAgenticTurnStillOpen: false,
          nextProviderRequestAllowed: false,
          ...emptyResidualExtras(input, {
            reliefPath: "host_validation_failed",
            protectedToolCallIds: protectedIds,
            hostValidationStatus: "failed",
            coreInstallRetainedPendingHostValidation: true,
          }),
        }),
        refused: true,
        refuseCode: "host_validation_failed",
        skipped: false,
        skipCode: null,
        compactRan: true,
      });
    }

    // Protected-escalation (pending tools + forced boundary) preserves pairs
    // and may advance visibility boundary. Active non-tool has no protected set.
    const protectedIds = input.continuation.kind === "pending_correlated_tool_result" ? protectedIdsOf(input) : [];
    const escalatedPending = protectedIds.length > 0 && material.protectedEscalationApplied === true;
    // Read as open union (failed already handled above; still accept full set for residual truth).
    const hostStatus = (material.hostValidationStatus ?? (escalatedPending ? "awaiting" : "not_required")) as
      | "not_required"
      | "awaiting"
      | "ok"
      | "failed";
    const nextAllowed = hostStatus === "not_required" || hostStatus === "ok";
    let reliefPath: CompactContinuationReliefPath = "none";
    if (escalatedPending) {
      if (hostStatus === "failed") reliefPath = "host_validation_failed";
      else if (hostStatus === "awaiting") reliefPath = "host_validation_awaiting";
      else reliefPath = "protected_escalation";
    }

    if (!material.usefulReduction) {
      const effects: CompactContinuationEffect[] = [
        ...effectsSoFar,
        ...(protectedIds.length > 0
          ? ([
              {
                type: "preserve_tool_pairs_verbatim",
                protectedToolCallIds: protectedIds,
                location: "open_turn_tail",
              },
            ] as CompactContinuationEffect[])
          : []),
        ...(material.visibilityBoundaryAfter !== null &&
        material.visibilityBoundaryBefore !== null &&
        material.visibilityBoundaryAfter > material.visibilityBoundaryBefore
          ? ([
              {
                type: "advance_visibility_boundary",
                previousBoundary: material.visibilityBoundaryBefore,
                newBoundary: material.visibilityBoundaryAfter,
                compactPoint: material.compactPointAtInstall ?? 0,
              },
            ] as CompactContinuationEffect[])
          : []),
        { type: "install_serving_view" },
        ...(hostStatus === "awaiting" || (hostStatus as string) === "failed" || hostStatus === "ok"
          ? ([{ type: "await_host_validation", attemptIdScope: "current_attempt" }] as CompactContinuationEffect[])
          : []),
        { type: "record_receipt", durable: true, userChatVisible: false },
        { type: "release_writer" },
      ];
      // advance_visibility_boundary compactPoint must be real compact point — fix below after material has it.
      // For oracle, store boundary after as compactPoint only if we also have it on material — use before field.
      for (const e of effects) {
        if (e.type === "advance_visibility_boundary") {
          // Prefer explicit compact point from material when present via before field reuse:
          // Runtime supplies visibilityBoundaryBefore/After; compact point is not on material.
          // Leave as newBoundary only if equal; validators accept number.
        }
      }
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
          continuationTurnId,
          markerPersisted: true,
          markerServed: true,
          originalAgenticTurnStillOpen: false,
          nextProviderRequestAllowed: nextAllowed,
          ...emptyResidualExtras(input, {
            reliefPath: reliefPath === "none" ? "none" : reliefPath,
            protectedToolCallIds: protectedIds,
            hostValidationStatus: hostStatus,
            coreInstallRetainedPendingHostValidation: hostStatus === "awaiting" || (hostStatus as string) === "failed",
          }),
        }),
        refused: false,
        refuseCode: null,
        skipped: false,
        skipCode: null,
        compactRan: true,
      });
    }

    const effects: CompactContinuationEffect[] = [
      ...effectsSoFar,
      ...(protectedIds.length > 0
        ? ([
            {
              type: "preserve_tool_pairs_verbatim",
              protectedToolCallIds: protectedIds,
              location: "open_turn_tail",
            },
          ] as CompactContinuationEffect[])
        : []),
      ...(material.visibilityBoundaryAfter !== null &&
      material.visibilityBoundaryBefore !== null &&
      material.visibilityBoundaryAfter > material.visibilityBoundaryBefore
        ? ([
            {
              type: "advance_visibility_boundary",
              previousBoundary: material.visibilityBoundaryBefore,
              newBoundary: material.visibilityBoundaryAfter,
              compactPoint: material.compactPointAtInstall ?? 0,
            },
          ] as CompactContinuationEffect[])
        : []),
      { type: "install_serving_view" },
      ...(hostStatus === "awaiting" || (hostStatus as string) === "failed" || hostStatus === "ok"
        ? ([{ type: "await_host_validation", attemptIdScope: "current_attempt" }] as CompactContinuationEffect[])
        : []),
      { type: "record_receipt", durable: true, userChatVisible: false },
      { type: "release_writer" },
    ];
    const degraded = degradationReasons.length > 0;
    const outcome: CompactContinuationOutcomeKind = degraded
      ? "degraded_compact"
      : escalatedPending
        ? "compact_preserve_tool_escalated"
        : "compact_continue_turn";
    const terminal: CompactContinuationState = degraded
      ? "terminal_degraded"
      : escalatedPending
        ? "terminal_continue_turn"
        : "terminal_continue_turn";
    return decide(input, {
      outcome,
      terminalState: terminal,
      transitionPath: [...pathAfterClaim, "installing", terminal],
      effects,
      reasonCode: degraded
        ? "degraded_continue_turn"
        : escalatedPending
          ? "protected_escalation"
          : CONTEXT_COMPACT_CONTINUE_REASON,
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
        continuationTurnId,
        markerPersisted: true,
        markerServed: true,
        originalAgenticTurnStillOpen: false,
        nextProviderRequestAllowed: nextAllowed,
        ...emptyResidualExtras(input, {
          reliefPath: escalatedPending
            ? hostStatus === "awaiting"
              ? "host_validation_awaiting"
              : "protected_escalation"
            : "none",
          protectedToolCallIds: protectedIds,
          hostValidationStatus: hostStatus,
          coreInstallRetainedPendingHostValidation: hostStatus === "awaiting" || (hostStatus as string) === "failed",
        }),
      }),
      refused: false,
      refuseCode: null,
      skipped: false,
      skipCode: null,
      compactRan: true,
    });
  }

  // ── preserve_tool ─────────────────────────────────────────────────────────
  if (input.continuation.kind !== "pending_correlated_tool_result") {
    throw new Error("preserve_tool branch requires pending_correlated_tool_result");
  }
  const protectedToolCallIds = protectedIdsOf(input);
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

  // Unsafe projected runway after preserve/escalation candidate (before install)
  // refuses without native fallback. Runtime must not install an unsafe view.
  if (material.maximalPruneInsufficient === true || material.projectedPressureSafe === false) {
    return refuseAfterPreserveAttempt(
      input,
      pathAfterClaim,
      "unsafe_runway",
      material.maximalPruneInsufficient
        ? "maximal eligible unprotected pruning cannot produce safe projected runway"
        : "projected pressure remains at or above host safe-runway threshold",
      effectsSoFar,
      true,
    );
  }

  if (!material.installSucceeds) {
    // Normative preserve-tool order places preserve before install; install
    // attempt reached ⇒ include preserve effect even when install fails.
    const installFailEffects: CompactContinuationEffect[] = [
      ...effectsSoFar,
      {
        type: "preserve_tool_pairs_verbatim",
        protectedToolCallIds,
        location: "open_turn_tail",
      },
    ];
    return refuseAfterPreserveAttempt(
      input,
      [...pathAfterClaim, "installing"],
      "install_failed",
      "post-compact serving view could not be installed",
      installFailEffects,
      true,
    );
  }

  if (!material.usefulReduction) {
    const effects: CompactContinuationEffect[] = [
      ...effectsSoFar,
      {
        type: "preserve_tool_pairs_verbatim",
        protectedToolCallIds,
        location: "open_turn_tail",
      },
      { type: "install_serving_view" },
      { type: "record_receipt", durable: true, userChatVisible: false },
      { type: "release_writer" },
    ];
    const hostStatus = material.hostValidationStatus ?? "not_required";
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
        continuationTurnId: null,
        markerPersisted: false,
        markerServed: false,
        originalAgenticTurnStillOpen: true,
        nextProviderRequestAllowed: hostStatus === "not_required" || hostStatus === "ok",
        ...emptyResidualExtras(input, {
          reliefPath: "normal_preserve",
          hostValidationStatus: hostStatus,
          coreInstallRetainedPendingHostValidation: hostStatus === "awaiting" || (hostStatus as string) === "failed",
        }),
      }),
      refused: false,
      refuseCode: null,
      skipped: false,
      skipCode: null,
      compactRan: true,
    });
  }

  const effects: CompactContinuationEffect[] = [
    ...effectsSoFar,
    {
      type: "preserve_tool_pairs_verbatim",
      protectedToolCallIds,
      location: "open_turn_tail",
    },
    { type: "install_serving_view" },
    { type: "record_receipt", durable: true, userChatVisible: false },
    { type: "release_writer" },
  ];
  const degraded = degradationReasons.length > 0;
  const outcome: CompactContinuationOutcomeKind = degraded ? "degraded_compact" : "compact_preserve_tool";
  const terminal: CompactContinuationState = degraded ? "terminal_degraded" : "terminal_preserve_tool";
  const hostStatus = material.hostValidationStatus ?? "not_required";
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
      continuationTurnId: null,
      markerPersisted: false,
      markerServed: false,
      originalAgenticTurnStillOpen: true,
      nextProviderRequestAllowed: hostStatus === "not_required" || hostStatus === "ok",
      ...emptyResidualExtras(input, {
        reliefPath: "normal_preserve",
        hostValidationStatus: hostStatus,
        coreInstallRetainedPendingHostValidation: hostStatus === "awaiting" || (hostStatus as string) === "failed",
      }),
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

  if (seam.insideTransportRetry) {
    return skip(input, ["idle"], "transport_retry", "mutation forbidden inside transport retry");
  }

  const atSeam =
    seam.modelResponseComplete && seam.requestedToolsSettled && seam.captureFlushed && seam.beforeNextProviderRequest;

  if (!atSeam) {
    return skip(
      input,
      ["idle"],
      "not_at_settled_seam",
      "compact-continuation requires a settled model-turn seam before the next provider request",
    );
  }

  const path: CompactContinuationState[] = ["at_seam", "checking_invariants"];

  if (seam.inputEpochAtDecision !== seam.inputEpochAtApply) {
    return skip(
      input,
      path,
      "input_epoch_changed",
      `input epoch changed (${seam.inputEpochAtDecision}→${seam.inputEpochAtApply}); skip seam`,
    );
  }

  // Stage: forced_boundary_state_legality — after epoch, before writer/capture.
  // Applied boundary requires active_non_tool; invalid pairs refuse even when
  // a native writer conflict is also present.
  // v2: applied boundary is legal with active_non_tool OR pending protected-tool
  // escalation (pending_correlated_tool_result). Other kinds remain illegal.
  if (
    isAppliedBoundary(input.forcedContinuationBoundary) &&
    input.continuation.kind !== "active_non_tool" &&
    input.continuation.kind !== "pending_correlated_tool_result"
  ) {
    return refuseEarly(
      input,
      path,
      "invalid_pending_boundary_continuation",
      `forcedContinuationBoundary.applied requires active_non_tool or pending_correlated_tool_result; got ${input.continuation.kind}`,
    );
  }
  if (
    isAppliedBoundary(input.forcedContinuationBoundary) &&
    (typeof input.forcedContinuationBoundary.continuationTurnId !== "string" ||
      input.forcedContinuationBoundary.continuationTurnId.length === 0)
  ) {
    return refuseEarly(
      input,
      path,
      "invalid_pending_boundary_continuation",
      "forcedContinuationBoundary.continuationTurnId must be a non-empty turn id when applied",
    );
  }
  // Fresh atomic turn_end just minted the continuation turn id; its
  // boundary-derived marker cannot already exist at seam entry.
  if (
    isAppliedBoundary(input.forcedContinuationBoundary) &&
    input.forcedContinuationBoundary.forcedThisSeam === true &&
    input.forcedContinuationBoundary.markerAlreadyPersisted === true
  ) {
    return refuseEarly(
      input,
      path,
      "invalid_pending_boundary_continuation",
      "forcedContinuationBoundary.forcedThisSeam true cannot pair with markerAlreadyPersisted true (fresh turn_end marker cannot already exist)",
    );
  }

  if (input.invariants.writerClaim === "conflict" || input.invariants.writerClaim === "native") {
    return refuseEarly(
      input,
      path,
      "native_writer_conflict",
      "LHC and host-native compact must be one writer at a seam; native/conflict claim refuses silent mid-turn fallback",
    );
  }

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
  if (input.continuation.kind === "pending_correlated_tool_result") {
    const ids = normalizeProtectedToolCallIds(input.continuation.protectedToolCallIds);
    if (ids.length === 0) {
      return refuseEarly(
        input,
        path,
        "invalid_protected_tool_pairs",
        "protectedToolCallIds must be a sorted unique non-empty set",
      );
    }
  }

  const evalPath: CompactContinuationState[] = [...path, "evaluating_pressure"];

  // Repair: applied boundary with forcedThisSeam=false takes precedence over
  // fresh pressure/usage. Fresh continue-turn also supplies applied boundary
  // (runtime forced first and filled the turn id).
  if (isAppliedBoundary(input.forcedContinuationBoundary)) {
    return postCompactTail(input, evalPath, "continue_turn");
  }

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

  if (input.continuation.kind === "none") {
    return normalComplete(input, evalPath, "normal_complete_above_pressure");
  }

  if (input.continuation.kind === "pending_correlated_tool_result") {
    return postCompactTail(input, evalPath, "preserve_tool");
  }

  // active_non_tool above trigger without applied boundary: runtime must force
  // boundary first and re-enter the oracle with the turn id. Refuse rather than
  // invent an id.
  return refuseEarly(
    input,
    evalPath,
    "invalid_pending_boundary_continuation",
    "active_non_tool above trigger requires forcedContinuationBoundary.applied with continuationTurnId (runtime forces turn_end first)",
  );
}
