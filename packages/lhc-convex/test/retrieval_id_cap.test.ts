// Bodies are token-budgeted; receipts are per-id. Without an id cap the
// model-visible result is unbounded — arbitrarily many missing ids would
// each earn a receipt despite the body budget (validator P0, 2026-08-08).
// Mirrors packages/lhc test/retrieval-id-cap.test.ts at the contract pin.
import { beforeEach, describe, expect, it } from "vitest";
import type { Lhc } from "../src/client/index.js";
import { MAX_RETRIEVAL_IDS_PER_CALL } from "../src/shared/retrieval.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

let fixture: ServiceFixture;
let sdk: Lhc;
let filePath: string;

beforeEach(async () => {
  fixture = serviceFixture();
  sdk = fixture.sdk;
  filePath = (await fixture.createThread()).filePath;
  const sent = await sdk.intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "only question" } }),
    validEvent("assistant_text", { payload: { text: "only answer" } }),
    validEvent("turn_end"),
  ]);
  if (!sent.ok) throw new Error(sent.error.reason);
  for (;;) {
    const drained = await sdk.work.drain({ filePath });
    if (!drained.ok) throw new Error(drained.error.reason);
    if (drained.value.remaining === 0) break;
  }
});

describe("retrieval id cap", () => {
  it("refuses over-cap calls whole, naming the cap", async () => {
    const ids = Array.from({ length: MAX_RETRIEVAL_IDS_PER_CALL + 1 }, (_, i) => `t${i + 1}`);
    const result = await sdk.retrieval.getTurns({ filePath }, ids);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toMatch(/too many ids/);
      expect(result.error.reason).toContain(String(MAX_RETRIEVAL_IDS_PER_CALL));
    }
  });

  it("accepts exactly the cap of unique ids", async () => {
    const ids = Array.from({ length: MAX_RETRIEVAL_IDS_PER_CALL }, (_, i) => `t${i + 1}`);
    const result = await sdk.retrieval.getTurns({ filePath }, ids);
    expect(result.ok).toBe(true);
  });

  it("refuses oversized ids per-id as invalid, with the echo clamped", async () => {
    const monster = `t${"9".repeat(40_000)}`;
    const result = await sdk.retrieval.getTurns({ filePath }, [monster, "t1"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const invalid = result.value.unserved.find((u) => u.reason === "invalid");
      expect(invalid).toBeDefined();
      expect(invalid?.id.length ?? 0).toBeLessThanOrEqual(33);
      expect(result.value.served.length).toBe(1);
    }
  });

  it("clamps caller tokenBudget to the contract ceiling", async () => {
    const result = await sdk.retrieval.getTurns({ filePath }, ["t1"], { tokenBudget: 10_000_000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.tokenBudget).toBeLessThanOrEqual(8_000);
  });

  it("counts deduped ids, not raw ids", async () => {
    const ids = Array.from({ length: MAX_RETRIEVAL_IDS_PER_CALL + 10 }, () => "t1");
    const result = await sdk.retrieval.getTurns({ filePath }, ids);
    expect(result.ok).toBe(true);
  });
});
