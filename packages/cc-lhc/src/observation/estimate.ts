/**
 * Host-side post-measurement estimate helpers (LIM-64 production path).
 *
 * Predicted next-request growth after an authoritative provider measurement:
 * - Prefer provider-reported `output_tokens` for the completed response.
 * - Otherwise estimate from canonical captured payload UTF-8 bytes (~4 bytes/token).
 * - Subsequent tool results / assistant / user / runtime content add the same
 *   host-byte estimate. Sidechains, synthetic resume chrome, meta, and suppressed
 *   rebuilt prefixes never contribute.
 *
 * Limitations of bytes/4: it is a host heuristic, not provider billing usage.
 * Labels keep that domain explicit (`source_labelled_estimate`).
 */

import type { MessageEventInput } from "lhc";
import { estimateTokensFromCapturedBytes } from "../governor/provider-context.js";
import type { PostMeasurementEstimate } from "../governor/types.js";

export const PROVIDER_OUTPUT_ESTIMATE_SOURCE = "provider_reported_output_tokens";
export const HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE = "host_canonical_payload_byte_estimate";
export const MIXED_POST_MEASUREMENT_ESTIMATE_SOURCE = "provider_output_plus_host_canonical_payload_byte_estimate";

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

/**
 * Merge estimate source labels when accumulating mixed provider-output and host-byte deltas.
 */
export function mergeEstimateSource(previousSource: string, nextSource: string, previousTokens: number): string {
  if (previousTokens <= 0 || previousSource.trim() === "") return nextSource;
  if (previousSource === nextSource) return previousSource;
  if (
    (previousSource === PROVIDER_OUTPUT_ESTIMATE_SOURCE || previousSource === MIXED_POST_MEASUREMENT_ESTIMATE_SOURCE) &&
    (nextSource === HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE ||
      nextSource === MIXED_POST_MEASUREMENT_ESTIMATE_SOURCE)
  ) {
    return MIXED_POST_MEASUREMENT_ESTIMATE_SOURCE;
  }
  if (
    (nextSource === PROVIDER_OUTPUT_ESTIMATE_SOURCE || nextSource === MIXED_POST_MEASUREMENT_ESTIMATE_SOURCE) &&
    (previousSource === HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE ||
      previousSource === MIXED_POST_MEASUREMENT_ESTIMATE_SOURCE)
  ) {
    return MIXED_POST_MEASUREMENT_ESTIMATE_SOURCE;
  }
  return MIXED_POST_MEASUREMENT_ESTIMATE_SOURCE;
}
