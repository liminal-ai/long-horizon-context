import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  idempotencyKey as adapterIdempotencyKey,
  messageKeyPrefix as adapterMessageKeyPrefix,
  joinedText,
  mapAssistantBlocks,
  mapUserBlocks,
  nonTextBlocks,
  textEvent,
  usageContextTokens,
} from "claude-adapter";
import type { MessageEventInput } from "lhc";

export const HARNESS = "claude-lhc";
const TASK_NOTIFICATION_MARKER = "<task-notification>";
const RUNTIME_NOTE_LABEL = "[runtime note]";
const STEER_LABEL = "[user steer]";
const SYNTHETIC_MODEL = "<synthetic>";

export function messageKeyPrefix(uuid: string): string {
  return adapterMessageKeyPrefix(HARNESS, uuid);
}

export function idempotencyKey(uuid: string, blockIndex: number, kind: string): string {
  return adapterIdempotencyKey(HARNESS, uuid, blockIndex, kind);
}

export function promptText(message: SDKUserMessage): string {
  return joinedText(message.message.content);
}

export function compactCommand(message: SDKUserMessage): { args: string } | null {
  const body = promptText(message).trim();
  if (body !== "/compact" && !body.startsWith("/compact ")) return null;
  return { args: body.slice("/compact".length).trim() };
}

export function mapPrompt(message: SDKUserMessage, uuid: string, turnOpen: boolean): MessageEventInput[] {
  const body = promptText(message);
  if (body === "" && nonTextBlocks(message.message.content) === undefined) return [];
  const trimmed = body.trimStart();
  if (trimmed.startsWith(TASK_NOTIFICATION_MARKER))
    return [textEvent(HARNESS, "runtime_note", body, "system", idempotencyKey(uuid, 0, "runtime_note"))];
  if (trimmed.startsWith(RUNTIME_NOTE_LABEL)) {
    const stripped = trimmed.slice(RUNTIME_NOTE_LABEL.length).replace(/^ /, "");
    return [textEvent(HARNESS, "runtime_note", stripped, "system", idempotencyKey(uuid, 0, "runtime_note"))];
  }
  if (turnOpen)
    return [
      textEvent(HARNESS, "runtime_note", `${STEER_LABEL} ${body}`, "user", idempotencyKey(uuid, 0, "runtime_note")),
    ];
  const attached = nonTextBlocks(message.message.content);
  return [
    textEvent(
      HARNESS,
      "user_prompt",
      body,
      "user",
      idempotencyKey(uuid, 0, "user_prompt"),
      attached === undefined ? {} : { blocks: attached },
    ),
  ];
}

export interface MapResult {
  events: MessageEventInput[];
  turnEnd: boolean;
  contextTokens?: number;
}

export function mapSdkMessage(message: SDKMessage, turnStartedAt: string | undefined): MapResult {
  const none: MapResult = { events: [], turnEnd: false };
  const m = message as unknown as Record<string, unknown>;
  const uuid = typeof m["uuid"] === "string" ? m["uuid"] : undefined;

  if (message.type === "assistant") {
    if (message.parent_tool_use_id !== null) return none;
    const inner = message.message as unknown as Record<string, unknown>;
    const model = typeof inner["model"] === "string" ? inner["model"] : undefined;
    if (model === SYNTHETIC_MODEL) return none;
    const id = uuid ?? `assistant:${String(inner["id"])}`;
    const events = mapAssistantBlocks(HARNESS, id, { content: inner["content"], model, usage: inner["usage"] });
    const contextTokens = usageContextTokens(inner["usage"]);
    return { events, turnEnd: false, ...(contextTokens !== undefined ? { contextTokens } : {}) };
  }

  if (message.type === "user") {
    if (message.parent_tool_use_id !== null) return none;
    if (m["isReplay"] === true) return none;
    const id = uuid ?? `user:${Date.now()}`;
    return { events: mapUserBlocks(HARNESS, id, message.message.content), turnEnd: false };
  }

  if (message.type === "result") {
    const aborted = message.subtype !== "success" || message.is_error === true;
    const id = uuid ?? `result:${Date.now()}`;
    const endedAt = new Date().toISOString();
    return {
      events: [
        {
          eventKind: "turn_end",
          idempotencyKey: idempotencyKey(id, 0, "turn_end"),
          actor: "system",
          harness: HARNESS,
          payload: {
            outcome: aborted ? "aborted" : "completed",
            outcomeReason: message.subtype,
            ...(turnStartedAt !== undefined ? { startedAt: turnStartedAt } : {}),
            endedAt,
          },
        },
      ],
      turnEnd: true,
    };
  }

  return none;
}
