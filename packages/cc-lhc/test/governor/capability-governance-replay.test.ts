/**
 * LIM-64 acceptance matrix — provider-aware replay fixtures (no paid calls).
 *
 * Covers:
 * 1 multi-model-turn authority
 * 2 threshold during open turn (classify, no mutate)
 * 3 settled seam would_compact + wouldMutate
 * 4 input/cache/cache-read math + source-labelled estimate
 * 5 post-measurement estimate crosses threshold
 * 6 missing/invalid usage falls back to the last known reading
 * 7 removed transient gates no longer suppress a settled compact
 * 8 native summary observation does not suppress later LHC compact
 * 9 handoff outcome receipt attachments (success/refuse/partial/rollback/retry)
 * 10 restart/replay durability of receipts
 * 11 capability boundary fields present on every receipt
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BUILTIN_CONTEXT_POLICIES, CONTEXT_WINDOW_NOT_YET_OBSERVED } from "../../src/governor/config.js";
import {
  applyGovernorLifecycleBatch,
  createGovernorRuntimeState,
  noteGovernorInput,
  setGovernorOperationInFlight,
} from "../../src/governor/observe-state.js";
import { buildPressureReceipt, providerContextFromUsage } from "../../src/governor/provider-context.js";
import { openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import type { GovernorHandoffOutcome, ResolvedContextPolicy } from "../../src/governor/types.js";
import type { LifecycleSignal } from "../../src/observation/types.js";

function armed(over: Partial<ResolvedContextPolicy["policy"]> = {}): ResolvedContextPolicy {
  const policy = { ...BUILTIN_CONTEXT_POLICIES["1M"], ...over };
  const sources = Object.fromEntries(
    Object.keys(policy).map((k) => [k, "session"]),
  ) as ResolvedContextPolicy["sources"];
  return { policy, sources, fallbacks: [], contextWindow: CONTEXT_WINDOW_NOT_YET_OBSERVED };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function readyState() {
  return createGovernorRuntimeState({
    captureGeneration: 1,
  });
}

describe("LIM-64 capability-limited governance replay matrix", () => {
  it("1: multi-model turns — latest completed usage is authoritative", () => {
    const r = applyGovernorLifecycleBatch(
      readyState(),
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: {
            input_tokens: 100_000,
            cache_creation_input_tokens: 50_000,
            cache_read_input_tokens: 50_000,
          },
        },
        {
          kind: "sampling_observed",
          samplingId: "m2",
          providerUsage: {
            input_tokens: 200_000,
            cache_creation_input_tokens: 10_000,
            cache_read_input_tokens: 5_000,
          },
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      armed(),
    );
    const settled = r.observes.filter((o) => o.observePhase === "settled_seam")[0]!;
    expect(settled.providerContextTotal).toBe(215_000);
    expect(settled.samplingId).toBe("m2");
    expect(settled.decision).toBe("below_threshold");
  });

  it("2: threshold during open turn — classify/record, wouldMutate false", () => {
    const r = applyGovernorLifecycleBatch(
      readyState(),
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: { input_tokens: 400_000 },
        },
      ],
      armed(),
    );
    const open = r.observes.find((o) => o.observePhase === "open_turn")!;
    expect(open.decision).toBe("would_compact");
    expect(open.wouldMutate).toBe(false);
    expect(open.hostCapability).toBe("capability_limited");
  });

  it("3: safe settled seam — one would_compact with wouldMutate true", () => {
    const r = applyGovernorLifecycleBatch(
      readyState(),
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: { input_tokens: 400_000 },
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      armed(),
    );
    const settled = r.observes.filter((o) => o.observePhase === "settled_seam");
    expect(settled).toHaveLength(1);
    expect(settled[0]!.decision).toBe("would_compact");
    expect(settled[0]!.wouldMutate).toBe(true);
    expect(settled[0]!.hostCapability).toBe("capability_limited");
  });

  it("4: input + cache_creation + cache_read math; estimate domain separate", () => {
    const usage = providerContextFromUsage({
      input_tokens: 210_000,
      cache_creation_input_tokens: 25_000,
      cache_read_input_tokens: 85_000,
      output_tokens: 9_999,
    });
    expect(usage?.total).toBe(320_000);
    const pressure = buildPressureReceipt(
      usage,
      { tokens: 1_000, source: "lhc_token_estimate", domain: "source_labelled_estimate" },
      360_000,
    );
    expect(pressure.providerBaseTokens).toBe(320_000);
    expect(pressure.estimateTokens).toBe(1_000);
    expect(pressure.nextRequestPressureTokens).toBe(321_000);
    expect(pressure.providerBaseDomain).toBe("provider_reported_input");
    expect(pressure.estimateDomain).toBe("source_labelled_estimate");
  });

  it("5: content after provider request moves predicted pressure across threshold", () => {
    const r = applyGovernorLifecycleBatch(
      readyState(),
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: { input_tokens: 355_000 },
        },
        {
          kind: "post_measurement_estimate",
          tokens: 10_000,
          source: "host_byte_estimate",
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      armed(),
    );
    const settled = r.observes.filter((o) => o.observePhase === "settled_seam")[0]!;
    expect(settled.decision).toBe("would_compact");
    expect(settled.providerContextTotal).toBe(355_000);
    expect(settled.pressure.nextRequestPressureTokens).toBe(365_000);
    expect(settled.postMeasurementEstimate.source).toBe("host_byte_estimate");
  });

  it("6: missing/invalid latest usage keeps the last known reading and still compacts", () => {
    const carried = applyGovernorLifecycleBatch(
      readyState(),
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "old",
          providerUsage: { input_tokens: 900_000 },
        },
        { kind: "sampling_observed", samplingId: "new" },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      armed(),
    );
    const settled = carried.observes.filter((o) => o.observePhase === "settled_seam")[0];
    expect(settled?.decision).toBe("would_compact");
    expect(settled?.wouldMutate).toBe(true);
    // Truthful provenance: still provider-reported, explicitly not this turn's.
    expect(settled?.pressure.providerBaseTokens).toBe(900_000);
    expect(settled?.pressure.providerBaseFreshness).toBe("last_known");
    expect(settled?.pressure.providerBaseDomain).toBe("provider_reported_input");
  });

  it("7: removed transient gates no longer suppress a settled compact", () => {
    const overPressure: LifecycleSignal[] = [
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "m",
        providerUsage: { input_tokens: 500_000 },
      },
      { kind: "turn_settled", reason: "end_turn" },
    ];
    const settledDecision = (state: ReturnType<typeof readyState>) =>
      applyGovernorLifecycleBatch(state, overPressure, armed()).observes.filter(
        (o) => o.observePhase === "settled_seam",
      )[0];

    // Input typed during the turn: settled history cannot be retroactively
    // invalidated by bytes that belong to the next turn.
    let typedAhead = applyGovernorLifecycleBatch(
      readyState(),
      [{ kind: "turn_opened", reason: "user_prompt" }],
      armed(),
    ).state;
    typedAhead = noteGovernorInput(typedAhead);
    typedAhead = noteGovernorInput(typedAhead);
    const afterInput = applyGovernorLifecycleBatch(typedAhead, overPressure.slice(1), armed()).observes.filter(
      (o) => o.observePhase === "settled_seam",
    )[0];
    expect(afterInput?.decision).toBe("would_compact");
    expect(afterInput?.wouldMutate).toBe(true);
    // The epoch survives as a diagnostic on the receipt, without authority.
    expect(afterInput?.inputEpoch).toBe(2);

    // A degraded capture generation is a repair trigger for the wrapper, not a
    // decision input: the classification still says compact.
    const afterDegrade = applyGovernorLifecycleBatch(
      readyState(),
      [{ kind: "capture_degraded", reason: "file_shrink", generation: 2 }, ...overPressure],
      armed(),
    ).observes.filter((o) => o.observePhase === "settled_seam")[0];
    expect(afterDegrade?.decision).toBe("would_compact");
    expect(afterDegrade?.wouldMutate).toBe(true);
    expect(afterDegrade?.captureGeneration).toBe(2);

    // A session mismatch revokes retrieval; it does not decide compaction.
    const afterMismatch = applyGovernorLifecycleBatch(
      readyState(),
      [{ kind: "session_mismatch_observed", expected: "a", observed: "b" }, ...overPressure],
      armed(),
    ).observes.filter((o) => o.observePhase === "settled_seam")[0];
    expect(afterMismatch?.decision).toBe("would_compact");
    expect(afterMismatch?.wouldMutate).toBe(true);

    // Sequencing survives: one operation at a time.
    const inflight = setGovernorOperationInFlight(readyState(), true);
    expect(settledDecision(inflight)?.decision).toBe("operation_in_flight");
  });

  it("8: native summary observed — LHC still compacts at the next settled seam (R8)", () => {
    const r = applyGovernorLifecycleBatch(
      readyState(),
      [
        { kind: "native_compact_observed", summaryPreview: "compacted" },
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m",
          providerUsage: { input_tokens: 500_000 },
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      armed(),
    );
    const settled = r.observes.filter((o) => o.observePhase === "settled_seam")[0]!;
    expect(settled.decision).toBe("would_compact");
    expect(settled.wouldMutate).toBe(true);
  });

  it("9: handoff outcome attachments remain receipted (success/refuse/partial/rollback/retry)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-handoff-"));
    dirs.push(dir);
    const store = openGovernorReceiptStore(join(dir, "cc-lhc.sqlite"));

    const { observes } = applyGovernorLifecycleBatch(
      readyState(),
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m",
          providerUsage: { input_tokens: 400_000 },
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      armed(),
    );
    const settled = observes.filter((o) => o.observePhase === "settled_seam")[0]!;
    const receipt = store.appendObserve({
      observe: settled,
      sessionId: "old",
      threadId: "th",
    });
    expect(receipt.inserted).toBe(true);
    expect(receipt.receipt.handoffOutcome?.kind).toBe("scheduled");

    const outcomes: GovernorHandoffOutcome[] = [
      { kind: "handoff_success", newSessionId: "new", droppedInputBytes: 4 },
      { kind: "mutation_refused", detail: "compact preview error: stop" },
      { kind: "mutation_partial", detail: "view installed; no rebuilt artifact this seam" },
      {
        kind: "handoff_replacement_nonviable",
        detail: "attempt 1: candidate exited",
        oldSessionId: "old",
        rebuiltSessionId: "new",
        attempts: 2,
      },
    ];
    for (const outcome of outcomes) {
      const updated = store.attachHandoffOutcome(receipt.receipt.receiptId, outcome);
      expect(updated?.handoffOutcome).toEqual(outcome);
    }

    // A second settled seam at barely higher pressure still classifies
    // would_compact: there is no growth toll to pay for a retry.
    const after = applyGovernorLifecycleBatch(
      applyGovernorLifecycleBatch(
        readyState(),
        [
          { kind: "turn_opened", reason: "user_prompt" },
          {
            kind: "sampling_observed",
            samplingId: "a",
            providerUsage: { input_tokens: 400_000 },
          },
          { kind: "turn_settled", reason: "end_turn" },
        ],
        armed(),
      ).state,
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "b",
          providerUsage: { input_tokens: 405_000 },
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      armed(),
    );
    const second = after.observes.filter((o) => o.observePhase === "settled_seam")[0];
    expect(second?.decision).toBe("would_compact");
    expect(second?.wouldMutate).toBe(true);
    store.close();
  });

  it("10: restart/replay of governor receipts is deterministic", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-replay-"));
    dirs.push(dir);
    const path = join(dir, "cc-lhc.sqlite");

    const signals: LifecycleSignal[] = [
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "m1",
        providerUsage: {
          input_tokens: 100_000,
          cache_creation_input_tokens: 20_000,
          cache_read_input_tokens: 30_000,
        },
      },
      {
        kind: "post_measurement_estimate",
        tokens: 250_000,
        source: "lhc_token_estimate",
      },
      { kind: "turn_settled", reason: "end_turn" },
    ];
    const first = applyGovernorLifecycleBatch(readyState(), signals, armed());
    const second = applyGovernorLifecycleBatch(readyState(), signals, armed());
    // Pure fold is deterministic.
    expect(JSON.stringify(first.observes)).toBe(JSON.stringify(second.observes));

    const storeA = openGovernorReceiptStore(path);
    for (const o of first.observes) {
      storeA.appendObserve({ observe: o, sessionId: "s1", threadId: "t1" });
    }
    const snapshot = storeA.listBySession("s1").map((r) => ({
      decision: r.decision,
      phase: r.observePhase,
      pressure: r.pressure.nextRequestPressureTokens,
      wouldMutate: r.wouldMutate,
      estimate: r.postMeasurementEstimate.tokens,
    }));
    storeA.close();

    const storeB = openGovernorReceiptStore(path);
    const replay = storeB.listBySession("s1").map((r) => ({
      decision: r.decision,
      phase: r.observePhase,
      pressure: r.pressure.nextRequestPressureTokens,
      wouldMutate: r.wouldMutate,
      estimate: r.postMeasurementEstimate.tokens,
    }));
    expect(replay).toEqual(snapshot);
    expect(replay.some((r) => r.wouldMutate === true)).toBe(true);
    storeB.close();
  });

  it("11: documentation-facing capability fields — no Codex parity claim on records", () => {
    const r = applyGovernorLifecycleBatch(
      readyState(),
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m",
          providerUsage: { input_tokens: 400_000 },
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      armed(),
    );
    for (const o of r.observes) {
      expect(o.hostCapability).toBe("capability_limited");
      expect(o.event).toBe("governor_observe");
      // Never claim full-state-machine effects in the observe payload.
      expect(JSON.stringify(o)).not.toMatch(/full_state_machine|context_compact_continue|compact_preserve_tool/);
    }
  });
});
