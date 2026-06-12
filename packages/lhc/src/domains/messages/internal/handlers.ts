// The three message-level derivation handlers (Flow 2): prompt smoothing,
// tool-call summary, tool-result summary. One shape throughout — read the
// source message (a tool-activity handler additionally joins its call-id
// pair, nothing more: AC-2.5), call exactly one provider operation, hand the
// form content back through HandlerOutcome. The drain's completion
// transaction performs the version-checked UPDATE-only write (Story 1), so a
// stale or deleted source discards here exactly as everywhere else. Outcomes
// on tool-activity summaries come from outcome.ts — the record, never the
// provider's text (AC-2.4) — and land in form metadata apart from content.
import type {
  HandlerFormWrite,
  HandlerOutcome,
  HandlerRunContext,
  ProviderResult,
  WorkHandler,
} from "../../../shared/derivation.js";
import type { WorkKind } from "../../../tech-utils/work-queue/index.js";
import { deriveToolOutcome } from "./outcome.js";
import {
  findPairedToolCall,
  findPairedToolResult,
  readMessageSource,
  type MessageSource,
} from "./forms.js";

// A handler that cannot read its source coherently has found source damage:
// terminal, form blocked with the reason (never a retry loop against a
// record that cannot improve). A *deleted* source never reaches this — its
// form row is gone and the completion write would discard — so a miss here
// is genuine corruption.
function sourceDamaged(reason: string): HandlerOutcome {
  return { ok: false, blocked: true, reason: `source_damaged: ${reason}` };
}

function loadSource(
  run: HandlerRunContext,
  item: { sourceRef: Record<string, string> },
  expectedKind: string,
):
  | { ok: true; messageId: string; source: MessageSource }
  | { ok: false; outcome: HandlerOutcome } {
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
      outcome: sourceDamaged(
        `message ${messageId} is kind ${source.kind}, expected ${expectedKind}`,
      ),
    };
  }
  return { ok: true, messageId, source };
}

function landForm(write: HandlerFormWrite, result: ProviderResult): HandlerOutcome {
  if (!result.ok) return { ok: false, retryable: result.retryable, reason: result.reason };
  const form: HandlerFormWrite = { ...write, content: result.text };
  // Provenance is copied from the provider result — stamped there from
  // config-known strings, never authored here and never parsed from text
  // (Epic 05 DD-4). The deterministic provider sets none, so its forms
  // carry none.
  if (result.provenance !== undefined) {
    form.metadata = { ...(write.metadata ?? {}), provenance: result.provenance };
  }
  return { ok: true, forms: [form] };
}

const smoothPromptHandler: WorkHandler = async (run, item) => {
  const loaded = loadSource(run, item, "user_prompt");
  if (!loaded.ok) return loaded.outcome;
  const text = loaded.source.blocks[0]?.content["text"];
  if (typeof text !== "string") {
    return sourceDamaged(`prompt ${loaded.messageId} has no text block`);
  }
  return landForm(
    {
      subjectKind: "message",
      subjectId: loaded.messageId,
      form: "smoothed_prompt",
      content: "",
    },
    await run.provider.smoothPrompt({ text }),
  );
};

const toolCallSummaryHandler: WorkHandler = async (run, item) => {
  const loaded = loadSource(run, item, "tool_call");
  if (!loaded.ok) return loaded.outcome;
  const block = loaded.source.blocks[0]?.content ?? {};
  const toolCallId = block["toolCallId"];
  const toolName = block["toolName"];
  if (typeof toolCallId !== "string" || typeof toolName !== "string") {
    return sourceDamaged(`tool call ${loaded.messageId} has no tool_call block`);
  }
  // The handler's one reach beyond its message: the paired result by call id
  // (AC-2.5). Outcome is stamped from that pairing mechanically — present and
  // clean, present and isError, or absent — before the provider ever runs.
  const paired = findPairedToolResult(run.openDb(), toolCallId);
  const outcome = deriveToolOutcome(paired);
  const input: Parameters<typeof run.provider.summarizeToolCall>[0] = {
    toolName,
    argsJson: JSON.stringify(block["arguments"] ?? {}),
  };
  if (paired !== undefined) {
    input.pairedResult = { content: paired.content, isError: paired.isError };
  }
  return landForm(
    {
      subjectKind: "message",
      subjectId: loaded.messageId,
      form: "tool_call_summary",
      content: "",
      metadata: { outcome },
    },
    await run.provider.summarizeToolCall(input),
  );
};

const toolResultSummaryHandler: WorkHandler = async (run, item) => {
  const loaded = loadSource(run, item, "tool_result");
  if (!loaded.ok) return loaded.outcome;
  const block = loaded.source.blocks[0]?.content ?? {};
  const content = block["content"];
  if (typeof content !== "string") {
    return sourceDamaged(`tool result ${loaded.messageId} has no tool_result block`);
  }
  const toolCallId = block["toolCallId"];
  const pairedCall =
    typeof toolCallId === "string"
      ? findPairedToolCall(run.openDb(), toolCallId)
      : undefined;
  // The summary abbreviates; the full result content stays untouched in the
  // record (AC-2.3) — nothing here writes back to message_block. The result
  // is tool activity, so its outcome is stamped from its own isError flag.
  return landForm(
    {
      subjectKind: "message",
      subjectId: loaded.messageId,
      form: "tool_result_summary",
      content: "",
      metadata: { outcome: deriveToolOutcome({ isError: block["isError"] === true }) },
    },
    await run.provider.summarizeToolResult({
      toolName: pairedCall?.toolName ?? "unknown_tool",
      content,
    }),
  );
};

// The domain's handler table, merged into the SDK dispatch map at
// construction (DD-6). Turn-owned kinds stay with the turns domain.
export const messageWorkHandlers: Readonly<Partial<Record<WorkKind, WorkHandler>>> = {
  prompt_smoothing: smoothPromptHandler,
  tool_call_summary: toolCallSummaryHandler,
  tool_result_summary: toolResultSummaryHandler,
};
