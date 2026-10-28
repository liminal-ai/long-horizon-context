import { mergeEstimateSource } from "../observation/estimate.js";
import { defaultSessionTokenFamily, type ResolvedTokenFamily } from "../observation/token-family.js";
import type { LifecycleSignal } from "../observation/types.js";
import { policySourcesSummary } from "./config.js";
import { decideGovernor } from "./decide.js";
import {
  buildPressureReceipt,
  normalizePostMeasurementEstimate,
  providerContextFromUsage,
} from "./provider-context.js";
import type {
  GovernorObserveRecord,
  PolicyFieldSources,
  PostMeasurementEstimate,
  ProviderBaseFreshness,
  ProviderContextTokens,
  ResolvedContextPolicy,
  TokenFamilySource,
} from "./types.js";
import { CC_LHC_HOST_CAPABILITY, EMPTY_POST_MEASUREMENT_ESTIMATE } from "./types.js";

export interface GovernorRuntimeState {
  turnOpen: boolean;
  inputEpochAtTurnOpen: number;
  currentInputEpoch: number;
  latestProviderContext: ProviderContextTokens | null;
  providerContextFreshness: ProviderBaseFreshness;
  latestSamplingId: string | null;
  postMeasurementEstimate: PostMeasurementEstimate;
  captureGeneration: number;
  operationInFlight: boolean;
  settleSequence: number;
  observeSequence: number;
  lastOpenTurnObserveFingerprint: string | null;
  sawSamplingThisTurn: boolean;
  contextLimitRejected: boolean;
  tokenFamily: string;
  tokenFamilySource: TokenFamilySource;
}

export function createGovernorRuntimeState(seed: Partial<GovernorRuntimeState> = {}): GovernorRuntimeState {
  const fallback = defaultSessionTokenFamily();
  return {
    turnOpen: false,
    inputEpochAtTurnOpen: 0,
    currentInputEpoch: 0,
    latestProviderContext: null,
    providerContextFreshness: "none",
    latestSamplingId: null,
    postMeasurementEstimate: { ...EMPTY_POST_MEASUREMENT_ESTIMATE },
    captureGeneration: 0,
    operationInFlight: false,
    settleSequence: 0,
    observeSequence: 0,
    lastOpenTurnObserveFingerprint: null,
    sawSamplingThisTurn: false,
    contextLimitRejected: false,
    tokenFamily: fallback.family,
    tokenFamilySource: fallback.source,
    ...seed,
  };
}

export function noteGovernorInput(state: GovernorRuntimeState): GovernorRuntimeState {
  return { ...state, currentInputEpoch: state.currentInputEpoch + 1 };
}

export function setGovernorCaptureGeneration(state: GovernorRuntimeState, generation: number): GovernorRuntimeState {
  return { ...state, captureGeneration: generation };
}

export function setGovernorOperationInFlight(state: GovernorRuntimeState, inFlight: boolean): GovernorRuntimeState {
  return { ...state, operationInFlight: inFlight };
}

export function setGovernorPostMeasurementEstimate(
  state: GovernorRuntimeState,
  estimate: PostMeasurementEstimate,
): GovernorRuntimeState {
  return {
    ...state,
    postMeasurementEstimate: normalizePostMeasurementEstimate(estimate),
  };
}

export function setGovernorTokenFamily(
  state: GovernorRuntimeState,
  resolved: ResolvedTokenFamily,
): GovernorRuntimeState {
  if (state.tokenFamily === resolved.family && state.tokenFamilySource === resolved.source) return state;
  return { ...state, tokenFamily: resolved.family, tokenFamilySource: resolved.source };
}

export interface GovernorLifecycleResult {
  state: GovernorRuntimeState;
  observe: GovernorObserveRecord | null;
}

export function applyGovernorLifecycleSignal(
  state: GovernorRuntimeState,
  signal: LifecycleSignal,
  resolved: ResolvedContextPolicy,
): GovernorLifecycleResult {
  switch (signal.kind) {
    case "turn_opened": {
      return {
        state: {
          ...state,
          turnOpen: true,
          inputEpochAtTurnOpen: state.currentInputEpoch,
          providerContextFreshness: state.latestProviderContext === null ? "none" : "last_known",
          latestSamplingId: null,
          sawSamplingThisTurn: false,
          lastOpenTurnObserveFingerprint: null,
          contextLimitRejected: false,
        },
        observe: null,
      };
    }
    case "sampling_observed": {
      const usage =
        signal.providerUsage !== undefined
          ? providerContextFromUsage(signal.providerUsage as Record<string, unknown>)
          : null;
      const rejected = signal.contextLimitRejected === true;
      const next: GovernorRuntimeState =
        usage === null
          ? {
              ...state,
              providerContextFreshness: state.latestProviderContext === null ? "none" : "last_known",
              latestSamplingId: signal.samplingId,
              sawSamplingThisTurn: true,
              contextLimitRejected: rejected || state.contextLimitRejected,
            }
          : {
              ...state,
              latestProviderContext: usage,
              providerContextFreshness: "current_sampling",
              latestSamplingId: signal.samplingId,
              sawSamplingThisTurn: true,
              postMeasurementEstimate: { ...EMPTY_POST_MEASUREMENT_ESTIMATE },
              contextLimitRejected: false,
            };
      if (next.turnOpen) {
        return observeOpenTurn(next, resolved);
      }
      return { state: next, observe: null };
    }
    case "post_measurement_estimate": {
      const mode = signal.mode ?? "set";
      const delta = normalizePostMeasurementEstimate({
        tokens: signal.tokens,
        source: signal.source,
        domain: "source_labelled_estimate",
      });
      let estimate: PostMeasurementEstimate;
      if (mode === "add") {
        const prev = normalizePostMeasurementEstimate(state.postMeasurementEstimate);
        const tokens = prev.tokens + delta.tokens;
        const safeTokens = Number.isSafeInteger(tokens) ? tokens : prev.tokens;
        estimate = {
          tokens: safeTokens,
          source: mergeEstimateSource(prev.source, delta.source, prev.tokens),
          domain: "source_labelled_estimate",
        };
      } else if (
        delta.tokens === 0 &&
        state.providerContextFreshness !== "current_sampling" &&
        normalizePostMeasurementEstimate(state.postMeasurementEstimate).tokens > 0
      ) {
        estimate = normalizePostMeasurementEstimate(state.postMeasurementEstimate);
      } else {
        estimate = delta;
      }
      const next: GovernorRuntimeState = {
        ...state,
        postMeasurementEstimate: estimate,
      };
      if (next.turnOpen) {
        return observeOpenTurn(next, resolved);
      }
      return { state: next, observe: null };
    }
    case "turn_settled": {
      return observeOnSettle(state, resolved);
    }
    case "capture_degraded": {
      return { state: { ...state, captureGeneration: signal.generation }, observe: null };
    }
    case "native_compact_observed": {
      return { state, observe: null };
    }
    case "session_bound":
    case "session_mismatch_observed": {
      return { state, observe: null };
    }
    default: {
      return { state, observe: null };
    }
  }
}

export function reobserveSettled(
  state: GovernorRuntimeState,
  resolved: ResolvedContextPolicy,
): GovernorLifecycleResult {
  if (state.turnOpen) return { state, observe: null };
  return observeOnSettle(state, resolved);
}

function openTurnFingerprint(
  decision: string,
  pressureTokens: number | null,
  samplingId: string | null,
  estimateTokens: number,
): string {
  return `${decision}|${pressureTokens ?? "null"}|${samplingId ?? ""}|${estimateTokens}`;
}

function decisionInputFrom(state: GovernorRuntimeState, resolved: ResolvedContextPolicy, turnOpen: boolean) {
  return {
    policy: resolved.policy,
    turnOpen,
    providerContext: state.latestProviderContext,
    providerContextFreshness: state.providerContextFreshness,
    postMeasurementEstimate: state.postMeasurementEstimate,
    operationInFlight: state.operationInFlight,
    contextLimitRejected: state.contextLimitRejected,
  };
}

function observeOpenTurn(state: GovernorRuntimeState, resolved: ResolvedContextPolicy): GovernorLifecycleResult {
  const decision = decideGovernor(decisionInputFrom(state, resolved, true));

  const fp = openTurnFingerprint(
    decision.kind,
    decision.pressure.nextRequestPressureTokens,
    state.latestSamplingId,
    state.postMeasurementEstimate.tokens,
  );
  if (fp === state.lastOpenTurnObserveFingerprint) {
    return { state, observe: null };
  }

  if (decision.kind === "turn_open" && !decision.pressure.atOrAboveTrigger) {
    return {
      state: { ...state, lastOpenTurnObserveFingerprint: fp },
      observe: null,
    };
  }

  const observeSequence = state.observeSequence + 1;
  const next: GovernorRuntimeState = {
    ...state,
    observeSequence,
    lastOpenTurnObserveFingerprint: fp,
  };

  const observe = buildObserveRecord({
    state: next,
    resolved,
    decision,
    observePhase: "open_turn",
    settleSequence: null,
    observeSequence,
  });

  return { state: next, observe };
}

function observeOnSettle(state: GovernorRuntimeState, resolved: ResolvedContextPolicy): GovernorLifecycleResult {
  const settleSequence = state.settleSequence + 1;
  const decision = decideGovernor(decisionInputFrom({ ...state, turnOpen: false }, resolved, false));

  const observeSequence = state.observeSequence + 1;
  const next: GovernorRuntimeState = {
    ...state,
    turnOpen: false,
    settleSequence,
    observeSequence,
    lastOpenTurnObserveFingerprint: null,
  };

  const observe = buildObserveRecord({
    state: next,
    resolved,
    decision,
    observePhase: "settled_seam",
    settleSequence,
    observeSequence,
  });

  return { state: next, observe };
}

function buildObserveRecord(args: {
  state: GovernorRuntimeState;
  resolved: ResolvedContextPolicy;
  decision: ReturnType<typeof decideGovernor>;
  observePhase: GovernorObserveRecord["observePhase"];
  settleSequence: number | null;
  observeSequence: number;
}): GovernorObserveRecord {
  const { state, resolved, decision, observePhase, settleSequence, observeSequence } = args;
  return {
    event: "governor_observe",
    hostCapability: CC_LHC_HOST_CAPABILITY,
    observePhase,
    decision: decision.kind,
    reason: decision.reason,
    providerContextTotal: decision.providerContextTotal,
    providerContext: state.latestProviderContext,
    postMeasurementEstimate: normalizePostMeasurementEstimate(state.postMeasurementEstimate),
    pressure:
      decision.pressure ??
      buildPressureReceipt(
        state.latestProviderContext,
        state.postMeasurementEstimate,
        resolved.policy.upperBoundTokens,
        state.providerContextFreshness,
      ),
    upperBoundTokens: resolved.policy.upperBoundTokens,
    lowerBoundTokens: resolved.policy.lowerBoundTokens,
    profile: resolved.policy.profile,
    tokenFamily: state.tokenFamily,
    tokenFamilySource: state.tokenFamilySource,
    wouldMutate: decision.wouldMutate,
    configFallbackCount: resolved.fallbacks.length,
    policySourcesSummary: policySourcesSummary(resolved.sources),
    captureGeneration: state.captureGeneration,
    inputEpoch: state.currentInputEpoch,
    inputEpochAtTurnOpen: state.inputEpochAtTurnOpen,
    observeSequence,
    settleSequence,
    samplingId: state.latestSamplingId,
  };
}

export function applyGovernorLifecycleBatch(
  state: GovernorRuntimeState,
  signals: readonly LifecycleSignal[],
  resolved: ResolvedContextPolicy,
): { state: GovernorRuntimeState; observes: GovernorObserveRecord[] } {
  let current = state;
  const observes: GovernorObserveRecord[] = [];
  for (const signal of signals) {
    const result = applyGovernorLifecycleSignal(current, signal, resolved);
    current = result.state;
    if (result.observe !== null) observes.push(result.observe);
  }
  return { state: current, observes };
}

export function formatGovernorObserveLogLine(record: GovernorObserveRecord): string {
  return `cc-lhc governor_observe ${JSON.stringify(record)}`;
}

export type { PolicyFieldSources };
