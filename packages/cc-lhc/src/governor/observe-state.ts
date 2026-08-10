/**
 * Stateful fold: lifecycle signals → at most one observe decision per settled turn.
 * Pure of I/O except the caller logs the returned record. Never mutates context.
 */

import { decideGovernor } from "./decide.js";
import { providerContextFromUsage } from "./provider-context.js";
import { policySourcesSummary } from "./config.js";
import type {
  GovernorObserveRecord,
  PolicyFieldSources,
  ProviderContextTokens,
  ResolvedContextPolicy,
} from "./types.js";
import type { LifecycleSignal } from "../observation/types.js";

export interface GovernorRuntimeState {
  turnOpen: boolean;
  /** Snapshot of input epoch when the current turn opened. */
  inputEpochAtTurnOpen: number;
  currentInputEpoch: number;
  latestProviderContext: ProviderContextTokens | null;
  latestSamplingId: string | null;
  captureHealthy: boolean;
  captureGeneration: number;
  descriptorReady: boolean;
  operationInFlight: boolean;
  nativeSummaryAttention: boolean;
  lastWouldCompactProviderTotal: number | null;
  lastWouldCompactCaptureGeneration: number | null;
  /** Monotonic settle counter for dedupe. */
  settleSequence: number;
  /** Last settle sequence that already produced an observe record. */
  lastObservedSettleSequence: number;
  /** Whether we have seen any sampling for the open/current turn. */
  sawSamplingThisTurn: boolean;
}

export function createGovernorRuntimeState(
  seed: Partial<GovernorRuntimeState> = {},
): GovernorRuntimeState {
  return {
    turnOpen: false,
    inputEpochAtTurnOpen: 0,
    currentInputEpoch: 0,
    latestProviderContext: null,
    latestSamplingId: null,
    captureHealthy: true,
    captureGeneration: 0,
    descriptorReady: false,
    operationInFlight: false,
    nativeSummaryAttention: false,
    lastWouldCompactProviderTotal: null,
    lastWouldCompactCaptureGeneration: null,
    settleSequence: 0,
    lastObservedSettleSequence: -1,
    sawSamplingThisTurn: false,
    ...seed,
  };
}

/** Bump input epoch (user typed / queued input). */
export function noteGovernorInput(state: GovernorRuntimeState): GovernorRuntimeState {
  return { ...state, currentInputEpoch: state.currentInputEpoch + 1 };
}

export function setGovernorDescriptorReady(
  state: GovernorRuntimeState,
  ready: boolean,
): GovernorRuntimeState {
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

export function setGovernorOperationInFlight(
  state: GovernorRuntimeState,
  inFlight: boolean,
): GovernorRuntimeState {
  return { ...state, operationInFlight: inFlight };
}

export interface GovernorLifecycleResult {
  state: GovernorRuntimeState;
  /** At most one observe record per call batch for a unique settle. */
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
          sawSamplingThisTurn: false,
        },
        observe: null,
      };
    }
    case "sampling_observed": {
      const usage =
        signal.providerUsage !== undefined
          ? providerContextFromUsage(signal.providerUsage as Record<string, unknown>)
          : null;
      return {
        state: {
          ...state,
          latestProviderContext: usage ?? state.latestProviderContext,
          latestSamplingId: signal.samplingId,
          sawSamplingThisTurn: true,
        },
        observe: null,
      };
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

function observeOnSettle(
  state: GovernorRuntimeState,
  resolved: ResolvedContextPolicy,
): GovernorLifecycleResult {
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

  if (decision.kind === "would_compact" && next.latestProviderContext !== null) {
    next = {
      ...next,
      lastWouldCompactProviderTotal: next.latestProviderContext.total,
      lastWouldCompactCaptureGeneration: next.captureGeneration,
    };
  }

  next = { ...next, lastObservedSettleSequence: settleSequence };

  const observe: GovernorObserveRecord = {
    event: "governor_observe",
    decision: decision.kind,
    reason: decision.reason,
    providerContextTotal: decision.providerContextTotal,
    providerContext: next.latestProviderContext,
    upperBoundTokens: resolved.policy.upperBoundTokens,
    lowerBoundTokens: resolved.policy.lowerBoundTokens,
    profile: resolved.policy.profile,
    autoCompactIntent: resolved.policy.autoCompact,
    observeOnly: true,
    wouldMutate: false,
    policyArmed: resolved.armed,
    policySourcesSummary: policySourcesSummary(resolved.sources),
    captureGeneration: next.captureGeneration,
    inputEpoch: next.currentInputEpoch,
    inputEpochAtTurnOpen: next.inputEpochAtTurnOpen,
    settleSequence,
    samplingId: next.latestSamplingId,
  };

  return { state: next, observe };
}

/**
 * Apply a batch of lifecycle signals in order. Emits at most one observe
 * record per unique turn_settled in the batch (typically one).
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
