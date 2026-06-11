// Rendering composition (Flow 3, AC-3.2–3.4): message-level forms become the
// ordered RenderingPart input for composeTurnRendering, with fallbacks and
// gap records where a form is not ready. Pure by anti-shim requirement —
// `(messages, forms) → { parts, gaps }` with no DB handle, no provider, no
// clock in the signature: determinism is structural, not disciplined.
//
// Tool activity stays in message order and groups into runs (AC-3.4, Fix 2):
// a maximal stretch of consecutive tool_call/tool_result messages folds into
// ONE RenderingPart and ONE receipt — a run-level account naming the tools,
// the call count, and the per-call mechanical outcomes, so a run containing a
// state-changing call structurally cannot lose its outcome and mixed outcomes
// stay explicit, never collapsed into a vague success. Prompts and assistant
// text break a run; thinking and runtime notes do not (interior ones ride the
// run account inline, edge ones stand alone) — a story-deviation decision.
// Runs are never reordered to make accounts tidier; the outcome rides the
// part, not the prose.
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

// One per-message atom before grouping: its composed part plus the structural
// facts the run-grouping reads. Tool atoms fold into runs; prompts and
// assistant text break runs; thinking and runtime notes are transparent —
// interior ones fold into the surrounding run's account, edge ones stand alone.
interface ComposeAtom {
  part: RenderingPart;
  isTool: boolean;
  isBreak: boolean; // user_prompt | assistant_text — ends a run
  toolName?: string; // tool_call only
  toolCallId?: string; // tool_call | tool_result
}

const RUN_BREAK_KINDS: ReadonlySet<RenderingPartKind> = new Set(["user_prompt", "assistant_text"]);
const TOOL_KINDS: ReadonlySet<RenderingPartKind> = new Set(["tool_call", "tool_result"]);

// One message → its composed part (ready form verbatim, else raw/truncated
// fallback) plus a gap when a derivable form was not ready. Gaps stay
// per-message — precise to the source record — regardless of run grouping
// (AC-3.2/3.3): the caller lands them on the rendering and they hold until an
// explicit rebuild recomposes from current states.
function buildAtom(
  message: ComposeMessage,
  forms: ReadonlyMap<string, ComposeFormRow>,
  resultByCallId: Map<string, boolean>,
): { atom: ComposeAtom; gap?: DependencyGap } {
  const plan = PART_PLANS[message.kind];
  const form =
    plan.form === undefined
      ? undefined
      : forms.get(composeFormKey(message.messageId, plan.form));
  const ready = form !== undefined && form.state === "ready" && form.content !== undefined;
  const block = message.blocks[0]?.content ?? {};
  const part: RenderingPart = {
    messageId: message.messageId,
    kind: message.kind,
    text: ready ? (form.content as string) : plan.fallbackText(message),
    fallback: plan.form !== undefined && !ready,
  };
  if (message.kind === "tool_call") {
    part.outcome =
      ready && form.metadata?.outcome !== undefined
        ? form.metadata.outcome
        : outcomeFromRecord(resultByCallId, block["toolCallId"]);
  } else if (message.kind === "tool_result") {
    part.outcome =
      ready && form.metadata?.outcome !== undefined
        ? form.metadata.outcome
        : block["isError"] === true
          ? "failed"
          : "succeeded";
  }
  const atom: ComposeAtom = {
    part,
    isTool: TOOL_KINDS.has(message.kind),
    isBreak: RUN_BREAK_KINDS.has(message.kind),
  };
  if (message.kind === "tool_call" && typeof block["toolName"] === "string") {
    atom.toolName = block["toolName"];
  }
  if (atom.isTool && typeof block["toolCallId"] === "string") {
    atom.toolCallId = block["toolCallId"];
  }
  const gap: DependencyGap | undefined =
    part.fallback && plan.form !== undefined
      ? { subjectKind: "message", subjectId: message.messageId, form: plan.form }
      : undefined;
  return gap === undefined ? { atom } : { atom, gap };
}

const RUN_OUTCOME_ORDER: readonly ToolOutcome[] = ["succeeded", "failed", "unknown"];

// The run's per-invocation outcome tally: each call counted once, plus any
// result whose paired call sits outside this run (a cross-turn pair). Mixed
// outcomes stay explicit; the run-level outcome is failed if any failed, else
// unknown if any unknown, else succeeded.
function tallyRun(members: readonly ComposeAtom[]): {
  counts: Record<ToolOutcome, number>;
  outcome: ToolOutcome;
  callCount: number;
  toolNames: string[];
} {
  const calls = members.filter((m) => m.part.kind === "tool_call");
  const callIds = new Set(
    calls.map((m) => m.toolCallId).filter((id): id is string => id !== undefined),
  );
  const orphanResults = members.filter(
    (m) =>
      m.part.kind === "tool_result" &&
      (m.toolCallId === undefined || !callIds.has(m.toolCallId)),
  );
  const counts: Record<ToolOutcome, number> = { succeeded: 0, failed: 0, unknown: 0 };
  for (const m of [...calls, ...orphanResults]) counts[m.part.outcome ?? "unknown"] += 1;
  const outcome: ToolOutcome =
    counts.failed > 0 ? "failed" : counts.unknown > 0 ? "unknown" : "succeeded";
  const toolNames: string[] = [];
  for (const call of calls) {
    if (call.toolName !== undefined && !toolNames.includes(call.toolName)) {
      toolNames.push(call.toolName);
    }
  }
  return { counts, outcome, callCount: calls.length, toolNames };
}

function runTallyText(counts: Record<ToolOutcome, number>): string {
  const segs = RUN_OUTCOME_ORDER.filter((o) => counts[o] > 0).map((o) => `${counts[o]} ${o}`);
  return segs.length > 0 ? segs.join(", ") : "no outcomes";
}

// One RenderingPart and one ToolRunReceipt for a maximal tool run (AC-3.4): a
// run-level header (tools, call count, outcome tally) over the members'
// composed accounts in record order — each tool member stating its own
// outcome so a state-changing call cannot lose it, interior thinking/notes
// riding inline. The receipt restates the same account + run outcome for the
// chunk summaries (AC-3.8).
function composeRun(members: readonly ComposeAtom[]): {
  part: RenderingPart;
  receipt: ToolRunReceipt;
} {
  const { counts, outcome, callCount, toolNames } = tallyRun(members);
  const tools = toolNames.length > 0 ? toolNames.join(", ") : "tools";
  const header = `tool run · ${tools} · ${callCount} call${callCount === 1 ? "" : "s"} · ${runTallyText(counts)}`;
  const detail = members
    .map((m) => (m.isTool ? `${m.part.text} ⇒ ${m.part.outcome ?? "unknown"}` : m.part.text))
    .join("\n");
  const text = `[${header}]\n${detail}`;
  const lead = members[0];
  if (lead === undefined) throw new Error("composeRun: a tool run has no members");
  return {
    part: {
      messageId: lead.part.messageId,
      kind: lead.part.kind,
      text,
      fallback: members.some((m) => m.isTool && m.part.fallback),
      outcome,
    },
    receipt: {
      messageId: lead.part.messageId,
      activity: lead.part.kind === "tool_result" ? "tool_result" : "tool_call",
      account: text,
      outcome,
    },
  };
}

// Compose the ordered RenderingParts and tool-run receipts. Per-message atoms
// build first (forms verbatim or fallbacks, per-message gaps); then maximal
// runs of consecutive tool activity fold into one run part + one receipt each
// (AC-3.4), with prompts/assistant text breaking runs and thinking/runtime
// notes transparent to them.
export function composeRenderingInput(
  messages: readonly ComposeMessage[],
  forms: ReadonlyMap<string, ComposeFormRow>,
): CompositionInput {
  const resultByCallId = recordOutcomes(messages);
  const atoms: ComposeAtom[] = [];
  const gaps: DependencyGap[] = [];
  for (const message of messages) {
    const built = buildAtom(message, forms, resultByCallId);
    atoms.push(built.atom);
    if (built.gap !== undefined) gaps.push(built.gap);
  }

  const parts: RenderingPart[] = [];
  const receipts: ToolRunReceipt[] = [];
  let i = 0;
  while (i < atoms.length) {
    const atom = atoms[i];
    if (atom === undefined) break; // i < length keeps this unreachable
    if (!atom.isTool) {
      parts.push(atom.part); // prompt, assistant text, or an edge thinking/note
      i += 1;
      continue;
    }
    // A maximal run starting at this tool atom: extend over following tool
    // atoms and interior transparent atoms (thinking/notes), stopping at the
    // next break (prompt/assistant text) or the turn's end. Transparent atoms
    // trailing the last tool atom stand alone, not folded into the run.
    let j = i;
    let lastToolIdx = i;
    for (let next = atoms[j + 1]; next !== undefined && !next.isBreak; next = atoms[j + 1]) {
      j += 1;
      if (next.isTool) lastToolIdx = j;
    }
    const run = composeRun(atoms.slice(i, lastToolIdx + 1));
    parts.push(run.part);
    receipts.push(run.receipt);
    for (let k = lastToolIdx + 1; k <= j; k += 1) {
      const trailing = atoms[k];
      if (trailing !== undefined) parts.push(trailing.part);
    }
    i = j + 1;
  }

  return { parts, gaps, receipts };
}
