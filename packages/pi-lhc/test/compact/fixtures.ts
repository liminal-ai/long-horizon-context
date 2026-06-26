import type { Band, CompactReceipt } from "lhc";
import { eventKey } from "../../src/capture/idempotency.js";
import type { LhcSeedEntryMap } from "../../src/compact/seed-entry-map.js";
import type { AgentMessage, SessionBeforeCompactEvent, SessionEntry } from "../../src/pi/types.js";

export function makeCompactReceipt(overrides: Partial<CompactReceipt> = {}): CompactReceipt {
  return {
    viewId: "v42",
    profile: null,
    config: { full: 25, smooth: 35, detailed: 20, brief: 20, lowerBound: 120_000 },
    bands: {
      brief: { entries: 2, tokens: 5000 },
      detailed: { entries: 1, tokens: 8000 },
      smooth: { entries: 3, tokens: 12_000 },
    } as CompactReceipt["bands"],
    tailTokens: 25_000,
    totalTokens: 50_000,
    coveredFrom: 1,
    compactPoint: 28,
    degraded: [],
    gaps: [],
    renderedBands: [
      { band: "brief" as Band, text: "brief band body" },
      { band: "detailed" as Band, text: "detailed band body" },
      { band: "smooth" as Band, text: "smooth band body" },
    ],
    firstKeptMessageId: "m14",
    ...overrides,
  };
}

export function makeBranchEntries(messageCount: number): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    entries.push({
      type: "message",
      id: `entry_${index}`,
      parentId: index === 0 ? null : `entry_${index - 1}`,
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: index % 2 === 0 ? `message ${index}` : [{ type: "text" as const, text: `message ${index}` }],
      } as AgentMessage,
    });
  }
  return entries;
}

export function makeSeedEntryMap(
  entries: Array<{ lhcMessageId: string; piEntryId: string }>,
  threadId = "th_test",
): LhcSeedEntryMap {
  return { customType: "pi-lhc.seed-entry-map", threadId, entries };
}

export function liveIdempotencyKey(piSessionId: string, entryId: string, kind = "user_prompt"): string {
  return eventKey({ piSessionId, entryId, blockIndex: 0, kind: kind as "user_prompt" });
}

export function makeBeforeCompactEvent(overrides: Partial<SessionBeforeCompactEvent> = {}): SessionBeforeCompactEvent {
  const controller = new AbortController();
  return {
    type: "session_before_compact",
    reason: "manual",
    willRetry: false,
    preparation: {
      firstKeptEntryId: "entry_0",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 99_000,
      fileOps: { readFiles: [], modifiedFiles: [] },
      settings: { enabled: true, reserveTokens: 32_000, keepRecentTokens: 20_000 },
    },
    branchEntries: makeBranchEntries(4),
    signal: controller.signal,
    ...overrides,
  };
}
