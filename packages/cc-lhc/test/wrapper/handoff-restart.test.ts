/**
 * LIM-80 Slice 3B2: pure ordered-journal-chain disposition (findings 3/8).
 * Aggregates per-segment read states into one chain decision: repairable / blocked
 * (delivering, never replay) / deliver (pending bytes) / settled / empty, carrying
 * the already-delivered byte total for truthful terminal accounting.
 */
import { describe, expect, it } from "vitest";

import { type ChainSegmentState, chainDisposition } from "../../src/wrapper/handoff-restart.js";

const pending = (bytes: number, label = "/j/p"): ChainSegmentState => ({ ok: true, label, state: "pending", bytes });
const delivering = (bytes: number, label = "/j/x"): ChainSegmentState => ({
  ok: true,
  label,
  state: "delivering",
  bytes,
});
const delivered = (bytes: number, label = "/j/d"): ChainSegmentState => ({
  ok: true,
  label,
  state: "delivered",
  bytes,
});
const bad = (label: string, reason: string): ChainSegmentState => ({ ok: false, label, reason });

describe("chainDisposition (LIM-80 3B2)", () => {
  it("empty chain → empty (a post-commit attempt with no journal, caller stays open)", () => {
    expect(chainDisposition([])).toEqual({ kind: "empty" });
  });

  it("any unreadable/mismatched segment → repairable, naming the failing segment (finding 5)", () => {
    expect(chainDisposition([delivered(4), bad("/j/gen2", "ancestry mismatch")])).toEqual({
      kind: "repairable",
      reason: "/j/gen2: ancestry mismatch",
      segment: "/j/gen2",
    });
  });

  it("any `delivering` segment → blocked, identifying the ACTUAL delivering segment + already-delivered bytes (finding 5)", () => {
    expect(chainDisposition([delivered(5), delivering(3, "/j/gen1"), pending(9)])).toEqual({
      kind: "blocked",
      deliveredBytes: 5,
      segment: "/j/gen1",
    });
  });

  it("pending bytes with no ambiguity → deliver, summing delivered + pending across the chain", () => {
    expect(chainDisposition([delivered(4), pending(6), pending(2)])).toEqual({
      kind: "deliver",
      deliveredBytes: 4,
      pendingBytes: 8,
    });
  });

  it("all delivered / pending-empty → settled with the delivered total", () => {
    expect(chainDisposition([delivered(4), pending(0), delivered(2)])).toEqual({ kind: "settled", deliveredBytes: 6 });
  });

  it("a single pending-empty origin journal → settled with zero bytes", () => {
    expect(chainDisposition([pending(0)])).toEqual({ kind: "settled", deliveredBytes: 0 });
  });

  it("repairable takes precedence over pending/delivering later in the chain", () => {
    expect(chainDisposition([bad("origin", "unreadable"), delivering(3)]).kind).toBe("repairable");
  });
});
