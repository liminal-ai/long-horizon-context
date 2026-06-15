// The real provider (DD-2): createInferenceProvider returns the same
// DerivationProvider interface the deterministic provider implements, so
// createSdk and everything below it see a provider, full stop. Every
// operation is the same five-step pipeline (Flow 2): bound the input where
// DD-7 applies, render the kind's prompt template into single-turn messages,
// call the host ModelCall with the kind's assignment, reject empty or
// whitespace-only text as empty_output (AC-2.4), and return the shaped text
// with config-known provenance (AC-2.5). The adapter never parses model text
// for outcomes, receipts, or any mechanical fact — those stay
// handler-authored from the record. Host containment (thrown exceptions,
// the adapter-owned timeout) lives in safeCall (AC-3.3, DD-6).
import type {
  DerivationProvider,
  DerivationType,
  ProviderResult,
} from "../shared/derivation.js";
import { FAILURE_CLASSIFICATION, safeCall } from "./classify.js";
import { PROMPT_REGISTRY, type PromptTemplate } from "./prompts/index.js";
import type { ModelCallFailureKind, ResolvedInferenceConfig } from "./types.js";

// DD-7: a pathological tool result must not blow a small-context model.
// Content over the bound keeps its head and tail around a marker, and the
// bounded whole stays within maxInputChars; bounding happens before prompt
// rendering, so the dropped middle never crosses the boundary.
function boundContent(content: string, maxInputChars: number): string {
  if (content.length <= maxInputChars) return content;
  const marker = `\n\n[... truncated: tool result was ${String(content.length)} chars; head and tail retained ...]\n\n`;
  // The marker only earns its place when head + marker + tail still fits the
  // bound. When maxInputChars is smaller than the marker itself, there is no
  // budget for the marker — emitting it would be the one path that crosses the
  // boundary DD-7 exists to hold — so degrade to a plain head truncation that
  // honors the cap exactly.
  if (marker.length > maxInputChars) return content.slice(0, maxInputChars);
  const keep = maxInputChars - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return content.slice(0, head) + marker + (tail > 0 ? content.slice(content.length - tail) : "");
}

// Failure mapping (DD-3): the queue consumes `retryable` exactly as it always
// has, and the reason string is machine-readable by the established
// code-before-first-colon convention. Retryable failures lead with
// `provider_failure` — the code Epic 02 has always landed on exhausted forms
// (the queue copies the provider's reason verbatim at exhaustion, AC-3.2) —
// with the failure kind named next; terminal kinds lead with the kind itself
// and land failed immediately.
function classifiedFailure(kind: ModelCallFailureKind, message: string): ProviderResult {
  const { retryable } = FAILURE_CLASSIFICATION[kind];
  const detail = message === "" ? kind : `${kind}: ${message}`;
  return {
    ok: false,
    retryable,
    reason: retryable ? `provider_failure: ${detail}` : detail,
  };
}

export function createInferenceProvider(config: ResolvedInferenceConfig): DerivationProvider {
  const callKind = async (kind: DerivationType, input: unknown): Promise<ProviderResult> => {
    const assignment = config.assignments[kind];
    // Construction validated the name (AC-1.3); a miss here is registry
    // drift after construction and is terminal, never retried into.
    const template = PROMPT_REGISTRY[assignment.prompt] as PromptTemplate<unknown> | undefined;
    if (template === undefined) {
      return classifiedFailure(
        "invalid_request",
        `prompt template "${assignment.prompt}" not in registry`,
      );
    }
    const messages = template.render(input);
    // safeCall contains the host (AC-3.3, DD-6): thrown exceptions arrive as
    // structured `other` failures and a hung function loses the timeout race
    // as `timeout` — both flow through the same classification below.
    const result = await safeCall(
      config.call,
      { provider: assignment.provider, model: assignment.model, messages },
      config.timeoutMs,
    );
    if (!result.ok) {
      return classifiedFailure(result.kind, result.message);
    }
    // Shaping: surrounding whitespace never becomes form content — and a
    // model that returned nothing but whitespace has not produced a
    // derivation (AC-2.4): a classified retryable failure, never a ready
    // form. `empty_output` is adapter-generated; hosts never return it.
    const text = result.text.trim();
    if (text === "") {
      return classifiedFailure("empty_output", "model returned empty or whitespace-only text");
    }
    // Provenance is the assignment's three config-known strings, copied —
    // never authored from model output (DD-4).
    return {
      ok: true,
      text,
      provenance: {
        provider: assignment.provider,
        model: assignment.model,
        prompt: assignment.prompt,
      },
    };
  };

  return {
    smoothPrompt: (i) => callKind("smoothed_prompt", i),
    summarizeToolResult: (i) =>
      callKind("tool_result_summary", {
        toolName: i.toolName,
        content: boundContent(i.content, config.maxInputChars),
        outcome: i.outcome ?? "unknown",
        targetTokens: i.targetTokens ?? 150,
        guidance:
          i.guidance ??
          "Preserve the status, concrete identifiers, counts, paths, and any error text or result items needed to continue.",
      }),
    composeTurnRendering: (i) => callKind("turn_rendering", i),
    projectLowerBand: (i) => callKind("lower_band_projection", i),
    summarizeChunkDetailed: (i) => callKind("chunk_summary_detailed", i),
    summarizeChunkBrief: (i) => callKind("chunk_summary_brief", i),
  };
}
