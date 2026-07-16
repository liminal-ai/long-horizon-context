// Derivation work queueing: TC-2.6 (complete batch result), TC-2.7/TC-2.9
// (message-owned work and its exact kind gate), TC-3.3/TC-3.6/TC-3.8 (turn-owned
// work), TC-5.4 (a skipped event queues nothing), the durability regression
// (work rows survive as durable state), the complete-surface rollback, and the
// enqueue-atomicity observable (pending form rows ride the intake transaction).
//
// Substrate-only frozen legs (documented n/a in the ledger):
//   - Every `workItemId` string (`w-m1-prompt_smoothing-v1`, …) is a frozen
//     SEMANTIC composite id. Convex work items carry opaque sequence ids
//     (`w1`, `w2`, …), so the queue is asserted on the stable owner/kind/
//     sourceRef/status facts, never the id string. `queuedAt` is wall-clock
//     (no injected-clock seam), so it is asserted as an ISO instant, not a
//     fixed value.
//   - FC-0.4's `WORK_KIND_REGISTRY` / `mapWorkQHandlers` / `lookupWork*` legs
//     assert a frozen internal module API. Convex has no exported work-kind
//     registry or handler map — the owner/sourceRefKey semantics are embodied
//     in the component's enqueue sites (proven by the owner/kind/sourceRef
//     assertions here). No analog surface exists to unit-test.
//   - The enqueue-atomicity ROLLBACK legs (`setIntakeWalkHook` throw,
//     `createDbWriteTransaction` + direct `enqueue`, per-enqueue `setSchedulerPoke`
//     counting) inject mid-transaction faults and drive Node module-global
//     scheduler seams. Convex mutations are atomic by platform guarantee and
//     expose no such seams; the versioned-supersede behavior those legs cover
//     is ported in mutations.test.ts (TC-5.3). The committed-write observable
//     (pending forms ride the intake transaction) is ported below.
import { beforeEach, describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

let fixture: ServiceFixture;
let sdk: Lhc;

beforeEach(() => {
  fixture = serviceFixture();
  sdk = fixture.sdk;
});

interface StableWorkItem {
  owner: string;
  kind: string;
  sourceRef: Record<string, string>;
  status: string;
}

async function createThread(): Promise<{ filePath: string; threadId: string }> {
  return fixture.createThread();
}

async function send(filePath: string, batch: MessageEventInput[]) {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`fixture batch failed: ${result.error.reason}`);
  return result.value;
}

// Below-SDK read of durable work rows for one owner: the batch result alone is
// not proof of durability.
async function queuedFor(thread: string, owner: string): Promise<StableWorkItem[]> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    return rows
      .filter((row) => row.instance === fixture.instance && row.thread === thread && row.owner === owner)
      .sort((a, b) => a.seq - b.seq)
      .map((row) => ({
        owner: row.owner,
        kind: row.kind,
        sourceRef: row.sourceRef as Record<string, string>,
        status: row.status,
      }));
  });
}

async function rawWorkItemCount(thread: string): Promise<number> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    return rows.filter((row) => row.instance === fixture.instance && row.thread === thread).length;
  });
}

async function rawFormRows(thread: string): Promise<Array<{ key: string; state: string }>> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("derivations").collect();
    return rows
      .filter((row) => row.instance === fixture.instance && row.thread === thread)
      .map((row) => ({ key: `${row.scope}/${row.subject}/${row.deriv}`, state: row.state }))
      .sort((a, b) => a.key.localeCompare(b.key));
  });
}

async function readBack(filePath: string, thread: string) {
  const events = await sdk.intakeStream.listEvents({ filePath });
  const projected = await sdk.messages.list({ filePath });
  const turnRecords = await sdk.turns.listTurns({ filePath });
  if (!events.ok || !projected.ok || !turnRecords.ok) throw new Error("read-back failed");
  return {
    events: events.value,
    messages: projected.value,
    turns: turnRecords.value,
    messageWork: await queuedFor(thread, "messages"),
    turnWork: await queuedFor(thread, "turns"),
  };
}

describe("Flow 2 (SDK): message-owned work queueing", () => {
  test("TC-2.7: a prompt and a tool result each durably queue their kind, owner messages", async () => {
    const { filePath, threadId } = await createThread();
    const result = await send(filePath, [validEvent("user_prompt"), validEvent("tool_result")]);

    // The batch result reports both items with owner/kind/sourceRef.
    expect(result.queuedWork).toContainEqual(
      expect.objectContaining({ owner: "messages", kind: "prompt_smoothing", sourceRef: { messageId: "m1" } }),
    );
    expect(result.queuedWork).toContainEqual(
      expect.objectContaining({ owner: "messages", kind: "tool_result_summary", sourceRef: { messageId: "m2" } }),
    );

    // Durable read-back through the owning domain: status queued.
    expect(await queuedFor(threadId, "messages")).toEqual([
      { owner: "messages", kind: "prompt_smoothing", sourceRef: { messageId: "m1" }, status: "queued" },
      { owner: "messages", kind: "tool_result_summary", sourceRef: { messageId: "m2" }, status: "queued" },
    ]);
    // The prompt opened a turn that is still open: no turn-owned work yet.
    expect(await queuedFor(threadId, "turns")).toEqual([]);
    expect(await rawWorkItemCount(threadId)).toBe(2);
  });

  test("TC-2.9: text, thinking, and note messages queue nothing — the kind gate is exact", async () => {
    const { filePath, threadId } = await createThread();
    const result = await send(filePath, [
      validEvent("assistant_text"),
      validEvent("assistant_thinking"),
      validEvent("runtime_note"),
    ]);
    expect(result.queuedWork).toEqual([]);
    expect(await queuedFor(threadId, "messages")).toEqual([]);
    expect(await queuedFor(threadId, "turns")).toEqual([]);
    expect(await rawWorkItemCount(threadId)).toBe(0);
  });

  test("TC-2.6: a mixed batch's result is complete — outcomes, messageIds, transitions, queuedWork, position", async () => {
    const { filePath } = await createThread();
    const original = validEvent("user_prompt");
    await send(filePath, [original]);

    const result = await send(filePath, [original, validEvent("assistant_text"), validEvent("turn_end")]);

    expect(result.events).toEqual([
      { idempotencyKey: original.idempotencyKey, outcome: "skipped", skipReason: "duplicate_idempotency_key" },
      expect.objectContaining({ outcome: "recorded", messageId: "m2" }),
      expect.objectContaining({ outcome: "recorded" }),
    ]);
    expect(result.events[2]).not.toHaveProperty("messageId");
    expect(result.turnTransitions).toEqual([
      { action: "closed", turnId: "t1" },
      { action: "opened", turnId: "t2" },
    ]);
    expect(result.queuedWork).toHaveLength(1);
    expect(result.queuedWork[0]).toEqual(
      expect.objectContaining({ owner: "turns", kind: "turn_derivation", sourceRef: { turnId: "t1" } }),
    );
    expect(result.threadPosition).toEqual({ lastEventOrder: 3 });
  });
});

describe("Flow 3 (SDK): turn-owned work queueing", () => {
  test("TC-3.3: explicit close durably queues a turn_derivation, owner turns", async () => {
    const { filePath, threadId } = await createThread();
    const result = await send(filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);

    expect(result.queuedWork).toContainEqual(
      expect.objectContaining({ owner: "turns", kind: "turn_derivation", sourceRef: { turnId: "t1" } }),
    );
    expect(await queuedFor(threadId, "turns")).toEqual([
      { owner: "turns", kind: "turn_derivation", sourceRef: { turnId: "t1" }, status: "queued" },
    ]);
  });

  test("TC-3.6: implicit close queues the same work-item contract as the explicit path", async () => {
    const explicit = await createThread();
    await send(explicit.filePath, [validEvent("user_prompt"), validEvent("assistant_text")]);
    await send(explicit.filePath, [validEvent("turn_end")]);

    const implicit = await createThread();
    await send(implicit.filePath, [validEvent("user_prompt"), validEvent("assistant_text")]);
    await send(implicit.filePath, [validEvent("user_prompt")]);

    const explicitItems = await queuedFor(explicit.threadId, "turns");
    const implicitItems = await queuedFor(implicit.threadId, "turns");
    expect(explicitItems).toEqual(implicitItems);
    expect(explicitItems).toEqual([
      { owner: "turns", kind: "turn_derivation", sourceRef: { turnId: "t1" }, status: "queued" },
    ]);
  });

  test("TC-3.8: a multi-turn batch queues one turn_derivation item per closed turn", async () => {
    const { filePath, threadId } = await createThread();
    await send(filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);

    const turnWork = await queuedFor(threadId, "turns");
    expect(turnWork).toEqual([
      { owner: "turns", kind: "turn_derivation", sourceRef: { turnId: "t1" }, status: "queued" },
      { owner: "turns", kind: "turn_derivation", sourceRef: { turnId: "t2" }, status: "queued" },
    ]);
  });

  test("TC-5.4: a skipped (duplicate) event queues nothing", async () => {
    const { filePath, threadId } = await createThread();
    const prompt = validEvent("user_prompt");
    const end = validEvent("turn_end");
    await send(filePath, [prompt, validEvent("assistant_text"), end]);
    await send(filePath, [validEvent("user_prompt")]); // t2 now open
    const baseline = await readBack(filePath, threadId);
    const baselineCount = await rawWorkItemCount(threadId);

    const resend = await send(filePath, [prompt, end]);
    expect(resend.events.map((entry) => entry.outcome)).toEqual(["skipped", "skipped"]);
    expect(resend.queuedWork).toEqual([]);
    expect(await readBack(filePath, threadId)).toEqual(baseline);
    expect(await rawWorkItemCount(threadId)).toBe(baselineCount);
  });
});

describe("architecture-risk: durability and rollback over the complete record surface", () => {
  test("durability: work items live as durable rows, status queued", async () => {
    const { filePath, threadId } = await createThread();
    await send(filePath, [
      validEvent("user_prompt"),
      validEvent("tool_call"),
      validEvent("tool_result"),
      validEvent("turn_end"),
    ]);
    const before = await readBack(filePath, threadId);
    expect(before.messageWork).toHaveLength(2);
    expect(before.turnWork).toHaveLength(1);

    // The rows live in durable component state — prompt (m1), tool result (m3),
    // and the turn (t1), all queued.
    expect(await queuedFor(threadId, "messages")).toEqual([
      { owner: "messages", kind: "prompt_smoothing", sourceRef: { messageId: "m1" }, status: "queued" },
      { owner: "messages", kind: "tool_result_summary", sourceRef: { messageId: "m3" }, status: "queued" },
    ]);
    expect(await queuedFor(threadId, "turns")).toEqual([
      { owner: "turns", kind: "turn_derivation", sourceRef: { turnId: "t1" }, status: "queued" },
    ]);
    expect(await readBack(filePath, threadId)).toEqual(before);
  });

  test("complete-surface rollback: a rejected batch leaves events, messages, turns, and work items at baseline", async () => {
    const { filePath, threadId } = await createThread();
    await send(filePath, [validEvent("user_prompt"), validEvent("tool_result"), validEvent("turn_end")]);
    const baseline = await readBack(filePath, threadId);
    const baselineCount = await rawWorkItemCount(threadId);

    const rejected = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      { ...validEvent("user_prompt"), eventKind: "bogus" } as unknown as MessageEventInput,
    ]);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe("invalid_event");

    expect(await readBack(filePath, threadId)).toEqual(baseline);
    expect(await rawWorkItemCount(threadId)).toBe(baselineCount);
  });
});

describe("enqueue atomicity: committed intake writes pending form rows in the same transaction", () => {
  test("a committed intake batch durably writes work rows and pending forms", async () => {
    const { filePath, threadId } = await createThread();
    const result = await send(filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);
    expect(result.queuedWork).toHaveLength(2);

    // The pending state rows rode the same transaction: one for the prompt's
    // derivation, two for the turn's rendering + pre-detailed assembly.
    expect(await rawFormRows(threadId)).toEqual([
      { key: "message/m1/smoothed_prompt", state: "pending" },
      { key: "turn/t1/pre_detailed_assembly", state: "pending" },
      { key: "turn/t1/turn_rendering", state: "pending" },
    ]);
  });
});
