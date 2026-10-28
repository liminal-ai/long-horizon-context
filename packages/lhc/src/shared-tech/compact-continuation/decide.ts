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
  type CompactContinuationRetryReceipt,
  type CompactContinuationSkipCode,
  type CompactContinuationState,
  type CompactContinuationWarning,
  type CompactContinuationWarningCode,
  compactContinuationMarkerIdempotencyKey,
  DEFAULT_COMPACT_RETRY_BUDGET,
  type ForcedContinuationBoundary,
  normalizeProtectedToolCallIds,
} from "./contract.js";

function isAppliedBoundary(b: ForcedContinuationBoundary): b is Extract<ForcedContinuationBoundary, { applied: true }> {
  return b.applied === true;
}

type SeamPrelude = {
  effects: CompactContinuationEffect[];
  boundaryDiscarded: boolean;
};

function warn(code: CompactContinuationWarningCode, reason: string): CompactContinuationEffect {
  return { type: "warn", code, reason };
}

function warningsOf(effects: readonly CompactContinuationEffect[]): CompactContinuationWarning[] {
  const out: CompactContinuationWarning[] = [];
  for (const e of effects) {
    if (e.type === "warn") out.push({ code: e.code, reason: e.reason });
  }
  return out;
}

function retryBudgetOf(input: CompactContinuationInput): number {
  const raw = input.policy.compactRetryBudget;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_COMPACT_RETRY_BUDGET;
  return Math.max(1, Math.trunc(raw));
}

function attemptIndexOf(input: CompactContinuationInput): number {
  const raw = input.compactMaterial.compactAttemptIndex;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
  return Math.max(1, Math.trunc(raw));
}

function noRetry(input: CompactContinuationInput): CompactContinuationRetryReceipt {
  return { attemptIndex: attemptIndexOf(input), budget: retryBudgetOf(input), retryAuthorized: false };
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

type ResidualParts = Omit<CompactContinuationResidualState, "pendingBoundaryDiscarded"> & {
  pendingBoundaryDiscarded?: boolean;
};

function residual(parts: ResidualParts): CompactContinuationResidualState {
  return { ...parts, pendingBoundaryDiscarded: parts.pendingBoundaryDiscarded ?? false };
}

function appliedBoundaryResidualOverlay(input: CompactContinuationInput, base: ResidualParts): ResidualParts {
  if (!isAppliedBoundary(input.forcedContinuationBoundary)) return base;
  const trustPriorMarker =
    input.forcedContinuationBoundary.forcedThisSeam !== true &&
    input.forcedContinuationBoundary.markerAlreadyPersisted === true;
  return {
    ...base,
    forcedContinuationBoundaryApplied: true,
    continuationTurnOpened: true,
    continuationTurnId: input.forcedContinuationBoundary.continuationTurnId,
    markerPersisted: base.markerPersisted || trustPriorMarker,
    originalAgenticTurnStillOpen: false,
  };
}

function declineEffects(
  input: CompactContinuationInput,
  prelude: SeamPrelude,
  code: CompactContinuationWarningCode,
  reason: string,
): CompactContinuationEffect[] {
  const effects: CompactContinuationEffect[] = [...prelude.effects, warn(code, reason)];
  if (input.invariants.writerClaim === "lhc") {
    effects.push({ type: "claim_writer", writer: "lhc" });
  }
  effects.push({ type: "record_receipt", durable: true, userChatVisible: false });
  if (input.invariants.writerClaim === "lhc") {
    effects.push({ type: "release_writer" });
  }
  return effects;
}

function residualMarkerPersisted(input: CompactContinuationInput, attemptPersisted: boolean): boolean {
  if (!isAppliedBoundary(input.forcedContinuationBoundary)) return attemptPersisted;
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
    retry: CompactContinuationRetryReceipt;
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
    warnings: warningsOf(parts.effects),
    retry: parts.retry,
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
    retry?: CompactContinuationRetryReceipt;
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
    retry: parts.retry ?? noRetry(input),
    refused: false,
    refuseCode: null,
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

function declineToOrdinary(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  prelude: SeamPrelude,
  code: CompactContinuationWarningCode,
  reason: string,
): CompactContinuationDecision {
  const effects = declineEffects(input, prelude, code, reason);
  const applied = isAppliedBoundary(input.forcedContinuationBoundary);
  return decide(input, {
    outcome: "decline_to_ordinary_compact",
    terminalState: "terminal_decline_ordinary",
    transitionPath: [...path, "terminal_decline_ordinary"],
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
        pendingBoundaryDiscarded: prelude.boundaryDiscarded,
        nextProviderRequestAllowed: true,
        ...emptyResidualExtras(input),
      }),
    ),
    skipped: false,
    skipCode: null,
    compactRan: false,
  });
}

function declineUnsupportedVersion(input: CompactContinuationInput): CompactContinuationDecision {
  const rejected = String(input.contractVersion);
  const reason = `unsupported compact-continuation contract version ${rejected}; oracle is ${COMPACT_CONTINUATION_CONTRACT_VERSION} — continuation state omitted in its entirety, ordinary compact runs on canonical turns`;
  const effects: CompactContinuationEffect[] = [
    { type: "discard_pending_boundary", continuationTurnId: null, reason },
    warn("unsupported_contract_version_omitted", reason),
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
    pendingBoundaryDiscarded: true,
    nextProviderRequestAllowed: true,
    reliefPath: "none",
    protectedToolCallIds: [],
    visibilityBoundaryBefore: null,
    visibilityBoundaryAfter: null,
    hostValidationStatus: "not_required",
    coreInstallRetainedPendingHostValidation: false,
  });
  const receipt: CompactContinuationReceipt = {
    contractVersion: COMPACT_CONTINUATION_CONTRACT_VERSION,
    outcome: "decline_to_ordinary_compact",
    reasonCode: `unsupported_contract_version_omitted:${rejected}`,
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
    warnings: warningsOf(effects),
    retry: { attemptIndex: 1, budget: DEFAULT_COMPACT_RETRY_BUDGET, retryAuthorized: false },
    continuation: {
      opened: false,
      markerServed: false,
      sameAgenticTurnPreserved: true,
    },
    reliefPath: residualState.reliefPath,
    protectedToolCallIds: residualState.protectedToolCallIds,
    effects,
    residual: residualState,
    refused: false,
    refuseCode: null,
    skipped: false,
    skipCode: null,
    transitionPath: ["idle", "terminal_decline_ordinary"],
  };
  return {
    outcome: "decline_to_ordinary_compact",
    terminalState: "terminal_decline_ordinary",
    transitionPath: ["idle", "terminal_decline_ordinary"],
    effects,
    receipt,
  };
}

function writerOwnedElsewhere(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  prelude: SeamPrelude,
  reason: string,
): CompactContinuationDecision {
  const effects: CompactContinuationEffect[] = [
    ...prelude.effects,
    warn("writer_owned_elsewhere", reason),
    { type: "record_receipt", durable: true, userChatVisible: false },
  ];
  const applied = isAppliedBoundary(input.forcedContinuationBoundary);
  return decide(input, {
    outcome: "continue_current_body",
    terminalState: "terminal_continue_current_body",
    transitionPath: [...path, "terminal_continue_current_body"],
    effects,
    reasonCode: "writer_owned_elsewhere",
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
        pendingBoundaryDiscarded: prelude.boundaryDiscarded,
        nextProviderRequestAllowed: true,
        ...emptyResidualExtras(input),
      }),
    ),
    skipped: false,
    skipCode: null,
    compactRan: false,
  });
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
        nextProviderRequestAllowed: false,
        ...emptyResidualExtras(input),
      }),
    ),
    skipped: true,
    skipCode: code,
    compactRan: false,
  });
}

function continueNormal(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  prelude: SeamPrelude,
  reasonCode: string,
  viaBelowTrigger: boolean,
): CompactContinuationDecision {
  const effects: CompactContinuationEffect[] = [
    ...prelude.effects,
    { type: "record_receipt", durable: true, userChatVisible: false },
  ];
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
      pendingBoundaryDiscarded: prelude.boundaryDiscarded,
      nextProviderRequestAllowed: true,

      ...emptyResidualExtras(input),
    }),
    skipped: false,
    skipCode: null,
    compactRan: false,
  });
}

function normalComplete(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  prelude: SeamPrelude,
  reasonCode: string,
): CompactContinuationDecision {
  const effects: CompactContinuationEffect[] = [
    ...prelude.effects,
    { type: "record_receipt", durable: true, userChatVisible: false },
  ];
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
      pendingBoundaryDiscarded: prelude.boundaryDiscarded,
      nextProviderRequestAllowed: true,

      ...emptyResidualExtras(input),
    }),
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

function retryClassification(input: CompactContinuationInput): {
  retry: CompactContinuationRetryReceipt;
  outcome: CompactContinuationOutcomeKind;
  terminalState: CompactContinuationState;
  reasonCode: string;
} {
  const attemptIndex = attemptIndexOf(input);
  const budget = retryBudgetOf(input);
  const retryAuthorized = attemptIndex < budget;
  return {
    retry: { attemptIndex, budget, retryAuthorized },
    outcome: retryAuthorized ? "retry_compact" : "continue_current_body",
    terminalState: retryAuthorized ? "terminal_retry" : "terminal_continue_current_body",
    reasonCode: retryAuthorized ? "compact_retry_authorized" : "compact_retry_budget_exhausted",
  };
}

function attemptFailureWarnings(
  code: "compact_attempt_failed" | "install_attempt_failed",
  reason: string,
  retry: CompactContinuationRetryReceipt,
): CompactContinuationEffect[] {
  const effects: CompactContinuationEffect[] = [warn(code, reason)];
  if (!retry.retryAuthorized) {
    effects.push(
      warn(
        "compact_retry_budget_exhausted",
        `bounded compact retry budget spent (attempt ${retry.attemptIndex} of ${retry.budget}); continuing on the current body`,
      ),
    );
  }
  return effects;
}

function attemptFailedAfterPreserve(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  code: "compact_attempt_failed" | "install_attempt_failed",
  reason: string,
  effectsSoFar: CompactContinuationEffect[],
  compactRan: boolean,
): CompactContinuationDecision {
  const cls = retryClassification(input);
  const effects: CompactContinuationEffect[] = [
    ...effectsSoFar,
    ...attemptFailureWarnings(code, reason, cls.retry),
    { type: "record_receipt", durable: true, userChatVisible: false },
    { type: "release_writer" },
  ];
  return decide(input, {
    outcome: cls.outcome,
    terminalState: cls.terminalState,
    transitionPath: [...path, cls.terminalState],
    effects,
    reasonCode: cls.reasonCode,
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
      ...emptyResidualExtras(input, {
        reliefPath: "core_install_failed",
        hostValidationStatus: "not_required",
      }),
    }),
    retry: cls.retry,
    skipped: false,
    skipCode: null,
    compactRan,
  });
}

function attemptFailedAfterContinue(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  code: "compact_attempt_failed" | "install_attempt_failed",
  reason: string,
  effectsSoFar: CompactContinuationEffect[],
  compactRan: boolean,
  continuationTurnId: string,
  attemptMarkerPersisted: boolean,
): CompactContinuationDecision {
  const cls = retryClassification(input);
  const effects: CompactContinuationEffect[] = [
    ...effectsSoFar,
    ...attemptFailureWarnings(code, reason, cls.retry),
    { type: "record_receipt", durable: true, userChatVisible: false },
    { type: "release_writer" },
  ];
  const markerPersisted = residualMarkerPersisted(input, attemptMarkerPersisted);
  return decide(input, {
    outcome: cls.outcome,
    terminalState: cls.terminalState,
    transitionPath: [...path, cls.terminalState],
    effects,
    reasonCode: cls.reasonCode,
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
      nextProviderRequestAllowed: true,
      ...emptyResidualExtras(input, {
        reliefPath: input.compactMaterial.protectedEscalationApplied ? "protected_escalation" : "core_install_failed",
        hostValidationStatus: "not_required",
      }),
    }),
    retry: cls.retry,
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

function bodyQualityWarnings(input: CompactContinuationInput): CompactContinuationEffect[] {
  const material = input.compactMaterial;
  const effects: CompactContinuationEffect[] = [];
  if (!material.canProduceValidProviderRequest) {
    effects.push(
      warn(
        "provider_request_unvalidated",
        "no structurally valid provider request could be proven after the full reduction ladder; sending the best available body",
      ),
    );
  }
  if (material.maximalPruneInsufficient === true || material.projectedPressureSafe === false) {
    effects.push(
      warn(
        "unsafe_runway_projection",
        material.maximalPruneInsufficient
          ? "maximal eligible unprotected pruning cannot produce safe projected runway; installing best available relief"
          : "projected pressure remains at or above host safe-runway threshold; installing best available relief",
      ),
    );
  }
  return effects;
}

function boundaryAdvanceEffects(input: CompactContinuationInput): CompactContinuationEffect[] {
  const material = input.compactMaterial;
  if (
    material.visibilityBoundaryAfter === null ||
    material.visibilityBoundaryBefore === null ||
    material.visibilityBoundaryAfter <= material.visibilityBoundaryBefore
  ) {
    return [];
  }
  return [
    {
      type: "advance_visibility_boundary",
      previousBoundary: material.visibilityBoundaryBefore,
      newBoundary: material.visibilityBoundaryAfter,
      compactPoint: material.compactPointAtInstall ?? 0,
    },
  ];
}

function hostValidationEffects(hostStatus: "not_required" | "awaiting" | "ok" | "failed"): CompactContinuationEffect[] {
  if (hostStatus === "not_required") return [];
  const effects: CompactContinuationEffect[] = [{ type: "await_host_validation", attemptIdScope: "current_attempt" }];
  if (hostStatus === "failed") {
    effects.push(
      {
        type: "record_host_validation",
        result: "failed",
        reason: "host_reported_provider_body_unsafe",
      },
      warn(
        "host_validation_failed",
        "host full-body validation failed after core install; degraded body stands and the next provider request proceeds",
      ),
    );
  }
  return effects;
}

function postCompactTail(
  input: CompactContinuationInput,
  path: CompactContinuationState[],
  prelude: SeamPrelude,
  branch: "preserve_tool" | "continue_turn",
): CompactContinuationDecision {
  const material = input.compactMaterial;
  const degradationReasons = degradationReasonsOf(input);
  const branchState: CompactContinuationState =
    branch === "preserve_tool" ? "path_preserve_tool" : "path_continue_turn";
  const branchPath: CompactContinuationState[] = [...path, branchState];

  if (branch === "continue_turn") {
    const boundary = input.forcedContinuationBoundary;
    if (!isAppliedBoundary(boundary) || boundary.continuationTurnId.length === 0) {
      return declineToOrdinary(
        input,
        branchPath,
        prelude,
        "continuation_boundary_unavailable",
        "continue-turn compact requires an applied forcedContinuationBoundary with a continuationTurnId; declining into ordinary settled-seam compact",
      );
    }
    const continuationTurnId = boundary.continuationTurnId;
    const forcedThisSeam = boundary.forcedThisSeam === true;

    const effectsSoFar: CompactContinuationEffect[] = [...prelude.effects, { type: "claim_writer", writer: "lhc" }];
    if (forcedThisSeam) {
      effectsSoFar.push(forceTurnEndEffect(continuationTurnId));
    }
    effectsSoFar.push(compactEffect(input));

    const pathAfterClaim: CompactContinuationState[] = [...branchPath, "compacting"];

    if (!material.compactStructurallyValid) {
      return attemptFailedAfterContinue(
        input,
        pathAfterClaim,
        "compact_attempt_failed",
        "compact assembly could not produce a structurally valid view",
        effectsSoFar,
        true,
        continuationTurnId,
        false,
      );
    }

    effectsSoFar.push(...bodyQualityWarnings(input));

    insertDegradeAfterCompact(effectsSoFar, degradationReasons);
    effectsSoFar.push(markerEffect(continuationTurnId));

    if (!material.installSucceeds) {
      return attemptFailedAfterContinue(
        input,
        [...pathAfterClaim, "installing"],
        "install_attempt_failed",
        "post-compact serving view could not be installed",
        effectsSoFar,
        true,
        continuationTurnId,
        true,
      );
    }

    const protectedIds = input.continuation.kind === "pending_correlated_tool_result" ? protectedIdsOf(input) : [];
    const escalatedPending = protectedIds.length > 0 && material.protectedEscalationApplied === true;
    const hostStatus = material.hostValidationStatus ?? (escalatedPending ? "awaiting" : "not_required");
    const nextAllowed = hostStatus !== "awaiting";
    let reliefPath: CompactContinuationReliefPath = "none";
    if (escalatedPending) {
      if (hostStatus === "failed") reliefPath = "host_validation_failed";
      else if (hostStatus === "awaiting") reliefPath = "host_validation_awaiting";
      else reliefPath = "protected_escalation";
    }

    const installTail: CompactContinuationEffect[] = [
      ...(protectedIds.length > 0
        ? ([
            {
              type: "preserve_tool_pairs_verbatim",
              protectedToolCallIds: protectedIds,
              location: "open_turn_tail",
            },
          ] as CompactContinuationEffect[])
        : []),
      ...boundaryAdvanceEffects(input),
      { type: "install_serving_view" },
      ...hostValidationEffects(hostStatus),
    ];

    if (!material.usefulReduction) {
      const effects: CompactContinuationEffect[] = [
        ...effectsSoFar,
        ...installTail,
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
          continuationTurnId,
          markerPersisted: true,
          markerServed: true,
          originalAgenticTurnStillOpen: false,
          pendingBoundaryDiscarded: prelude.boundaryDiscarded,
          nextProviderRequestAllowed: nextAllowed,
          ...emptyResidualExtras(input, {
            reliefPath,
            protectedToolCallIds: protectedIds,
            hostValidationStatus: hostStatus,
            coreInstallRetainedPendingHostValidation: hostStatus === "awaiting",
          }),
        }),
        skipped: false,
        skipCode: null,
        compactRan: true,
      });
    }

    const effects: CompactContinuationEffect[] = [
      ...effectsSoFar,
      ...installTail,
      { type: "record_receipt", durable: true, userChatVisible: false },
      { type: "release_writer" },
    ];
    const degraded = degradationReasons.length > 0;
    const outcome: CompactContinuationOutcomeKind = degraded
      ? "degraded_compact"
      : escalatedPending
        ? "compact_preserve_tool_escalated"
        : "compact_continue_turn";
    const terminal: CompactContinuationState = degraded ? "terminal_degraded" : "terminal_continue_turn";
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
        pendingBoundaryDiscarded: prelude.boundaryDiscarded,
        nextProviderRequestAllowed: nextAllowed,
        ...emptyResidualExtras(input, {
          reliefPath: escalatedPending
            ? hostStatus === "awaiting"
              ? "host_validation_awaiting"
              : hostStatus === "failed"
                ? "host_validation_failed"
                : "protected_escalation"
            : "none",
          protectedToolCallIds: protectedIds,
          hostValidationStatus: hostStatus,
          coreInstallRetainedPendingHostValidation: hostStatus === "awaiting",
        }),
      }),
      skipped: false,
      skipCode: null,
      compactRan: true,
    });
  }

  if (input.continuation.kind !== "pending_correlated_tool_result") {
    throw new Error("preserve_tool branch requires pending_correlated_tool_result");
  }
  const protectedToolCallIds = protectedIdsOf(input);
  const effectsSoFar: CompactContinuationEffect[] = [
    ...prelude.effects,
    { type: "claim_writer", writer: "lhc" },
    compactEffect(input),
  ];
  const pathAfterClaim: CompactContinuationState[] = [...branchPath, "compacting"];

  if (!material.compactStructurallyValid) {
    return attemptFailedAfterPreserve(
      input,
      pathAfterClaim,
      "compact_attempt_failed",
      "compact assembly could not produce a structurally valid view",
      effectsSoFar,
      true,
    );
  }

  effectsSoFar.push(...bodyQualityWarnings(input));

  insertDegradeAfterCompact(effectsSoFar, degradationReasons);

  const preserveEffect: CompactContinuationEffect = {
    type: "preserve_tool_pairs_verbatim",
    protectedToolCallIds,
    location: "open_turn_tail",
  };

  if (!material.installSucceeds) {
    return attemptFailedAfterPreserve(
      input,
      [...pathAfterClaim, "installing"],
      "install_attempt_failed",
      "post-compact serving view could not be installed",
      [...effectsSoFar, preserveEffect],
      true,
    );
  }

  const hostStatus = material.hostValidationStatus ?? "not_required";
  const installTail: CompactContinuationEffect[] = [
    preserveEffect,
    { type: "install_serving_view" },
    ...hostValidationEffects(hostStatus),
  ];

  if (!material.usefulReduction) {
    const effects: CompactContinuationEffect[] = [
      ...effectsSoFar,
      ...installTail,
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
        continuationTurnId: null,
        markerPersisted: false,
        markerServed: false,
        originalAgenticTurnStillOpen: true,
        pendingBoundaryDiscarded: prelude.boundaryDiscarded,
        nextProviderRequestAllowed: hostStatus !== "awaiting",
        ...emptyResidualExtras(input, {
          reliefPath: "normal_preserve",
          hostValidationStatus: hostStatus,
          coreInstallRetainedPendingHostValidation: hostStatus === "awaiting",
        }),
      }),
      skipped: false,
      skipCode: null,
      compactRan: true,
    });
  }

  const effects: CompactContinuationEffect[] = [
    ...effectsSoFar,
    ...installTail,
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
      continuationTurnId: null,
      markerPersisted: false,
      markerServed: false,
      originalAgenticTurnStillOpen: true,
      pendingBoundaryDiscarded: prelude.boundaryDiscarded,
      nextProviderRequestAllowed: hostStatus !== "awaiting",
      ...emptyResidualExtras(input, {
        reliefPath: "normal_preserve",
        hostValidationStatus: hostStatus,
        coreInstallRetainedPendingHostValidation: hostStatus === "awaiting",
      }),
    }),
    skipped: false,
    skipCode: null,
    compactRan: true,
  });
}

export function decideCompactContinuation(input: CompactContinuationInput): CompactContinuationDecision {
  if (input.contractVersion !== COMPACT_CONTINUATION_CONTRACT_VERSION) {
    return declineUnsupportedVersion(input);
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

  const preludeEffects: CompactContinuationEffect[] = [];
  let boundaryDiscarded = false;
  let effective = input;

  const entryBoundary = input.forcedContinuationBoundary;
  if (isAppliedBoundary(entryBoundary)) {
    const wrongKind =
      input.continuation.kind !== "active_non_tool" && input.continuation.kind !== "pending_correlated_tool_result";
    const missingTurnId =
      typeof entryBoundary.continuationTurnId !== "string" || entryBoundary.continuationTurnId.length === 0;
    if (wrongKind || missingTurnId) {
      const reason = wrongKind
        ? `forcedContinuationBoundary.applied requires active_non_tool or pending_correlated_tool_result; got ${input.continuation.kind} — boundary discarded, seam starts fresh`
        : "forcedContinuationBoundary.continuationTurnId must be a non-empty turn id when applied — boundary discarded, seam starts fresh";
      preludeEffects.push({
        type: "discard_pending_boundary",
        continuationTurnId: missingTurnId ? null : entryBoundary.continuationTurnId,
        reason,
      });
      preludeEffects.push(warn("pending_boundary_discarded", reason));
      boundaryDiscarded = true;
      effective = { ...input, forcedContinuationBoundary: { applied: false } };
    } else if (entryBoundary.forcedThisSeam === true && entryBoundary.markerAlreadyPersisted === true) {
      preludeEffects.push(
        warn(
          "boundary_marker_claim_untrusted",
          "forcedThisSeam true cannot pair with markerAlreadyPersisted true (a fresh turn_end marker cannot already exist); marker claim not trusted",
        ),
      );
    }
  }

  const writerClaim = effective.invariants.writerClaim;
  if (writerClaim === "native" || writerClaim === "conflict") {
    const authority = effective.invariants.writerOwnershipAuthority ?? null;
    if (authority === "no_live_owner") {
      preludeEffects.push({ type: "reclaim_writer", priorClaim: writerClaim, hostAuthority: "no_live_owner" });
      preludeEffects.push(
        warn(
          "stale_writer_row_reclaimed",
          `stale ${writerClaim} writer row reclaimed after host ownership authority confirmed no live owner holds this LHC thread`,
        ),
      );
      effective = { ...effective, invariants: { ...effective.invariants, writerClaim: "none" } };
    } else {
      return writerOwnedElsewhere(
        effective,
        path,
        { effects: preludeEffects, boundaryDiscarded },
        authority === "live_owner"
          ? `a live owner holds this LHC thread (${writerClaim} writer row); continuing this attempt's current request and re-competing at the next seam`
          : `no host ownership authority was supplied for a ${writerClaim} writer row; treating it as a live owner and continuing this attempt's current request`,
      );
    }
  }

  if (!effective.invariants.captureComplete) {
    preludeEffects.push(
      warn(
        "capture_incomplete",
        "capture of the settled model turn is incomplete; compacting on available thread data (capture feeds derivation quality, not compact capability)",
      ),
    );
  }

  if (!effective.invariants.providerIdentityValid) {
    const reason =
      "required provider/model identity cannot be proven; omitting signed reasoning and proceeding with the compact";
    preludeEffects.push(warn("provider_identity_unproven", reason));
    preludeEffects.push({ type: "omit_signed_reasoning", reason });
  }

  if (!effective.invariants.singleOpenTurn) {
    preludeEffects.push(
      warn(
        "open_turn_invariant_unverified",
        "exactly-one-open-turn invariant does not hold; turn-record health is core LHC's own job, not a compact precondition",
      ),
    );
  }

  let protectedPathUnavailable: { code: CompactContinuationWarningCode; reason: string } | null = null;
  if (effective.continuation.kind === "pending_correlated_tool_result") {
    if (!effective.continuation.correlationValid) {
      protectedPathUnavailable = {
        code: "tool_correlation_unproven",
        reason:
          "pending tool-result continuation cannot prove call/result correlation; declining into ordinary settled-seam compact on canonical state",
      };
    } else if (normalizeProtectedToolCallIds(effective.continuation.protectedToolCallIds).length === 0) {
      protectedPathUnavailable = {
        code: "protected_tool_pairs_invalid",
        reason:
          "protectedToolCallIds must be a sorted unique non-empty set; declining into ordinary settled-seam compact on canonical state",
      };
    }
  }

  const prelude: SeamPrelude = { effects: preludeEffects, boundaryDiscarded };
  const evalPath: CompactContinuationState[] = [...path, "evaluating_pressure"];

  if (isAppliedBoundary(effective.forcedContinuationBoundary)) {
    if (protectedPathUnavailable !== null) {
      return declineToOrdinary(
        effective,
        evalPath,
        prelude,
        protectedPathUnavailable.code,
        protectedPathUnavailable.reason,
      );
    }
    return postCompactTail(effective, evalPath, prelude, "continue_turn");
  }

  if (!effective.providerUsage.available) {
    if (effective.continuation.kind === "none") {
      return normalComplete(effective, evalPath, prelude, "no_provider_usage_work_complete");
    }
    return continueNormal(effective, evalPath, prelude, "no_provider_usage", false);
  }

  const pressure = pressureReceipt(effective);
  if (pressure.atOrAboveTrigger !== true) {
    if (effective.continuation.kind === "none") {
      return normalComplete(effective, evalPath, prelude, "below_trigger_work_complete");
    }
    return continueNormal(effective, evalPath, prelude, "below_trigger", true);
  }

  if (effective.continuation.kind === "none") {
    return normalComplete(effective, evalPath, prelude, "normal_complete_above_pressure");
  }

  if (effective.continuation.kind === "pending_correlated_tool_result") {
    if (protectedPathUnavailable !== null) {
      return declineToOrdinary(
        effective,
        evalPath,
        prelude,
        protectedPathUnavailable.code,
        protectedPathUnavailable.reason,
      );
    }
    return postCompactTail(effective, evalPath, prelude, "preserve_tool");
  }

  return declineToOrdinary(
    effective,
    evalPath,
    prelude,
    "continuation_boundary_unavailable",
    "active_non_tool above trigger requires forcedContinuationBoundary.applied with continuationTurnId (runtime forces turn_end first); declining into ordinary settled-seam compact",
  );
}
