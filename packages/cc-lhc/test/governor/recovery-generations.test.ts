/**
 * LIM-80 Slice 3B2: append-only replacement recovery-generation history.
 * Findings 2/7/11 — active identity resolution, exact-prefix merge (append only,
 * never rewrite), rich record round-trip, and >1 generation (repeated crashes).
 */
import { describe, expect, it } from "vitest";

import {
  activeReplacementIdentity,
  mergeRecoveryArtifacts,
  parseRecoveryArtifacts,
  type RecoveryArtifacts,
  type ReplacementGeneration,
} from "../../src/governor/recovery.js";
import type { ProcessIdentity } from "../../src/runtime/process-identity.js";

const id = (pid: number, starttime: string): ProcessIdentity => ({ pid, bootId: "boot", starttime });
const ORIGINAL = id(100, "1");
const GEN_A = id(200, "2");
const GEN_B = id(300, "3");
const GEN_C = id(400, "4");

const adopt = (replacement: ProcessIdentity): ReplacementGeneration => ({ replacement, via: "adopt" });
const respawn = (
  replacement: ProcessIdentity,
  oldChild: ProcessIdentity,
  journalPath: string,
): ReplacementGeneration => ({
  replacement,
  via: "respawn",
  oldChild,
  journalPath,
  journalId: `jid-${replacement.pid}`,
});

describe("activeReplacementIdentity (LIM-80 3B2)", () => {
  it("is undefined before any replacement, then the original, then the last generation", () => {
    expect(activeReplacementIdentity({})).toBeUndefined();
    expect(activeReplacementIdentity({ replacementChild: ORIGINAL })).toEqual(ORIGINAL);
    expect(
      activeReplacementIdentity({ replacementChild: ORIGINAL, replacementGenerations: [adopt(GEN_A), adopt(GEN_B)] }),
    ).toEqual(GEN_B);
  });
});

describe("mergeRecoveryArtifacts replacementGenerations (LIM-80 3B2)", () => {
  it("appends a new generation onto an exact prefix (repeated crashes accumulate)", () => {
    const stored: RecoveryArtifacts = { replacementChild: ORIGINAL, replacementGenerations: [adopt(GEN_A)] };
    const merged = mergeRecoveryArtifacts(stored, {
      replacementGenerations: [adopt(GEN_A), respawn(GEN_B, id(9, "9"), "/j/b"), adopt(GEN_C)],
    });
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.artifacts.replacementGenerations).toHaveLength(3);
      expect(activeReplacementIdentity(merged.artifacts)).toEqual(GEN_C);
      // The immutable original identity is never rewritten.
      expect(merged.artifacts.replacementChild).toEqual(ORIGINAL);
    }
  });

  it("rejects a rewrite of an existing generation (not an exact prefix)", () => {
    const stored: RecoveryArtifacts = { replacementGenerations: [adopt(GEN_A)] };
    const merged = mergeRecoveryArtifacts(stored, { replacementGenerations: [adopt(GEN_B)] });
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.conflictKey).toBe("replacementGenerations");
  });

  it("rejects a shorter (truncating) list", () => {
    const stored: RecoveryArtifacts = { replacementGenerations: [adopt(GEN_A), adopt(GEN_B)] };
    const merged = mergeRecoveryArtifacts(stored, { replacementGenerations: [adopt(GEN_A)] });
    expect(merged.ok).toBe(false);
  });

  it("rejects a differing `via`/oldChild/journal on the same replacement identity", () => {
    const stored: RecoveryArtifacts = { replacementGenerations: [adopt(GEN_A)] };
    const merged = mergeRecoveryArtifacts(stored, {
      replacementGenerations: [respawn(GEN_A, id(9, "9"), "/j/a")],
    });
    expect(merged.ok).toBe(false);
  });
});

describe("parseRecoveryArtifacts replacementGenerations (LIM-80 3B2)", () => {
  it("round-trips rich generation records (adopt + respawn)", () => {
    const artifacts: RecoveryArtifacts = {
      replacementChild: ORIGINAL,
      replacementGenerations: [adopt(GEN_A), respawn(GEN_B, id(9, "9"), "/j/b")],
    };
    const parsed = parseRecoveryArtifacts(JSON.parse(JSON.stringify(artifacts)));
    expect(parsed).toEqual(artifacts);
  });

  it("rejects an invalid `via` and a malformed identity", () => {
    expect(parseRecoveryArtifacts({ replacementGenerations: [{ replacement: ORIGINAL, via: "steal" }] })).toBeNull();
    expect(parseRecoveryArtifacts({ replacementGenerations: [{ replacement: { pid: 1 }, via: "adopt" }] })).toBeNull();
  });
});
