// Tail and band formatting: the tail mapping table, short/full tool-result
// selection by boundary position, and the deterministic at-or-behind-boundary
// truncation rule. Pure functions over read state by design: no DB handle, no
// inference, no clock.
//
// The band-entry side includes degrade ladders, gap entries as the last rung,
// the [degraded: ...] and [inter-turn note] markers, and band-text assembly.
// select.ts consumes the same entry renderer to price
// entries during the fill walk, so the tokens the walk budgets are the tokens
// the band stores: one renderer, no drift. The brief ladder additionally caps
// its fallback rungs (briefFallbackCapTokens): a failed brief must not cost
// the band what a full uncompressed body costs.
import type { Band } from "../../shared-tech/index.js";
import { FALLBACK_TRUNCATION_LIMIT, truncateForFallback } from "../../shared-tech/index.js";
import { estimateTokens } from "../../shared-tech/token-counting/index.js";
import type { TailMessageRow } from "./snapshot.js";

export interface AssembledContextMessage {
  role: "user" | "assistant";
  content: string;
  band?: Band;
}

// Deterministic abbreviation: a fixed prefix plus an exact tail marker, a pure
// function of the input string alone. Restated here, byte-identical to
// turns/internal/compose.ts's truncateForFallback, because cross-domain
// internals may not be imported.
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

// What the tail renderer needs beyond the message itself: the boundary
// position (short/full selection) and the call-id → tool-name pairing
// (results carry only their call id).
export interface TailRenderContext {
  boundaryPosition: number;
  toolNameByCallId: ReadonlyMap<string, string>;
}

// The call-id → tool-name map from the messages in hand. Pairing within the
// tail is structurally sufficient: the compact point snaps to a turn start,
// so a tail result's call is never behind it.
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

/** Tool-result body for session loading: full ahead of the boundary, truncated at-or-behind. */
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

// Anthropic models running with omitted thinking display emit thinking blocks
// whose text is empty, with the encrypted reasoning carried (if at all) in a
// signature. An empty-text, unsigned block carries nothing a model can use,
// and the two serving exits rendered it divergently (standalone [thinking]
// husk vs empty adjacent part). Skip such rows at serve time only — capture
// and derivations keep them. Signed blocks are served once signature capture
// lands; the predicate already honors them.
export function isEmptyThinkingHusk(message: TailMessageRow): boolean {
  if (message.kind !== "assistant_thinking") return false;
  const content = message.blocks[0]?.content ?? {};
  const text = content["text"];
  const hasText = typeof text === "string" && text.trim() !== "";
  const signature = content["signature"] ?? content["thinkingSignature"];
  const hasSignature = typeof signature === "string" && signature !== "";
  return !hasText && !hasSignature;
}

// One tail message → one assembled message per the mapping table. Each kind is its
// own arm so a single kind's drift fails its own named test leg.
export function renderTailMessage(message: TailMessageRow, ctx: TailRenderContext): AssembledContextMessage {
  switch (message.kind) {
    case "user_prompt":
      return { role: "user", content: textOf(message) };
    case "assistant_text":
      return { role: "assistant", content: textOf(message) };
    case "assistant_thinking":
      // Included: the tail is full fidelity (bands compress thinking away for
      // older turns); harness-side conversion may re-block or drop.
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
  }
}

// One non-empty band to one labeled `user` message: band-marker header, then
// the snapshot bytes verbatim. Inference APIs reject unknown roles.
export function renderBandMessage(band: Band, renderedText: string): AssembledContextMessage {
  return { role: "user", band, content: `[context · ${band}]\n${renderedText}` };
}

// ── band entries: degrade ladders, gaps, keys ────────────────────

// One derivation's stored state as the ladder reads it (a read shape for
// Derivation: the resolvers never write, never re-derive).
export interface DerivationSnapshot {
  state: "pending" | "ready" | "failed" | "blocked";
  content?: string;
  reason?: string;
}

export type CompactChunkMaterialSnapshot =
  | { kind: "ready"; content: string }
  | { kind: "concat"; content: string; reason: string };

export type DerivationLookup = (subjectId: string, derivationType: string) => DerivationSnapshot | undefined;

// A subject's resolved representation: which rung of its ladder renders.
// `derivationUsed` is the arrangement/receipt vocabulary; `degradedMarker` is the
// rendered [degraded: …] text for fallback rungs.
export interface ResolvedRepresentation {
  derivationUsed: string;
  body: string;
  degraded: boolean;
  gap: boolean;
  degradedMarker?: string;
  reason?: string;
}

function usable(derivation: DerivationSnapshot | undefined): derivation is DerivationSnapshot & { content: string } {
  // "Usable" means state = ready.
  return derivation?.state === "ready" && typeof derivation.content === "string";
}

function ladderState(derivation: DerivationSnapshot | undefined): string {
  return derivation === undefined ? "absent" : derivation.state;
}

// Smooth (turn) ladder: turn_rendering → detailed_turn_compression →
// deterministic excerpt of the turn's live messages → gap entry.
export function resolveSmoothRepresentation(
  turnId: string,
  lookup: DerivationLookup,
  excerpt: string | null,
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
  if (excerpt !== null) {
    return {
      derivationUsed: "message_excerpt",
      body: deterministicTruncation(excerpt),
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

// Detailed (chunk) ladder: chunk_summary_detailed → chunk_summary_brief →
// concatenated member smooth compressions (truncated, marked) → gap entry.
export function resolveDetailedRepresentation(
  chunkId: string,
  lookup: DerivationLookup,
  material?: CompactChunkMaterialSnapshot,
): ResolvedRepresentation {
  const detailed = lookup(chunkId, "chunk_summary_detailed");
  if (usable(detailed)) {
    return { derivationUsed: "chunk_summary_detailed", body: detailed.content, degraded: false, gap: false };
  }
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

// The size floor a failed brief may cost: 5% of the brief band's own budget,
// never below 200 tokens. A brief derivation exists to be small; when it fails
// the ladder falls back to material sized for a different purpose (member
// concat, i.e. raw turn text), and an uncompressed fallback that large is what
// let one chunk consume the band. The floor is on the fallback only — a ready
// brief is whatever the deriver made it.
export function briefFallbackCapTokens(briefBandBudget: number): number {
  return Math.max(briefBandBudget * 0.05, 200);
}

// Character-level shrink priced by the same estimator the fill walk budgets
// with, so the entry's reported size is its true size: start from the body's
// own chars-per-token ratio, then step down until the kept text plus its
// terminal marker prices at or under the cap.
function capFallbackBody(body: string, capTokens: number): string {
  const bodyTokens = estimateTokens(body);
  if (bodyTokens <= capTokens) return body;
  const marker = (dropped: number): string => `[compression failed: ~${dropped} tokens of content truncated]`;
  let keep = Math.floor((body.length / bodyTokens) * capTokens);
  for (;;) {
    const kept = body.slice(0, keep).trimEnd();
    const dropped = Math.max(0, bodyTokens - estimateTokens(kept));
    const capped = kept === "" ? marker(dropped) : `${kept}\n${marker(dropped)}`;
    if (keep === 0 || estimateTokens(capped) <= capTokens) return capped;
    keep = Math.max(0, Math.min(keep - 1, Math.floor(keep * 0.9)));
  }
}

// Brief (chunk) ladder: chunk_summary_brief → chunk_summary_detailed
// truncated → gap entry (no compression rung in this band's ladder). Every
// fallback rung is capped by the failure floor; the ready rung never is.
export function resolveBriefRepresentation(
  chunkId: string,
  lookup: DerivationLookup,
  briefBandBudget: number,
  material?: CompactChunkMaterialSnapshot,
): ResolvedRepresentation {
  const brief = lookup(chunkId, "chunk_summary_brief");
  if (usable(brief)) {
    return { derivationUsed: "chunk_summary_brief", body: brief.content, degraded: false, gap: false };
  }
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
      body: capFallbackBody(material.content, briefFallbackCapTokens(briefBandBudget)),
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

// The per-message line an excerpt or note renders — a compact, deterministic
// excerpt of the raw record (last-rung fallback, not the tail mapping).
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

// One selected subject → its band-entry text: any attached inter-turn notes
// (rule 6: rendered raw with the marker, immediately before the entry), then
// the representation body, [degraded: …] when a fallback rung rendered, or the
// gap line as the last rung. select.ts prices exactly this text in the fill
// walk; the band stores exactly this text.
export function renderArrangementEntry(
  subjectKind: "turn" | "chunk",
  _subjectId: string,
  rep: ResolvedRepresentation,
  noteTexts: readonly string[],
): string {
  const lines = noteTexts.map((text) => `[inter-turn note] ${text}`);
  if (rep.gap) {
    lines.push(`[${subjectKind} unavailable: ${rep.reason ?? "unknown"}]`);
  } else {
    const marker = rep.degraded ? `[degraded: ${rep.degradedMarker ?? rep.derivationUsed}]\n` : "";
    lines.push(`${marker}${rep.body}`);
  }
  return lines.join("\n");
}

// A band's snapshot bytes: its entries oldest-first, blank-line separated.
export function assembleBandText(entryTexts: readonly string[]): string {
  return entryTexts.join("\n\n");
}
