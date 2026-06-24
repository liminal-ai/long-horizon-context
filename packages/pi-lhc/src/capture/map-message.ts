import type { EventKind, MessageEventInput } from "lhc";
import type {
  AgentMessage,
  AssistantMessage,
  ContentPart,
  FileRefPart,
  ImagePart,
  ToolResultMessage,
  UserMessage,
} from "../pi/types.js";
import { eventKey } from "./idempotency.js";

// Pure mapping: one PI `AgentMessage` to the ordered LHC events for it. A user
// message → one `user_prompt`; an assistant
// message fans out `assistant_thinking` (if present) → `assistant_text` (if
// present) → one `tool_call` per call, in that order; a tool result → one
// `tool_result` correlated by `toolCallId`, carrying `isError`. Unsupported
// parts and a wholly-empty message degrade to a `runtime_note` (never a silent
// drop). A graceful interrupt carries its disposition through on a trailing
// `runtime_note`.

export interface MapCtx {
  piSessionId: string;
  entryId?: string | undefined;
  fallbackId?: string | undefined;
}

const HARNESS = "pi";

/** The aborted-disposition note text. A graceful interrupt has no intake-schema
 *  field to hold its disposition, so the mapper carries `stopReason` through on
 *  the one durable vehicle — a `runtime_note` — rather than discarding it.
 *  Exported so the aborted corpus fixture stays in lock-step with the mapper. */
export const ABORTED_DISPOSITION_TEXT = "turn aborted (stopReason: aborted) — partial content preserved";

const EMPTY_MESSAGE_NOTE = "message omitted: no mappable content parts";

function partsOf(msg: AgentMessage): ContentPart[] {
  switch (msg.role) {
    case "user":
      return typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content;
    case "assistant":
    case "toolResult":
      return msg.content;
  }
}

function textOf(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function thinkingOf(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: "thinking" }> => p.type === "thinking")
    .map((p) => p.thinking)
    .join("");
}

function unsupportedOf(parts: ContentPart[]): Array<ImagePart | FileRefPart> {
  return parts.filter((p): p is ImagePart | FileRefPart => p.type === "image" || p.type === "fileRef");
}

function omissionText(part: ImagePart | FileRefPart): string {
  return part.type === "image"
    ? `unsupported content omitted: image part${part.mimeType !== undefined ? ` (${part.mimeType})` : ""}`
    : `unsupported content omitted: file reference (${part.path})`;
}

function buildKey(
  ctx: MapCtx,
  role: string,
  kind: EventKind,
  blockIndex: number,
  opts: {
    entryId?: string | undefined;
    responseId?: string | undefined;
    toolCallId?: string | undefined;
    content?: string | undefined;
  } = {},
): string {
  return eventKey({
    piSessionId: ctx.piSessionId,
    entryId: opts.entryId ?? ctx.entryId,
    responseId: opts.responseId,
    blockIndex,
    kind,
    role,
    fallbackId: ctx.fallbackId,
    toolCallId: opts.toolCallId,
    content: opts.content,
  });
}

function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null || !(field in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" && candidate !== "" ? candidate : undefined;
}

function responseIdOf(msg: AgentMessage): string | undefined {
  return stringField(msg, "responseId") ?? stringField(msg, "id");
}

// Per-kind builders — explicit eventKind literals so the discriminated union
// narrows without a cast.
function textEvent(
  kind: "user_prompt" | "assistant_text" | "assistant_thinking" | "runtime_note",
  text: string,
  actor: string,
  key: string,
): MessageEventInput {
  return { eventKind: kind, idempotencyKey: key, actor, harness: HARNESS, payload: { text } };
}

function toolCallEvent(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): MessageEventInput {
  return {
    eventKind: "tool_call",
    idempotencyKey: key,
    actor: "assistant",
    harness: HARNESS,
    payload: { toolCallId, toolName, arguments: args },
  };
}

function toolResultEvent(toolCallId: string, content: string, isError: boolean, key: string): MessageEventInput {
  return {
    eventKind: "tool_result",
    idempotencyKey: key,
    actor: "tool",
    harness: HARNESS,
    payload: { toolCallId, content, isError },
  };
}

function mapUser(msg: UserMessage, ctx: MapCtx): MessageEventInput[] {
  const events: MessageEventInput[] = [];
  const parts = partsOf(msg);
  let block = 0;
  if (parts.some((p) => p.type === "text")) {
    const text = textOf(parts);
    events.push(textEvent("user_prompt", text, "user", buildKey(ctx, "user", "user_prompt", block, { content: text })));
    block += 1;
  }
  for (const part of unsupportedOf(parts)) {
    const text = omissionText(part);
    events.push(
      textEvent("runtime_note", text, "system", buildKey(ctx, "user", "runtime_note", block, { content: text })),
    );
    block += 1;
  }
  if (events.length === 0) {
    events.push(
      textEvent(
        "runtime_note",
        EMPTY_MESSAGE_NOTE,
        "system",
        buildKey(ctx, "user", "runtime_note", block, { content: "empty:user" }),
      ),
    );
  }
  return events;
}

function mapAssistant(msg: AssistantMessage, ctx: MapCtx): MessageEventInput[] {
  const events: MessageEventInput[] = [];
  const responseId = responseIdOf(msg);
  const parts = partsOf(msg);
  let block = 0;
  // PI's confirmed part order: thinking → text → tool calls (research §5a).
  if (parts.some((p) => p.type === "thinking")) {
    const text = thinkingOf(parts);
    events.push(
      textEvent(
        "assistant_thinking",
        text,
        "assistant",
        buildKey(ctx, "assistant", "assistant_thinking", block, { responseId, content: text }),
      ),
    );
    block += 1;
  }
  if (parts.some((p) => p.type === "text")) {
    const text = textOf(parts);
    events.push(
      textEvent(
        "assistant_text",
        text,
        "assistant",
        buildKey(ctx, "assistant", "assistant_text", block, { responseId, content: text }),
      ),
    );
    block += 1;
  }
  for (const part of parts) {
    if (part.type !== "toolCall") continue;
    events.push(
      toolCallEvent(
        part.id,
        part.name,
        part.arguments,
        buildKey(ctx, "assistant", "tool_call", block, {
          responseId,
          toolCallId: part.id,
          content: part.name,
        }),
      ),
    );
    block += 1;
  }
  for (const part of unsupportedOf(parts)) {
    const text = omissionText(part);
    events.push(
      textEvent(
        "runtime_note",
        text,
        "system",
        buildKey(ctx, "assistant", "runtime_note", block, { responseId, content: text }),
      ),
    );
    block += 1;
  }
  // Graceful interrupt: carry the aborted disposition through (never discarded).
  if (msg.stopReason === "aborted") {
    events.push(
      textEvent(
        "runtime_note",
        ABORTED_DISPOSITION_TEXT,
        "system",
        buildKey(ctx, "assistant", "runtime_note", block, { responseId, content: ABORTED_DISPOSITION_TEXT }),
      ),
    );
    block += 1;
  }
  if (events.length === 0) {
    events.push(
      textEvent(
        "runtime_note",
        EMPTY_MESSAGE_NOTE,
        "system",
        buildKey(ctx, "assistant", "runtime_note", block, { responseId, content: "empty:assistant" }),
      ),
    );
  }
  return events;
}

function mapToolResult(msg: ToolResultMessage, ctx: MapCtx): MessageEventInput[] {
  const events: MessageEventInput[] = [];
  const parts = partsOf(msg);
  const content = textOf(parts);
  const isError = msg.isError === true;
  // Correlation is by toolCallId, not arrival order; the error flag and content
  // are always captured, even on failure.
  events.push(
    toolResultEvent(
      msg.toolCallId,
      content,
      isError,
      buildKey(ctx, "toolResult", "tool_result", 0, { toolCallId: msg.toolCallId, content }),
    ),
  );
  let block = 1;
  for (const [partIndex, part] of unsupportedOf(parts).entries()) {
    const text = omissionText(part);
    events.push(
      textEvent(
        "runtime_note",
        text,
        "system",
        buildKey(ctx, "toolResult", "runtime_note", block, {
          toolCallId: `${msg.toolCallId}:omission:${partIndex}`,
          content: text,
        }),
      ),
    );
    block += 1;
  }
  return events;
}

export function mapMessage(msg: AgentMessage, ctx: MapCtx): MessageEventInput[] {
  switch (msg.role) {
    case "user":
      return mapUser(msg, ctx);
    case "assistant":
      return mapAssistant(msg, ctx);
    case "toolResult":
      return mapToolResult(msg, ctx);
    default:
      throw new Error(`unmappable PI message role: ${String((msg as { role?: unknown }).role)}`);
  }
}
