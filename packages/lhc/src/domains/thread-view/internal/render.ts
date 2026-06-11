// Tail and band formatting (Story 1): the seven-kind tail mapping table
// (tech design §Tail message rendering — contract, not implementation
// choice), short/full tool-result selection by boundary position, and the
// short-form ladder (ready summary → deterministic truncation). Pure
// functions over read state by design: no DB handle, no provider, no clock —
// determinism is structural (AC-1.7 byte-identical pulls fall out of it).
//
// Story 2 adds the band-entry side: the degrade ladders (tech design
// §Degrade ladders), gap entries as the last rung (never absence, AC-2.5),
// visible subject keys (§t12 / §c4, AC-2.10), the [degraded: …] and
// [inter-turn note] markers, and band-text assembly. select.ts consumes the
// same entry renderer to price entries during the fill walk, so the tokens
// the walk budgets are the tokens the band stores — one renderer, no drift.
import type { Band, ViewMessage } from "../../../shared/view.js";
import type { TailMessageRow } from "./snapshot.js";

// Epic 01's deterministic abbreviation rule: a fixed prefix plus an exact
// tail marker, a pure function of the input string alone. Restated here —
// byte-identical to turns/internal/compose.ts's truncateForFallback —
// because cross-domain internals may not be imported and the turns domain
// is frozen for this epic (tech design §Top-Tier Surfaces: no changes).
export const ABBREVIATION_LIMIT = 200;

export function deterministicTruncation(text: string): string {
  if (text.length <= ABBREVIATION_LIMIT) return text;
  const dropped = text.length - ABBREVIATION_LIMIT;
  return `${text.slice(0, ABBREVIATION_LIMIT)}… [truncated ${dropped} chars]`;
}

function blockContent(message: TailMessageRow): Record<string, unknown> {
  return message.blocks[0]?.content ?? {};
}

function textOf(message: TailMessageRow): string {
  const text = blockContent(message)["text"];
  return typeof text === "string" ? text : "";
}

// What the tail renderer needs beyond the message itself: the boundary
// position (short/full selection), the call-id → tool-name pairing (results
// carry only their call id), and the ready tool-result summaries (the
// short-form ladder's first rung).
export interface TailRenderContext {
  boundaryPosition: number;
  toolNameByCallId: ReadonlyMap<string, string>;
  toolResultSummaries: ReadonlyMap<string, string>;
}

// The call-id → tool-name map from the messages in hand. Pairing within the
// tail is structurally sufficient: the compact point snaps to a turn start,
// so a tail result's call is never behind it.
export function toolNamesByCallId(
  messages: readonly TailMessageRow[],
): Map<string, string> {
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

function renderToolCall(message: TailMessageRow): ViewMessage {
  const block = blockContent(message);
  const name = typeof block["toolName"] === "string" ? block["toolName"] : "unknown_tool";
  // Deterministic arg rendering: the projected arguments serialized verbatim,
  // oversized args abbreviated by the same Epic 01 rule.
  const args = deterministicTruncation(JSON.stringify(block["arguments"] ?? {}));
  return { role: "assistant", content: `[tool call · ${name}] ${args}` };
}

function renderToolResult(message: TailMessageRow, ctx: TailRenderContext): ViewMessage {
  const block = blockContent(message);
  const callId = block["toolCallId"];
  const name =
    (typeof callId === "string" ? ctx.toolNameByCallId.get(callId) : undefined) ??
    "unknown_tool";
  const content = typeof block["content"] === "string" ? block["content"] : "";
  if (message.sourceEventOrder > ctx.boundaryPosition) {
    return { role: "user", content: `[tool result · ${name}]\n${content}` };
  }
  // At-or-behind the boundary: the short-form ladder — the ready summary
  // when usable, else deterministic truncation of the raw content (AC-4.2's
  // vocabulary; the default-boundary leg lands here in Story 1). Short-form
  // rendering marks that fuller content exists in the record.
  const short = ctx.toolResultSummaries.get(message.messageId) ?? deterministicTruncation(content);
  return {
    role: "user",
    content: `[tool result · ${name} · abridged]\n${short} [full content in record §${message.messageId}]`,
  };
}

// One tail message → one ViewMessage per the mapping table. Each kind is its
// own arm so a single kind's drift fails its own named test leg.
export function renderTailMessage(
  message: TailMessageRow,
  ctx: TailRenderContext,
): ViewMessage {
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
  }
}

// One non-empty band → one labeled `user` message: band-marker header, then
// the snapshot bytes verbatim (AC-5.1 resolution: provider APIs reject
// unknown roles; `user` is what the MVP's injection used).
export function renderBandMessage(band: Band, renderedText: string): ViewMessage {
  return { role: "user", band, content: `[context · ${band}]\n${renderedText}` };
}

// ── band entries: degrade ladders, gaps, keys (Story 2) ──────────

// One derived form's stored state as the ladder reads it (a projection of
// DerivedForm: the resolvers never write, never re-derive).
export interface FormSnapshot {
  state: "pending" | "ready" | "failed" | "blocked";
  content?: string;
  reason?: string;
}

export type FormLookup = (subjectId: string, form: string) => FormSnapshot | undefined;

// A subject's resolved representation: which rung of its ladder renders.
// `formUsed` is the arrangement/receipt vocabulary; `degradedMarker` is the
// rendered [degraded: …] text for fallback rungs.
export interface ResolvedRepresentation {
  formUsed: string;
  body: string;
  degraded: boolean;
  gap: boolean;
  degradedMarker?: string;
  reason?: string;
}

function usable(form: FormSnapshot | undefined): form is FormSnapshot & { content: string } {
  // "Usable" means state = ready (tech design §Degrade ladders).
  return form?.state === "ready" && typeof form.content === "string";
}

function ladderState(form: FormSnapshot | undefined): string {
  return form === undefined ? "absent" : form.state;
}

// Smooth (turn) ladder: turn_rendering → lower_band_projection →
// deterministic excerpt of the turn's live messages → gap entry.
export function resolveSmoothRepresentation(
  turnId: string,
  lookup: FormLookup,
  excerpt: string | null,
): ResolvedRepresentation {
  const rendering = lookup(turnId, "turn_rendering");
  if (usable(rendering)) {
    return { formUsed: "turn_rendering", body: rendering.content, degraded: false, gap: false };
  }
  const projection = lookup(turnId, "lower_band_projection");
  if (usable(projection)) {
    return {
      formUsed: "lower_band_projection",
      body: projection.content,
      degraded: true,
      gap: false,
      degradedMarker: "smooth-from-projection",
    };
  }
  if (excerpt !== null) {
    return {
      formUsed: "message_excerpt",
      body: deterministicTruncation(excerpt),
      degraded: true,
      gap: false,
      degradedMarker: "smooth-from-excerpt",
    };
  }
  return {
    formUsed: "gap",
    body: "",
    degraded: false,
    gap: true,
    reason: `no usable form (turn_rendering: ${ladderState(rendering)}, lower_band_projection: ${ladderState(projection)}, no live messages)`,
  };
}

// Detailed (chunk) ladder: chunk_summary_detailed → chunk_summary_brief →
// concatenated member projections (truncated, marked) → gap entry.
export function resolveDetailedRepresentation(
  chunkId: string,
  lookup: FormLookup,
  memberProjections: readonly string[],
): ResolvedRepresentation {
  const detailed = lookup(chunkId, "chunk_summary_detailed");
  if (usable(detailed)) {
    return { formUsed: "chunk_summary_detailed", body: detailed.content, degraded: false, gap: false };
  }
  const brief = lookup(chunkId, "chunk_summary_brief");
  if (usable(brief)) {
    return {
      formUsed: "chunk_summary_brief",
      body: brief.content,
      degraded: true,
      gap: false,
      degradedMarker: "detailed-from-brief",
    };
  }
  if (memberProjections.length > 0) {
    return {
      formUsed: "member_projections",
      body: deterministicTruncation(memberProjections.join("\n")),
      degraded: true,
      gap: false,
      degradedMarker: "detailed-from-projections",
    };
  }
  return {
    formUsed: "gap",
    body: "",
    degraded: false,
    gap: true,
    reason: `no usable form (chunk_summary_detailed: ${ladderState(detailed)}, chunk_summary_brief: ${ladderState(brief)}, member projections ready: 0)`,
  };
}

// Brief (chunk) ladder: chunk_summary_brief → chunk_summary_detailed
// truncated → gap entry (no projections rung in this band's ladder).
export function resolveBriefRepresentation(
  chunkId: string,
  lookup: FormLookup,
): ResolvedRepresentation {
  const brief = lookup(chunkId, "chunk_summary_brief");
  if (usable(brief)) {
    return { formUsed: "chunk_summary_brief", body: brief.content, degraded: false, gap: false };
  }
  const detailed = lookup(chunkId, "chunk_summary_detailed");
  if (usable(detailed)) {
    return {
      formUsed: "chunk_summary_detailed_truncated",
      body: deterministicTruncation(detailed.content),
      degraded: true,
      gap: false,
      degradedMarker: "brief-from-detailed",
    };
  }
  return {
    formUsed: "gap",
    body: "",
    degraded: false,
    gap: true,
    reason: `no usable form (chunk_summary_brief: ${ladderState(brief)}, chunk_summary_detailed: ${ladderState(detailed)}, member projections ready: 0)`,
  };
}

// The per-message line an excerpt or note renders — a compact, deterministic
// projection of the raw record (last-rung fallback, not the tail mapping).
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
// the keyed entry — §key, [degraded: …] when a fallback rung rendered, or the
// gap line as the last rung. select.ts prices exactly this text in the fill
// walk; the band stores exactly this text.
export function renderArrangementEntry(
  subjectKind: "turn" | "chunk",
  subjectId: string,
  rep: ResolvedRepresentation,
  noteTexts: readonly string[],
): string {
  const lines = noteTexts.map((text) => `[inter-turn note] ${text}`);
  if (rep.gap) {
    lines.push(`§${subjectId} [${subjectKind} ${subjectId} unavailable: ${rep.reason ?? "unknown"}]`);
  } else {
    const marker = rep.degraded ? ` [degraded: ${rep.degradedMarker ?? rep.formUsed}]` : "";
    lines.push(`§${subjectId}${marker}\n${rep.body}`);
  }
  return lines.join("\n");
}

// A band's snapshot bytes: its entries oldest-first, blank-line separated.
export function assembleBandText(entryTexts: readonly string[]): string {
  return entryTexts.join("\n\n");
}
