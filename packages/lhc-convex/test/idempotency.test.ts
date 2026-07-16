import { beforeEach, describe, expect, test } from "vitest";
import type { EventRecord, Lhc } from "../src/client/index.js";
import {
  type ConvexHarness,
  conversationTurn,
  eventBatch,
  type ServiceFixture,
  serviceFixture,
  validEvent,
} from "./fixtures/index.js";

let fixture: ServiceFixture;
let sdk: Lhc;
let convex: ConvexHarness;

beforeEach(() => {
  fixture = serviceFixture();
  sdk = fixture.sdk;
  convex = fixture.test;
});

async function createThread(): Promise<string> {
  return (await fixture.createThread()).filePath;
}

async function readBack(filePath: string): Promise<EventRecord[]> {
  const result = await sdk.intakeStream.listEvents({ filePath });
  if (!result.ok) throw new Error(`read-back failed: ${result.error.reason}`);
  return result.value;
}

async function rawDump(): Promise<string> {
  return await convex.run(async (ctx) => {
    const rows = await Promise.all(
      [
        "instances",
        "threads",
        "events",
        "turns",
        "messages",
        "messageBlocks",
        "workItems",
        "derivations",
        "chunks",
        "chunkMembers",
        "threadViews",
        "threadViewBands",
        "viewBoundaries",
        "logs",
        "derivationLogs",
      ].map(async (table) => await ctx.db.query(table as never).collect()),
    );
    return JSON.stringify(rows);
  });
}

describe("Flow 5 (SDK): idempotent resend", () => {
  test("TC-5.1: resending a fully recorded batch skips everything and changes nothing", async () => {
    const filePath = await createThread();
    const batch = conversationTurn();
    const first = await sdk.intakeStream.messageEvents({ filePath }, batch);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.events.every((entry) => entry.outcome === "recorded")).toBe(true);
    expect(first.value.threadPosition.lastEventOrder).toBe(5);
    const baseline = await readBack(filePath);

    const resend = await sdk.intakeStream.messageEvents({ filePath }, batch);
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

  test("TC-5.2: partial resend skips the old, records the new, and keeps the order dense", async () => {
    const filePath = await createThread();
    const old = eventBatch(["user_prompt", "assistant_text", "tool_call"]);
    expect((await sdk.intakeStream.messageEvents({ filePath }, old)).ok).toBe(true);

    const fresh = [validEvent("tool_result"), validEvent("turn_end")];
    const resend = await sdk.intakeStream.messageEvents({ filePath }, [...old, ...fresh]);
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

  test("TC-5.3: idempotency keys are scoped to the thread — same key records in both threads", async () => {
    const threadA = await createThread();
    const threadB = await createThread();
    const event = validEvent("user_prompt", { idempotencyKey: "shared-key-1" });

    const inA = await sdk.intakeStream.messageEvents({ filePath: threadA }, [event]);
    const inB = await sdk.intakeStream.messageEvents({ filePath: threadB }, [event]);
    expect(inA.ok).toBe(true);
    expect(inB.ok).toBe(true);
    if (!inA.ok || !inB.ok) return;
    expect(inA.value.events[0]!.outcome).toBe("recorded");
    expect(inB.value.events[0]!.outcome).toBe("recorded");
    expect((await readBack(threadA)).map((row) => row.idempotencyKey)).toEqual(["shared-key-1"]);
    expect((await readBack(threadB)).map((row) => row.idempotencyKey)).toEqual(["shared-key-1"]);
  });

  test("TC-5.4: skips are inert — no duplicate rows, no order numbers consumed, no transitions reported", async () => {
    const filePath = await createThread();
    const batch = eventBatch(["user_prompt", "turn_end"]);
    expect((await sdk.intakeStream.messageEvents({ filePath }, batch)).ok).toBe(true);

    const resend = await sdk.intakeStream.messageEvents({ filePath }, batch);
    expect(resend.ok).toBe(true);
    if (!resend.ok) return;
    expect(resend.value.events.every((entry) => entry.outcome === "skipped")).toBe(true);
    expect(resend.value.turnTransitions).toEqual([]);
    expect(resend.value.queuedWork).toEqual([]);

    const counts = await convex.run(async (ctx) => {
      const rows = await ctx.db.query("events").collect();
      return rows.map((row) => ({
        idempotencyKey: row.idemKey,
        count: rows.filter((candidate) => candidate.idemKey === row.idemKey).length,
      }));
    });
    expect(counts).toHaveLength(2);
    for (const row of counts) expect(row.count).toBe(1);

    const next = await sdk.intakeStream.messageEvents({ filePath }, [validEvent("user_prompt")]);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.threadPosition.lastEventOrder).toBe(3);
    expect((await readBack(filePath)).map((row) => row.eventOrder)).toEqual([1, 2, 3]);
  });

  test("TC-5.5: key wins over content — original payload intact, resent payload stored nowhere", async () => {
    const filePath = await createThread();
    const original = validEvent("user_prompt", {
      idempotencyKey: "key-K",
      payload: { text: "PAYLOAD-A-ORIGINAL" },
    });
    expect((await sdk.intakeStream.messageEvents({ filePath }, [original])).ok).toBe(true);

    const reused = validEvent("user_prompt", {
      idempotencyKey: "key-K",
      payload: { text: "PAYLOAD-B-MUST-VANISH" },
    });
    const resend = await sdk.intakeStream.messageEvents({ filePath }, [reused]);
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
    const dump = await rawDump();
    expect(dump).toContain("PAYLOAD-A-ORIGINAL");
    expect(dump).not.toContain("PAYLOAD-B-MUST-VANISH");
  });
});
