/**
 * Host-side post-measurement estimate helpers (LIM-64 production path).
 *
 * Predicted next-request growth after an authoritative provider measurement:
 * - Prefer provider-reported `output_tokens` for the completed response.
 * - Otherwise estimate from canonical captured payload UTF-8 bytes (~4 bytes/token).
 * - Subsequent tool results / assistant / runtime content add the same host-byte
 *   estimate. Accepted user_prompt text uses the session TokenEstimator.
 *   Sidechains, synthetic resume chrome, meta, and suppressed rebuilt prefixes
 *   never contribute.
 *
 * Limitations of bytes/4: it is a host heuristic, not provider billing usage.
 * Labels keep that domain explicit (`source_labelled_estimate`).
 */

import { type MessageEventInput, TOKEN_ESTIMATOR_ID, type TokenEstimator } from "lhc";
import { estimateTokensFromCapturedBytes } from "../governor/provider-context.js";
import type { PostMeasurementEstimate } from "../governor/types.js";
import { defaultSessionTokenFamily, sessionDefaultEstimator } from "./token-family.js";

export const PROVIDER_OUTPUT_ESTIMATE_SOURCE = "provider_reported_output_tokens";
export const HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE = "host_canonical_payload_byte_estimate";
export const MIXED_POST_MEASUREMENT_ESTIMATE_SOURCE = "provider_output_plus_host_canonical_payload_byte_estimate";

export function userPromptEstimateSource(family: string): string {
  return `user_prompt:${TOKEN_ESTIMATOR_ID}:${family}`;
}

export function pendingPromptEstimateSource(family: string): string {
  return `pending_prompt:${TOKEN_ESTIMATOR_ID}:${family}`;
}

/** Default-family labels for tests and compose ranking of the launch fallback. */
export const USER_PROMPT_ESTIMATE_SOURCE = userPromptEstimateSource(defaultSessionTokenFamily().family);
export const PENDING_PROMPT_ESTIMATE_SOURCE = pendingPromptEstimateSource(defaultSessionTokenFamily().family);

/** Fold state shared across observe lines for one capture generation. */
export interface PostMeasurementEstimateFold {
  /**
   * True after a completed sampling_observed in the current live suffix.
   * Content before the first completed sampling of a generation is not post-measurement.
   */
  hasAuthoritativeSampling: boolean;
  /**
   * Canonical payload bytes for the in-flight assistant sampling attempt
   * (split thinking/text/tool lines before completion).
   */
  pendingAssistantPayloadBytes: number;
}

export function createPostMeasurementEstimateFold(): PostMeasurementEstimateFold {
  return {
    hasAuthoritativeSampling: false,
    pendingAssistantPayloadBytes: 0,
  };
}

/** Safe non-negative integer, or null when missing/invalid. */
export function readProviderOutputTokens(usage: Record<string, unknown> | null | undefined): number | null {
  if (usage === null || usage === undefined || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  for (const key of ["output_tokens", "outputTokens"] as const) {
    if (!Object.hasOwn(usage, key)) continue;
    const raw = usage[key];
    if (typeof raw !== "number") return null;
    if (!Number.isFinite(raw) || !Number.isSafeInteger(raw) || raw < 0) return null;
    return raw;
  }
  return null;
}

/**
 * Canonical payload bytes that can grow the next provider request.
 * Measures only conversational payload fields — not event chrome or ids.
 */
export function canonicalPayloadBytes(event: MessageEventInput): number {
  switch (event.eventKind) {
    case "user_prompt":
    case "assistant_text":
    case "assistant_thinking":
    case "runtime_note": {
      const text = event.payload.text;
      return typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0;
    }
    case "tool_result": {
      const content = event.payload.content;
      return typeof content === "string" ? Buffer.byteLength(content, "utf8") : 0;
    }
    case "tool_call": {
      const name = typeof event.payload.toolName === "string" ? event.payload.toolName : "";
      let argsBytes = 0;
      try {
        argsBytes = Buffer.byteLength(JSON.stringify(event.payload.arguments ?? {}), "utf8");
      } catch {
        argsBytes = 0;
      }
      return Buffer.byteLength(name, "utf8") + argsBytes;
    }
    default:
      // model_change, thinking_level_change, turn_end, compact markers: not counted
      return 0;
  }
}

export function totalCanonicalPayloadBytes(events: readonly MessageEventInput[]): number {
  let total = 0;
  for (const event of events) {
    total += canonicalPayloadBytes(event);
  }
  return total;
}

export function hostEstimateFromCanonicalBytes(bytes: number): PostMeasurementEstimate {
  return estimateTokensFromCapturedBytes(bytes, HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE);
}

export function hostEstimateFromCanonicalEvents(events: readonly MessageEventInput[]): PostMeasurementEstimate {
  return hostEstimateFromCanonicalBytes(totalCanonicalPayloadBytes(events));
}

function estimateSourceRank(label: string): number {
  if (label === PROVIDER_OUTPUT_ESTIMATE_SOURCE) return 0;
  if (label === HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE) return 1;
  if (label.startsWith("user_prompt:")) return 2;
  if (label.startsWith("pending_prompt:")) return 3;
  return 4;
}

function atomicEstimateSources(source: string): string[] {
  const atoms: string[] = [];
  for (const raw of source.split("+")) {
    const part = raw.trim();
    if (part === "") continue;
    if (part === MIXED_POST_MEASUREMENT_ESTIMATE_SOURCE) {
      atoms.push(PROVIDER_OUTPUT_ESTIMATE_SOURCE, HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE);
      continue;
    }
    atoms.push(part);
  }
  return atoms;
}

/** Stable unique join of estimator labels. Provider+host alone keeps the historical mixed name. */
export function composeEstimateSources(sources: readonly string[]): string {
  const unique = new Set<string>();
  for (const source of sources) {
    for (const atom of atomicEstimateSources(source)) unique.add(atom);
  }
  const labels = [...unique];
  if (labels.length === 0) return HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE;
  if (labels.length === 1) return labels[0]!;
  const onlyProviderAndHost =
    labels.length === 2 &&
    unique.has(PROVIDER_OUTPUT_ESTIMATE_SOURCE) &&
    unique.has(HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE);
  if (onlyProviderAndHost) return MIXED_POST_MEASUREMENT_ESTIMATE_SOURCE;
  const rank = estimateSourceRank;
  return labels
    .sort((left, right) => {
      const order = rank(left) - rank(right);
      return order !== 0 ? order : left.localeCompare(right);
    })
    .join("+");
}

/**
 * Merge estimate source labels when accumulating mixed deltas.
 * Unlike sources compose and dedupe; the provider+host mixed name is used only
 * when provider-reported output is actually one of the atoms.
 */
export function mergeEstimateSource(previousSource: string, nextSource: string, previousTokens: number): string {
  if (previousTokens <= 0 || previousSource.trim() === "") return nextSource;
  if (previousSource === nextSource) return previousSource;
  return composeEstimateSources([previousSource, nextSource]);
}

function lhcTextEstimate(text: string, source: string, estimator: TokenEstimator): PostMeasurementEstimate {
  const tokens = estimator.estimate(text);
  const safe = Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : 0;
  return {
    tokens: safe,
    source,
    domain: "source_labelled_estimate",
  };
}

function estimatorOf(estimator: TokenEstimator | undefined): TokenEstimator {
  return estimator ?? sessionDefaultEstimator();
}

/**
 * Size of the prompt an invocation is about to send, before it is sent.
 *
 * One-shot pre-launch uses the session TokenEstimator. The source label names
 * that estimator and family so the figure is never read as provider usage or
 * as the captured-content bytes/4 heuristic. This value is ephemeral at the
 * seam and is not stored; accepted user_prompt events account for the same
 * text separately after intake.
 */
export function pendingPromptEstimate(promptText: string, estimator?: TokenEstimator): PostMeasurementEstimate {
  const used = estimatorOf(estimator);
  return lhcTextEstimate(promptText, pendingPromptEstimateSource(used.family), used);
}

/** Per-event post-measurement contribution for accepted canonical intake. */
export function estimateAcceptedEvent(event: MessageEventInput, estimator?: TokenEstimator): PostMeasurementEstimate {
  if (event.eventKind === "user_prompt") {
    const used = estimatorOf(estimator);
    return lhcTextEstimate(event.payload.text, userPromptEstimateSource(used.family), used);
  }
  return hostEstimateFromCanonicalBytes(canonicalPayloadBytes(event));
}

/**
 * Shared add used by immediate observe and deferred post-dedupe accepted events.
 * User prompts use the session TokenEstimator; assistant/tool/runtime stay bytes/4.
 */
export function postMeasurementEstimateFromEvents(
  events: readonly MessageEventInput[],
  estimator?: TokenEstimator,
): PostMeasurementEstimate {
  let tokens = 0;
  let source = HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE;
  let any = false;
  for (const event of events) {
    const part = estimateAcceptedEvent(event, estimator);
    if (part.tokens <= 0) continue;
    source = any ? mergeEstimateSource(source, part.source, tokens) : part.source;
    any = true;
    const next = tokens + part.tokens;
    tokens = Number.isSafeInteger(next) ? next : tokens;
  }
  if (!any) {
    return {
      tokens: 0,
      source: HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE,
      domain: "source_labelled_estimate",
    };
  }
  return { tokens, source, domain: "source_labelled_estimate" };
}

/**
 * Everything the next request carries that no provider measurement covers:
 * content captured after the last reading, plus the prompt about to be sent.
 * This is the estimate half of one-shot pre-launch pressure; the provider base
 * is the last authoritative reading from the persisted transcript.
 */
export function preLaunchEstimate(
  capturedGrowth: PostMeasurementEstimate,
  promptText: string,
  estimator?: TokenEstimator,
): PostMeasurementEstimate {
  const prompt = pendingPromptEstimate(promptText, estimator);
  const parts = [capturedGrowth, prompt].filter((part) => part.tokens > 0);
  return {
    tokens: capturedGrowth.tokens + prompt.tokens,
    source:
      parts.length === 0
        ? pendingPromptEstimateSource(estimatorOf(estimator).family)
        : parts.map((part) => part.source).join("+"),
    domain: "source_labelled_estimate",
  };
}
