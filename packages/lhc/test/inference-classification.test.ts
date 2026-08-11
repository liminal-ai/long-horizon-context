// Model-call failures preserve stable reason classes. safeCall contains thrown
// host exceptions as `other` and races the adapter-owned timeout as `timeout`,
// so host behavior cannot crash a drain.
import { afterEach, describe, expect, it } from "vitest";
import { type Derivation, type DrainReport, initLhc, type Lhc } from "../src/index.js";
import { safeCall } from "../src/shared-tech/classify.js";
import type { ModelCall, ModelCallInput } from "../src/shared-tech/inference-types.js";
import {
  cannedResponses,
  FAKE_MODEL_PREFIX,
  hangingCall,
  readDerivedForms,
  recordingCall,
  scriptedCall,
  type TempStore,
  tempStore,
  throwingCall,
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
  return initLhc({
    inference: { call, assignments: validAssignments(), ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    mode: "manual",
    chunkPolicy: CHUNK_POLICY,
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
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

// Drains to empty and hands back both the report and the derivations.
async function drainNormally(sdk: Lhc, filePath: string): Promise<{ report: DrainReport; derivations: Derivation[] }> {
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

describe("TC-3.1: inference failures preserve stable reason classes", () => {
  it("auth fails on the first attempt with a stable kind-led reason", async () => {
    const { call, calls } = countingCall(scriptedCall([{ ok: false, kind: "auth", message: "invalid api key" }]));
    const sdk = inferenceSdk(call);
    const { report, derivations: forms } = await drainNormally(sdk, await seedSmoothingOnly(sdk, freshStore()));

    const smoothed = forms.find((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("failed");
    expect(smoothed?.reason).toBe("auth: invalid api key");
    expect(calls()).toBe(1);
    expect(report.ran).toHaveLength(1);
    expect(report.ran[0]).toMatchObject({ disposition: "failed_terminal" });
  });

  it("network fails on the first attempt with a provider_failure-led reason", async () => {
    const { call, calls } = countingCall(scriptedCall([{ ok: false, kind: "network", message: "connection reset" }]));
    const sdk = inferenceSdk(call);
    const { report, derivations: forms } = await drainNormally(sdk, await seedSmoothingOnly(sdk, freshStore()));

    const smoothed = forms.find((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("failed");
    expect(smoothed?.reason?.startsWith("provider_failure")).toBe(true);
    expect(smoothed?.reason).toContain("network");
    expect(calls()).toBe(1);
    expect(report.ran[0]).toMatchObject({ disposition: "failed_terminal" });
  });
});

describe("TC-3.2: thrown exceptions and timeouts are contained; no host behavior crashes a drain (AC-3.2, AC-3.3)", () => {
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
    expect(forms.find((form) => form.derivationType === "detailed_turn_compression")?.state).toBe("ready");
  });

  describe("safeCall is the containment wrapper (AC-3.3, DD-6)", () => {
    it("passes a structured success through untouched", async () => {
      const result = await safeCall(scriptedCall([{ ok: true, text: "plain success" }]), PROBE_INPUT, 1000);
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

describe("provenance reports the actually-serving model when the host says so", () => {
  it("actualProvider/actualModel on a success override assignment provenance; prompt stays the assignment's", async () => {
    const sdk = inferenceSdk(async () => ({
      ok: true,
      text: "smoothed just fine",
      actualProvider: "prov-actual",
      actualModel: "model-actual",
    }));
    const { derivations: forms } = await drainNormally(sdk, await seedSmoothingOnly(sdk, freshStore()));

    const smoothed = forms.find((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("ready");
    expect(smoothed?.metadata?.provenance).toMatchObject({
      provider: "prov-actual",
      model: "model-actual",
    });
    expect(smoothed?.metadata?.provenance?.prompt).toBe(validAssignments().smoothed_prompt.prompt);
  });

  it("absent actuals keep the assignment's provenance exactly as before", async () => {
    const sdk = inferenceSdk(async () => ({ ok: true, text: "smoothed plainly" }));
    const { derivations: forms } = await drainNormally(sdk, await seedSmoothingOnly(sdk, freshStore()));

    const smoothed = forms.find((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("ready");
    expect(smoothed?.metadata?.provenance).toMatchObject({
      provider: validAssignments().smoothed_prompt.provider,
      model: validAssignments().smoothed_prompt.model,
    });
  });
});
