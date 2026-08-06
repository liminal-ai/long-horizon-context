import { randomUUID } from "node:crypto";

import type { SessionAssistantPart, SessionThreadViewEntry, SessionThreadViewMessage } from "lhc";

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
}

export interface RebuiltRolloutLine {
  line: RolloutLineItem;
  rolloutType: "user" | "assistant";
}

function isMessageEntry(entry: SessionThreadViewEntry): entry is SessionThreadViewMessage {
  return "role" in entry;
}

/**
 * Native content block for one assistant part, or null for an empty part.
 *
 * The tail of a rebuilt rollout must be NATIVE blocks, never bracket-labelled
 * text: text renderings of tool activity taught the model to emit "[tool …]"
 * markers before real tool calls (pi-lhc's "echo failure mode"), which the
 * harness then passed through as user-facing prose, and non-native lines can
 * never be cache- or diff-stable against what Claude Code itself writes.
 * Bracket renderings belong only to the compacted bands (already lossy
 * summaries, served as user text) — the fidelity line pi-lhc drew.
 *
 * Thinking signatures are not carried by the thread record, so rebuilt
 * thinking blocks ship `signature: ""` (a shape real rollout files exhibit) —
 * the pi-lhc-documented cost is a one-time cache miss, not a format break.
 * Tool ids re-emit verbatim (`toolCallId` ↔ `tool_use_id`) so calls and
 * results stay paired exactly as captured.
 */
function assistantPartBlock(part: SessionAssistantPart): ContentBlock | null {
  if (part.type === "text" && part.text !== undefined && part.text !== "") {
    return { type: "text", text: part.text };
  }
  if (part.type === "thinking" && part.thinking !== undefined && part.thinking !== "") {
    return { type: "thinking", thinking: part.thinking, signature: "" };
  }
  if (part.type === "toolCall") {
    return {
      type: "tool_use",
      id: part.toolCallId ?? "",
      name: part.toolName ?? "tool",
      input: part.arguments ?? {},
    };
  }
  return null;
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

/**
 * One native assistant line body carrying a single block. Real rollout files
 * (verified live on 2.1.x) hold exactly one content block per line, with
 * consecutive lines of the same API message sharing `message.id` — so the
 * rebuild emits one line per part under a shared synthetic id.
 */
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

/**
 * The swap receipt shown to the user after prune/compact. It lives in the
 * rebuilt rollout as a trailing runtime-note line, so Claude Code renders it
 * natively in the transcript on resume — raw stdout writes land in the TUI's
 * status-line region and are wiped by the post-swap repaint.
 */
export function formatSwapReceipt(oldSessionId: string, newSessionId: string, expectedReintakeLines: number): string {
  return `session ${oldSessionId} preserved; resumed in-place as ${newSessionId} (expect ~${expectedReintakeLines} replayed lines to re-intake)`;
}

/**
 * A trailing user line carrying a runtime note. The "[runtime note]" label is
 * what the intake mapper strips and re-classifies as runtime_note, so the
 * receipt stays out of the user lane and its replay signature is stable
 * across prune cycles.
 */
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

/**
 * Map assembled thread-view entries to rollout JSONL line objects (not yet
 * serialized). Bands arrive as user text entries (already lossy summaries —
 * bracket labels are correct there); the tail re-emits NATIVE shapes:
 * per-block assistant lines (thinking / text / tool_use) under a shared
 * synthetic message id, and tool results as tool_result blocks paired by
 * tool_use_id. `model_change` entries stamp the model on subsequent
 * assistant lines (their native representation — rollout files carry no
 * standalone model-change line); `thinking_level_change` has no rollout
 * representation and is skipped.
 */
export function buildRolloutLines(input: RebuildRolloutInput): RebuiltRolloutLine[] {
  const { entries, newSessionId, envelope } = input;
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
      line.message = userMessageContent(entry.content);
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
            content: entry.content,
            is_error: entry.isError === true,
          },
        ],
      };
      parentUuid = typeof line.uuid === "string" ? line.uuid : null;
      rebuilt.push({ line, rolloutType: "user" });
      continue;
    }

    if (entry.role === "assistant") {
      const blocks = entry.content.map(assistantPartBlock).filter((block): block is ContentBlock => block !== null);
      if (blocks.length === 0) continue;
      // One API message across the entry: shared synthetic id, and the
      // native stop_reason ("tool_use" when the message issues tool calls).
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
    } catch {}
  }
  return envelope;
}
