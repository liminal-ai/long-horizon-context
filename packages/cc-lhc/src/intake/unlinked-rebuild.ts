/**
 * Rebuilt transcripts that predate their own lineage record.
 *
 * Before the not-yet-accepted reservation existed, Smart Compact wrote the
 * rebuilt transcript first and linked it to its thread only at the switch. A
 * whole-tree kill between the two left a file no record names; `cc-lhc -c`
 * then picks it as the newest transcript. Such a file is recognized by its
 * rebuild prefix — the synthetic assistant message ids the rebuild writes
 * (`msg_` + the line uuid) or its trailing `[lhc compact|prune:…]` receipt —
 * and linked back to its thread through the thread's recorded replay
 * signatures, which the prefix's replayed turns reproduce.
 *
 * Only a transcript recognized as rebuilt is ever looked up; any other unknown
 * session is left to the ordinary new-thread path.
 */

import { readFile } from "node:fs/promises";

import type { RolloutLineItem } from "../rollout/types.js";
import { type LineageDbDeps, threadsMatchingSignatures } from "./lineage-db.js";
import { signaturesForRolloutLine } from "./replay-dedupe.js";

export type UnlinkedRebuild =
  | { kind: "linked"; threadId: string; matches: number }
  /** Rebuilt, but no single thread is identified; `candidates` tie or are empty. */
  | { kind: "unidentified"; candidateThreadIds: string[] };

const SYNTHETIC_MESSAGE_ID = /^msg_[0-9a-f]{32}$/;
const RECEIPT_NOTE = /^\[runtime note\] \[lhc (compact|prune):/;

function parseLines(content: string): RolloutLineItem[] {
  const items: RolloutLineItem[] = [];
  for (const raw of content.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) items.push(parsed as RolloutLineItem);
    } catch {
      // A torn or foreign line says nothing either way.
    }
  }
  return items;
}

function messageOf(item: RolloutLineItem): Record<string, unknown> | undefined {
  const message = (item as { message?: unknown }).message;
  return typeof message === "object" && message !== null ? (message as Record<string, unknown>) : undefined;
}

/** True when the lines carry the rebuild prefix's own fingerprint. */
export function hasRebuildPrefix(items: readonly RolloutLineItem[]): boolean {
  const lineUuids = new Set<string>();
  for (const item of items) {
    if (typeof item.uuid === "string") lineUuids.add(item.uuid.replace(/-/g, ""));
  }
  for (const item of items) {
    const message = messageOf(item);
    if (message === undefined) continue;
    const id = message.id;
    if (item.type === "assistant" && typeof id === "string" && SYNTHETIC_MESSAGE_ID.test(id)) {
      if (lineUuids.has(id.slice("msg_".length))) return true;
    }
    if (item.type === "user" && typeof message.content === "string" && RECEIPT_NOTE.test(message.content)) {
      return true;
    }
  }
  return false;
}

/**
 * Link an unrecorded transcript to the thread it was rebuilt from. Null when
 * the file is absent, unreadable, or not a rebuilt transcript.
 */
export async function identifyUnlinkedRebuild(input: {
  rolloutPath: string;
  lineageDbPath: string;
  lineageDeps?: LineageDbDeps;
  readFileFn?: (path: string) => Promise<string>;
}): Promise<UnlinkedRebuild | null> {
  let content: string;
  try {
    content = await (input.readFileFn ?? ((path: string) => readFile(path, "utf8")))(input.rolloutPath);
  } catch {
    return null;
  }
  const items = parseLines(content);
  if (!hasRebuildPrefix(items)) return null;

  const signatures: string[] = [];
  for (const [index, item] of items.entries()) {
    try {
      signatures.push(...signaturesForRolloutLine(item, index));
    } catch {
      // A line the mapper cannot read contributes nothing.
    }
  }
  let ranked: Array<{ threadId: string; matches: number }>;
  try {
    ranked = threadsMatchingSignatures(input.lineageDbPath, signatures, input.lineageDeps);
  } catch {
    ranked = [];
  }
  const [top, second] = ranked;
  if (top !== undefined && (second === undefined || top.matches > second.matches)) {
    return { kind: "linked", threadId: top.threadId, matches: top.matches };
  }
  const best = top?.matches ?? 0;
  return {
    kind: "unidentified",
    candidateThreadIds: ranked.filter((row) => row.matches === best).map((row) => row.threadId),
  };
}

/**
 * The exact next step for a rebuilt transcript cc-lhc cannot link to a thread.
 * `resumeTargets` are the current sessions of the candidate threads.
 */
export function unlinkedRebuildGuidance(sessionId: string, resumeTargets: readonly string[]): string {
  const head =
    `cc-lhc: session ${sessionId} is a Smart Compact rebuilt transcript from an interrupted compaction and ` +
    "was never linked to its thread; capture is off for it.";
  if (resumeTargets.length === 1) {
    return `${head} Continue the conversation with: cc-lhc --resume ${resumeTargets[0]}`;
  }
  if (resumeTargets.length > 1) {
    return `${head} Continue the conversation with one of: ${resumeTargets
      .map((target) => `cc-lhc --resume ${target}`)
      .join(" | ")}`;
  }
  return (
    `${head} Continue the conversation it was compacted from with: cc-lhc --resume <that session's id> ` +
    "(run cc-lhc --resume with no id to pick it)"
  );
}
