// Epic 03 Story 2: selection goldens G1–G4 (architecture-risk). Exact
// arrangements against committed JSON (test/goldens/) — the only guard that
// catches tie-breaker drift (≤ vs <, newest-first ordering, newest-member
// chunk coverage) that replay-on-the-same-engine cannot. Each case runs a
// REAL compact through the SDK surface and compares the stored arrangement,
// compact point, covered_from, and gaps verbatim against the golden.
// Story 4 (sanctioned amendment): the Boundary G1 trajectory golden joins at
// the bottom — committed positions after each scripted intake batch, floor
// legs included, plus TC-4.5's replay-equality leg.
//
// Goldens are immutable once committed: an implementation that disagrees
// with one is wrong until the design rule is shown wrong (deviation process,
// never a golden edit). Regeneration instructions: test/goldens/README.md
// (GOLDEN_DUMP=1 prints actuals).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type MessageEventInput } from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  type DerivedThreadFixture,
  derivedThreadFixture,
  openRaw,
  stragglerVariantThread,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

interface Golden {
  case: string;
  fixture: "derived-thread" | "straggler-variant";
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

function messageText(message: { content: readonly { text: string }[] }): string {
  return message.content.map((part) => part.text).join("");
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
let straggler: DerivedThreadFixture;

beforeAll(async () => {
  store = tempStore();
  fixture = await derivedThreadFixture(store);
  straggler = await stragglerVariantThread(store);
});
afterAll(() => {
  store.cleanup();
});

async function runGolden(golden: Golden): Promise<StoredView> {
  const target = golden.fixture === "straggler-variant" ? straggler : fixture;
  const receipt = await target.sdk.threadView.compact({ filePath: target.filePath }, { params: golden.params });
  expect(receipt.ok).toBe(true);
  if (!receipt.ok) throw new Error(receipt.error.reason);
  const stored = readStoredView(target.filePath);
  if (process.env["GOLDEN_DUMP"] === "1") {
    console.log(`${golden.case}\n${JSON.stringify(stored, null, 2)}`);
  }
  // Receipt and stored row agree (one selection, two reports).
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
    // The loner condition itself: exactly one smooth entry, and the smooth
    // budget (250 × 4% = 10) is smaller than any turn entry could render.
    expect(stored.arrangement.filter((entry) => entry.band === "smooth")).toHaveLength(1);
  });

  it("G4 turnless straggler: the note rides the following turn's band entry; the trailing note is tail", async () => {
    const golden = loadGolden("g4-turnless-straggler.json");
    const stored = await runGolden(golden);
    expectMatches(stored, golden);

    // The trailing note still appears in the tail.
    const contextRead = await (straggler.sdk as Lhc).threadView.getLlmRequestContext({
      filePath: straggler.filePath,
    });
    expect(contextRead.ok).toBe(true);
    if (!contextRead.ok) return;
    const tail = contextRead.value.messages.filter((message) => !messageText(message).startsWith("[context ·"));
    expect(
      tail.some(
        (message) =>
          messageText(message) === "[runtime note] session closing note after the last turn (fixture straggler)",
      ),
    ).toBe(true);
    // The note appears once: banded with c2, not duplicated into the tail.
    expect(tail.some((message) => messageText(message).includes("harness restarted between turns"))).toBe(false);
  });
});

// ── Boundary G1 (Epic 03 Story 4, re-cut by Epic 05 Story 6 for the
// turn-end trigger and whole-turn eviction): the trajectory golden ─────
//
// Committed expected positions after each scripted batch — target/peek-ahead
// arithmetic off-by-ones survive property tests, not goldens. The expected
// values were hand-derived from the design rules (Epic 05 tech design
// §Flow 5) before implementation: contents are n joined "tok" words (exactly
// n o200k tokens each), so every sum in the golden is checkable by hand.
// Every advance fires through a real intake commit; positions and zone sums
// read back through real model-context/status calls (no test-only advance surface).

interface BoundaryGolden {
  case: string;
  budgets: { maxTokens: number; targetTokens: number };
  batches: Array<{
    label: string;
    resultTokens: number[];
    turnEnd: boolean;
    expectedPosition: number;
    expectedZoneTokens: number;
  }>;
}

function trajectoryTokens(n: number): string {
  return Array<string>(n).fill("tok").join(" ");
}

let trajectoryCallCounter = 0;

function trajectoryBatch(batch: BoundaryGolden["batches"][number]): MessageEventInput[] {
  const events: MessageEventInput[] = [validEvent("user_prompt", { payload: { text: "trajectory prompt" } })];
  for (const n of batch.resultTokens) {
    trajectoryCallCounter += 1;
    const toolCallId = `call-g1b-${trajectoryCallCounter}`;
    events.push(
      validEvent("tool_call", {
        payload: { toolCallId, toolName: "read_file", arguments: { path: `g1b-${trajectoryCallCounter}.txt` } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId, content: trajectoryTokens(n), isError: false },
      }),
    );
  }
  if (batch.turnEnd) events.push(validEvent("turn_end"));
  return events;
}

// One full replay of the golden's script against a fresh thread: the
// committed positions and zone sums after each batch.
async function replayTrajectory(golden: BoundaryGolden): Promise<Array<{ position: number; zoneTokens: number }>> {
  const sdk = initLhc({
    inferenceCallbacks: createInferenceCallbacksDouble(),
    mode: "manual",
    view: { visibility: golden.budgets },
  });
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`trajectory thread creation failed: ${created.error.reason}`);

  const observed: Array<{ position: number; zoneTokens: number }> = [];
  for (const batch of golden.batches) {
    const result = await sdk.intakeStream.messageEvents({ filePath }, trajectoryBatch(batch));
    if (!result.ok) throw new Error(`trajectory intake failed: ${result.error.reason}`);
    const contextRead = await sdk.threadView.getLlmRequestContext({ filePath });
    const status = await sdk.threadView.status({ filePath });
    if (!contextRead.ok || !status.ok) throw new Error("trajectory read-back failed");
    const db = openRaw(filePath);
    const position = Number(
      (db.prepare(`SELECT position FROM view_boundary`).get() as { position: number | bigint }).position,
    );
    db.close();
    observed.push({
      position,
      zoneTokens: status.value.visibility.zoneTokens,
    });
  }
  return observed;
}

describe("Boundary G1 (committed JSON): the advance trajectory under the turn-end trigger", () => {
  it("matches the committed positions and zone sums after every scripted batch", async () => {
    const golden = JSON.parse(
      readFileSync(join(import.meta.dirname, "goldens", "boundary-g1-trajectory.json"), "utf8"),
    ) as BoundaryGolden;
    const observed = await replayTrajectory(golden);
    if (process.env["GOLDEN_DUMP"] === "1") {
      console.log(`${golden.case}\n${JSON.stringify(observed, null, 2)}`);
    }
    expect(observed).toEqual(
      golden.batches.map((batch) => ({
        position: batch.expectedPosition,
        zoneTokens: batch.expectedZoneTokens,
      })),
    );

    // TC-4.5 (AC-4.4) replay equality: the same record and budgets on a
    // second fresh thread produce the same boundary trajectory.
    expect(await replayTrajectory(golden)).toEqual(observed);
  });
});
