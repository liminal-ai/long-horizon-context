import type { SessionThreadViewEntry } from "lhc";
import { describe, expect, it } from "vitest";
import {
  applySessionThreadViewToSessionManager,
  findSeedEntryMapInBranch,
  findSeedEntryMapInSession,
  LHC_SEED_ENTRY_MAP_TYPE,
  mapFirstKeptToEntryId,
} from "../../src/index.js";
import { type TempStore, tempStore } from "../fixtures/thread.js";
import { buildCompactLhcFixture } from "./lhc-thread-fixture.js";

const TARGET_PARAMS = {
  lowerBound: 400,
  percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
};

describe("seed-entry-map", () => {
  it("writes one row per represented LHC message at hydrate", () => {
    const entries: SessionThreadViewEntry[] = [
      {
        role: "user",
        content: "hello",
        sourceMessages: [{ messageId: "m1", idempotencyKey: "k1" }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t" },
          { type: "text", text: "a" },
          { type: "toolCall", toolCallId: "call_1", toolName: "read", arguments: {} },
        ],
        sourceMessages: [
          { messageId: "m10", idempotencyKey: "k10" },
          { messageId: "m11", idempotencyKey: "k11" },
          { messageId: "m12", idempotencyKey: "k12" },
        ],
      },
    ];

    const customEntries: unknown[] = [];
    let messageCalls = 0;
    const sessionManager = {
      appendMessage() {
        messageCalls += 1;
        return messageCalls === 1 ? "pi_user" : "pi_asst";
      },
      appendModelChange() {
        return "mc1";
      },
      appendThinkingLevelChange() {
        return "tl1";
      },
      appendCustomEntry(_type: string, data: unknown) {
        customEntries.push(data);
        return "seed_map_1";
      },
    };

    const seeded = applySessionThreadViewToSessionManager(sessionManager as never, entries, "th_seed");
    expect(seeded.seedEntryMapRows).toEqual([
      { lhcMessageId: "m1", piEntryId: "pi_user" },
      { lhcMessageId: "m10", piEntryId: "pi_asst" },
      { lhcMessageId: "m11", piEntryId: "pi_asst" },
      { lhcMessageId: "m12", piEntryId: "pi_asst" },
    ]);
    expect(customEntries).toHaveLength(1);
    expect(customEntries[0]).toMatchObject({
      customType: LHC_SEED_ENTRY_MAP_TYPE,
      threadId: "th_seed",
      entries: seeded.seedEntryMapRows,
    });
  });

  it("seeded entries carry prior-session idempotency keys, not null", () => {
    const entries: SessionThreadViewEntry[] = [
      {
        role: "user",
        content: "resumed",
        sourceMessages: [{ messageId: "m5", idempotencyKey: "pi:old_session:entry:e1:block:0:kind:user_prompt" }],
      },
    ];
    expect(entries[0]?.sourceMessages[0]?.idempotencyKey).not.toBeNull();
  });

  it("findSeedEntryMapInSession returns newest map", () => {
    const older = {
      type: "custom",
      customType: LHC_SEED_ENTRY_MAP_TYPE,
      data: {
        customType: LHC_SEED_ENTRY_MAP_TYPE,
        threadId: "th_a",
        entries: [{ lhcMessageId: "m1", piEntryId: "old" }],
      },
    };
    const newer = {
      type: "custom",
      customType: LHC_SEED_ENTRY_MAP_TYPE,
      data: {
        customType: LHC_SEED_ENTRY_MAP_TYPE,
        threadId: "th_a",
        entries: [{ lhcMessageId: "m1", piEntryId: "new" }],
      },
    };
    const found = findSeedEntryMapInSession([older, newer] as never);
    expect(found?.entries[0]?.piEntryId).toBe("new");
  });

  it("findSeedEntryMapInBranch ignores newer all-session sibling with wrong threadId", () => {
    const branchLocal = {
      type: "custom",
      customType: LHC_SEED_ENTRY_MAP_TYPE,
      data: {
        customType: LHC_SEED_ENTRY_MAP_TYPE,
        threadId: "th_active",
        entries: [{ lhcMessageId: "m1", piEntryId: "branch_pi" }],
      },
    };
    const siblingWrongThread = {
      type: "custom",
      customType: LHC_SEED_ENTRY_MAP_TYPE,
      data: {
        customType: LHC_SEED_ENTRY_MAP_TYPE,
        threadId: "th_other",
        entries: [{ lhcMessageId: "m1", piEntryId: "wrong" }],
      },
    };
    const branchEntries = [branchLocal, siblingWrongThread] as never;
    expect(findSeedEntryMapInBranch(branchEntries, "th_active")?.entries[0]?.piEntryId).toBe("branch_pi");
    expect(findSeedEntryMapInSession(branchEntries)?.entries[0]?.piEntryId).toBe("wrong");
  });

  it("seed-map rows remain valid for mapping after compact within session", async () => {
    const store: TempStore = tempStore();
    try {
      const fixture = await buildCompactLhcFixture(store);
      const sessionView = await fixture.sdk.threadView.getSessionThreadView({ filePath: fixture.filePath });
      expect(sessionView.ok).toBe(true);
      if (!sessionView.ok) return;

      const customEntries: unknown[] = [];
      const sessionManager = {
        appendMessage() {
          return "pi_kept";
        },
        appendModelChange() {
          return "mc1";
        },
        appendThinkingLevelChange() {
          return "tl1";
        },
        appendCustomEntry(_type: string, data: unknown) {
          customEntries.push(data);
          return "seed_map";
        },
      };

      applySessionThreadViewToSessionManager(
        sessionManager as never,
        sessionView.value.entries,
        sessionView.value.threadId,
      );
      const seedMap = findSeedEntryMapInSession(
        customEntries.map((data) => ({ type: "custom", customType: LHC_SEED_ENTRY_MAP_TYPE, data })) as never,
      );
      expect(seedMap).not.toBeNull();
      if (seedMap === null) return;

      const compact = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: TARGET_PARAMS });
      expect(compact.ok).toBe(true);
      if (!compact.ok || compact.value.firstKeptMessageId === null) return;

      const sessionViewAfter = await fixture.sdk.threadView.getSessionThreadView({ filePath: fixture.filePath });
      expect(sessionViewAfter.ok).toBe(true);
      if (!sessionViewAfter.ok) return;

      const keptRow = seedMap.entries.find((row) => row.lhcMessageId === compact.value.firstKeptMessageId);
      expect(keptRow).toBeDefined();
      if (keptRow === undefined) return;

      const mapping = mapFirstKeptToEntryId(
        compact.value.firstKeptMessageId,
        sessionViewAfter.value,
        seedMap,
        [
          {
            type: "message",
            id: keptRow.piEntryId,
            parentId: null,
            message: { role: "user", content: "x", timestamp: 1_700_000_000_000 },
          },
        ],
        "different_pi_session",
      );
      expect(mapping).toEqual({ firstKeptEntryId: keptRow.piEntryId, origin: "seeded" });
    } finally {
      store.cleanup();
    }
  });
});
