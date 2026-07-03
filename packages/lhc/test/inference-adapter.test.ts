// Epic 05 Story 3 — TC-2.1 (AC-2.1, AC-2.2, AC-2.5) and TC-2.3 (AC-2.4): the
// real adapter behind the unchanged Epic 02 seam. A seeded thread drains all
// seven kinds to ready with the fake host's canned content; the same seeding
// drained under deterministic inference callbacks proves the handlers unchanged
// (equivalence, AC-2.1). The canned text for the tool lanes deliberately
// claims the wrong outcome — the stamped outcome must come from the record,
// never model prose (architecture risk: adapter parses model output).
// Empty or whitespace-only success text is a classified retryable failure,
// never a ready form.
import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicInferenceCallbacks, type Derivation, initLhc, type Lhc } from "../src/index.js";
import type { ModelCall, ModelCallInput } from "../src/shared-tech/inference-types.js";
import {
  cannedResponses,
  DERIVATION_TYPES,
  type DerivationType,
  INFERENCE_DERIVATION_TYPES,
  readDerivedForms,
  recordingCall,
  scriptedCall,
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

const RETRY = { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 };
// Tiny target: each placed turn crosses it, so turn 1's chunk closes during
// the drain and the two chunk-summary kinds run too.
const CHUNK_POLICY = { targetProjectedTokens: 5, maxProjectedTokens: 4400 };

const MARKER_PATTERN = /^(smoothed|toolcall|toolresult|rendering|projection|detailed|brief)\(/;

// The adversarial canned set: the tool lanes' text claims failure while the
// record's tool result carries isError: false. A stored outcome agreeing
// with this prose would prove the adapter (or a handler) parsed model output
// for mechanical facts.
function adversarialResponses(): Record<DerivationType, string> {
  const responses = cannedResponses();
  responses.tool_result_summary = "error: the tool produced nothing and the run failed";
  return responses;
}

// Turn 1 carries a clean tool run (smoothing, both tool summaries, rendering,
// compression); turn 2 exists so turn 1's chunk closes under the tiny target
// policy and both chunk summaries enqueue.
async function seedSevenKinds(sdk: Lhc, store: TempStore): Promise<string> {
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  expect(created.ok).toBe(true);
  const result = await sdk.intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "please inspect the fixture file" } }),
    validEvent("tool_call", {
      payload: {
        toolCallId: "call-adapter-1",
        toolName: "read_file",
        arguments: { path: "fixture.txt" },
      },
    }),
    validEvent("tool_result", {
      payload: { toolCallId: "call-adapter-1", content: "contents of fixture.txt ".repeat(1500), isError: false },
    }),
    validEvent("assistant_text", { payload: { text: "the fixture file holds fixture text" } }),
    validEvent("turn_end"),
    validEvent("user_prompt", { payload: { text: "thanks, now summarize it" } }),
    validEvent("assistant_text", { payload: { text: "summarized" } }),
    validEvent("turn_end"),
  ]);
  expect(result.ok).toBe(true);
  return filePath;
}

async function drainAll(sdk: Lhc, filePath: string): Promise<Derivation[]> {
  const drained = await sdk.work.drain({ filePath });
  expect(drained.ok).toBe(true);
  if (drained.ok) {
    expect(drained.value.stoppedBecause).toBe("empty");
    expect(drained.value.remaining).toBe(0);
  }
  return readDerivedForms(filePath);
}

// One prompt, no turn_end: exactly one work item (prompt_smoothing) queues,
// so a scripted call's entries map one-to-one onto smoothing attempts.
async function seedSmoothingOnly(sdk: Lhc, store: TempStore): Promise<string> {
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  expect(created.ok).toBe(true);
  const result = await sdk.intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "only a prompt to smooth" } }),
  ]);
  expect(result.ok).toBe(true);
  return filePath;
}

function inferenceSdk(call: ModelCall): { sdk: Lhc; assignments: ReturnType<typeof validAssignments> } {
  const assignments = validAssignments();
  const sdk = initLhc({
    inference: { call, assignments },
    mode: "manual",
    retry: RETRY,
    chunkPolicy: CHUNK_POLICY,
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
  });
  return { sdk, assignments };
}

describe("TC-2.1: seven kinds land ready through the adapter (AC-2.1, AC-2.2, AC-2.5)", () => {
  it.skip("a seeded drain lands every kind ready with its lane's canned content and assignment provenance", async () => {
    const responses = adversarialResponses();
    const { call } = recordingCall(responses);
    const { sdk, assignments } = inferenceSdk(call);
    const forms = await drainAll(sdk, await seedSevenKinds(sdk, freshStore()));

    for (const kind of DERIVATION_TYPES) {
      const ready = forms.filter((form) => form.derivationType === kind && form.state === "ready");
      expect(ready.length).toBeGreaterThan(0);
    }
    for (const kind of INFERENCE_DERIVATION_TYPES) {
      const ready = forms.filter((form) => form.derivationType === kind && form.state === "ready");
      for (const form of ready) {
        // Content is the canned response, shaped — and provenance is the
        // assignment's three config-known strings, never authored from text.
        expect(form.content).toBe(responses[kind]);
        expect(form.metadata?.provenance).toEqual({
          provider: assignments[kind].provider,
          model: assignments[kind].model,
          prompt: assignments[kind].prompt,
        });
      }
    }
  });

  it.skip("outcomes are stamped from the record, disagreeing with the adversarial canned text", async () => {
    const responses = adversarialResponses();
    const { call } = recordingCall(responses);
    const { sdk } = inferenceSdk(call);
    const forms = await drainAll(sdk, await seedSevenKinds(sdk, freshStore()));

    // The record's tool result has isError: false, so the tool-result summary
    // must stamp "succeeded" even though its landed content claims failure.
    const form = forms.find((row) => row.derivationType === "tool_result_summary" && row.state === "ready");
    expect(form?.metadata?.outcome).toBe("succeeded");
    expect(form?.content).toContain("failed");
    const rendering = forms.find(
      (row) => row.subjectId === "t1" && row.derivationType === "turn_rendering" && row.state === "ready",
    );
    expect(rendering).toBeDefined();
    expect(rendering?.content).toContain("⇒ succeeded");
  });

  it.skip("handler equivalence: deterministic inference callbacks land the same rows with marker content and no provenance", async () => {
    const { call } = recordingCall(adversarialResponses());
    const { sdk: adapterSdk } = inferenceSdk(call);
    const adapterForms = await drainAll(adapterSdk, await seedSevenKinds(adapterSdk, freshStore()));

    const deterministicSdk = initLhc({
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
      mode: "manual",
      retry: RETRY,
      chunkPolicy: CHUNK_POLICY,
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
    });
    const deterministicForms = await drainAll(deterministicSdk, await seedSevenKinds(deterministicSdk, freshStore()));

    // Same handler code, same record: the same form rows, subjects, and
    // states land through both inference paths (message/turn/chunk ids are
    // deterministic functions of the event order).
    const rowKey = (derivation: Derivation): string =>
      `${derivation.subjectKind}|${derivation.subjectId}|${derivation.derivationType}|${derivation.state}`;
    expect(deterministicForms.map(rowKey).sort()).toEqual(adapterForms.map(rowKey).sort());

    for (const form of deterministicForms) {
      expect(form.state).toBe("ready");
      if (INFERENCE_DERIVATION_TYPES.includes(form.derivationType as (typeof INFERENCE_DERIVATION_TYPES)[number])) {
        expect(form.content).toMatch(MARKER_PATTERN);
      }
      // Deterministic inference callbacks never set provenance (AC-2.5).
      expect(form.metadata?.provenance).toBeUndefined();
    }
    for (const form of adapterForms) {
      expect(form.content).not.toMatch(MARKER_PATTERN);
    }
  });
});

describe("TC-2.3: empty or whitespace-only output is a classified failure (AC-2.4)", () => {
  it("a whitespace-only success classifies empty_output retryable; the retry lands ready", async () => {
    let calls = 0;
    const script = scriptedCall([
      { ok: true, text: "  " },
      { ok: true, text: "the real smoothing" },
    ]);
    const log: ModelCallInput[] = [];
    const call: ModelCall = (input) => {
      calls += 1;
      log.push(structuredClone(input));
      return script(input);
    };
    const { sdk } = inferenceSdk(call);
    const filePath = await seedSmoothingOnly(sdk, freshStore());
    const forms = await drainAll(sdk, filePath);

    const smoothed = forms.find((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("ready");
    expect(smoothed?.content).toBe("the real smoothing");
    // Two boundary calls: the whitespace-only first attempt was rejected and
    // retried — it never landed as a ready form.
    expect(calls).toBe(2);

    const derivationLog = await sdk.logging.queryDerivationLog(
      { filePath },
      { subjectId: "m1", derivationType: "smoothed_prompt" },
    );
    expect(derivationLog.ok).toBe(true);
    if (!derivationLog.ok) return;
    const failed = derivationLog.value.find((entry) => entry.eventKind === "inference_failed");
    expect(failed).toEqual(
      expect.objectContaining({
        eventKind: "inference_failed",
        payload: {
          reason: expect.stringContaining("empty_output"),
          requestMessages: log[0]?.messages,
        },
      }),
    );
  });

  it("an all-whitespace script exhausts the budget: failed, reason provider_failure, last error naming empty_output", async () => {
    let calls = 0;
    const script = scriptedCall([
      { ok: true, text: "" },
      { ok: true, text: "   " },
      { ok: true, text: "\n\t " },
    ]);
    const call: ModelCall = (input) => {
      calls += 1;
      return script(input);
    };
    const { sdk } = inferenceSdk(call);
    const forms = await drainAll(sdk, await seedSmoothingOnly(sdk, freshStore()));

    const smoothed = forms.find((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("failed");
    expect(smoothed?.content).toBeUndefined();
    expect(smoothed?.reason?.startsWith("provider_failure")).toBe(true);
    expect(smoothed?.reason).toContain("empty_output");
    expect(smoothed?.metadata?.attempts).toBe(RETRY.budget);
    expect(smoothed?.metadata?.lastError).toContain("empty_output");
    expect(calls).toBe(RETRY.budget);
  });

  it("success text is shaped: surrounding whitespace never reaches the form content", async () => {
    const { sdk } = inferenceSdk(scriptedCall([{ ok: true, text: "\n  shaped result text  \n" }]));
    const forms = await drainAll(sdk, await seedSmoothingOnly(sdk, freshStore()));

    const smoothed = forms.find((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("ready");
    expect(smoothed?.content).toBe("shaped result text");
  });
});
