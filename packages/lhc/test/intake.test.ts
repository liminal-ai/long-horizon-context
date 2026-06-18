// Flow 2 (recording half): TC-2.1, TC-2.8, TC-1.4 (closing Story 1's
// deferral), the four architecture-risk tests (mid-walk rollback, restart
// survival, no-lock-on-rejection, system_error rollback parity). The CLI
// in-process stdin legs retired with the CLI surface (Epic 05 Story 1).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EventRecord, intakeStream, type MessageEventInput, threads } from "../src/index.js";
import {
  conversationTurn,
  eventBatch,
  openRaw,
  setIntakeClock,
  setIntakeWalkHook,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  setIntakeWalkHook(null);
  setIntakeClock(null);
  store.cleanup();
});

async function createThread(): Promise<string> {
  const filePath = store.threadPath();
  const created = await threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  return filePath;
}

async function readBack(filePath: string): Promise<EventRecord[]> {
  const result = await intakeStream.listEvents({ filePath });
  if (!result.ok) throw new Error(`read-back failed: ${result.error.reason}`);
  return result.value;
}

describe("Flow 2 (SDK): event recording", () => {
  it("TC-2.1: two batches record in array order with a dense, continuing event order", async () => {
    const filePath = await createThread();
    const batchOne = eventBatch(["user_prompt", "assistant_text", "tool_call"]);
    const batchTwo = eventBatch(["tool_result", "runtime_note", "turn_end"]);

    const first = await intakeStream.messageEvents({ filePath }, batchOne);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.events.map((e) => e.outcome)).toEqual(["recorded", "recorded", "recorded"]);
    expect(first.value.threadPosition.lastEventOrder).toBe(3);

    const second = await intakeStream.messageEvents({ filePath }, batchTwo);
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

  it("TC-2.8: an empty batch is a caller error and records nothing", async () => {
    const filePath = await createThread();
    const result = await intakeStream.messageEvents({ filePath }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("empty_batch");
    expect(result.error.reason).toContain("empty");

    expect(await readBack(filePath)).toEqual([]);
  });

  it("TC-1.4: the same batch by thread id and by file path produces identical results and read-back (closes Story 1's deferral)", async () => {
    // recordedAt is sourced from the injected clock (test-plan: fixed per
    // test), so the two independent recordings stamp the same instant and the
    // read-back can be compared field-for-field — recordedAt included, nothing
    // stripped.
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    setIntakeClock(() => recordedAt);

    const pathA = store.threadPath();
    const createdA = await threads.newThread({
      filePath: pathA,
      registryPath: store.registryPath,
    });
    expect(createdA.ok).toBe(true);
    if (!createdA.ok) return;
    const pathB = await createThread();

    const batch = eventBatch(["user_prompt", "assistant_text", "tool_call", "turn_end"]);
    const byId = await intakeStream.messageEvents(
      { threadId: createdA.value.threadId, registryPath: store.registryPath },
      batch,
    );
    const byPath = await intakeStream.messageEvents({ filePath: pathB }, batch);
    expect(byId.ok).toBe(true);
    expect(byPath.ok).toBe(true);
    if (!byId.ok || !byPath.ok) return;
    expect(byId.value).toEqual(byPath.value);

    // Exact read-back equivalence through both reference forms — every field,
    // recordedAt included. Determinism comes from the injected clock, not from
    // weakening the assertion.
    const readById = await intakeStream.listEvents({
      threadId: createdA.value.threadId,
      registryPath: store.registryPath,
    });
    expect(readById.ok).toBe(true);
    if (!readById.ok) return;
    const readByPath = await readBack(pathB);
    expect(readById.value).toEqual(readByPath);

    // recordedAt is the injected instant, proving it came from the clock seam
    // rather than wall time.
    expect(readById.value.map((e: EventRecord) => e.recordedAt)).toEqual(
      readByPath.map(() => recordedAt.toISOString()),
    );
  });

  it("architecture-risk: mid-walk failure rolls the whole batch back to baseline", async () => {
    const filePath = await createThread();
    const baselineBatch = eventBatch(["user_prompt", "assistant_text"]);
    const recorded = await intakeStream.messageEvents({ filePath }, baselineBatch);
    expect(recorded.ok).toBe(true);
    const baseline = await readBack(filePath);
    expect(baseline).toHaveLength(2);

    // Real mechanism: the seam closes the handle inside the transaction after
    // the first event of the new batch has been recorded.
    setIntakeWalkHook((db, eventIndex) => {
      if (eventIndex === 0) db.close();
    });
    const result = await intakeStream.messageEvents({ filePath }, eventBatch(["tool_call", "tool_result", "turn_end"]));
    setIntakeWalkHook(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("system_error");
    expect(result.error.code).toBe("storage_failure");

    // Post-reopen read-back: not the operation's own claim about itself.
    expect(await readBack(filePath)).toEqual(baseline);
  });

  it("architecture-risk: system_error rollback parity — storage failure mid-batch leaves no partial events", async () => {
    const filePath = await createThread();
    setIntakeWalkHook((db, eventIndex) => {
      if (eventIndex === 1) db.close();
    });
    const result = await intakeStream.messageEvents({ filePath }, conversationTurn());
    setIntakeWalkHook(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("system_error");
    expect(result.error.code).toBe("storage_failure");

    // AC-4.6 is class-independent: the first two walked events are gone too.
    expect(await readBack(filePath)).toEqual([]);
    const db = openRaw(filePath);
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM event").get() as unknown as {
        n: number | bigint;
      };
      expect(Number(row.n)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("architecture-risk: restart survival — reopen sees the identical record", async () => {
    const filePath = await createThread();
    const batch = conversationTurn();
    const recorded = await intakeStream.messageEvents({ filePath }, batch);
    expect(recorded.ok).toBe(true);

    // Every SDK operation opens and closes its own handle, so each read-back
    // below is a fresh open of the file the write durably left behind.
    const firstRead = await readBack(filePath);
    expect(firstRead).toHaveLength(5);
    const secondRead = await readBack(filePath);
    expect(secondRead).toEqual(firstRead);

    const db = openRaw(filePath);
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM event").get() as unknown as {
        n: number | bigint;
      };
      expect(Number(row.n)).toBe(5);
    } finally {
      db.close();
    }
  });

  it("architecture-risk: a rejected batch takes no lock — rejection succeeds while another connection holds the write lock", async () => {
    const filePath = await createThread();
    const locker = openRaw(filePath);
    try {
      locker.exec("BEGIN IMMEDIATE;");
      // If rejection touched the transaction path it would block on the held
      // lock and surface SQLITE_BUSY as storage_failure; pure validation
      // returns the caller error immediately instead.
      const result = await intakeStream.messageEvents({ filePath }, [
        { ...validEvent("user_prompt"), eventKind: "bogus" } as unknown as MessageEventInput,
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.errorClass).toBe("caller_error");
        expect(result.error.code).toBe("invalid_event");
      }
      locker.exec("ROLLBACK;");
    } finally {
      locker.close();
    }
    expect(await readBack(filePath)).toEqual([]);
  });
});
