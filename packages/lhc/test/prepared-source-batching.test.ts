import { describe, expect, it } from "vitest";
import { readPreparedSourceState } from "../src/thread-view/index.js";
import { derivedThreadFixture, openRaw, tempStore } from "./fixtures/index.js";

describe("prepared-source selected-turn batching", () => {
  it("preserves the canonical digest above SQLite's variable ceiling", async () => {
    const store = tempStore();
    try {
      const fixture = await derivedThreadFixture(store, { failures: false });
      const db = openRaw(fixture.filePath);
      try {
        const actualTurnIds = (
          db.prepare(`SELECT turn_id FROM turns ORDER BY turn_id`).all() as unknown as Array<{ turn_id: string }>
        ).map((row) => row.turn_id);
        const canonicalTurnIds = (
          db.prepare(`SELECT turn_id FROM turns ORDER BY turn_order`).all() as unknown as Array<{ turn_id: string }>
        ).map((row) => row.turn_id);
        const overLimit = [
          ...actualTurnIds,
          ...Array.from(
            { length: 33_000 },
            (_, index) =>
              `${actualTurnIds[index % actualTurnIds.length]}-pad-${index.toString().padStart(5, "0")}`,
          ),
        ];
        const sortedOverLimit = [...overLimit].sort();
        const realBatchIndexes = new Set(
          actualTurnIds.map((turnId) => Math.floor(sortedOverLimit.indexOf(turnId) / 400)),
        );
        expect(actualTurnIds).not.toEqual(canonicalTurnIds);
        expect(realBatchIndexes.size).toBeGreaterThan(1);
        const compactPoint = Number.MAX_SAFE_INTEGER;
        const small = readPreparedSourceState(db, compactPoint, { selectedSourceTurnIds: actualTurnIds });
        const batched = readPreparedSourceState(db, compactPoint, { selectedSourceTurnIds: overLimit });
        expect(batched.tailDigest).toBe(small.tailDigest);

        // Kills a no-global-reorder mutant: the same union arrives from
        // different batches but must hash in canonical message/block order.
        const shuffled = [...overLimit].reverse();
        expect(readPreparedSourceState(db, compactPoint, { selectedSourceTurnIds: shuffled }).tailDigest).toBe(
          small.tailDigest,
        );

        // Kills a no-dedup mutant: repeated selected IDs cannot duplicate rows.
        expect(
          readPreparedSourceState(db, compactPoint, {
            selectedSourceTurnIds: [...overLimit, ...actualTurnIds],
          }).tailDigest,
        ).toBe(small.tailDigest);

        // Kills a dropped-batch mutant: omitting an actual selected source is visible.
        expect(
          readPreparedSourceState(db, compactPoint, {
            selectedSourceTurnIds: overLimit.filter((turnId) => turnId !== actualTurnIds[0]),
          }).tailDigest,
        ).not.toBe(small.tailDigest);
      } finally {
        db.close();
      }
    } finally {
      store.cleanup();
    }
  }, 120_000);
});
