// Flow 2 (recording half): TC-2.1 (dense continuing event order), TC-2.8
// (empty-batch caller error), TC-1.4 (id-ref / path-ref recording equivalence).
//
// Substrate-only frozen legs (documented n/a in the ledger):
//   - The four "architecture-risk" tests (mid-walk rollback via `db.close()`,
//     system_error rollback parity, restart survival via `openRaw`, and the
//     no-lock-on-rejection test with a held `BEGIN IMMEDIATE` lock) all inject
//     a mid-transaction storage fault or hold a SQLite write lock. Convex
//     mutations are atomic by platform guarantee and expose no
//     mid-transaction fault seam and no external file lock, so none of these
//     mechanisms exists. The observable invariant they protect — a rejected or
//     failed batch records nothing — is covered here (TC-2.8) and in
//     validation.test.ts (whole-batch rollback to baseline).
//
// TC-1.4 reshape: the frozen test records the SAME batch on two threads under
// an injected fixed clock so `recordedAt` matches field-for-field. Convex has
// no clock seam (`recordedAt` is wall-clock `Date.now()`), so this port proves
// ref equivalence two ways instead: (1) a single thread read back through both
// the id-ref and the path-ref is byte-identical (same stored rows, recordedAt
// included), and (2) the same batch on two threads produces identical receipts
// and identical read-back modulo the genuinely wall-clock `recordedAt`.
import { beforeEach, describe, expect, test } from "vitest";
import type { EventRecord, Lhc } from "../src/client/index.js";
import { eventBatch, type ServiceFixture, serviceFixture } from "./fixtures/index.js";

let fixture: ServiceFixture;
let sdk: Lhc;

beforeEach(() => {
  fixture = serviceFixture();
  sdk = fixture.sdk;
});

async function createThread(alias?: string): Promise<string> {
  return (await fixture.createThread(alias)).filePath;
}

async function readBack(filePath: string): Promise<EventRecord[]> {
  const result = await sdk.intakeStream.listEvents({ filePath });
  if (!result.ok) throw new Error(`read-back failed: ${result.error.reason}`);
  return result.value;
}

describe("Flow 2 (SDK): event recording", () => {
  test("TC-2.1: two batches record in array order with a dense, continuing event order", async () => {
    const filePath = await createThread();
    const batchOne = eventBatch(["user_prompt", "assistant_text", "tool_call"]);
    const batchTwo = eventBatch(["tool_result", "runtime_note", "turn_end"]);

    const first = await sdk.intakeStream.messageEvents({ filePath }, batchOne);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.events.map((e) => e.outcome)).toEqual(["recorded", "recorded", "recorded"]);
    expect(first.value.threadPosition.lastEventOrder).toBe(3);

    const second = await sdk.intakeStream.messageEvents({ filePath }, batchTwo);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.threadPosition.lastEventOrder).toBe(6);

    const events = await readBack(filePath);
    expect(events.map((e) => e.eventOrder)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.map((e) => e.eventKind)).toEqual([
      "user_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
      "runtime_note",
      "turn_end",
    ]);
    expect(events.map((e) => e.idempotencyKey)).toEqual([...batchOne, ...batchTwo].map((e) => e.idempotencyKey));
  });

  test("TC-2.8: an empty batch is a caller error and records nothing", async () => {
    const filePath = await createThread();
    const result = await sdk.intakeStream.messageEvents({ filePath }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("empty_batch");
    expect(result.error.reason).toContain("empty");

    expect(await readBack(filePath)).toEqual([]);
  });

  test("TC-1.4: a single thread reads back identically through the id-ref and the path-ref", async () => {
    const created = await sdk.threads.newThread({ filePath: "dual-ref" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const threadId = created.value.threadId;

    const batch = eventBatch(["user_prompt", "assistant_text", "tool_call", "turn_end"]);
    const recorded = await sdk.intakeStream.messageEvents({ filePath: "dual-ref" }, batch);
    expect(recorded.ok).toBe(true);

    // Same stored rows through both references: every field, recordedAt included.
    const byId = await sdk.intakeStream.listEvents({ threadId });
    const byPath = await sdk.intakeStream.listEvents({ filePath: "dual-ref" });
    expect(byId.ok).toBe(true);
    expect(byPath.ok).toBe(true);
    if (!byId.ok || !byPath.ok) return;
    expect(byId.value).toEqual(byPath.value);
    expect(byId.value.map((e) => e.eventOrder)).toEqual([1, 2, 3, 4]);
  });

  test("TC-1.4: the same batch on two threads records identical receipts and read-back (modulo wall-clock recordedAt)", async () => {
    const pathA = await createThread("thread-a");
    const pathB = await createThread("thread-b");

    const batch = eventBatch(["user_prompt", "assistant_text", "tool_call", "turn_end"]);
    // Fresh keys per thread would diverge, so reuse one batch shape but with
    // per-thread keys; compare the deterministic (non-key, non-clock) fields.
    const batchA = batch;
    const batchB = eventBatch(["user_prompt", "assistant_text", "tool_call", "turn_end"]);

    const recA = await sdk.intakeStream.messageEvents({ filePath: pathA }, batchA);
    const recB = await sdk.intakeStream.messageEvents({ filePath: pathB }, batchB);
    expect(recA.ok).toBe(true);
    expect(recB.ok).toBe(true);
    if (!recA.ok || !recB.ok) return;

    // Receipt outcomes, turn transitions and thread position are identical.
    expect(recA.value.events.map((e) => e.outcome)).toEqual(recB.value.events.map((e) => e.outcome));
    expect(recA.value.turnTransitions).toEqual(recB.value.turnTransitions);
    expect(recA.value.threadPosition).toEqual(recB.value.threadPosition);

    // Read-back is identical field-for-field except the wall-clock recordedAt
    // and the per-thread idempotency keys.
    const stripped = (events: EventRecord[]) =>
      events.map(({ recordedAt, idempotencyKey, ...rest }) => {
        void recordedAt;
        void idempotencyKey;
        return rest;
      });
    expect(stripped(await readBack(pathA))).toEqual(stripped(await readBack(pathB)));
    // recordedAt is a valid ISO instant on both.
    for (const event of await readBack(pathA)) {
      expect(new Date(event.recordedAt).toISOString()).toBe(event.recordedAt);
    }
  });
});
