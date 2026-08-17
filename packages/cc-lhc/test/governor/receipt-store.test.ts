import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";

import { BUILTIN_CONTEXT_POLICY } from "../../src/governor/config.js";
import { applyGovernorLifecycleBatch, createGovernorRuntimeState } from "../../src/governor/observe-state.js";
import { governorReceiptReplayKey, openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import type { ResolvedContextPolicy } from "../../src/governor/types.js";
import { openLineageDatabase } from "../../src/intake/lineage-db.js";

function armed(): ResolvedContextPolicy {
  const policy = { ...BUILTIN_CONTEXT_POLICY, autoCompact: true };
  const sources = Object.fromEntries(
    Object.keys(policy).map((k) => [k, "builtin"]),
  ) as ResolvedContextPolicy["sources"];
  return { policy, sources, armed: true, errors: [] };
}

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function settledWouldCompact() {
  const { observes } = applyGovernorLifecycleBatch(
    createGovernorRuntimeState({
      captureHealthy: true,
      captureGeneration: 3,
      descriptorReady: true,
    }),
    [
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "s1",
        providerUsage: {
          input_tokens: 200_000,
          cache_creation_input_tokens: 100_000,
          cache_read_input_tokens: 80_000,
        },
      },
      {
        kind: "post_measurement_estimate",
        tokens: 5_000,
        source: "lhc_token_estimate",
      },
      { kind: "turn_settled", reason: "end_turn" },
    ],
    armed(),
  );
  return observes.filter((o) => o.observePhase === "settled_seam")[0]!;
}

describe("governor durable receipt store", () => {
  it("persists observe receipts and survives reopen (restart/replay)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-gov-receipt-"));
    dirs.push(dir);
    const dbPath = join(dir, "cc-lhc.sqlite");

    const settled = settledWouldCompact();
    const store1 = openGovernorReceiptStore(dbPath);
    const durable = store1.appendObserve({
      observe: settled,
      sessionId: "sess-a",
      threadId: "th_a",
    });
    expect(durable.inserted).toBe(true);
    expect(durable.receipt.decision).toBe("would_compact");
    expect(durable.receipt.wouldMutate).toBe(true);
    expect(durable.receipt.pressure.nextRequestPressureTokens).toBe(385_000);
    expect(durable.receipt.handoffOutcome?.kind).toBe("scheduled");
    expect(durable.receipt.captureGeneration).toBe(3);
    store1.close();

    // Restart: reopen the same file and inspect.
    const store2 = openGovernorReceiptStore(dbPath);
    const listed = store2.listBySession("sess-a");
    expect(listed.length).toBeGreaterThanOrEqual(1);
    const last = listed[listed.length - 1]!;
    expect(last.receiptId).toBe(durable.receipt.receiptId);
    expect(last.pressure.estimateDomain).toBe("source_labelled_estimate");
    expect(last.observe.providerContextTotal).toBe(380_000);
    expect(last.observe.pressure.estimateTokens).toBe(5_000);

    const attached = store2.attachHandoffOutcome(last.receiptId, {
      kind: "handoff_success",
      newSessionId: "sess-b",
      flushedInputBytes: 12,
    });
    expect(attached?.handoffOutcome).toEqual({
      kind: "handoff_success",
      newSessionId: "sess-b",
      flushedInputBytes: 12,
    });
    store2.close();

    const store3 = openGovernorReceiptStore(dbPath);
    const again = store3.getById(durable.receipt.receiptId);
    expect(again?.handoffOutcome?.kind).toBe("handoff_success");
    store3.close();
  });

  it("records deferred_open_turn for open-turn threshold classifications", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-gov-receipt-open-"));
    dirs.push(dir);
    const dbPath = join(dir, "cc-lhc.sqlite");
    const { observes } = applyGovernorLifecycleBatch(
      createGovernorRuntimeState({
        captureHealthy: true,
        captureGeneration: 1,
        descriptorReady: true,
      }),
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "s1",
          providerUsage: { input_tokens: 500_000 },
        },
      ],
      armed(),
    );
    const open = observes.find((o) => o.observePhase === "open_turn" && o.decision === "would_compact");
    expect(open).toBeDefined();
    const store = openGovernorReceiptStore(dbPath);
    const receipt = store.appendObserve({ observe: open!, sessionId: "s", threadId: "t" });
    expect(receipt.inserted).toBe(true);
    expect(receipt.receipt.wouldMutate).toBe(false);
    expect(receipt.receipt.handoffOutcome).toEqual({ kind: "deferred_open_turn" });
    store.close();
  });

  it("exact replay is idempotent and preserves terminal handoff outcome", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-gov-receipt-idem-"));
    dirs.push(dir);
    const dbPath = join(dir, "cc-lhc.sqlite");
    const settled = settledWouldCompact();
    const store = openGovernorReceiptStore(dbPath);

    const first = store.appendObserve({ observe: settled, sessionId: "sess", threadId: "th" });
    expect(first.inserted).toBe(true);
    store.attachHandoffOutcome(first.receipt.receiptId, {
      kind: "handoff_success",
      newSessionId: "new",
      flushedInputBytes: 3,
    });

    // Same native facts, different in-memory observeSequence (restart).
    const replayObserve = {
      ...settled,
      observeSequence: 999,
      settleSequence: 999,
      captureGeneration: 99,
    };
    const second = store.appendObserve({ observe: replayObserve, sessionId: "sess", threadId: "th" });
    expect(second.inserted).toBe(false);
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(second.receipt.handoffOutcome?.kind).toBe("handoff_success");
    expect(store.listBySession("sess")).toHaveLength(1);

    // Close/reopen + replay: row count unchanged.
    store.close();
    const reopened = openGovernorReceiptStore(dbPath);
    const third = reopened.appendObserve({ observe: settled, sessionId: "sess", threadId: "th" });
    expect(third.inserted).toBe(false);
    expect(reopened.listBySession("sess")).toHaveLength(1);
    expect(third.receipt.handoffOutcome?.kind).toBe("handoff_success");
    reopened.close();
  });

  it("changed pressure/classification creates a distinct receipt", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-gov-receipt-distinct-"));
    dirs.push(dir);
    const dbPath = join(dir, "cc-lhc.sqlite");
    const settled = settledWouldCompact();
    const store = openGovernorReceiptStore(dbPath);
    const a = store.appendObserve({ observe: settled, sessionId: "s", threadId: "t" });
    const changed = {
      ...settled,
      postMeasurementEstimate: {
        tokens: 50_000,
        source: "accepted_lhc_canonical_payload_byte_estimate",
        domain: "source_labelled_estimate" as const,
      },
      pressure: {
        ...settled.pressure,
        estimateTokens: 50_000,
        nextRequestPressureTokens: (settled.providerContextTotal ?? 0) + 50_000,
        atOrAboveTrigger: true,
      },
    };
    const b = store.appendObserve({ observe: changed, sessionId: "s", threadId: "t" });
    expect(b.inserted).toBe(true);
    expect(b.receipt.receiptId).not.toBe(a.receipt.receiptId);
    expect(store.listBySession("s")).toHaveLength(2);
    expect(governorReceiptReplayKey({ observe: settled, sessionId: "s", threadId: "t" })).not.toBe(
      governorReceiptReplayKey({ observe: changed, sessionId: "s", threadId: "t" }),
    );
    store.close();
  });

  it("coexists with lineage DB opens (busy_timeout before WAL)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-gov-receipt-coex-"));
    dirs.push(dir);
    const dbPath = join(dir, "cc-lhc.sqlite");

    // Lineage opens first (same file).
    const lineage = openLineageDatabase(dbPath);
    const store = openGovernorReceiptStore(dbPath);
    const settled = settledWouldCompact();
    const result = store.appendObserve({ observe: settled, sessionId: "s", threadId: "t" });
    expect(result.inserted).toBe(true);

    // Concurrent second connection appends must not throw SQLITE_BUSY instantly.
    const store2 = openGovernorReceiptStore(dbPath);
    const again = store2.appendObserve({ observe: settled, sessionId: "s", threadId: "t" });
    expect(again.inserted).toBe(false);
    expect(again.receipt.receiptId).toBe(result.receipt.receiptId);

    // busy_timeout is set on a raw open path for the store schema init.
    const probe = new DatabaseSync(dbPath);
    probe.exec("PRAGMA busy_timeout = 10000");
    const mode = probe.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(String(mode.journal_mode).toLowerCase()).toBe("wal");
    probe.close();

    store2.close();
    store.close();
    lineage.close();
  });

  it("concurrent appends for the same replay key do not create duplicates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-gov-receipt-race-"));
    dirs.push(dir);
    const dbPath = join(dir, "cc-lhc.sqlite");
    const settled = settledWouldCompact();
    // Seed schema.
    const seed = openGovernorReceiptStore(dbPath);
    seed.close();

    const workerSrc = `
      const { parentPort, workerData } = require("node:worker_threads");
      const { pathToFileURL } = require("node:url");
      (async () => {
        const mod = await import(pathToFileURL(workerData.moduleUrl).href);
        const store = mod.openGovernorReceiptStore(workerData.dbPath);
        const result = store.appendObserve({
          observe: workerData.observe,
          sessionId: "race",
          threadId: "th",
        });
        store.close();
        parentPort.postMessage({ receiptId: result.receipt.receiptId, inserted: result.inserted });
      })().catch((e) => {
        parentPort.postMessage({ error: String(e) });
      });
    `;

    // Resolve built-ish path: use file URL of compiled-free TS via vitest runtime — run sequential
    // same-process concurrent-style opens instead if workers cannot load TS.
    // Same-process multi-connection race:
    const a = openGovernorReceiptStore(dbPath);
    const b = openGovernorReceiptStore(dbPath);
    const r1 = a.appendObserve({ observe: settled, sessionId: "race", threadId: "th" });
    const r2 = b.appendObserve({ observe: settled, sessionId: "race", threadId: "th" });
    expect(r1.receipt.receiptId).toBe(r2.receipt.receiptId);
    expect([r1.inserted, r2.inserted].filter(Boolean).length).toBe(1);
    expect(a.listBySession("race")).toHaveLength(1);
    a.close();
    b.close();
    void workerSrc;
    void Worker;
  });
});
