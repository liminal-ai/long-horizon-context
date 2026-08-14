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
  return { policy, sources, armed: true, errors: [] };
}

describe("governor observe-state fold", () => {
  it("emits one observe record per turn_settled; duplicate settle does not double-trigger", () => {
    const state = createGovernorRuntimeState({
      captureHealthy: true,
      captureGeneration: 1,
      descriptorReady: true,
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

    const second = applyGovernorLifecycleBatch(first.state, [{ kind: "turn_settled", reason: "end_turn" }], resolved);
    expect(second.observes).toHaveLength(1);
    expect(second.observes[0]?.decision).toBe("retry_growth_guard");
  });

  it("multiple model turns: only latest completed sampling is authoritative", () => {
    const state = createGovernorRuntimeState({
      captureHealthy: true,
      captureGeneration: 1,
      descriptorReady: true,
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
    expect(settledMissing[0]?.decision).toBe("no_provider_usage");
    expect(settledMissing[0]?.providerContextTotal).toBeNull();

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
    expect(invalid.observes.filter((o) => o.observePhase === "settled_seam")[0]?.decision).toBe("no_provider_usage");

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
      captureHealthy: true,
      captureGeneration: 1,
      descriptorReady: true,
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
      captureHealthy: true,
      captureGeneration: 1,
      descriptorReady: true,
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

  it("settled seam after estimate: one would_compact with wouldMutate true", () => {
    const state = createGovernorRuntimeState({
      captureHealthy: true,
      captureGeneration: 1,
      descriptorReady: true,
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

  it("input epoch change during turn suppresses would_compact", () => {
    let state = createGovernorRuntimeState({
      captureHealthy: true,
      captureGeneration: 1,
      descriptorReady: true,
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
    expect(r.observes.filter((o) => o.observePhase === "settled_seam")[0]?.decision).toBe("input_epoch_changed");
  });

  it("degraded capture suppresses", () => {
    const state = createGovernorRuntimeState({
      captureHealthy: false,
      captureGeneration: 2,
      descriptorReady: true,
    });
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
      armed(true),
    );
    expect(r.observes.filter((o) => o.observePhase === "settled_seam")[0]?.decision).toBe("capture_degraded");
  });

  it("descriptor not ready suppresses", () => {
    const state = createGovernorRuntimeState({
      captureHealthy: true,
      descriptorReady: false,
    });
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
      armed(true),
    );
    expect(r.observes.filter((o) => o.observePhase === "settled_seam")[0]?.decision).toBe("descriptor_not_ready");
  });

  it("native compact attention suppresses and does not race LHC writer", () => {
    const r = applyGovernorLifecycleBatch(
      createGovernorRuntimeState({
        captureHealthy: true,
        descriptorReady: true,
      }),
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
    expect(r.observes.filter((o) => o.observePhase === "settled_seam")[0]?.decision).toBe("native_summary_attention");
    expect(r.observes.every((o) => o.wouldMutate === false)).toBe(true);
  });

  it("observe mode never sets wouldMutate", () => {
    const observeOnlyPolicy = armed(true);
    observeOnlyPolicy.policy = { ...observeOnlyPolicy.policy, observeOnly: true };
    const state = createGovernorRuntimeState({
      captureHealthy: true,
      descriptorReady: true,
    });
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
      observeOnlyPolicy,
    );
    for (const o of r.observes) {
      if (o.decision === "would_compact") {
        expect(o.wouldMutate).toBe(false);
        expect(o.observeOnly).toBe(true);
      }
    }
  });

  it("policy_disabled when autoCompact off still observes", () => {
    const state = createGovernorRuntimeState({
      captureHealthy: true,
      descriptorReady: true,
    });
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
      captureHealthy: true,
      captureGeneration: 1,
      descriptorReady: true,
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
});
