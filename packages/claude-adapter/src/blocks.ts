import type { ApiBlock, MessageEventInput } from "lhc";
import { idempotencyKey } from "./identity.js";

export interface AssistantProvenance {
  provider: string;
  api: string;
}
export const CLAUDE_PROVENANCE: AssistantProvenance = { provider: "anthropic", api: "messages" };

export type TextEventKind = "user_prompt" | "assistant_text" | "assistant_thinking" | "runtime_note";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blocks(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

const SERVER_RESULT_TYPES = new Set([
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
]);

export function nonTextBlocks(content: unknown): ApiBlock[] | undefined {
  const parts = blocks(content).filter((b): b is ApiBlock => typeof b["type"] === "string");
  return parts.some((b) => b.type !== "text") ? parts : undefined;
}

export function joinedText(content: unknown): string {
  return blocks(content)
    .filter((b) => b["type"] === "text")
    .map((b) => (typeof b["text"] === "string" ? b["text"] : ""))
    .join("");
}

export function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) && typeof block["text"] === "string" ? block["text"] : JSON.stringify(block)))
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function textEvent(
  harness: string,
  kind: TextEventKind,
  body: string,
  actor: string,
  key: string,
  extra: Record<string, unknown> = {},
): MessageEventInput {
  return {
    eventKind: kind,
    idempotencyKey: key,
    actor,
    harness,
    payload: { text: body, ...extra },
  } as MessageEventInput;
}

export function usageContextTokens(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const n = (k: string): number =>
    typeof usage[k] === "number" && Number.isFinite(usage[k]) ? (usage[k] as number) : 0;
  const total = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
  return total > 0 ? total : undefined;
}

export interface AssistantMessage {
  content: unknown;
  model?: string | undefined;
  usage?: unknown;
}

export function mapAssistantBlocks(harness: string, id: string, message: AssistantMessage): MessageEventInput[] {
  const { model } = message;
  const providerUsage = isRecord(message.usage) ? message.usage : undefined;
  const key = (index: number, kind: string) => idempotencyKey(harness, id, index, kind);
  const provenance = { ...CLAUDE_PROVENANCE, ...(model !== undefined ? { model } : {}) };
  const events: MessageEventInput[] = [];
  for (const [index, block] of blocks(message.content).entries()) {
    if (block["type"] === "thinking") {
      const signature = typeof block["signature"] === "string" ? block["signature"] : "";
      events.push(
        textEvent(
          harness,
          "assistant_thinking",
          typeof block["thinking"] === "string" ? block["thinking"] : "",
          "assistant",
          key(index, "assistant_thinking"),
          {
            ...(signature !== "" ? { signature } : {}),
            ...provenance,
          },
        ),
      );
    } else if (block["type"] === "redacted_thinking") {
      events.push(
        textEvent(harness, "assistant_thinking", "", "assistant", key(index, "assistant_thinking"), {
          block,
          ...provenance,
        }),
      );
    } else if (block["type"] === "server_tool_use") {
      events.push({
        eventKind: "tool_call",
        idempotencyKey: key(index, "tool_call"),
        actor: "assistant",
        harness,
        payload: {
          toolCallId: String(block["id"]),
          toolName: String(block["name"]),
          arguments: isRecord(block["input"]) ? block["input"] : {},
          block: block as ApiBlock,
        },
      });
    } else if (typeof block["type"] === "string" && SERVER_RESULT_TYPES.has(block["type"])) {
      events.push({
        eventKind: "tool_result",
        idempotencyKey: key(index, "tool_result"),
        actor: "tool",
        harness,
        payload: {
          toolCallId: String(block["tool_use_id"]),
          content: "",
          isError: isRecord(block["content"]) && typeof block["content"]["error_code"] === "string",
          blocks: [block as ApiBlock],
        },
      });
    } else if (block["type"] === "text") {
      const body = typeof block["text"] === "string" ? block["text"] : "";
      if (body === "") continue;
      events.push(
        textEvent(harness, "assistant_text", body, "assistant", key(index, "assistant_text"), {
          ...(providerUsage !== undefined ? { providerUsage } : {}),
          ...provenance,
        }),
      );
    } else if (block["type"] === "tool_use") {
      events.push({
        eventKind: "tool_call",
        idempotencyKey: key(index, "tool_call"),
        actor: "assistant",
        harness,
        payload: {
          toolCallId: String(block["id"]),
          toolName: String(block["name"]),
          arguments: isRecord(block["input"]) ? block["input"] : {},
        },
      });
    }
  }
  return events;
}

export function mapUserBlocks(harness: string, id: string, content: unknown): MessageEventInput[] {
  const events: MessageEventInput[] = [];
  for (const [index, block] of blocks(content).entries()) {
    if (block["type"] === "tool_result") {
      const attached = nonTextBlocks(block["content"]);
      events.push({
        eventKind: "tool_result",
        idempotencyKey: idempotencyKey(harness, id, index, "tool_result"),
        actor: "tool",
        harness,
        payload: {
          toolCallId: String(block["tool_use_id"]),
          isError: block["is_error"] === true,
          content: attached === undefined ? stringifyToolResultContent(block["content"]) : joinedText(block["content"]),
          ...(attached === undefined ? {} : { blocks: attached }),
        },
      });
    } else if (block["type"] === "text") {
      const body = typeof block["text"] === "string" ? block["text"] : "";
      if (body === "") continue;
      events.push(
        textEvent(harness, "runtime_note", body, "system", idempotencyKey(harness, id, index, "runtime_note")),
      );
    }
  }
  return events;
}
