// Story 6 (Epic 02): messages.remove — Flow 6. Thread-view-level removal with
// the event log intact: a deleted message leaves reads and its turn's
// membership while its source events stay in the Epic 01 read-back (TC-6.1);
// its own forms drop while the turn and chunk clear and re-queue for
// minus-one composition, the cascade stopping exactly at the chunk (TC-6.2).
// Prompt protection refuses whole-turn removal in this slice (TC-6.3).
// Refusals — open turn, missing id, double delete through the filtered view —
// are stable and change nothing (TC-6.7).
//
// The frozen work-item-id and disposition strings are substrate (Convex work
// items carry opaque ids and the drain reports aggregate counts), so the
// cascade is proven on the stable cleared/dropped/queued kinds and the derived
// form states. The background "delete-and-walk-away" leg is excluded: the
// scheduled-drain poke cannot be driven to completion under convex-test (a
// harness limitation, not a Convex behavior gap) — its manual-mode equivalent
// is TC-6.2.
import { describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput } from "../src/client/index.js";
import { capturedCalls, resetCapturedCalls } from "./convex/model.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

interface DeleteFixture extends ServiceFixture {
  filePath: string;
  threadId: string;
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`batch failed: ${result.error.reason}`);
}

async function rawWorkItems(fixture: ServiceFixture, thread: string): Promise<unknown[]> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    return rows
      .filter((row) => row.instance === fixture.instance && row.thread === thread)
      .map(({ _id, _creationTime, workItem, queuedAt, startedAt, ...rest }) => rest)
      .sort((a, b) => a.seq - b.seq);
  });
}

async function readDerivedForms(fixture: ServiceFixture, thread: string): Promise<Array<Record<string, unknown>>> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("derivations").collect();
    return rows
      .filter((row) => row.instance === fixture.instance && row.thread === thread)
      .map(({ _id, _creationTime, ...rest }) => rest as Record<string, unknown>)
      .sort((a, b) =>
        `${a["scope"]}/${a["subject"]}/${a["deriv"]}`.localeCompare(`${b["scope"]}/${b["subject"]}/${b["deriv"]}`),
      );
  });
}

function clearKey(entry: Record<string, unknown>): string {
  return `${entry["subjectKind"]}/${entry["subjectId"]}/${entry["derivationType"]}`;
}

function unwrap<T>(result: { ok: boolean }): T {
  if (!result.ok) throw new Error(`expected ok result: ${JSON.stringify(result)}`);
  return (result as { ok: true; value: T }).value;
}

// The full mutation read-back surface in one snapshot — record, membership,
// chunks, events, forms, queue — for refusal-changes-nothing assertions.
async function snapshot(fixture: DeleteFixture): Promise<unknown> {
  const { sdk, filePath } = fixture;
  return {
    messages: unwrap(await sdk.messages.list({ filePath })),
    turns: unwrap(await sdk.turns.listTurns({ filePath })),
    chunks: unwrap(await sdk.turns.listChunks({ filePath })),
    events: unwrap(await sdk.intakeStream.listEvents({ filePath })),
    derivations: await readDerivedForms(fixture, fixture.threadId),
    queue: await rawWorkItems(fixture, fixture.threadId),
  };
}

// One closed turn carrying a full tool run — m1 prompt, m2 tool_call, m3
// tool_result, m4 assistant_text — drained ready. Under the default chunk
// policy t1's chunk stays open, so no chunk summary rows exist.
async function toolRunThread(overrides: Record<string, unknown> = {}): Promise<DeleteFixture> {
  const fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1 } }, ...overrides });
  const { filePath, threadId } = await fixture.createThread();
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "use the tool" } }),
    validEvent("tool_call"),
    validEvent("tool_result"),
    validEvent("assistant_text", { payload: { text: "tool run done" } }),
    validEvent("turn_end"),
  ]);
  const drained = await fixture.sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
  return { ...fixture, filePath, threadId };
}

describe("TC-6.1 / AC-6.1: a deleted message leaves reads and membership; its events remain", () => {
  test("deleting a tool-result message removes it from message reads and turn membership, not from event read-back", async () => {
    const fixture = await toolRunThread();
    const { filePath, sdk } = fixture;
    const eventsBefore = unwrap<Array<{ eventKind: string }>>(await sdk.intakeStream.listEvents({ filePath }));

    const result = await sdk.messages.remove({ filePath }, { messageId: "m3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changed).toEqual({ messageIds: ["m3"], turnIds: [] });

    // Message reads exclude the deleted record.
    const records = unwrap<Array<{ messageId: string }>>(await sdk.messages.list({ filePath }));
    expect(records.map((record) => record.messageId)).toEqual(["m1", "m2", "m4"]);

    // Turn membership shrinks in place — the turn row and its boundaries
    // untouched, the deleted member filtered out.
    const turnRecords = unwrap<Array<{ memberMessageIds: string[] }>>(await sdk.turns.listTurns({ filePath }));
    expect(turnRecords).toHaveLength(2);
    expect(turnRecords[0]?.memberMessageIds).toEqual(["m1", "m2", "m4"]);

    // The audit surface is deliberately unfiltered: every source event,
    // byte-identical, including the deleted message's.
    expect(unwrap(await sdk.intakeStream.listEvents({ filePath }))).toEqual(eventsBefore);
    expect(eventsBefore.some((event: { eventKind: string }) => event.eventKind === "tool_result")).toBe(true);
  });
});

describe("TC-6.2 / AC-6.2 (architecture risk): delete drops own forms, re-queues upward, stops at the chunk", () => {
  test("the deleted message's forms are gone, its turn and chunk re-queue, chunk 2 is byte-stable", async () => {
    // max=1: every turn forms its own immediately closed chunk — two chunks,
    // both with summaries.
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const { filePath, threadId } = await fixture.createThread();
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "first prompt" } }),
      validEvent("tool_call"),
      validEvent("tool_result"),
      validEvent("assistant_text", { payload: { text: "first answer" } }),
      validEvent("turn_end"),
    ]);
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "second prompt" } }),
      validEvent("assistant_text", { payload: { text: "second answer" } }),
      validEvent("turn_end"),
    ]);
    const first = await fixture.sdk.work.drain({ filePath });
    if (!first.ok) throw new Error(first.error.reason);
    const df = { ...fixture, filePath, threadId };
    const before = await readDerivedForms(df, threadId);
    expect(before.every((form) => form["state"] === "ready")).toBe(true);

    const result = await fixture.sdk.messages.remove({ filePath }, { messageId: "m3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The subject's own forms drop; the chain above clears. Tool calls render
    // as recorded and have no summary row to clear or requeue.
    expect(result.value.dropped.map(clearKey)).toEqual(["message/m3/tool_result_summary"]);
    expect(result.value.cleared.map(clearKey).sort()).toEqual(
      [
        "turn/t1/detailed_turn_compression",
        "turn/t1/pre_detailed_assembly",
        "turn/t1/turn_rendering",
        "chunk/c1/chunk_summary_brief",
        "chunk/c1/chunk_summary_detailed",
      ].sort(),
    );
    expect(result.value.queued.map((item) => item.kind).sort()).toEqual([
      "chunk_summary_brief",
      "chunk_summary_detailed",
      "detailed_turn_compression",
      "turn_derivation",
    ]);

    // Dropped means rows removed — no ghost row in any state.
    const after = await readDerivedForms(df, threadId);
    expect(after.some((form) => form["subject"] === "m3")).toBe(false);
    // The cleared half sits pending at the bumped version.
    const clearedSet = new Set(result.value.cleared.map(clearKey));
    const afterKey = (f: Record<string, unknown>) => `${f["scope"]}/${f["subject"]}/${f["deriv"]}`;
    for (const form of after.filter((candidate) => clearedSet.has(afterKey(candidate)))) {
      expect(form["state"]).toBe("pending");
      expect(form["sourceVersion"]).toBe(2);
    }
    // Everything else — m1's message form, t2's forms, chunk 2's summaries —
    // deep-equals its pre-delete row, source version included.
    expect(after.filter((form) => !clearedSet.has(afterKey(form)))).toEqual(
      before.filter((form) => !clearedSet.has(afterKey(form)) && form["subject"] !== "m3"),
    );

    // The rebuild re-derives the affected turn: the proof it re-ran is a
    // detailed_turn_compression model call, and every form lands ready again.
    resetCapturedCalls();
    const drained = await fixture.sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    expect((await readDerivedForms(df, threadId)).every((form) => form["state"] === "ready")).toBe(true);
    expect(capturedCalls.some((call) => call.model.includes("detailed_turn_compression"))).toBe(true);
  });
});

describe("TC-6.3 / AC-6.3 (architecture risk): prompt protection refuses unsupported whole-turn removal", () => {
  test("deleting a turn-initiating prompt is refused naming the turn; nothing changes", async () => {
    const fixture = await toolRunThread();
    const before = await snapshot(fixture);

    const result = await fixture.sdk.messages.remove({ filePath: fixture.filePath }, { messageId: "m1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("message_initiates_turn");
    expect(result.error.reason).toContain("t1");
    expect(result.error.reason).toContain("not supported");

    expect(await snapshot(fixture)).toEqual(before);
  });
});

describe("TC-6.7 / AC-6.7: refusals are stable and change nothing — double delete included", () => {
  test("open-turn target, bogus id, and a second delete of the same id refuse with stable codes; the record is identical after each", async () => {
    const fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1 } } });
    const { filePath, threadId } = await fixture.createThread();
    // t1 closed {m1 prompt, m2 answer}; t2 open {m4 prompt}.
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "closed prompt" } }),
      validEvent("assistant_text", { payload: { text: "closed answer" } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "open prompt" } }),
    ]);
    const drained = await fixture.sdk.work.drain({ filePath });
    if (!drained.ok) throw new Error(drained.error.reason);
    const df = { ...fixture, filePath, threadId };
    const before = await snapshot(df);

    // Open-turn message: refused under the closed-turn boundary.
    const openTurn = await fixture.sdk.messages.remove({ filePath }, { messageId: "m4" });
    expect(openTurn.ok).toBe(false);
    if (openTurn.ok) return;
    expect(openTurn.error.errorClass).toBe("caller_error");
    expect(openTurn.error.code).toBe("turn_open");
    expect(await snapshot(df)).toEqual(before);

    // Unknown id.
    const missing = await fixture.sdk.messages.remove({ filePath }, { messageId: "m99" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("message_not_found");
    expect(await snapshot(df)).toEqual(before);

    // Double delete: the first succeeds; the second reads the filtered view and
    // refuses as message_not_found — a refusal, not a silent success.
    const firstDelete = await fixture.sdk.messages.remove({ filePath }, { messageId: "m2" });
    expect(firstDelete.ok).toBe(true);
    const afterDelete = await snapshot(df);
    const secondDelete = await fixture.sdk.messages.remove({ filePath }, { messageId: "m2" });
    expect(secondDelete.ok).toBe(false);
    if (secondDelete.ok) return;
    expect(secondDelete.error.errorClass).toBe("caller_error");
    expect(secondDelete.error.code).toBe("message_not_found");
    expect(await snapshot(df)).toEqual(afterDelete);
  });
});
