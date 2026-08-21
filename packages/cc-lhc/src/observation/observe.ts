/**
 * Formal Claude rollout observation adapter.
 *
 * One interpretation of each parsed line yields:
 *  - ordered canonical LHC intake events
 *  - typed host lifecycle signals
 *
 * Lifecycle aggregation (sampling/turn) is fold-over-lines only; intake stays
 * per-block in native order.
 */

import type { MessageEventInput } from "lhc";

import { providerContextFromUsage } from "../governor/provider-context.js";
import {
  contentBlocks,
  isAssistantLine,
  isUserLine,
  type MapStats,
  mapRolloutLine,
  nativeCompactSummaryText,
} from "../intake/map.js";
import { classifyTurnSignal, isAssistantSamplingComplete } from "../intake/turn-signal.js";
import { attributeLineSession } from "../rollout/expected-session.js";
import type { RolloutLineItem, WatcherEmission } from "../rollout/types.js";
import { type AsyncWorkFold, observeAsyncWorkLine } from "./async-work.js";
import {
  createPostMeasurementEstimateFold,
  HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE,
  hostEstimateFromCanonicalBytes,
  type PostMeasurementEstimateFold,
  postMeasurementEstimateFromEvents,
  PROVIDER_OUTPUT_ESTIMATE_SOURCE,
  readProviderOutputTokens,
  totalCanonicalPayloadBytes,
} from "./estimate.js";
import {
  completeSamplingAttempt,
  createSamplingDedupeState,
  noteSamplingPartial,
  type SamplingDedupeState,
  samplingIdFromAssistant,
} from "./sampling.js";
import type { LifecycleSignal, ObservationStats, TurnOpenReason, TurnSettleReason } from "./types.js";

/**
 * Mutable turn-state fold shared across observe calls for one capture generation.
 * classifyTurnSignal remains a pure state assertion; lifecycle emits only edges.
 */
export interface TurnFoldState {
  open: boolean;
}

export function createTurnFoldState(): TurnFoldState {
  return { open: false };
}

export interface ObserveLineOptions {
  expectedSessionId?: string;
  samplingDedupe?: SamplingDedupeState;
  generation?: number;
  /** When provided, turn lifecycle emissions are edge-only against this fold. */
  turnFold?: TurnFoldState;
  /**
   * Live post-measurement estimate fold. Shared across lines for one capture
   * generation so production emits cumulative growth after the latest sampling.
   */
  estimateFold?: PostMeasurementEstimateFold;
  /**
   * Rebuilt historical prefix: still parse + attribute, but do not emit
   * conversation/runtime lifecycle facts and do not mutate live sampling/turn
   * folds. Capture-degraded / session-mismatch validation still flow.
   */
  suppressRuntimeLifecycle?: boolean;
  /**
   * Open asynchronous work derived from the same ordered lines. Shared across
   * one capture generation, like the sampling and turn folds. Absent for
   * callers that do not track it.
   */
  asyncWorkFold?: AsyncWorkFold;
  /**
   * When true (live capture session path): do not emit pressure-affecting
   * signals (`post_measurement_estimate`, `turn_settled`) into `lifecycle`.
   * Put them in `deferredPressure` instead so the caller can publish only
   * after replay dedupe + successful intake. Sampling folds still update;
   * mode:add is not precomputed (caller derives adds from accepted events).
   */
  deferPressureLifecycle?: boolean;
}

export interface ObserveLineResult {
  events: MessageEventInput[];
  lifecycle: LifecycleSignal[];
  /**
   * Pressure-affecting signals held when `deferPressureLifecycle` is set:
   * sampling `post_measurement_estimate` mode:set and `turn_settled` only.
   * mode:add is never pre-held — derive from post-dedupe accepted events.
   */
  deferredPressure: LifecycleSignal[];
  /**
   * True when this line would have emitted a post-measurement mode:add under
   * immediate observe (authoritative sampling already seen, non-sampling-complete
   * content with payload). Session uses this with accepted-event bytes.
   */
  wouldPostMeasurementAdd: boolean;
  stats: ObservationStats;
  unknownShape?: boolean;
}

function emptyStats(): ObservationStats {
  return { sidechain: 0, unknown: 0, meta: 0, image: 0 };
}

function asMapStats(stats: ObservationStats): MapStats {
  return { ...stats };
}

function providerUsageOf(message: RolloutLineItem["message"]): Record<string, unknown> | undefined {
  if (message === undefined || typeof message !== "object" || message === null) return undefined;
  const usage = (message as Record<string, unknown>).usage;
  if (usage === undefined || usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }
  return usage as Record<string, unknown>;
}

function modelOf(message: RolloutLineItem["message"]): string | undefined {
  if (message === undefined) return undefined;
  const model = message.model;
  return typeof model === "string" && model !== "" ? model : undefined;
}

function messageIdOf(message: RolloutLineItem["message"]): string | undefined {
  if (message === undefined || typeof message !== "object" || message === null) return undefined;
  const id = (message as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

function requestIdOf(item: RolloutLineItem): string | undefined {
  const top = item.requestId;
  if (typeof top === "string" && top !== "") return top;
  return undefined;
}

function lineUuid(item: RolloutLineItem, lineIndex: number): string {
  if (typeof item.uuid === "string" && item.uuid !== "") return item.uuid;
  return `synthetic:${lineIndex}`;
}

function turnOpenReason(item: RolloutLineItem): TurnOpenReason {
  const content = item.message?.content;
  if (Array.isArray(content) && contentBlocks(content).some((block) => block.type === "tool_result")) {
    return "tool_result";
  }
  return "user_prompt";
}

function turnSettleReason(item: RolloutLineItem): TurnSettleReason {
  if (isUserLine(item)) {
    const content = item.message?.content;
    const text =
      typeof content === "string"
        ? content
        : contentBlocks(content)
            .filter((block) => block.type === "text" || block.type === "tool_result")
            .map((block) =>
              block.type === "text"
                ? typeof block.text === "string"
                  ? block.text
                  : ""
                : typeof block.content === "string"
                  ? block.content
                  : "",
            )
            .join("");
    if (text.trimStart().startsWith("[Request interrupted")) return "interrupt";
  }
  const stop = item.message?.stop_reason;
  if (stop === "end_turn") return "end_turn";
  if (stop === "stop_sequence") return "stop_sequence";
  return "other";
}

function unknownConversationShapeKey(item: RolloutLineItem, lineIndex: number): string {
  const type = typeof item.type === "string" && item.type !== "" ? item.type : "none";
  // Bounded key for sticky health; line index is for logs only (not in key).
  void lineIndex;
  return `unknown_shape:type=${type}`;
}

/**
 * Interpret one rollout line once → ordered events + lifecycle signals.
 *
 * On a completing assistant line: sampling_observed (final), then the completed
 * response's own contribution to next-request growth (provider output_tokens or
 * host byte estimate), then turn_settled when applicable.
 *
 * After an authoritative sampling, subsequent captured tool results /
 * assistant / user / runtime content accumulate as post_measurement_estimate
 * adds. Sidechains, synthetic resume chrome, meta, and suppressed prefixes do
 * not contribute (mapRolloutLine already drops them from events).
 *
 * When `deferPressureLifecycle` is set (live capture path), estimate/settled
 * signals are held so the session can publish them only for events accepted by
 * replay dedupe and successfully intaken into canonical LHC.
 */
export function observeRolloutLine(
  item: RolloutLineItem,
  lineIndex = 0,
  options: ObserveLineOptions = {},
): ObserveLineResult {
  const lifecycle: LifecycleSignal[] = [];
  const deferredPressure: LifecycleSignal[] = [];
  const deferPressure = options.deferPressureLifecycle === true;
  const generation = options.generation ?? 1;
  const samplingDedupe = options.samplingDedupe ?? createSamplingDedupeState();
  const estimateFold = options.estimateFold ?? createPostMeasurementEstimateFold();

  const pushEstimate = (signal: Extract<LifecycleSignal, { kind: "post_measurement_estimate" }>): void => {
    if (deferPressure) {
      // mode:add is never held here — session rebuilds adds from accepted events.
      if (signal.mode === "add") return;
      deferredPressure.push(signal);
      return;
    }
    lifecycle.push(signal);
  };

  const pushSettled = (signal: Extract<LifecycleSignal, { kind: "turn_settled" }>): void => {
    if (deferPressure) {
      deferredPressure.push(signal);
      return;
    }
    lifecycle.push(signal);
  };

  if (options.expectedSessionId !== undefined) {
    const attr = attributeLineSession(
      options.expectedSessionId,
      item.sessionId,
      typeof item.session_id === "string" ? item.session_id : undefined,
    );
    if (attr.conflict && attr.observed !== undefined) {
      lifecycle.push({
        kind: "session_mismatch_observed",
        expected: options.expectedSessionId,
        observed: attr.observed,
      });
      lifecycle.push({
        kind: "capture_degraded",
        reason: `session_mismatch:${attr.observed}`,
        generation,
      });
      return {
        events: [],
        lifecycle,
        deferredPressure: [],
        wouldPostMeasurementAdd: false,
        stats: emptyStats(),
      };
    }
  }

  const suppressRuntime = options.suppressRuntimeLifecycle === true;

  // Rebuilt historical prefix lines are a served projection of work that is
  // already over — the launches they replay were killed by the swap that
  // wrote them. Only the live suffix opens work.
  if (!suppressRuntime && options.asyncWorkFold !== undefined) {
    observeAsyncWorkLine(item, options.asyncWorkFold);
  }

  if (!suppressRuntime) {
    // Same discriminator intake maps on, so the loud notice and the bounded
    // closed turn can never disagree about what a native summary is.
    const nativeSummary = nativeCompactSummaryText(item);
    if (nativeSummary !== null) {
      lifecycle.push({
        kind: "native_compact_observed",
        ...(nativeSummary !== "" ? { summaryPreview: nativeSummary.slice(0, 120) } : {}),
      });
    }
  }

  const mapped = mapRolloutLine(item, lineIndex);
  const stats = asMapStats(mapped.stats);
  const events = mapped.events;
  const linePayloadBytes = totalCanonicalPayloadBytes(events);

  // Sampling fold: accumulate on every assistant line; emit once when complete.
  // Prefix validation must not mutate live sampling state.
  let samplingEmittedThisLine = false;
  let wouldPostMeasurementAdd = false;
  if (!suppressRuntime && isAssistantLine(item) && item.isSidechain !== true) {
    const usage = providerUsageOf(item.message);
    const model = modelOf(item.message);
    const reqId = requestIdOf(item);
    const msgId = messageIdOf(item.message);
    const samplingId = samplingIdFromAssistant({
      lineUuid: lineUuid(item, lineIndex),
      ...(reqId !== undefined ? { requestId: reqId } : {}),
      ...(msgId !== undefined ? { messageId: msgId } : {}),
    });
    if (isAssistantSamplingComplete(item)) {
      // Include this completing line's canonical payload in the pending assistant
      // body so host-byte fallback covers split thinking/text/tool blocks.
      estimateFold.pendingAssistantPayloadBytes += linePayloadBytes;
      const claim = completeSamplingAttempt(samplingDedupe, samplingId, model, usage);
      if (claim.action === "emit") {
        samplingEmittedThisLine = true;
        lifecycle.push({
          kind: "sampling_observed",
          samplingId: claim.samplingId,
          ...(claim.model !== undefined ? { model: claim.model } : {}),
          ...(claim.providerUsage !== undefined ? { providerUsage: claim.providerUsage } : {}),
        });
        const blocked =
          item.isApiErrorMessage === true || (typeof item.error === "string" && item.error !== "");
        const provider = blocked ? null : providerContextFromUsage(claim.providerUsage);
        // API-error, blocked, all-zero, malformed, or missing usage is not a
        // new measurement: do not emit mode=set that would erase growth.
        if (provider !== null) {
          const outputTokens = readProviderOutputTokens(claim.providerUsage);
          if (outputTokens !== null) {
            pushEstimate({
              kind: "post_measurement_estimate",
              tokens: outputTokens,
              source: PROVIDER_OUTPUT_ESTIMATE_SOURCE,
              mode: "set",
            });
          } else {
            const est = hostEstimateFromCanonicalBytes(estimateFold.pendingAssistantPayloadBytes);
            pushEstimate({
              kind: "post_measurement_estimate",
              tokens: est.tokens,
              source: HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE,
              mode: "set",
            });
          }
          estimateFold.hasAuthoritativeSampling = true;
        }
        estimateFold.pendingAssistantPayloadBytes = 0;
      } else {
        // Duplicate complete (replay/dedupe): do not re-seed estimate or count
        // the assistant body again as post-measurement growth.
        estimateFold.pendingAssistantPayloadBytes = 0;
      }
    } else if (usage !== undefined || model !== undefined || linePayloadBytes > 0) {
      noteSamplingPartial(samplingDedupe, samplingId, model, usage);
      estimateFold.pendingAssistantPayloadBytes += linePayloadBytes;
    }
  } else if (
    !suppressRuntime &&
    !samplingEmittedThisLine &&
    estimateFold.hasAuthoritativeSampling &&
    linePayloadBytes > 0
  ) {
    // Content after the last provider measurement: tool results, user prompts,
    // runtime notes, and later assistant lines (new attempt partials land here
    // only once a prior sampling was authoritative; incomplete assistant partials
    // above accumulate into pending and emit on complete).
    wouldPostMeasurementAdd = true;
    if (!deferPressure) {
      const est = postMeasurementEstimateFromEvents(events);
      if (est.tokens > 0 || linePayloadBytes > 0) {
        lifecycle.push({
          kind: "post_measurement_estimate",
          tokens: est.tokens,
          source: est.source,
          mode: "add",
        });
      }
    }
  }

  // Retain the pure classifyTurnSignal fold for state; publish lifecycle only
  // on real edges. Assistant tool_use is an "open" state assertion (turn
  // continues) but must not republish turn_opened for every split block.
  // User prompt / tool_result openings and open→close settlements emit once.
  // Prefix validation must not mutate live turn fold state.
  if (!suppressRuntime) {
    const signal = classifyTurnSignal(item);
    const fold = options.turnFold;
    if (fold !== undefined) {
      const wasOpen = fold.open;
      if (signal === "opens") {
        fold.open = true;
        if (!wasOpen && isUserLine(item)) {
          lifecycle.push({ kind: "turn_opened", reason: turnOpenReason(item) });
        }
      } else if (signal === "closes") {
        fold.open = false;
        if (wasOpen) {
          pushSettled({ kind: "turn_settled", reason: turnSettleReason(item) });
        }
      }
    } else {
      // Stateless single-line observe (tests / callers without a fold): emit
      // only user opening edges and close assertions that are content-terminal.
      if (signal === "opens" && isUserLine(item)) {
        lifecycle.push({ kind: "turn_opened", reason: turnOpenReason(item) });
      } else if (signal === "closes") {
        pushSettled({ kind: "turn_settled", reason: turnSettleReason(item) });
      }
    }
  }

  // Unknown host chrome is diagnostic only. Claude adds top-level bookkeeping
  // records over time; absence from our metadata census is not evidence that
  // canonical conversation was lost. Only an unknown USER/ASSISTANT record can
  // conceal conversational content and therefore threaten safe rebuilding.
  const unknownConversationShape = stats.unknown > 0 && (isUserLine(item) || isAssistantLine(item));
  if (unknownConversationShape) {
    lifecycle.push({
      kind: "capture_degraded",
      reason: unknownConversationShapeKey(item, lineIndex),
      generation,
    });
  }

  return {
    events,
    lifecycle,
    deferredPressure,
    wouldPostMeasurementAdd,
    stats,
    ...(unknownConversationShape ? { unknownShape: true } : {}),
  };
}

export function observeWatcherEmission(
  emission: WatcherEmission,
  lineIndex: number,
  options: ObserveLineOptions = {},
): ObserveLineResult {
  if (emission.kind === "parse_error") {
    const generation = options.generation ?? 1;
    return {
      events: [],
      lifecycle: [
        {
          kind: "capture_degraded",
          reason: `parse_error:${emission.error}`,
          generation,
        },
      ],
      deferredPressure: [],
      wouldPostMeasurementAdd: false,
      stats: emptyStats(),
    };
  }
  return observeRolloutLine(emission.item, lineIndex, options);
}

export function observeRolloutLines(
  items: readonly RolloutLineItem[],
  options: ObserveLineOptions = {},
): ObserveLineResult {
  const events: MessageEventInput[] = [];
  const lifecycle: LifecycleSignal[] = [];
  const deferredPressure: LifecycleSignal[] = [];
  let wouldPostMeasurementAdd = false;
  const stats = emptyStats();
  // Share sampling + turn + estimate folds across the batch (same as live session fold).
  const samplingDedupe = options.samplingDedupe ?? createSamplingDedupeState();
  const turnFold = options.turnFold ?? createTurnFoldState();
  const estimateFold = options.estimateFold ?? createPostMeasurementEstimateFold();
  const opts = { ...options, samplingDedupe, turnFold, estimateFold };
  for (const [lineIndex, item] of items.entries()) {
    const observed = observeRolloutLine(item, lineIndex, opts);
    events.push(...observed.events);
    lifecycle.push(...observed.lifecycle);
    deferredPressure.push(...observed.deferredPressure);
    wouldPostMeasurementAdd = wouldPostMeasurementAdd || observed.wouldPostMeasurementAdd;
    stats.sidechain += observed.stats.sidechain;
    stats.unknown += observed.stats.unknown;
    stats.meta += observed.stats.meta;
    stats.image += observed.stats.image;
  }
  return { events, lifecycle, deferredPressure, wouldPostMeasurementAdd, stats };
}

/**
 * Post-measurement add for events that survived replay dedupe and successful
 * intake. Same estimator as immediate observe mode:add. Zero tokens when empty.
 * Callers must not invoke this for sampling-complete assistant lines whose
 * contribution was already published as mode:set.
 */
export function postMeasurementAddFromAcceptedEvents(
  events: readonly MessageEventInput[],
): Extract<LifecycleSignal, { kind: "post_measurement_estimate" }> | null {
  const est = postMeasurementEstimateFromEvents(events);
  if (est.tokens <= 0) return null;
  return {
    kind: "post_measurement_estimate",
    tokens: est.tokens,
    source: est.source,
    mode: "add",
  };
}
