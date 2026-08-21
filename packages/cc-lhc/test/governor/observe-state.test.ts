import { describe, expect, it } from "vitest";

import { BUILTIN_CONTEXT_POLICY } from "../../src/governor/config.js";
import {
  applyGovernorLifecycleBatch,
  createGovernorRuntimeState,
  noteGovernorInput,
  setGovernorPostMeasurementEstimate,
} from "../../src/governor/observe-state.js";
import type { ResolvedContextPolicy } from "../../src/governor/types.js";
import type { LifecycleSignal } from "../../src/observation/types.js";

function armed(autoCompact = true): ResolvedContextPolicy {
  const policy = { ...BUILTIN_CONTEXT_POLICY, autoCompact };
  const sources = Object.fromEntries(
    Object.keys(policy).map((k) => [k, "builtin"]),
  ) as ResolvedContextPolicy["sources"];
  return { policy, sources, fallbacks: [] };
}

describe("governor observe-state fold", () => {
  it("emits one observe record per turn_settled; duplicate settle does not double-trigger", () => {
    const state = createGovernorRuntimeState({
      captureGeneration: 1,
    });
    const resolved = armed(true);
    const signals: LifecycleSignal[] = [
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "m1",
        providerUsage: {
          input_tokens: 400_000,
          cache_creation_input_tokens: 50_000,
          cache_read_input_tokens: 60_000,
        },
      },
      { kind: "turn_settled", reason: "end_turn" },
    ];
    const first = applyGovernorLifecycleBatch(state, signals, resolved);
    // Open-turn may emit would_compact (threshold) then settled also emits.
    const settled = first.observes.filter((o) => o.observePhase === "settled_seam");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.decision).toBe("would_compact");
    expect(settled[0]?.providerContextTotal).toBe(510_000);
    expect(settled[0]?.wouldMutate).toBe(true);
    expect(settled[0]?.hostCapability).toBe("capability_limited");
    expect(settled[0]?.pressure.nextRequestPressureTokens).toBe(510_000);

    // A second settled seam at the same pressure is still executable: a seam
    // that never started a mutation costs the next one nothing.
    const second = applyGovernorLifecycleBatch(first.state, [{ kind: "turn_settled", reason: "end_turn" }], resolved);
    expect(second.observes).toHaveLength(1);
    expect(second.observes[0]?.decision).toBe("would_compact");
    expect(second.observes[0]?.wouldMutate).toBe(true);
  });

  it("multiple model turns: the newest VALID sampling is authoritative", () => {
    const state = createGovernorRuntimeState({
      captureGeneration: 1,
    });
    const resolved = armed(true);

    const missing = applyGovernorLifecycleBatch(
      state,
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "request-1",
          providerUsage: { input_tokens: 600_000 },
        },
        { kind: "sampling_observed", samplingId: "request-2" },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      resolved,
    );
    const settledMissing = missing.observes.filter((o) => o.observePhase === "settled_seam");
    expect(settledMissing[0]?.decision).toBe("would_compact");
    expect(settledMissing[0]?.providerContextTotal).toBe(600_000);
    expect(settledMissing[0]?.pressure.providerBaseFreshness).toBe("last_known");

    const invalid = applyGovernorLifecycleBatch(
      state,
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "request-1",
          providerUsage: { input_tokens: 600_000 },
        },
        {
          kind: "sampling_observed",
          samplingId: "request-2",
          providerUsage: { input_tokens: -1 },
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      resolved,
    );
    const settledInvalid = invalid.observes.filter((o) => o.observePhase === "settled_seam")[0];
    expect(settledInvalid?.decision).toBe("would_compact");
    expect(settledInvalid?.providerContextTotal).toBe(600_000);
    expect(settledInvalid?.pressure.providerBaseFreshness).toBe("last_known");

    const replaced = applyGovernorLifecycleBatch(
      state,
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "request-1",
          providerUsage: { input_tokens: 600_000 },
        },
        {
          kind: "sampling_observed",
          samplingId: "request-2",
          providerUsage: { input_tokens: 100_000 },
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      resolved,
    );
    expect(replaced.observes.filter((o) => o.observePhase === "settled_seam")[0]?.decision).toBe("below_threshold");
    expect(replaced.observes.filter((o) => o.observePhase === "settled_seam")[0]?.providerContextTotal).toBe(100_000);
  });

  it("threshold crossed while turn open: classify would_compact with wouldMutate=false and no second mutate on open", () => {
    const state = createGovernorRuntimeState({
      captureGeneration: 1,
    });
    const resolved = armed(true);
    const r = applyGovernorLifecycleBatch(
      state,
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: {
            input_tokens: 400_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      ],
      resolved,
    );
    const open = r.observes.filter((o) => o.observePhase === "open_turn");
    expect(open.length).toBeGreaterThanOrEqual(1);
    expect(open[0]?.decision).toBe("would_compact");
    expect(open[0]?.wouldMutate).toBe(false);
    expect(open[0]?.reason).toMatch(/open turn|mid-agentic-turn/i);
    // No handoff cue while open.
    expect(r.observes.every((o) => o.wouldMutate === false)).toBe(true);
  });

  it("post-measurement estimate after provider request can cross threshold during open turn", () => {
    const state = createGovernorRuntimeState({
      captureGeneration: 1,
    });
    const resolved = armed(true);
    // Provider total just below upper (360k).
    const afterSampling = applyGovernorLifecycleBatch(
      state,
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: { input_tokens: 350_000 },
        },
      ],
      resolved,
    );
    // Below threshold open classification may be suppressed (turn_open noise).
    expect(afterSampling.observes.every((o) => o.decision !== "would_compact" || o.wouldMutate === false)).toBe(true);

    const afterEstimate = applyGovernorLifecycleBatch(
      afterSampling.state,
      [
        {
          kind: "post_measurement_estimate",
          tokens: 20_000,
          source: "lhc_token_estimate",
          mode: "set",
        },
      ],
      resolved,
    );
    const openWould = afterEstimate.observes.filter(
      (o) => o.observePhase === "open_turn" && o.decision === "would_compact",
    );
    expect(openWould).toHaveLength(1);
    expect(openWould[0]?.wouldMutate).toBe(false);
    expect(openWould[0]?.providerContextTotal).toBe(350_000);
    expect(openWould[0]?.pressure.estimateTokens).toBe(20_000);
    expect(openWould[0]?.pressure.nextRequestPressureTokens).toBe(370_000);
    expect(openWould[0]?.pressure.estimateDomain).toBe("source_labelled_estimate");
  });

  it("post_measurement_estimate mode add accumulates; set replaces; new sampling resets", () => {
    const resolved = armed(true);
    const afterSampling = applyGovernorLifecycleBatch(
      createGovernorRuntimeState({
        captureGeneration: 1,
      }),
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: { input_tokens: 100_000 },
        },
        {
          kind: "post_measurement_estimate",
          tokens: 1_000,
          source: "provider_reported_output_tokens",
          mode: "set",
        },
        {
          kind: "post_measurement_estimate",
          tokens: 500,
          source: "host_canonical_payload_byte_estimate",
          mode: "add",
        },
        {
          kind: "post_measurement_estimate",
          tokens: 250,
          source: "host_canonical_payload_byte_estimate",
          mode: "add",
        },
      ],
      resolved,
    );
    expect(afterSampling.state.postMeasurementEstimate.tokens).toBe(1_750);
    expect(afterSampling.state.postMeasurementEstimate.source).toBe(
      "provider_output_plus_host_canonical_payload_byte_estimate",
    );

    const afterSet = applyGovernorLifecycleBatch(
      afterSampling.state,
      [
        {
          kind: "post_measurement_estimate",
          tokens: 42,
          source: "host_canonical_payload_byte_estimate",
          mode: "set",
        },
      ],
      resolved,
    );
    expect(afterSet.state.postMeasurementEstimate.tokens).toBe(42);

    const afterNewSampling = applyGovernorLifecycleBatch(
      afterSet.state,
      [
        {
          kind: "sampling_observed",
          samplingId: "m2",
          providerUsage: { input_tokens: 110_000 },
        },
      ],
      resolved,
    );
    expect(afterNewSampling.state.postMeasurementEstimate.tokens).toBe(0);
  });

  it("settled seam after estimate: one would_compact with wouldMutate true", () => {
    const state = createGovernorRuntimeState({
      captureGeneration: 1,
    });
    const resolved = armed(true);
    const r = applyGovernorLifecycleBatch(
      state,
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: { input_tokens: 350_000 },
        },
        {
          kind: "post_measurement_estimate",
          tokens: 20_000,
          source: "host_byte_estimate",
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      resolved,
    );
    const settled = r.observes.filter((o) => o.observePhase === "settled_seam");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.decision).toBe("would_compact");
    expect(settled[0]?.wouldMutate).toBe(true);
    expect(settled[0]?.pressure.nextRequestPressureTokens).toBe(370_000);
    // Provider total never includes estimate.
    expect(settled[0]?.providerContextTotal).toBe(350_000);
  });

  it("input typed during the turn does not suppress the settled decision", () => {
    let state = createGovernorRuntimeState({
      captureGeneration: 1,
    });
    const resolved = armed(true);
    state = applyGovernorLifecycleBatch(state, [{ kind: "turn_opened", reason: "user_prompt" }], resolved).state;
    state = noteGovernorInput(state);
    const r = applyGovernorLifecycleBatch(
      state,
      [
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: { input_tokens: 600_000 },
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      resolved,
    );
    const settled = r.observes.filter((o) => o.observePhase === "settled_seam")[0];
    expect(settled?.decision).toBe("would_compact");
    expect(settled?.wouldMutate).toBe(true);
    // Kept as a receipt diagnostic, stripped of authority.
    expect(settled?.inputEpoch).toBe(1);
    expect(settled?.inputEpochAtTurnOpen).toBe(0);
  });

  it("a degraded capture generation does not suppress the settled decision", () => {
    const state = createGovernorRuntimeState({
      captureGeneration: 2,
    });
    const r = applyGovernorLifecycleBatch(
      state,
      [
        { kind: "capture_degraded", reason: "file_shrink", generation: 3 },
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: { input_tokens: 600_000 },
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      armed(true),
    );
    const settled = r.observes.filter((o) => o.observePhase === "settled_seam")[0];
    expect(settled?.decision).toBe("would_compact");
    expect(settled?.wouldMutate).toBe(true);
    expect(settled?.captureGeneration).toBe(3);
  });

  it("native compact observed leaves no sticky state: the settled seam still arms compaction (R8)", () => {
    const r = applyGovernorLifecycleBatch(
      createGovernorRuntimeState({}),
      [
        { kind: "native_compact_observed", summaryPreview: "..." },
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: { input_tokens: 600_000 },
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      armed(true),
    );
    const settled = r.observes.filter((o) => o.observePhase === "settled_seam")[0]!;
    expect(settled.decision).toBe("would_compact");
    expect(settled.wouldMutate).toBe(true);
  });

  it("a default policy at pressure sets wouldMutate — there is no observe-only mode", () => {
    const r = applyGovernorLifecycleBatch(
      createGovernorRuntimeState({}),
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: { input_tokens: 600_000 },
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      armed(true),
    );
    const settled = r.observes.filter((o) => o.observePhase === "settled_seam")[0];
    expect(settled?.decision).toBe("would_compact");
    expect(settled?.wouldMutate).toBe(true);
  });

  it("policy_disabled when autoCompact off still observes", () => {
    const state = createGovernorRuntimeState({});
    const r = applyGovernorLifecycleBatch(
      state,
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: { input_tokens: 600_000 },
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      armed(false),
    );
    expect(r.observes.filter((o) => o.observePhase === "settled_seam")[0]?.decision).toBe("policy_disabled");
  });

  it("setGovernorPostMeasurementEstimate is pure state update", () => {
    const state = createGovernorRuntimeState();
    const next = setGovernorPostMeasurementEstimate(state, {
      tokens: 12,
      source: "lhc_token_estimate",
      domain: "source_labelled_estimate",
    });
    expect(next.postMeasurementEstimate.tokens).toBe(12);
    expect(state.postMeasurementEstimate.tokens).toBe(0);
  });

  it("split sampling lines: only final usage drives pressure; one settle → one settled observe", () => {
    const state = createGovernorRuntimeState({
      captureGeneration: 1,
    });
    const resolved = armed(true);
    const r = applyGovernorLifecycleBatch(
      state,
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: { input_tokens: 10 },
        },
        { kind: "turn_settled", reason: "end_turn" },
      ],
      resolved,
    );
    const settled = r.observes.filter((o) => o.observePhase === "settled_seam");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.decision).toBe("below_threshold");
  });

  it("all-zero sampling retains provider and growth; failed mode=set 0 cannot reset", () => {
    const resolved = armed(true);
    resolved.policy = {
      ...resolved.policy,
      autoCompact: true,
      lowerBoundTokens: 100_000,
      upperBoundTokens: 200_000,
      minRunwayTokens: 50_000,
    };
    const afterValid = applyGovernorLifecycleBatch(
      createGovernorRuntimeState({ captureGeneration: 1 }),
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "req:prior",
          providerUsage: { input_tokens: 164_208, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        {
          kind: "post_measurement_estimate",
          tokens: 66_025,
          source: "user_prompt:js-tiktoken:o200k_base",
          mode: "add",
        },
      ],
      resolved,
    );
    expect(afterValid.state.latestProviderContext?.total).toBe(164_208);
    expect(afterValid.state.postMeasurementEstimate.tokens).toBe(66_025);

    const afterZero = applyGovernorLifecycleBatch(
      afterValid.state,
      [
        {
          kind: "sampling_observed",
          samplingId: "req:fail",
          providerUsage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
        },
        {
          kind: "post_measurement_estimate",
          tokens: 0,
          source: "provider_reported_output_tokens",
          mode: "set",
        },
        { kind: "turn_settled", reason: "other" },
      ],
      resolved,
    );
    expect(afterZero.state.latestProviderContext?.total).toBe(164_208);
    expect(afterZero.state.postMeasurementEstimate.tokens).toBe(66_025);
    const settled = afterZero.observes.filter((o) => o.observePhase === "settled_seam").at(-1);
    expect(settled?.pressure.nextRequestPressureTokens).toBe(230_233);
    expect(settled?.decision).toBe("would_compact");
  });
});
