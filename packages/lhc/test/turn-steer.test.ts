// Turn parts, Flow 7 — the host's steer assertion on user_prompt. A steering
// prompt (steer: true) inside a run in progress joins the open turn; it is
// never a boundary, so the task's turn identity survives a steer. Absent, a
// populated open turn still closes and a new one opens.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLhc, intakeStream, messages, turns } from "../src/index.js";
import { createInferenceCallbacksDouble, type TempStore, tempStore, validEvent } from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

describe("user_prompt steer assertion", () => {
  it("a steer joins the open turn without a boundary; a plain prompt still closes and opens; the flag is validated", async () => {
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const filePath = store.threadPath();
    expect((await sdk.threads.newThread({ filePath, registryPath: store.registryPath })).ok).toBe(true);

    const sent = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "big task" } }),
      validEvent("assistant_text", { payload: { text: "step 0", stepIndex: 0 } }),
      validEvent("user_prompt", { payload: { text: "actually, focus on the tests", steer: true } }),
      validEvent("assistant_text", { payload: { text: "step 1", stepIndex: 1 } }),
    ]);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value.turnTransitions).toEqual([]);

    const listed = await messages.list({ filePath });
    expect(listed.ok && listed.value.map((m) => [m.turnId, m.kind])).toEqual([
      ["t1", "user_prompt"],
      ["t1", "assistant_text"],
      ["t1", "user_prompt"],
      ["t1", "assistant_text"],
    ]);
    const steer = listed.ok ? listed.value[2] : undefined;
    expect(steer?.blocks[0]?.content).toEqual({ text: "actually, focus on the tests", steer: true });

    // Steps stay consistent around the steer; the turn is still splittable.
    const meta = await sdk.threadView.hostMetadata({ filePath });
    expect(meta.ok && meta.value.activeTurn).toMatchObject({
      turnId: "t1",
      completeSteps: 2,
      lastStepEdge: 1,
      splittable: true,
    });

    // A plain prompt is still a boundary.
    const next = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "new task" } }),
    ]);
    expect(next.ok && next.value.turnTransitions).toEqual([
      { action: "closed", turnId: "t1" },
      { action: "opened", turnId: "t2" },
    ]);
    const open = await turns.listTurns({ filePath });
    expect(open.ok && open.value.map((t) => [t.turnId, t.status])).toEqual([
      ["t1", "closed"],
      ["t2", "open"],
    ]);

    // Closed validation: steer must be a boolean; no other kind takes it.
    for (const bad of [
      validEvent("user_prompt", { payload: { text: "x", steer: "yes" } as never }),
      validEvent("assistant_text", { payload: { text: "x", steer: true } as never }),
    ]) {
      const result = await intakeStream.messageEvents({ filePath }, [bad]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_event");
    }
  });
});
