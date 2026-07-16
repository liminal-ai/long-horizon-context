// Story 4 (Epic 02): derivation state, report, and repair — Flow 4. The
// four-state lifecycle read back on forms the pipeline landed (TC-4.1), exact
// owner scoping and the exact not-ready set (TC-4.3), explicit re-queue
// through the owning surfaces landing ready with the failure cleared (TC-4.4),
// derive returning one result per message id (TC-4.5), and degrade-don't-block
// reads with non-ready summary states present (TC-4.7 chunk leg).
//
// Adaptations and exclusions, with reason:
//  - The frozen fixtures block turn derivations through a two-open-turns
//    corruption. The Convex turn-derivation handler does not treat two open
//    turns as damage (its intake refuses that state up front); the reachable
//    blocked-source path is a deleted turn row, which lands the turn forms
//    blocked with "source_damaged: turn <id> not found". This suite uses that
//    path, so the frozen ".reason contains 'open'" wording (TC-4.6 second) has
//    no analog.
//  - A model-failed smoothing falls back to a ready form on Convex (proven in
//    derivation_turns), so the "failed" smoothed_prompt state is manufactured
//    through the sanctioned raw stamp (as view_fixture / inspect_health do),
//    never a hand-written flow assertion.
//  - The drain work-item-id and disposition strings are substrate (Convex
//    reports aggregate drain counts and opaque work ids).
//  - TC-4.6 (deriveTurn refusal on source damage) and TC-4.7's listTurns leg
//    are documented open in the ledger: a deleted turn is excluded from
//    listTurns and deriveTurn on it returns turn_not_found rather than a
//    source_damaged-blocked refusal — the two-open-turns "readable blocked
//    turn" shape has no Convex analog.
import { describe, expect, test } from "vitest";
import type { DerivationReportEntry, Lhc, MessageEventInput } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

const MIXED_FAILED_REASON = "provider_failure: scripted failure (fixture)";
const BRIEF_FAILED_REASON = "provider_failure: scripted brief failure (fixture)";

async function stampChunkBriefFailed(fixture: ServiceFixture, thread: string, chunkId: string): Promise<void> {
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("derivations").collect();
    const row = rows.find(
      (r) =>
        r.instance === fixture.instance &&
        r.thread === thread &&
        r.subject === chunkId &&
        r.deriv === "chunk_summary_brief",
    );
    if (row === undefined) throw new Error(`chunk brief for ${chunkId} missing`);
    await ctx.db.patch("derivations", row._id, {
      state: "failed",
      content: undefined,
      reason: BRIEF_FAILED_REASON,
      metadata: undefined,
      derivedAt: "2026-01-01T00:00:00.000Z",
    });
  });
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`batch failed: ${result.error.reason}`);
}

async function liveWork(fixture: ServiceFixture, thread: string): Promise<unknown[]> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    return rows.filter((row) => row.instance === fixture.instance && row.thread === thread);
  });
}

async function deleteTurns(fixture: ServiceFixture, thread: string, turnIds: readonly string[]): Promise<void> {
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("turns").collect();
    for (const turnId of turnIds) {
      const row = rows.find((r) => r.instance === fixture.instance && r.thread === thread && r.turn === turnId);
      if (row === undefined) throw new Error(`turn ${turnId} missing`);
      await ctx.db.patch("turns", row._id, { deletedAt: "2026-01-01T00:00:00.000Z" });
    }
  });
}

async function stampSmoothingFailed(fixture: ServiceFixture, thread: string, messageId: string): Promise<void> {
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("derivations").collect();
    const row = rows.find(
      (r) =>
        r.instance === fixture.instance &&
        r.thread === thread &&
        r.subject === messageId &&
        r.deriv === "smoothed_prompt",
    );
    if (row === undefined) throw new Error(`smoothing for ${messageId} missing`);
    await ctx.db.patch("derivations", row._id, {
      state: "failed",
      content: undefined,
      reason: MIXED_FAILED_REASON,
      metadata: undefined,
      derivedAt: "2026-01-01T00:00:00.000Z",
    });
  });
}

function entryOf(
  entries: readonly DerivationReportEntry[],
  subjectId: string,
  derivationType: string,
): DerivationReportEntry | undefined {
  return entries.find((entry) => entry.subjectId === subjectId && entry.derivationType === derivationType);
}

async function reportOf(
  sdk: Lhc,
  filePath: string,
  owner: "messages" | "turns",
  opts?: { notReady?: boolean },
): Promise<DerivationReportEntry[]> {
  const result =
    owner === "messages" ? await sdk.messages.report({ filePath }, opts) : await sdk.turns.report({ filePath }, opts);
  if (!result.ok) throw new Error(`${owner} report failed: ${result.error.reason}`);
  return result.value;
}

interface MixedFixture extends ServiceFixture {
  filePath: string;
  threadId: string;
  remaining: number;
}

// Every form state landed for real: three prompt turns through intake; the
// first prompt's smoothing stamped failed (Convex smoothing never lands failed
// through the pipeline — it falls back to ready), both closed turns' turn
// derivations blocked by deleting their turn rows before the drain, a bounded
// drain leaving the third prompt's smoothing pending, and the second prompt
// smoothing ready.
async function mixedStateThread(): Promise<MixedFixture> {
  const fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1 } } });
  const { filePath, threadId } = await fixture.createThread();
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "first prompt" } }),
    validEvent("turn_end"),
  ]);
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "second prompt" } }),
    validEvent("turn_end"),
  ]);
  await send(fixture.sdk, filePath, [validEvent("user_prompt", { payload: { text: "third prompt, left open" } })]);
  // Real source damage on both closed turns before the drain claims their
  // derivations.
  await deleteTurns(fixture, threadId, ["t1", "t2"]);
  const drained = await fixture.sdk.work.drain({ filePath }, { maxItems: 4 });
  if (!drained.ok) throw new Error(drained.error.reason);
  // Manufacture the failed smoothing state (the pipeline lands it ready).
  await stampSmoothingFailed(fixture, threadId, "m1");
  return { ...fixture, filePath, threadId, remaining: drained.value.remaining };
}

describe("TC-4.1 / AC-4.1: every landed form reads back in exactly one of the four states", () => {
  test("ready, failed, pending, and blocked land and read back; failed carries the stable reason", async () => {
    const fixture = await mixedStateThread();
    const { sdk, filePath } = fixture;
    expect(fixture.remaining).toBe(1);

    const messageEntries = await reportOf(sdk, filePath, "messages");
    const turnEntries = await reportOf(sdk, filePath, "turns");

    const failed = entryOf(messageEntries, "m1", "smoothed_prompt");
    expect(failed?.state).toBe("failed");
    expect(failed?.reason).toBe(MIXED_FAILED_REASON);
    expect(failed?.metadata).toBeUndefined();

    expect(entryOf(messageEntries, "m3", "smoothed_prompt")?.state).toBe("ready");
    expect(entryOf(messageEntries, "m5", "smoothed_prompt")?.state).toBe("pending");
    expect(entryOf(turnEntries, "t1", "turn_rendering")?.state).toBe("blocked");
    expect(entryOf(turnEntries, "t1", "turn_rendering")?.reason).toContain("source_damaged");

    // Exactly one of the four states on every row, both owners.
    for (const entry of [...messageEntries, ...turnEntries]) {
      expect(["pending", "ready", "failed", "blocked"]).toContain(entry.state);
    }
  });
});

describe("TC-4.3 / AC-4.3: owner scoping is exact and notReady is exact set equality", () => {
  test("each owner reports only its own forms; notReady returns exactly the failed+pending+blocked set", async () => {
    const fixture = await mixedStateThread();
    const { sdk, filePath } = fixture;

    const messageEntries = await reportOf(sdk, filePath, "messages");
    expect(messageEntries.every((entry) => entry.subjectKind === "message")).toBe(true);
    expect(messageEntries.map((entry) => [entry.subjectId, entry.state])).toEqual([
      ["m1", "failed"],
      ["m3", "ready"],
      ["m5", "pending"],
    ]);

    const turnEntries = await reportOf(sdk, filePath, "turns");
    expect(turnEntries.every((entry) => entry.subjectKind === "turn" || entry.subjectKind === "chunk")).toBe(true);
    expect(turnEntries.map((entry) => [entry.subjectId, entry.derivationType, entry.state])).toEqual([
      ["t1", "pre_detailed_assembly", "blocked"],
      ["t1", "turn_rendering", "blocked"],
      ["t2", "pre_detailed_assembly", "blocked"],
      ["t2", "turn_rendering", "blocked"],
    ]);

    // notReady: exactly the non-ready set — m3's ready row drops, nothing else.
    const notReadyMessages = await reportOf(sdk, filePath, "messages", { notReady: true });
    expect(notReadyMessages.map((entry) => [entry.subjectId, entry.state])).toEqual([
      ["m1", "failed"],
      ["m5", "pending"],
    ]);
    const notReadyTurns = await reportOf(sdk, filePath, "turns", { notReady: true });
    expect(notReadyTurns).toHaveLength(4);
    expect(notReadyTurns.every((entry) => entry.state === "blocked")).toBe(true);

    // Subject filters scope to exactly the named subject's forms.
    const oneMessage = await sdk.messages.report({ filePath }, { messageId: "m1" });
    expect(oneMessage.ok && oneMessage.value.map((entry) => entry.subjectId)).toEqual(["m1"]);
    const oneTurn = await sdk.turns.report({ filePath }, { turnId: "t2" });
    expect(oneTurn.ok && oneTurn.value.map((entry) => entry.subjectId)).toEqual(["t2", "t2"]);
  });

  test("chunk summaries report under the turns owner, never under messages", async () => {
    // Policy 1/1: every turn's compression meets max, so each turn closes its
    // own chunk immediately and both summary kinds queue and run. The second
    // chunk's brief summary is stamped failed (a scripted first-call failure
    // would land on c1; the failed-not-blocked contract is the same for c2).
    const failFixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const target = await failFixture.createThread();
    await send(failFixture.sdk, target.filePath, [
      validEvent("user_prompt", { payload: { text: "chunk one prompt" } }),
      validEvent("assistant_text", { payload: { text: "chunk one answer" } }),
      validEvent("turn_end"),
    ]);
    await send(failFixture.sdk, target.filePath, [
      validEvent("user_prompt", { payload: { text: "chunk two prompt" } }),
      validEvent("assistant_text", { payload: { text: "chunk two answer" } }),
      validEvent("turn_end"),
    ]);
    await failFixture.sdk.work.drain({ filePath: target.filePath });
    await stampChunkBriefFailed(failFixture, target.threadId, "c2");

    const turnEntries = await reportOf(failFixture.sdk, target.filePath, "turns");
    // The turns owner spans the turn and chunk scopes; the client reports each
    // scope separately, so chunk forms are gathered through the per-chunk
    // report.
    const chunkEntries: DerivationReportEntry[] = [];
    for (const chunkId of ["c1", "c2"]) {
      const report = await failFixture.sdk.turns.report({ filePath: target.filePath }, { chunkId });
      if (!report.ok) throw new Error(report.error.reason);
      chunkEntries.push(...report.value);
    }
    expect(chunkEntries.map((entry) => [entry.subjectId, entry.derivationType, entry.state])).toEqual([
      ["c1", "chunk_summary_brief", "ready"],
      ["c1", "chunk_summary_detailed", "ready"],
      ["c2", "chunk_summary_brief", "failed"],
      ["c2", "chunk_summary_detailed", "ready"],
    ]);

    const notReady = await reportOf(failFixture.sdk, target.filePath, "turns", { notReady: true });
    // The turn-scope notReady report carries only turn forms; the failed chunk
    // brief is reported through the chunk scope.
    const chunkNotReady = await failFixture.sdk.turns.report(
      { filePath: target.filePath },
      { chunkId: "c2", notReady: true },
    );
    expect(notReady.every((entry) => entry.subjectKind === "turn")).toBe(true);
    expect(
      chunkNotReady.ok && chunkNotReady.value.map((entry) => [entry.subjectId, entry.derivationType, entry.state]),
    ).toEqual([["c2", "chunk_summary_brief", "failed"]]);

    // Cross-owner leakage check, both directions.
    const messageEntries = await reportOf(failFixture.sdk, target.filePath, "messages");
    expect(messageEntries.every((entry) => entry.subjectKind === "message")).toBe(true);
    expect(turnEntries.some((entry) => entry.subjectKind === "message")).toBe(false);

    // The chunk filter scopes to exactly the named chunk's summary forms.
    const oneChunk = await failFixture.sdk.turns.report({ filePath: target.filePath }, { chunkId: "c2" });
    expect(oneChunk.ok && oneChunk.value.map((entry) => [entry.subjectId, entry.derivationType])).toEqual([
      ["c2", "chunk_summary_brief"],
      ["c2", "chunk_summary_detailed"],
    ]);
  });
});

describe("TC-4.4 / AC-4.4: derive through the owning surface lands the derivation ready with the failure cleared", () => {
  test("messages.derive repairs a failed smoothing synchronously", async () => {
    const fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1 } } });
    const { filePath, threadId } = await fixture.createThread();
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "gapped prompt" } }),
      validEvent("assistant_text", { payload: { text: "gapped answer" } }),
      validEvent("turn_end"),
    ]);
    await fixture.sdk.work.drain({ filePath });
    await stampSmoothingFailed(fixture, threadId, "m1");

    expect(await liveWork(fixture, threadId)).toEqual([]);
    const before = entryOf(await reportOf(fixture.sdk, filePath, "messages"), "m1", "smoothed_prompt");
    expect(before?.state).toBe("failed");
    expect(before?.reason).toBe(MIXED_FAILED_REASON);

    const derived = await fixture.sdk.messages.derive({ filePath }, ["m1"]);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.value).toEqual([{ messageId: "m1", outcome: "derived", sourceVersion: 2 }]);

    const repaired = entryOf(await reportOf(fixture.sdk, filePath, "messages"), "m1", "smoothed_prompt");
    expect(repaired?.state).toBe("ready");
    expect(repaired?.sourceVersion).toBe(2);
    expect(repaired?.content).toBeDefined();
    // No failure residue remains.
    expect(repaired?.reason).toBeUndefined();
    expect(await liveWork(fixture, threadId)).toEqual([]);
  });

  test("turns.deriveTurn rebuilds the rendering at the next source version", async () => {
    const fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1 } } });
    const { filePath, threadId } = await fixture.createThread();
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "gapped prompt" } }),
      validEvent("assistant_text", { payload: { text: "gapped answer" } }),
      validEvent("turn_end"),
    ]);
    await fixture.sdk.work.drain({ filePath });
    await stampSmoothingFailed(fixture, threadId, "m1");
    const beforeRepair = entryOf(await reportOf(fixture.sdk, filePath, "turns"), "t1", "turn_rendering");

    // Repair the dependency first, then rebuild the composition.
    const repairSmoothing = await fixture.sdk.messages.derive({ filePath }, ["m1"]);
    expect(repairSmoothing.ok).toBe(true);
    expect(entryOf(await reportOf(fixture.sdk, filePath, "messages"), "m1", "smoothed_prompt")?.state).toBe("ready");
    // No auto-cascade: the rendering row is still exactly what it was.
    expect(entryOf(await reportOf(fixture.sdk, filePath, "turns"), "t1", "turn_rendering")).toEqual(beforeRepair);

    const rebuild = await fixture.sdk.turns.deriveTurn({ filePath }, "t1");
    expect(rebuild.ok).toBe(true);
    if (!rebuild.ok) return;
    expect(rebuild.value).toEqual({ turnId: "t1", outcome: "derived", sourceVersion: 2 });
    expect(await liveWork(fixture, threadId)).toEqual([]);
    const rebuilt = entryOf(await reportOf(fixture.sdk, filePath, "turns"), "t1", "turn_rendering");
    expect(rebuilt?.state).toBe("ready");
    expect(rebuilt?.sourceVersion).toBe(2);
    // Both turn derivations ride the one work item: the compression rebuilt too.
    expect(entryOf(await reportOf(fixture.sdk, filePath, "turns"), "t1", "detailed_turn_compression")).toMatchObject({
      state: "ready",
      sourceVersion: 2,
    });
  });
});

describe("TC-4.5 / AC-4.5: derive returns one result per message id", () => {
  test("derives derivable messages and reports non-derivable messages without queue exposure", async () => {
    const fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1 } } });
    const { filePath, threadId } = await fixture.createThread();
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "gapped prompt" } }),
      validEvent("assistant_text", { payload: { text: "gapped answer" } }),
      validEvent("turn_end"),
    ]);
    await fixture.sdk.work.drain({ filePath });
    await stampSmoothingFailed(fixture, threadId, "m1");

    const derived = await fixture.sdk.messages.derive({ filePath }, ["m1", "m2"]);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.value).toEqual([
      { messageId: "m1", outcome: "derived", sourceVersion: 2 },
      { messageId: "m2", outcome: "not_derivable" },
    ]);
    expect(entryOf(await reportOf(fixture.sdk, filePath, "messages"), "m1", "smoothed_prompt")?.state).toBe("ready");
    expect(await liveWork(fixture, threadId)).toEqual([]);
    // One row per form by key — derive left no duplicate artifacts behind.
    const smoothings = (await reportOf(fixture.sdk, filePath, "messages")).filter(
      (form) => form.subjectId === "m1" && form.derivationType === "smoothed_prompt",
    );
    expect(smoothings).toHaveLength(1);
  });
});

describe("TC-4.7 / AC-4.7 (architecture risk): reads degrade, never block", () => {
  test("chunk reads return records with summary-form states attached, including non-ready ones", async () => {
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const { filePath, threadId } = await fixture.createThread();
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "chunk read prompt one" } }),
      validEvent("turn_end"),
    ]);
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "chunk read prompt two" } }),
      validEvent("turn_end"),
    ]);
    await fixture.sdk.work.drain({ filePath });
    await stampChunkBriefFailed(fixture, threadId, "c2");

    const chunksRead = await fixture.sdk.turns.listChunks({ filePath });
    expect(chunksRead.ok).toBe(true);
    if (!chunksRead.ok) return;
    expect(chunksRead.value.map((record) => [record.chunkId, record.status])).toEqual([
      ["c1", "closed"],
      ["c2", "closed"],
    ]);
    expect(chunksRead.value[0]?.memberTurnIds).toEqual(["t1"]);
    const chunkFormStates = chunksRead.value.map((record) =>
      record.derivations?.map((form) => [form.derivationType, form.state]),
    );
    expect(chunkFormStates).toEqual([
      [
        ["chunk_summary_brief", "ready"],
        ["chunk_summary_detailed", "ready"],
      ],
      [
        ["chunk_summary_brief", "failed"],
        ["chunk_summary_detailed", "ready"],
      ],
    ]);
    // The failed summary's read carries its stored reason — degraded, not
    // blocking, and never an error.
    const failedBrief = chunksRead.value[1]?.derivations?.find((form) => form.derivationType === "chunk_summary_brief");
    expect(failedBrief?.reason).toBe(BRIEF_FAILED_REASON);
  });
});
