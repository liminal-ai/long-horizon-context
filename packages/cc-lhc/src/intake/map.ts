import type { EventKind, MessageEventInput } from "lhc";

import type { ContentBlock, RolloutLineItem, ToolResultBlock, ToolUseBlock } from "../rollout/types.js";

const HARNESS = "cc";
const IMAGE_PLACEHOLDER = "[image content not captured]";

const META_MARKERS = ["<local-command-caveat>", "<command-name>", "<local-command-stdout>"] as const;

// Background-task notifications are machine traffic injected as user messages.
// They stay in the record (the assistant's next turn responds to them) but as
// runtime_note, so they skip prompt smoothing and stay out of the user lane.
// Rebuilt rollouts re-serve runtime notes with the "[runtime note]" label; the
// mapper recognizes that label AND strips it, so the stored payload is always
// the canonical note text — labels never stack across prune cycles, and the
// replay signature of a re-tailed note matches the originally captured event.
const TASK_NOTIFICATION_MARKER = "<task-notification>";
const RUNTIME_NOTE_LABEL = "[runtime note]";

// Claude Code appends a zero-usage assistant line ("No response requested.",
// model "<synthetic>") when it resumes a session whose last line is a user
// message. Rebuilt rollouts end on the swap-receipt runtime note, so every
// prune/compact swap produces one. It is harness chrome, not conversation —
// skipped and counted as meta so it never enters the thread record.
const SYNTHETIC_MODEL = "<synthetic>";
const SYNTHETIC_NO_RESPONSE_TEXT = "No response requested.";

export interface MapStats {
  sidechain: number;
  unknown: number;
  meta: number;
  image: number;
}

export interface MapResult {
  events: MessageEventInput[];
  stats: MapStats;
}

function emptyStats(): MapStats {
  return { sidechain: 0, unknown: 0, meta: 0, image: 0 };
}

export function idempotencyKey(uuid: string, blockIndex: number, kind: EventKind): string {
  return `cc-lhc:rollout:${uuid}:${blockIndex}:${kind}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function contentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlock => isRecord(block) && typeof block.type === "string");
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function recordUuid(item: RolloutLineItem, lineIndex: number): string {
  if (typeof item.uuid === "string" && item.uuid !== "") return item.uuid;
  const sessionId = typeof item.sessionId === "string" ? item.sessionId : "no-session";
  const type = typeof item.type === "string" ? item.type : "no-type";
  return `synthetic:${sessionId}:${type}:${lineIndex}`;
}

function isMetaUserContent(content: string): boolean {
  return META_MARKERS.some((marker) => content.includes(marker));
}

export function isMetaUserLine(item: RolloutLineItem, content: string): boolean {
  if (item.isMeta === true) return true;
  return isMetaUserContent(content);
}

function textEvent(
  kind: "user_prompt" | "assistant_text" | "assistant_thinking" | "runtime_note",
  text: string,
  actor: string,
  key: string,
): MessageEventInput {
  return { eventKind: kind, idempotencyKey: key, actor, harness: HARNESS, payload: { text } };
}

/** Canonical runtime-note text, or null when the text is a regular prompt. */
export function runtimeNoteText(text: string): string | null {
  const trimmed = text.trimStart();
  if (trimmed.startsWith(TASK_NOTIFICATION_MARKER)) return text;
  if (trimmed.startsWith(RUNTIME_NOTE_LABEL)) {
    const stripped = trimmed.slice(RUNTIME_NOTE_LABEL.length);
    return stripped.startsWith(" ") ? stripped.slice(1) : stripped;
  }
  return null;
}

function mapUserString(item: RolloutLineItem, text: string, lineIndex: number): MessageEventInput[] {
  const uuid = recordUuid(item, lineIndex);
  const noteText = runtimeNoteText(text);
  if (noteText !== null) {
    return [textEvent("runtime_note", noteText, "system", idempotencyKey(uuid, 0, "runtime_note"))];
  }
  return [textEvent("user_prompt", text, "user", idempotencyKey(uuid, 0, "user_prompt"))];
}

function mapUserToolResults(item: RolloutLineItem, blocks: ToolResultBlock[], lineIndex: number): MessageEventInput[] {
  const uuid = recordUuid(item, lineIndex);
  const events: MessageEventInput[] = [];
  let blockIndex = 0;
  for (const block of blocks) {
    const toolCallId = block.tool_use_id;
    const content = stringifyToolResultContent(block.content);
    const isError = block.is_error === true;
    events.push({
      eventKind: "tool_result",
      idempotencyKey: idempotencyKey(uuid, blockIndex, "tool_result"),
      actor: "tool",
      harness: HARNESS,
      payload: { toolCallId, content, isError },
    });
    blockIndex += 1;
  }
  return events;
}

function mapUserTextBlocks(
  item: RolloutLineItem,
  blocks: ContentBlock[],
  lineIndex: number,
): { events: MessageEventInput[]; imageCount: number } {
  let text = blocks
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
  const hasImage = blocks.some((block) => block.type === "image");
  let imageCount = 0;
  if (hasImage) {
    imageCount = 1;
    if (text !== "") text += "\n";
    text += IMAGE_PLACEHOLDER;
  }
  if (text === "") return { events: [], imageCount };
  return { events: mapUserString(item, text, lineIndex), imageCount };
}

function mapAssistant(item: RolloutLineItem, lineIndex: number): MessageEventInput[] {
  const message = item.message;
  if (message === undefined) return [];

  const uuid = recordUuid(item, lineIndex);
  const blocks = contentBlocks(message.content);
  const events: MessageEventInput[] = [];
  let blockIndex = 0;

  for (const block of blocks) {
    if (block.type === "thinking") {
      const thinking = typeof block.thinking === "string" ? block.thinking : "";
      if (thinking !== "") {
        events.push(
          textEvent(
            "assistant_thinking",
            thinking,
            "assistant",
            idempotencyKey(uuid, blockIndex, "assistant_thinking"),
          ),
        );
        blockIndex += 1;
      }
    }
  }

  for (const block of blocks) {
    if (block.type === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      if (text !== "") {
        events.push(textEvent("assistant_text", text, "assistant", idempotencyKey(uuid, blockIndex, "assistant_text")));
        blockIndex += 1;
      }
    }
  }

  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const toolBlock = block as ToolUseBlock;
    const toolCallId = toolBlock.id;
    const toolName = toolBlock.name;
    const args = isRecord(toolBlock.input) ? toolBlock.input : {};
    events.push({
      eventKind: "tool_call",
      idempotencyKey: idempotencyKey(uuid, blockIndex, "tool_call"),
      actor: "assistant",
      harness: HARNESS,
      payload: { toolCallId, toolName, arguments: args },
    });
    blockIndex += 1;
  }

  return events;
}

function isSyntheticNoResponse(item: RolloutLineItem): boolean {
  const message = item.message;
  if (message === undefined || message.model !== SYNTHETIC_MODEL) return false;
  const blocks = contentBlocks(message.content);
  return blocks.length === 1 && blocks[0]!.type === "text" && blocks[0]!.text === SYNTHETIC_NO_RESPONSE_TEXT;
}

export function isUserLine(item: RolloutLineItem): boolean {
  if (item.type === "user") return true;
  return item.message?.role === "user";
}

export function isAssistantLine(item: RolloutLineItem): boolean {
  if (item.type === "assistant") return true;
  return item.message?.role === "assistant";
}

function skipType(item: RolloutLineItem): boolean {
  const type = item.type;
  return type === "summary" || type === "file-history-snapshot";
}

export function mapRolloutLine(item: RolloutLineItem, lineIndex = 0): MapResult {
  const stats = emptyStats();

  if (item.isSidechain === true) {
    stats.sidechain += 1;
    return { events: [], stats };
  }

  if (skipType(item)) {
    stats.unknown += 1;
    return { events: [], stats };
  }

  if (isUserLine(item)) {
    const message = item.message;
    if (message === undefined) {
      stats.unknown += 1;
      return { events: [], stats };
    }

    const content = message.content;
    if (typeof content === "string") {
      if (isMetaUserLine(item, content)) {
        stats.meta += 1;
        return { events: [], stats };
      }
      return { events: mapUserString(item, content, lineIndex), stats };
    }

    const blocks = contentBlocks(content);
    const toolResults = blocks.filter((block): block is ToolResultBlock => block.type === "tool_result");
    if (toolResults.length > 0) {
      return { events: mapUserToolResults(item, toolResults, lineIndex), stats };
    }

    const textParts = blocks
      .filter((block) => block.type === "text")
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .join("");
    if (isMetaUserLine(item, textParts)) {
      stats.meta += 1;
      return { events: [], stats };
    }

    const mapped = mapUserTextBlocks(item, blocks, lineIndex);
    stats.image += mapped.imageCount;
    if (mapped.events.length > 0) {
      return { events: mapped.events, stats };
    }

    stats.unknown += 1;
    return { events: [], stats };
  }

  if (isAssistantLine(item)) {
    if (isSyntheticNoResponse(item)) {
      stats.meta += 1;
      return { events: [], stats };
    }
    const events = mapAssistant(item, lineIndex);
    if (events.length === 0) {
      stats.unknown += 1;
    }
    return { events, stats };
  }

  stats.unknown += 1;
  return { events: [], stats };
}

export function mapRolloutLines(items: readonly RolloutLineItem[]): MapResult & { events: MessageEventInput[] } {
  const combined: MessageEventInput[] = [];
  const stats = emptyStats();

  for (const [lineIndex, item] of items.entries()) {
    const mapped = mapRolloutLine(item, lineIndex);
    combined.push(...mapped.events);
    stats.sidechain += mapped.stats.sidechain;
    stats.unknown += mapped.stats.unknown;
    stats.meta += mapped.stats.meta;
    stats.image += mapped.stats.image;
  }

  return { events: combined, stats };
}
