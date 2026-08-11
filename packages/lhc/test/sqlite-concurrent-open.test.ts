/**
 * Slice 2 correction: concurrent capture + retrieval/impression writes must
 * both succeed under WAL. Re-applying journal_mode=WAL on every open previously
 * raced and produced "database is locked" on capture.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeterministicInferenceCallbacks, initLhc, type Lhc, retrieval } from "../src/index.js";
import { type TempStore, tempStore, validEvent } from "./fixtures/index.js";

describe("sqlite concurrent capture + retrieval", () => {
  let store: TempStore;
  let sdk: Lhc;
  let filePath: string;

  beforeEach(async () => {
    store = tempStore();
    sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
    const path = store.threadPath();
    const created = await sdk.threads.newThread({ filePath: path, registryPath: store.registryPath });
    if (!created.ok) throw new Error(created.error.reason);
    filePath = path;
    await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "q" } }),
      validEvent("assistant_text", { payload: { text: "a" } }),
      validEvent("turn_end"),
    ]);
    await sdk.work.drain({ filePath });
  });

  afterEach(() => {
    store.cleanup();
  });

  it("Promise.all retrieval + capture both succeed repeatedly on existing archive", async () => {
    for (let i = 0; i < 20; i += 1) {
      const retP = retrieval.getTurns({ filePath }, ["t1"], { surface: `race-${i}` });
      const capP = sdk.intakeStream.messageEvents({ filePath }, [
        validEvent("user_prompt", { payload: { text: `race-${i}` } }),
        validEvent("assistant_text", { payload: { text: `ans-${i}` } }),
        validEvent("turn_end"),
      ]);
      const [ret, cap] = await Promise.all([retP, capP]);
      expect(ret.ok, `retrieval failed iter ${i}: ${ret.ok ? "" : ret.error.reason}`).toBe(true);
      expect(cap.ok, `capture failed iter ${i}: ${cap.ok ? "" : cap.error.reason}`).toBe(true);
    }
    const imps = await retrieval.listImpressions({ filePath });
    expect(imps.ok).toBe(true);
    if (!imps.ok) return;
    expect(imps.value.length).toBeGreaterThanOrEqual(20);
  });

  it("fresh archive: create then race open paths", async () => {
    const path2 = store.threadPath("fresh-race");
    const created = await sdk.threads.newThread({ filePath: path2, registryPath: store.registryPath });
    if (!created.ok) throw new Error(created.error.reason);
    await sdk.intakeStream.messageEvents({ filePath: path2 }, [
      validEvent("user_prompt", { payload: { text: "seed" } }),
      validEvent("assistant_text", { payload: { text: "seed-a" } }),
      validEvent("turn_end"),
    ]);
    await sdk.work.drain({ filePath: path2 });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.all([
          retrieval.getTurns({ filePath: path2 }, ["t1"], { surface: `f-${i}` }),
          sdk.intakeStream.messageEvents({ filePath: path2 }, [
            validEvent("runtime_note", { payload: { text: `n-${i}` } }),
          ]),
        ]),
      ),
    );
    for (const [ret, cap] of results) {
      expect(ret.ok).toBe(true);
      expect(cap.ok).toBe(true);
    }
  });
});
