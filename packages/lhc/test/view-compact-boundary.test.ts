// LIM-115 exact-boundary proofs. Three comparisons in the selector are `>=`
// or `<=` and decide the arrangement at the point where the two sides are
// equal. The differential suite cannot see any of them: two of the three sit
// on inputs no realistic fixture lands on exactly, and the third is in the
// walk both plans share, so both plans move together when it moves.
//
// Each test below stands the record exactly on one of those lines and pins
// the documented answer, so flipping the comparison fails a named test:
//
//   A. crossingMessage's `sum >= budget` — the accumulated newest-first token
//      sum equals the full budget exactly at the crossing message.
//   B. the straddling closed turn's `fullSideTokens >= smoothSideTokens` — the
//      turn's tokens split exactly in half across the budget line (ties stay
//      in full), and one token either side of it.
//   C. fillBand's `sum + entry.tokens <= bandBudget` — an entry whose rendered
//      token estimate exactly fills what the band has left.
//
// A and B run through the real bounded compact-point query and through the
// legacy eager reads, and again through the public preview under both values
// of LHC_COMPACT_ALGORITHM, so the boundary is pinned in both product states.
// C is a pure fixture over the shared walk: fillBand has one implementation,
// so pinning it once pins it for both.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type MessageEventInput, threads } from "../src/index.js";
import type { DbReadTransaction } from "../src/shared-tech/index.js";
import { estimateTokens } from "../src/shared-tech/token-counting/index.js";
import { createBoundedSelection } from "../src/thread-view/internal/bounded-source.js";
import {
  readSelectionInputs,
  type SelectionConfig,
  type SelectionInputs,
  type SelectionMessage,
  type SelectionTurn,
  selectArrangement,
} from "../src/thread-view/internal/select.js";
import { walkArrangement } from "../src/thread-view/internal/walk.js";
import { createInferenceCallbacksDouble, openRaw, type TempStore, tempStore, validEvent } from "./fixtures/index.js";

let store: TempStore;
const AMBIENT_ALGORITHM = process.env["LHC_COMPACT_ALGORITHM"];

beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
  if (AMBIENT_ALGORITHM === undefined) delete process.env["LHC_COMPACT_ALGORITHM"];
  else process.env["LHC_COMPACT_ALGORITHM"] = AMBIENT_ALGORITHM;
});

// full 100 of a 1000 lower bound: the budget the fixtures land on exactly.
const FULL_BUDGET = 100;
const PARAMS = { lowerBound: 1000, percentages: { full: 10, smooth: 30, detailed: 30, brief: 30 } };
const CONFIG: SelectionConfig = { lowerBound: PARAMS.lowerBound, percentages: PARAMS.percentages };

function sdkFor(): Lhc {
  return initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
}

async function newThread(): Promise<string> {
  const created = await threads.newThread({ filePath: store.threadPath(), registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  return created.value.filePath;
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(result.error.reason);
}

function withDb<T>(filePath: string, run: (db: DatabaseSync) => T): T {
  const db = openRaw(filePath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function execSql(filePath: string, sql: string, ...params: SQLInputValue[]): void {
  withDb(filePath, (db) => db.prepare(sql).run(...params));
}

/**
 * Five closed turns of two messages each, with every message's token estimate
 * set to an exact value. Intake decides token estimates from content, so the
 * only way to stand a record exactly on the budget line is to state the
 * estimates directly.
 */
async function threadWithExactTokens(tokensByTurn: readonly (readonly [number, number])[]): Promise<string> {
  const sdk = sdkFor();
  const filePath = await newThread();
  for (let turn = 1; turn <= tokensByTurn.length; turn += 1) {
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: `turn ${turn} prompt` } }),
      validEvent("assistant_text", { payload: { text: `turn ${turn} answer` } }),
      validEvent("turn_end"),
    ]);
  }
  const rows = withDb(
    filePath,
    (db) =>
      db.prepare(`SELECT message_id, turn_id FROM message ORDER BY source_event_order`).all() as unknown as Array<{
        message_id: string;
        turn_id: string;
      }>,
  );
  for (let turn = 1; turn <= tokensByTurn.length; turn += 1) {
    const turnRows = rows.filter((row) => row.turn_id === `t${turn}`);
    const tokens = tokensByTurn[turn - 1] as readonly [number, number];
    if (turnRows.length !== 2) throw new Error(`fixture invariant: t${turn} carries ${turnRows.length} messages`);
    turnRows.forEach((row, index) => {
      execSql(
        filePath,
        `UPDATE message SET token_estimate = ? WHERE message_id = ?`,
        tokens[index] ?? 0,
        row.message_id,
      );
    });
  }
  return filePath;
}

function closedAtOf(filePath: string, turnId: string): number {
  return withDb(filePath, (db) => {
    const row = db.prepare(`SELECT closed_at_event_order AS o FROM turns WHERE turn_id = ?`).get(turnId) as
      | { o: number | bigint }
      | undefined;
    if (row === undefined) throw new Error(`fixture invariant: no turn ${turnId}`);
    return Number(row.o);
  });
}

/** The bounded plan's compact point, through its real metadata queries. */
function boundedCompactPoint(filePath: string): number {
  return withDb(filePath, (db) => {
    const transaction: DbReadTransaction = { db, filePath, threadId: "boundary" };
    const plan = createBoundedSelection(db, transaction, { includeChunkMaterials: true, signal: undefined });
    // The real bounded source, so the compact-point keyset query is the thing
    // under test — not a stand-in SelectionSource.
    return walkArrangement(plan.source, CONFIG).compactPoint;
  });
}

/** The legacy plan's compact point, through its eager reads. */
function legacyCompactPoint(filePath: string): number {
  return withDb(filePath, (db) => selectArrangement(readSelectionInputs(db), CONFIG).compactPoint);
}

async function previewCompactPoint(algorithm: "bounded" | "legacy", filePath: string): Promise<number> {
  if (algorithm === "legacy") process.env["LHC_COMPACT_ALGORITHM"] = "legacy";
  else delete process.env["LHC_COMPACT_ALGORITHM"];
  const preview = await sdkFor().threadView.previewCompact({ filePath }, { params: PARAMS });
  if (!preview.ok) throw new Error(preview.error.reason);
  if (preview.value.kind !== "ok") throw new Error(preview.value.reason);
  return preview.value.preview.compactPoint;
}

/** Every route to the compact point agrees, and agrees with the documented value. */
async function expectCompactPoint(filePath: string, expected: number): Promise<void> {
  expect(boundedCompactPoint(filePath)).toBe(expected);
  expect(legacyCompactPoint(filePath)).toBe(expected);
  expect(await previewCompactPoint("bounded", filePath)).toBe(expected);
  expect(await previewCompactPoint("legacy", filePath)).toBe(expected);
}

describe("LIM-115 boundary A: the crossing message that lands exactly on the full budget", () => {
  it("takes the message whose running sum equals the budget, not the one after it", async () => {
    // Newest-first: 20+20 (t5) + 20+20 (t4) = 80, then t3's newer message at
    // 20 makes exactly 100. t3's older message is larger, so the straddle
    // rounds the turn into smooth — and taking the older message instead
    // would cover t3 whole and put the point a turn earlier.
    const filePath = await threadWithExactTokens([
      [10, 10],
      [10, 10],
      [30, 20],
      [20, 20],
      [20, 20],
    ]);
    expect(closedAtOf(filePath, "t2")).toBe(6);
    expect(closedAtOf(filePath, "t3")).toBe(9);

    // The sum reaches the budget exactly, never overshoots it.
    const tokensNewerThanT3Close = withDb(filePath, (db) =>
      Number(
        (
          db
            .prepare(
              `SELECT COALESCE(SUM(token_estimate), 0) AS total FROM message
               WHERE deleted_at IS NULL AND source_event_order > ?`,
            )
            .get(9) as { total: number | bigint }
        ).total,
      ),
    );
    expect(tokensNewerThanT3Close + 20).toBe(FULL_BUDGET);

    // `>=` stops at that message: t3 straddles and rounds to smooth.
    // `>` would walk one message older, cover t3 whole, and answer 6.
    await expectCompactPoint(filePath, 9);
  });
});

describe("LIM-115 boundary B: the closed turn that straddles the budget line at an exact tie", () => {
  it("keeps a turn split exactly in half in full", async () => {
    // t3 holds 40 tokens; 20 of them sit on the full side of the line.
    // fullSideTokens === smoothSideTokens, and the documented rule is that
    // ties stay in full — so the tail begins at t2's close, not t3's.
    const filePath = await threadWithExactTokens([
      [10, 10],
      [10, 10],
      [15, 25],
      [20, 20],
      [20, 20],
    ]);
    expect(closedAtOf(filePath, "t2")).toBe(6);
    expect(closedAtOf(filePath, "t3")).toBe(9);
    // The tie, stated: 80 tokens newer than t3's close, 100 of budget, 40 in
    // the turn. One token more on the newer side and the turn goes to smooth.
    await expectCompactPoint(filePath, 6);
  });

  it("sends a turn one token short of the tie to smooth", async () => {
    // The same shape with t3 at 41 tokens: 20 on the full side, 21 on the
    // smooth side. One token fewer on the newer side and the turn stays full.
    const filePath = await threadWithExactTokens([
      [10, 10],
      [10, 10],
      [16, 25],
      [20, 20],
      [20, 20],
    ]);
    expect(closedAtOf(filePath, "t3")).toBe(9);
    await expectCompactPoint(filePath, 9);
  });
});

describe("LIM-115 boundary C: the entry that exactly fills its band budget", () => {
  it("includes an entry whose rendered tokens exactly consume what the band has left", () => {
    // A ready turn_rendering renders as its body verbatim, so an entry's cost
    // is the estimate of that body — known before the walk runs.
    const olderBody = "older banded turn rendering body with enough words to price above zero";
    const newerBody = "newer banded turn rendering body";
    const olderTokens = estimateTokens(olderBody);
    const newerTokens = estimateTokens(newerBody);
    const smoothBudget = olderTokens + newerTokens;

    // Percentages of a lower bound chosen so the smooth share is exactly the
    // two entries together: (4S × 25) / 100 === S.
    const config: SelectionConfig = {
      lowerBound: 4 * smoothBudget,
      percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
    };
    expect((config.lowerBound * config.percentages.smooth) / 100).toBe(smoothBudget);

    const turns: SelectionTurn[] = [
      { turnId: "t1", turnOrder: 1, status: "closed", openedAt: 1, closedAt: 2 },
      { turnId: "t2", turnOrder: 2, status: "closed", openedAt: 3, closedAt: 4 },
      // An open turn holding more tokens than any budget: the compact point is
      // pinned at t2's close whatever the shares are, so the two banded turns
      // are the same two entries every time.
      { turnId: "t3", turnOrder: 3, status: "open", openedAt: 5, closedAt: null },
    ];
    const messages: SelectionMessage[] = [
      { messageId: "m1", order: 1, kind: "user_prompt", tokenEstimate: 1, turnId: "t1", text: "m1" },
      { messageId: "m3", order: 3, kind: "user_prompt", tokenEstimate: 1, turnId: "t2", text: "m3" },
      { messageId: "m5", order: 5, kind: "user_prompt", tokenEstimate: 1_000_000, turnId: "t3", text: "m5" },
    ];
    const inputs: SelectionInputs = {
      messages,
      turns,
      chunks: [],
      derivations: new Map([
        ["t1/turn_rendering", { state: "ready", content: olderBody }],
        ["t2/turn_rendering", { state: "ready", content: newerBody }],
      ]),
      maxEventOrder: 5,
      derivationCounts: {},
      skippedRecords: [],
    };

    const selection = selectArrangement(inputs, config);

    expect(selection.compactPoint).toBe(4);
    // Both entries fit, the newer one first and the older one landing on the
    // budget exactly. A strict `<` would stop the band after the newer entry
    // and drop the older one.
    expect(selection.entries.map((entry) => entry.subjectId)).toEqual(["t1", "t2"]);
    expect(selection.entries.map((entry) => entry.tokens).reduce((total, tokens) => total + tokens, 0)).toBe(
      smoothBudget,
    );
    expect(selection.entries.every((entry) => entry.band === "smooth")).toBe(true);
  });
});
