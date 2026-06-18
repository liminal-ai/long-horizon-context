// Epic 05 Story 2 — TC-1.1 (AC-1.1, AC-1.3): the construction matrix.
// Construction is where every config mistake dies: inferenceCallbacks XOR inference,
// all seven kinds present (parameterized over the exported DERIVATION_TYPES set so
// a new kind fails the matrix automatically), no unknown kind keys, every
// prompt name known, non-empty provider/model strings — each a TypeError
// naming the violated rule, with no partial construction. A complete valid
// config does not merely construct: a seeded drain lands a form ready.
import { afterEach, describe, expect, it } from "vitest";
import { initLhc, type ModelAssignment, type SdkConfig } from "../src/index.js";
import {
  cannedResponses,
  createInferenceCallbacksDouble,
  readDerivedForms,
  recordingCall,
  type TempStore,
  tempStore,
  validAssignments,
  validEvent,
} from "./fixtures/index.js";

const stores: TempStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.cleanup();
});

function freshStore(): TempStore {
  const store = tempStore();
  stores.push(store);
  return store;
}

function buildSdk(assignments: unknown): () => unknown {
  const { call } = recordingCall(cannedResponses());
  return () =>
    initLhc({
      mode: "manual",
      inference: { call, assignments },
    } as unknown as SdkConfig);
}

describe("TC-1.1: inferenceCallbacks XOR inference (AC-1.1)", () => {
  it("both inferenceCallbacks and inference is a TypeError naming the XOR rule", () => {
    const { call } = recordingCall(cannedResponses());
    const make = (): unknown =>
      initLhc({
        mode: "manual",
        inferenceCallbacks: createInferenceCallbacksDouble(),
        inference: { call, assignments: validAssignments() },
      });
    expect(make).toThrow(TypeError);
    expect(make).toThrow(/exactly one of inferenceCallbacks or inference/);
  });

  it("neither inferenceCallbacks nor inference is a TypeError naming the XOR rule", () => {
    const make = (): unknown => initLhc({ mode: "manual" } as unknown as SdkConfig);
    expect(make).toThrow(TypeError);
    expect(make).toThrow(/exactly one of inferenceCallbacks or inference/);
  });
});

describe("TC-1.1: assignment validation (AC-1.3, AC-6.1)", () => {
  it("an unknown kind key in assignments is a TypeError naming it", () => {
    const assignments: Record<string, ModelAssignment> = { ...validAssignments() };
    assignments["smoothed_promptz"] = {
      provider: "prov-x",
      model: "model-x",
      prompt: "smoothing-v1",
    };
    const make = buildSdk(assignments);
    expect(make).toThrow(TypeError);
    expect(make).toThrow(/unknown derivation type "smoothed_promptz"/);
  });

  it("an unknown prompt name on an inference assignment is a TypeError naming kind and prompt", () => {
    const assignments = validAssignments({
      tool_result_summary: { prompt: "tool-result-v99" },
    });
    const make = buildSdk(assignments);
    expect(make).toThrow(TypeError);
    expect(make).toThrow(/tool_result_summary/);
    expect(make).toThrow(/unknown template "tool-result-v99"/);
  });

  it("an empty provider string on an inference assignment is a TypeError naming field and kind", () => {
    const assignments = validAssignments({ smoothed_prompt: { provider: "" } });
    const make = buildSdk(assignments);
    expect(make).toThrow(TypeError);
    expect(make).toThrow(/smoothed_prompt\.provider must be a non-empty string/);
  });

  it("an empty model string on an inference assignment is a TypeError naming field and kind", () => {
    const assignments = validAssignments({ chunk_summary_brief: { model: "  " } });
    const make = buildSdk(assignments);
    expect(make).toThrow(TypeError);
    expect(make).toThrow(/chunk_summary_brief\.model must be a non-empty string/);
  });
});

describe("TC-1.1: a complete valid config operates (AC-1.1, AC-1.3)", () => {
  it("constructs, and a seeded drain lands a form ready with the host's text", async () => {
    const store = freshStore();
    const responses = cannedResponses();
    const { call, log } = recordingCall(responses);
    const sdk = initLhc({
      mode: "manual",
      inference: { call, assignments: validAssignments() },
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    });

    const filePath = store.threadPath();
    const created = await sdk.threads.newThread({
      filePath,
      registryPath: store.registryPath,
    });
    expect(created.ok).toBe(true);
    const batch = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "construct me a context" } }),
      validEvent("assistant_text", { payload: { text: "constructing" } }),
      validEvent("turn_end"),
    ]);
    expect(batch.ok).toBe(true);

    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    if (drained.ok) {
      expect(drained.value.stoppedBecause).toBe("empty");
      expect(drained.value.remaining).toBe(0);
    }

    const smoothed = readDerivedForms(filePath).find(
      (form) => form.derivationType === "smoothed_prompt" && form.subjectId === "m1",
    );
    expect(smoothed?.state).toBe("ready");
    expect(smoothed?.content).toBe(responses.smoothed_prompt);
    expect(log.length).toBeGreaterThan(0);
  });
});
