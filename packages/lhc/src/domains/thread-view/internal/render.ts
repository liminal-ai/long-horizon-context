// Tail and band formatting (Story 1): the seven-kind tail mapping table
// (tech design §Tail message rendering — contract, not implementation
// choice), short/full tool-result selection by boundary position, and the
// short-form ladder (ready summary → deterministic truncation). Pure
// functions over read state by design: no DB handle, no provider, no clock —
// determinism is structural (AC-1.7 byte-identical pulls fall out of it).
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
