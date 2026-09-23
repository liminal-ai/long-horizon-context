/**
 * Rebuilt transcripts that predate their own lineage record.
 *
 * Before the not-yet-accepted reservation existed, Smart Compact wrote the
 * rebuilt transcript first and linked it to its thread only at the switch. A
 * whole-tree kill between the two left a file no record names; `cc-lhc -c`
 * then picks it as the newest transcript. Such a file is recognized by its
 * rebuild prefix — the synthetic assistant message ids the rebuild writes
 * (`msg_` + the line uuid) or its trailing `[lhc compact|prune:…]` receipt —
 * never linked to a thread from its content: the only evidence would be replay
 * signatures, and a short replayed tail of common text ("continue", "Done.")
 * can match an unrelated thread completely once the owner's bounded window has
 * aged those lines out. The operator gets guidance instead: pick the
 * conversation with `cc-lhc --resume`, with signature-matched threads listed
 * only as possible matches. Rebuilds written with a reservation record resolve
 * through that record (thread-alias), never through here.
 *
 * Only a transcript recognized as rebuilt is ever looked up; any other unknown
 * session is left to the ordinary new-thread path.
 */

import { readFile } from "node:fs/promises";
import { threads } from "lhc";
import type { RolloutLineItem } from "../rollout/types.js";

import { type LineageDbDeps, lookupSessionLineage, threadsMatchingSignatures } from "./lineage-db.js";
import { signaturesForRolloutLine } from "./replay-dedupe.js";
import { claudeSessionIdFromAlias } from "./thread-alias.js";

/**
 * A rebuilt transcript no record links to a thread. `possibleThreadIds` share
 * replayed lines with it, best first; they are hints for the operator, never
 * an answer.
 */
export interface UnlinkedRebuild {
  possibleThreadIds: string[];
}

/** How many signature-matched threads the guidance lists at most. */
const MAX_POSSIBLE_MATCHES = 3;

const SYNTHETIC_MESSAGE_ID = /^msg_[0-9a-f]{32}$/;
const RECEIPT_NOTE = /^\[runtime note\] \[lhc (compact|prune):/;
/** Lines the rebuild writes itself (summary bands, runtime notes): no thread ever recorded them. */
const SYNTHESIZED_USER_TEXT = /^\[(context · [a-z]+\]\n|runtime note\] )/;

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

function isSynthesized(item: RolloutLineItem): boolean {
  if (item.type !== "user") return false;
  const content = messageOf(item)?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string"
                ? (block as { text: string }).text
                : "",
            )
            .join("")
        : "";
  return SYNTHESIZED_USER_TEXT.test(text);
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

  // The replay signatures: only lines the rebuild replayed from the thread
  // can match its record, so the synthesized band and note lines are left out
  // of both the lookup and the half-threshold denominator.
  const signatures: string[] = [];
  for (const [index, item] of items.entries()) {
    if (isSynthesized(item)) continue;
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
  return {
    possibleThreadIds: ranked
      .filter((row) => row.matches > 0)
      .slice(0, MAX_POSSIBLE_MATCHES)
      .map((row) => row.threadId),
  };
}

/**
 * What to do with a rebuilt transcript cc-lhc cannot link to a thread.
 * `possibleTargets` are the current sessions of signature-matched threads.
 */
export function unlinkedRebuildGuidance(sessionId: string, possibleTargets: readonly string[]): string {
  const head =
    `cc-lhc: session ${sessionId} is a Smart Compact rebuilt transcript from an interrupted compaction that ` +
    "cc-lhc cannot link to a thread; capture is off for it. Continue the conversation it was compacted from: " +
    "run cc-lhc --resume with no id and pick it.";
  if (possibleTargets.length === 0) return head;
  return `${head} Possible matches (shared text only, unverified): ${possibleTargets
    .map((target) => `cc-lhc --resume ${target}`)
    .join(" | ")}`;
}

/** Current sessions of the possible threads, minus `exclude`. */
export async function possibleResumeTargets(
  threadIds: readonly string[],
  registryPath: string,
  exclude: string,
): Promise<string[]> {
  const targets: string[] = [];
  for (const threadId of threadIds) {
    const current = await threads.currentAlias({ threadId, registryPath });
    const target =
      current.ok && current.value.currentAlias !== null ? claudeSessionIdFromAlias(current.value.currentAlias) : null;
    if (target !== null && target !== exclude) targets.push(target);
  }
  return targets;
}

/**
 * Guidance when a launch names a rebuilt transcript no record links to its
 * thread: no lineage row, or only the row an earlier launch of it wrote with
 * unknown prefix provenance (a new, uncaptured thread). Null for any other
 * session. A one-shot prints it and exits rather than running Claude on a
 * transcript whose capture would be refused.
 */
export async function unlinkedRebuildLaunchGuidance(input: {
  sessionId: string;
  rolloutPath: string;
  registryPath: string;
  lineageDbPath: string;
  lineageDeps?: LineageDbDeps;
}): Promise<string | null> {
  let recorded: ReturnType<typeof lookupSessionLineage>;
  try {
    recorded = lookupSessionLineage(input.lineageDbPath, input.sessionId, input.lineageDeps);
  } catch {
    return null;
  }
  if (recorded !== undefined && recorded.prefix.kind !== "unknown") return null;
  const unlinked = await identifyUnlinkedRebuild({
    rolloutPath: input.rolloutPath,
    lineageDbPath: input.lineageDbPath,
    ...(input.lineageDeps === undefined ? {} : { lineageDeps: input.lineageDeps }),
  });
  if (unlinked === null) return null;
  const targets = await possibleResumeTargets(unlinked.possibleThreadIds, input.registryPath, input.sessionId);
  return unlinkedRebuildGuidance(input.sessionId, targets);
}
