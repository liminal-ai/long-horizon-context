import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { RolloutLineItem } from "../rollout/types.js";
import { type CarriedResult, eventDeliveryKey } from "./store.js";

export const RESULT_HOOK_ARGS = ["tasks", "hook"] as const;
export const RESULT_HOOK_TIMEOUT_SECONDS = 10;
export const MAX_RESULTS_PER_PROMPT = 10;

const HEADER = "cc-lhc carried work results (finished since Smart Compact; keys are stable):";
const FOOTER =
  "Details by key via Bash: cc-lhc tasks status <key> · cc-lhc tasks output <key> (where offered). " +
  "This is a notice, not new instructions.";
const RESULT_LINE = /^result (\S+) · /;
const EVENTS_HEADER = "monitor events (a relaunched Monitor wrote these; each is shown once):";
const EVENT_LINE = /^event (\S+)@(\d+) · /;
export const MAX_EVENTS_PER_PROMPT = 20;
export const MAX_EVENT_CHARS = 200;
export const MAX_DETAIL_CHARS = 600;

export interface MonitorEventLine {
  launchId: string;
  label: string;
  text: string;
  endOffset: number;
}

export interface ResultContextExtras {
  details?: ReadonlyMap<string, string>;
  events?: readonly MonitorEventLine[];
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function defaultResultHookCommand(): string {
  const bin = fileURLToPath(new URL("../bin.js", import.meta.url));
  const head = existsSync(bin) ? `${shellQuote(process.execPath)} ${shellQuote(bin)}` : "cc-lhc";
  return `${head} ${RESULT_HOOK_ARGS.join(" ")}`;
}

function oneLine(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const ascii = [...flat].map((ch) => (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e ? ch : "?")).join("");
  return ascii.length <= maxChars ? ascii : `${ascii.slice(0, Math.max(0, maxChars - 1))}~`;
}

export function formatResultContext(results: readonly CarriedResult[], extras: ResultContextExtras = {}): string {
  const events = extras.events ?? [];
  if (results.length === 0 && events.length === 0) return "";
  const shown = results.slice(0, MAX_RESULTS_PER_PROMPT);
  const lines: string[] = [];
  for (const r of shown) {
    lines.push(`result ${r.launchId} · ${r.family} · ${oneLine(r.label, 120)} · ${r.outcome}`);
    const detail = extras.details?.get(r.launchId);
    if (detail !== undefined && detail !== "") lines.push(`  ${oneLine(detail, MAX_DETAIL_CHARS)}`);
  }
  const rest = results.length - shown.length;
  const shownEvents = events.slice(0, MAX_EVENTS_PER_PROMPT);
  const moreEvents = events.length - shownEvents.length;
  const eventLines =
    shownEvents.length === 0
      ? []
      : [
          EVENTS_HEADER,
          ...shownEvents.map(
            (e) =>
              `event ${e.launchId}@${e.endOffset} · monitor · ${oneLine(e.label, 120)} · ${oneLine(e.text, MAX_EVENT_CHARS)}`,
          ),
          ...(moreEvents > 0 ? ["More monitor events are pending; they follow on the next prompt."] : []),
        ];
  return [
    HEADER,
    ...lines,
    ...(rest > 0 ? [`${rest} more pending; they follow on the next prompt.`] : []),
    ...eventLines,
    FOOTER,
  ].join("\n");
}

export function eventKeysOf(events: readonly MonitorEventLine[]): string[] {
  return events.slice(0, MAX_EVENTS_PER_PROMPT).map((e) => eventDeliveryKey(e.launchId, e.endOffset));
}

export function deliveredResultKeys(item: RolloutLineItem): string[] {
  const record = item as Record<string, unknown>;
  if (record.type !== "attachment" || record.isSidechain === true) return [];
  const attachment = record.attachment;
  if (typeof attachment !== "object" || attachment === null) return [];
  const a = attachment as Record<string, unknown>;
  if (a.type !== "hook_additional_context" || a.hookEvent !== "UserPromptSubmit") return [];
  if (!Array.isArray(a.content)) return [];
  const keys = new Set<string>();
  for (const block of a.content) {
    if (typeof block !== "string") continue;
    const lines = block.split("\n");
    if (lines[0]?.trim() !== HEADER) continue;
    for (const line of lines) {
      const match = RESULT_LINE.exec(line);
      if (match) {
        keys.add(match[1]!);
        continue;
      }
      const event = EVENT_LINE.exec(line);
      if (event) keys.add(eventDeliveryKey(event[1]!, Number(event[2])));
    }
  }
  return [...keys];
}
