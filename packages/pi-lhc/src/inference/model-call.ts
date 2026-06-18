// AC-4.1..4.4. The host-supplied ModelCall function.
//
// Resolves (provider,model) via ctx.modelRegistry.find, completes through
// a production-valid boundary, and classifies failures into the LHC contract.
// Provider/model are opaque routing keys — the connector does not interpret them.
//
// PRODUCTION BOUNDARY: the function validates provider/model through PI's
// registry and completes through @earendil-works/pi-ai when that package is
// available in the host runtime. If the runtime does not provide pi-ai, the host
// returns a classified failure; it never fabricates completion text.
//
// Spec Deviation: Local pi-ai types in pi-ai.ts instead of importing from
// @earendil-works/pi-ai (package not yet available).

import {
  DEFAULT_PROMPT_NAMES,
  type ModelAssignment,
  type ModelCall,
  type ModelCallFailureKind,
  type ModelCallResult,
} from "lhc";
import type { ExtensionContext, ModelHandle } from "../pi/types.js";
import type { PiAiComplete } from "./pi-ai.js";

interface ModelCallDeps {
  complete?: PiAiComplete;
}

/** Extract the text content from an AssistantMessage-like shape. */
function extractAssistantText(message: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
  const content = message.content ?? [];
  const textParts = content.filter((part) => part.type === "text" && part.text !== undefined);
  return textParts.map((part) => part.text as string).join("\n");
}

/** Pure mapping of a PI/pi-ai failure shape to a ModelCallFailureKind
 *  (terminal: auth, invalid_request; retryable: rate_limit, timeout, network;
 *  thrown → other). */
export function classifyFailure(err: unknown): ModelCallFailureKind {
  // Guard: non-object errors fall through to "other"
  if (typeof err !== "object" || err === null) {
    return "other";
  }

  const errorLike = err as Partial<{ code?: string; type?: string; message?: string } & Error>;
  const code = errorLike.code?.toLowerCase() ?? "";
  const type = errorLike.type?.toLowerCase() ?? "";
  const message = errorLike.message?.toLowerCase() ?? "";

  // Check for auth failures (terminal)
  const authPatterns = ["auth", "unauthorized", "401", "authentication"];
  if (authPatterns.some((p) => code.includes(p) || type.includes(p) || message.includes(p))) {
    return "auth";
  }

  // Check for invalid request (terminal)
  const invalidPatterns = ["invalid", "400", "bad"];
  if (invalidPatterns.some((p) => code.includes(p) || type.includes(p) || message.includes(p))) {
    return "invalid_request";
  }

  // Check for rate limit (retryable)
  const rateLimitPatterns = ["rate", "429"];
  if (rateLimitPatterns.some((p) => code.includes(p) || type.includes(p) || message.includes(p))) {
    return "rate_limit";
  }

  // Check for timeout (retryable)
  const timeoutPatterns = ["timeout", "timed", "408"];
  if (timeoutPatterns.some((p) => code.includes(p) || type.includes(p) || message.includes(p))) {
    return "timeout";
  }

  // Check for network errors (retryable)
  const networkPatterns = ["network", "connection", "econnrefused", "enotfound", "fetch"];
  if (networkPatterns.some((p) => code.includes(p) || type.includes(p) || message.includes(p))) {
    return "network";
  }

  // Default for unknown errors
  return "other";
}

async function importPiAiComplete(): Promise<PiAiComplete> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<unknown>;
  const loaded = await dynamicImport("@earendil-works/pi-ai");
  const complete = (loaded as { complete?: unknown }).complete;
  if (typeof complete !== "function") {
    throw Object.assign(new Error("@earendil-works/pi-ai does not export complete()"), {
      code: "invalid_request",
    });
  }
  return complete as PiAiComplete;
}

/**
 * Production ModelCall implementation using PI's model registry and pi-ai.
 *
 * Resolves (provider, model) through ctx.modelRegistry.find(), validates
 * auth with hasConfiguredAuth(), and completes through @earendil-works/pi-ai
 * when the host runtime provides it.
 */
export function createModelCall(ctx: ExtensionContext, deps: ModelCallDeps = {}): ModelCall {
  return async ({ provider, model, messages }): Promise<ModelCallResult> => {
    // Resolve the model through PI's registry
    const resolved = ctx.modelRegistry.find(provider, model);
    if (resolved === undefined) {
      // Unknown model - treat as invalid request (terminal)
      return {
        ok: false,
        kind: "invalid_request",
        message: `Model not found in registry: ${provider}/${model}`,
      };
    }

    // Check if auth is configured
    if (!ctx.modelRegistry.hasConfiguredAuth(resolved)) {
      // No auth - treat as auth failure (terminal)
      return {
        ok: false,
        kind: "auth",
        message: `No configured auth for model: ${provider}/${model}`,
      };
    }

    // Complete through pi-ai. Tests may inject this seam; production loads the
    // host package at runtime so pi-lhc does not publish fabricated text when
    // the host dependency is absent.
    try {
      const complete = deps.complete ?? await importPiAiComplete();
      const response = await complete(resolved, { messages });

      // Extract text from the response
      const text = extractAssistantText(response);

      // NOTE: We do NOT check for empty text here. AC-4.4 specifies that
      // empty_output is classified by LHC's adapter, not by the host function.
      // The host function returns text-or-failure only, even if the text is empty.
      return { ok: true, text };
    } catch (err) {
      // Classify the error into a ModelCallFailureKind
      const kind = classifyFailure(err);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind, message };
    }
  };
}

export const ASSIGNMENT_KINDS = [
  "smoothed_prompt",
  "tool_result_summary",
  "smooth_turn_compression",
  "chunk_summary_brief",
] as const;

export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

export const DEFAULT_ASSIGNMENT_PROMPTS: Record<AssignmentKind, string> = {
  smoothed_prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt ?? "smoothing-v1",
  tool_result_summary: DEFAULT_PROMPT_NAMES.tool_result_summary ?? "tool-result-v1",
  smooth_turn_compression: DEFAULT_PROMPT_NAMES.smooth_turn_compression ?? "lower-band-v1",
  chunk_summary_brief: DEFAULT_PROMPT_NAMES.chunk_summary_brief ?? "chunk-brief-v1",
};

/**
 * Default assignments for the inference-backed LHC derivations.
 *
 * Story 6 implements config loading; these defaults use a real PI registry
 * lane, so the shipped production path can resolve through createModelCall().
 */
// PI v0.79.2 ships openai-codex/gpt-5.4 in its built-in catalog and records it
// as the default openai-codex model (pi-coding-agent CHANGELOG: GPT-5.4 support
// across openai/openai-codex, with gpt-5.4 now the default). This is the
// production-reachable dial-in default Story 6 requires; unavailable auth is
// still reported by startup validation rather than hidden behind a test provider.
export const DEFAULT_PI_MODEL = { provider: "openai-codex", id: "gpt-5.4" } as const;

export function defaultAssignments(
  model: { provider: string; id: string } = DEFAULT_PI_MODEL,
): Record<AssignmentKind, ModelAssignment> {
  const assignment = (kind: AssignmentKind): ModelAssignment => ({
    provider: model.provider,
    model: model.id,
    prompt: DEFAULT_ASSIGNMENT_PROMPTS[kind],
  });
  return Object.fromEntries(ASSIGNMENT_KINDS.map((kind) => [kind, assignment(kind)])) as Record<
    AssignmentKind,
    ModelAssignment
  >;
}
