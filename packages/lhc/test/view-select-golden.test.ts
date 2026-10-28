import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DerivedThreadFixture,
  derivedThreadFixture,
  openRaw,
  type TempStore,
  tempStore,
} from "./fixtures/index.js";

interface Golden {
  case: string;
  fixture: "derived-thread";
  params: {
    lowerBound: number;
    percentages: { full: number; smooth: number; detailed: number; brief: number };
  };
  compactPoint: number;
  coveredFrom: number;
  arrangement: Array<{
    band: string;
    subjectKind: string;
    subjectId: string;
    derivationUsed: string;
    degraded: boolean;
  }>;
  gaps: Array<{ band: string; subjectId: string; reason: string }>;
}

function loadGolden(name: string): Golden {
  return JSON.parse(readFileSync(join(import.meta.dirname, "goldens", name), "utf8")) as Golden;
}

interface StoredView {
  compactPoint: number;
  coveredFrom: number;
  arrangement: Golden["arrangement"];
  gaps: Golden["gaps"];
}

function readStoredView(filePath: string): StoredView {
  const db = openRaw(filePath);
  try {
    const row = db
      .prepare(
        `SELECT compact_point, covered_from, arrangement_json, gaps_json
         FROM thread_view WHERE singleton = 1`,
      )
      .get() as
      | {
          compact_point: number | bigint;
          covered_from: number | bigint;
          arrangement_json: string;
          gaps_json: string;
        }
      | undefined;
    if (row === undefined) throw new Error("no view row after compact");
    return {
      compactPoint: Number(row.compact_point),
      coveredFrom: Number(row.covered_from),
      arrangement: JSON.parse(row.arrangement_json) as Golden["arrangement"],
      gaps: JSON.parse(row.gaps_json) as Golden["gaps"],
    };
  } finally {
    db.close();
  }
}

let store: TempStore;
let fixture: DerivedThreadFixture;

beforeAll(async () => {
  store = tempStore();
  fixture = await derivedThreadFixture(store);
});
afterAll(() => {
  store.cleanup();
});

async function runGolden(golden: Golden): Promise<StoredView> {
  const receipt = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: golden.params });
  expect(receipt.ok).toBe(true);
  if (!receipt.ok) throw new Error(receipt.error.reason);
  const stored = readStoredView(fixture.filePath);
  if (process.env["GOLDEN_DUMP"] === "1") {
    console.log(`${golden.case}\n${JSON.stringify(stored, null, 2)}`);
  }
  expect(receipt.value.compactPoint).toBe(stored.compactPoint);
  expect(receipt.value.coveredFrom).toBe(stored.coveredFrom);
  return stored;
}

function expectMatches(stored: StoredView, golden: Golden): void {
  expect(stored.compactPoint).toBe(golden.compactPoint);
  expect(stored.coveredFrom).toBe(golden.coveredFrom);
  expect(stored.arrangement).toEqual(golden.arrangement);
  expect(stored.gaps).toEqual(golden.gaps);
}

describe("selection goldens G1–G4 (committed JSON, exact arrangements)", () => {
  it("G1 proportions: shares fill the full gradient as committed", async () => {
    const golden = loadGolden("g1-proportions.json");
    expectMatches(await runGolden(golden), golden);
  });

  it("G2a budget edge: a turn exactly filling the smooth remainder is included (≤ rule)", async () => {
    const golden = loadGolden("g2-edge-inclusion.json");
    expectMatches(await runGolden(golden), golden);
  });

  it("G2b budget edge: one token under the exact fill excludes the turn and stops the band", async () => {
    const golden = loadGolden("g2-edge-exclusion.json");
    expectMatches(await runGolden(golden), golden);
  });

  it("G3 oversized loner: a single turn larger than the whole smooth budget represents alone", async () => {
    const golden = loadGolden("g3-oversized-loner.json");
    const stored = await runGolden(golden);
    expectMatches(stored, golden);
    expect(
      stored.arrangement.filter((entry) => entry.band === "smooth" && entry.derivationUsed !== "gap"),
    ).toHaveLength(1);
  });
});
