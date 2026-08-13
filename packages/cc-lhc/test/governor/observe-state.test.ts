import { describe, expect, it } from "vitest";

import { BUILTIN_CONTEXT_POLICY } from "../../src/governor/config.js";
import {
  applyGovernorLifecycleBatch,
  createGovernorRuntimeState,
  noteGovernorInput,
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
    let state = createGovernorRuntimeState({
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
    expect(first.observes).toHaveLength(1);
    expect(first.observes[0]?.decision).toBe("would_compact");
    expect(first.observes[0]?.providerContextTotal).toBe(510_000);
    expect(first.observes[0]?.wouldMutate).toBe(true);

    // Replay the same settle sequence number via a second settle without new open
    // — fold increments settleSequence; second settle is a new sequence but
    // retry-growth should suppress immediate re-fire.
    const second = applyGovernorLifecycleBatch(
      first.state,
      [{ kind: "turn_settled", reason: "end_turn" }],
      resolved,
    );
    expect(second.observes).toHaveLength(1);
    expect(second.observes[0]?.decision).toBe("retry_growth_guard");
  });

  it("split sampling lines: only final usage drives pressure; one settle → one observe", () => {
    let state = createGovernorRuntimeState({
      captureHealthy: true,
      captureGeneration: 1,
      descriptorReady: true,
    });
    const resolved = armed(true);
    // Model-only then usage-complete (deduped at adapter; we only see final).
    const r = applyGovernorLifecycleBatch(
      state,
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "m1",
          providerUsage: { input_tokens: 10 },
        },
        // Later complete usage replaces (noteSampling prefers later in adapter;
        // here we emit only the completed fact once with final usage).
        { kind: "turn_settled", reason: "end_turn" },
      ],
      resolved,
    );
    expect(r.observes).toHaveLength(1);
    // 10 << upper → below_threshold
    expect(r.observes[0]?.decision).toBe("below_threshold");
  });

  it("uses only the latest completed sampling as provider authority", () => {
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
    expect(missing.observes[0]?.decision).toBe("no_provider_usage");
    expect(missing.observes[0]?.providerContextTotal).toBeNull();

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
    expect(invalid.observes[0]?.decision).toBe("no_provider_usage");
    expect(invalid.observes[0]?.providerContextTotal).toBeNull();

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
    expect(replaced.observes[0]?.decision).toBe("below_threshold");
    expect(replaced.observes[0]?.providerContextTotal).toBe(100_000);
  });

  it("input epoch change during turn suppresses would_compact", () => {
    let state = createGovernorRuntimeState({
      captureHealthy: true,
      captureGeneration: 1,
      descriptorReady: true,
    });
    const resolved = armed(true);
    state = applyGovernorLifecycleBatch(
      state,
      [{ kind: "turn_opened", reason: "user_prompt" }],
      resolved,
    ).state;
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
    expect(r.observes[0]?.decision).toBe("input_epoch_changed");
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
    expect(r.observes[0]?.decision).toBe("capture_degraded");
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
    expect(r.observes[0]?.decision).toBe("descriptor_not_ready");
  });

  it("native compact attention suppresses", () => {
    let state = createGovernorRuntimeState({
      captureHealthy: true,
      descriptorReady: true,
    });
    const r = applyGovernorLifecycleBatch(
      state,
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
    expect(r.observes[0]?.decision).toBe("native_summary_attention");
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
      expect(o.decision).toBe("would_compact");
      expect(o.wouldMutate).toBe(false);
      expect(o.observeOnly).toBe(true);
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
    expect(r.observes[0]?.decision).toBe("policy_disabled");
  });
});
