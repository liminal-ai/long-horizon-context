import type { ContinuitySnapshot } from "../continuity/snapshot.js";
import type { AsyncWorkFamily, OpenAsyncWork } from "../observation/async-work.js";

export const MAX_NAMED_CONTINUITY_ITEMS = 6;
export const MAX_CONTINUITY_NOTE_CHARS = 1_200;
export const MAX_CONTINUITY_NAME_CHARS = 64;
const MAX_TASK_ID_CHARS = 32;

const FAMILY_NOUN: Record<AsyncWorkFamily, string> = {
  agent: "background agent",
  workflow: "workflow",
  background_shell: "background command",
  monitor: "monitor",
  scheduled_wakeup: "scheduled wakeup",
};

const FAMILY_CATEGORY: Record<AsyncWorkFamily, string> = {
  agent: "background agents",
  workflow: "workflows",
  background_shell: "background commands",
  monitor: "monitors",
  scheduled_wakeup: "scheduled wakeups",
};

const NO_TERMINATION = "This note does not claim that the previous Claude process or those items stopped.";

function uniqueCategories(work: readonly OpenAsyncWork[]): string {
  const seen = new Set<AsyncWorkFamily>();
  const labels: string[] = [];
  for (const item of work) {
    if (seen.has(item.family)) continue;
    seen.add(item.family);
    labels.push(FAMILY_CATEGORY[item.family]);
  }
  if (labels.length === 0) return "live background work";
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function plainAscii(text: string, maxChars: number): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  const ascii = [...flattened].map((ch) => (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e ? ch : "?")).join("");
  if (ascii.length <= maxChars) return ascii;
  return `${ascii.slice(0, maxChars - 3)}...`;
}

function due(scheduledForMs: number, nowMs: number): string {
  const seconds = Math.round((scheduledForMs - nowMs) / 1000);
  if (seconds <= 0) return "overdue";
  if (seconds < 60) return `fires in ${seconds}s`;
  return `fires in ${Math.round(seconds / 60)}m`;
}

export function formatContinuityItemLabel(work: OpenAsyncWork, nowMs: number): string {
  const parts = [FAMILY_NOUN[work.family]];
  if (work.family !== "background_shell" && work.description !== undefined && work.description !== "") {
    parts.push(`"${plainAscii(work.description, MAX_CONTINUITY_NAME_CHARS)}"`);
  }
  if (work.family === "scheduled_wakeup" && work.scheduledForMs !== undefined) {
    parts.push(`(${due(work.scheduledForMs, nowMs)})`);
  } else {
    const id = work.taskId !== undefined && work.taskId !== "" ? work.taskId : work.key;
    if (id !== "") parts.push(`(${plainAscii(id, MAX_TASK_ID_CHARS)})`);
  }
  return parts.join(" ");
}

function classifyItem(work: OpenAsyncWork): string {
  if (work.family === "background_shell") {
    return (
      "detached from this session; it may still be running; cannot return output or completion " +
      "to this session; check before relying on its result"
    );
  }
  return "continuity lost; cannot return output or completion to this replacement session; verify or restart as appropriate";
}

function detailedNote(work: readonly OpenAsyncWork[], nowMs: number): string {
  const lines = work.map((item) => `- ${formatContinuityItemLabel(item, nowMs)}: ${classifyItem(item)}`);
  return [
    `${SMART_COMPACT_LEAD} The following tracked work cannot return output or completion to this replacement session:`,
    ...lines,
    NO_TERMINATION,
  ].join("\n");
}

const SMART_COMPACT_LEAD = "Smart Compact rebuilt this session.";

function genericNote(work: readonly OpenAsyncWork[]): string {
  const count = work.length;
  const noun = count === 1 ? "1 piece" : `${count} pieces`;
  return (
    `${SMART_COMPACT_LEAD} ${noun} of live background work (${uniqueCategories(work)}) ` +
    "cannot return output or completion to this replacement session. " +
    "Verify or restart affected work as appropriate. " +
    NO_TERMINATION
  );
}

export function formatContinuityNote(work: readonly OpenAsyncWork[], nowMs: number = Date.now()): string | undefined {
  if (work.length === 0) return undefined;
  const detailed = detailedNote(work, nowMs);
  if (work.length <= MAX_NAMED_CONTINUITY_ITEMS && detailed.length <= MAX_CONTINUITY_NOTE_CHARS) {
    return detailed;
  }
  return genericNote(work);
}

export function formatCarryoverNote(snapshot: ContinuitySnapshot): string | undefined {
  const count = snapshot.items.length;
  if (count === 0) return undefined;
  return count === 1 ? "1 background process carried over." : `${count} background processes carried over.`;
}

export function freezeLiveAsyncWork(work: readonly OpenAsyncWork[]): readonly OpenAsyncWork[] {
  return Object.freeze(work.map((item) => Object.freeze({ ...item })));
}
