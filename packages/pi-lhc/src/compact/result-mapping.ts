import type { Band, CompactReceipt, SessionThreadView, SessionThreadViewEntrySource } from "lhc";
import { parseEventKeySource } from "../capture/idempotency.js";
import type { CompactionResult, SessionEntry } from "../pi/types.js";
import type { LhcSeedEntryMap } from "./seed-entry-map.js";

export interface FirstKeptMapping {
  firstKeptEntryId: string;
  origin: "live" | "seeded" | "summary_only";
}

export type FirstKeptMappingResult = { mappingFailed: true; reason: string } | FirstKeptMapping;

/**
 * Host-only splice when LHC evicted every PI-mappable tail message.
 *
 * Pi's CompactionResult.firstKeptEntryId is a required string. buildContextEntries
 * (vendor/pi session-manager) keeps pre-compaction entries only after that id is
 * found on the path; an unmatched id yields [compaction summary] + later entries.
 * This sentinel cannot collide with Pi uuidv7/randomUUID entry ids, so it is the
 * explicit "no kept raw tail" cut. Do not point at preparation.firstKeptEntryId:
 * that would retain the oversized raw turn the selector just evicted.
 */
export const SUMMARY_ONLY_FIRST_KEPT_ENTRY_ID = "pi-lhc:summary-only" as const;

/** True empty mappable tail: compact point advanced, but no PI-mappable message remains past it. */
export function isSummaryOnlyTail(preview: { compactPoint: number; firstKeptMessageId: string | null }): boolean {
  return preview.firstKeptMessageId === null && preview.compactPoint > 0;
}

export function summaryOnlyFirstKeptMapping(): FirstKeptMapping {
  return { firstKeptEntryId: SUMMARY_ONLY_FIRST_KEPT_ENTRY_ID, origin: "summary_only" };
}

function branchEntryIds(branchEntries: readonly SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of branchEntries) {
    if (typeof entry.id === "string" && entry.id !== "") ids.add(entry.id);
  }
  return ids;
}

function keyMatchesCurrentSession(key: string, currentPiSessionId: string): boolean {
  return key.startsWith(`pi:${currentPiSessionId}:`);
}

function findSourceForMessage(
  sessionView: SessionThreadView,
  firstKeptMessageId: string,
): SessionThreadViewEntrySource | null {
  for (const entry of sessionView.entries) {
    if (!("sourceMessages" in entry)) continue;
    for (const source of entry.sourceMessages) {
      if (source.messageId === firstKeptMessageId) return source;
    }
  }
  return null;
}

export function mapFirstKeptToEntryId(
  firstKeptMessageId: string,
  sessionView: SessionThreadView,
  seedEntryMap: LhcSeedEntryMap | null,
  branchEntries: readonly SessionEntry[],
  currentPiSessionId: string,
): FirstKeptMappingResult {
  const source = findSourceForMessage(sessionView, firstKeptMessageId);
  if (source === null) {
    return { mappingFailed: true, reason: `no session-view source for message ${firstKeptMessageId}` };
  }

  const branchIds = branchEntryIds(branchEntries);
  const key = source.idempotencyKey;

  if (key !== null && key !== "" && keyMatchesCurrentSession(key, currentPiSessionId)) {
    const parsed = parseEventKeySource(key);
    if (parsed?.entryId === undefined) {
      return { mappingFailed: true, reason: "live idempotency key is not entry-scoped" };
    }
    if (branchIds.has(parsed.entryId)) {
      return { firstKeptEntryId: parsed.entryId, origin: "live" };
    }
  }

  const seededId = seedEntryMap?.entries.find((row) => row.lhcMessageId === firstKeptMessageId)?.piEntryId;
  if (seededId !== undefined) {
    if (!branchIds.has(seededId)) {
      return { mappingFailed: true, reason: "seed entry id is not in branch entries" };
    }
    return { firstKeptEntryId: seededId, origin: "seeded" };
  }

  return { mappingFailed: true, reason: "neither live nor seed tier resolved" };
}

export function assembleSummaryFromRenderedBands(renderedBands: ReadonlyArray<{ band: Band; text: string }>): string {
  const parts: string[] = [];
  for (const { band, text } of renderedBands) {
    if (text.trim() === "") continue;
    parts.push(`[context · ${band}]\n${text}`);
  }
  return parts.join("\n\n");
}

export function assembleCompactionResult(
  receipt: CompactReceipt,
  firstKeptEntryId: string,
  tokensBefore: number,
): CompactionResult<CompactReceipt> {
  return {
    summary: assembleSummaryFromRenderedBands(receipt.renderedBands),
    firstKeptEntryId,
    tokensBefore,
    details: receipt,
  };
}
