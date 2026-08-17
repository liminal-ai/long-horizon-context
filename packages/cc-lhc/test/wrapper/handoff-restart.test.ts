/**
 * LIM-80 Slice 3B2: pure restart-handoff decision helpers.
 * Journal disposition (findings 7-8) + terminal-success gate (finding 9).
 */
import { describe, expect, it } from "vitest";

import {
  type JournalDisposition,
  planJournalDisposition,
  planRestartTerminal,
} from "../../src/wrapper/handoff-restart.js";
import type { InputJournalHeader, InputJournalReadResult } from "../../src/wrapper/input-journal.js";

const HEADER: InputJournalHeader = {
  version: 1,
  journalId: "jid",
  receiptId: "r1",
  attemptId: "a1",
  oldSessionId: "old-1",
  rebuiltSessionId: "new-1",
  createdAt: "2026-08-17T00:00:00.000Z",
};

function ok(state: "pending" | "delivering" | "delivered", bytes: number): InputJournalReadResult {
  return { ok: true, header: HEADER, chunks: Buffer.alloc(bytes), state };
}

describe("planJournalDisposition (LIM-80 3B2)", () => {
  it("no journal artifact → legacy, never infer bytes", () => {
    expect(planJournalDisposition(null)).toEqual({ kind: "no_journal" });
  });
  it("pending with zero bytes → no_bytes (safe to terminalize)", () => {
    expect(planJournalDisposition(ok("pending", 0))).toEqual({ kind: "no_bytes" });
  });
  it("pending with bytes → deliver exactly once", () => {
    expect(planJournalDisposition(ok("pending", 12))).toEqual({ kind: "deliver", byteCount: 12 });
  });
  it("delivering → blocked_indeterminate, never replay", () => {
    expect(planJournalDisposition(ok("delivering", 9))).toEqual({ kind: "blocked_indeterminate", byteCount: 9 });
  });
  it("delivered → delivered, never replay", () => {
    expect(planJournalDisposition(ok("delivered", 9))).toEqual({ kind: "delivered" });
  });
  it("unreadable/mismatch/corrupt → open_repairable, not terminal", () => {
    const bad: InputJournalReadResult = { ok: false, reason: "journal binding does not match" };
    expect(planJournalDisposition(bad)).toEqual({ kind: "open_repairable", reason: "journal binding does not match" });
  });
});

describe("planRestartTerminal (LIM-80 3B2)", () => {
  const proven = {
    currentChildIsExactActive: true,
    rebuiltSessionCurrent: true,
    foreignReplacementLiveOrIndeterminate: false,
    rolloutVerified: true,
  };
  it("never terminalizes while a DIFFERENT recorded replacement is live/indeterminate", () => {
    const d = planRestartTerminal({
      ...proven,
      foreignReplacementLiveOrIndeterminate: true,
      journal: { kind: "delivered" },
    });
    expect(d.kind).toBe("open");
    if (d.kind === "open") expect(d.reason).toMatch(/different recorded replacement/);
  });
  it("blocks when the current session is not the rebuilt session / capture not ready", () => {
    expect(planRestartTerminal({ ...proven, rebuiltSessionCurrent: false, journal: { kind: "delivered" } }).kind).toBe(
      "open",
    );
  });
  it("blocks when the current child is not the EXACT active replacement identity", () => {
    expect(
      planRestartTerminal({ ...proven, currentChildIsExactActive: false, journal: { kind: "delivered" } }).kind,
    ).toBe("open");
  });
  it("blocks when the rollout is not re-verified", () => {
    expect(planRestartTerminal({ ...proven, rolloutVerified: false, journal: { kind: "delivered" } }).kind).toBe(
      "open",
    );
  });
  it("delivered journal + full proofs → success", () => {
    expect(planRestartTerminal({ ...proven, journal: { kind: "delivered" } }).kind).toBe("success");
  });
  it("no_bytes + full proofs → success", () => {
    expect(planRestartTerminal({ ...proven, journal: { kind: "no_bytes" } }).kind).toBe("success");
  });
  it("no_journal at a post-commit attempt → open (never infer bytes absent)", () => {
    const d = planRestartTerminal({ ...proven, journal: { kind: "no_journal" } });
    expect(d.kind).toBe("open");
    if (d.kind === "open") expect(d.reason).toMatch(/no input journal/);
  });
  it("pending bytes + full proofs → deliver_then_success", () => {
    expect(planRestartTerminal({ ...proven, journal: { kind: "deliver", byteCount: 5 } }).kind).toBe(
      "deliver_then_success",
    );
  });
  it("delivering journal NEVER auto-terminalizes as success (blocked)", () => {
    const d = planRestartTerminal({ ...proven, journal: { kind: "blocked_indeterminate", byteCount: 3 } });
    expect(d.kind).toBe("blocked");
    if (d.kind === "blocked") expect(d.reason).toMatch(/never auto-replay/);
  });
  it("repairable journal leaves it open even with full child/rollout proof", () => {
    const j: JournalDisposition = { kind: "open_repairable", reason: "corrupt" };
    expect(planRestartTerminal({ ...proven, journal: j }).kind).toBe("open");
  });
});
