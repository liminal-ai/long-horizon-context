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
  PROVIDER_OUTPUT_ESTIMATE_SOURCE,
  postMeasurementEstimateFromEvents,
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
import { noteAssistantModel, type SessionTokenFamilyState } from "./token-family.js";
import type { LifecycleSignal, ObservationStats, TurnOpenReason, TurnSettleReason } from "./types.js";

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
  turnFold?: TurnFoldState;
  estimateFold?: PostMeasurementEstimateFold;
  suppressRuntimeLifecycle?: boolean;
  asyncWorkFold?: AsyncWorkFold;
  tokenFamily?: SessionTokenFamilyState;
  deferPressureLifecycle?: boolean;
}

export interface ObserveLineResult {
  events: MessageEventInput[];
  lifecycle: LifecycleSignal[];
  deferredPressure: LifecycleSignal[];
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

const CLAUDE_PROMPT_TOO_LONG = "Prompt is too long";

function assistantPlainText(item: RolloutLineItem): string {
  const content = item.message?.content;
  if (typeof content === "string") return content;
  return contentBlocks(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

export function isClaudePromptTooLongRejection(item: RolloutLineItem): boolean {
  if (item.isSidechain === true) return false;
  if (!isAssistantLine(item)) return false;
  if (item.isApiErrorMessage !== true) return false;
  if (item.error !== "invalid_request") return false;
  return assistantPlainText(item) === CLAUDE_PROMPT_TOO_LONG;
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
  void lineIndex;
  return `unknown_shape:type=${type}`;
}

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

  if (!suppressRuntime && options.asyncWorkFold !== undefined) {
    observeAsyncWorkLine(item, options.asyncWorkFold);
  }

  if (!suppressRuntime) {
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
    if (model !== undefined && options.tokenFamily !== undefined) {
      noteAssistantModel(options.tokenFamily, model);
    }
    if (isAssistantSamplingComplete(item)) {
      estimateFold.pendingAssistantPayloadBytes += linePayloadBytes;
      const claim = completeSamplingAttempt(samplingDedupe, samplingId, model, usage);
      if (claim.action === "emit") {
        samplingEmittedThisLine = true;
        lifecycle.push({
          kind: "sampling_observed",
          samplingId: claim.samplingId,
          ...(claim.model !== undefined ? { model: claim.model } : {}),
          ...(claim.providerUsage !== undefined ? { providerUsage: claim.providerUsage } : {}),
          ...(isClaudePromptTooLongRejection(item) ? { contextLimitRejected: true as const } : {}),
        });
        const blocked = item.isApiErrorMessage === true || (typeof item.error === "string" && item.error !== "");
        const provider = blocked ? null : providerContextFromUsage(claim.providerUsage);
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
    wouldPostMeasurementAdd = true;
    if (!deferPressure) {
      const est = postMeasurementEstimateFromEvents(events, options.tokenFamily?.estimator);
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
      if (signal === "opens" && isUserLine(item)) {
        lifecycle.push({ kind: "turn_opened", reason: turnOpenReason(item) });
      } else if (signal === "closes") {
        pushSettled({ kind: "turn_settled", reason: turnSettleReason(item) });
      }
    }
  }

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

export function postMeasurementAddFromAcceptedEvents(
  events: readonly MessageEventInput[],
  estimator?: import("lhc").TokenEstimator,
): Extract<LifecycleSignal, { kind: "post_measurement_estimate" }> | null {
  const est = postMeasurementEstimateFromEvents(events, estimator);
  if (est.tokens <= 0) return null;
  return {
    kind: "post_measurement_estimate",
    tokens: est.tokens,
    source: est.source,
    mode: "add",
  };
}
