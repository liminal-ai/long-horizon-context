// Bodies are token-budgeted; receipts are per-id. Without an id cap the
// model-visible result is unbounded — arbitrarily many missing ids would
// each earn a receipt despite the body budget (validator P0, 2026-08-08).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDeterministicInferenceCallbacks,
  initLhc,
  intakeStream,
  type Lhc,
  retrieval,
} from "../src/index.js";
import { MAX_RETRIEVAL_IDS_PER_CALL } from "../src/retrieval/index.js";
import { type TempStore, tempStore, validEvent } from "./fixtures/index.js";

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
  const sent = await intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "only question" } }),
    validEvent("assistant_text", { payload: { text: "only answer" } }),
    validEvent("turn_end"),
  ]);
  if (!sent.ok) throw new Error(sent.error.reason);
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
});
afterEach(() => {
  store.cleanup();
});

describe("retrieval id cap", () => {
  it("refuses over-cap calls whole, naming the cap", async () => {
    const ids = Array.from({ length: MAX_RETRIEVAL_IDS_PER_CALL + 1 }, (_, i) => `t${i + 1}`);
    const result = await retrieval.getTurns({ filePath }, ids);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toMatch(/too many ids/);
      expect(result.error.reason).toContain(String(MAX_RETRIEVAL_IDS_PER_CALL));
    }
  });

  it("counts deduped ids, not raw ids", async () => {
    const ids = Array.from({ length: MAX_RETRIEVAL_IDS_PER_CALL + 10 }, () => "t1");
    const result = await retrieval.getTurns({ filePath }, ids);
    expect(result.ok).toBe(true);
  });
});
