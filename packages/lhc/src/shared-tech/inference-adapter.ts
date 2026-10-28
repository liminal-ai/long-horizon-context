import { safeCall } from "./classify.js";
import type { InferenceCallbacks, InferenceRequestMessage, InferenceResult } from "./derivation.js";
import type { ModelAssignment, ModelCallFailureKind, ResolvedInferenceConfig } from "./inference-types.js";
import { PROMPT_REGISTRY, type PromptTemplate } from "./prompts/index.js";

function boundContent(content: string, maxInputChars: number): string {
  if (content.length <= maxInputChars) return content;
  const marker = `\n\n[... truncated: tool result was ${String(content.length)} chars; head and tail retained ...]\n\n`;
  if (marker.length > maxInputChars) return content.slice(0, maxInputChars);
  const keep = maxInputChars - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return content.slice(0, head) + marker + (tail > 0 ? content.slice(content.length - tail) : "");
}

function inferenceFailure(
  kind: ModelCallFailureKind,
  message: string,
  requestMessages?: InferenceRequestMessage[],
): InferenceResult {
  const detail = message === "" ? kind : `${kind}: ${message}`;
  const reason = kind === "auth" || kind === "invalid_request" ? detail : `provider_failure: ${detail}`;
  return {
    ok: false,
    reason,
    ...(requestMessages !== undefined ? { requestMessages } : {}),
  };
}

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

function withTargetRatios(input: unknown, assignment: ModelAssignment): unknown {
  const ratios = targetRatiosOf(assignment);
  if (typeof input !== "object" || input === null) return input;
  return { ...(input as Record<string, unknown>), ...ratios };
}

export function createInferenceCallbacks(config: ResolvedInferenceConfig): InferenceCallbacks {
  const callKind = async (kind: string, input: unknown): Promise<InferenceResult> => {
    const assignment = config.assignments[kind];
    if (assignment === undefined) {
      return inferenceFailure("invalid_request", `no assignment for derivation type "${kind}"`);
    }
    const template = PROMPT_REGISTRY[assignment.prompt] as PromptTemplate<unknown> | undefined;
    if (template === undefined) {
      return inferenceFailure("invalid_request", `prompt template "${assignment.prompt}" not in registry`);
    }
    const messages = template.render(withTargetRatios(input, assignment));
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
      return inferenceFailure(result.kind, result.message, messages);
    }
    const text = result.text.trim();
    if (text === "") {
      return inferenceFailure("empty_output", "model returned empty or whitespace-only text", messages);
    }
    return {
      ok: true,
      text,
      provenance: {
        provider: result.actualProvider ?? assignment.provider,
        model: result.actualModel ?? assignment.model,
        prompt: assignment.prompt,
      },
      requestMessages: messages,
      rawResponse: result.text,
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
    compressDetailedTurn: (i) => callKind("detailed_turn_compression", i),
    summarizeChunkBrief: (i) => callKind("chunk_summary_brief", i),
  };
}
