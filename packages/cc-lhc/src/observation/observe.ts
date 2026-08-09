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

import { contentBlocks, isAssistantLine, isUserLine, mapRolloutLine, type MapStats } from "../intake/map.js";
import { classifyTurnSignal, isAssistantSamplingComplete } from "../intake/turn-signal.js";
import { attributeLineSession } from "../rollout/expected-session.js";
import type { RolloutLineItem, WatcherEmission } from "../rollout/types.js";
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
   * Rebuilt historical prefix: still parse + attribute, but do not emit
   * conversation/runtime lifecycle facts and do not mutate live sampling/turn
   * folds. Capture-degraded / session-mismatch validation still flow.
   */
  suppressRuntimeLifecycle?: boolean;
}

export interface ObserveLineResult {
  events: MessageEventInput[];
  lifecycle: LifecycleSignal[];
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

function isNativeSummary(item: RolloutLineItem): boolean {
  return item.type === "summary";
}

function unknownShapeKey(item: RolloutLineItem, lineIndex: number): string {
  const type = typeof item.type === "string" && item.type !== "" ? item.type : "none";
  // Bounded key for sticky health; line index is for logs only (not in key).
  void lineIndex;
  return `unknown_shape:type=${type}`;
}

/**
 * Interpret one rollout line once → ordered events + lifecycle signals.
 *
 * On a completing assistant line: sampling_observed (final) before turn_settled.
 */
export function observeRolloutLine(
  item: RolloutLineItem,
  lineIndex = 0,
  options: ObserveLineOptions = {},
): ObserveLineResult {
  const lifecycle: LifecycleSignal[] = [];
  const generation = options.generation ?? 1;
  const samplingDedupe = options.samplingDedupe ?? createSamplingDedupeState();

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
      return { events: [], lifecycle, stats: emptyStats() };
    }
  }

  const suppressRuntime = options.suppressRuntimeLifecycle === true;

  if (!suppressRuntime && isNativeSummary(item)) {
    const summary = typeof item.summary === "string" ? item.summary : undefined;
    lifecycle.push({
      kind: "native_compact_observed",
      ...(summary !== undefined ? { summaryPreview: summary.slice(0, 120) } : {}),
    });
  }

  const mapped = mapRolloutLine(item, lineIndex);
  const stats = asMapStats(mapped.stats);
  const events = mapped.events;

  // Sampling fold: accumulate on every assistant line; emit once when complete.
  // Prefix validation must not mutate live sampling state.
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
      const claim = completeSamplingAttempt(samplingDedupe, samplingId, model, usage);
      if (claim.action === "emit") {
        lifecycle.push({
          kind: "sampling_observed",
          samplingId: claim.samplingId,
          ...(claim.model !== undefined ? { model: claim.model } : {}),
          ...(claim.providerUsage !== undefined ? { providerUsage: claim.providerUsage } : {}),
        });
      }
    } else if (usage !== undefined || model !== undefined) {
      noteSamplingPartial(samplingDedupe, samplingId, model, usage);
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
          lifecycle.push({ kind: "turn_settled", reason: turnSettleReason(item) });
        }
      }
    } else {
      // Stateless single-line observe (tests / callers without a fold): emit
      // only user opening edges and close assertions that are content-terminal.
      if (signal === "opens" && isUserLine(item)) {
        lifecycle.push({ kind: "turn_opened", reason: turnOpenReason(item) });
      } else if (signal === "closes") {
        lifecycle.push({ kind: "turn_settled", reason: turnSettleReason(item) });
      }
    }
  }

  let unknownShape = false;
  if (stats.unknown > 0) {
    unknownShape = true;
    lifecycle.push({
      kind: "capture_degraded",
      reason: unknownShapeKey(item, lineIndex),
      generation,
    });
  }

  return { events, lifecycle, stats, ...(unknownShape ? { unknownShape: true } : {}) };
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
  const stats = emptyStats();
  // Share sampling + turn fold across the batch (same as live session fold).
  const samplingDedupe = options.samplingDedupe ?? createSamplingDedupeState();
  const turnFold = options.turnFold ?? createTurnFoldState();
  const opts = { ...options, samplingDedupe, turnFold };
  for (const [lineIndex, item] of items.entries()) {
    const observed = observeRolloutLine(item, lineIndex, opts);
    events.push(...observed.events);
    lifecycle.push(...observed.lifecycle);
    stats.sidechain += observed.stats.sidechain;
    stats.unknown += observed.stats.unknown;
    stats.meta += observed.stats.meta;
    stats.image += observed.stats.image;
  }
  return { events, lifecycle, stats };
}
