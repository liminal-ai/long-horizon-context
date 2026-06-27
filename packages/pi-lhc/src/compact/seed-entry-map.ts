import type { SessionEntry } from "../pi/types.js";

export const LHC_SEED_ENTRY_MAP_TYPE = "pi-lhc.seed-entry-map";

export interface LhcSeedEntryMapRow {
  lhcMessageId: string;
  piEntryId: string;
}

export interface LhcSeedEntryMap {
  customType: typeof LHC_SEED_ENTRY_MAP_TYPE;
  threadId: string;
  entries: LhcSeedEntryMapRow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSeedEntryMapData(data: unknown): LhcSeedEntryMap | null {
  const record = isRecord(data) ? data : null;
  if (record === null) return null;
  const customType = record.customType;
  const threadId = record.threadId;
  const entries = record.entries;
  if (customType !== LHC_SEED_ENTRY_MAP_TYPE || typeof threadId !== "string" || threadId === "") {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  const rows: LhcSeedEntryMapRow[] = [];
  for (const row of entries) {
    if (!isRecord(row)) return null;
    const lhcMessageId = row.lhcMessageId;
    const piEntryId = row.piEntryId;
    if (typeof lhcMessageId !== "string" || lhcMessageId === "") return null;
    if (typeof piEntryId !== "string" || piEntryId === "") return null;
    rows.push({ lhcMessageId, piEntryId });
  }
  return { customType: LHC_SEED_ENTRY_MAP_TYPE, threadId, entries: rows };
}

function parseSeedEntryMapFromEntry(entry: SessionEntry): LhcSeedEntryMap | null {
  const matchesType =
    entry.customType === LHC_SEED_ENTRY_MAP_TYPE ||
    (entry.type === "custom" && isRecord(entry.data) && entry.data.customType === LHC_SEED_ENTRY_MAP_TYPE);
  if (!matchesType) return null;
  const fromData = parseSeedEntryMapData(entry.data);
  if (fromData !== null) return fromData;
  return parseSeedEntryMapData(entry);
}

/** Newest seed-entry-map on the compact branch is authoritative; threadId must match. */
export function findSeedEntryMapInBranch(
  branchEntries: readonly SessionEntry[],
  activeThreadId: string,
): LhcSeedEntryMap | null {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (entry === undefined) continue;
    const parsed = parseSeedEntryMapFromEntry(entry);
    if (parsed !== null && parsed.threadId === activeThreadId) return parsed;
  }
  return null;
}

/** Newest seed-entry-map in PI session entries is authoritative (no thread filter). */
export function findSeedEntryMapInSession(entries: readonly SessionEntry[]): LhcSeedEntryMap | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const parsed = parseSeedEntryMapFromEntry(entry);
    if (parsed !== null) return parsed;
  }
  return null;
}
