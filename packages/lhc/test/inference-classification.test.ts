// Epic 05 Story 4 — TC-3.1 (AC-3.1, AC-3.2) and TC-3.2 (AC-3.2, AC-3.3):
// model-call failures classify through the fixed table into Epic 02's
// provider-result machinery, unchanged. The table is asserted directly as
// data; retryable kinds back off and retry within budget, exhaustion lands
// failed with the provider_failure-led reason and attempts/last-error in form
// metadata, terminal kinds land failed after exactly one call. safeCall
// contains thrown host exceptions (classified `other`) and races the
// adapter-owned timeout (classified `timeout`, DD-6) — no host function
// behavior can crash a drain. Reason format per the Story 3 ruling:
// retryable → `provider_failure: <kind>: <message>`, terminal → kind-led.
import { afterEach, describe, expect, it } from "vitest";
import { createSdk, type Derivation, type DrainReport, type Lhc } from "../src/index.js";
import { FAILURE_CLASSIFICATION, safeCall } from "../src/shared-tech/classify.js";
import type { ModelCall, ModelCallInput } from "../src/shared-tech/inference-types.js";
import {
  cannedResponses,
  FAKE_MODEL_PREFIX,
  DERIVATION_TYPES,
  hangingCall,
  readDerivedForms,
  recordingCall,
  scriptedCall,
  tempStore,
  throwingCall,
  validAssignments,
  validEvent,
  type TempStore,
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
// Tiny target (the adapter-suite pattern): each placed turn crosses it, so
// turn 1's chunk closes during the multi-kind drain and the two chunk-summary
// kinds run too.
const CHUNK_POLICY = { targetProjectedTokens: 5, maxProjectedTokens: 4400 };

const PROBE_INPUT: ModelCallInput = {
  provider: "prov-probe",
  model: "model-probe",
  messages: [{ role: "user", content: "probe" }],
};

function inferenceSdk(call: ModelCall, timeoutMs?: number): Lhc {
  return createSdk({
    inference: { call, assignments: validAssignments(), ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    mode: "manual",
    retry: RETRY,
    chunkPolicy: CHUNK_POLICY,
  });
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

// Turn 1 carries a clean tool run; turn 2 closes turn 1's chunk under the
// tiny target policy, so all seven kinds queue (the adapter-suite seeding).
async function seedSevenKinds(sdk: Lhc, store: TempStore): Promise<string> {
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  expect(created.ok).toBe(true);
  const result = await sdk.intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "please inspect the fixture file" } }),
    validEvent("tool_call", {
      payload: {
        toolCallId: "call-classify-1",
        toolName: "read_file",
        arguments: { path: "fixture.txt" },
      },
    }),
    validEvent("tool_result", {
      payload: { toolCallId: "call-classify-1", content: "contents of fixture.txt", isError: false },
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

// Drains to empty — the "drain returns normally" assertion every leg shares —
// and hands back both the report (dispositions, attempts) and the forms.
async function drainNormally(
  sdk: Lhc,
  filePath: string,
): Promise<{ report: DrainReport; derivations: Derivation[] }> {
  const drained = await sdk.work.drain({ filePath });
  expect(drained.ok).toBe(true);
  if (!drained.ok) throw new Error("drain failed");
  expect(drained.value.stoppedBecause).toBe("empty");
  expect(drained.value.remaining).toBe(0);
  return { report: drained.value, derivations: readDerivedForms(filePath) };
}

function countingCall(inner: ModelCall): { call: ModelCall; calls: () => number } {
  let calls = 0;
  return {
    call: (input) => {
      calls += 1;
      return inner(input);
    },
    calls: () => calls,
  };
}

describe("TC-3.1: the classification table drives retry and terminal paths (AC-3.1, AC-3.2)", () => {
  it("FAILURE_CLASSIFICATION matches AC-3.1 exactly, as data", () => {
    expect(FAILURE_CLASSIFICATION).toEqual({
      rate_limit: { retryable: true },
      timeout: { retryable: true },
      network: { retryable: true },
      empty_output: { retryable: true },
      other: { retryable: true },
      auth: { retryable: false },
      invalid_request: { retryable: false },
    });
  });

  it("rate_limit twice then success: the form lands ready and the attempts are recorded", async () => {
    const { call, calls } = countingCall(
      scriptedCall([
        { ok: false, kind: "rate_limit", message: "throttled by the fake host" },
        { ok: false, kind: "rate_limit", message: "throttled by the fake host" },
        { ok: true, text: "smoothed after two rate limits" },
      ]),
    );
    const sdk = inferenceSdk(call);
    const { report, derivations: forms } = await drainNormally(sdk, await seedSmoothingOnly(sdk, freshStore()));

    const smoothed = forms.find((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("ready");
    expect(smoothed?.content).toBe("smoothed after two rate limits");
    expect(calls()).toBe(3);
    // The retries happened inside the existing machinery: one item ran, done,
    // with both failed attempts on its disposition record.
    expect(report.ran).toHaveLength(1);
    expect(report.ran[0]).toMatchObject({ disposition: "done", attempts: 2 });
  });

  it("auth is terminal: failed on the first attempt, exactly one call, stable kind-led reason", async () => {
    const { call, calls } = countingCall(
      scriptedCall([{ ok: false, kind: "auth", message: "invalid api key" }]),
    );
    const sdk = inferenceSdk(call);
    const { report, derivations: forms } = await drainNormally(sdk, await seedSmoothingOnly(sdk, freshStore()));

    const smoothed = forms.find((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("failed");
    // Terminal reasons lead with the kind (machine-readable code before the
    // first colon) — stable across attempts because there is only one.
    expect(smoothed?.reason).toBe("auth: invalid api key");
    expect(smoothed?.metadata?.attempts).toBe(1);
    expect(calls()).toBe(1);
    expect(report.ran).toHaveLength(1);
    expect(report.ran[0]).toMatchObject({ disposition: "failed_terminal", attempts: 1 });
  });

  it("network failures exhaust the budget: failed, provider_failure-led reason, last error preserved", async () => {
    const { call, calls } = countingCall(
      scriptedCall([
        { ok: false, kind: "network", message: "connection reset" },
        { ok: false, kind: "network", message: "connection reset" },
        { ok: false, kind: "network", message: "connection reset" },
      ]),
    );
    const sdk = inferenceSdk(call);
    const { report, derivations: forms } = await drainNormally(sdk, await seedSmoothingOnly(sdk, freshStore()));

    const smoothed = forms.find((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("failed");
    expect(smoothed?.reason?.startsWith("provider_failure")).toBe(true);
    expect(smoothed?.reason).toContain("network");
    expect(smoothed?.metadata?.attempts).toBe(RETRY.budget);
    expect(smoothed?.metadata?.lastError).toContain("network");
    expect(smoothed?.metadata?.lastError).toContain("connection reset");
    expect(calls()).toBe(RETRY.budget);
    expect(report.ran[0]).toMatchObject({ disposition: "failed_terminal", attempts: RETRY.budget });
  });
});

describe("TC-3.2: thrown exceptions and timeouts are contained; no host behavior crashes a drain (AC-3.2, AC-3.3)", () => {
  it("a throwing host on one kind retries as `other` to exhaustion while every other item completes", async () => {
    const responses = cannedResponses();
    const { call: canned } = recordingCall(responses);
    const smoothingLane = `${FAKE_MODEL_PREFIX}smoothed_prompt`;
    const call: ModelCall = (input) =>
      input.model === smoothingLane
        ? Promise.reject(new Error("scripted host explosion"))
        : canned(input);
    const sdk = inferenceSdk(call);
    const { report, derivations: forms } = await drainNormally(sdk, await seedSevenKinds(sdk, freshStore()));

    // The thrown exception classified `other` (retryable): each smoothing
    // item burned its full budget, then turn construction recovered it to
    // plain ready without escaping the exception.
    const smoothed = forms.filter((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed.length).toBeGreaterThan(0);
    for (const form of smoothed) {
      expect(form.state).toBe("ready");
    }
    // Every other kind completed: the drain continued past the throwing lane.
    for (const kind of DERIVATION_TYPES.filter((k) => k !== "smoothed_prompt")) {
      const ready = forms.filter((form) => form.derivationType === kind && form.state === "ready");
      expect(ready.length).toBeGreaterThan(0);
      for (const form of ready) expect(form.content).toBe(responses[kind]);
    }
    for (const entry of report.ran.filter((r) => r.workItemId.includes("prompt_smoothing"))) {
      expect(entry.disposition).toBe("failed_terminal");
    }
  });

  it("a hanging host classifies `timeout` under the adapter-owned race and the drain continues", async () => {
    const hangingLane = `${FAKE_MODEL_PREFIX}smoothed_prompt`;
    const { call: canned } = recordingCall(cannedResponses());
    const hang = hangingCall();
    const call: ModelCall = (input) => (input.model === hangingLane ? hang(input) : canned(input));
    const sdk = inferenceSdk(call, 50);
    const store = freshStore();
    const filePath = store.threadPath();
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    const seeded = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "a prompt whose smoothing hangs" } }),
      validEvent("turn_end"),
    ]);
    expect(seeded.ok).toBe(true);

    const { derivations: forms } = await drainNormally(sdk, filePath);
    const smoothed = forms.find((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("ready");
    // The drain continued past the hanging lane: the turn's forms landed.
    expect(forms.find((form) => form.derivationType === "turn_rendering")?.state).toBe("ready");
    expect(forms.find((form) => form.derivationType === "smooth_turn_compression")?.state).toBe("ready");
  });

  it("timeout is retryable: a host that hangs once then answers lands the form ready", async () => {
    let attempt = 0;
    const call: ModelCall = () => {
      attempt += 1;
      if (attempt === 1) return new Promise(() => {});
      return Promise.resolve({ ok: true, text: "answered after one hang" });
    };
    const sdk = inferenceSdk(call, 50);
    const { report, derivations: forms } = await drainNormally(sdk, await seedSmoothingOnly(sdk, freshStore()));

    const smoothed = forms.find((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("ready");
    expect(smoothed?.content).toBe("answered after one hang");
    expect(report.ran[0]).toMatchObject({ disposition: "done", attempts: 1 });
  });

  describe("safeCall is the containment wrapper (AC-3.3, DD-6)", () => {
    it("passes a structured success through untouched", async () => {
      const result = await safeCall(
        scriptedCall([{ ok: true, text: "plain success" }]),
        PROBE_INPUT,
        1000,
      );
      expect(result).toEqual({ ok: true, text: "plain success" });
    });

    it("passes a structured failure through untouched", async () => {
      const result = await safeCall(
        scriptedCall([{ ok: false, kind: "rate_limit", message: "throttled" }]),
        PROBE_INPUT,
        1000,
      );
      expect(result).toEqual({ ok: false, kind: "rate_limit", message: "throttled" });
    });

    it("classifies a thrown exception as `other`, carrying the message", async () => {
      const result = await safeCall(throwingCall(new Error("kaboom")), PROBE_INPUT, 1000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("other");
        expect(result.message).toContain("kaboom");
      }
    });

    it("classifies a synchronously throwing host as `other` (the promise contract is not trusted)", async () => {
      const sync: ModelCall = () => {
        throw new Error("sync kaboom");
      };
      const result = await safeCall(sync, PROBE_INPUT, 1000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("other");
        expect(result.message).toContain("sync kaboom");
      }
    });

    it("classifies a never-settling host as `timeout` after the race", async () => {
      const result = await safeCall(hangingCall(), PROBE_INPUT, 50);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("timeout");
        expect(result.message).toContain("50");
      }
    });
  });
});
