// Verifier finding 01F-001: pre-v5 work_item rows carry payload NULL, so the
// drain's terminal paths must reconstruct their form targets from the F-02
// backfill's kind→form mapping — otherwise exhaustion deletes the work row
// and strands the backfilled derivation as pending forever. This suite
// drains a true Epic 01 legacy file (v4 schema, unversioned ids, no payload
// column values) through the production upgrade path and pins AC-1.9/DD-1
// for upgraded rows: terminal failure lands the form `failed` with the final
// reason and attempts before the row is deleted.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countLiveItems, initLhc, type Lhc } from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  legacyEpic01ThreadFile,
  openRaw,
  readDerivedForms,
  registerTestWorkHandlers,
  tempStore,
  type InferenceCallbacksDouble,
  type TempStore,
} from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

function manualSdk(double: InferenceCallbacksDouble): Lhc {
  const sdk = initLhc({
    inferenceCallbacks: double,
    mode: "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 200 },
  });
  registerTestWorkHandlers(sdk, double);
  return sdk;
}

function liveCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    return countLiveItems(db);
  } finally {
    db.close();
  }
}

describe("01F-001: terminal failure on pre-v5 queued rows lands the backfilled form failed, never stranded pending", () => {
  it("retry exhaustion on a legacy row marks its backfilled form failed with final reason and attempts, row deleted; the rest of the legacy queue still runs", async () => {
    const filePath = store.threadPath();
    legacyEpic01ThreadFile(filePath, "th_legacy_terminal");
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);

    double.failKind("prompt_smoothing", 99, {
      retryable: true,
      reason: "scripted legacy exhaustion (smoothPrompt)",
    });
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;

    // The legacy queue ran whole, unversioned ids and all: the smoothing
    // item exhausted its budget, the other two completed.
    expect(drained.value.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m1-prompt_smoothing", "failed_terminal"],
      ["w-m3-tool_result_summary", "done"],
      ["w-t1-turn_derivation", "done"],
    ]);
    expect(drained.value.ran[0]?.attempts).toBe(3);
    expect(drained.value.ran[0]?.reason).toBe("scripted legacy exhaustion (smoothPrompt)");

    // DD-1 for upgraded rows: the work rows are gone AND the backfilled
    // pending form was found by the terminal write — failed with the final
    // reason and attempts copied, not stranded pending.
    expect(liveCount(filePath)).toBe(0);
    const forms = readDerivedForms(filePath);
    const failed = forms.find((form) => form.subjectId === "m1" && form.derivationType === "smoothed_prompt");
    expect(failed?.state).toBe("failed");
    expect(failed?.reason).toBe("scripted legacy exhaustion (smoothPrompt)");
    expect(failed?.metadata?.attempts).toBe(3);
    expect(failed?.sourceVersion).toBe(1);
    // No form anywhere is left pending after the drain.
    expect(forms.map((form) => `${form.subjectId}/${form.derivationType}/${form.state}`).sort()).toEqual([
      "m1/smoothed_prompt/failed",
      "m3/tool_result_summary/ready",
      "t1/smooth_turn_compression/ready",
      "t1/turn_rendering/ready",
    ]);
  });

  it("a non-retryable failure on a legacy two-form item (turn_derivation) marks both backfilled forms failed", async () => {
    const filePath = store.threadPath();
    legacyEpic01ThreadFile(filePath, "th_legacy_blocked");
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);

    // Scripted on the handler's first inference callback operation (the double keys by
    // inference callback op / form-kind aliases, not the work kind).
    double.failKind("turn_rendering", 1, {
      retryable: false,
      reason: "scripted legacy refusal (composeTurnRendering)",
    });
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.value.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m1-prompt_smoothing", "done"],
      ["w-m3-tool_result_summary", "done"],
      ["w-t1-turn_derivation", "failed_terminal"],
    ]);

    expect(liveCount(filePath)).toBe(0);
    const forms = readDerivedForms(filePath);
    const turnForms = forms.filter((form) => form.subjectId === "t1");
    expect(turnForms.map((form) => form.state)).toEqual(["failed", "failed"]);
    for (const form of turnForms) {
      expect(form.reason).toBe("scripted legacy refusal (composeTurnRendering)");
      expect(form.metadata?.attempts).toBe(1);
    }
  });
});
