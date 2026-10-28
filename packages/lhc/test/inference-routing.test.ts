import { afterEach, describe, expect, it } from "vitest";
import {
  assertModelCallContract,
  assertRoutingThroughSdk,
  cannedResponses,
  DERIVATION_TYPES,
  FAKE_MODEL_PREFIX,
  FAKE_PROVIDER_PREFIX,
  INFERENCE_DERIVATION_TYPES,
  probeInput,
  recordingCall,
  type TempStore,
  tempStore,
  validAssignments,
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

describe("TC-1.2: per-kind provider/model routing (AC-1.4)", () => {
  it.skip("a seeded drain exercises all seven kinds, each call carrying exactly its assigned strings", async () => {
    const responses = cannedResponses();
    const { call, log } = recordingCall(responses);
    const assignments = validAssignments();
    const { derivations: forms } = await assertRoutingThroughSdk(call, assignments, freshStore());

    for (const kind of INFERENCE_DERIVATION_TYPES) {
      const lane = log.filter((input) => input.model === `${FAKE_MODEL_PREFIX}${kind}`);
      expect(lane.length).toBeGreaterThan(0);
      for (const input of lane) {
        expect(input.provider).toBe(`${FAKE_PROVIDER_PREFIX}${kind}`);
        expect(input.model).toBe(assignments[kind].model);
      }
      const ready = forms.filter((form) => form.derivationType === kind && form.state === "ready");
      expect(ready.length).toBeGreaterThan(0);
      for (const form of ready) {
        expect(form.content).toBe(responses[kind]);
      }
    }
    for (const kind of DERIVATION_TYPES) {
      expect(forms.some((form) => form.derivationType === kind && form.state === "ready")).toBe(true);
    }
  });

  it.skip("every logged messages value is single-turn shape: system and user roles, string content (AC-1.2)", async () => {
    const { call, log } = recordingCall(cannedResponses());
    await assertRoutingThroughSdk(call, validAssignments(), freshStore());

    expect(log.length).toBeGreaterThan(0);
    for (const input of log) {
      expect(input.messages.length).toBeGreaterThan(0);
      expect(input.messages.some((message) => message.role === "user")).toBe(true);
      for (const message of input.messages) {
        expect(["system", "user"]).toContain(message.role);
        expect(typeof message.content).toBe("string");
      }
    }
  });

  it.skip("a three-lane mixed config routes each call by item kind with no cross-kind bleed", async () => {
    const lanes = {
      smoothed_prompt: "lane-alpha",
      tool_result_summary: "lane-beta",
      detailed_turn_compression: "lane-beta",
      chunk_summary_brief: "lane-gamma",
    } as const;
    const assignments = validAssignments({
      smoothed_prompt: { provider: lanes.smoothed_prompt },
      tool_result_summary: { provider: lanes.tool_result_summary },
      detailed_turn_compression: { provider: lanes.detailed_turn_compression },
      chunk_summary_brief: { provider: lanes.chunk_summary_brief },
    });
    const responses = cannedResponses();
    const { call, log } = recordingCall(responses);
    const { derivations: forms } = await assertRoutingThroughSdk(call, assignments, freshStore());

    for (const kind of INFERENCE_DERIVATION_TYPES) {
      const calls = log.filter((input) => input.model === assignments[kind].model);
      expect(calls.length).toBeGreaterThan(0);
      for (const input of calls) {
        expect(input.provider).toBe(lanes[kind]);
      }
      const ready = forms.filter((form) => form.derivationType === kind && form.state === "ready");
      expect(ready.length).toBeGreaterThan(0);
      for (const form of ready) {
        expect(form.content).toBe(responses[kind]);
      }
    }
  });
});

describe("TC-1.2: fake-host fixture conformance (AC-1.2)", () => {
  it("assertModelCallContract holds against recordingCall", async () => {
    const { call } = recordingCall(cannedResponses());
    await assertModelCallContract(
      call,
      probeInput({
        provider: `${FAKE_PROVIDER_PREFIX}smoothed_prompt`,
        model: `${FAKE_MODEL_PREFIX}smoothed_prompt`,
      }),
    );
  });
});
