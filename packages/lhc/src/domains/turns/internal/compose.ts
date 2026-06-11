// Rendering composition (Flow 3, AC-3.2–3.4): message-level forms become the
// ordered RenderingPart input for composeTurnRendering, with fallbacks and
// gap records where a form is not ready. Pure by anti-shim requirement —
// `(messages, forms) → { parts, gaps }` with no DB handle, no provider, no
// clock in the signature: determinism is structural, not disciplined.
//
// Tool activity stays in message order — runs are the consecutive tool
// messages exactly as recorded, never reordered to make accounts tidier —
// and every tool part carries its outcome, so a run containing a
// state-changing call structurally cannot lose its outcome in composition
// (AC-3.4: the outcome rides the part, not the prose).
import type {
  DependencyGap,
  DerivedFormMetadata,
  DerivedFormState,
  FormKind,
  RenderingPart,
  RenderingPartKind,
  ToolOutcome,
  ToolRunReceipt,
} from "../../../shared/derivation.js";

// The member message as the composer sees it: kind plus projected blocks,
// verbatim from the record (already deleted-filtered by the caller's read).
export interface ComposeMessage {
  messageId: string;
  kind: RenderingPartKind;
  blocks: Array<{ blockType: string; content: Record<string, unknown> }>;
}

// One message-owned form row as composition input; keyed by the caller as
// `${messageId}/${form}`.
export interface ComposeFormRow {
  state: DerivedFormState;
  content?: string;
  metadata?: DerivedFormMetadata;
}

export function composeFormKey(messageId: string, form: FormKind): string {
  return `${messageId}/${form}`;
}

export interface CompositionInput {
  parts: RenderingPart[];
  gaps: DependencyGap[];
  // The turn's tool-run receipts (AC-3.8): the tool parts restated as
  // account + outcome, in message order — pure restatement of the
  // composition input, stamped on the rendering so chunk summaries read
  // receipts without re-deriving anything.
  receipts: ToolRunReceipt[];
}

// Deterministic truncation for tool-activity fallbacks (AC-3.2's "raw or
// truncated content"): a fixed prefix plus an exact tail marker, a pure
// function of the input string alone.
export const FALLBACK_TRUNCATION_LIMIT = 200;

export function truncateForFallback(text: string): string {
  if (text.length <= FALLBACK_TRUNCATION_LIMIT) return text;
  const dropped = text.length - FALLBACK_TRUNCATION_LIMIT;
  return `${text.slice(0, FALLBACK_TRUNCATION_LIMIT)}… [truncated ${dropped} chars]`;
}

function textOf(message: ComposeMessage): string {
  const text = message.blocks[0]?.content["text"];
  return typeof text === "string" ? text : "";
}

// Mechanical outcome from the record alone (the AC-2.4 rule carried into
// composition): a tool call's outcome comes from its paired result among the
// turn's messages — present and clean, present and isError, or absent.
function recordOutcomes(messages: readonly ComposeMessage[]): Map<string, boolean> {
  const byCallId = new Map<string, boolean>();
  for (const message of messages) {
    if (message.kind !== "tool_result") continue;
    const block = message.blocks[0]?.content ?? {};
    const callId = block["toolCallId"];
    if (typeof callId === "string") byCallId.set(callId, block["isError"] === true);
  }
  return byCallId;
}

function outcomeFromRecord(
  resultByCallId: Map<string, boolean>,
  callId: unknown,
): ToolOutcome {
  if (typeof callId !== "string") return "unknown";
  const isError = resultByCallId.get(callId);
  if (isError === undefined) return "unknown";
  return isError ? "failed" : "succeeded";
}

interface PartPlan {
  form?: FormKind; // the message-level form this kind composes from, if any
  fallbackText: (message: ComposeMessage) => string;
}

// The fallback rules table (story Technical Notes): prompt → raw text; tool
// call/result → deterministic truncation; text/thinking/note → raw, no form
// to fall back from and therefore never a gap.
const PART_PLANS: Record<RenderingPartKind, PartPlan> = {
  user_prompt: { form: "smoothed_prompt", fallbackText: textOf },
  assistant_text: { fallbackText: textOf },
  assistant_thinking: { fallbackText: textOf },
  runtime_note: { fallbackText: textOf },
  tool_call: {
    form: "tool_call_summary",
    fallbackText: (message) => {
      const block = message.blocks[0]?.content ?? {};
      const toolName = typeof block["toolName"] === "string" ? block["toolName"] : "unknown_tool";
      return truncateForFallback(`${toolName}(${JSON.stringify(block["arguments"] ?? {})})`);
    },
  },
  tool_result: {
    form: "tool_result_summary",
    fallbackText: (message) => {
      const block = message.blocks[0]?.content ?? {};
      return truncateForFallback(typeof block["content"] === "string" ? block["content"] : "");
    },
  },
};

// Ready forms verbatim; non-ready (pending | failed | blocked) fall back with
// one gap recorded per fallback naming the source record and the missing
// form (AC-3.2). Gaps are facts about this composition — the caller lands
// them on the rendering and they stay put until an explicit rebuild
// recomposes from current states (AC-3.3).
export function composeRenderingInput(
  messages: readonly ComposeMessage[],
  forms: ReadonlyMap<string, ComposeFormRow>,
): CompositionInput {
  const parts: RenderingPart[] = [];
  const gaps: DependencyGap[] = [];
  const receipts: ToolRunReceipt[] = [];
  const resultByCallId = recordOutcomes(messages);

  for (const message of messages) {
    const plan = PART_PLANS[message.kind];
    const form = plan.form === undefined ? undefined : forms.get(composeFormKey(message.messageId, plan.form));
    const ready = form !== undefined && form.state === "ready" && form.content !== undefined;

    const part: RenderingPart = {
      messageId: message.messageId,
      kind: message.kind,
      text: ready ? (form.content as string) : plan.fallbackText(message),
      fallback: plan.form !== undefined && !ready,
    };
    if (message.kind === "tool_call") {
      const callId = message.blocks[0]?.content["toolCallId"];
      part.outcome =
        ready && form.metadata?.outcome !== undefined
          ? form.metadata.outcome
          : outcomeFromRecord(resultByCallId, callId);
    } else if (message.kind === "tool_result") {
      const block = message.blocks[0]?.content ?? {};
      part.outcome =
        ready && form.metadata?.outcome !== undefined
          ? form.metadata.outcome
          : block["isError"] === true
            ? "failed"
            : "succeeded";
    }
    parts.push(part);
    if (part.fallback && plan.form !== undefined) {
      gaps.push({ subjectKind: "message", subjectId: message.messageId, form: plan.form });
    }
    if (message.kind === "tool_call" || message.kind === "tool_result") {
      receipts.push({
        messageId: message.messageId,
        activity: message.kind,
        account: part.text,
        outcome: part.outcome ?? "unknown",
      });
    }
  }

  return { parts, gaps, receipts };
}
