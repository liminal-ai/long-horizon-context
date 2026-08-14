import { describe, expect, it } from "vitest";

import { BUILTIN_CONTEXT_POLICY } from "../../src/governor/config.js";
import { decideGovernor } from "../../src/governor/decide.js";
import type { ContextPolicy, GovernorInput } from "../../src/governor/types.js";
import { EMPTY_POST_MEASUREMENT_ESTIMATE } from "../../src/governor/types.js";

function baseInput(over: Partial<GovernorInput> = {}): GovernorInput {
  const policy: ContextPolicy = {
    ...BUILTIN_CONTEXT_POLICY,
    autoCompact: true,
  };
  return {
    policy,
    policyArmed: true,
    turnOpen: false,
    settleStale: false,
    providerContext: {
      inputTokens: BUILTIN_CONTEXT_POLICY.upperBoundTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      total: BUILTIN_CONTEXT_POLICY.upperBoundTokens,
    },
    postMeasurementEstimate: { ...EMPTY_POST_MEASUREMENT_ESTIMATE },
    captureHealthy: true,
    captureGeneration: 1,
    descriptorReady: true,
    operationInFlight: false,
    inputEpochAtTurnOpen: 0,
    currentInputEpoch: 0,
    nativeSummaryAttention: false,
    lastWouldCompactProviderTotal: null,
    lastWouldCompactCaptureGeneration: null,
    ...over,
  };
}

describe("decideGovernor", () => {
  it("would_compact at exact upper with all gates clear", () => {
    const d = decideGovernor(baseInput());
    expect(d.kind).toBe("would_compact");
    expect(d.wouldMutate).toBe(true);
    expect(d.pressure.nextRequestPressureTokens).toBe(BUILTIN_CONTEXT_POLICY.upperBoundTokens);
    expect(d.pressure.estimateDomain).toBe("source_labelled_estimate");
  });

  it("observeOnly keeps would_compact non-executable", () => {
    const d = decideGovernor(baseInput({ policy: { ...BUILTIN_CONTEXT_POLICY, observeOnly: true } }));
    expect(d.kind).toBe("would_compact");
    expect(d.wouldMutate).toBe(false);
  });

  it("below_threshold one below upper", () => {
    const d = decideGovernor(
      baseInput({
        providerContext: {
          inputTokens: BUILTIN_CONTEXT_POLICY.upperBoundTokens - 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          total: BUILTIN_CONTEXT_POLICY.upperBoundTokens - 1,
        },
      }),
    );
    expect(d.kind).toBe("below_threshold");
  });

  it("multicomponent cache usage counts toward pressure", () => {
    const d = decideGovernor(
      baseInput({
        providerContext: {
          inputTokens: 260_000,
          cacheCreationInputTokens: 50_000,
          cacheReadInputTokens: 50_000,
          total: BUILTIN_CONTEXT_POLICY.upperBoundTokens,
        },
      }),
    );
    expect(d.kind).toBe("would_compact");
    expect(d.providerContextTotal).toBe(360_000);
  });

  it("post-measurement estimate can cross the threshold without double-counting into provider total", () => {
    const d = decideGovernor(
      baseInput({
        providerContext: {
          inputTokens: 350_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          total: 350_000,
        },
        postMeasurementEstimate: {
          tokens: 20_000,
          source: "lhc_token_estimate",
          domain: "source_labelled_estimate",
        },
      }),
    );
    expect(d.kind).toBe("would_compact");
    expect(d.providerContextTotal).toBe(350_000);
    expect(d.pressure.providerBaseTokens).toBe(350_000);
    expect(d.pressure.estimateTokens).toBe(20_000);
    expect(d.pressure.nextRequestPressureTokens).toBe(370_000);
    expect(d.pressure.estimateDomain).toBe("source_labelled_estimate");
  });

  it("no_provider_usage", () => {
    expect(decideGovernor(baseInput({ providerContext: null })).kind).toBe("no_provider_usage");
    expect(decideGovernor(baseInput({ providerContext: null })).pressure.nextRequestPressureTokens).toBeNull();
  });

  it("turn_open when pressure is below threshold during open turn", () => {
    const d = decideGovernor(
      baseInput({
        turnOpen: true,
        providerContext: {
          inputTokens: 1_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          total: 1_000,
        },
      }),
    );
    expect(d.kind).toBe("turn_open");
    expect(d.wouldMutate).toBe(false);
  });

  it("classifies would_compact without mutation when threshold is crossed during open turn", () => {
    const d = decideGovernor(baseInput({ turnOpen: true }));
    expect(d.kind).toBe("would_compact");
    expect(d.wouldMutate).toBe(false);
    expect(d.reason).toMatch(/open turn|mid-agentic-turn/i);
  });

  it("settle_stale", () => {
    expect(decideGovernor(baseInput({ settleStale: true })).kind).toBe("settle_stale");
  });

  it("input_epoch_changed", () => {
    expect(decideGovernor(baseInput({ inputEpochAtTurnOpen: 1, currentInputEpoch: 2 })).kind).toBe(
      "input_epoch_changed",
    );
  });

  it("capture_degraded", () => {
    expect(decideGovernor(baseInput({ captureHealthy: false })).kind).toBe("capture_degraded");
  });

  it("descriptor_not_ready", () => {
    expect(decideGovernor(baseInput({ descriptorReady: false })).kind).toBe("descriptor_not_ready");
  });

  it("operation_in_flight", () => {
    expect(decideGovernor(baseInput({ operationInFlight: true })).kind).toBe("operation_in_flight");
  });

  it("native_summary_attention", () => {
    expect(decideGovernor(baseInput({ nativeSummaryAttention: true })).kind).toBe("native_summary_attention");
  });

  it("policy_disabled when autoCompact false", () => {
    const d = decideGovernor(
      baseInput({
        policy: { ...BUILTIN_CONTEXT_POLICY, autoCompact: false },
      }),
    );
    expect(d.kind).toBe("policy_disabled");
  });

  it("policy_invalid when not armed", () => {
    expect(decideGovernor(baseInput({ policyArmed: false })).kind).toBe("policy_invalid");
  });

  it("retry_growth_guard after would_compact without enough growth", () => {
    const d = decideGovernor(
      baseInput({
        lastWouldCompactProviderTotal: 500_000,
        lastWouldCompactCaptureGeneration: 1,
        captureGeneration: 1,
        providerContext: {
          inputTokens: 505_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          total: 505_000,
        },
        policy: { ...BUILTIN_CONTEXT_POLICY, autoCompact: true, retryGrowthTokens: 10_000 },
      }),
    );
    expect(d.kind).toBe("retry_growth_guard");
  });

  it("allows would_compact after sufficient growth", () => {
    const d = decideGovernor(
      baseInput({
        lastWouldCompactProviderTotal: 500_000,
        lastWouldCompactCaptureGeneration: 1,
        captureGeneration: 1,
        providerContext: {
          inputTokens: 520_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          total: 520_000,
        },
        policy: { ...BUILTIN_CONTEXT_POLICY, autoCompact: true, retryGrowthTokens: 10_000 },
      }),
    );
    expect(d.kind).toBe("would_compact");
  });
});
