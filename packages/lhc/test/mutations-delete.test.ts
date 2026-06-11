// Story 6 (Epic 02): messages.deleteMessage and turns.deleteTurn — Flow 6.
// Projection-level removal with the event log intact: a deleted message
// leaves reads and its turn's membership while its source events stay in
// the Epic 01 read-back (TC-6.1); its own forms drop while the turn and
// chunk clear and re-queue for minus-one composition, the cascade stopping
// exactly at the chunk (TC-6.2). Prompt protection routes whole-exchange
// intent to the turn surface (TC-6.3), where deleteTurn removes the turn
// and all its messages from reads and chunk membership (TC-6.4), re-derives
// the chunk's summaries from the remaining members without moving a
// boundary (TC-6.5, architecture risk: the captureInputs assertion proves
// the composition read path is deleted-filtered), and an emptied-out chunk
// drops its summary forms — absent, never failed, no rebuild queued
// (TC-6.6, architecture risk). Refusals — open turn, missing id, double
// delete through the filtered view — are stable and change nothing
// (TC-6.7). The CLI parity leg (TC-6.8) lives in
// cli-process-mutations-delete.test.ts (process suite). New file by the
// red-manifest rule: mutations.test.ts is hash-locked by Story 5.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSdk,
  estimateTokens,
  intakeStream,
  messages,
  queueDetail,
  setSchedulerPoke,
  setThreadTouch,
  threads,
  turns,
  type DerivationProvider,
  type DrainReport,
  type Lhc,
  type MessageEventInput,
  type ProviderResult,
  type SdkConfig,
  type OpResult,
} from "../src/index.js";
import {
  createProviderDouble,
  openRaw,
  readChunks,
  readDerivedForms,
  tempStore,
  validEvent,
  type TempStore,
} from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
  setSchedulerPoke(null);
  setThreadTouch(null);
});

async function newThread(): Promise<string> {
  const created = await threads.newThread({
    filePath: store.threadPath(),
    registryPath: store.registryPath,
  });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  return created.value.filePath;
}

function manualSdk(
  provider: DerivationProvider,
  overrides: Partial<Pick<SdkConfig, "chunkPolicy" | "clock" | "mode">> = {},
): Lhc {
  const config: SdkConfig = {
    provider,
    mode: overrides.mode ?? "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 5000 },
  };
  if (overrides.chunkPolicy !== undefined) config.chunkPolicy = overrides.chunkPolicy;
  if (overrides.clock !== undefined) config.clock = overrides.clock;
  return createSdk(config);
}

async function send(
  sdk: Lhc,
  filePath: string,
  batch: readonly MessageEventInput[],
): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`batch failed: ${result.error.reason}`);
}

async function drain(sdk: Lhc, filePath: string): Promise<DrainReport> {
  const result = await sdk.work.drain({ filePath });
  if (!result.ok) throw new Error(`drain failed: ${result.error.reason}`);
  return result.value;
}

function rawDetail(filePath: string): ReturnType<typeof queueDetail> {
  const db = openRaw(filePath);
  try {
    return queueDetail(db);
  } finally {
    db.close();
  }
}

function clearKey(entry: { subjectKind: string; subjectId: string; form: string }): string {
  return `${entry.subjectKind}/${entry.subjectId}/${entry.form}`;
}

function unwrap<T>(result: OpResult<T>): T {
  if (!result.ok) throw new Error(`expected ok result, got ${result.error.code}`);
  return result.value;
}

// The full mutation read-back surface in one snapshot — record, membership,
// chunks, events, forms, queue — for refusal-changes-nothing assertions.
async function snapshot(filePath: string): Promise<unknown> {
  return {
    messages: unwrap(await messages.listMessages({ filePath })),
    turns: unwrap(await turns.listTurns({ filePath })),
    chunks: unwrap(await turns.listChunks({ filePath })),
    events: unwrap(await intakeStream.listEvents({ filePath })),
    forms: readDerivedForms(filePath),
    queue: rawDetail(filePath),
  };
}

// One closed turn carrying a full tool run — m1 prompt, m2 tool_call,
// m3 tool_result, m4 assistant_text — drained ready. Under the default
// chunk policy t1's chunk stays open, so no chunk summary rows exist.
async function toolRunThread(sdk: Lhc): Promise<string> {
  const filePath = await newThread();
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "use the tool" } }),
    validEvent("tool_call"),
    validEvent("tool_result"),
    validEvent("assistant_text", { payload: { text: "tool run done" } }),
    validEvent("turn_end"),
  ]);
  await drain(sdk, filePath);
  return filePath;
}

// Scripted lower-band projections of a fixed size, every other operation on
// the deterministic double — the TC-3.6 pattern for exact chunk membership.
const PROJ = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
function withScriptedProjections(base: DerivationProvider): DerivationProvider {
  return {
    smoothPrompt: (i) => base.smoothPrompt(i),
    summarizeToolCall: (i) => base.summarizeToolCall(i),
    summarizeToolResult: (i) => base.summarizeToolResult(i),
    composeTurnRendering: (i) => base.composeTurnRendering(i),
    projectLowerBand: (): Promise<ProviderResult> =>
      Promise.resolve({ ok: true, text: PROJ }),
    summarizeChunkDetailed: (i) => base.summarizeChunkDetailed(i),
    summarizeChunkBrief: (i) => base.summarizeChunkBrief(i),
  };
}

// Prompt+answer turns sized so chunks close at exactly two members:
// target 2·per+1 means the third turn's placement closes the chunk holding
// the first two (TC-3.6's golden case, reused as this story's fixture).
function twoTurnChunkSdk(double: DerivationProvider): Lhc {
  const per = estimateTokens(PROJ);
  return manualSdk(withScriptedProjections(double), {
    chunkPolicy: { targetProjectedTokens: 2 * per + 1, maxProjectedTokens: 100 * per },
  });
}

async function sendPromptTurn(sdk: Lhc, filePath: string, n: number): Promise<void> {
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: `prompt ${n}` } }),
    validEvent("assistant_text", { payload: { text: `answer ${n}` } }),
    validEvent("turn_end"),
  ]);
}

describe("TC-6.1 / AC-6.1: a deleted message leaves reads and membership; its events remain", () => {
  it("deleting a tool-result message removes it from message reads and turn membership, not from event read-back", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const filePath = await toolRunThread(sdk);
    const eventsBefore = unwrap(await intakeStream.listEvents({ filePath }));

    const result = await messages.deleteMessage({ filePath }, { messageId: "m3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changed).toEqual({ messageIds: ["m3"], turnIds: [] });

    // Message reads exclude the deleted record.
    const records = unwrap(await messages.listMessages({ filePath }));
    expect(records.map((record) => record.messageId)).toEqual(["m1", "m2", "m4"]);

    // Turn membership shrinks in place — the turn row and its boundaries
    // untouched, the deleted member filtered out.
    const turnRecords = unwrap(await turns.listTurns({ filePath }));
    expect(turnRecords).toHaveLength(1);
    expect(turnRecords[0]?.memberMessageIds).toEqual(["m1", "m2", "m4"]);

    // The audit surface is deliberately unfiltered: every source event,
    // byte-identical, including the deleted message's.
    expect(unwrap(await intakeStream.listEvents({ filePath }))).toEqual(eventsBefore);
    expect(eventsBefore.some((event) => event.eventKind === "tool_result")).toBe(true);
  });
});

describe("TC-6.2 / AC-6.2 (architecture risk): delete drops own forms, re-queues upward, stops at the chunk", () => {
  it("the deleted message's forms are gone, its turn and chunk re-queue, chunk 2 is byte-stable", async () => {
    const double = createProviderDouble();
    // max=1: every turn forms its own immediately closed chunk — two
    // chunks, both with summaries (the TC-5.2 reach fixture).
    const sdk = manualSdk(double, {
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const filePath = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "first prompt" } }),
      validEvent("tool_call"),
      validEvent("tool_result"),
      validEvent("assistant_text", { payload: { text: "first answer" } }),
      validEvent("turn_end"),
    ]);
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "second prompt" } }),
      validEvent("assistant_text", { payload: { text: "second answer" } }),
      validEvent("turn_end"),
    ]);
    await drain(sdk, filePath);
    const before = readDerivedForms(filePath);
    expect(before.every((form) => form.state === "ready")).toBe(true);

    const result = await messages.deleteMessage({ filePath }, { messageId: "m3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The subject's own forms drop; the chain above clears — and nothing
    // outside the chain is named.
    expect(result.value.dropped.map(clearKey)).toEqual(["message/m3/tool_result_summary"]);
    expect(result.value.cleared.map(clearKey).sort()).toEqual(
      [
        "turn/t1/lower_band_projection",
        "turn/t1/turn_rendering",
        "chunk/c1/chunk_summary_brief",
        "chunk/c1/chunk_summary_detailed",
      ].sort(),
    );
    expect(result.value.queued.map((item) => item.workItemId).sort()).toEqual([
      "w-c1-chunk_summary_brief-v2",
      "w-c1-chunk_summary_detailed-v2",
      "w-t1-turn_derivation-v2",
    ]);

    // Dropped means rows removed — no ghost row in any state.
    const after = readDerivedForms(filePath);
    expect(after.some((form) => form.subjectId === "m3")).toBe(false);
    // The cleared half sits pending at the bumped version and queued.
    const clearedSet = new Set(result.value.cleared.map(clearKey));
    for (const form of after.filter((candidate) => clearedSet.has(clearKey(candidate)))) {
      expect(form.state).toBe("pending");
      expect(form.sourceVersion).toBe(2);
    }
    // Everything else — m1's and m2's message forms, t2's forms, chunk 2's
    // summaries — deep-equals its pre-delete row, source version included.
    expect(after.filter((form) => !clearedSet.has(clearKey(form)))).toEqual(
      before.filter(
        (form) => !clearedSet.has(clearKey(form)) && form.subjectId !== "m3",
      ),
    );

    // The rebuild composes minus-one: the production compose path
    // enumerates live members only (the filter at composition, proven by
    // the capture log, not by a read API).
    const captured = double.captureInputs();
    await drain(sdk, filePath);
    expect(readDerivedForms(filePath).every((form) => form.state === "ready")).toBe(true);
    const recompose = captured.filter((call) => call.op === "composeTurnRendering");
    expect(recompose).toHaveLength(1);
    const parts = (recompose[0]?.input as { parts: Array<{ messageId: string }> }).parts;
    expect(parts.map((part) => part.messageId)).toEqual(["m1", "m2", "m4"]);
  });
});

describe("TC-6.3 / AC-6.3 (architecture risk): prompt protection routes to the turn surface", () => {
  it("deleting a turn-initiating prompt is refused naming the turn and the turns-delete path; nothing changes", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const filePath = await toolRunThread(sdk);
    const before = await snapshot(filePath);

    const result = await messages.deleteMessage({ filePath }, { messageId: "m1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("message_initiates_turn");
    // The error names the turn and points at the turn-delete operation.
    expect(result.error.reason).toContain("t1");
    expect(result.error.reason).toContain("turns.deleteTurn");
    expect(result.error.reason).toContain("turns delete");

    expect(await snapshot(filePath)).toEqual(before);
  });
});

describe("TC-6.4 / AC-6.4: turn delete removes the turn and its messages from reads; events remain", () => {
  it("a three-message turn leaves turn reads, message reads, and chunk membership; event read-back is byte-stable", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "kill this exchange" } }),
      validEvent("assistant_text", { payload: { text: "dead end, part one" } }),
      validEvent("assistant_text", { payload: { text: "dead end, part two" } }),
      validEvent("turn_end"),
    ]);
    await drain(sdk, filePath);
    const eventsBefore = unwrap(await intakeStream.listEvents({ filePath }));
    expect(unwrap(await turns.listTurns({ filePath }))[0]?.chunkId).toBe("c1");

    const result = await turns.deleteTurn({ filePath }, { turnId: "t1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changed).toEqual({
      messageIds: ["m1", "m2", "m3"],
      turnIds: ["t1"],
    });
    // The drop-set walk goes down as well as up: the turn's two forms and
    // every member's own forms are rows-removed.
    expect(result.value.dropped.map(clearKey).sort()).toEqual(
      [
        "message/m1/smoothed_prompt",
        "turn/t1/lower_band_projection",
        "turn/t1/turn_rendering",
      ].sort(),
    );

    expect(unwrap(await messages.listMessages({ filePath }))).toEqual([]);
    expect(unwrap(await turns.listTurns({ filePath }))).toEqual([]);
    // Chunk membership shrinks in place: the chunk row remains, its member
    // listing empties, no boundary moves.
    const chunks = unwrap(await turns.listChunks({ filePath }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.memberTurnIds).toEqual([]);

    expect(unwrap(await intakeStream.listEvents({ filePath }))).toEqual(eventsBefore);
    expect(eventsBefore).toHaveLength(4);
  });
});

describe("TC-6.5 / AC-6.5 (architecture risk): the chunk re-derives from remaining members; boundaries never move", () => {
  it("deleting one of chunk 1's two turns rebuilds its summaries from the survivor; chunk 2 and all boundaries are identical", async () => {
    const double = createProviderDouble();
    const sdk = twoTurnChunkSdk(double);
    const filePath = await newThread();
    for (let n = 1; n <= 5; n += 1) await sendPromptTurn(sdk, filePath, n);
    await drain(sdk, filePath);

    // Fixture sanity: c1{t1,t2} and c2{t3,t4} closed with summaries, c3{t5}
    // still open — exact membership by the scripted projection size.
    const chunksBefore = readChunks(filePath);
    expect(chunksBefore.members).toEqual([
      { chunkId: "c1", turnId: "t1", memberIdx: 0 },
      { chunkId: "c1", turnId: "t2", memberIdx: 1 },
      { chunkId: "c2", turnId: "t3", memberIdx: 0 },
      { chunkId: "c2", turnId: "t4", memberIdx: 1 },
      { chunkId: "c3", turnId: "t5", memberIdx: 0 },
    ]);
    const formsBefore = readDerivedForms(filePath);

    const result = await turns.deleteTurn({ filePath }, { turnId: "t1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cleared.map(clearKey).sort()).toEqual([
      "chunk/c1/chunk_summary_brief",
      "chunk/c1/chunk_summary_detailed",
    ]);
    expect(result.value.queued.map((item) => item.workItemId).sort()).toEqual([
      "w-c1-chunk_summary_brief-v2",
      "w-c1-chunk_summary_detailed-v2",
    ]);

    const captured = double.captureInputs();
    await drain(sdk, filePath);

    // The rebuilt summaries read exactly one member projection — the
    // double-input fixture proves the composition input excludes the
    // deleted turn (the read path a read-API assertion would miss).
    const detailed = captured.filter((call) => call.op === "summarizeChunkDetailed");
    const brief = captured.filter((call) => call.op === "summarizeChunkBrief");
    expect(detailed).toHaveLength(1);
    expect(brief).toHaveLength(1);
    expect((detailed[0]?.input as { memberProjections: string[] }).memberProjections).toEqual([
      PROJ,
    ]);
    expect((brief[0]?.input as { memberProjections: string[] }).memberProjections).toEqual([
      PROJ,
    ]);

    const after = readDerivedForms(filePath);
    // Chunk 1's summaries are ready again at the next source version.
    for (const form of after.filter((candidate) => candidate.subjectId === "c1")) {
      expect(form.state).toBe("ready");
      expect(form.sourceVersion).toBe(2);
    }
    // No other chunk's membership or derivations changed: every form
    // outside the deleted turn's chain — the other turns', the other
    // messages', chunk 2's — byte-equals its pre-delete row, and the raw
    // chunk/member tables — the boundaries — are identical (membership
    // only ever shrinks through reads).
    const touched = new Set(["m1", "t1", "c1"]);
    expect(after.filter((form) => !touched.has(form.subjectId))).toEqual(
      formsBefore.filter((form) => !touched.has(form.subjectId)),
    );
    expect(readChunks(filePath)).toEqual(chunksBefore);
    // The live read shrinks: chunk 1 lists only the survivor.
    const liveChunks = unwrap(await turns.listChunks({ filePath }));
    expect(liveChunks.find((chunk) => chunk.chunkId === "c1")?.memberTurnIds).toEqual(["t2"]);
  });
});

describe("TC-6.6 / AC-6.6 (architecture risk): an emptied chunk drops its summaries — absent, never failed", () => {
  it("deleting every turn in a chunk leaves an empty chunk with no summary rows, no queued rebuild, and clean reads", async () => {
    const double = createProviderDouble();
    const sdk = twoTurnChunkSdk(double);
    const filePath = await newThread();
    for (let n = 1; n <= 3; n += 1) await sendPromptTurn(sdk, filePath, n);
    await drain(sdk, filePath);
    expect(readChunks(filePath).members.filter((member) => member.chunkId === "c1")).toHaveLength(
      2,
    );

    const first = await turns.deleteTurn({ filePath }, { turnId: "t1" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // One member left: the chunk clears and re-queues (the TC-6.5 path).
    expect(first.value.queued.map((item) => item.workItemId).sort()).toEqual([
      "w-c1-chunk_summary_brief-v2",
      "w-c1-chunk_summary_detailed-v2",
    ]);

    const second = await turns.deleteTurn({ filePath }, { turnId: "t2" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Empties out: the summary forms drop with the last member — and the
    // first delete's still-queued rebuilds are superseded, not run.
    expect(second.value.cleared).toEqual([]);
    expect(second.value.queued).toEqual([]);
    expect(
      second.value.dropped.filter((entry) => entry.subjectKind === "chunk").map(clearKey).sort(),
    ).toEqual(["chunk/c1/chunk_summary_brief", "chunk/c1/chunk_summary_detailed"]);
    expect([...second.value.superseded].sort()).toEqual([
      "w-c1-chunk_summary_brief-v2",
      "w-c1-chunk_summary_detailed-v2",
    ]);

    // Dropped, never failed: no c1 rows in any state, no failed form
    // anywhere, no live work targeting the empty chunk.
    const forms = readDerivedForms(filePath);
    expect(forms.some((form) => form.subjectId === "c1")).toBe(false);
    expect(forms.some((form) => form.state === "failed")).toBe(false);
    expect(rawDetail(filePath)).toEqual([]);

    // Reads skip the empty chunk without error: it lists with zero members
    // and no form states; a drain finds nothing to do.
    const chunks = unwrap(await turns.listChunks({ filePath }));
    const emptied = chunks.find((chunk) => chunk.chunkId === "c1");
    expect(emptied?.memberTurnIds).toEqual([]);
    expect(emptied?.forms).toBeUndefined();
    expect(unwrap(await turns.listTurns({ filePath })).map((turn) => turn.turnId)).toEqual([
      "t3",
    ]);
    const report = await drain(sdk, filePath);
    expect(report.ran).toEqual([]);
  });
});

describe("TC-6.7 / AC-6.7: refusals are stable and change nothing — double delete included", () => {
  it("open-turn target, bogus id, and a second delete of the same id refuse with stable codes; the record is identical after each", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    // t1 closed {m1 prompt, m2 answer}; t2 open {m4 prompt}.
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "closed prompt" } }),
      validEvent("assistant_text", { payload: { text: "closed answer" } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "open prompt" } }),
    ]);
    await drain(sdk, filePath);
    const before = await snapshot(filePath);

    // Open-turn message: refused under the closed-turn boundary.
    const openTurn = await messages.deleteMessage({ filePath }, { messageId: "m4" });
    expect(openTurn.ok).toBe(false);
    if (openTurn.ok) return;
    expect(openTurn.error.errorClass).toBe("caller_error");
    expect(openTurn.error.code).toBe("turn_open");
    expect(await snapshot(filePath)).toEqual(before);

    // Unknown id.
    const missing = await messages.deleteMessage({ filePath }, { messageId: "m99" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("message_not_found");
    expect(await snapshot(filePath)).toEqual(before);

    // Double delete: the first succeeds; the second reads the filtered view
    // and refuses as message_not_found — a refusal, not a silent success,
    // and not a tombstone-aware error branch.
    const firstDelete = await messages.deleteMessage({ filePath }, { messageId: "m2" });
    expect(firstDelete.ok).toBe(true);
    const afterDelete = await snapshot(filePath);
    const secondDelete = await messages.deleteMessage({ filePath }, { messageId: "m2" });
    expect(secondDelete.ok).toBe(false);
    if (secondDelete.ok) return;
    expect(secondDelete.error.errorClass).toBe("caller_error");
    expect(secondDelete.error.code).toBe("message_not_found");
    expect(await snapshot(filePath)).toEqual(afterDelete);
  });

  it("the turn surface refuses the same way: open turn, bogus id, double delete", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "closed prompt" } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "open prompt" } }),
    ]);
    await drain(sdk, filePath);
    const before = await snapshot(filePath);

    const openTurn = await turns.deleteTurn({ filePath }, { turnId: "t2" });
    expect(openTurn.ok).toBe(false);
    if (openTurn.ok) return;
    expect(openTurn.error.errorClass).toBe("caller_error");
    expect(openTurn.error.code).toBe("turn_open");
    expect(await snapshot(filePath)).toEqual(before);

    const missing = await turns.deleteTurn({ filePath }, { turnId: "t99" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("turn_not_found");
    expect(await snapshot(filePath)).toEqual(before);

    const firstDelete = await turns.deleteTurn({ filePath }, { turnId: "t1" });
    expect(firstDelete.ok).toBe(true);
    const afterDelete = await snapshot(filePath);
    const secondDelete = await turns.deleteTurn({ filePath }, { turnId: "t1" });
    expect(secondDelete.ok).toBe(false);
    if (secondDelete.ok) return;
    expect(secondDelete.error.code).toBe("turn_not_found");
    expect(await snapshot(filePath)).toEqual(afterDelete);
  });

  it("deleting a turn whose messages were individually deleted first still works (live-row membership walk)", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "the prompt" } }),
      validEvent("assistant_text", { payload: { text: "answer one" } }),
      validEvent("assistant_text", { payload: { text: "answer two" } }),
      validEvent("turn_end"),
    ]);
    await drain(sdk, filePath);
    expect((await messages.deleteMessage({ filePath }, { messageId: "m2" })).ok).toBe(true);

    const result = await turns.deleteTurn({ filePath }, { turnId: "t1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the still-live members are stamped now; the earlier delete
    // already removed m2 and dropped its forms.
    expect(result.value.changed).toEqual({ messageIds: ["m1", "m3"], turnIds: ["t1"] });
    expect(unwrap(await messages.listMessages({ filePath }))).toEqual([]);
    expect(unwrap(await turns.listTurns({ filePath }))).toEqual([]);
  });
});

describe("background mode: delete-and-walk-away (production path)", () => {
  it("the cascade's enqueue pokes ride the commit; the minus-one rebuild runs with no further call", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double, { mode: "background" });
    const filePath = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "the prompt" } }),
      validEvent("tool_call"),
      validEvent("tool_result"),
      validEvent("turn_end"),
    ]);
    await sdk.drainSettled({ filePath });
    expect(readDerivedForms(filePath).every((form) => form.state === "ready")).toBe(true);

    const result = await messages.deleteMessage({ filePath }, { messageId: "m3" });
    expect(result.ok).toBe(true);
    await sdk.drainSettled({ filePath });

    const turnForms = readDerivedForms(filePath).filter((form) => form.subjectId === "t1");
    expect(turnForms).toHaveLength(2);
    expect(turnForms.every((form) => form.state === "ready" && form.sourceVersion === 2)).toBe(
      true,
    );
    expect(rawDetail(filePath)).toEqual([]);
  });
});
