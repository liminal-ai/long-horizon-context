// createInferenceCallbacks returns the same InferenceCallbacks interface direct
// injection implements, so initLhc and everything below it sees callback
// operations. Every operation follows the same pipeline: bound input where
// needed, render the kind's prompt template into single-turn messages, call the
// host ModelCall with the kind's assignment, reject empty or whitespace-only
// text as empty_output, and return shaped text with config-known provenance.
// The adapter never parses model text for outcomes, receipts, or any mechanical
// fact; those stay handler-authored from the record. Host containment lives in
// safeCall.

import { FAILURE_CLASSIFICATION, safeCall } from "./classify.js";
import type { InferenceCallbacks, InferenceResult } from "./derivation.js";
import type { ModelAssignment, ModelCallFailureKind, ResolvedInferenceConfig } from "./inference-types.js";
import { PROMPT_REGISTRY, type PromptTemplate } from "./prompts/index.js";

// A pathological tool result must not blow a small-context model. Content over
// the bound keeps its head and tail around a marker, and the bounded whole
// stays within maxInputChars; bounding happens before prompt rendering, so the
// dropped middle never crosses the boundary.
function boundContent(content: string, maxInputChars: number): string {
  if (content.length <= maxInputChars) return content;
  const marker = `\n\n[... truncated: tool result was ${String(content.length)} chars; head and tail retained ...]\n\n`;
  // The marker only earns its place when head + marker + tail still fits the
  // bound. When maxInputChars is smaller than the marker itself, there is no
  // budget for the marker — emitting it would be the one path that crosses the
  // configured boundary exists to hold, so degrade to a plain head truncation
  // that honors the cap exactly.
  if (marker.length > maxInputChars) return content.slice(0, maxInputChars);
  const keep = maxInputChars - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return content.slice(0, head) + marker + (tail > 0 ? content.slice(content.length - tail) : "");
}

// Failure mapping: the queue consumes `retryable` exactly as it always has, and
// the reason string is machine-readable by the established
// code-before-first-colon convention. Retryable failures lead with
// `provider_failure`, the code exhausted derivations already use; terminal
// kinds lead with the kind itself and land failed immediately.
function classifiedFailure(kind: ModelCallFailureKind, message: string): InferenceResult {
  const { retryable } = FAILURE_CLASSIFICATION[kind];
  const detail = message === "" ? kind : `${kind}: ${message}`;
  return {
    ok: false,
    retryable,
    reason: retryable ? `provider_failure: ${detail}` : detail,
  };
}

// Target ratios carried on an assignment, extracted as a plain object so the
// adapter can merge them into a prompt's render input. Exported so tests pin
// the extraction directly; the adapter uses it at the call-build site below,
// making the ratios reachable by the rendering path. Token targets are computed
// by the owning handler.
export function targetRatiosOf(
  assignment: ModelAssignment | undefined,
): Partial<Pick<ModelAssignment, "targetMinRatio" | "targetMaxRatio" | "targetAimRatio">> {
  if (assignment === undefined) return {};
  return {
    ...(assignment.targetMinRatio !== undefined ? { targetMinRatio: assignment.targetMinRatio } : {}),
    ...(assignment.targetMaxRatio !== undefined ? { targetMaxRatio: assignment.targetMaxRatio } : {}),
    ...(assignment.targetAimRatio !== undefined ? { targetAimRatio: assignment.targetAimRatio } : {}),
  };
}

// Merge an assignment's target ratios into a prompt's render input. The input
// is unknown at this registry boundary; ratios attach only when the input is an
// object, leaving non-object inputs untouched.
function withTargetRatios(input: unknown, assignment: ModelAssignment): unknown {
  const ratios = targetRatiosOf(assignment);
  if (typeof input !== "object" || input === null) return input;
  return { ...(input as Record<string, unknown>), ...ratios };
}

export function createInferenceCallbacks(config: ResolvedInferenceConfig): InferenceCallbacks {
  const callKind = async (kind: string, input: unknown): Promise<InferenceResult> => {
    const assignment = config.assignments[kind];
    if (assignment === undefined) {
      return classifiedFailure("invalid_request", `no assignment for derivation type "${kind}"`);
    }
    // Construction validated the name; a miss here is registry drift after
    // construction and is terminal, never retried into.
    const template = PROMPT_REGISTRY[assignment.prompt] as PromptTemplate<unknown> | undefined;
    if (template === undefined) {
      return classifiedFailure("invalid_request", `prompt template "${assignment.prompt}" not in registry`);
    }
    const messages = template.render(withTargetRatios(input, assignment));
    // safeCall contains the host: thrown exceptions arrive as structured
    // `other` failures and a hung function loses the timeout race as `timeout`;
    // both flow through the same classification below.
    const result = await safeCall(
      config.call,
      {
        provider: assignment.provider,
        model: assignment.model,
        messages,
        ...(assignment.thinking !== undefined ? { thinking: assignment.thinking } : {}),
      },
      config.timeoutMs,
    );
    if (!result.ok) {
      return classifiedFailure(result.kind, result.message);
    }
    // Shaping: surrounding whitespace never becomes derivation content — and a
    // model that returned nothing but whitespace has not produced a
    // derivation: a classified retryable failure, never a ready derivation.
    // `empty_output` is adapter-generated; hosts never return it.
    const text = result.text.trim();
    if (text === "") {
      return classifiedFailure("empty_output", "model returned empty or whitespace-only text");
    }
    // Provenance is the assignment's three config-known strings, copied, never
    // authored from model output.
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
        operationClass: i.operationClass ?? "unknown",
        responseShape: i.responseShape ?? "unknown_content",
        promptMode: i.promptMode ?? "generic_summary",
        facts: i.facts ?? {},
      }),
    compressSmoothTurn: (i) => callKind("smooth_turn_compression", i),
    summarizeChunkBrief: (i) => callKind("chunk_summary_brief", i),
  };
}
