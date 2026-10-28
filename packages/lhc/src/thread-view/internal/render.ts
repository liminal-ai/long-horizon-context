import type { Band } from "../../shared-tech/index.js";
import { FALLBACK_TRUNCATION_LIMIT, truncateForFallback } from "../../shared-tech/index.js";
import type { TokenEstimator } from "../../shared-tech/token-counting/index.js";
import type { TailMessageRow } from "./snapshot.js";

export interface AssembledContextMessage {
  role: "user" | "assistant";
  content: string;
  band?: Band;
}

export const ABBREVIATION_LIMIT = FALLBACK_TRUNCATION_LIMIT;

export function deterministicTruncation(text: string): string {
  return truncateForFallback(text);
}

function blockContent(message: TailMessageRow): Record<string, unknown> {
  return message.blocks[0]?.content ?? {};
}

function textOf(message: TailMessageRow): string {
  const text = blockContent(message)["text"];
  return typeof text === "string" ? text : "";
}

export interface TailRenderContext {
  boundaryPosition: number;
  toolNameByCallId: ReadonlyMap<string, string>;
}

export function toolNamesByCallId(messages: readonly TailMessageRow[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.kind !== "tool_call") continue;
    const block = blockContent(message);
    const callId = block["toolCallId"];
    const toolName = block["toolName"];
    if (typeof callId === "string" && typeof toolName === "string") {
      names.set(callId, toolName);
    }
  }
  return names;
}

function renderToolCall(message: TailMessageRow): AssembledContextMessage {
  const block = blockContent(message);
  const name = typeof block["toolName"] === "string" ? block["toolName"] : "unknown_tool";
  const args = JSON.stringify(block["arguments"] ?? {});
  return { role: "assistant", content: `[tool call · ${name}] ${args}` };
}

function toolResultRawContent(message: TailMessageRow): string {
  const content = blockContent(message)["content"];
  return typeof content === "string" ? content : "";
}

export function toolResultSessionContent(message: TailMessageRow, ctx: TailRenderContext): string {
  const content = toolResultRawContent(message);
  if (message.sourceEventOrder > ctx.boundaryPosition) {
    return content;
  }
  return deterministicTruncation(content);
}

function renderToolResult(message: TailMessageRow, ctx: TailRenderContext): AssembledContextMessage {
  const block = blockContent(message);
  const callId = block["toolCallId"];
  const name = (typeof callId === "string" ? ctx.toolNameByCallId.get(callId) : undefined) ?? "unknown_tool";
  if (message.sourceEventOrder > ctx.boundaryPosition) {
    return { role: "user", content: `[tool result · ${name}]\n${toolResultRawContent(message)}` };
  }
  const short = deterministicTruncation(toolResultRawContent(message));
  return {
    role: "user",
    content: `[tool result · ${name} · abridged]\n${short}`,
  };
}

export function isEmptyThinkingHusk(message: TailMessageRow): boolean {
  if (message.kind !== "assistant_thinking") return false;
  if (message.blocks.length > 1) return false;
  const content = message.blocks[0]?.content ?? {};
  const text = content["text"];
  const hasText = typeof text === "string" && text.trim() !== "";
  const signature = content["signature"] ?? content["thinkingSignature"];
  const hasSignature = typeof signature === "string" && signature !== "";
  return !hasText && !hasSignature;
}

export function hasThinkingText(message: TailMessageRow): boolean {
  if (message.kind !== "assistant_thinking") return false;
  const text = message.blocks[0]?.content?.["text"];
  return typeof text === "string" && text.trim() !== "";
}

export function renderTailMessage(message: TailMessageRow, ctx: TailRenderContext): AssembledContextMessage {
  switch (message.kind) {
    case "user_prompt":
      return { role: "user", content: textOf(message) };
    case "assistant_text":
      return { role: "assistant", content: textOf(message) };
    case "assistant_thinking":
      return { role: "assistant", content: `[thinking]\n${textOf(message)}\n[/thinking]` };
    case "tool_call":
      return renderToolCall(message);
    case "tool_result":
      return renderToolResult(message, ctx);
    case "runtime_note":
      return { role: "user", content: `[runtime note] ${textOf(message)}` };
    case "model_change": {
      const block = message.blocks[0]?.content ?? {};
      return {
        role: "user",
        content: `[model change] ${String(block["previousModel"] ?? "")} -> ${String(block["newModel"] ?? "")}`,
      };
    }
    case "thinking_level_change": {
      const block = message.blocks[0]?.content ?? {};
      return {
        role: "user",
        content: `[thinking level change] ${String(block["previousLevel"] ?? "")} -> ${String(block["newLevel"] ?? "")}`,
      };
    }
    case "compact_continuation_marker": {
      const block = message.blocks[0]?.content ?? {};
      const cause = typeof block["cause"] === "string" ? block["cause"] : "context_compacted_task_in_progress";
      const action = typeof block["action"] === "string" ? block["action"] : "continue_existing_task";
      const turnId = typeof block["continuationTurnId"] === "string" ? block["continuationTurnId"] : "";
      return {
        role: "user",
        content: [
          "[compact continuation]",
          `cause=${cause}`,
          `action=${action}`,
          "newUserRequest=false",
          "waitForUser=false",
          `continuationTurnId=${turnId}`,
        ].join(" "),
      };
    }
  }
}

export function renderBandMessage(band: Band, renderedText: string): AssembledContextMessage {
  return { role: "user", band, content: `[context · ${band}]\n${renderedText}` };
}

export interface DerivationSnapshot {
  state: "pending" | "ready" | "failed" | "blocked";
  content?: string;
  reason?: string;
  sourceVersion?: number;
}

export type CompactChunkMaterialSnapshot =
  | { kind: "ready"; content: string }
  | { kind: "concat"; content: string; reason: string };

export type DerivationLookup = (subjectId: string, derivationType: string) => DerivationSnapshot | undefined;

export type CompactChunkMaterialLookup = () => CompactChunkMaterialSnapshot | undefined;
export type TurnExcerptLookup = () => string | null;

export interface ResolvedRepresentation {
  derivationUsed: string;
  body: string;
  degraded: boolean;
  gap: boolean;
  degradedMarker?: string;
  reason?: string;
}

function usable(derivation: DerivationSnapshot | undefined): derivation is DerivationSnapshot & { content: string } {
  return derivation?.state === "ready" && typeof derivation.content === "string";
}

function ladderState(derivation: DerivationSnapshot | undefined): string {
  return derivation === undefined ? "absent" : derivation.state;
}

export function resolveSmoothRepresentation(
  turnId: string,
  lookup: DerivationLookup,
  excerpt: TurnExcerptLookup,
): ResolvedRepresentation {
  const rendering = lookup(turnId, "turn_rendering");
  if (usable(rendering)) {
    return { derivationUsed: "turn_rendering", body: rendering.content, degraded: false, gap: false };
  }
  const compression = lookup(turnId, "detailed_turn_compression");
  if (usable(compression)) {
    return {
      derivationUsed: "detailed_turn_compression",
      body: compression.content,
      degraded: true,
      gap: false,
      degradedMarker: "smooth-from-compression",
    };
  }
  const excerptText = excerpt();
  if (excerptText !== null) {
    return {
      derivationUsed: "message_excerpt",
      body: deterministicTruncation(excerptText),
      degraded: true,
      gap: false,
      degradedMarker: "smooth-from-excerpt",
    };
  }
  return {
    derivationUsed: "gap",
    body: "",
    degraded: false,
    gap: true,
    reason: `no usable derivation (turn_rendering: ${ladderState(rendering)}, detailed_turn_compression: ${ladderState(compression)}, no live messages)`,
  };
}

export function resolveDetailedRepresentation(
  chunkId: string,
  lookup: DerivationLookup,
  materialLookup?: CompactChunkMaterialLookup,
): ResolvedRepresentation {
  const detailed = lookup(chunkId, "chunk_summary_detailed");
  if (usable(detailed)) {
    return { derivationUsed: "chunk_summary_detailed", body: detailed.content, degraded: false, gap: false };
  }
  const material = materialLookup?.();
  if (material?.kind === "ready") {
    return {
      derivationUsed: "chunk_summary_detailed",
      body: material.content,
      degraded: false,
      gap: false,
    };
  }
  if (material?.kind === "concat") {
    return {
      derivationUsed: "stored_member_concat",
      body: material.content,
      degraded: true,
      gap: false,
      degradedMarker: "detailed-from-stored-members",
      reason: material.reason,
    };
  }
  return {
    derivationUsed: "gap",
    body: "",
    degraded: false,
    gap: true,
    reason: `no usable derivation (chunk_summary_detailed: ${ladderState(detailed)}, compact material absent)`,
  };
}

export function briefFallbackCapTokens(briefBandBudget: number): number {
  return Math.max(briefBandBudget * 0.05, 200);
}

function capFallbackBody(body: string, capTokens: number, estimator: TokenEstimator): string {
  const bodyTokens = estimator.estimate(body);
  if (bodyTokens <= capTokens) return body;
  const marker = (dropped: number): string => `[compression failed: ~${dropped} tokens of content truncated]`;
  let keep = Math.floor((body.length / bodyTokens) * capTokens);
  for (;;) {
    const kept = body.slice(0, keep).trimEnd();
    const dropped = Math.max(0, bodyTokens - estimator.estimate(kept));
    const capped = kept === "" ? marker(dropped) : `${kept}\n${marker(dropped)}`;
    if (keep === 0 || estimator.estimate(capped) <= capTokens) return capped;
    keep = Math.max(0, Math.min(keep - 1, Math.floor(keep * 0.9)));
  }
}

export function resolveBriefRepresentation(
  chunkId: string,
  lookup: DerivationLookup,
  briefBandBudget: number,
  estimator: TokenEstimator,
  materialLookup?: CompactChunkMaterialLookup,
): ResolvedRepresentation {
  const brief = lookup(chunkId, "chunk_summary_brief");
  if (usable(brief)) {
    return { derivationUsed: "chunk_summary_brief", body: brief.content, degraded: false, gap: false };
  }
  const material = materialLookup?.();
  if (material?.kind === "ready") {
    return {
      derivationUsed: "chunk_summary_brief",
      body: material.content,
      degraded: false,
      gap: false,
    };
  }
  if (material?.kind === "concat") {
    return {
      derivationUsed: "stored_member_concat",
      body: capFallbackBody(material.content, briefFallbackCapTokens(briefBandBudget), estimator),
      degraded: true,
      gap: false,
      degradedMarker: "brief-from-stored-members",
      reason: material.reason,
    };
  }
  return {
    derivationUsed: "gap",
    body: "",
    degraded: false,
    gap: true,
    reason: `no usable derivation (chunk_summary_brief: ${ladderState(brief)}, compact material absent)`,
  };
}

export function excerptLine(
  kind: string,
  blocks: ReadonlyArray<{ blockType: string; content: Record<string, unknown> }>,
): string {
  const content = blocks[0]?.content ?? {};
  const text = typeof content["text"] === "string" ? content["text"] : "";
  switch (kind) {
    case "tool_call": {
      const name = typeof content["toolName"] === "string" ? content["toolName"] : "unknown_tool";
      return `[tool call · ${name}]`;
    }
    case "tool_result":
      return "[tool result]";
    default:
      return text;
  }
}

export function renderArrangementEntry(
  subjectKind: "turn" | "chunk",
  _subjectId: string,
  rep: ResolvedRepresentation,
  noteTexts: readonly string[],
  memberTurnIds: readonly string[] = [],
): string {
  const lines = noteTexts.map((text) => `[inter-turn note] ${text}`);
  if (subjectKind === "chunk" && memberTurnIds.length > 0) {
    lines.push(`<turns>${memberTurnIds.join(" ")}</turns>`);
  }
  if (rep.gap) {
    lines.push(`[${subjectKind} unavailable: ${rep.reason ?? "unknown"}]`);
  } else {
    const marker = rep.degraded ? `[degraded: ${rep.degradedMarker ?? rep.derivationUsed}]\n` : "";
    lines.push(`${marker}${rep.body}`);
  }
  return lines.join("\n");
}

export function assembleBandText(entryTexts: readonly string[]): string {
  return entryTexts.join("\n\n");
}
