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

export const USER_PROMPT_ESTIMATE_SOURCE = userPromptEstimateSource(defaultSessionTokenFamily().family);
export const PENDING_PROMPT_ESTIMATE_SOURCE = pendingPromptEstimateSource(defaultSessionTokenFamily().family);

export interface PostMeasurementEstimateFold {
  hasAuthoritativeSampling: boolean;
  pendingAssistantPayloadBytes: number;
}

export function createPostMeasurementEstimateFold(): PostMeasurementEstimateFold {
  return {
    hasAuthoritativeSampling: false,
    pendingAssistantPayloadBytes: 0,
  };
}

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

export function pendingPromptEstimate(promptText: string, estimator?: TokenEstimator): PostMeasurementEstimate {
  const used = estimatorOf(estimator);
  return lhcTextEstimate(promptText, pendingPromptEstimateSource(used.family), used);
}

export function estimateAcceptedEvent(event: MessageEventInput, estimator?: TokenEstimator): PostMeasurementEstimate {
  if (event.eventKind === "user_prompt") {
    const used = estimatorOf(estimator);
    return lhcTextEstimate(event.payload.text, userPromptEstimateSource(used.family), used);
  }
  return hostEstimateFromCanonicalBytes(canonicalPayloadBytes(event));
}

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
