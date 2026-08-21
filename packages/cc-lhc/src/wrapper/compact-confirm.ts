/**
 * What the operator is shown before an automatic compact swap kills live
 * background work, and what counts as saying yes to it.
 *
 * The wrapper cannot compact without replacing the Claude child, and the
 * replacement is a different process: everything the old one was still
 * running dies with it. When there is nothing open the swap is invisible and
 * runs as always. When there is, the operator is the only one who can say
 * whether this work is worth more than the compact — so they are asked, once,
 * at that seam.
 *
 * Only "y" proceeds. Every other disposition skips this seam and nothing
 * else: no state is kept, and the next eligible seam asks again while work
 * remains open.
 */

import type { AsyncWorkFamily, OpenAsyncWork } from "../observation/async-work.js";

/** Panel hint for the confirmation. Plain ASCII, like every row we draw. */
export const COMPACT_CONFIRM_HINT = "y = Smart Compact now and kill this work  |  any other key = not now";

/** Why the confirmation ended without an affirmative answer. */
export type CompactConfirmDecline = "declined" | "dismissed" | "stdin_closed" | "render_failed" | "interrupted";

export type CompactConfirmDisposition = { kind: "yes" } | { kind: "no"; reason: CompactConfirmDecline };

/** Human phrase for a decline, used in the wrapper log and the receipt. */
export function describeDecline(reason: CompactConfirmDecline): string {
  switch (reason) {
    case "declined":
      return "operator declined";
    case "dismissed":
      return "operator dismissed the prompt";
    case "stdin_closed":
      return "terminal input closed before an answer";
    case "render_failed":
      return "the prompt could not be shown";
    case "interrupted":
      return "the prompt was interrupted";
  }
}

const FAMILY_NOUNS: Record<AsyncWorkFamily, string> = {
  agent: "background agent",
  workflow: "workflow",
  background_shell: "background command",
  monitor: "monitor",
  scheduled_wakeup: "scheduled wakeup",
};

/** Keep a bullet readable on a normal terminal; the panel truncates the rest. */
const MAX_DESCRIPTION_CHARS = 64;
const MAX_EVENT_CHARS = 48;

/** Plain ASCII, single line, bounded. Panel rows are never multi-line. */
function plain(text: string, maxChars: number): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  // Non-ASCII survives in Claude's own summaries; the panel draws ASCII only.
  const ascii = [...flattened].map((ch) => (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e ? ch : "?")).join("");
  if (ascii.length <= maxChars) return ascii;
  return `${ascii.slice(0, maxChars - 3)}...`;
}

/**
 * When the wakeup is due, in words. Past its moment it reads `overdue` rather
 * than counting backwards: the record shows it armed and never shows it
 * running, so the wrapper says what it knows and nothing more.
 */
function due(scheduledForMs: number, nowMs: number): string {
  const seconds = Math.round((scheduledForMs - nowMs) / 1000);
  if (seconds <= 0) return "overdue";
  if (seconds < 60) return `fires in ${seconds}s`;
  return `fires in ${Math.round(seconds / 60)}m`;
}

/** One bullet: what the work is, what it was called, and how it last looked. */
export function describeAsyncWork(work: OpenAsyncWork, nowMs: number): string {
  const parts = [FAMILY_NOUNS[work.family]];
  if (work.description !== undefined) parts.push(`"${plain(work.description, MAX_DESCRIPTION_CHARS)}"`);
  if (work.family === "scheduled_wakeup") {
    if (work.scheduledForMs !== undefined) parts.push(`(${due(work.scheduledForMs, nowMs)})`);
  } else if (work.taskId !== undefined) {
    parts.push(`(${plain(work.taskId, 32)})`);
  }
  let line = `  - ${parts.join(" ")}`;
  if (work.latestEvent !== undefined) line += ` - last event: ${plain(work.latestEvent, MAX_EVENT_CHARS)}`;
  return line;
}

/**
 * The confirmation body: one warning naming what the swap costs, then one
 * bullet per piece of live work. Returns an empty list when nothing is open,
 * so a caller cannot raise an empty prompt.
 */
export function compactConfirmRows(work: readonly OpenAsyncWork[], nowMs: number): string[] {
  if (work.length === 0) return [];
  const count = work.length;
  const noun = count === 1 ? "1 piece" : `${count} pieces`;
  return [
    `Smart Compact replaces the Claude session and will kill ${noun} of live background work:`,
    ...work.map((item) => describeAsyncWork(item, nowMs)),
  ];
}
