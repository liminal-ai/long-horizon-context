// Rendering composition: message-level derivations become ordered
// RenderingParts for deterministic turn rendering, with fallbacks and gap
// records where a derivation is not ready. The function stays pure:
// `(messages, derivations) -> { parts, gaps }` with no DB handle, inference,
// or clock in the signature.
//
// Tool activity stays in message order and groups into maximal runs. A run
// becomes one RenderingPart and one receipt: the account names tools, call
// count, and per-call mechanical outcomes. Prompts and assistant text break a
// run; thinking and runtime notes do not. Runs are never reordered.

import { cleanPrompt } from "../../messages/index.js";
import type {
  DependencyGap,
  DerivationMetadata,
  DerivationState,
  RenderingPart,
  RenderingPartKind,
  ToolOutcome,
  ToolRunReceipt,
} from "../../shared-tech/index.js";
import { truncateForFallback } from "../../shared-tech/index.js";

// The member message as the composer sees it: kind plus projected blocks,
// verbatim from the record (already deleted-filtered by the caller's read).
export interface ComposeMessage {
  messageId: string;
  kind: RenderingPartKind;
  blocks: Array<{ blockType: string; content: Record<string, unknown> }>;
}

// One message-owned derivation row as composition input; keyed by the caller as
// `${messageId}/${derivation}`.
export interface ComposeDerivationRow {
  state: DerivationState;
  content?: string;
  metadata?: DerivationMetadata;
  reason?: string;
  sourceVersion: number;
}

export function composeDerivationKey(messageId: string, derivation: string): string {
  return `${messageId}/${derivation}`;
}

export interface CompositionInput {
  parts: RenderingPart[];
  gaps: DependencyGap[];
  recoveries: RecoveryReceipt[];
  // Tool parts restated as account + outcome in message order, stamped on
  // the rendering so chunk summaries read receipts without re-deriving them.
  receipts: ToolRunReceipt[];
}

export interface RecoveryReceipt {
  subjectKind: "message";
  subjectId: string;
  derivationType: string;
  content: string;
  sourceVersion: number;
  reason: "not_ready" | "failed_floor";
  floorUsed: string;
}

function textOf(message: ComposeMessage): string {
  const text = message.blocks[0]?.content["text"];
  return typeof text === "string" ? text : "";
}

function modelChangeText(message: ComposeMessage): string {
  const block = message.blocks[0]?.content ?? {};
  const previous = block["previousModel"];
  const next = block["newModel"];
  return typeof previous === "string" && typeof next === "string"
    ? `model_change ${previous} -> ${next}`
    : "model_change";
}

function thinkingLevelChangeText(message: ComposeMessage): string {
  const block = message.blocks[0]?.content ?? {};
  const previous = block["previousLevel"];
  const next = block["newLevel"];
  return typeof previous === "string" && typeof next === "string"
    ? `thinking_level_change ${previous} -> ${next}`
    : "thinking_level_change";
}

function promptFallbackText(message: ComposeMessage): string {
  const original = textOf(message);
  const floor = cleanPrompt(original);
  return floor.length === 0 && original.length > 0 ? original : floor;
}

// Mechanical outcome from the record alone: a tool call's outcome comes from
// its paired result among the turn's messages.
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

function outcomeFromRecord(resultByCallId: Map<string, boolean>, callId: unknown): ToolOutcome {
  if (typeof callId !== "string") return "unknown";
  const isError = resultByCallId.get(callId);
  if (isError === undefined) return "unknown";
  return isError ? "failed" : "succeeded";
}

interface PartPlan {
  derivation?: string; // the message-level derivation this kind composes from, if any
  fallbackText: (message: ComposeMessage) => string;
}

// Fallback rules: prompt -> cleaned text; tool call -> recorded args; tool
// result -> deterministic truncation; text/thinking/note -> raw, no
// derivation to fall back from and therefore never a gap.
const PART_PLANS: Record<RenderingPartKind, PartPlan> = {
  user_prompt: { derivation: "smoothed_prompt", fallbackText: promptFallbackText },
  assistant_text: { fallbackText: textOf },
  assistant_thinking: { fallbackText: textOf },
  runtime_note: { fallbackText: textOf },
  model_change: { fallbackText: modelChangeText },
  thinking_level_change: { fallbackText: thinkingLevelChangeText },
  tool_call: {
    fallbackText: (message) => {
      const block = message.blocks[0]?.content ?? {};
      const toolName = typeof block["toolName"] === "string" ? block["toolName"] : "unknown_tool";
      return truncateForFallback(`${toolName}(${JSON.stringify(block["arguments"] ?? {})})`);
    },
  },
  tool_result: {
    derivation: "tool_result_summary",
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
const DIALOG_KINDS: ReadonlySet<RenderingPartKind> = new Set(["user_prompt", "assistant_text"]);

// One message → its composed part (ready derivation verbatim, else raw/truncated
// fallback) plus a gap when a derivable derivation was not ready. Gaps stay
// per-message — precise to the source record — regardless of run grouping
// The caller lands gaps on the rendering and they hold until an explicit
// rebuild recomposes from current states.
function buildAtom(
  message: ComposeMessage,
  derivations: ReadonlyMap<string, ComposeDerivationRow>,
  resultByCallId: Map<string, boolean>,
): { atom: ComposeAtom; gap?: DependencyGap; recovery?: RecoveryReceipt } {
  const plan = PART_PLANS[message.kind];
  const derivation =
    plan.derivation === undefined
      ? undefined
      : derivations.get(composeDerivationKey(message.messageId, plan.derivation));
  const ready = derivation !== undefined && derivation.state === "ready" && derivation.content !== undefined;
  const block = message.blocks[0]?.content ?? {};
  const part: RenderingPart = {
    messageId: message.messageId,
    kind: message.kind,
    text: ready ? (derivation.content as string) : plan.fallbackText(message),
    fallback: plan.derivation !== undefined && !ready,
  };
  if (message.kind === "model_change" || message.kind === "thinking_level_change") {
    part.blocks = message.blocks;
  }
  if (message.kind === "tool_call") {
    part.outcome =
      ready && derivation.metadata?.outcome !== undefined
        ? derivation.metadata.outcome
        : outcomeFromRecord(resultByCallId, block["toolCallId"]);
  } else if (message.kind === "tool_result") {
    part.outcome =
      ready && derivation.metadata?.outcome !== undefined
        ? derivation.metadata.outcome
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
    part.fallback && plan.derivation !== undefined
      ? { subjectKind: "message", subjectId: message.messageId, derivationType: plan.derivation }
      : undefined;
  const recovery: RecoveryReceipt | undefined =
    part.fallback && plan.derivation !== undefined
      ? {
          subjectKind: "message",
          subjectId: message.messageId,
          derivationType: plan.derivation,
          content: part.text,
          sourceVersion: derivation?.sourceVersion ?? 1,
          reason: derivation?.state === "failed" ? "failed_floor" : "not_ready",
          floorUsed: part.text,
        }
      : undefined;
  return { atom, ...(gap === undefined ? {} : { gap }), ...(recovery === undefined ? {} : { recovery }) };
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
  const callIds = new Set(calls.map((m) => m.toolCallId).filter((id): id is string => id !== undefined));
  const orphanResults = members.filter(
    (m) => m.part.kind === "tool_result" && (m.toolCallId === undefined || !callIds.has(m.toolCallId)),
  );
  const counts: Record<ToolOutcome, number> = { succeeded: 0, failed: 0, unknown: 0 };
  for (const m of [...calls, ...orphanResults]) counts[m.part.outcome ?? "unknown"] += 1;
  const outcome: ToolOutcome = counts.failed > 0 ? "failed" : counts.unknown > 0 ? "unknown" : "succeeded";
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

// One RenderingPart and one ToolRunReceipt for a maximal tool run: a run-level
// header over member accounts in record order, each tool member stating its
// own outcome. The receipt restates the same account and run outcome for
// chunk summaries.
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
// build first (derivations verbatim or fallbacks, per-message gaps); then maximal
// runs of consecutive tool activity fold into one run part + one receipt each
// with prompts/assistant text breaking runs and thinking/runtime notes
// transparent to them.
export function composeRenderingInput(
  messages: readonly ComposeMessage[],
  derivations: ReadonlyMap<string, ComposeDerivationRow>,
): CompositionInput {
  const resultByCallId = recordOutcomes(messages);
  const atoms: ComposeAtom[] = [];
  const gaps: DependencyGap[] = [];
  const recoveries: RecoveryReceipt[] = [];
  for (const message of messages) {
    const built = buildAtom(message, derivations, resultByCallId);
    atoms.push(built.atom);
    if (built.gap !== undefined) gaps.push(built.gap);
    if (built.recovery !== undefined) recoveries.push(built.recovery);
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

  return { parts, gaps, receipts, recoveries };
}

function formatDialogueSection(part: RenderingPart): string {
  if (part.kind === "user_prompt") return `User:\n${part.text}`;
  return `⏺ ${part.text}`;
}

function composeDialogueText(parts: readonly RenderingPart[]): string {
  const dialogueParts = parts.filter(
    (part): part is RenderingPart & { kind: "user_prompt" | "assistant_text" } =>
      part.kind === "user_prompt" || part.kind === "assistant_text",
  );
  if (dialogueParts.length === 0) return "";

  let text = formatDialogueSection(dialogueParts[0]!);
  for (let index = 1; index < dialogueParts.length; index += 1) {
    const previous = dialogueParts[index - 1]!;
    const current = dialogueParts[index]!;
    const separator = previous.kind === "assistant_text" && current.kind === "assistant_text" ? "\n" : "\n\n";
    text += separator + formatDialogueSection(current);
  }
  return text.replace(/\n{3,}/g, "\n\n");
}

// Dialog-register assembly for detailed-band compression: user prompts
// (smoothed where ready) and assistant text only, in record order.
export function composePreDetailedAssembly(
  messages: readonly ComposeMessage[],
  derivations: ReadonlyMap<string, ComposeDerivationRow>,
): Pick<CompositionInput, "gaps" | "recoveries"> & { text: string } {
  const resultByCallId = recordOutcomes(messages);
  const parts: RenderingPart[] = [];
  const gaps: DependencyGap[] = [];
  const recoveries: RecoveryReceipt[] = [];
  for (const message of messages) {
    if (!DIALOG_KINDS.has(message.kind)) continue;
    const built = buildAtom(message, derivations, resultByCallId);
    parts.push(built.atom.part);
    if (built.gap !== undefined) gaps.push(built.gap);
    if (built.recovery !== undefined) recoveries.push(built.recovery);
  }
  return { text: composeDialogueText(parts), gaps, recoveries };
}
