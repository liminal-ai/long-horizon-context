// The construction matrix, ported to the component's serializable config
// boundary. Every assignment mistake dies in the Lhc constructor's
// validateConfig before any thread exists: unknown kind keys, unknown prompt
// names, and empty provider/model strings each throw a TypeError naming the
// violated rule. A complete valid config does not merely construct — a seeded
// drain lands a form ready with the fake host's canned text.
//
// The frozen inferenceCallbacks-XOR-inference cases are omitted: the component
// has no direct-callback surface. Every inference lane routes through the
// operator-supplied model-call handle, so the XOR contract has no analog here.
import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api.js";
import { initLhc, type LhcExecutor, type ModelAssignment } from "../src/client/index.js";
import { serviceFixture, validEvent } from "./fixtures/index.js";

const DUMMY_CALL = "test_model:call";

// Never reached: validateConfig throws in the constructor before any executor
// call. Present only so a valid config can be constructed off-fixture.
const dummyExecutor: LhcExecutor = {
  runQuery: () => Promise.reject(new Error("executor must not be called during construction")),
  runMutation: () => Promise.reject(new Error("executor must not be called during construction")),
  runAction: () => Promise.reject(new Error("executor must not be called during construction")),
} as unknown as LhcExecutor;

function validAssignments(
  overrides: Partial<Record<string, Partial<ModelAssignment>>> = {},
): Record<string, ModelAssignment> {
  const base: Record<string, ModelAssignment> = {
    smoothed_prompt: { provider: "prov-a", model: "model-a", prompt: "smoothing-v1" },
    tool_result_summary: { provider: "prov-b", model: "model-b", prompt: "tool-result-v2" },
    detailed_turn_compression: { provider: "prov-c", model: "model-c", prompt: "detailed-turn-compression-v3" },
    chunk_summary_brief: { provider: "prov-d", model: "model-d", prompt: "chunk-brief-v3" },
  };
  for (const [kind, override] of Object.entries(overrides)) {
    base[kind] = { ...(base[kind] ?? ({} as ModelAssignment)), ...override } as ModelAssignment;
  }
  return base;
}

function buildSdk(assignments: unknown): () => unknown {
  return () =>
    initLhc(api, dummyExecutor, {
      componentInstanceId: "construction-test",
      mode: "manual",
      inference: { call: DUMMY_CALL, assignments },
    } as never);
}

describe("assignment validation (AC-1.3, AC-6.1)", () => {
  test("an unknown kind key in assignments is a TypeError naming it", () => {
    const assignments: Record<string, ModelAssignment> = { ...validAssignments() };
    assignments["smoothed_promptz"] = { provider: "prov-x", model: "model-x", prompt: "smoothing-v1" };
    const make = buildSdk(assignments);
    expect(make).toThrow(TypeError);
    expect(make).toThrow(/unknown derivation type "smoothed_promptz"/);
  });

  test("an unknown prompt name on an inference assignment is a TypeError naming kind and prompt", () => {
    const assignments = validAssignments({ tool_result_summary: { prompt: "tool-result-v99" } });
    const make = buildSdk(assignments);
    expect(make).toThrow(TypeError);
    expect(make).toThrow(/tool_result_summary/);
    expect(make).toThrow(/unknown template "tool-result-v99"/);
  });

  test("an empty provider string on an inference assignment is a TypeError naming field and kind", () => {
    const assignments = validAssignments({ smoothed_prompt: { provider: "" } });
    const make = buildSdk(assignments);
    expect(make).toThrow(TypeError);
    expect(make).toThrow(/smoothed_prompt\.provider must be a non-empty string/);
  });

  test("an empty model string on an inference assignment is a TypeError naming field and kind", () => {
    const assignments = validAssignments({ chunk_summary_brief: { model: "  " } });
    const make = buildSdk(assignments);
    expect(make).toThrow(TypeError);
    expect(make).toThrow(/chunk_summary_brief\.model must be a non-empty string/);
  });
});

describe("a complete valid config operates (AC-1.1, AC-1.3)", () => {
  test("constructs, and a seeded drain lands a form ready with the host's text", async () => {
    const fixture = serviceFixture();
    const { filePath } = await fixture.createThread();
    const batch = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "construct me a context" } }),
      validEvent("assistant_text", { payload: { text: "constructing" } }),
      validEvent("turn_end"),
    ]);
    expect(batch.ok).toBe(true);

    const drained = await fixture.sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.value.remaining).toBe(0);
    expect(drained.value.completed).toBeGreaterThan(0);

    const report = await fixture.sdk.messages.report({ filePath }, { messageId: "m1" });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const smoothed = report.value.find((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("ready");
    expect(smoothed?.content).toBe("canned smoothed_prompt text from the fake host");
  });
});
