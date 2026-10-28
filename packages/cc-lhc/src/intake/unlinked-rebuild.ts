import { readFile } from "node:fs/promises";
import { threads } from "lhc";
import type { RolloutLineItem } from "../rollout/types.js";

import { type LineageDbDeps, lookupSessionLineage, threadsMatchingSignatures } from "./lineage-db.js";
import { signaturesForRolloutLine } from "./replay-dedupe.js";
import { claudeSessionIdFromAlias } from "./thread-alias.js";

export interface UnlinkedRebuild {
  possibleThreadIds: string[];
}

const MAX_POSSIBLE_MATCHES = 3;

const SYNTHETIC_MESSAGE_ID = /^msg_[0-9a-f]{32}$/;
const RECEIPT_NOTE = /^\[runtime note\] \[lhc (compact|prune):/;
const SYNTHESIZED_USER_TEXT = /^\[(context · [a-z]+\]\n|runtime note\] )/;

function parseLines(content: string): RolloutLineItem[] {
  const items: RolloutLineItem[] = [];
  for (const raw of content.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) items.push(parsed as RolloutLineItem);
    } catch {}
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
    if (isSynthesized(item)) continue;
    try {
      signatures.push(...signaturesForRolloutLine(item, index));
    } catch {}
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
