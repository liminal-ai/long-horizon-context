import { randomUUID } from "node:crypto";

import type {
  SessionAssistantPart,
  SessionThreadViewEntry,
  SessionThreadViewMessage,
} from "lhc";

import type { RolloutLineItem } from "./types.js";

export interface RolloutEnvelope {
  cwd: string;
  version?: string;
  gitBranch?: string;
  userType?: string;
  entrypoint?: string;
  assistantModel?: string;
  /** When true, emit both sessionId and session_id (observed on current rollout files). */
  dualSessionIdFields?: boolean;
}

export interface RebuildRolloutInput {
  entries: readonly SessionThreadViewEntry[];
  newSessionId: string;
  envelope: RolloutEnvelope;
}

export interface RebuiltRolloutLine {
  line: RolloutLineItem;
  rolloutType: "user" | "assistant";
}

function isMessageEntry(entry: SessionThreadViewEntry): entry is SessionThreadViewMessage {
  return "role" in entry;
}

function renderAssistantText(parts: readonly SessionAssistantPart[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text !== undefined && part.text !== "") {
      chunks.push(part.text);
    } else if (part.type === "thinking" && part.thinking !== undefined && part.thinking !== "") {
      chunks.push(`[thinking]\n${part.thinking}`);
    } else if (part.type === "toolCall") {
      const name = part.toolName ?? "tool";
      const args = JSON.stringify(part.arguments ?? {});
      chunks.push(`[tool ${name}]\n${args}`);
    }
  }
  return chunks.join("\n\n");
}

function syntheticMessageId(lineUuid: string): string {
  return `msg_${lineUuid.replace(/-/g, "")}`;
}

function baseEnvelopeFields(
  sessionId: string,
  parentUuid: string | null,
  envelope: RolloutEnvelope,
  timestamp: string,
): RolloutLineItem {
  const line: RolloutLineItem = {
    type: "user",
    uuid: randomUUID(),
    parentUuid,
    sessionId,
    isSidechain: false,
    cwd: envelope.cwd,
    timestamp,
  };
  if (envelope.version !== undefined) line.version = envelope.version;
  if (envelope.gitBranch !== undefined) line.gitBranch = envelope.gitBranch;
  if (envelope.userType !== undefined) line.userType = envelope.userType;
  if (envelope.entrypoint !== undefined) line.entrypoint = envelope.entrypoint;
  if (envelope.dualSessionIdFields === true) {
    line.session_id = sessionId;
  }
  return line;
}

function userMessageContent(text: string): { role: "user"; content: string } {
  return { role: "user", content: text };
}

function assistantMessageContent(
  lineUuid: string,
  text: string,
  envelope: RolloutEnvelope,
): Record<string, unknown> {
  return {
    role: "assistant",
    id: syntheticMessageId(lineUuid),
    type: "message",
    model: envelope.assistantModel ?? "unknown",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
  };
}

/** Map assembled thread-view entries to rollout JSONL line objects (not yet serialized). */
export function buildRolloutLines(input: RebuildRolloutInput): RebuiltRolloutLine[] {
  const { entries, newSessionId, envelope } = input;
  const rebuilt: RebuiltRolloutLine[] = [];
  let parentUuid: string | null = null;
  const timestamp = new Date().toISOString();

  for (const entry of entries) {
    if (!isMessageEntry(entry)) continue;

    if (entry.role === "user") {
      const line = baseEnvelopeFields(newSessionId, parentUuid, envelope, timestamp);
      line.type = "user";
      line.message = userMessageContent(entry.content);
      parentUuid = typeof line.uuid === "string" ? line.uuid : null;
      rebuilt.push({ line, rolloutType: "user" });
      continue;
    }

    if (entry.role === "toolResult") {
      const line = baseEnvelopeFields(newSessionId, parentUuid, envelope, timestamp);
      line.type = "user";
      const prefix = entry.isError === true ? "[tool error] " : "";
      line.message = userMessageContent(`${prefix}${entry.content}`);
      parentUuid = typeof line.uuid === "string" ? line.uuid : null;
      rebuilt.push({ line, rolloutType: "user" });
      continue;
    }

    if (entry.role === "assistant") {
      const text = renderAssistantText(entry.content);
      if (text === "") continue;
      const line = baseEnvelopeFields(newSessionId, parentUuid, envelope, timestamp);
      const lineUuid = typeof line.uuid === "string" ? line.uuid : randomUUID();
      line.uuid = lineUuid;
      line.type = "assistant";
      line.message = assistantMessageContent(lineUuid, text, envelope);
      parentUuid = lineUuid;
      rebuilt.push({ line, rolloutType: "assistant" });
    }
  }

  return rebuilt;
}

export function serializeRolloutLines(lines: readonly RebuiltRolloutLine[]): string {
  return lines.map((entry) => JSON.stringify(entry.line)).join("\n") + (lines.length > 0 ? "\n" : "");
}

export function firstUserPrompt(lines: readonly RebuiltRolloutLine[]): string {
  for (const entry of lines) {
    if (entry.rolloutType !== "user") continue;
    const content = entry.line.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string") {
          return block.text;
        }
      }
    }
  }
  return "";
}

function assistantModelFromLine(item: RolloutLineItem): string | undefined {
  const message = item.message;
  if (message === undefined || typeof message !== "object" || message === null) return undefined;
  const model = (message as Record<string, unknown>).model;
  return typeof model === "string" && model !== "" ? model : undefined;
}

/** Extract scalar envelope fields from the newest user/assistant line in a source rollout. */
export function envelopeFromRolloutLine(item: RolloutLineItem, cwd: string): RolloutEnvelope {
  const envelope: RolloutEnvelope = { cwd };
  if (typeof item.version === "string") envelope.version = item.version;
  if (typeof item.gitBranch === "string") envelope.gitBranch = item.gitBranch;
  if (typeof item.userType === "string") envelope.userType = item.userType;
  if (typeof item.entrypoint === "string") envelope.entrypoint = item.entrypoint;
  if (typeof item.session_id === "string") envelope.dualSessionIdFields = true;
  if (item.type === "assistant") {
    const model = assistantModelFromLine(item);
    if (model !== undefined) envelope.assistantModel = model;
  }
  return envelope;
}

export function parseRolloutEnvelopeFromContent(content: string, cwd: string): RolloutEnvelope {
  const envelope: RolloutEnvelope = { cwd, version: "2.1.201" };
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const item = JSON.parse(lines[index]!) as RolloutLineItem;
      if (item.type !== "user" && item.type !== "assistant") continue;
      const partial = envelopeFromRolloutLine(item, cwd);
      if (partial.version !== undefined) envelope.version = partial.version;
      if (partial.gitBranch !== undefined) envelope.gitBranch = partial.gitBranch;
      if (partial.userType !== undefined) envelope.userType = partial.userType;
      if (partial.entrypoint !== undefined) envelope.entrypoint = partial.entrypoint;
      if (partial.dualSessionIdFields === true) envelope.dualSessionIdFields = true;
      if (partial.assistantModel !== undefined) envelope.assistantModel = partial.assistantModel;
    } catch {
      continue;
    }
  }
  return envelope;
}
