// Rendering composition: message-level derivations become ordered
// RenderingParts for deterministic turn rendering, with fallbacks and gap
// records where a derivation is not ready. The function stays pure:
// `(messages, derivations) -> { parts, gaps }` with no DB handle, inference,
// or clock in the signature.
//
// Tool activity stays in message order and groups into maximal runs. A run
// becomes one RenderingPart whose header names tools, call count, and per-call
// mechanical outcomes. Prompts and assistant text break a run; thinking and
// runtime notes do not. Runs are never reordered.

import { cleanPrompt } from "../../messages/index.js";
import type {
  DependencyGap,
  DerivationMetadata,
  DerivationState,
  RenderingPart,
  RenderingPartKind,
  ToolOutcome,
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

/** Short XML wrap: tag name is the entity id (`m12`, `t3`). */
export function wrapEntityXml(entityId: string, body: string): string {
  return `<${entityId}>\n${body}\n</${entityId}>`;
}

function wrapMessageLineXml(messageId: string, line: string): string {
  return `<${messageId}>${line}</${messageId}>`;
}

// One RenderingPart for a maximal tool run: a run-level header over member
// accounts in record order, each tool member stating its own outcome. Each
// member line is tagged with its message id so smooth history can address it.
function composeRun(members: readonly ComposeAtom[]): RenderingPart {
  const { counts, outcome, callCount, toolNames } = tallyRun(members);
  const tools = toolNames.length > 0 ? toolNames.join(", ") : "tools";
  const header = `tool run · ${tools} · ${callCount} call${callCount === 1 ? "" : "s"} · ${runTallyText(counts)}`;
  const detail = members
    .map((m) => {
      const line = m.isTool ? `${m.part.text} ⇒ ${m.part.outcome ?? "unknown"}` : m.part.text;
      return wrapMessageLineXml(m.part.messageId, line);
    })
    .join("\n");
  const text = `[${header}]\n${detail}`;
  const lead = members[0];
  if (lead === undefined) throw new Error("composeRun: a tool run has no members");
  return {
    messageId: lead.part.messageId,
    kind: lead.part.kind,
    text,
    fallback: members.some((m) => m.isTool && m.part.fallback),
    outcome,
    memberMessageIds: members.map((m) => m.part.messageId),
  };
}

// Compose the ordered RenderingParts. Per-message atoms build first
// (derivations verbatim or fallbacks, per-message gaps); then maximal runs of
// consecutive tool activity fold into one run part each with prompts/assistant
// text breaking runs and thinking/runtime notes transparent to them.
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
    parts.push(run);
    for (let k = lastToolIdx + 1; k <= j; k += 1) {
      const trailing = atoms[k];
      if (trailing !== undefined) parts.push(trailing.part);
    }
    i = j + 1;
  }

  return { parts, gaps, recoveries };
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

function renderingPartLabel(kind: RenderingPartKind): string {
  switch (kind) {
    case "user_prompt":
      return "User prompt";
    case "assistant_text":
      return "Assistant response";
    case "assistant_thinking":
      return "Assistant thinking";
    case "runtime_note":
      return "Runtime note";
    case "model_change":
      return "Model change";
    case "thinking_level_change":
      return "Thinking level change";
    case "tool_call":
      return "Tool call";
    case "tool_result":
      return "Tool result";
  }
}

/** Smooth-band turn_rendering text: turn wrap + per-message tags. Not used for
 *  pre_detailed_assembly (compression stays untagged). */
export function composeStructuredTurnText(parts: readonly RenderingPart[], turnId: string): string {
  const inner = parts
    .map((part) => {
      const annotations = [
        part.fallback ? "fallback" : undefined,
        part.outcome === undefined ? undefined : `outcome: ${part.outcome}`,
      ].filter((annotation): annotation is string => annotation !== undefined);
      const suffix = annotations.length === 0 ? "" : ` [${annotations.join("; ")}]`;
      const header = `${renderingPartLabel(part.kind)}${suffix}`;
      // Tool runs already tag each member line; other parts wrap the whole body.
      const body =
        part.memberMessageIds !== undefined && part.memberMessageIds.length > 0
          ? part.text
          : wrapEntityXml(part.messageId, part.text);
      return `${header}\n${body}`;
    })
    .join("\n\n");
  return wrapEntityXml(turnId, inner);
}

/** Chunk band header: member turn ids the model can request later. */
export function formatTurnRangeHeader(turnIds: readonly string[]): string {
  if (turnIds.length === 0) return "";
  return `<turns>${turnIds.join(" ")}</turns>`;
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
