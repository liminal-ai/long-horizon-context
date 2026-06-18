// Flow 5: idempotent resend (TC-5.1 through TC-5.5, asserted at the event
// level — the no-message / no-transition / no-work-item clauses re-assert in
// Stories 3-5 as those records exist).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EventRecord, intakeStream, threads } from "../src/index.js";
import { conversationTurn, eventBatch, openRaw, type TempStore, tempStore, validEvent } from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
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

// Serializes every row of every table for below-SDK absence assertions.
function rawDump(filePath: string): string {
  const db = openRaw(filePath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{
      name: string;
    }>;
    let dump = "";
    for (const table of tables) {
      dump += JSON.stringify(db.prepare(`SELECT * FROM "${table.name}"`).all());
    }
    return dump;
  } finally {
    db.close();
  }
}

describe("Flow 5 (SDK): idempotent resend", () => {
  it("TC-5.1: resending a fully recorded batch skips everything and changes nothing", async () => {
    const filePath = await createThread();
    const batch = conversationTurn();
    const first = await intakeStream.messageEvents({ filePath }, batch);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.events.every((entry) => entry.outcome === "recorded")).toBe(true);
    expect(first.value.threadPosition.lastEventOrder).toBe(5);
    const baseline = await readBack(filePath);

    const resend = await intakeStream.messageEvents({ filePath }, batch);
    expect(resend.ok).toBe(true);
    if (!resend.ok) return;
    expect(resend.value.events).toHaveLength(5);
    for (const [index, entry] of resend.value.events.entries()) {
      expect(entry.outcome).toBe("skipped");
      expect(entry.skipReason).toBe("duplicate_idempotency_key");
      expect(entry.idempotencyKey).toBe(batch[index]!.idempotencyKey);
    }
    expect(resend.value.threadPosition.lastEventOrder).toBe(5);

    expect(await readBack(filePath)).toEqual(baseline);
  });

  it("TC-5.2: partial resend skips the old, records the new, and keeps the order dense", async () => {
    const filePath = await createThread();
    const old = eventBatch(["user_prompt", "assistant_text", "tool_call"]);
    const first = await intakeStream.messageEvents({ filePath }, old);
    expect(first.ok).toBe(true);

    const fresh = [validEvent("tool_result"), validEvent("turn_end")];
    const resend = await intakeStream.messageEvents({ filePath }, [...old, ...fresh]);
    expect(resend.ok).toBe(true);
    if (!resend.ok) return;
    expect(resend.value.events.map((entry) => entry.outcome)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "recorded",
      "recorded",
    ]);
    expect(resend.value.threadPosition.lastEventOrder).toBe(5);

    const events = await readBack(filePath);
    expect(events.map((event) => event.eventOrder)).toEqual([1, 2, 3, 4, 5]);
    expect(events[3]!.idempotencyKey).toBe(fresh[0]!.idempotencyKey);
    expect(events[4]!.idempotencyKey).toBe(fresh[1]!.idempotencyKey);
  });

  it("TC-5.3: idempotency keys are scoped to the thread — same key records in both threads", async () => {
    const threadA = await createThread();
    const threadB = await createThread();
    const event = validEvent("user_prompt", { idempotencyKey: "shared-key-1" });

    const inA = await intakeStream.messageEvents({ filePath: threadA }, [event]);
    const inB = await intakeStream.messageEvents({ filePath: threadB }, [event]);
    expect(inA.ok).toBe(true);
    expect(inB.ok).toBe(true);
    if (!inA.ok || !inB.ok) return;
    expect(inA.value.events[0]!.outcome).toBe("recorded");
    expect(inB.value.events[0]!.outcome).toBe("recorded");

    expect((await readBack(threadA)).map((e) => e.idempotencyKey)).toEqual(["shared-key-1"]);
    expect((await readBack(threadB)).map((e) => e.idempotencyKey)).toEqual(["shared-key-1"]);
  });

  it("TC-5.4: skips are inert — no duplicate rows, no order numbers consumed, no transitions reported", async () => {
    const filePath = await createThread();
    const batch = eventBatch(["user_prompt", "turn_end"]);
    const first = await intakeStream.messageEvents({ filePath }, batch);
    expect(first.ok).toBe(true);

    const resend = await intakeStream.messageEvents({ filePath }, batch);
    expect(resend.ok).toBe(true);
    if (!resend.ok) return;
    expect(resend.value.events.every((entry) => entry.outcome === "skipped")).toBe(true);
    expect(resend.value.turnTransitions).toEqual([]);
    expect(resend.value.queuedWork).toEqual([]);

    // No duplicate event rows: each key appears exactly once below the SDK.
    const db = openRaw(filePath);
    try {
      const counts = db
        .prepare("SELECT idempotency_key, COUNT(*) AS n FROM event GROUP BY idempotency_key")
        .all() as unknown as Array<{ idempotency_key: string; n: number | bigint }>;
      expect(counts).toHaveLength(2);
      for (const row of counts) expect(Number(row.n)).toBe(1);
    } finally {
      db.close();
    }

    // Skips consumed no order numbers: the next recorded event lands at 3.
    const next = await intakeStream.messageEvents({ filePath }, [validEvent("user_prompt")]);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.threadPosition.lastEventOrder).toBe(3);
    expect((await readBack(filePath)).map((e) => e.eventOrder)).toEqual([1, 2, 3]);
  });

  it("TC-5.5: key wins over content — original payload intact, resent payload stored nowhere", async () => {
    const filePath = await createThread();
    const original = validEvent("user_prompt", {
      idempotencyKey: "key-K",
      payload: { text: "PAYLOAD-A-ORIGINAL" },
    });
    const first = await intakeStream.messageEvents({ filePath }, [original]);
    expect(first.ok).toBe(true);

    const reused = validEvent("user_prompt", {
      idempotencyKey: "key-K",
      payload: { text: "PAYLOAD-B-MUST-VANISH" },
    });
    const resend = await intakeStream.messageEvents({ filePath }, [reused]);
    expect(resend.ok).toBe(true);
    if (!resend.ok) return;
    expect(resend.value.events[0]).toEqual({
      idempotencyKey: "key-K",
      outcome: "skipped",
      skipReason: "duplicate_idempotency_key",
    });

    const events = await readBack(filePath);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ text: "PAYLOAD-A-ORIGINAL" });

    // openRaw scan: payload B appears in no table at all.
    const dump = rawDump(filePath);
    expect(dump).toContain("PAYLOAD-A-ORIGINAL");
    expect(dump).not.toContain("PAYLOAD-B-MUST-VANISH");
  });
});
