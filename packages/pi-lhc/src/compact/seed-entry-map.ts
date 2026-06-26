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

/** Newest seed-entry-map in PI session entries is authoritative. */
export function findSeedEntryMapInSession(entries: readonly SessionEntry[]): LhcSeedEntryMap | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const matchesType =
      entry.customType === LHC_SEED_ENTRY_MAP_TYPE ||
      (entry.type === "custom" && isRecord(entry.data) && entry.data.customType === LHC_SEED_ENTRY_MAP_TYPE);
    if (!matchesType) continue;
    const fromData = parseSeedEntryMapData(entry.data);
    if (fromData !== null) return fromData;
    const fromEntry = parseSeedEntryMapData(entry);
    if (fromEntry !== null) return fromEntry;
  }
  return null;
}
