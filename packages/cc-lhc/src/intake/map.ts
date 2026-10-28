import type { EventKind, MessageEventInput } from "lhc";

import type {
  ContentBlock,
  ConversationMessage,
  RolloutLineItem,
  ToolResultBlock,
  ToolUseBlock,
} from "../rollout/types.js";

const HARNESS = "cc";

const SERVER_RESULT_TYPES = new Set([
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
]);

const META_MARKERS = ["<local-command-caveat>", "<command-name>", "<local-command-stdout>"] as const;

const TASK_NOTIFICATION_MARKER = "<task-notification>";
const RUNTIME_NOTE_LABEL = "[runtime note]";

// Claude Code appends a zero-usage assistant line ("No response requested.",
// model "<synthetic>") when it resumes a session whose last line is a user
// message. Rebuilt rollouts end on the swap-receipt runtime note, so every
// prune/compact swap produces one. It is harness chrome, not conversation —
// skipped and counted as meta so it never enters the thread record.
const SYNTHETIC_MODEL = "<synthetic>";
const SYNTHETIC_NO_RESPONSE_TEXT = "No response requested.";

export function isProductionAssistantFallbackOnly(item: RolloutLineItem): boolean {
  if (!isAssistantLine(item)) return false;
  const message = item.message;
  if (message === undefined) return false;
  const blocks = contentBlocks(message.content);
  if (blocks.length !== 1) return false;
  const block = blocks[0]!;
  if (!isRecord(block)) return false;
  const outerKeys = Object.keys(block).sort();
  if (outerKeys.length !== 3) return false;
  if (outerKeys[0] !== "from" || outerKeys[1] !== "to" || outerKeys[2] !== "type") return false;
  if (block.type !== "fallback") return false;
  const from = block.from;
  const to = block.to;
  if (!isRecord(from) || !isRecord(to)) return false;
  const fromKeys = Object.keys(from);
  const toKeys = Object.keys(to);
  if (fromKeys.length !== 1 || fromKeys[0] !== "model") return false;
  if (toKeys.length !== 1 || toKeys[0] !== "model") return false;
  if (typeof from.model !== "string" || from.model === "") return false;
  if (typeof to.model !== "string" || to.model === "") return false;
  if (typeof message.model !== "string" || message.model === "") return false;
  if (message.model !== to.model) return false;
  return true;
}

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

export function rolloutKeyPrefix(uuid: string): string {
  return `cc-lhc:rollout:${uuid}:`;
}

export function idempotencyKey(uuid: string, blockIndex: number, kind: EventKind): string {
  return `${rolloutKeyPrefix(uuid)}${blockIndex}:${kind}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function contentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlock => isRecord(block) && typeof block.type === "string");
}

function nonTextBlocks(content: unknown): ContentBlock[] | undefined {
  const blocks = contentBlocks(content);
  return blocks.some((block) => block.type !== "text") ? blocks : undefined;
}

function joinedText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

export function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function recordUuid(item: RolloutLineItem, lineIndex: number): string {
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
  extra: Record<string, unknown> = {},
): MessageEventInput {
  return {
    eventKind: kind,
    idempotencyKey: key,
    actor,
    harness: HARNESS,
    payload: { text, ...extra },
  } as MessageEventInput;
}

function messageModel(message: { model?: string } | undefined): string | undefined {
  const model = message?.model;
  return typeof model === "string" && model !== "" ? model : undefined;
}

export function messageProviderUsage(message: ConversationMessage | undefined): Record<string, unknown> | undefined {
  if (message === undefined) return undefined;
  const usage = (message as Record<string, unknown>).usage;
  if (usage === undefined || usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }
  return usage as Record<string, unknown>;
}

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
    const isError = block.is_error === true;
    const attached = nonTextBlocks(block.content);
    const content = attached === undefined ? stringifyToolResultContent(block.content) : joinedText(attached);
    events.push({
      eventKind: "tool_result",
      idempotencyKey: idempotencyKey(uuid, blockIndex, "tool_result"),
      actor: "tool",
      harness: HARNESS,
      payload: { toolCallId, content, isError, ...(attached === undefined ? {} : { blocks: attached }) },
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
  const text = joinedText(blocks);
  const attached = nonTextBlocks(blocks);
  const imageCount = attached === undefined ? 0 : 1;
  if (text === "" && attached === undefined) return { events: [], imageCount };
  const events = mapUserString(item, text, lineIndex);
  if (attached !== undefined) {
    for (const event of events) {
      if (event.eventKind === "user_prompt") event.payload = { ...event.payload, blocks: attached };
    }
  }
  return { events, imageCount };
}

function mapAssistant(item: RolloutLineItem, lineIndex: number): MessageEventInput[] {
  const message = item.message;
  if (message === undefined) return [];

  const uuid = recordUuid(item, lineIndex);
  const blocks = contentBlocks(message.content);
  const events: MessageEventInput[] = [];
  const model = messageModel(message);
  const providerUsage = messageProviderUsage(message);

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]!;
    if (block.type === "thinking") {
      const thinking = typeof block.thinking === "string" ? block.thinking : "";
      const signature = typeof block.signature === "string" ? block.signature : "";
      const extra: Record<string, unknown> = {};
      if (signature !== "") extra.signature = signature;
      if (model !== undefined) extra.model = model;
      events.push(
        textEvent(
          "assistant_thinking",
          thinking,
          "assistant",
          idempotencyKey(uuid, blockIndex, "assistant_thinking"),
          extra,
        ),
      );
      continue;
    }
    if (block.type === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      if (text === "") continue;
      const extra: Record<string, unknown> = {};
      if (model !== undefined) extra.model = model;
      if (providerUsage !== undefined) extra.providerUsage = providerUsage;
      events.push(
        textEvent("assistant_text", text, "assistant", idempotencyKey(uuid, blockIndex, "assistant_text"), extra),
      );
      continue;
    }
    if (block.type === "tool_use") {
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
      continue;
    }
    if (block.type === "redacted_thinking") {
      const extra: Record<string, unknown> = { block };
      if (model !== undefined) extra.model = model;
      events.push(
        textEvent("assistant_thinking", "", "assistant", idempotencyKey(uuid, blockIndex, "assistant_thinking"), extra),
      );
      continue;
    }
    if (block.type === "server_tool_use") {
      events.push({
        eventKind: "tool_call",
        idempotencyKey: idempotencyKey(uuid, blockIndex, "tool_call"),
        actor: "assistant",
        harness: HARNESS,
        payload: {
          toolCallId: String(block.id),
          toolName: String(block.name),
          arguments: isRecord(block.input) ? (block.input as Record<string, unknown>) : {},
          block,
        },
      });
      continue;
    }
    if (SERVER_RESULT_TYPES.has(block.type)) {
      const errored =
        isRecord(block.content) && typeof (block.content as Record<string, unknown>).error_code === "string";
      events.push({
        eventKind: "tool_result",
        idempotencyKey: idempotencyKey(uuid, blockIndex, "tool_result"),
        actor: "tool",
        harness: HARNESS,
        payload: { toolCallId: String(block.tool_use_id), content: "", isError: errored, blocks: [block] },
      });
    }
  }

  return events;
}

export function isSyntheticNoResponse(item: RolloutLineItem): boolean {
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

export function nativeCompactSummaryText(item: RolloutLineItem): string | null {
  if (item.type === "summary") {
    return typeof item.summary === "string" ? item.summary : "";
  }
  if (item.type !== "user" || item.isCompactSummary !== true) return null;
  const message = item.message;
  if (message === undefined || message.role !== "user") return null;
  return typeof message.content === "string" ? message.content : null;
}

export function isNativeCompactSummaryLine(item: RolloutLineItem): boolean {
  return nativeCompactSummaryText(item) !== null;
}

const NATIVE_COMPACT_SUMMARY_TAG = "claude-compact-summary";
const NATIVE_COMPACT_SUMMARY_MAX_CHARS = 2_000;
const NATIVE_COMPACT_SUMMARY_TRUNCATION_MARKER = "[... remainder of summary truncated]";

export function nativeCompactSummaryContent(summary: string): string {
  const points = Array.from(summary);
  const truncated = points.length > NATIVE_COMPACT_SUMMARY_MAX_CHARS;
  const body = truncated ? points.slice(0, NATIVE_COMPACT_SUMMARY_MAX_CHARS).join("") : summary;
  const parts = [`<${NATIVE_COMPACT_SUMMARY_TAG}>`, body];
  if (truncated) parts.push(NATIVE_COMPACT_SUMMARY_TRUNCATION_MARKER);
  parts.push(`</${NATIVE_COMPACT_SUMMARY_TAG}>`);
  return parts.join("\n");
}

function nativeCompactSummaryUuid(item: RolloutLineItem, lineIndex: number): string {
  const leaf = item.leafUuid;
  if (typeof leaf === "string" && leaf !== "") return `summary:${leaf}`;
  return recordUuid(item, lineIndex);
}

function mapNativeCompactSummary(item: RolloutLineItem, lineIndex: number, summary: string): MessageEventInput[] {
  const uuid = nativeCompactSummaryUuid(item, lineIndex);
  return [
    textEvent("user_prompt", nativeCompactSummaryContent(summary), "user", idempotencyKey(uuid, 0, "user_prompt")),
    {
      eventKind: "turn_end",
      idempotencyKey: idempotencyKey(uuid, 0, "turn_end"),
      actor: "system",
      harness: HARNESS,
      payload: { outcome: "completed", outcomeReason: "claude_native_compact_summary" },
    },
  ];
}

// Known housekeeping record types from the supported Claude Code corpus
// (2.1.215–2.1.226 census). Counted as meta so skipped_unknown remains a
// meaningful drift gauge for truly unrecognized shapes.
const META_LINE_TYPES = new Set([
  "file-history-snapshot",
  "queue-operation",
  "attachment",
  "ai-title",
  "custom-title",
  "last-prompt",
  "mode",
  "permission-mode",
  "file-history-delta",
  "agent-name",
]);

function isMetaLineType(item: RolloutLineItem): boolean {
  if (typeof item.type === "string" && META_LINE_TYPES.has(item.type)) return true;
  if (item.attachment !== undefined) return true;
  if (item.type === "system") return true;
  return false;
}

export function mapRolloutLine(item: RolloutLineItem, lineIndex = 0): MapResult {
  const stats = emptyStats();

  if (item.isSidechain === true) {
    stats.sidechain += 1;
    return { events: [], stats };
  }

  const nativeSummary = nativeCompactSummaryText(item);
  if (nativeSummary !== null) {
    return { events: mapNativeCompactSummary(item, lineIndex, nativeSummary), stats };
  }

  if (isMetaLineType(item)) {
    stats.meta += 1;
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
    if (isProductionAssistantFallbackOnly(item)) {
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

export interface RolloutChain {
  parents: Map<string, { parent: string | null; live: boolean }>;
  tip: string | null;
}

export type ChainStep = { kind: "append" } | { kind: "rewind"; keptUuid: string | null; hopUuid: string };

export function createRolloutChain(): RolloutChain {
  return { parents: new Map(), tip: null };
}

function opensUserTurn(item: RolloutLineItem): boolean {
  if (!isUserLine(item)) return false;
  const content = item.message?.content;
  return !contentBlocks(content).some((block) => block.type === "tool_result");
}

// Claude Code 2.1.310 writes a rewind ("Restore conversation") as nothing on
// disk until the next prompt, which then names an earlier record as its parent.
// Parallel tool calls stay linear, so only a user turn opener can branch.
export function foldRolloutChain(chain: RolloutChain, item: RolloutLineItem, live: boolean): ChainStep {
  const uuid = item.uuid;
  if (item.isSidechain === true || typeof uuid !== "string" || uuid === "") return { kind: "append" };
  const parent = typeof item.parentUuid === "string" && item.parentUuid !== "" ? item.parentUuid : null;
  const rewound =
    chain.tip !== null &&
    item.parentUuid !== undefined &&
    parent !== chain.tip &&
    (parent === null || chain.parents.has(parent)) &&
    opensUserTurn(item);
  chain.parents.set(uuid, { parent, live });
  chain.tip = uuid;
  return rewound ? { kind: "rewind", keptUuid: parent, hopUuid: uuid } : { kind: "append" };
}

export function liveAncestry(chain: RolloutChain, from: string | null): string[] {
  const ancestry: string[] = [];
  let cursor = from;
  while (cursor !== null) {
    const entry = chain.parents.get(cursor);
    if (entry === undefined || !entry.live) break;
    ancestry.push(cursor);
    cursor = entry.parent;
  }
  return ancestry;
}

export function rewindRollbackEvent(hopUuid: string, keepThroughEventOrder: number): MessageEventInput {
  return {
    eventKind: "rollback",
    idempotencyKey: idempotencyKey(hopUuid, 0, "rollback"),
    actor: "user",
    harness: HARNESS,
    payload: { keepThroughEventOrder, reason: "claude_rewind" },
  };
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
