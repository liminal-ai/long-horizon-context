// The brief band's two failure defenses, from the production incident where a
// chunk whose brief derivation never landed rendered its whole uncompressed
// fallback, and the brief walk stopped there — silently dropping every older
// chunk although each had a healthy, small brief.
//
//   - the walk: brief is the last band, so an entry that does not fit is
//     skipped (recorded as a gap) and the walk continues to older candidates.
//   - the floor: a brief that fell back to larger material is capped at 5% of
//     the brief band budget (never below 200 tokens) with a terminal marker,
//     so the failure costs the band a brief-sized entry, not a body-sized one.
//
// Selection is exercised through selectArrangement directly (pure over its
// inputs); the floor is exercised through the ladder resolver it lives in.
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/shared-tech/token-counting/index.js";
import {
  briefFallbackCapTokens,
  type CompactChunkMaterialSnapshot,
  type DerivationSnapshot,
  resolveBriefRepresentation,
} from "../src/thread-view/internal/render.js";
import {
  type SelectionChunk,
  type SelectionInputs,
  type SelectionMessage,
  type SelectionTurn,
  selectArrangement,
} from "../src/thread-view/internal/select.js";

// full 250 (t8 alone), smooth 10 (t7 alone), detailed 40 (c6 alone as an
// oversized loner), brief 700 for the remaining chunks c5…c1.
const PARAMS = { lowerBound: 1000, percentages: { full: 25, smooth: 1, detailed: 4, brief: 70 } };
const BRIEF_BUDGET = 700;
const CHUNK_IDS = ["c1", "c2", "c3", "c4", "c5", "c6"] as const;

// ~2251 tokens: more than three times the whole brief band budget, the shape
// of an uncompressed fallback standing in for a failed brief.
const OVERSIZED_BODY = "chunk detail line ".repeat(750);

// Eight closed turns, one message each; t1…t6 are single-turn chunks, t7 is
// the smooth band's one entry, t8's 500 tokens put the compact point at t7's
// close.
function incidentInputs(options: {
  briefOverride?: DerivationSnapshot;
  briefMaterial?: CompactChunkMaterialSnapshot;
}): SelectionInputs {
  const turns: SelectionTurn[] = Array.from({ length: 8 }, (_, index) => ({
    turnId: `t${index + 1}`,
    turnOrder: index + 1,
    status: "closed",
    openedAt: index * 10 + 1,
    closedAt: (index + 1) * 10,
  }));
  const messages: SelectionMessage[] = turns.map((turn) => ({
    messageId: `m${turn.turnOrder}`,
    order: turn.openedAt,
    kind: "user_prompt",
    tokenEstimate: turn.turnId === "t8" ? 500 : 10,
    turnId: turn.turnId,
    text: `prompt ${turn.turnId}`,
  }));
  const chunks: SelectionChunk[] = CHUNK_IDS.map((chunkId, index) => ({
    chunkId,
    chunkOrder: index + 1,
    status: "closed",
    memberTurnIds: [`t${index + 1}`],
  }));

  const derivations = new Map<string, DerivationSnapshot>([
    ["t7/turn_rendering", { state: "ready", content: "rendered turn t7" }],
  ]);
  for (const chunkId of CHUNK_IDS) {
    // Detailed material is deliberately larger than the detailed share, so c6
    // takes that band alone and c5…c1 arrive at brief.
    derivations.set(`${chunkId}/chunk_summary_detailed`, {
      state: "ready",
      content: `detailed summary line ${chunkId} `.repeat(15),
    });
    derivations.set(`${chunkId}/chunk_summary_brief`, {
      state: "ready",
      content: `brief summary for chunk ${chunkId}`,
    });
  }
  if (options.briefOverride !== undefined) derivations.set("c3/chunk_summary_brief", options.briefOverride);

  const compactChunkMaterials = new Map<string, CompactChunkMaterialSnapshot>();
  if (options.briefMaterial !== undefined) {
    compactChunkMaterials.set("c3/chunk_summary_brief", options.briefMaterial);
  }

  return {
    messages,
    turns,
    chunks,
    derivations,
    compactChunkMaterials,
    maxEventOrder: 80,
    derivationCounts: {},
    skippedRecords: [],
  };
}

function briefSubjects(selection: { entries: Array<{ band: string; subjectId: string }> }): string[] {
  return selection.entries.filter((entry) => entry.band === "brief").map((entry) => entry.subjectId);
}

describe("brief band: a chunk whose brief derivation failed", () => {
  it("is capped to the failure floor and every older healthy chunk still lands in the band", () => {
    const selection = selectArrangement(
      incidentInputs({
        briefOverride: { state: "failed", reason: "provider timeout" },
        briefMaterial: { kind: "concat", content: OVERSIZED_BODY, reason: "failed_floor" },
      }),
      PARAMS,
    );

    // The incident's regression: c2 and c1 sit behind the bad chunk.
    expect(briefSubjects(selection)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(selection.skipped).toEqual([]);
    expect(selection.coveredFrom).toBe(1); // t1's oldest message

    const bad = selection.entries.find((entry) => entry.subjectId === "c3");
    expect(bad?.degraded).toBe(true);
    expect(bad?.derivationUsed).toBe("stored_member_concat");
    expect(bad?.text).toMatch(/\[compression failed: ~\d+ tokens of content truncated\]$/);
    // Reported post-truncation: the cap plus the ladder's own [degraded: …]
    // line, not the multi-thousand-token body.
    expect(estimateTokens(OVERSIZED_BODY)).toBeGreaterThan(3 * BRIEF_BUDGET);
    expect(bad?.tokens).toBeLessThan(briefFallbackCapTokens(BRIEF_BUDGET) + 20);
  });
});

describe("brief band: an entry too large for the remaining budget", () => {
  it("is skipped with a gap note while older entries continue to be selected", () => {
    // A ready brief is never capped, so this reaches the walk oversized —
    // the walk fix on its own, with the failure floor out of the picture.
    const selection = selectArrangement(
      incidentInputs({ briefOverride: { state: "ready", content: OVERSIZED_BODY } }),
      PARAMS,
    );

    expect(briefSubjects(selection)).toEqual(["c1", "c2", "c4", "c5"]);
    expect(selection.coveredFrom).toBe(1);
    expect(selection.skipped).toHaveLength(1);
    const skip = selection.skipped[0];
    expect(skip?.band).toBe("brief");
    expect(skip?.subjectId).toBe("c3");
    expect(skip?.tokens).toBeGreaterThan(BRIEF_BUDGET);
    expect(skip?.reason).toContain(String(skip?.tokens));
    // The skipped chunk's turns are accounted for by the gap note, not
    // answered with unbudgeted detailed material.
    expect(selection.entries.filter((entry) => entry.subjectId === "t3")).toEqual([]);
  });
});

describe("brief failure floor", () => {
  const failedBrief: DerivationSnapshot = { state: "failed", reason: "provider timeout" };
  const lookup = (_subjectId: string, derivationType: string): DerivationSnapshot | undefined =>
    derivationType === "chunk_summary_brief" ? failedBrief : undefined;
  const fallback = (bandBudget: number) =>
    resolveBriefRepresentation("c3", lookup, bandBudget, () => ({
      kind: "concat",
      content: OVERSIZED_BODY,
      reason: "failed_floor",
    }));

  it("caps at 5% of the brief band budget above the floor", () => {
    expect(briefFallbackCapTokens(8000)).toBe(400);
    expect(estimateTokens(fallback(8000).body)).toBeLessThanOrEqual(400);
    expect(estimateTokens(fallback(8000).body)).toBeGreaterThan(300);
  });

  it("caps at 200 tokens where 5% would fall below it", () => {
    expect(briefFallbackCapTokens(4000)).toBe(200); // the crossover
    expect(briefFallbackCapTokens(1000)).toBe(200);
    expect(estimateTokens(fallback(1000).body)).toBeLessThanOrEqual(200);
    expect(estimateTokens(fallback(1000).body)).toBeGreaterThan(150);
  });

  it("marks the truncation with the tokens it dropped, and degrades the representation", () => {
    const rep = fallback(BRIEF_BUDGET);
    const marker = rep.body.match(/\[compression failed: ~(\d+) tokens of content truncated\]$/);
    expect(marker).not.toBeNull();
    expect(Number(marker?.[1])).toBeGreaterThan(estimateTokens(OVERSIZED_BODY) - 250);
    expect(rep.degraded).toBe(true);
    expect(rep.degradedMarker).toBe("brief-from-stored-members");
  });

  it("never truncates a ready brief, however large", () => {
    const ready = (_subjectId: string, derivationType: string): DerivationSnapshot | undefined =>
      derivationType === "chunk_summary_brief" ? { state: "ready", content: OVERSIZED_BODY } : undefined;
    const rep = resolveBriefRepresentation("c3", ready, 100);
    expect(rep.body).toBe(OVERSIZED_BODY);
    expect(rep.degraded).toBe(false);
    expect(rep.derivationUsed).toBe("chunk_summary_brief");
  });
});
