// Epic 07 Story 0 — assignment config and defaults, ported to the component.
// The typed derivation enumeration is gone: partial assignments are accepted,
// per-derivation target ranges are accepted, guard defaults fill, and every
// inference derivation type resolves to a default provider lane, model, and
// prompt when the host supplies no overrides.
//
// The component resolves config at construction into the stored instance
// record (normalizeConfig → instances.config), so defaults, merges, and
// routing keys are read from that stored config — the frozen suite's
// sdk.config.compressionTargets and direct-callback log are replaced by this
// per-instance stored-config inspection.
//
// Two frozen cases are not ported. The aim-outside-[min,max] rejection matrix
// (compressionTargets.aimRatio / briefTargets.aimRatio) has no analog: the
// component validates ratio positivity and max>=min but does not reject an aim
// outside the range (see report). The resolveGuards() unit is not a client
// export; its defaults are asserted here through the stored instance config.
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";
import { initLhc, type LhcExecutor, type ModelAssignment } from "../src/client/index.js";
import { dummyModelCall, executor, modules } from "./fixtures/index.js";

const dummyExecutor: LhcExecutor = {
  runQuery: () => Promise.reject(new Error("executor must not be called during construction")),
  runMutation: () => Promise.reject(new Error("executor must not be called during construction")),
  runAction: () => Promise.reject(new Error("executor must not be called during construction")),
} as unknown as LhcExecutor;

function construct(assignments: Record<string, ModelAssignment>): () => unknown {
  return () =>
    initLhc(api, dummyExecutor, {
      componentInstanceId: "assignment-config",
      mode: "manual",
      inference: { call: dummyModelCall, assignments },
    });
}

let instanceCounter = 0;

// Construct a real instance with the given raw config and return the config the
// component stored for it (normalizeConfig output), so resolved defaults,
// merges, and routing keys are observable.
async function storedConfig(config: {
  assignments?: Record<string, ModelAssignment>;
  guards?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  instanceCounter += 1;
  const instance = `assignment-config-${instanceCounter}`;
  const test = convexTest(schema, modules);
  const sdk = initLhc(api, executor(test), {
    componentInstanceId: instance,
    mode: "manual",
    inference: { call: dummyModelCall, assignments: config.assignments ?? {} },
    ...(config.guards === undefined ? {} : { guards: config.guards as never }),
  });
  const created = await sdk.threads.newThread({ filePath: "cfg-thread" });
  if (!created.ok) throw new Error(created.error.reason);
  return await test.run(async (ctx) => {
    const rows = await ctx.db.query("instances").collect();
    const row = rows.find((item) => item.instance === instance);
    if (row === undefined) throw new Error("instance config was not stored");
    return row.config as Record<string, unknown>;
  });
}

describe("TC-0.3b / TC-6.3a: partial assignments accepted (AC-0.3, AC-6.3)", () => {
  it("constructs with only inference assignments — no deterministic entries required", () => {
    const assignments: Record<string, ModelAssignment> = {
      smoothed_prompt: { provider: "p", model: "m", prompt: "smoothing-v1" },
      tool_result_summary: { provider: "p", model: "m", prompt: "tool-result-v1" },
      detailed_turn_compression: { provider: "p", model: "m", prompt: "detailed-turn-compression-v1" },
      chunk_summary_brief: { provider: "p", model: "m", prompt: "chunk-brief-v2" },
    };
    expect(construct(assignments)).not.toThrow();
  });

  it("constructs when only one inference type is assigned", () => {
    const assignments: Record<string, ModelAssignment> = {
      smoothed_prompt: { provider: "p", model: "m", prompt: "smoothing-v1" },
    };
    expect(construct(assignments)).not.toThrow();
  });
});

describe("TC-6.1a: per-derivation target ranges accepted (AC-6.1)", () => {
  it("detailed_turn_compression and chunk_summary_brief accept target ratios without error", () => {
    const assignments: Record<string, ModelAssignment> = {
      smoothed_prompt: { provider: "p", model: "m", prompt: "smoothing-v1" },
      tool_result_summary: { provider: "p", model: "m", prompt: "tool-result-v1" },
      detailed_turn_compression: {
        provider: "p",
        model: "m",
        prompt: "detailed-turn-compression-v1",
        targetMinRatio: 0.35,
        targetAimRatio: 0.5,
        targetMaxRatio: 0.65,
      },
      chunk_summary_brief: {
        provider: "p",
        model: "m",
        prompt: "chunk-brief-v2",
        targetMinRatio: 0.08,
        targetAimRatio: 0.12,
        targetMaxRatio: 0.2,
      },
    };
    expect(construct(assignments)).not.toThrow();
  });
});

describe("TC-6.2a: missing guard config fills defaults (AC-6.2)", () => {
  it("a construction with no guards stores the documented guard defaults", async () => {
    const config = await storedConfig({});
    expect(config["guards"]).toMatchObject({
      smoothedPrompt: { maxInferenceTokens: 700, suspiciousOutputRatio: 0.15 },
      detailedTurnCompression: { tinyTurnTokens: 80 },
      toolResultSummary: { timeoutMs: 60_000 },
    });
  });

  it("explicit guards override per-field while unset fields keep defaults", async () => {
    const config = await storedConfig({ guards: { smoothedPrompt: { maxInferenceTokens: 500 } } });
    expect(config["guards"]).toMatchObject({
      smoothedPrompt: { maxInferenceTokens: 500, suspiciousOutputRatio: 0.15 },
      detailedTurnCompression: { tinyTurnTokens: 80 },
    });
  });

  it("construction with no guards succeeds", () => {
    expect(construct({ smoothed_prompt: { provider: "p", model: "m", prompt: "smoothing-v1" } })).not.toThrow();
  });
});

describe("TC-6.4a: inference types resolve to a default provider lane and model (AC-6.4)", () => {
  it("with no overrides, every inference type resolves to the codex / gpt-5.4-mini lane with thinking none", async () => {
    const config = await storedConfig({});
    const assignments = config["assignments"] as Record<string, ModelAssignment>;
    const expectedPrompts: Record<string, string> = {
      smoothed_prompt: "smoothing-v1",
      tool_result_summary: "tool-result-v2",
      detailed_turn_compression: "detailed-turn-compression-v3",
      chunk_summary_brief: "chunk-brief-v3",
    };
    for (const [kind, prompt] of Object.entries(expectedPrompts)) {
      expect(assignments[kind]).toMatchObject({
        provider: "codex",
        model: "gpt-5.4-mini",
        prompt,
        thinking: "none",
      });
    }
  });
});

describe("partial assignment overrides merge defaults", () => {
  it("preserves thinking none when override omits thinking", async () => {
    const config = await storedConfig({
      assignments: { smoothed_prompt: { provider: "custom", model: "custom-model", prompt: "smoothing-v1" } },
    });
    const assignments = config["assignments"] as Record<string, ModelAssignment>;
    expect(assignments["smoothed_prompt"]).toMatchObject({
      provider: "custom",
      model: "custom-model",
      thinking: "none",
    });
  });

  it("preserves detailed_turn_compression target ratios when override omits them", async () => {
    const config = await storedConfig({
      assignments: {
        detailed_turn_compression: { provider: "p", model: "m", prompt: "detailed-turn-compression-v1" },
      },
    });
    const assignments = config["assignments"] as Record<string, ModelAssignment>;
    expect(assignments["detailed_turn_compression"]).toMatchObject({
      targetMinRatio: 0.35,
      targetAimRatio: 0.5,
      targetMaxRatio: 0.65,
    });
  });

  it("allows explicit thinking override", async () => {
    const config = await storedConfig({
      assignments: {
        smoothed_prompt: { provider: "custom", model: "custom-model", prompt: "smoothing-v1", thinking: "high" },
      },
    });
    const assignments = config["assignments"] as Record<string, ModelAssignment>;
    expect(assignments["smoothed_prompt"]).toMatchObject({ thinking: "high" });
  });
});
