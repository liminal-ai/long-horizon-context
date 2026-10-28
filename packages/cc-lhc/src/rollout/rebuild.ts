import { randomUUID } from "node:crypto";

import type { SessionAssistantPart, SessionThreadViewEntry, SessionThreadViewMessage } from "lhc";

import { SELECTED_THINKING_REBUILD_ARM, type ThinkingRebuildArm } from "./thinking-ladder.js";
import type { ContentBlock, RolloutLineItem } from "./types.js";

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
  thinkingRebuildArm?: ThinkingRebuildArm;
}

export interface RebuiltRolloutLine {
  line: RolloutLineItem;
  rolloutType: "user" | "assistant";
}

function isMessageEntry(entry: SessionThreadViewEntry): entry is SessionThreadViewMessage {
  return "role" in entry;
}

function assistantPartBlock(
  part: SessionAssistantPart,
  arm: ThinkingRebuildArm = SELECTED_THINKING_REBUILD_ARM,
): ContentBlock | null {
  if (part.type === "text" && part.text !== undefined && part.text !== "") {
    return { type: "text", text: part.text };
  }
  if (part.type === "thinking" || part.type === "redacted_thinking") {
    if (part.type === "redacted_thinking") {
      return arm === "omit" ? null : ((part.block as ContentBlock | undefined) ?? null);
    }
    const thinking = part.thinking ?? "";
    const signature =
      typeof part.thinkingSignature === "string" && part.thinkingSignature !== "" ? part.thinkingSignature : undefined;
    if (arm === "omit") return null;
    if (arm === "unsigned_visible") {
      if (thinking === "") return null;
      return { type: "thinking", thinking };
    }
    if (signature !== undefined) {
      return { type: "thinking", thinking, signature };
    }
    return null;
  }
  if (part.type === "toolCall") {
    return {
      type: "tool_use",
      id: part.toolCallId ?? "",
      name: part.toolName ?? "tool",
      input: part.arguments ?? {},
    };
  }
  return (part.block as ContentBlock | undefined) ?? null;
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

function userMessageContent(content: string | ContentBlock[]): {
  role: "user";
  content: string | ContentBlock[];
} {
  return { role: "user", content };
}

function assistantMessageContent(
  messageId: string,
  model: string,
  block: ContentBlock,
  stopReason: string,
): Record<string, unknown> {
  return {
    role: "assistant",
    id: messageId,
    type: "message",
    model,
    stop_reason: stopReason,
    content: [block],
  };
}

export function runtimeNoteRolloutLine(
  text: string,
  sessionId: string,
  envelope: RolloutEnvelope,
  parentUuid: string | null,
): RebuiltRolloutLine {
  const line = baseEnvelopeFields(sessionId, parentUuid, envelope, new Date().toISOString());
  line.type = "user";
  line.message = userMessageContent(`[runtime note] ${text}`);
  return { line, rolloutType: "user" };
}

export function buildRolloutLines(input: RebuildRolloutInput): RebuiltRolloutLine[] {
  const { entries, newSessionId, envelope } = input;
  const thinkingArm = input.thinkingRebuildArm ?? SELECTED_THINKING_REBUILD_ARM;
  const rebuilt: RebuiltRolloutLine[] = [];
  let parentUuid: string | null = null;
  const timestamp = new Date().toISOString();
  let assistantModel = envelope.assistantModel ?? "unknown";

  for (const entry of entries) {
    if (!isMessageEntry(entry)) {
      if (entry.kind === "model_change" && entry.modelId !== "") {
        assistantModel = entry.modelId;
      }
      continue;
    }

    if (entry.role === "user") {
      const line = baseEnvelopeFields(newSessionId, parentUuid, envelope, timestamp);
      line.type = "user";
      line.message = userMessageContent((entry.blocks as ContentBlock[] | undefined) ?? entry.content);
      parentUuid = typeof line.uuid === "string" ? line.uuid : null;
      rebuilt.push({ line, rolloutType: "user" });
      continue;
    }

    if (entry.role === "toolResult") {
      const line = baseEnvelopeFields(newSessionId, parentUuid, envelope, timestamp);
      line.type = "user";
      line.message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: entry.toolCallId,
            content: (entry.blocks as ContentBlock[] | undefined) ?? entry.content,
            is_error: entry.isError === true,
          },
        ],
      };
      parentUuid = typeof line.uuid === "string" ? line.uuid : null;
      rebuilt.push({ line, rolloutType: "user" });
      continue;
    }

    if (entry.role === "assistant") {
      const blocks = entry.content
        .map((part) => assistantPartBlock(part, thinkingArm))
        .filter((block): block is ContentBlock => block !== null);
      if (blocks.length === 0) continue;
      const stopReason = blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
      let messageId: string | null = null;
      for (const block of blocks) {
        const line = baseEnvelopeFields(newSessionId, parentUuid, envelope, timestamp);
        const lineUuid = typeof line.uuid === "string" ? line.uuid : randomUUID();
        line.uuid = lineUuid;
        line.type = "assistant";
        if (messageId === null) messageId = syntheticMessageId(lineUuid);
        line.message = assistantMessageContent(messageId, assistantModel, block, stopReason);
        parentUuid = lineUuid;
        rebuilt.push({ line, rolloutType: "assistant" });
      }
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
    } catch {}
  }
  return envelope;
}
