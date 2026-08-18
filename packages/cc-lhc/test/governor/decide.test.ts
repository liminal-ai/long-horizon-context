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
    turnOpen: false,
    providerContext: {
      inputTokens: BUILTIN_CONTEXT_POLICY.upperBoundTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      total: BUILTIN_CONTEXT_POLICY.upperBoundTokens,
    },
    providerContextFreshness: "current_sampling",
    postMeasurementEstimate: { ...EMPTY_POST_MEASUREMENT_ESTIMATE },
    operationInFlight: false,
    nativeSummaryAttention: false,
    ...over,
  };
}

describe("decideGovernor", () => {
  it("would_compact at exact upper on a default policy", () => {
    const d = decideGovernor(baseInput());
    expect(d.kind).toBe("would_compact");
    expect(d.wouldMutate).toBe(true);
    expect(d.pressure.nextRequestPressureTokens).toBe(BUILTIN_CONTEXT_POLICY.upperBoundTokens);
    expect(d.pressure.estimateDomain).toBe("source_labelled_estimate");
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

  it("compacts on the last known provider reading when the current sampling is missing", () => {
    const d = decideGovernor(
      baseInput({
        providerContext: {
          inputTokens: 900_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          total: 900_000,
        },
        providerContextFreshness: "last_known",
        postMeasurementEstimate: { tokens: 4_000, source: "lhc_token_estimate", domain: "source_labelled_estimate" },
      }),
    );
    expect(d.kind).toBe("would_compact");
    expect(d.wouldMutate).toBe(true);
    expect(d.pressure.nextRequestPressureTokens).toBe(904_000);
  });

  it("labels a carried-forward reading as last_known rather than a fresh provider fact", () => {
    const d = decideGovernor(baseInput({ providerContextFreshness: "last_known" }));
    expect(d.pressure.providerBaseFreshness).toBe("last_known");
    expect(d.pressure.providerBaseDomain).toBe("provider_reported_input");
    expect(d.reason).toContain("last known provider");
  });

  it("with no provider reading at all, pressure is the labelled estimate alone", () => {
    const d = decideGovernor(
      baseInput({
        providerContext: null,
        providerContextFreshness: "none",
        postMeasurementEstimate: { tokens: 12, source: "lhc_token_estimate", domain: "source_labelled_estimate" },
      }),
    );
    expect(d.kind).toBe("below_threshold");
    expect(d.pressure.providerBaseTokens).toBeNull();
    expect(d.pressure.providerBaseFreshness).toBe("none");
    expect(d.pressure.nextRequestPressureTokens).toBe(12);
  });

  it("an estimate alone can still reach the trigger", () => {
    const d = decideGovernor(
      baseInput({
        providerContext: null,
        providerContextFreshness: "none",
        postMeasurementEstimate: {
          tokens: BUILTIN_CONTEXT_POLICY.upperBoundTokens,
          source: "lhc_token_estimate",
          domain: "source_labelled_estimate",
        },
      }),
    );
    expect(d.kind).toBe("would_compact");
    expect(d.wouldMutate).toBe(true);
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

  it("operation_in_flight", () => {
    expect(decideGovernor(baseInput({ operationInFlight: true })).kind).toBe("operation_in_flight");
  });

  it("native_summary_attention", () => {
    expect(decideGovernor(baseInput({ nativeSummaryAttention: true })).kind).toBe("native_summary_attention");
  });

  it("policy_disabled only when the user turned autoCompact off", () => {
    const d = decideGovernor(
      baseInput({
        policy: { ...BUILTIN_CONTEXT_POLICY, autoCompact: false },
      }),
    );
    expect(d.kind).toBe("policy_disabled");
    expect(d.wouldMutate).toBe(false);
  });

  it("nothing but policy and pressure can suppress a settled compact", () => {
    // Every non-pressure input the decision still accepts, set to its most
    // pessimistic value at once. The gates this campaign removed — typed-ahead
    // input, degraded capture, an unready descriptor, an unwritten receipt,
    // insufficient retry growth — are no longer expressible here at all.
    const d = decideGovernor(
      baseInput({
        providerContext: {
          inputTokens: 950_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          total: 950_000,
        },
        providerContextFreshness: "last_known",
      }),
    );
    expect(d.kind).toBe("would_compact");
    expect(d.wouldMutate).toBe(true);
  });

  it("repeated settled seams at the same pressure keep producing an executable decision", () => {
    // No retry-growth toll: a deferral that never started a mutation costs the
    // next seam nothing.
    const at = baseInput({
      providerContext: {
        inputTokens: 400_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        total: 400_000,
      },
    });
    for (let seam = 0; seam < 3; seam += 1) {
      const d = decideGovernor(at);
      expect(d.kind).toBe("would_compact");
      expect(d.wouldMutate).toBe(true);
    }
  });
});
