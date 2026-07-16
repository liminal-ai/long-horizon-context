// Story 5 (Epic 02): messages.edit and the mutation cascade — Flow 5's edit
// half. One synchronous transaction carries the content change, the token
// re-stamp, and the full dependent-chain clear-and-requeue (TC-5.1). Cascade
// reach is proven in both directions — exactly the chain cleared, everything
// outside it byte-stable including source versions (TC-5.2). Post-return no
// pre-edit derivation is ready and replacements sit queued at the new source
// version, with the still-queued first wave superseded on a second edit
// (TC-5.3). Refusals (open turn, missing id, deleted target through the
// filtered view) change nothing (TC-5.5).
//
// Excluded, with reason:
//  - The work-item-id strings and drain disposition strings are substrate
//    (Convex work items carry opaque ids; the drain reports aggregate counts).
//    The cascade is proven on the stable cleared/dropped set, the queued work
//    kinds, the superseded count, and the derived form states/versions.
//  - TC-5.1's induced-cascade-failure atomicity leg is n/a: it forces a
//    primary-key collision on the replacement work-item id, a node:sqlite
//    fault surface. Convex mutations are atomic by platform guarantee and
//    expose no mid-cascade fault seam.
//  - TC-5.4 (the version check beats a claimed straggler) is out of scope:
//    it needs an in-flight-claimed-item-held-across-the-edit seam
//    (double.delayKind); the Convex drain claims and completes each item
//    atomically with no analog.
//  - The background "edit-and-walk-away" leg is excluded: the scheduled-drain
//    poke cannot be driven to completion under convex-test (harness
//    limitation, not a Convex behavior gap) — TC-5.1 is its manual equivalent.
import { describe, expect, test } from "vitest";
import { estimateTokens, type Lhc, type MessageEventInput } from "../src/client/index.js";
import { capturedCalls, resetCapturedCalls } from "./convex/model.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

interface EditFixture extends ServiceFixture {
  filePath: string;
  threadId: string;
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`batch failed: ${result.error.reason}`);
}

async function rawWorkItems(fixture: ServiceFixture, thread: string): Promise<Array<Record<string, unknown>>> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    return rows
      .filter((row) => row.instance === fixture.instance && row.thread === thread)
      .map(({ _id, _creationTime, workItem, queuedAt, startedAt, ...rest }) => rest as Record<string, unknown>)
      .sort((a, b) => (a["seq"] as number) - (b["seq"] as number));
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

function formKey(form: Record<string, unknown>): string {
  return `${form["scope"]}/${form["subject"]}/${form["deriv"]}`;
}

function unwrap<T>(result: { ok: boolean }): T {
  if (!result.ok) throw new Error(`expected ok result: ${JSON.stringify(result)}`);
  return (result as { ok: true; value: T }).value;
}

async function snapshot(fixture: EditFixture): Promise<unknown> {
  return {
    messages: unwrap(await fixture.sdk.messages.list({ filePath: fixture.filePath })),
    derivations: await readDerivedForms(fixture, fixture.threadId),
    queue: await rawWorkItems(fixture, fixture.threadId),
  };
}

// One closed prompt+answer turn (m1 prompt, t1), drained ready. tinyTurnTokens
// forces the detailed_turn_compression form so the whole turn chain is present.
// Under the default chunk policy t1's chunk stays open, so no chunk summary
// rows exist.
async function readyTurnThread(overrides: Record<string, unknown> = {}): Promise<EditFixture> {
  const fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1 } }, ...overrides });
  const { filePath, threadId } = await fixture.createThread();
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "original prompt" } }),
    validEvent("assistant_text", { payload: { text: "the original answer" } }),
    validEvent("turn_end"),
  ]);
  const drained = await fixture.sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
  return { ...fixture, filePath, threadId };
}

describe("TC-5.1 / AC-5.1: edit updates content, blocks, and estimate synchronously, reporting the cascade", () => {
  test("changes the record in the edit's transaction and names cleared forms and queued items", async () => {
    const fixture = await readyTurnThread();
    const { filePath, sdk } = fixture;

    const result = await sdk.messages.edit({ filePath }, { messageId: "m1", content: "edited prompt" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changed).toEqual({ messageIds: ["m1"], turnIds: [] });
    expect(result.value.dropped).toEqual([]);
    // The chain above m1: its own smoothing and t1's three forms. t1's chunk is
    // still open — no summary rows exist, so none are named.
    expect(result.value.cleared.map(clearKey).sort()).toEqual(
      [
        "message/m1/smoothed_prompt",
        "turn/t1/detailed_turn_compression",
        "turn/t1/pre_detailed_assembly",
        "turn/t1/turn_rendering",
      ].sort(),
    );
    expect(result.value.queued.map((item) => item.kind).sort()).toEqual([
      "detailed_turn_compression",
      "prompt_smoothing",
      "turn_derivation",
    ]);
    expect(result.value.superseded).toEqual([]);

    // Synchronous, before any drain: content, blocks, and the re-stamped
    // estimate read back changed.
    const m1 = unwrap<Array<{ messageId: string; blocks: unknown; tokenEstimate: number }>>(
      await sdk.messages.list({ filePath }),
    ).find((record) => record.messageId === "m1");
    expect(m1?.blocks).toEqual([{ blockType: "text", content: { text: "edited prompt" } }]);
    expect(m1?.tokenEstimate).toBe(estimateTokens("edited prompt"));

    // The queued rebuilds run through the normal drain and derive from the
    // edited content: the smoothing lands ready at the bumped version, and the
    // model was called with the edited prompt.
    resetCapturedCalls();
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    const smoothing = (await readDerivedForms(fixture, fixture.threadId)).find(
      (form) => form["subject"] === "m1" && form["deriv"] === "smoothed_prompt",
    );
    expect(smoothing?.["state"]).toBe("ready");
    expect(smoothing?.["sourceVersion"]).toBe(2);
    expect(
      capturedCalls.some(
        (call) =>
          call.model.includes("smoothed_prompt") &&
          call.messages.some((message) => message.content.includes("edited prompt")),
      ),
    ).toBe(true);
  });
});

describe("TC-5.2 / AC-5.2 (architecture risk): cascade reach is exact in both directions", () => {
  test("clears exactly the edited message's chain; the second chunk's forms are byte-stable", async () => {
    // max=1: every turn's compression meets the maximum, so each turn forms its
    // own immediately closed chunk — two chunks, both with summaries.
    const fixture = await serviceFixtureTwoChunk();
    const { filePath, threadId, sdk } = fixture;

    const before = await readDerivedForms(fixture, threadId);
    // Fixture sanity: both chunks closed with every form ready.
    expect(before.map((form) => formKey(form)).sort()).toEqual(
      [
        "message/m1/smoothed_prompt",
        "message/m4/smoothed_prompt",
        "turn/t1/detailed_turn_compression",
        "turn/t1/pre_detailed_assembly",
        "turn/t1/turn_rendering",
        "turn/t2/detailed_turn_compression",
        "turn/t2/pre_detailed_assembly",
        "turn/t2/turn_rendering",
        "chunk/c1/chunk_summary_brief",
        "chunk/c1/chunk_summary_detailed",
        "chunk/c2/chunk_summary_brief",
        "chunk/c2/chunk_summary_detailed",
      ].sort(),
    );
    expect(before.every((form) => form["state"] === "ready")).toBe(true);

    const result = await sdk.messages.edit({ filePath }, { messageId: "m1", content: "rewritten first prompt" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The cleared set is exactly the chain: m1's forms, t1's three, c1's two.
    expect(result.value.cleared.map(clearKey).sort()).toEqual(
      [
        "message/m1/smoothed_prompt",
        "turn/t1/detailed_turn_compression",
        "turn/t1/pre_detailed_assembly",
        "turn/t1/turn_rendering",
        "chunk/c1/chunk_summary_brief",
        "chunk/c1/chunk_summary_detailed",
      ].sort(),
    );

    // The untouched-set half: every form outside the chain — chunk 2's
    // summaries, t2's forms, m4's smoothing — deep-equals its pre-edit rows,
    // state and source version included.
    const clearedSet = new Set(result.value.cleared.map(clearKey));
    const after = await readDerivedForms(fixture, threadId);
    expect(after.filter((form) => !clearedSet.has(formKey(form)))).toEqual(
      before.filter((form) => !clearedSet.has(formKey(form))),
    );
    // And the cleared half sits pending at the bumped version.
    for (const form of after.filter((candidate) => clearedSet.has(formKey(candidate)))) {
      expect(form["state"]).toBe("pending");
      expect(form["sourceVersion"]).toBe(2);
      expect(form["content"]).toBeUndefined();
    }
  });
});

// max=1 two-turn thread: two closed single-member chunks, both with summaries.
async function serviceFixtureTwoChunk(): Promise<EditFixture> {
  const fixture = serviceFixture({
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
    chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
  });
  const { filePath, threadId } = await fixture.createThread();
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "first prompt" } }),
    validEvent("assistant_text", { payload: { text: "first answer" } }),
    validEvent("turn_end"),
  ]);
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "second prompt" } }),
    validEvent("assistant_text", { payload: { text: "second answer" } }),
    validEvent("turn_end"),
  ]);
  const drained = await fixture.sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
  return { ...fixture, filePath, threadId };
}

describe("TC-5.3 / AC-5.3: post-return, nothing pre-edit is ready; replacements queued at the new version; superseded reported", () => {
  test("clears to pending with version-scoped replacements, and a second edit supersedes the still-queued first wave", async () => {
    const fixture = await serviceFixtureTwoChunkSingle();
    const { filePath, threadId, sdk } = fixture;
    expect((await readDerivedForms(fixture, threadId)).every((form) => form["state"] === "ready")).toBe(true);

    // Edit while everything is ready: every dependent form leaves ready in the
    // edit's transaction, replacement items carry the new source version, and
    // nothing was queued to supersede.
    const first = await sdk.messages.edit({ filePath }, { messageId: "m1", content: "first edit" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.superseded).toEqual([]);
    expect(first.value.queued.map((item) => item.kind).sort()).toEqual([
      "chunk_summary_brief",
      "chunk_summary_detailed",
      "detailed_turn_compression",
      "prompt_smoothing",
      "turn_derivation",
    ]);
    const formsAfterFirst = await readDerivedForms(fixture, threadId);
    expect(formsAfterFirst.every((form) => form["state"] === "pending")).toBe(true);
    expect(formsAfterFirst.every((form) => form["sourceVersion"] === 2)).toBe(true);
    const queueAfterFirst = await rawWorkItems(fixture, threadId);
    expect(queueAfterFirst).toHaveLength(5);
    expect(queueAfterFirst.every((row) => row["status"] === "queued" && row["sourceVersion"] === 2)).toBe(true);

    // Second edit before any drain: the still-queued first wave is
    // supersede-deleted in the cascade transaction and reported; the queue
    // holds only the v3 replacements.
    const second = await sdk.messages.edit({ filePath }, { messageId: "m1", content: "second edit" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.superseded).toHaveLength(5);
    const queueAfterSecond = await rawWorkItems(fixture, threadId);
    expect(queueAfterSecond).toHaveLength(5);
    expect(queueAfterSecond.every((row) => row["status"] === "queued" && row["sourceVersion"] === 3)).toBe(true);
    expect((await readDerivedForms(fixture, threadId)).every((form) => form["sourceVersion"] === 3)).toBe(true);

    // And the drain rebuilds the whole chain from the second edit's content.
    resetCapturedCalls();
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    const smoothing = (await readDerivedForms(fixture, threadId)).find(
      (form) => form["subject"] === "m1" && form["deriv"] === "smoothed_prompt",
    );
    expect(smoothing?.["state"]).toBe("ready");
    expect(smoothing?.["sourceVersion"]).toBe(3);
    expect(
      capturedCalls.some(
        (call) =>
          call.model.includes("smoothed_prompt") &&
          call.messages.some((message) => message.content.includes("second edit")),
      ),
    ).toBe(true);
  });
});

// max=1 single-turn thread: one closed single-member chunk with summaries.
async function serviceFixtureTwoChunkSingle(): Promise<EditFixture> {
  const fixture = serviceFixture({
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
    chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
  });
  const { filePath, threadId } = await fixture.createThread();
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "original prompt" } }),
    validEvent("assistant_text", { payload: { text: "the answer" } }),
    validEvent("turn_end"),
  ]);
  const drained = await fixture.sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
  return { ...fixture, filePath, threadId };
}

describe("TC-5.5 / AC-5.5: refusals are stable and change nothing", () => {
  test("refuses open-turn, missing, and deleted targets; read-back identical after each", async () => {
    const fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1 } } });
    const { filePath, threadId } = await fixture.createThread();
    // m1 in closed t1; m3 in open t2.
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "closed prompt" } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "open prompt" } }),
    ]);
    const df = { ...fixture, filePath, threadId };
    const before = await snapshot(df);

    const openTurn = await fixture.sdk.messages.edit({ filePath }, { messageId: "m3", content: "nope" });
    expect(openTurn.ok).toBe(false);
    if (openTurn.ok) return;
    expect(openTurn.error.errorClass).toBe("caller_error");
    expect(openTurn.error.code).toBe("turn_open");
    expect(await snapshot(df)).toEqual(before);

    const missing = await fixture.sdk.messages.edit({ filePath }, { messageId: "m99", content: "nope" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.errorClass).toBe("caller_error");
    expect(missing.error.code).toBe("message_not_found");
    expect(await snapshot(df)).toEqual(before);

    // A deleted target reads as message_not_found through the filtered view —
    // never a distinct error. (deletedAt stamped below the SDK.)
    await fixture.test.run(async (ctx) => {
      const rows = await ctx.db.query("messages").collect();
      const m1 = rows.find(
        (row) => row.instance === fixture.instance && row.thread === threadId && row.message === "m1",
      );
      if (m1 === undefined) throw new Error("m1 missing");
      await ctx.db.patch("messages", m1._id, { deletedAt: "2026-06-11T00:00:00.000Z" });
    });
    const afterStamp = await snapshot(df);
    const deleted = await fixture.sdk.messages.edit({ filePath }, { messageId: "m1", content: "nope" });
    expect(deleted.ok).toBe(false);
    if (deleted.ok) return;
    expect(deleted.error.code).toBe("message_not_found");
    expect(await snapshot(df)).toEqual(afterStamp);
  });

  test("refuses an open-turn target under the closed-turn boundary; read-back unchanged", async () => {
    const fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1 } } });
    const { filePath, threadId } = await fixture.createThread();
    // A note before any prompt attaches to the initialized open turn. It exists
    // and is not deleted; the open-turn boundary refuses the edit.
    await send(fixture.sdk, filePath, [validEvent("runtime_note", { payload: { text: "a note before any turn" } })]);
    const m1 = unwrap<Array<{ messageId: string; turnId: string }>>(await fixture.sdk.messages.list({ filePath })).find(
      (record) => record.messageId === "m1",
    );
    expect(m1?.turnId).toBe("t1");

    const df = { ...fixture, filePath, threadId };
    const before = await snapshot(df);
    const openTurn = await fixture.sdk.messages.edit({ filePath }, { messageId: "m1", content: "nope" });
    expect(openTurn.ok).toBe(false);
    if (openTurn.ok) return;
    expect(openTurn.error.errorClass).toBe("caller_error");
    expect(openTurn.error.code).toBe("turn_open");
    expect(await snapshot(df)).toEqual(before);
  });
});
