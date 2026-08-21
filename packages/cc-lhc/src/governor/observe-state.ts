/**
 * Stateful fold: lifecycle signals → observe decisions for open-turn and settled seams.
 * Pure of I/O except the caller persists/logs the returned record. Never mutates context.
 *
 * - The newest valid provider reading is authoritative and is carried forward.
 *   A missing or malformed usage line downgrades its freshness to `last_known`;
 *   it never erases the session's pressure.
 * - Post-measurement estimate is source-labelled and never counted as provider
 *   usage. It resets only when a new valid reading supersedes it.
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
  ProviderBaseFreshness,
  ProviderContextTokens,
  ResolvedContextPolicy,
} from "./types.js";
import { CC_LHC_HOST_CAPABILITY, EMPTY_POST_MEASUREMENT_ESTIMATE } from "./types.js";

export interface GovernorRuntimeState {
  turnOpen: boolean;
  /** Snapshot of input epoch when the current turn opened (diagnostic only). */
  inputEpochAtTurnOpen: number;
  currentInputEpoch: number;
  /**
   * Newest valid provider reading for this session. Never cleared by a turn
   * boundary or a bad usage line — an older true reading beats no reading.
   */
  latestProviderContext: ProviderContextTokens | null;
  /** Whether latestProviderContext came from the current turn's sampling. */
  providerContextFreshness: ProviderBaseFreshness;
  latestSamplingId: string | null;
  /**
   * Source-labelled estimate of content captured after the latest provider
   * measurement. Reset when a new valid reading becomes authoritative.
   */
  postMeasurementEstimate: PostMeasurementEstimate;
  captureGeneration: number;
  operationInFlight: boolean;
  /** Monotonic settle counter. */
  settleSequence: number;
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
    providerContextFreshness: "none",
    latestSamplingId: null,
    postMeasurementEstimate: { ...EMPTY_POST_MEASUREMENT_ESTIMATE },
    captureGeneration: 0,
    operationInFlight: false,
    settleSequence: 0,
    observeSequence: 0,
    lastOpenTurnObserveFingerprint: null,
    sawSamplingThisTurn: false,
    ...seed,
  };
}

/** Bump input epoch (user typed / queued input). Diagnostic; never a veto. */
export function noteGovernorInput(state: GovernorRuntimeState): GovernorRuntimeState {
  return { ...state, currentInputEpoch: state.currentInputEpoch + 1 };
}

export function setGovernorCaptureGeneration(state: GovernorRuntimeState, generation: number): GovernorRuntimeState {
  return { ...state, captureGeneration: generation };
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
      // The provider reading and the growth measured on top of it both survive
      // the turn boundary: the reading is simply no longer this turn's own.
      return {
        state: {
          ...state,
          turnOpen: true,
          inputEpochAtTurnOpen: state.currentInputEpoch,
          providerContextFreshness: state.latestProviderContext === null ? "none" : "last_known",
          latestSamplingId: null,
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
      // A valid reading supersedes and resets the growth measured on top of the
      // previous one. A missing or malformed one leaves both in place, marked
      // last_known — the session's real size does not disappear with a bad line.
      const next: GovernorRuntimeState =
        usage === null
          ? {
              ...state,
              providerContextFreshness: state.latestProviderContext === null ? "none" : "last_known",
              latestSamplingId: signal.samplingId,
              sawSamplingThisTurn: true,
            }
          : {
              ...state,
              latestProviderContext: usage,
              providerContextFreshness: "current_sampling",
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
      } else if (
        delta.tokens === 0 &&
        state.providerContextFreshness !== "current_sampling" &&
        normalizePostMeasurementEstimate(state.postMeasurementEstimate).tokens > 0
      ) {
        // Failed/blocked sampling is last_known: a following mode=set of 0
        // must not erase accumulated post-measurement growth.
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
      // Degradation is a repair trigger for the wrapper, not a decision input.
      return { state: { ...state, captureGeneration: signal.generation }, observe: null };
    }
    case "native_compact_observed": {
      // R8: loud notice only. Intake captures the summary as ordinary
      // bounded history; nothing pauses, latches, or defers LHC compaction.
      return { state, observe: null };
    }
    case "session_bound":
    case "session_mismatch_observed": {
      // Binding and mismatch are capture/retrieval lifecycle; the wrapper acts
      // on them. Neither changes what the governor decides.
      return { state, observe: null };
    }
    default: {
      return { state, observe: null };
    }
  }
}

/**
 * Re-run the settled decision after capture finished rebuilding/catching up.
 *
 * A seam skipped while capture was catching up is not consumed: this is the
 * catch-up evaluation that replaces "the decision runs exactly once per settle,
 * whatever state capture happened to be in". Returns no record while a turn is
 * open — that turn's own settle will observe.
 */
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
  // Skip identical re-emits (same classification for same pressure/sampling).
  if (fp === state.lastOpenTurnObserveFingerprint) {
    return { state, observe: null };
  }

  // Skip pure turn_open "waiting" noise unless pressure crossed.
  if (decision.kind === "turn_open" && !decision.pressure.atOrAboveTrigger) {
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
    autoCompactIntent: resolved.policy.autoCompact,
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
