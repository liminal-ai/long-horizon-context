/**
 * LIM-80 Slice 3B2: append-only replacement generation EVENT log (two-phase).
 * Findings 1/3/4/9/12 — active identity from ready events, exact-prefix merge with
 * full revalidation, strict event shape, phase ordering (prepared-before-ready,
 * unique ids, no duplicates), journal chain, and pending-prepared recovery.
 */
import { describe, expect, it } from "vitest";

import {
  activeReplacementIdentity,
  journalChain,
  mergeRecoveryArtifacts,
  parseRecoveryArtifacts,
  pendingPreparedGenerations,
  type RecoveryArtifacts,
  type ReplacementGenerationEvent,
  validateGenerationEvents,
} from "../../src/governor/recovery.js";
import type { ProcessIdentity } from "../../src/runtime/process-identity.js";

const pid = (n: number, starttime: string): ProcessIdentity => ({ pid: n, bootId: "boot", starttime });
const ORIGINAL = pid(100, "1");
const REPL_A = pid(200, "2");
const REPL_B = pid(300, "3");
const OLD_A = pid(210, "20");
const OLD_B = pid(310, "30");

const adoptReady = (
  generationId: string,
  replacement: ProcessIdentity,
  origin = "att-0",
): ReplacementGenerationEvent => ({
  kind: "adopt_ready",
  generationId,
  originAttemptId: origin,
  replacement,
});
const prepared = (
  generationId: string,
  oldChild: ProcessIdentity,
  journalPath: string,
  origin = "att-0",
): ReplacementGenerationEvent => ({
  kind: "respawn_prepared",
  generationId,
  originAttemptId: origin,
  oldChild,
  journalPath,
  journalId: `jid-${generationId}`,
});
const respawnReady = (
  generationId: string,
  replacement: ProcessIdentity,
  origin = "att-0",
): ReplacementGenerationEvent => ({
  kind: "respawn_ready",
  generationId,
  originAttemptId: origin,
  replacement,
});

describe("activeReplacementIdentity (event log)", () => {
  it("is undefined, then the original, then the last READY (a prepared-only respawn is NOT active)", () => {
    expect(activeReplacementIdentity({})).toBeUndefined();
    expect(activeReplacementIdentity({ replacementChild: ORIGINAL })).toEqual(ORIGINAL);
    // Prepared but not ready → still the original, not the unproven respawn.
    expect(
      activeReplacementIdentity({
        replacementChild: ORIGINAL,
        replacementGenerationEvents: [prepared("g1", OLD_A, "/j/1")],
      }),
    ).toEqual(ORIGINAL);
    // After ready → the proven replacement.
    expect(
      activeReplacementIdentity({
        replacementChild: ORIGINAL,
        replacementGenerationEvents: [prepared("g1", OLD_A, "/j/1"), respawnReady("g1", REPL_A)],
      }),
    ).toEqual(REPL_A);
  });
});

describe("validateGenerationEvents (phase ordering)", () => {
  it("accepts adopt standalone and a full respawn prepared→ready", () => {
    expect(validateGenerationEvents([adoptReady("g1", REPL_A)])).toBe(true);
    expect(validateGenerationEvents([prepared("g1", OLD_A, "/j/1"), respawnReady("g1", REPL_A)])).toBe(true);
  });
  it("rejects a ready without a prior prepared", () => {
    expect(validateGenerationEvents([respawnReady("g1", REPL_A)])).toBe(false);
  });
  it("rejects a duplicate ready or duplicate prepared", () => {
    expect(
      validateGenerationEvents([prepared("g1", OLD_A, "/j/1"), respawnReady("g1", REPL_A), respawnReady("g1", REPL_B)]),
    ).toBe(false);
    expect(validateGenerationEvents([prepared("g1", OLD_A, "/j/1"), prepared("g1", OLD_B, "/j/2")])).toBe(false);
  });
  it("rejects mixing adopt and respawn under one generation id", () => {
    expect(validateGenerationEvents([adoptReady("g1", REPL_A), prepared("g1", OLD_A, "/j/1")])).toBe(false);
  });
  it("accepts three generations interleaved by id in order", () => {
    expect(
      validateGenerationEvents([
        prepared("g1", OLD_A, "/j/1"),
        respawnReady("g1", REPL_A),
        adoptReady("g2", REPL_B),
        prepared("g3", OLD_B, "/j/3"),
      ]),
    ).toBe(true);
  });

  // Finding 7 (strengthened validation) ────────────────────────────────
  it("rejects a READY replacement identity that repeats an earlier READY identity", () => {
    // Two adopts claiming the same live child identity is impossible.
    expect(validateGenerationEvents([adoptReady("g1", REPL_A), adoptReady("g2", REPL_A)])).toBe(false);
    // A respawn readying an identity a prior generation already readied.
    expect(
      validateGenerationEvents([
        prepared("g1", OLD_A, "/j/1"),
        respawnReady("g1", REPL_A),
        prepared("g2", OLD_B, "/j/2"),
        respawnReady("g2", REPL_A),
      ]),
    ).toBe(false);
  });

  it("a respawn_ready may only close the LATEST still-open prepared; never an older one after a newer generation started", () => {
    // g1 prepared, g2 prepared (g1 abandoned), then ready(g1) is illegal.
    expect(
      validateGenerationEvents([
        prepared("g1", OLD_A, "/j/1"),
        prepared("g2", OLD_B, "/j/2"),
        respawnReady("g1", REPL_A),
      ]),
    ).toBe(false);
    // Closing the LATEST open prepared (g2) is valid; g1 stays abandoned.
    expect(
      validateGenerationEvents([
        prepared("g1", OLD_A, "/j/1"),
        prepared("g2", OLD_B, "/j/2"),
        respawnReady("g2", REPL_A),
      ]),
    ).toBe(true);
    // An adopt starting after an open prepared abandons it: a later ready(g1) is illegal.
    expect(
      validateGenerationEvents([prepared("g1", OLD_A, "/j/1"), adoptReady("g2", REPL_B), respawnReady("g1", REPL_A)]),
    ).toBe(false);
  });

  it("merge rejects appending a duplicate-identity or out-of-order ready (revalidates the whole log)", () => {
    const stored: RecoveryArtifacts = {
      replacementGenerationEvents: [prepared("g1", OLD_A, "/j/1"), respawnReady("g1", REPL_A)],
    };
    // Appending a second generation readying REPL_A again is rejected.
    const dup = mergeRecoveryArtifacts(stored, {
      replacementGenerationEvents: [
        prepared("g1", OLD_A, "/j/1"),
        respawnReady("g1", REPL_A),
        prepared("g2", OLD_B, "/j/2"),
        respawnReady("g2", REPL_A),
      ],
    });
    expect(dup.ok).toBe(false);
  });
});

describe("mergeRecoveryArtifacts replacementGenerationEvents (exact-prefix + revalidate)", () => {
  it("appends new events onto an exact prefix, keeping the log well-formed", () => {
    const stored: RecoveryArtifacts = { replacementGenerationEvents: [prepared("g1", OLD_A, "/j/1")] };
    const merged = mergeRecoveryArtifacts(stored, {
      replacementGenerationEvents: [
        prepared("g1", OLD_A, "/j/1"),
        respawnReady("g1", REPL_A),
        adoptReady("g2", REPL_B),
      ],
    });
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.artifacts.replacementGenerationEvents).toHaveLength(3);
      expect(activeReplacementIdentity(merged.artifacts)).toEqual(REPL_B);
    }
  });
  it("rejects rewriting an existing event (not an exact prefix)", () => {
    const stored: RecoveryArtifacts = { replacementGenerationEvents: [prepared("g1", OLD_A, "/j/1")] };
    const merged = mergeRecoveryArtifacts(stored, { replacementGenerationEvents: [prepared("g1", OLD_B, "/j/1")] });
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.conflictKey).toBe("replacementGenerationEvents");
  });
  it("rejects a truncating (shorter) log", () => {
    const stored: RecoveryArtifacts = {
      replacementGenerationEvents: [prepared("g1", OLD_A, "/j/1"), respawnReady("g1", REPL_A)],
    };
    const merged = mergeRecoveryArtifacts(stored, { replacementGenerationEvents: [prepared("g1", OLD_A, "/j/1")] });
    expect(merged.ok).toBe(false);
  });
  it("rejects an append that makes the log ill-formed (ready without prepared)", () => {
    const stored: RecoveryArtifacts = { replacementGenerationEvents: [] };
    const merged = mergeRecoveryArtifacts(stored, { replacementGenerationEvents: [respawnReady("g9", REPL_A)] });
    expect(merged.ok).toBe(false);
  });
});

describe("parseRecoveryArtifacts event strictness (finding 12)", () => {
  it("round-trips adopt + respawn(prepared,ready) events", () => {
    const artifacts: RecoveryArtifacts = {
      replacementChild: ORIGINAL,
      inputJournalOriginAttemptId: "att-origin",
      replacementGenerationEvents: [
        prepared("g1", OLD_A, "/j/1"),
        respawnReady("g1", REPL_A),
        adoptReady("g2", REPL_B),
      ],
    };
    expect(parseRecoveryArtifacts(JSON.parse(JSON.stringify(artifacts)))).toEqual(artifacts);
  });
  it("rejects an adopt event carrying oldChild/journal (no partial pairs)", () => {
    expect(
      parseRecoveryArtifacts({
        replacementGenerationEvents: [
          { kind: "adopt_ready", generationId: "g1", originAttemptId: "a", replacement: ORIGINAL, journalPath: "/x" },
        ],
      }),
    ).toBeNull();
  });
  it("rejects a respawn_prepared missing journalId, and unknown keys", () => {
    expect(
      parseRecoveryArtifacts({
        replacementGenerationEvents: [
          { kind: "respawn_prepared", generationId: "g1", originAttemptId: "a", oldChild: OLD_A, journalPath: "/x" },
        ],
      }),
    ).toBeNull();
    expect(
      parseRecoveryArtifacts({
        replacementGenerationEvents: [
          { kind: "adopt_ready", generationId: "g1", originAttemptId: "a", replacement: ORIGINAL, extra: 1 },
        ],
      }),
    ).toBeNull();
  });
  it("rejects a persisted log that violates phase ordering", () => {
    expect(parseRecoveryArtifacts({ replacementGenerationEvents: [respawnReady("g1", REPL_A)] })).toBeNull();
  });
});

describe("journalChain + pendingPreparedGenerations (findings 3/4)", () => {
  it("orders the origin journal first, then respawn segments in append order", () => {
    const a: RecoveryArtifacts = {
      inputJournalPath: "/j/origin",
      inputJournalId: "jid-origin",
      inputJournalOriginAttemptId: "att-origin",
      replacementGenerationEvents: [
        prepared("g1", OLD_A, "/j/1"),
        respawnReady("g1", REPL_A),
        prepared("g2", OLD_B, "/j/2"),
      ],
    };
    expect(journalChain(a).map((s) => s.path)).toEqual(["/j/origin", "/j/1", "/j/2"]);
    expect(journalChain(a).map((s) => s.source)).toEqual(["origin", "generation", "generation"]);
    // g2 prepared but not ready → a pending prepared generation awaiting proof.
    const pending = pendingPreparedGenerations(a);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.generationId).toBe("g2");
    expect(pending[0]!.oldChild).toEqual(OLD_B);
  });
});
