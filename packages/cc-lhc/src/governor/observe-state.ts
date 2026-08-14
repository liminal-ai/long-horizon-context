/**
 * Stateful fold: lifecycle signals → observe decisions for open-turn and settled seams.
 * Pure of I/O except the caller persists/logs the returned record. Never mutates context.
 *
 * LIM-64:
 * - Latest completed sampling is authoritative; missing/invalid clears stale usage.
 * - Post-measurement estimate is source-labelled and never counted as provider usage.
 * - Open-turn threshold crossings are classified (wouldMutate=false) without mutation.
 * - Settled seam may arm wouldMutate for capability-limited compact + controlled handoff.
 */

import { mergeEstimateSource } from "../observation/estimate.js";
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
  ProviderContextTokens,
  ResolvedContextPolicy,
} from "./types.js";
import { CC_LHC_HOST_CAPABILITY, EMPTY_POST_MEASUREMENT_ESTIMATE } from "./types.js";

export interface GovernorRuntimeState {
  turnOpen: boolean;
  /** Snapshot of input epoch when the current turn opened. */
  inputEpochAtTurnOpen: number;
  currentInputEpoch: number;
  latestProviderContext: ProviderContextTokens | null;
  latestSamplingId: string | null;
  /**
   * Source-labelled estimate of content captured after the latest provider
   * measurement. Reset when a new sampling becomes authoritative.
   */
  postMeasurementEstimate: PostMeasurementEstimate;
  captureHealthy: boolean;
  captureGeneration: number;
  descriptorReady: boolean;
  operationInFlight: boolean;
  nativeSummaryAttention: boolean;
  /**
   * Predicted next-request pressure at last would_compact for this generation
   * (used for retry-growth hysteresis).
   */
  lastWouldCompactProviderTotal: number | null;
  lastWouldCompactCaptureGeneration: number | null;
  /** Monotonic settle counter. */
  settleSequence: number;
  /** Last settle sequence that already produced a settled observe record. */
  lastObservedSettleSequence: number;
  /** Monotonic observe counter (open + settled). */
  observeSequence: number;
  /**
   * Last open-turn observe fingerprint for this turn (decision + pressure + sampling).
   * Prevents spam re-emits of identical open-turn classifications.
   */
  lastOpenTurnObserveFingerprint: string | null;
  /** Whether we have seen any sampling for the open/current turn. */
  sawSamplingThisTurn: boolean;
}

export function createGovernorRuntimeState(seed: Partial<GovernorRuntimeState> = {}): GovernorRuntimeState {
  return {
    turnOpen: false,
    inputEpochAtTurnOpen: 0,
    currentInputEpoch: 0,
    latestProviderContext: null,
    latestSamplingId: null,
    postMeasurementEstimate: { ...EMPTY_POST_MEASUREMENT_ESTIMATE },
    captureHealthy: true,
    captureGeneration: 0,
    descriptorReady: false,
    operationInFlight: false,
    nativeSummaryAttention: false,
    lastWouldCompactProviderTotal: null,
    lastWouldCompactCaptureGeneration: null,
    settleSequence: 0,
    lastObservedSettleSequence: -1,
    observeSequence: 0,
    lastOpenTurnObserveFingerprint: null,
    sawSamplingThisTurn: false,
    ...seed,
  };
}

/** Bump input epoch (user typed / queued input). */
export function noteGovernorInput(state: GovernorRuntimeState): GovernorRuntimeState {
  return { ...state, currentInputEpoch: state.currentInputEpoch + 1 };
}

export function setGovernorDescriptorReady(state: GovernorRuntimeState, ready: boolean): GovernorRuntimeState {
  return { ...state, descriptorReady: ready };
}

export function setGovernorCaptureHealth(
  state: GovernorRuntimeState,
  healthy: boolean,
  generation: number,
): GovernorRuntimeState {
  return {
    ...state,
    captureHealthy: healthy,
    captureGeneration: generation,
  };
}

export function setGovernorOperationInFlight(state: GovernorRuntimeState, inFlight: boolean): GovernorRuntimeState {
  return { ...state, operationInFlight: inFlight };
}

/**
 * Replace the post-measurement estimate (content captured after last provider request).
 * Domain is forced to source_labelled_estimate.
 */
export function setGovernorPostMeasurementEstimate(
  state: GovernorRuntimeState,
  estimate: PostMeasurementEstimate,
): GovernorRuntimeState {
  return {
    ...state,
    postMeasurementEstimate: normalizePostMeasurementEstimate(estimate),
  };
}

export interface GovernorLifecycleResult {
  state: GovernorRuntimeState;
  /** Observe record for this signal (at most one). */
  observe: GovernorObserveRecord | null;
}

/**
 * Apply one lifecycle signal. Returns updated state and optional observe record.
 */
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
          latestProviderContext: null,
          latestSamplingId: null,
          postMeasurementEstimate: { ...EMPTY_POST_MEASUREMENT_ESTIMATE },
          sawSamplingThisTurn: false,
          lastOpenTurnObserveFingerprint: null,
        },
        observe: null,
      };
    }
    case "sampling_observed": {
      const usage =
        signal.providerUsage !== undefined
          ? providerContextFromUsage(signal.providerUsage as Record<string, unknown>)
          : null;
      // Latest completed sampling is authoritative. Missing or invalid provider
      // usage must clear an older count rather than trigger from stale pressure.
      // New measurement resets the post-measurement estimate (content after this
      // request has not yet been captured).
      const next: GovernorRuntimeState = {
        ...state,
        latestProviderContext: usage,
        latestSamplingId: signal.samplingId,
        sawSamplingThisTurn: true,
        postMeasurementEstimate: { ...EMPTY_POST_MEASUREMENT_ESTIMATE },
      };
      // Classify during open turn so threshold-crossed-open is receipted.
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
        // Cumulative growth for the current authoritative sampling. Do not
        // replace the running total with only the latest line.
        const prev = normalizePostMeasurementEstimate(state.postMeasurementEstimate);
        const tokens = prev.tokens + delta.tokens;
        const safeTokens = Number.isSafeInteger(tokens) ? tokens : prev.tokens;
        estimate = {
          tokens: safeTokens,
          source: mergeEstimateSource(prev.source, delta.source, prev.tokens),
          domain: "source_labelled_estimate",
        };
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
      return {
        state: {
          ...state,
          captureHealthy: false,
          captureGeneration: signal.generation,
        },
        observe: null,
      };
    }
    case "native_compact_observed": {
      // Explicit attention latch: LHC will not race a native writer.
      return {
        state: { ...state, nativeSummaryAttention: true },
        observe: null,
      };
    }
    case "session_bound": {
      // Binding does not alone mark descriptor ready; wrapper does that.
      return { state, observe: null };
    }
    case "session_mismatch_observed": {
      return {
        state: { ...state, captureHealthy: false, descriptorReady: false },
        observe: null,
      };
    }
    default: {
      return { state, observe: null };
    }
  }
}

function openTurnFingerprint(
  decision: string,
  pressureTokens: number | null,
  samplingId: string | null,
  estimateTokens: number,
): string {
  return `${decision}|${pressureTokens ?? "null"}|${samplingId ?? ""}|${estimateTokens}`;
}

function observeOpenTurn(state: GovernorRuntimeState, resolved: ResolvedContextPolicy): GovernorLifecycleResult {
  const decision = decideGovernor({
    policy: resolved.policy,
    policyArmed: resolved.armed,
    turnOpen: true,
    settleStale: false,
    providerContext: state.latestProviderContext,
    postMeasurementEstimate: state.postMeasurementEstimate,
    captureHealthy: state.captureHealthy,
    captureGeneration: state.captureGeneration,
    descriptorReady: state.descriptorReady,
    operationInFlight: state.operationInFlight,
    inputEpochAtTurnOpen: state.inputEpochAtTurnOpen,
    currentInputEpoch: state.currentInputEpoch,
    nativeSummaryAttention: state.nativeSummaryAttention,
    lastWouldCompactProviderTotal: state.lastWouldCompactProviderTotal,
    lastWouldCompactCaptureGeneration: state.lastWouldCompactCaptureGeneration,
  });

  const fp = openTurnFingerprint(
    decision.kind,
    decision.pressure.nextRequestPressureTokens,
    state.latestSamplingId,
    state.postMeasurementEstimate.tokens,
  );
  // Skip identical re-emits (same classification for same pressure/sampling).
  if (fp === state.lastOpenTurnObserveFingerprint) {
    return { state, observe: null };
  }

  // Skip pure turn_open "waiting" noise unless pressure crossed or a gate failed.
  // Always emit would_compact (threshold), no_provider_usage, and all gate kinds.
  if (decision.kind === "turn_open" && decision.pressure.atOrAboveTrigger !== true) {
    // Still remember fingerprint so we don't thrash if estimate flickers at same kind.
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
  let next: GovernorRuntimeState = {
    ...state,
    turnOpen: false,
    settleSequence,
  };

  // Dedupe: never emit two observe records for the same settle sequence.
  if (settleSequence === state.lastObservedSettleSequence) {
    return { state: next, observe: null };
  }

  const decision = decideGovernor({
    policy: resolved.policy,
    policyArmed: resolved.armed,
    turnOpen: false,
    settleStale: false,
    providerContext: next.latestProviderContext,
    postMeasurementEstimate: next.postMeasurementEstimate,
    captureHealthy: next.captureHealthy,
    captureGeneration: next.captureGeneration,
    descriptorReady: next.descriptorReady,
    operationInFlight: next.operationInFlight,
    inputEpochAtTurnOpen: next.inputEpochAtTurnOpen,
    currentInputEpoch: next.currentInputEpoch,
    nativeSummaryAttention: next.nativeSummaryAttention,
    lastWouldCompactProviderTotal: next.lastWouldCompactProviderTotal,
    lastWouldCompactCaptureGeneration: next.lastWouldCompactCaptureGeneration,
  });

  if (decision.kind === "would_compact" && decision.pressure.nextRequestPressureTokens !== null) {
    next = {
      ...next,
      lastWouldCompactProviderTotal: decision.pressure.nextRequestPressureTokens,
      lastWouldCompactCaptureGeneration: next.captureGeneration,
    };
  }

  const observeSequence = next.observeSequence + 1;
  next = {
    ...next,
    lastObservedSettleSequence: settleSequence,
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
      ),
    upperBoundTokens: resolved.policy.upperBoundTokens,
    lowerBoundTokens: resolved.policy.lowerBoundTokens,
    profile: resolved.policy.profile,
    autoCompactIntent: resolved.policy.autoCompact,
    observeOnly: resolved.policy.observeOnly,
    wouldMutate: decision.wouldMutate,
    policyArmed: resolved.armed,
    policySourcesSummary: policySourcesSummary(resolved.sources),
    captureGeneration: state.captureGeneration,
    inputEpoch: state.currentInputEpoch,
    inputEpochAtTurnOpen: state.inputEpochAtTurnOpen,
    observeSequence,
    settleSequence,
    samplingId: state.latestSamplingId,
  };
}

/**
 * Apply a batch of lifecycle signals in order.
 */
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

/** Expose sources type helper for tests. */
export type { PolicyFieldSources };
