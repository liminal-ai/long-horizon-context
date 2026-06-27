// Message-level derivation handlers share one shape: read the source message,
// optionally join its call-id pair, and return derivation content through
// HandlerOutcome. The drain's completion transaction does the version-checked
// UPDATE-only write, so stale or deleted sources discard here exactly as
// everywhere else. Tool-activity outcomes come from outcome.ts, never inference
// text, and land in derivation metadata apart from content.
import type {
  HandlerDerivationWrite,
  HandlerOutcome,
  HandlerRunContext,
  InferenceResult,
  ToolOutcome,
  WorkHandler,
} from "../../shared-tech/index.js";
import { truncateForFallback } from "../../shared-tech/index.js";
import { type LogEntry, writeLog } from "../../shared-tech/logging/index.js";
import { estimateTokens } from "../../shared-tech/token-counting/index.js";
import type { WorkKind } from "../../shared-tech/work-queue/index.js";
import { classifyToolResult } from "./classify-tool-result.js";
import { findPairedToolCall, type MessageSource, readMessageSource } from "./derivations.js";
import { deriveToolOutcome } from "./outcome.js";
import { cleanPrompt } from "./smoothing.js";

const FORCE_TOOL_RESULT_SUMMARY_FALLBACK = true;

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

export interface SmoothedPromptDerivation {
  write: HandlerDerivationWrite;
  warningLog?: LogEntry;
}

export async function deriveSmoothedPrompt(
  run: HandlerRunContext,
  messageId: string,
  text: string,
): Promise<SmoothedPromptDerivation | Extract<InferenceResult, { ok: false }>> {
  const cleaned = cleanPrompt(text);
  const cleanedTokens = estimateTokens(cleaned);
  const guards = run.config.guards.smoothedPrompt;
  if (cleanedTokens > guards.maxInferenceTokens) {
    return {
      write: {
        subjectKind: "message",
        subjectId: messageId,
        derivationType: "smoothed_prompt",
        content: cleaned,
      },
    };
  }

  const result = await run.inferenceCallbacks.smoothPrompt({ text: cleaned });
  if (!result.ok) return result;

  const resultTokens = estimateTokens(result.text);
  if (resultTokens < guards.suspiciousOutputRatio * cleanedTokens) {
    return {
      write: {
        subjectKind: "message",
        subjectId: messageId,
        derivationType: "smoothed_prompt",
        content: cleaned,
        metadata: { discardReason: "suspicious_output_ratio" },
      },
      warningLog: {
        level: "warning",
        message: "suspicious smoothed_prompt output discarded",
        derivationType: "smoothed_prompt",
        subjectId: messageId,
        reason: "suspicious_output_ratio",
        floorUsed: cleaned,
      },
    };
  }

  const write: HandlerDerivationWrite = {
    subjectKind: "message",
    subjectId: messageId,
    derivationType: "smoothed_prompt",
    content: result.text,
  };
  if (result.provenance !== undefined) {
    write.metadata = { provenance: result.provenance };
  }
  return { write };
}

const smoothPromptHandler: WorkHandler = async (run, item) => {
  const loaded = loadSource(run, item, "user_prompt");
  if (!loaded.ok) return loaded.outcome;
  const text = loaded.source.blocks[0]?.content["text"];
  if (typeof text !== "string") {
    return sourceDamaged(`prompt ${loaded.messageId} has no text block`);
  }
  const derived = await deriveSmoothedPrompt(run, loaded.messageId, text);
  if (!("write" in derived)) return { ok: false, retryable: derived.retryable, reason: derived.reason };
  const outcome: HandlerOutcome = { ok: true, derivations: [derived.write] };
  if (derived.warningLog !== undefined) {
    outcome.onApplied = (transaction) => {
      transaction.onCommit(() => {
        writeLog({ db: transaction.db, threadId: run.threadId, filePath: run.filePath }, derived.warningLog!);
      });
    };
  }
  return outcome;
};

export function toolResultTargetTokens(tokens: number, config: HandlerRunContext["config"]): number {
  const tier = config.toolResult;
  const ratio = tokens <= tier.smallTierTokens ? tier.smallTargetRatio : tier.midTargetRatio;
  return Math.max(1, Math.ceil(tokens * ratio));
}

export interface ToolResultSummaryDerivation {
  write: HandlerDerivationWrite;
}

export async function deriveToolResultSummary(
  run: HandlerRunContext,
  messageId: string,
  input: {
    toolName: string;
    toolInput?: Record<string, unknown>;
    content: string;
    outcome: ToolOutcome;
  },
): Promise<ToolResultSummaryDerivation | Extract<InferenceResult, { ok: false }>> {
  const tokens = estimateTokens(input.content);
  if (FORCE_TOOL_RESULT_SUMMARY_FALLBACK) {
    return {
      write: {
        subjectKind: "message",
        subjectId: messageId,
        derivationType: "tool_result_summary",
        content: truncateForFallback(input.content),
        metadata: { outcome: input.outcome },
      },
    };
  }
  if (tokens <= run.config.toolResult.smallTierTokens) {
    return {
      write: {
        subjectKind: "message",
        subjectId: messageId,
        derivationType: "tool_result_summary",
        content: input.content,
        metadata: { outcome: input.outcome },
      },
    };
  }

  const targetTokens = toolResultTargetTokens(tokens, run.config);
  const classification = classifyToolResult({
    toolName: input.toolName,
    ...(input.toolInput === undefined ? {} : { toolInput: input.toolInput }),
    rawOutput: input.content,
    outcome: input.outcome,
  });
  const result = await run.inferenceCallbacks.summarizeToolResult({
    toolName: input.toolName,
    content: input.content,
    outcome: input.outcome,
    targetTokens,
    operationClass: classification.operationClass,
    responseShape: classification.responseShape,
    promptMode: classification.promptMode,
    facts: classification.facts,
  });
  if (!result.ok) return result;

  const write: HandlerDerivationWrite = {
    subjectKind: "message",
    subjectId: messageId,
    derivationType: "tool_result_summary",
    content: result.text,
    metadata: { outcome: input.outcome },
  };
  if (result.provenance !== undefined) {
    write.metadata = { ...write.metadata, provenance: result.provenance };
  }
  return { write };
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
  // record. Nothing here writes back to message_block. The result is tool
  // activity, so its outcome is stamped from its own isError flag.
  const outcome = deriveToolOutcome({ isError: block["isError"] === true });
  const derived = await deriveToolResultSummary(run, loaded.messageId, {
    toolName: pairedCall?.toolName ?? "unknown_tool",
    ...(pairedCall?.toolInput === undefined ? {} : { toolInput: pairedCall.toolInput }),
    content,
    outcome,
  });
  if (!("write" in derived)) return { ok: false, retryable: derived.retryable, reason: derived.reason };
  return { ok: true, derivations: [derived.write] };
};

// The domain's handler table is merged into the SDK dispatch map at
// construction. Turn-owned kinds stay with the turns domain.
export const messageWorkHandlers: Readonly<Partial<Record<WorkKind, WorkHandler>>> = {
  prompt_smoothing: smoothPromptHandler,
  tool_result_summary: toolResultSummaryHandler,
};
