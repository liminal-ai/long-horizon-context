import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BUILTIN_CONTEXT_POLICY } from "../../src/governor/config.js";
import { applyGovernorLifecycleBatch, createGovernorRuntimeState } from "../../src/governor/observe-state.js";
import { openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import type { ResolvedContextPolicy } from "../../src/governor/types.js";

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

describe("governor durable receipt store", () => {
  it("persists observe receipts and survives reopen (restart/replay)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-gov-receipt-"));
    dirs.push(dir);
    const dbPath = join(dir, "cc-lhc.sqlite");

    const state = createGovernorRuntimeState({
      captureHealthy: true,
      captureGeneration: 3,
      descriptorReady: true,
    });
    const { observes } = applyGovernorLifecycleBatch(
      state,
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
    const settled = observes.filter((o) => o.observePhase === "settled_seam");
    expect(settled).toHaveLength(1);

    const store1 = openGovernorReceiptStore(dbPath);
    const openReceives = observes.filter((o) => o.observePhase === "open_turn");
    for (const o of openReceives) {
      store1.appendObserve({ observe: o, sessionId: "sess-a", threadId: "th_a" });
    }
    const durable = store1.appendObserve({
      observe: settled[0]!,
      sessionId: "sess-a",
      threadId: "th_a",
    });
    expect(durable.decision).toBe("would_compact");
    expect(durable.wouldMutate).toBe(true);
    expect(durable.pressure.nextRequestPressureTokens).toBe(385_000);
    expect(durable.handoffOutcome?.kind).toBe("scheduled");
    expect(durable.captureGeneration).toBe(3);
    store1.close();

    // Restart: reopen the same file and inspect.
    const store2 = openGovernorReceiptStore(dbPath);
    const listed = store2.listBySession("sess-a");
    expect(listed.length).toBeGreaterThanOrEqual(1);
    const last = listed[listed.length - 1]!;
    expect(last.receiptId).toBe(durable.receiptId);
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
    const again = store3.getById(durable.receiptId);
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
    expect(receipt.wouldMutate).toBe(false);
    expect(receipt.handoffOutcome).toEqual({ kind: "deferred_open_turn" });
    store.close();
  });
});
