// The real provider (DD-2): createInferenceProvider returns the same
// DerivationProvider interface the deterministic provider implements, so
// createSdk and everything below it see a provider, full stop. Each operation
// is one closure lookup at call time — the kind's assignment names the
// provider/model routing keys and the prompt template; the host's ModelCall
// is the only code that crosses the transport boundary (AC-1.2, AC-1.4).
// Output shaping (empty-output rejection, input bounding) and the safeCall
// timeout land with the adapter/classification stories; routing and result
// mapping are complete here.
import type {
  DerivationProvider,
  FormKind,
  ProviderResult,
} from "../shared/derivation.js";
import { FAILURE_CLASSIFICATION } from "./classify.js";
import { PROMPT_REGISTRY, type PromptTemplate } from "./prompts/index.js";
import type { ModelCallResult, ResolvedInferenceConfig } from "./types.js";

export function createInferenceProvider(config: ResolvedInferenceConfig): DerivationProvider {
  const callKind = async (kind: FormKind, input: unknown): Promise<ProviderResult> => {
    const assignment = config.assignments[kind];
    // Construction validated the name (AC-1.3); a miss here is registry
    // drift after construction and is terminal, never retried into.
    const template = PROMPT_REGISTRY[assignment.prompt] as PromptTemplate<unknown> | undefined;
    if (template === undefined) {
      return {
        ok: false,
        retryable: false,
        reason: `invalid_request: prompt template "${assignment.prompt}" not in registry`,
      };
    }
    const messages = template.render(input);
    let result: ModelCallResult;
    try {
      result = await config.call({
        provider: assignment.provider,
        model: assignment.model,
        messages,
      });
    } catch (cause) {
      // Thrown host exceptions classify as `other` (AC-3.3); the structured
      // safeCall wrapper (timeout race, DD-6) supersedes this containment in
      // the classification story.
      result = { ok: false, kind: "other", message: String(cause) };
    }
    if (!result.ok) {
      return {
        ok: false,
        retryable: FAILURE_CLASSIFICATION[result.kind].retryable,
        // The kind string leads the reason — stable and machine-readable
        // (DD-3) — with the host's message carried for the audit trail.
        reason: result.message === "" ? result.kind : `${result.kind}: ${result.message}`,
      };
    }
    // Provenance is the assignment's three config-known strings, copied —
    // never authored from model output (DD-4).
    return {
      ok: true,
      text: result.text,
      provenance: {
        provider: assignment.provider,
        model: assignment.model,
        prompt: assignment.prompt,
      },
    };
  };

  return {
    smoothPrompt: (i) => callKind("smoothed_prompt", i),
    summarizeToolCall: (i) => callKind("tool_call_summary", i),
    summarizeToolResult: (i) => callKind("tool_result_summary", i),
    composeTurnRendering: (i) => callKind("turn_rendering", i),
    projectLowerBand: (i) => callKind("lower_band_projection", i),
    summarizeChunkDetailed: (i) => callKind("chunk_summary_detailed", i),
    summarizeChunkBrief: (i) => callKind("chunk_summary_brief", i),
  };
}
