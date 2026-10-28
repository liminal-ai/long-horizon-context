import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type MessageEventInput, threads } from "../src/index.js";
import type { DbReadTransaction } from "../src/shared-tech/index.js";
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
import { estimateTokens, o200k } from "./fixtures/tokens.js";

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

const FULL_BUDGET = 100;
const PARAMS = { lowerBound: 1000, percentages: { full: 10, smooth: 30, detailed: 30, brief: 30 } };
const CONFIG: SelectionConfig = {
  lowerBound: PARAMS.lowerBound,
  percentages: PARAMS.percentages,
  tokenEstimator: o200k,
};

function sdkFor(): Lhc {
  return initLhc({ tokenFamily: "o200k", inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
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

function boundedCompactPoint(filePath: string): number {
  return withDb(filePath, (db) => {
    const transaction: DbReadTransaction = { db, filePath, threadId: "boundary" };
    const plan = createBoundedSelection(db, transaction, {
      includeChunkMaterials: true,
      signal: undefined,
      tokenEstimator: o200k,
    });
    return walkArrangement(plan.source, CONFIG).compactPoint;
  });
}

function legacyCompactPoint(filePath: string): number {
  return withDb(filePath, (db) => selectArrangement(readSelectionInputs(db, o200k), CONFIG).compactPoint);
}

async function previewCompactPoint(algorithm: "bounded" | "legacy", filePath: string): Promise<number> {
  if (algorithm === "legacy") process.env["LHC_COMPACT_ALGORITHM"] = "legacy";
  else delete process.env["LHC_COMPACT_ALGORITHM"];
  const preview = await sdkFor().threadView.previewCompact({ filePath }, { params: PARAMS });
  if (!preview.ok) throw new Error(preview.error.reason);
  if (preview.value.kind !== "ok") throw new Error(preview.value.reason);
  return preview.value.preview.compactPoint;
}

async function expectCompactPoint(filePath: string, expected: number): Promise<void> {
  expect(boundedCompactPoint(filePath)).toBe(expected);
  expect(legacyCompactPoint(filePath)).toBe(expected);
  expect(await previewCompactPoint("bounded", filePath)).toBe(expected);
  expect(await previewCompactPoint("legacy", filePath)).toBe(expected);
}

describe("LIM-115 boundary A: the crossing message that lands exactly on the full budget", () => {
  it("takes the message whose running sum equals the budget, not the one after it", async () => {
    const filePath = await threadWithExactTokens([
      [10, 10],
      [10, 10],
      [30, 20],
      [20, 20],
      [20, 20],
    ]);
    expect(closedAtOf(filePath, "t2")).toBe(6);
    expect(closedAtOf(filePath, "t3")).toBe(9);

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

    await expectCompactPoint(filePath, 9);
  });
});

describe("LIM-115 boundary B: the closed turn that straddles the budget line at an exact tie", () => {
  it("keeps a turn split exactly in half in full", async () => {
    const filePath = await threadWithExactTokens([
      [10, 10],
      [10, 10],
      [15, 25],
      [20, 20],
      [20, 20],
    ]);
    expect(closedAtOf(filePath, "t2")).toBe(6);
    expect(closedAtOf(filePath, "t3")).toBe(9);
    await expectCompactPoint(filePath, 6);
  });

  it("sends a turn one token short of the tie to smooth", async () => {
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
    const olderBody = "older banded turn rendering body with enough words to price above zero";
    const newerBody = "newer banded turn rendering body";
    const olderTokens = estimateTokens(olderBody);
    const newerTokens = estimateTokens(newerBody);
    const smoothBudget = olderTokens + newerTokens;

    const config: SelectionConfig = {
      lowerBound: 4 * smoothBudget,
      percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
      tokenEstimator: o200k,
    };
    expect((config.lowerBound * config.percentages.smooth) / 100).toBe(smoothBudget);

    const turns: SelectionTurn[] = [
      { turnId: "t1", turnOrder: 1, status: "closed", openedAt: 1, closedAt: 2 },
      { turnId: "t2", turnOrder: 2, status: "closed", openedAt: 3, closedAt: 4 },
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
    expect(selection.entries.map((entry) => entry.subjectId)).toEqual(["t1", "t2"]);
    expect(selection.entries.map((entry) => entry.tokens).reduce((total, tokens) => total + tokens, 0)).toBe(
      smoothBudget,
    );
    expect(selection.entries.every((entry) => entry.band === "smooth")).toBe(true);
  });
});
