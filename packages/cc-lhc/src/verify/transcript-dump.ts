import type { SessionThreadView } from "lhc";

import { isMetaUserLine, isSyntheticNoResponse, stringifyToolResultContent } from "../intake/map.js";
import type { ContentBlock, RolloutLineItem } from "../rollout/types.js";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key]);
    return sorted;
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

interface DumpEntry {
  label: string;
  body: string;
}

function formatEntries(entries: readonly DumpEntry[]): string {
  if (entries.length === 0) return "";
  return `${entries.map((entry) => (entry.body === "" ? entry.label : `${entry.label}\n${entry.body}`)).join("\n\n")}\n`;
}

function toolCallLabel(name: string, id: string): string {
  return `[tool call · ${name} · ${id}]`;
}

function toolResultLabel(id: string, isError: boolean): string {
  return `[tool result · ${id}${isError ? " · error" : ""}]`;
}

export function dumpSessionThreadView(view: SessionThreadView): string {
  const out: DumpEntry[] = [];
  for (const entry of view.entries) {
    if ("kind" in entry) {
      if (entry.kind === "model_change") {
        out.push({ label: `[model change · ${entry.provider}/${entry.modelId}]`, body: "" });
      } else {
        out.push({ label: `[thinking level change · ${entry.level}]`, body: "" });
      }
      continue;
    }
    if (entry.role === "user") {
      out.push({ label: "[user]", body: entry.content });
      continue;
    }
    if (entry.role === "toolResult") {
      out.push({ label: toolResultLabel(entry.toolCallId, entry.isError === true), body: entry.content });
      continue;
    }
    for (const part of entry.content) {
      if (part.type === "text" && part.text !== undefined && part.text !== "") {
        out.push({ label: "[assistant]", body: part.text });
      } else if (part.type === "thinking" && part.thinking !== undefined && part.thinking !== "") {
        out.push({ label: "[assistant thinking]", body: part.thinking });
      } else if (part.type === "toolCall") {
        out.push({
          label: toolCallLabel(part.toolName ?? "tool", part.toolCallId ?? ""),
          body: stableJson(part.arguments ?? {}),
        });
      }
    }
  }
  return formatEntries(out);
}

function dumpAssistantBlock(block: ContentBlock, out: DumpEntry[]): void {
  if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
    out.push({ label: "[assistant]", body: block.text });
  } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking !== "") {
    out.push({ label: "[assistant thinking]", body: block.thinking });
  } else if (block.type === "tool_use") {
    const name = typeof block.name === "string" ? block.name : "tool";
    const id = typeof block.id === "string" ? block.id : "";
    out.push({ label: toolCallLabel(name, id), body: stableJson(block.input ?? {}) });
  }
}

function dumpUserBlock(block: ContentBlock, out: DumpEntry[]): void {
  if (block.type === "tool_result") {
    const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
    out.push({
      label: toolResultLabel(id, block.is_error === true),
      body: stringifyToolResultContent(block.content),
    });
  } else if (block.type === "text" && typeof block.text === "string") {
    out.push({ label: "[user]", body: block.text });
  } else {
    out.push({ label: `[${block.type}]`, body: "" });
  }
}

export function dumpRolloutLines(items: readonly RolloutLineItem[]): string {
  const out: DumpEntry[] = [];
  for (const item of items) {
    if (item.isSidechain === true) continue;
    if (item.type !== "user" && item.type !== "assistant") continue;
    if (isSyntheticNoResponse(item)) continue;
    const content = item.message?.content;
    if (content === undefined) continue;
    if (item.type === "user") {
      if (typeof content === "string") {
        if (isMetaUserLine(item, content)) continue;
        out.push({ label: "[user]", body: content });
      } else if (Array.isArray(content)) {
        if (item.isMeta === true) continue;
        for (const block of content) dumpUserBlock(block, out);
      }
      continue;
    }
    if (item.isMeta === true) continue;
    if (typeof content === "string") {
      out.push({ label: "[assistant]", body: content });
    } else if (Array.isArray(content)) {
      for (const block of content) dumpAssistantBlock(block, out);
    }
  }
  return formatEntries(out);
}

export function parseRolloutContent(content: string): RolloutLineItem[] {
  const items: RolloutLineItem[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      items.push(JSON.parse(line) as RolloutLineItem);
    } catch {}
  }
  return items;
}
