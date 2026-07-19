// Canonical transcript dumps — the fidelity-certification harness (ported
// from pi-lhc's export-serializer approach). Two sources, one format:
//
//   dumpSessionThreadView  — what LHC serves (the rebuild's input)
//   dumpRolloutLines       — what a Claude Code rollout file contains
//
// Because the rebuild emits native blocks, a faithful swap makes the two
// dumps line up entry-for-entry: diff a pre-compact rollout dump against a
// post-compact one and the tail must match exactly, with only the banded
// head replaced by [context · band] entries (plus the trailing swap
// receipt). The dump format itself uses bracket labels — that is fine HERE
// because these files are diff artifacts for humans, never served to a
// model.
//
// Determinism rules: tool arguments serialize with recursively sorted keys
// (structural equality → byte equality); native tool-result content
// normalizes through the same stringification intake uses; envelope noise
// (uuids, timestamps, session ids) never appears.

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

/** Stable-sorted-key JSON: two structurally equal payloads compare equal. */
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

/** Canonical dump of the served thread view — the rebuild's exact input. */
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
    // images and other rich blocks: presence marker only
    out.push({ label: `[${block.type}]`, body: "" });
  }
}

/**
 * Canonical dump of parsed rollout lines. Skips exactly what intake skips —
 * sidechains, meta lines by flag AND by content marker (`<command-name>`,
 * `<local-command-stdout>`, …), and the synthetic "No response requested."
 * resume line — so a pre-compact dump and a post-compact dump differ only
 * where transcript content differs, never on harness bookkeeping (proven on
 * the 2026-07-19 230k certification: the only spurious diffs were /exit
 * meta lines and the synthetic resume line before this alignment).
 */
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

/** Parse rollout JSONL content into line items, skipping unparseable lines. */
export function parseRolloutContent(content: string): RolloutLineItem[] {
  const items: RolloutLineItem[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      items.push(JSON.parse(line) as RolloutLineItem);
    } catch {
      // unparseable lines carry no transcript content worth diffing
    }
  }
  return items;
}
