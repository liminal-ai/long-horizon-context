import type { LlmRequestContextMessage } from "lhc";
import type { AgentMessage, ContentPart, SessionEntry, ToolResultMessage } from "../pi/types.js";

export interface ExportEntry {
  role: string;
  text: string;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Serialize one PI content part to deterministic text without trimming. */
export function serializeContentPart(part: ContentPart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "thinking":
      return `[thinking]\n${part.thinking}\n[/thinking]`;
    case "toolCall":
      return `[tool call · ${part.name}] ${stableJson(part.arguments)}`;
    case "image": {
      const mime = part.mimeType === undefined ? "" : ` mimeType=${part.mimeType}`;
      const data = part.data === undefined ? "" : ` data=${part.data}`;
      return `[image]${mime}${data}`;
    }
    case "fileRef":
      return `[fileRef] ${part.path}`;
  }
}

function userContentParts(content: string | ContentPart[]): ContentPart[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function stringField(record: unknown, field: string): string | undefined {
  if (typeof record !== "object" || record === null || !(field in record)) return undefined;
  const value = (record as Record<string, unknown>)[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function serializeToolResultMessage(message: ToolResultMessage): string {
  const toolName = stringField(message, "toolName") ?? message.toolCallId;
  const errorSuffix = message.isError === true ? " · error" : "";
  const body = message.content.map(serializeContentPart).join("");
  return `[tool result · ${toolName}${errorSuffix}]\n${body}`;
}

/** Map one live PI AgentMessage to export text without trimming. */
export function agentMessageToExportText(message: AgentMessage): string {
  switch (message.role) {
    case "user":
      return userContentParts(message.content).map(serializeContentPart).join("");
    case "assistant":
      return message.content.map(serializeContentPart).join("");
    case "toolResult":
      return serializeToolResultMessage(message);
  }
}

export function agentMessageToExportEntry(message: AgentMessage): ExportEntry {
  if (message.role === "toolResult") {
    return { role: "user", text: serializeToolResultMessage(message) };
  }
  return { role: message.role, text: agentMessageToExportText(message) };
}

export function llmRequestContextMessageToExportEntry(message: LlmRequestContextMessage): ExportEntry {
  return {
    role: message.role,
    text: message.content.map((part) => part.text).join(""),
  };
}

export function llmRequestContextMessagesToExportEntries(messages: readonly LlmRequestContextMessage[]): ExportEntry[] {
  return messages.map(llmRequestContextMessageToExportEntry);
}

function isMessageSessionEntry(entry: SessionEntry): entry is SessionEntry & { message: AgentMessage } {
  return entry.type === "message" && entry.message !== undefined;
}

/** Walk PI SessionManager entries in record order; message entries only. */
export function piSessionEntriesToExportEntries(entries: readonly SessionEntry[]): ExportEntry[] {
  const out: ExportEntry[] = [];
  for (const entry of entries) {
    if (!isMessageSessionEntry(entry)) continue;
    out.push(agentMessageToExportEntry(entry.message));
  }
  return out;
}

/** Canonical export bytes: `[role]` line, raw content, blank line between entries. */
export function serializeExportEntries(entries: readonly ExportEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`[${entry.role}]`);
    lines.push(entry.text);
    lines.push("");
  }
  return lines.join("\n");
}

export function exportTimestamp(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}
