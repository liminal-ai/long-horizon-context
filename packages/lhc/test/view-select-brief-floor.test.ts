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

const PARAMS = {
  lowerBound: 1000,
  percentages: { full: 25, smooth: 1, detailed: 4, brief: 70 },
  tokenEstimator: o200k,
};
const BRIEF_BUDGET = 700;
const CHUNK_IDS = ["c1", "c2", "c3", "c4", "c5", "c6"] as const;

const OVERSIZED_BODY = "chunk detail line ".repeat(750);

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

    expect(briefSubjects(selection)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(selection.skipped).toEqual([]);
    expect(selection.coveredFrom).toBe(1);

    const bad = selection.entries.find((entry) => entry.subjectId === "c3");
    expect(bad?.degraded).toBe(true);
    expect(bad?.derivationUsed).toBe("stored_member_concat");
    expect(bad?.text).toMatch(/\[compression failed: ~\d+ tokens of content truncated\]$/);
    expect(estimateTokens(OVERSIZED_BODY)).toBeGreaterThan(3 * BRIEF_BUDGET);
    expect(bad?.tokens).toBeLessThan(briefFallbackCapTokens(BRIEF_BUDGET) + 20);
  });
});

describe("brief band: an entry too large for the remaining budget", () => {
  it("is skipped with a gap note while older entries continue to be selected", () => {
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
    expect(briefFallbackCapTokens(4000)).toBe(200);
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

const STRADDLE_PARAMS = {
  lowerBound: 1000,
  percentages: { full: 25, smooth: 30, detailed: 20, brief: 25 },
  tokenEstimator: o200k,
};

function body(subjectId: string, tokens: number): string {
  return `${subjectId}${" alpha".repeat(tokens - 1)}`;
}

function straddleInputs(options: {
  count: number;
  chunks: ReadonlyArray<readonly string[]>;
  compressions: Record<string, number>;
  newestChunkStatus?: "open" | "closed";
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
    status: index === options.chunks.length - 1 ? (options.newestChunkStatus ?? "closed") : "closed",
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
    const detailedTokens = selection.entries
      .filter((entry) => entry.band === "detailed")
      .reduce((sum, entry) => sum + entry.tokens, 0);
    expect(detailedTokens).toBeLessThanOrEqual(200);
    expect(selection.coveredFrom).toBe(1);
    expect(selection.skipped).toEqual([]);
    expect(selection.entries.filter((entry) => entry.gap)).toEqual([]);
  });

  it("stops in detailed and skips in brief; the turns left inside coverage get one gap marker per run", () => {
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

    const marker = selection.entries.find((entry) => entry.gap);
    expect(marker?.text).toBe("[turns t2–t3 not in view; use get-turns]");
    expect(marker?.reason).toBe("turns t2–t3 not in view; use get-turns");
    const gaps = [
      ...selection.entries
        .filter((entry) => entry.gap)
        .map((entry) => ({ band: entry.band, subjectId: entry.subjectId, reason: entry.reason })),
      ...selection.skipped.map((skip) => ({ band: skip.band, subjectId: skip.subjectId, reason: skip.reason })),
    ];
    expect(gaps.map((gap) => `${gap.band}:${gap.subjectId}`)).toEqual(["brief:t2–t3", "brief:t3", "brief:t2"]);
    expect(gaps[0]?.reason).toBe("turns t2–t3 not in view; use get-turns");
  });

  it("a first chunk still open: its turns older than smooth take the elder bands from ready turn compressions", () => {
    const selection = selectArrangement(
      straddleInputs({
        count: 6,
        chunks: [["t1", "t2", "t3", "t4", "t5", "t6"]],
        compressions: { t1: 20, t2: 20 },
        newestChunkStatus: "open",
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
    expect(selection.coveredFrom).toBe(1);
    expect(selection.entries.filter((entry) => entry.gap)).toEqual([]);
  });

  it("leading turns with no material get one run marker, and covered_from stays at represented material", () => {
    const selection = selectArrangement(
      straddleInputs({
        count: 6,
        chunks: [["t1", "t2", "t3", "t4", "t5", "t6"]],
        compressions: {},
        newestChunkStatus: "open",
      }),
      { ...STRADDLE_PARAMS, percentages: { full: 25, smooth: 30, detailed: 0, brief: 0 } },
    );

    expect(layout(selection)).toEqual([
      "detailed:t1–t2:gap",
      "smooth:t3:turn_rendering",
      "smooth:t4:turn_rendering",
      "smooth:t5:turn_rendering",
    ]);
    expect(selection.entries[0]?.text).toBe("[turns t1–t2 not in view; use get-turns]");
    expect(selection.coveredFrom).toBe(21);
  });

  it.each([30, 1000])("long open chunk with only the oldest summary ready stays budgeted (%i turns)", (count) => {
    const selection = selectArrangement(
      straddleInputs({
        count,
        chunks: [Array.from({ length: count }, (_, i) => `t${i + 1}`)],
        compressions: { t1: 20 },
        newestChunkStatus: "open",
      }),
      STRADDLE_PARAMS,
    );
    const total = selection.entries.reduce((sum, entry) => sum + entry.tokens, 0);
    expect(total).toBeLessThan(1000);
    const n = count - 1;
    expect(layout(selection)).toEqual([
      "detailed:t1:detailed_turn_compression",
      `detailed:t2–t${n - 3}:gap`,
      `smooth:t${n - 2}:turn_rendering`,
      `smooth:t${n - 1}:turn_rendering`,
      `smooth:t${n}:turn_rendering`,
    ]);
    expect(selection.entries[1]?.text).toBe(`[turns t2–t${n - 3} not in view; use get-turns]`);
    expect(selection.coveredFrom).toBe(1);
  });

  it("mixed ready and missing elder turns: one marker per missing run, entries for ready turns, all budgeted", () => {
    const selection = selectArrangement(
      straddleInputs({
        count: 12,
        chunks: [Array.from({ length: 12 }, (_, i) => `t${i + 1}`)],
        compressions: { t1: 20, t4: 20, t8: 20 },
        newestChunkStatus: "open",
      }),
      STRADDLE_PARAMS,
    );
    expect(layout(selection)).toEqual([
      "detailed:t1:detailed_turn_compression",
      "detailed:t2–t3:gap",
      "detailed:t4:detailed_turn_compression",
      "detailed:t5–t7:gap",
      "detailed:t8:detailed_turn_compression",
      "smooth:t9:turn_rendering",
      "smooth:t10:turn_rendering",
      "smooth:t11:turn_rendering",
    ]);
    const detailedTokens = selection.entries
      .filter((entry) => entry.band === "detailed")
      .reduce((sum, entry) => sum + entry.tokens, 0);
    expect(detailedTokens).toBeLessThanOrEqual(200);
    expect(selection.coveredFrom).toBe(1);
  });

  it("an elder backlog larger than the shares leaves one leading marker, never a line per turn", () => {
    const count = 305;
    const compressions = Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`t${i + 1}`, 40]));
    const selection = selectArrangement(
      straddleInputs({
        count,
        chunks: [Array.from({ length: count }, (_, i) => `t${i + 1}`)],
        compressions,
        newestChunkStatus: "open",
      }),
      STRADDLE_PARAMS,
    );
    const gaps = selection.entries.filter((entry) => entry.gap);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.text).toMatch(/^\[turns t1–t\d+ not in view; use get-turns\]$/);
    expect(selection.entries.length).toBeLessThan(20);
    const total = selection.entries.reduce((sum, entry) => sum + entry.tokens, 0);
    expect(total).toBeLessThan(1000);
  });

  it("leaves a non-straddling layout exactly as it was", () => {
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
