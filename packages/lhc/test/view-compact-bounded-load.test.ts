// LIM-115 load bound: what the bounded selector reads, and what it refuses to.
//
// Two kinds of proof here.
//
//   - Positive, from the poison pill: an unreadable block on a historical
//     candidate the walk never visits. The bounded plan compacts; the legacy
//     plan throws on parse, because it loads every live message before
//     selecting. That difference is the bound — and it is the red proof too:
//     if the bounded plan hydrated the unvisited row it would throw with it.
//     The same poison on a candidate the walk DOES visit must fail under both,
//     so the bound is a bound and not a broken read.
//   - Direct, from the plan's own counters: on a record whose derivations are
//     all usable, no turn excerpt is hydrated and no chunk material is
//     resolved at all.
//
// The selector switch is proved end to end in a child process, where the
// environment is the real one and the diagnostic lands on real stderr.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbReadTransaction } from "../src/shared-tech/index.js";
import { createBoundedSelection } from "../src/thread-view/internal/bounded-source.js";
import {
  COMPACT_ALGORITHM_ENV_VAR,
  LEGACY_COMPACT_ALGORITHM,
  resolveCompactAlgorithm,
} from "../src/thread-view/internal/compact-algorithm.js";
import { walkArrangement } from "../src/thread-view/internal/walk.js";
import { derivedThreadFixture, openRaw, poisonMessageBlockJson, type TempStore, tempStore } from "./fixtures/index.js";

// Whatever the ambient environment selected: these tests set the selector
// explicitly and put it back, so the file behaves the same either way.
const AMBIENT_ALGORITHM = process.env[COMPACT_ALGORITHM_ENV_VAR];

function restoreAmbientAlgorithm(): void {
  if (AMBIENT_ALGORITHM === undefined) delete process.env[COMPACT_ALGORITHM_ENV_VAR];
  else process.env[COMPACT_ALGORITHM_ENV_VAR] = AMBIENT_ALGORITHM;
}

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
  restoreAmbientAlgorithm();
});

// Full share large enough that the newest turns are the whole tail and the
// oldest turns are never band candidates.
const TAIL_ONLY_PARAMS = { lowerBound: 400, percentages: { full: 50, smooth: 50, detailed: 0, brief: 0 } };
const BAND_PARAMS = { lowerBound: 900, percentages: { full: 20, smooth: 15, detailed: 5, brief: 60 } };

async function compactWith(
  algorithm: "bounded" | "legacy",
  sdk: Awaited<ReturnType<typeof derivedThreadFixture>>["sdk"],
  filePath: string,
  params: typeof TAIL_ONLY_PARAMS,
): Promise<{ ok: boolean; reason?: string }> {
  if (algorithm === "legacy") process.env[COMPACT_ALGORITHM_ENV_VAR] = LEGACY_COMPACT_ALGORITHM;
  else delete process.env[COMPACT_ALGORITHM_ENV_VAR];
  try {
    const result = await sdk.threadView.compact({ filePath }, { params });
    return result.ok ? { ok: true } : { ok: false, reason: result.error.reason };
  } finally {
    restoreAmbientAlgorithm();
  }
}

describe("LIM-115: the bounded selector's load bound", () => {
  it("does not read an unreadable block on a candidate the walk never visits", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const listed = await fixture.sdk.messages.list({ filePath: fixture.filePath });
    if (!listed.ok) throw new Error(listed.error.reason);
    const historical = listed.value.find((record) => record.turnId === "t1");
    if (historical === undefined) throw new Error("fixture invariant: t1 carries no message");
    poisonMessageBlockJson(fixture.filePath, historical.messageId);

    const bounded = await compactWith("bounded", fixture.sdk, fixture.filePath, TAIL_ONLY_PARAMS);
    expect(bounded.ok).toBe(true);

    // The red half: the same record, the same params, the plan that reads
    // everything. It never gets to select.
    const legacy = await compactWith("legacy", fixture.sdk, fixture.filePath, TAIL_ONLY_PARAMS);
    expect(legacy.ok).toBe(false);
    expect(legacy.reason).toContain("JSON");
  });

  it("does read the block of a candidate the walk does visit", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    // With no stored smooth rungs anywhere, every smooth entry falls to the
    // raw message excerpt — so the turns the walk selects are exactly the
    // turns it hydrates.
    const db = openRaw(fixture.filePath);
    let visitedTurnId: string;
    try {
      db.prepare(
        `DELETE FROM derivation WHERE subject_kind = 'turn'
         AND derivation_type IN ('turn_rendering', 'detailed_turn_compression')`,
      ).run();
      const transaction: DbReadTransaction = { db, filePath: fixture.filePath, threadId: "load-bound" };
      const plan = createBoundedSelection(db, transaction, { includeChunkMaterials: true, signal: undefined });
      const selection = walkArrangement(plan.source, BAND_PARAMS);
      const smooth = selection.entries.filter((entry) => entry.band === "smooth");
      expect(smooth.length).toBeGreaterThan(0);
      expect(smooth.every((entry) => entry.derivationUsed === "message_excerpt")).toBe(true);
      // One hydration per included entry, plus at most the one crossing
      // candidate the fill walk priced before the band stopped — and far
      // fewer than the record's turns either way.
      expect(plan.stats.turnExcerptHydrations).toBeGreaterThanOrEqual(smooth.length);
      expect(plan.stats.turnExcerptHydrations).toBeLessThanOrEqual(smooth.length + 1);
      expect(plan.stats.turnExcerptHydrations).toBeLessThan(fixture.turnIds.length);
      visitedTurnId = smooth[smooth.length - 1]?.subjectId as string;
    } finally {
      db.close();
    }

    const listed = await fixture.sdk.messages.list({ filePath: fixture.filePath });
    if (!listed.ok) throw new Error(listed.error.reason);
    const visited = listed.value.find((record) => record.turnId === visitedTurnId);
    if (visited === undefined) throw new Error(`fixture invariant: ${visitedTurnId} carries no message`);
    poisonMessageBlockJson(fixture.filePath, visited.messageId);

    const bounded = await compactWith("bounded", fixture.sdk, fixture.filePath, BAND_PARAMS);
    expect(bounded.ok).toBe(false);
    expect(bounded.reason).toContain("JSON");
  });

  it("hydrates no excerpt and resolves no chunk material when every derivation is usable", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const db = openRaw(fixture.filePath);
    try {
      const transaction: DbReadTransaction = {
        db,
        filePath: fixture.filePath,
        threadId: "measurement",
      };
      const plan = createBoundedSelection(db, transaction, { includeChunkMaterials: true, signal: undefined });
      const selection = walkArrangement(plan.source, BAND_PARAMS);
      expect(selection.entries.length).toBeGreaterThan(0);
      expect(plan.stats.turnExcerptHydrations).toBe(0);
      expect(plan.stats.messageBlockRowsRead).toBe(0);
      expect(plan.stats.chunkMaterialResolutions).toBe(0);
      // The compact-point walk reads the tail it is measuring, not the record.
      const liveMessages = (
        db.prepare(`SELECT COUNT(*) AS n FROM message WHERE deleted_at IS NULL`).get() as { n: number | bigint }
      ).n;
      expect(plan.stats.compactPointRowsScanned).toBeLessThan(Number(liveMessages));
    } finally {
      db.close();
    }
  });

  it("resolves chunk material only for the chunks the walk builds", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const db = openRaw(fixture.filePath);
    try {
      db.prepare(`DELETE FROM derivation WHERE subject_kind = 'chunk'`).run();
      const transaction: DbReadTransaction = { db, filePath: fixture.filePath, threadId: "measurement" };
      const plan = createBoundedSelection(db, transaction, { includeChunkMaterials: true, signal: undefined });
      const selection = walkArrangement(plan.source, BAND_PARAMS);
      const builtChunks = new Set(
        selection.entries.filter((entry) => entry.subjectKind === "chunk").map((entry) => entry.subjectId),
      );
      expect(builtChunks.size).toBeGreaterThan(0);
      const closedChunks = (
        db.prepare(`SELECT COUNT(*) AS n FROM chunk WHERE status = 'closed'`).get() as { n: number | bigint }
      ).n;
      // The eager plan resolves both summary types for every closed chunk.
      expect(plan.stats.chunkMaterialResolutions).toBeLessThan(Number(closedChunks) * 2);
    } finally {
      db.close();
    }
  });
});

describe("LIM-115: the algorithm selector", () => {
  it("accepts exactly one value and defaults to bounded", () => {
    expect(COMPACT_ALGORITHM_ENV_VAR).toBe("LHC_COMPACT_ALGORITHM");
    expect(resolveCompactAlgorithm({})).toBe("bounded");
    expect(resolveCompactAlgorithm({ LHC_COMPACT_ALGORITHM: "legacy" })).toBe("legacy");
    expect(resolveCompactAlgorithm({ LHC_COMPACT_ALGORITHM: "Legacy" })).toBe("bounded");
    expect(resolveCompactAlgorithm({ LHC_COMPACT_ALGORITHM: "1" })).toBe("bounded");
    expect(resolveCompactAlgorithm({ LHC_COMPACT_ALGORITHM: "" })).toBe("bounded");
    expect(resolveCompactAlgorithm({ LHC_COMPACT_ALGORITHM: "bounded" })).toBe("bounded");
  });

  it("switches the plan and announces itself in a real process", () => {
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    const fixturesRoot = fileURLToPath(new URL("./fixtures", import.meta.url));
    const scriptPath = join(store.dir, "selector-probe.mts");
    // A whole thread, a poisoned historical block, one compact: the plan that
    // reads everything cannot finish, the bounded plan can.
    writeFileSync(
      scriptPath,
      `import { initLhc } from ${JSON.stringify(join(srcRoot, "index.ts"))};
import { createInferenceCallbacksDouble } from ${JSON.stringify(join(fixturesRoot, "inference-callbacks-double.ts"))};
import { DatabaseSync } from "node:sqlite";
const filePath = process.argv[2];
const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
const created = await sdk.threads.newThread({ filePath, registryPath: filePath + ".registry" });
if (!created.ok) throw new Error(created.error.reason);
let counter = 0;
const event = (eventKind, payload) => ({
  eventKind,
  idempotencyKey: "probe-" + ++counter,
  actor: "probe",
  harness: "probe",
  payload,
});
for (let turn = 1; turn <= 8; turn += 1) {
  const batch = await sdk.intakeStream.messageEvents({ filePath }, [
    event("user_prompt", { text: "turn " + turn + " prompt " + "x".repeat(200) }),
    event("assistant_text", { text: "turn " + turn + " answer " + "y".repeat(200) }),
    event("turn_end", {}),
  ]);
  if (!batch.ok) throw new Error(batch.error.reason);
}
const db = new DatabaseSync(filePath);
const oldest = db.prepare("SELECT message_id FROM message ORDER BY source_event_order LIMIT 1").get();
db.prepare("UPDATE message_block SET content = ? WHERE message_id = ?").run("{'x': 1,}", oldest.message_id);
db.close();
const compacted = await sdk.threadView.compact({ filePath }, {
  params: { lowerBound: 400, percentages: { full: 50, smooth: 50, detailed: 0, brief: 0 } },
});
console.log(JSON.stringify({ ok: compacted.ok, reason: compacted.ok ? null : compacted.error.reason }));
`,
      "utf8",
    );

    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const run = (env: NodeJS.ProcessEnv, threadName: string) =>
      spawnSync(tsx, [scriptPath, join(store.dir, `${threadName}.sqlite`)], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });

    const boundedRun = run({ LHC_COMPACT_ALGORITHM: "" }, "probe-bounded");
    expect(boundedRun.status, boundedRun.stderr).toBe(0);
    expect(JSON.parse(boundedRun.stdout.trim())).toEqual({ ok: true, reason: null });
    expect(boundedRun.stderr).not.toContain("LhcCompactAlgorithmWarning");

    const legacyRun = run({ LHC_COMPACT_ALGORITHM: "legacy" }, "probe-legacy");
    expect(legacyRun.status, legacyRun.stderr).toBe(0);
    const legacyResult = JSON.parse(legacyRun.stdout.trim()) as { ok: boolean; reason: string | null };
    expect(legacyResult.ok).toBe(false);
    expect(legacyResult.reason).toContain("JSON");
    // The escape hatch is not silent.
    expect(legacyRun.stderr).toContain("LhcCompactAlgorithmWarning");
    expect(legacyRun.stderr).toContain("LHC_COMPACT_ALGORITHM=legacy");
  }, 120_000);
});
