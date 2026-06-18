// The message-level derivation handlers (Flow 2): prompt smoothing and
// tool-result summary. One shape throughout — read the
// source message (a tool-activity handler additionally joins its call-id
// pair, nothing more: AC-2.5), call exactly one inference operation, hand the
// derivation content back through HandlerOutcome. The drain's completion
// transaction does the version-checked UPDATE-only write (Story 1), so a
// stale or deleted source discards here exactly as everywhere else. Outcomes
// on tool-activity summaries come from outcome.ts — the record, never the
// inference text (AC-2.4) — and land in derivation metadata apart from content.
import type {
  HandlerDerivationWrite,
  HandlerOutcome,
  HandlerRunContext,
  InferenceResult,
  WorkHandler,
} from "../../shared-tech/index.js";
import { truncateForFallback } from "../../shared-tech/index.js";
import { estimateTokens } from "../../shared-tech/token-counting/index.js";
import type { WorkKind } from "../../shared-tech/work-queue/index.js";
import { findPairedToolCall, type MessageSource, readMessageSource } from "./derivations.js";
import { deriveToolOutcome } from "./outcome.js";
import { cleanPrompt } from "./smoothing.js";

// A handler that cannot read its source coherently has found source damage:
// terminal, derivation blocked with the reason (never a retry loop against a
// record that cannot improve). A *deleted* source never reaches this — its
// derivation row is gone and the completion write would discard — so a miss here
// is genuine corruption.
function sourceDamaged(reason: string): HandlerOutcome {
  return { ok: false, blocked: true, reason: `source_damaged: ${reason}` };
}

function loadSource(
  run: HandlerRunContext,
  item: { sourceRef: Record<string, string> },
  expectedKind: string,
): { ok: true; messageId: string; source: MessageSource } | { ok: false; outcome: HandlerOutcome } {
  const messageId = item.sourceRef["messageId"];
  if (messageId === undefined) {
    return { ok: false, outcome: sourceDamaged("work item carries no messageId") };
  }
  const source = readMessageSource(run.openDb(), messageId);
  if (source === undefined) {
    return { ok: false, outcome: sourceDamaged(`message ${messageId} not found`) };
  }
  if (source.kind !== expectedKind) {
    return {
      ok: false,
      outcome: sourceDamaged(`message ${messageId} is kind ${source.kind}, expected ${expectedKind}`),
    };
  }
  return { ok: true, messageId, source };
}

function landDerivation(write: HandlerDerivationWrite, result: InferenceResult): HandlerOutcome {
  if (!result.ok) return { ok: false, retryable: result.retryable, reason: result.reason };
  const derivation: HandlerDerivationWrite = { ...write, content: result.text };
  // Provenance is copied from the inference result — stamped there from
  // config-known strings, never authored here and never parsed from text
  // (Epic 05 DD-4). Deterministic domain assembly sets none, so its derivations
  // carry none.
  if (result.provenance !== undefined) {
    derivation.metadata = { ...(write.metadata ?? {}), provenance: result.provenance };
  }
  return { ok: true, derivations: [derivation] };
}

const smoothPromptHandler: WorkHandler = async (run, item) => {
  const loaded = loadSource(run, item, "user_prompt");
  if (!loaded.ok) return loaded.outcome;
  const text = loaded.source.blocks[0]?.content["text"];
  if (typeof text !== "string") {
    return sourceDamaged(`prompt ${loaded.messageId} has no text block`);
  }
  const cleaned = cleanPrompt(text);
  if (estimateTokens(cleaned) > run.config.smoothing.maxInferenceTokens) {
    return {
      ok: true,
      derivations: [
        {
          subjectKind: "message",
          subjectId: loaded.messageId,
          derivationType: "smoothed_prompt",
          content: cleaned,
        },
      ],
    };
  }
  return landDerivation(
    {
      subjectKind: "message",
      subjectId: loaded.messageId,
      derivationType: "smoothed_prompt",
      content: "",
    },
    await run.inferenceCallbacks.smoothPrompt({ text: cleaned }),
  );
};

export function toolResultGuidance(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("read") || normalized.includes("fetch")) {
    return "Preserve paths, filenames, cited identifiers, error messages, and the parts of the retrieved content that affect the next action.";
  }
  if (normalized.includes("search") || normalized.includes("rg") || normalized.includes("grep")) {
    return "Preserve query terms, match counts, ranked hits, file paths, and line numbers.";
  }
  if (normalized.includes("exec") || normalized.includes("shell") || normalized.includes("command")) {
    return "Preserve command outcome, exit status, stderr, failing step names, and the shortest useful stdout excerpt.";
  }
  return "Preserve the status, concrete identifiers, counts, paths, and any error text or result items needed to continue.";
}

export function toolResultTargetTokens(tokens: number, config: HandlerRunContext["config"]): number {
  const tier = config.toolResult;
  const ratio = tokens <= tier.smallTierTokens ? tier.smallTargetRatio : tier.midTargetRatio;
  return Math.max(1, Math.ceil(tokens * ratio));
}

const toolResultSummaryHandler: WorkHandler = async (run, item) => {
  const loaded = loadSource(run, item, "tool_result");
  if (!loaded.ok) return loaded.outcome;
  const block = loaded.source.blocks[0]?.content ?? {};
  const content = block["content"];
  if (typeof content !== "string") {
    return sourceDamaged(`tool result ${loaded.messageId} has no tool_result block`);
  }
  const toolCallId = block["toolCallId"];
  const pairedCall = typeof toolCallId === "string" ? findPairedToolCall(run.openDb(), toolCallId) : undefined;
  // The summary abbreviates; the full result content stays untouched in the
  // record (AC-2.3) — nothing here writes back to message_block. The result
  // is tool activity, so its outcome is stamped from its own isError flag.
  const tokens = estimateTokens(content);
  const outcome = deriveToolOutcome({ isError: block["isError"] === true });
  if (tokens > run.config.toolResult.largeTierTokens) {
    return {
      ok: true,
      derivations: [
        {
          subjectKind: "message",
          subjectId: loaded.messageId,
          derivationType: "tool_result_summary",
          content: truncateForFallback(content),
          metadata: { outcome },
        },
      ],
    };
  }
  const targetTokens = toolResultTargetTokens(tokens, run.config);
  if (tokens <= targetTokens) {
    return {
      ok: true,
      derivations: [
        {
          subjectKind: "message",
          subjectId: loaded.messageId,
          derivationType: "tool_result_summary",
          content,
          metadata: { outcome },
        },
      ],
    };
  }
  return landDerivation(
    {
      subjectKind: "message",
      subjectId: loaded.messageId,
      derivationType: "tool_result_summary",
      content: "",
      metadata: { outcome },
    },
    await run.inferenceCallbacks.summarizeToolResult({
      toolName: pairedCall?.toolName ?? "unknown_tool",
      content,
      outcome,
      targetTokens,
      guidance: toolResultGuidance(pairedCall?.toolName ?? "unknown_tool"),
    }),
  );
};

// The domain's handler table, merged into the SDK dispatch map at
// construction (DD-6). Turn-owned kinds stay with the turns domain.
export const messageWorkHandlers: Readonly<Partial<Record<WorkKind, WorkHandler>>> = {
  prompt_smoothing: smoothPromptHandler,
  tool_result_summary: toolResultSummaryHandler,
};
