// LIM-115 differential proof: the bounded Smart Compact selector against the
// legacy eager one, on frozen copies of one record.
//
// The two states are the only two that exist, selected the way production
// selects them — LHC_COMPACT_ALGORITHM unset for the bounded default, set to
// `legacy` for the eager plan. There is no third comparison mode here: each
// run is an ordinary prepare/install against its own frozen copy of the same
// SQLite file, so neither can see the other's writes.
//
// `createdAt` is pinned through installPreparedCompact's existing seam, and
// nothing else is normalized: the comparison is byte equality of the whole
// observation — preview, prepared arrangement and its entry text, receipt,
// stored view, served model context, session view, and the materialized PI
// session file.
import { copyFileSync, readFileSync } from "node:fs";
import type { SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CompactContinuationHostFacts,
  initLhc,
  type Lhc,
  type MessageEventInput,
  type ViewCompactParams,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  derivedThreadFixture,
  mixedStateVariantThread,
  openRaw,
  runCompactContinuationForTests,
  setIntakeClock,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
// Whatever the ambient environment selected: withAlgorithm restores it, so
// the file behaves the same under either default.
const AMBIENT_ALGORITHM = process.env["LHC_COMPACT_ALGORITHM"];

afterEach(() => {
  store.cleanup();
  if (AMBIENT_ALGORITHM === undefined) delete process.env["LHC_COMPACT_ALGORITHM"];
  else process.env["LHC_COMPACT_ALGORITHM"] = AMBIENT_ALGORITHM;
});

const PINNED_CREATED_AT = "2026-03-03T03:03:03.030Z";

// Bands wide enough that all three fill from the 12-turn fixture, and a full
// share small enough that the compact point lands mid-record.
const BAND_PARAMS: ViewCompactParams = {
  lowerBound: 900,
  percentages: { full: 20, smooth: 20, detailed: 30, brief: 30 },
};

// A detailed share too small for the fixture's chunks, so the rest cascade
// into brief and all three bands carry entries.
const THREE_BAND_PARAMS: ViewCompactParams = {
  lowerBound: 900,
  percentages: { full: 20, smooth: 15, detailed: 5, brief: 60 },
};

function sdkFor(): Lhc {
  return initLhc({
    inferenceCallbacks: createInferenceCallbacksDouble(),
    mode: "manual",
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
  });
}

function execSql(filePath: string, sql: string, ...params: SQLInputValue[]): void {
  const db = openRaw(filePath);
  try {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

let frozenCounter = 0;

/**
 * One SQLite state, two independent copies. The WAL is checkpointed into the
 * main file first so a copy is the whole record, and each plan then runs
 * against its own file — never the same live one.
 */
function freeze(sourcePath: string): { legacy: string; bounded: string } {
  const db = openRaw(sourcePath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
  frozenCounter += 1;
  const legacy = store.threadPath(`frozen-${frozenCounter}-legacy`);
  const bounded = store.threadPath(`frozen-${frozenCounter}-bounded`);
  copyFileSync(sourcePath, legacy);
  copyFileSync(sourcePath, bounded);
  return { legacy, bounded };
}

async function withAlgorithm<T>(algorithm: "bounded" | "legacy", run: () => Promise<T>): Promise<T> {
  const previous = process.env["LHC_COMPACT_ALGORITHM"];
  if (algorithm === "legacy") process.env["LHC_COMPACT_ALGORITHM"] = "legacy";
  else delete process.env["LHC_COMPACT_ALGORITHM"];
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env["LHC_COMPACT_ALGORITHM"];
    else process.env["LHC_COMPACT_ALGORITHM"] = previous;
  }
}

interface ObserveOptions {
  params?: ViewCompactParams;
  compactPointUpperBound?: number;
  /** Applied to this copy between prepare and install: the source-drift leg. */
  driftBetweenPrepareAndInstall?: (filePath: string) => void;
}

/**
 * Everything compact produces for one plan on one copy: the preview, the
 * prepared arrangement, the receipt, the stored view, both served shapes, and
 * the materialized session file's bytes.
 */
async function observe(sdk: Lhc, filePath: string, opts: ObserveOptions = {}): Promise<unknown> {
  const compactOpts = opts.params === undefined ? {} : { params: opts.params };
  const preview = await sdk.threadView.previewCompact({ filePath }, compactOpts);
  const prepared = await sdk.threadView.prepareCompact(
    { filePath },
    {
      ...compactOpts,
      ...(opts.compactPointUpperBound !== undefined ? { compactPointUpperBound: opts.compactPointUpperBound } : {}),
    },
  );
  if (!prepared.ok) return { preview, prepared };
  opts.driftBetweenPrepareAndInstall?.(filePath);
  const receipt = await sdk.threadView.installPreparedCompact({ filePath }, prepared.value, {
    createdAt: PINNED_CREATED_AT,
  });
  return { preview, prepared, receipt, ...(await serve(sdk, filePath)) };
}

/** The serving side, after whatever installed the view. */
async function serve(sdk: Lhc, filePath: string): Promise<Record<string, unknown>> {
  const described = await sdk.threadView.describe({ filePath });
  const llmContext = await sdk.threadView.getLlmRequestContext({ filePath });
  const sessionView = await sdk.threadView.getSessionThreadView({ filePath });
  const sessionFile = `${filePath}.pi.jsonl`;
  const materialized = await sdk.threadView.materialize({ filePath }, { path: sessionFile });
  return {
    described,
    llmContext,
    sessionView,
    materialized: materialized.ok,
    sessionFileBytes: materialized.ok ? readFileSync(sessionFile, "utf8") : null,
  };
}

/** Runs both plans on frozen copies and asserts byte equality of the whole observation. */
async function expectPlansAgree(sourcePath: string, opts: ObserveOptions = {}): Promise<unknown> {
  const sdk = sdkFor();
  const copies = freeze(sourcePath);
  const legacy = await withAlgorithm("legacy", () => observe(sdk, copies.legacy, opts));
  const bounded = await withAlgorithm("bounded", () => observe(sdk, copies.bounded, opts));
  // toEqual first for a readable diff, then the byte check the proof rests on.
  expect(bounded).toEqual(legacy);
  expect(JSON.stringify(bounded)).toBe(JSON.stringify(legacy));
  return bounded;
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<string[]> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value.events.map((entry) => entry.messageId ?? "");
}

describe("LIM-115: bounded and legacy Smart Compact agree byte for byte", () => {
  it("healthy derived thread: every band fills from stored derivations", async () => {
    const fixture = await derivedThreadFixture(store);
    const observed = (await expectPlansAgree(fixture.filePath, { params: THREE_BAND_PARAMS })) as {
      prepared: { ok: true; value: { bands: unknown[]; selection: { compactPoint: number } } };
    };
    // The scenario is only proof if it actually banded.
    expect(observed.prepared.value.bands.length).toBe(3);
    expect(observed.prepared.value.selection.compactPoint).toBeGreaterThan(0);
  });

  it("open turns, blocked and pending derivations, fallback excerpts", async () => {
    const fixture = await mixedStateVariantThread(store);
    await expectPlansAgree(fixture.filePath, { params: BAND_PARAMS });
  });

  it("missing and failed chunk summaries fall back to stored-member material", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    for (const chunkId of ["c1", "c2", "c3"]) {
      execSql(
        fixture.filePath,
        `UPDATE derivation SET state = 'failed', content = NULL, reason = 'timeout: scripted'
         WHERE subject_kind = 'chunk' AND subject_id = ?`,
        chunkId,
      );
    }
    execSql(fixture.filePath, `DELETE FROM derivation WHERE subject_kind = 'chunk' AND subject_id = 'c3'`);
    const observed = (await expectPlansAgree(fixture.filePath, { params: BAND_PARAMS })) as {
      prepared: { ok: true; value: { warnings: unknown[] } };
    };
    expect(observed.prepared.value.warnings.length).toBeGreaterThan(0);
  });

  it("deleted messages and a tombstoned turn (orphaned messages, empty chunk)", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const listed = await fixture.sdk.messages.list({ filePath: fixture.filePath });
    if (!listed.ok) throw new Error(listed.error.reason);
    const target = listed.value.find((record) => record.kind === "assistant_text" && record.turnId === "t3");
    if (target === undefined) throw new Error("fixture invariant: t3 carries no assistant text");
    const deleted = await fixture.sdk.messages.remove({ filePath: fixture.filePath }, { messageId: target.messageId });
    if (!deleted.ok) throw new Error(deleted.error.reason);
    // A tombstoned turn is a legitimate reference target: its messages become
    // orphans the walk skips and the receipt names.
    execSql(fixture.filePath, `UPDATE turns SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE turn_id = 't2'`);
    const observed = (await expectPlansAgree(fixture.filePath, { params: BAND_PARAMS })) as {
      prepared: { ok: true; value: { skippedRecords: Array<{ kind: string }> } };
    };
    expect(observed.prepared.value.skippedRecords.some((record) => record.kind === "orphaned_message")).toBe(true);
  });

  it("a chunk member pointing at a missing turn row", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    execSql(fixture.filePath, `DELETE FROM turns WHERE turn_id = 't1'`);
    const observed = (await expectPlansAgree(fixture.filePath, { params: BAND_PARAMS })) as {
      prepared: { ok: true; value: { skippedRecords: Array<{ kind: string }> } };
    };
    expect(observed.prepared.value.skippedRecords.some((record) => record.kind === "dangling_chunk_member")).toBe(true);
  });

  it("compactPointUpperBound snaps both plans to the same closed-turn boundary", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    // The protected-pair tail: the bound compact may not advance past.
    const bounds = await fixture.sdk.threadView.previewProtectedBoundary(
      { filePath: fixture.filePath },
      { protectedToolCallIds: ["call-fx-8-1", "call-fx-8-2"] },
    );
    if (!bounds.ok) throw new Error(bounds.error.reason);
    expect(bounds.value.earliestProtectedResultOrder).not.toBeNull();
    await expectPlansAgree(fixture.filePath, {
      params: BAND_PARAMS,
      compactPointUpperBound: bounds.value.maxLegalBoundary,
    });
  });

  it("source drift between prepare and install recomputes identically", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await expectPlansAgree(fixture.filePath, {
      params: BAND_PARAMS,
      // Same edit applied to each copy after its own prepare: install sees
      // drift and reassembles under the install lock.
      driftBetweenPrepareAndInstall: (filePath) => {
        execSql(
          filePath,
          `UPDATE derivation SET content = 'drifted after prepare'
           WHERE subject_kind = 'turn' AND subject_id = 't4' AND derivation_type = 'turn_rendering'`,
        );
      },
    });
  });

  it("compact continuation installs the same view under both plans", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await send(fixture.sdk, fixture.filePath, [
      validEvent("user_prompt", { payload: { text: "continue the investigation with more context" } }),
      validEvent("assistant_text", { payload: { text: "working on it with more detail ".repeat(20) } }),
    ]);
    const copies = freeze(fixture.filePath);
    const facts = (): CompactContinuationHostFacts => ({
      attemptId: "lim-115-differential",
      seam: {
        modelResponseComplete: true,
        requestedToolsSettled: true,
        captureFlushed: true,
        beforeNextProviderRequest: true,
        insideTransportRetry: false,
        inputEpochAtDecision: 1,
        inputEpochAtApply: 1,
      },
      providerUsage: {
        available: true,
        inputTokens: 90000,
        cacheCreationTokens: 5000,
        cacheReadTokens: 10000,
        total: 105000,
        domain: "provider_reported_input",
      },
      postMeasurementEstimate: { tokens: 2000, source: "lhc_token_estimate", domain: "source_labelled_estimate" },
      policy: {
        upperTriggerTokens: 100000,
        lowerTargetTokens: 400,
        hostCapability: "full_state_machine",
        safeRunwayThresholdTokens: 200000,
        safeRunwayThresholdSource: "host_safe_runway",
      },
      continuation: { kind: "active_non_tool" },
      writerClaim: "none",
      captureComplete: true,
      providerIdentityValid: true,
      actor: "fixture-actor",
      harness: "fixture-harness",
      compact: { params: BAND_PARAMS },
    });
    const sdk = sdkFor();
    // The continuation runner's own clock is pinned, and so is intake's, so
    // the marker event and the receipt carry fixed instants. The one instant
    // no seam reaches is the view's createdAt: that path installs with its own
    // `new Date()`, and the value is not a selector output. Each run's own
    // createdAt — and nothing else — is replaced before the byte comparison.
    setIntakeClock(() => new Date(PINNED_CREATED_AT));
    const run = async (filePath: string): Promise<string> => {
      const result = await runCompactContinuationForTests({ filePath }, facts(), () => new Date(PINNED_CREATED_AT));
      const served = await serve(sdk, filePath);
      const described = served["described"] as { ok: boolean; value?: { createdAt?: string } };
      const createdAt = described.value?.createdAt;
      if (createdAt === undefined) throw new Error("continuation did not install a view");
      return JSON.stringify({ result, ...served })
        .split(createdAt)
        .join("<view-created-at>");
    };
    try {
      const legacy = await withAlgorithm("legacy", () => run(copies.legacy));
      const bounded = await withAlgorithm("bounded", () => run(copies.bounded));
      expect(bounded).toBe(legacy);
    } finally {
      setIntakeClock(null);
    }
  });

  it("unreadable stored-member material on an unselected chunk changes nothing", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    // c1 has no summaries left, so its entry would need stored-member
    // material — and that material is unreadable, because a member turn is
    // closed with no close boundary. Both plans omit blocked material, so the
    // arrangement is the same whether or not it was ever asked for.
    execSql(fixture.filePath, `DELETE FROM derivation WHERE subject_kind = 'chunk' AND subject_id = 'c1'`);
    execSql(fixture.filePath, `UPDATE turns SET closed_at_event_order = NULL WHERE turn_id = 't1'`);
    await expectPlansAgree(fixture.filePath, { params: THREE_BAND_PARAMS });
  });
});
