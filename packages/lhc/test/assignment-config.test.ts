// Epic 07 Story 0 — assignment config and defaults (Flow 6 + AC-0.3).
// Covers the construction contract changes Story 0 installs: the typed
// derivation enumeration is gone (AC-0.3), partial assignments are accepted
// (deterministic types optional), per-derivation target ranges are accepted
// (AC-6.1), guard defaults fill (AC-6.2), and every inference derivation type
// resolves to a documented default provider lane and model when the host
// supplies no overrides (AC-6.4).
import { describe, expect, it } from "vitest";
import { initLhc, type Lhc, type ModelAssignment } from "../src/index.js";
import {
  DEFAULT_GUARDS,
  type ModelCall,
  type ModelCallInput,
  resolveGuards,
} from "../src/shared-tech/inference-types.js";

// A ModelCall that records every input and resolves to a minimal success, so
// the default provider/model routing keys are observable from the log alone
// (TC-6.4a) without depending on the per-kind canned-text fixture.
function recordingCall(): { call: ModelCall; log: ModelCallInput[] } {
  const log: ModelCallInput[] = [];
  const call: ModelCall = (input) => {
    log.push(structuredClone(input));
    return Promise.resolve({ ok: true, text: "ok" });
  };
  return { call, log };
}

// The four inference derivation types and the minimal input each callback
// operation accepts, so TC-6.4a can drive every default-routed lane.
const INFERENCE_OPS: Array<{ kind: string; run: (p: Lhc) => Promise<unknown> }> = [
  { kind: "smoothed_prompt", run: (p) => p.config.inferenceCallbacks.smoothPrompt({ text: "x" }) },
  {
    kind: "tool_result_summary",
    run: (p) =>
      p.config.inferenceCallbacks.summarizeToolResult({ toolName: "read", content: "c", outcome: "succeeded" }),
  },
  {
    kind: "detailed_turn_compression",
    run: (p) =>
      p.config.inferenceCallbacks.compressDetailedTurn({
        dialogueText: "r",
        inputTokens: 10,
        targetMinTokens: 4,
        targetAimTokens: 5,
        targetMaxTokens: 7,
      }),
  },
  {
    kind: "chunk_summary_brief",
    run: (p) =>
      p.config.inferenceCallbacks.summarizeChunkBrief({
        text: "m",
        inputTokens: 10,
        targetMinTokens: 1,
        targetAimTokens: 2,
        targetMaxTokens: 3,
      }),
  },
];

describe("TC-0.3b / TC-6.3a: partial assignments accepted (AC-0.3, AC-6.3)", () => {
  it("constructs with only inference assignments — no deterministic entries required", () => {
    const assignments: Record<string, ModelAssignment> = {
      smoothed_prompt: { provider: "p", model: "m", prompt: "smoothing-v1" },
      tool_result_summary: { provider: "p", model: "m", prompt: "tool-result-v1" },
      detailed_turn_compression: { provider: "p", model: "m", prompt: "detailed-turn-compression-v1" },
      chunk_summary_brief: { provider: "p", model: "m", prompt: "chunk-brief-v2" },
    };
    expect(() => initLhc({ mode: "manual", inference: { call: recordingCall().call, assignments } })).not.toThrow();
  });

  it("constructs when deterministic types (turn_rendering, chunk_summary_detailed) are absent", () => {
    // Same as above but explicit about the deterministic omission: a config
    // that carries only the four inference types is a valid production config.
    const { call } = recordingCall();
    const sdk = initLhc({
      mode: "manual",
      inference: {
        call,
        assignments: {
          smoothed_prompt: { provider: "p", model: "m", prompt: "smoothing-v1" },
        },
      },
    });
    expect(sdk).toBeDefined();
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
    expect(() => initLhc({ mode: "manual", inference: { call: recordingCall().call, assignments } })).not.toThrow();
  });

  it("rejects detailed_turn_compression target aim outside min/max", () => {
    const assignments: Record<string, ModelAssignment> = {
      detailed_turn_compression: {
        provider: "p",
        model: "m",
        prompt: "detailed-turn-compression-v1",
        targetMinRatio: 0.35,
        targetAimRatio: 0.8,
        targetMaxRatio: 0.65,
      },
    };
    expect(() => initLhc({ mode: "manual", inference: { call: recordingCall().call, assignments } })).toThrow(
      /compressionTargets\.aimRatio must be between minRatio and maxRatio/,
    );
  });

  it("rejects chunk_summary_brief target aim outside min/max", () => {
    const assignments: Record<string, ModelAssignment> = {
      chunk_summary_brief: {
        provider: "p",
        model: "m",
        prompt: "chunk-brief-v2",
        targetMinRatio: 0.08,
        targetAimRatio: 0.3,
        targetMaxRatio: 0.2,
      },
    };
    expect(() => initLhc({ mode: "manual", inference: { call: recordingCall().call, assignments } })).toThrow(
      /briefTargets\.aimRatio must be between minRatio and maxRatio/,
    );
  });
});

describe("TC-6.2a: missing guard config fills defaults (AC-6.2)", () => {
  it("resolveGuards with no input returns the documented defaults", () => {
    const guards = resolveGuards();
    expect(guards).toEqual(DEFAULT_GUARDS);
    expect(guards.smoothedPrompt?.maxInferenceTokens).toBe(700);
    expect(guards.smoothedPrompt?.suspiciousOutputRatio).toBe(0.15);
    expect(guards.detailedTurnCompression?.tinyTurnTokens).toBe(80);
    expect(guards.toolResultSummary?.timeoutMs).toBe(60_000);
  });

  it("explicit guards override per-field while unset fields keep defaults", () => {
    const guards = resolveGuards({ smoothedPrompt: { maxInferenceTokens: 500 } });
    expect(guards.smoothedPrompt?.maxInferenceTokens).toBe(500);
    expect(guards.smoothedPrompt?.suspiciousOutputRatio).toBe(0.15);
    expect(guards.detailedTurnCompression?.tinyTurnTokens).toBe(80);
  });

  it("construction with no guards succeeds (defaults applied at construction)", () => {
    const { call } = recordingCall();
    expect(() =>
      initLhc({
        mode: "manual",
        inference: {
          call,
          assignments: {
            smoothed_prompt: { provider: "p", model: "m", prompt: "smoothing-v1" },
          },
        },
      }),
    ).not.toThrow();
  });
});

describe("TC-6.4a: inference types resolve to a default provider lane and model (AC-6.4)", () => {
  it("with no explicit overrides, every inference op routes to the default codex / gpt-5.4-mini lane with thinking none", async () => {
    const { call, log } = recordingCall();
    const sdk = initLhc({ mode: "manual", inference: { call } });
    for (const op of INFERENCE_OPS) {
      await op.run(sdk);
    }
    expect(log.length).toBe(INFERENCE_OPS.length);
    for (const entry of log) {
      expect(entry.provider).toBe("codex");
      expect(entry.model).toBe("gpt-5.4-mini");
      expect(entry.thinking).toBe("none");
    }
  });
});

describe("partial assignment overrides merge defaults", () => {
  it("preserves thinking none when override omits thinking", async () => {
    const { call, log } = recordingCall();
    const sdk = initLhc({
      mode: "manual",
      inference: {
        call,
        assignments: {
          smoothed_prompt: { provider: "custom", model: "custom-model", prompt: "smoothing-v1" },
        },
      },
    });
    await sdk.config.inferenceCallbacks.smoothPrompt({ text: "x" });
    expect(log[0]?.thinking).toBe("none");
  });

  it("preserves detailed_turn_compression target ratios when override omits them", () => {
    const sdk = initLhc({
      mode: "manual",
      inference: {
        call: recordingCall().call,
        assignments: {
          detailed_turn_compression: { provider: "p", model: "m", prompt: "detailed-turn-compression-v1" },
        },
      },
    });
    expect(sdk.config.compressionTargets).toEqual({
      minRatio: 0.35,
      aimRatio: 0.5,
      maxRatio: 0.65,
    });
  });

  it("allows explicit thinking override", async () => {
    const { call, log } = recordingCall();
    const sdk = initLhc({
      mode: "manual",
      inference: {
        call,
        assignments: {
          smoothed_prompt: {
            provider: "custom",
            model: "custom-model",
            prompt: "smoothing-v1",
            thinking: "high",
          },
        },
      },
    });
    await sdk.config.inferenceCallbacks.smoothPrompt({ text: "x" });
    expect(log[0]?.thinking).toBe("high");
  });
});
