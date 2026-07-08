import { createHash } from "node:crypto";

import type { EventKind, MessageEventInput } from "lhc";

import type { ContentBlock, RolloutLineItem } from "../rollout/types.js";

export const CODEX_HARNESS_ID = "codex";

const IMAGE_PLACEHOLDER = "[image content not captured]";
const RUNTIME_NOTE_LABEL = "[runtime note]";
const COMPACTED_NOTE = "Codex native compaction occurred.";

// Codex delivers session bootstrap (AGENTS.md instructions, user_instructions,
// environment context) as user-role response_item messages. They are harness
// scaffolding, not conversation: keep them in the record as runtime notes so
// they stay out of the user-prompt lane (no smoothing, no prompt semantics).
const BOOTSTRAP_PREFIXES = ["# AGENTS.md instructions", "<user_instructions>", "<environment_context>", "<INSTRUCTIONS>"];

function isBootstrapInstructionText(text: string): boolean {
  const trimmed = text.trimStart();
  return BOOTSTRAP_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

type TextEventKind = "user_prompt" | "assistant_text" | "assistant_thinking" | "runtime_note";

export interface CodexSessionInfo {
  id?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  originator?: string;
  source?: unknown;
}

export interface MapStats {
  /** Compatibility bucket consumed by the copied capture session. */
  sidechain: number;
  /** Compatibility bucket for non-content skipped rollout records. */
  unknown: number;
  /** Compatibility bucket for bootstrap/meta records skipped as non-conversation. */
  meta: number;
  /** Number of image content items represented by placeholders. */
  image: number;

  sessionMeta: number;
  embeddedSessionMeta: number;
  turnContext: number;
  eventMsg: number;
  developerMessage: number;
  systemMessage: number;
  encryptedReasoning: number;
  compacted: number;
  unrecognizedResponseItem: number;
  emptyMessage: number;
}

export interface MapResult {
  events: MessageEventInput[];
  stats: MapStats;
  sessionInfo?: CodexSessionInfo;
}

function emptyStats(): MapStats {
  return {
    sidechain: 0,
    unknown: 0,
    meta: 0,
    image: 0,
    sessionMeta: 0,
    embeddedSessionMeta: 0,
    turnContext: 0,
    eventMsg: 0,
    developerMessage: 0,
    systemMessage: 0,
    encryptedReasoning: 0,
    compacted: 0,
    unrecognizedResponseItem: 0,
    emptyMessage: 0,
  };
}

export function idempotencyKey(lineId: string, blockIndex: number, kind: EventKind): string {
  return `codex-lhc:rollout:${lineId}:${blockIndex}:${kind}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function contentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlock => isRecord(block) && typeof block.type === "string");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  const entries = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24);
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function rolloutPayload(item: RolloutLineItem): Record<string, unknown> | undefined {
  return isRecord(item.payload) ? item.payload : undefined;
}

export function rolloutLineId(item: RolloutLineItem): string {
  const payload = rolloutPayload(item);
  if (payload !== undefined) {
    const id = stringField(payload, "id");
    if (id !== undefined) return id;
    const callId = stringField(payload, "call_id");
    if (callId !== undefined) return callId;
  }
  return fingerprint(item);
}

function syntheticCallId(item: RolloutLineItem): string {
  return `synthetic:${fingerprint(item)}`;
}

function toolCallId(payload: Record<string, unknown>, item: RolloutLineItem): string {
  return stringField(payload, "call_id") ?? syntheticCallId(item);
}

function textEvent(kind: TextEventKind, text: string, actor: string, key: string): MessageEventInput {
  return { eventKind: kind, idempotencyKey: key, actor, harness: CODEX_HARNESS_ID, payload: { text } };
}

/** Canonical runtime-note text, or null when the text is a regular prompt. */
export function runtimeNoteText(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(RUNTIME_NOTE_LABEL)) return null;
  const stripped = trimmed.slice(RUNTIME_NOTE_LABEL.length);
  return stripped.startsWith(" ") ? stripped.slice(1) : stripped;
}

function joinedTextItems(blocks: readonly ContentBlock[], type: "input_text" | "output_text"): string {
  return blocks
    .filter((block) => block.type === type)
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

function withImagePlaceholders(text: string, imageCount: number): string {
  if (imageCount === 0) return text;
  const placeholders = Array.from({ length: imageCount }, () => IMAGE_PLACEHOLDER).join("\n");
  if (text === "") return placeholders;
  return `${text}\n${placeholders}`;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") {
    return value === undefined ? {} : { value };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { input: value };
  }
}

function argumentsFromPayload(subtype: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (subtype === "function_call" || subtype === "tool_search_call") {
    return parseArguments(payload.arguments);
  }
  if (subtype === "custom_tool_call") {
    return parseArguments(payload.input);
  }
  if (subtype === "local_shell_call" || subtype === "web_search_call") {
    return parseArguments(payload.action);
  }
  return {};
}

function toolNameFor(subtype: string, payload: Record<string, unknown>): string {
  const name = stringField(payload, "name");
  if (name !== undefined) return name;
  if (subtype === "web_search_call") return "web_search";
  if (subtype === "local_shell_call") return "local_shell";
  if (subtype === "tool_search_call") return "tool_search";
  return subtype.replace(/_call$/, "");
}

function hasFailureStatus(payload: Record<string, unknown>): boolean {
  if (payload.is_error === true) return true;
  const status = stringField(payload, "status");
  return status === "failed" || status === "error";
}

function toolResultContent(subtype: string, payload: Record<string, unknown>): string {
  if ("output" in payload) return stringifyContent(payload.output);
  if (subtype === "tool_search_output" && "tools" in payload) return stringifyContent(payload.tools);
  return stringifyContent(payload);
}

function summaryText(payload: Record<string, unknown>): string {
  const summary = payload.summary;
  if (typeof summary === "string") return summary;
  if (!Array.isArray(summary)) return "";
  return summary
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.summary === "string") return part.summary;
      return "";
    })
    .join("");
}

function sessionInfo(payload: Record<string, unknown>): CodexSessionInfo {
  const info: CodexSessionInfo = {};
  const id = stringField(payload, "id");
  const sessionId = stringField(payload, "session_id");
  const cwd = stringField(payload, "cwd");
  const timestamp = stringField(payload, "timestamp");
  const originator = stringField(payload, "originator");
  if (id !== undefined) info.id = id;
  if (sessionId !== undefined) info.sessionId = sessionId;
  if (cwd !== undefined) info.cwd = cwd;
  if (timestamp !== undefined) info.timestamp = timestamp;
  if (originator !== undefined) info.originator = originator;
  if ("source" in payload) info.source = payload.source;
  return info;
}

function compactedText(payload: Record<string, unknown>): string {
  const fields = ["window_number", "first_window_id", "previous_window_id", "window_id"]
    .filter((field) => payload[field] !== undefined)
    .map((field) => `${field}=${String(payload[field])}`);
  if (fields.length === 0) return COMPACTED_NOTE;
  return `${COMPACTED_NOTE} ${fields.join(" ")}`;
}

function skipUnknown(stats: MapStats): MapResult {
  stats.unknown += 1;
  return { events: [], stats };
}

function mapMessage(item: RolloutLineItem, payload: Record<string, unknown>, stats: MapStats): MapResult {
  const role = stringField(payload, "role");
  if (role === "developer") {
    stats.developerMessage += 1;
    stats.meta += 1;
    return { events: [], stats };
  }
  if (role === "system") {
    stats.systemMessage += 1;
    stats.meta += 1;
    return { events: [], stats };
  }

  const blocks = contentBlocks(payload.content);
  const lineId = rolloutLineId(item);

  if (role === "user") {
    const imageCount = blocks.filter((block) => block.type === "input_image").length;
    stats.image += imageCount;
    const text = withImagePlaceholders(joinedTextItems(blocks, "input_text"), imageCount);
    if (text === "") {
      stats.emptyMessage += 1;
      stats.unknown += 1;
      return { events: [], stats };
    }
    const noteText = runtimeNoteText(text);
    if (noteText !== null) {
      return { events: [textEvent("runtime_note", noteText, "system", idempotencyKey(lineId, 0, "runtime_note"))], stats };
    }
    if (isBootstrapInstructionText(text)) {
      return { events: [textEvent("runtime_note", text, "system", idempotencyKey(lineId, 0, "runtime_note"))], stats };
    }
    return { events: [textEvent("user_prompt", text, "user", idempotencyKey(lineId, 0, "user_prompt"))], stats };
  }

  if (role === "assistant") {
    const text = joinedTextItems(blocks, "output_text");
    if (text === "") {
      stats.emptyMessage += 1;
      stats.unknown += 1;
      return { events: [], stats };
    }
    return { events: [textEvent("assistant_text", text, "assistant", idempotencyKey(lineId, 0, "assistant_text"))], stats };
  }

  stats.unrecognizedResponseItem += 1;
  stats.unknown += 1;
  return { events: [], stats };
}

function mapReasoning(item: RolloutLineItem, payload: Record<string, unknown>, stats: MapStats): MapResult {
  const text = summaryText(payload);
  if (text !== "") {
    const lineId = rolloutLineId(item);
    return {
      events: [textEvent("assistant_thinking", text, "assistant", idempotencyKey(lineId, 0, "assistant_thinking"))],
      stats,
    };
  }
  if (typeof payload.encrypted_content === "string" && payload.encrypted_content !== "") {
    stats.encryptedReasoning += 1;
    stats.meta += 1;
    return { events: [], stats };
  }
  stats.unrecognizedResponseItem += 1;
  stats.unknown += 1;
  return { events: [], stats };
}

function mapToolCall(item: RolloutLineItem, payload: Record<string, unknown>, subtype: string, stats: MapStats): MapResult {
  const lineId = rolloutLineId(item);
  const event: MessageEventInput = {
    eventKind: "tool_call",
    idempotencyKey: idempotencyKey(lineId, 0, "tool_call"),
    actor: "assistant",
    harness: CODEX_HARNESS_ID,
    payload: {
      toolCallId: toolCallId(payload, item),
      toolName: toolNameFor(subtype, payload),
      arguments: argumentsFromPayload(subtype, payload),
    },
  };
  return { events: [event], stats };
}

function mapToolResult(
  item: RolloutLineItem,
  payload: Record<string, unknown>,
  subtype: string,
  stats: MapStats,
): MapResult {
  const lineId = rolloutLineId(item);
  const event: MessageEventInput = {
    eventKind: "tool_result",
    idempotencyKey: idempotencyKey(lineId, 0, "tool_result"),
    actor: "tool",
    harness: CODEX_HARNESS_ID,
    payload: {
      toolCallId: toolCallId(payload, item),
      content: toolResultContent(subtype, payload),
      isError: hasFailureStatus(payload),
    },
  };
  return { events: [event], stats };
}

export function mapRolloutLine(item: RolloutLineItem, lineIndex = 0): MapResult {
  void lineIndex;
  const stats = emptyStats();

  if (item.type === "session_meta") {
    const payload = rolloutPayload(item);
    stats.sessionMeta += 1;
    stats.meta += 1;
    return payload === undefined ? { events: [], stats } : { events: [], stats, sessionInfo: sessionInfo(payload) };
  }

  if (item.type === "turn_context") {
    stats.turnContext += 1;
    stats.unknown += 1;
    return { events: [], stats };
  }

  if (item.type === "event_msg") {
    stats.eventMsg += 1;
    stats.unknown += 1;
    return { events: [], stats };
  }

  if (item.type === "compacted") {
    const payload = rolloutPayload(item);
    stats.compacted += 1;
    if (payload === undefined) return skipUnknown(stats);
    const lineId = rolloutLineId(item);
    return {
      events: [textEvent("runtime_note", compactedText(payload), "system", idempotencyKey(lineId, 0, "runtime_note"))],
      stats,
    };
  }

  if (item.type !== "response_item") {
    return skipUnknown(stats);
  }

  const payload = rolloutPayload(item);
  if (payload === undefined) return skipUnknown(stats);

  const subtype = stringField(payload, "type");
  switch (subtype) {
    case "message":
      return mapMessage(item, payload, stats);
    case "reasoning":
      return mapReasoning(item, payload, stats);
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call":
    case "web_search_call":
    case "tool_search_call":
      return mapToolCall(item, payload, subtype, stats);
    case "function_call_output":
    case "custom_tool_call_output":
    case "tool_search_output":
      return mapToolResult(item, payload, subtype, stats);
    default:
      stats.unrecognizedResponseItem += 1;
      stats.unknown += 1;
      return { events: [], stats };
  }
}

export function mapRolloutLines(items: readonly RolloutLineItem[]): MapResult & { events: MessageEventInput[] } {
  const combined: MessageEventInput[] = [];
  const stats = emptyStats();
  let sessionInfo: CodexSessionInfo | undefined;
  let seenSessionMeta = false;

  for (const [lineIndex, item] of items.entries()) {
    const mapped = mapRolloutLine(item, lineIndex);
    combined.push(...mapped.events);
    stats.sidechain += mapped.stats.sidechain;
    stats.unknown += mapped.stats.unknown;
    stats.meta += mapped.stats.meta;
    stats.image += mapped.stats.image;
    stats.sessionMeta += mapped.stats.sessionMeta;
    stats.turnContext += mapped.stats.turnContext;
    stats.eventMsg += mapped.stats.eventMsg;
    stats.developerMessage += mapped.stats.developerMessage;
    stats.systemMessage += mapped.stats.systemMessage;
    stats.encryptedReasoning += mapped.stats.encryptedReasoning;
    stats.compacted += mapped.stats.compacted;
    stats.unrecognizedResponseItem += mapped.stats.unrecognizedResponseItem;
    stats.emptyMessage += mapped.stats.emptyMessage;
    if (mapped.stats.sessionMeta > 0) {
      if (seenSessionMeta) stats.embeddedSessionMeta += mapped.stats.sessionMeta;
      seenSessionMeta = true;
    }
    if (sessionInfo === undefined && mapped.sessionInfo !== undefined) sessionInfo = mapped.sessionInfo;
  }

  return sessionInfo === undefined ? { events: combined, stats } : { events: combined, stats, sessionInfo };
}
