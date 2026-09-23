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
// Also here (F6, long-horizon-context-dth): a closed chunk straddling the
// smooth band's oldest turn, whose older members used to vanish with no gap,
// and the gap-marker line every unrepresented turn inside coverage now gets.
//
// Selection is exercised through selectArrangement directly (pure over its
// inputs); the floor is exercised through the ladder resolver it lives in.
import { describe, expect, it } from "vitest";
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
import { estimateTokens, o200k } from "./fixtures/tokens.js";

// full 250 (t8 alone), smooth 10 (t7 alone), detailed 40 (c6 alone as an
// oversized loner), brief 700 for the remaining chunks c5…c1.
const PARAMS = {
  lowerBound: 1000,
  percentages: { full: 25, smooth: 1, detailed: 4, brief: 70 },
  tokenEstimator: o200k,
};
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

// Band subjects, gap-marker lines excluded (a marker names a hole, not a subject).
function briefSubjects(selection: { entries: Array<{ band: string; subjectId: string; gap: boolean }> }): string[] {
  return selection.entries.filter((entry) => entry.band === "brief" && !entry.gap).map((entry) => entry.subjectId);
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
    // The skipped chunk's turns are accounted for by the gap note and a
    // rendered gap marker line, not answered with unbudgeted detailed material.
    const t3 = selection.entries.filter((entry) => entry.subjectId === "t3");
    expect(t3.map((entry) => ({ band: entry.band, gap: entry.gap, text: entry.text }))).toEqual([
      { band: "brief", gap: true, text: "[turn t3 not in view; use get-turns]" },
    ]);
  });
});

describe("brief failure floor", () => {
  const failedBrief: DerivationSnapshot = { state: "failed", reason: "provider timeout" };
  const lookup = (_subjectId: string, derivationType: string): DerivationSnapshot | undefined =>
    derivationType === "chunk_summary_brief" ? failedBrief : undefined;
  const fallback = (bandBudget: number) =>
    resolveBriefRepresentation("c3", lookup, bandBudget, o200k, () => ({
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
    const rep = resolveBriefRepresentation("c3", ready, 100, o200k);
    expect(rep.body).toBe(OVERSIZED_BODY);
    expect(rep.degraded).toBe(false);
    expect(rep.derivationUsed).toBe("chunk_summary_brief");
  });
});

// ── F6: a chunk straddling the smooth band's oldest turn ──────────────
//
// full 250 (the newest turn's 300-token message alone), smooth 300 (three
// ~90-token renderings), detailed 200, brief 250. The newest turn is the
// verbatim tail, so the compact point sits at the second-newest turn's close.
const STRADDLE_PARAMS = {
  lowerBound: 1000,
  percentages: { full: 25, smooth: 30, detailed: 20, brief: 25 },
  tokenEstimator: o200k,
};

// A body of roughly `tokens` o200k tokens, distinct per subject.
function body(subjectId: string, tokens: number): string {
  return `${subjectId}${" alpha".repeat(tokens - 1)}`;
}

// `count` closed turns, one message each (the newest 300 tokens, the rest 10),
// every turn with a ~90-token rendering; chunks and turn compressions as given.
function straddleInputs(options: {
  count: number;
  chunks: ReadonlyArray<readonly string[]>;
  compressions: Record<string, number>;
}): SelectionInputs {
  const turns: SelectionTurn[] = Array.from({ length: options.count }, (_, index) => ({
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
    tokenEstimate: turn.turnOrder === options.count ? 300 : 10,
    turnId: turn.turnId,
    text: `prompt ${turn.turnId}`,
  }));
  const chunks: SelectionChunk[] = options.chunks.map((memberTurnIds, index) => ({
    chunkId: `c${index + 1}`,
    chunkOrder: index + 1,
    status: "closed",
    memberTurnIds: [...memberTurnIds],
  }));
  const derivations = new Map<string, DerivationSnapshot>();
  for (const turn of turns) {
    derivations.set(`${turn.turnId}/turn_rendering`, { state: "ready", content: body(`rendered-${turn.turnId}`, 90) });
  }
  for (const [turnId, tokens] of Object.entries(options.compressions)) {
    derivations.set(`${turnId}/detailed_turn_compression`, {
      state: "ready",
      content: body(`compressed-${turnId}`, tokens),
    });
  }
  for (const chunk of chunks) {
    derivations.set(`${chunk.chunkId}/chunk_summary_detailed`, {
      state: "ready",
      content: `detailed ${chunk.chunkId}`,
    });
    derivations.set(`${chunk.chunkId}/chunk_summary_brief`, { state: "ready", content: `brief ${chunk.chunkId}` });
  }
  return {
    messages,
    turns,
    chunks,
    derivations,
    maxEventOrder: options.count * 10,
    derivationCounts: {},
    skippedRecords: [],
  };
}

function layout(selection: { entries: Array<{ band: string; subjectId: string; derivationUsed: string }> }): string[] {
  return selection.entries.map((entry) => `${entry.band}:${entry.subjectId}:${entry.derivationUsed}`);
}

describe("F6: a closed chunk straddling the smooth band's oldest turn", () => {
  it("places its members older than smooth as per-turn entries in the unused detailed budget", () => {
    // c1 = t1…t6: t6 is the tail, t3…t5 fill smooth, so c1 is no chunk
    // candidate and t1–t2 are the members that used to vanish.
    const selection = selectArrangement(
      straddleInputs({
        count: 6,
        chunks: [["t1", "t2", "t3", "t4", "t5", "t6"]],
        compressions: { t1: 20, t2: 20 },
      }),
      STRADDLE_PARAMS,
    );

    expect(selection.compactPoint).toBe(50);
    expect(layout(selection)).toEqual([
      "detailed:t1:detailed_turn_compression",
      "detailed:t2:detailed_turn_compression",
      "smooth:t3:turn_rendering",
      "smooth:t4:turn_rendering",
      "smooth:t5:turn_rendering",
    ]);
    expect(selection.entries[0]?.text).toBe(body("compressed-t1", 20));
    // Detailed stays within its share.
    const detailedTokens = selection.entries
      .filter((entry) => entry.band === "detailed")
      .reduce((sum, entry) => sum + entry.tokens, 0);
    expect(detailedTokens).toBeLessThanOrEqual(200);
    // Coverage reaches what is actually covered: t1's oldest message.
    expect(selection.coveredFrom).toBe(1);
    expect(selection.skipped).toEqual([]);
    expect(selection.entries.filter((entry) => entry.gap)).toEqual([]);
  });

  it("stops in detailed and skips in brief; the turns left inside coverage get one gap marker per run", () => {
    // c1 = t1…t9: t9 is the tail, t6…t8 fill smooth, t1…t5 straddle. t5 fits
    // detailed, t4 stops it; brief takes t4, cannot fit t3 or t2, takes t1.
    const selection = selectArrangement(
      straddleInputs({
        count: 9,
        chunks: [["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]],
        compressions: { t1: 20, t2: 400, t3: 400, t4: 150, t5: 150 },
      }),
      STRADDLE_PARAMS,
    );

    expect(layout(selection)).toEqual([
      "brief:t1:detailed_turn_compression",
      "brief:t2–t3:gap",
      "brief:t4:detailed_turn_compression",
      "detailed:t5:detailed_turn_compression",
      "smooth:t6:turn_rendering",
      "smooth:t7:turn_rendering",
      "smooth:t8:turn_rendering",
    ]);
    expect(selection.coveredFrom).toBe(1);

    // The marker renders in the served band text…
    const marker = selection.entries.find((entry) => entry.gap);
    expect(marker?.text).toBe("[turns t2–t3 not in view; use get-turns]");
    expect(marker?.reason).toBe("turns t2–t3 not in view; use get-turns");
    // …and, as a gap entry beside the skip records, lands in gaps_json: the
    // view's gaps are gap entries plus skipped subjects (thread-view gapNotes).
    const gaps = [
      ...selection.entries
        .filter((entry) => entry.gap)
        .map((entry) => ({ band: entry.band, subjectId: entry.subjectId, reason: entry.reason })),
      ...selection.skipped.map((skip) => ({ band: skip.band, subjectId: skip.subjectId, reason: skip.reason })),
    ];
    expect(gaps.map((gap) => `${gap.band}:${gap.subjectId}`)).toEqual(["brief:t2–t3", "brief:t3", "brief:t2"]);
    expect(gaps[0]?.reason).toBe("turns t2–t3 not in view; use get-turns");
  });

  it("leaves a non-straddling layout exactly as it was", () => {
    // c1 = t1…t2 sits wholly behind smooth (t3…t5): an ordinary chunk
    // candidate, no straddle, no hole — the pre-F6 arrangement, byte for byte.
    const selection = selectArrangement(
      straddleInputs({ count: 6, chunks: [["t1", "t2"]], compressions: { t1: 20, t2: 20 } }),
      STRADDLE_PARAMS,
    );

    expect(selection.compactPoint).toBe(50);
    expect(selection.coveredFrom).toBe(1);
    expect(selection.skipped).toEqual([]);
    expect(
      selection.entries.map((entry) => ({
        band: entry.band,
        subjectKind: entry.subjectKind,
        subjectId: entry.subjectId,
        derivationUsed: entry.derivationUsed,
        degraded: entry.degraded,
        gap: entry.gap,
        startOrder: entry.startOrder,
        text: entry.text,
      })),
    ).toEqual([
      {
        band: "detailed",
        subjectKind: "chunk",
        subjectId: "c1",
        derivationUsed: "chunk_summary_detailed",
        degraded: false,
        gap: false,
        startOrder: 1,
        text: "<turns>t1 t2</turns>\ndetailed c1",
      },
      ...[3, 4, 5].map((n) => ({
        band: "smooth",
        subjectKind: "turn",
        subjectId: `t${n}`,
        derivationUsed: "turn_rendering",
        degraded: false,
        gap: false,
        startOrder: (n - 1) * 10 + 1,
        text: body(`rendered-t${n}`, 90),
      })),
    ]);
  });
});
