// Story 6 (Epic 02): messages.remove — Flow 6.
// Thread-view-level removal with the event log intact: a deleted message
// leaves reads and its turn's membership while its source events stay in
// the Epic 01 read-back (TC-6.1); its own forms drop while the turn and
// chunk clear and re-queue for minus-one composition, the cascade stopping
// exactly at the chunk (TC-6.2). Prompt protection refuses whole-turn removal
// in this slice (TC-6.3). Refusals — open turn, missing id, double
// delete through the filtered view — are stable and change nothing
// (TC-6.7). The CLI parity leg (TC-6.8) lives in
// cli-process-mutations-delete.test.ts (process suite). New file by the
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DrainReport,
  type InferenceCallbacks,
  initLhc,
  intakeStream,
  type Lhc,
  type MessageEventInput,
  messages,
  type OpResult,
  queueDetail,
  type SdkConfig,
  setSchedulerPoke,
  setThreadTouch,
  threads,
  turns,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
  readDerivedForms,
  type TempStore,
  tempStore,
  validEvent,
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
  inferenceCallbacks: InferenceCallbacks,
  overrides: Partial<Pick<SdkConfig, "chunkPolicy" | "clock" | "mode">> = {},
): Lhc {
  const config: SdkConfig = {
    inferenceCallbacks,
    mode: overrides.mode ?? "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 5000 },
    guards: { smoothTurnCompression: { tinyTurnTokens: 1 } },
  };
  if (overrides.chunkPolicy !== undefined) config.chunkPolicy = overrides.chunkPolicy;
  if (overrides.clock !== undefined) config.clock = overrides.clock;
  return initLhc(config);
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
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

function clearKey(entry: { subjectKind: string; subjectId: string; derivationType: string }): string {
  return `${entry.subjectKind}/${entry.subjectId}/${entry.derivationType}`;
}

function unwrap<T>(result: OpResult<T>): T {
  if (!result.ok) throw new Error(`expected ok result, got ${result.error.code}`);
  return result.value;
}

// The full mutation read-back surface in one snapshot — record, membership,
// chunks, events, forms, queue — for refusal-changes-nothing assertions.
async function snapshot(filePath: string): Promise<unknown> {
  return {
    messages: unwrap(await messages.list({ filePath })),
    turns: unwrap(await turns.listTurns({ filePath })),
    chunks: unwrap(await turns.listChunks({ filePath })),
    events: unwrap(await intakeStream.listEvents({ filePath })),
    derivations: readDerivedForms(filePath),
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

describe("TC-6.1 / AC-6.1: a deleted message leaves reads and membership; its events remain", () => {
  it("deleting a tool-result message removes it from message reads and turn membership, not from event read-back", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await toolRunThread(sdk);
    const eventsBefore = unwrap(await intakeStream.listEvents({ filePath }));

    const result = await messages.remove({ filePath }, { messageId: "m3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changed).toEqual({ messageIds: ["m3"], turnIds: [] });

    // Message reads exclude the deleted record.
    const records = unwrap(await messages.list({ filePath }));
    expect(records.map((record) => record.messageId)).toEqual(["m1", "m2", "m4"]);

    // Turn membership shrinks in place — the turn row and its boundaries
    // untouched, the deleted member filtered out.
    const turnRecords = unwrap(await turns.listTurns({ filePath }));
    expect(turnRecords).toHaveLength(2);
    expect(turnRecords[0]?.memberMessageIds).toEqual(["m1", "m2", "m4"]);

    // The audit surface is deliberately unfiltered: every source event,
    // byte-identical, including the deleted message's.
    expect(unwrap(await intakeStream.listEvents({ filePath }))).toEqual(eventsBefore);
    expect(eventsBefore.some((event) => event.eventKind === "tool_result")).toBe(true);
  });
});

describe("TC-6.2 / AC-6.2 (architecture risk): delete drops own forms, re-queues upward, stops at the chunk", () => {
  it("the deleted message's forms are gone, its turn and chunk re-queue, chunk 2 is byte-stable", async () => {
    const double = createInferenceCallbacksDouble();
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

    const result = await messages.remove({ filePath }, { messageId: "m3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The subject's own forms drop; the chain above clears. Tool calls render
    // as recorded and have no summary row to clear or requeue.
    expect(result.value.dropped.map(clearKey)).toEqual(["message/m3/tool_result_summary"]);
    expect(result.value.cleared.map(clearKey).sort()).toEqual(
      [
        "turn/t1/smooth_turn_compression",
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
    // Everything else — m1's message form, t2's forms, chunk 2's summaries —
    // deep-equals its pre-delete row, source version included.
    expect(after.filter((form) => !clearedSet.has(clearKey(form)))).toEqual(
      before.filter((form) => !clearedSet.has(clearKey(form)) && form.subjectId !== "m3"),
    );

    // The rebuild re-derives the affected turn: turn_rendering is deterministic
    // (AC-6.3), so the proof it re-ran is a compressSmoothTurn call carrying the
    // re-rendered text (the live-members-only filter is exercised by the ready
    // check above and m3's absence throughout).
    const captured = double.captureInputs();
    await drain(sdk, filePath);
    expect(readDerivedForms(filePath).every((form) => form.state === "ready")).toBe(true);
    expect(captured.some((call) => call.op === "compressSmoothTurn")).toBe(true);
  });
});

describe("TC-6.3 / AC-6.3 (architecture risk): prompt protection refuses unsupported whole-turn removal", () => {
  it("deleting a turn-initiating prompt is refused naming the turn; nothing changes", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await toolRunThread(sdk);
    const before = await snapshot(filePath);

    const result = await messages.remove({ filePath }, { messageId: "m1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("message_initiates_turn");
    expect(result.error.reason).toContain("t1");
    expect(result.error.reason).toContain("whole turn is not supported");

    expect(await snapshot(filePath)).toEqual(before);
  });
});

describe("TC-6.7 / AC-6.7: refusals are stable and change nothing — double delete included", () => {
  it("open-turn target, bogus id, and a second delete of the same id refuse with stable codes; the record is identical after each", async () => {
    const double = createInferenceCallbacksDouble();
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
    const openTurn = await messages.remove({ filePath }, { messageId: "m4" });
    expect(openTurn.ok).toBe(false);
    if (openTurn.ok) return;
    expect(openTurn.error.errorClass).toBe("caller_error");
    expect(openTurn.error.code).toBe("turn_open");
    expect(await snapshot(filePath)).toEqual(before);

    // Unknown id.
    const missing = await messages.remove({ filePath }, { messageId: "m99" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("message_not_found");
    expect(await snapshot(filePath)).toEqual(before);

    // Double delete: the first succeeds; the second reads the filtered view
    // and refuses as message_not_found — a refusal, not a silent success,
    // and not a tombstone-aware error branch.
    const firstDelete = await messages.remove({ filePath }, { messageId: "m2" });
    expect(firstDelete.ok).toBe(true);
    const afterDelete = await snapshot(filePath);
    const secondDelete = await messages.remove({ filePath }, { messageId: "m2" });
    expect(secondDelete.ok).toBe(false);
    if (secondDelete.ok) return;
    expect(secondDelete.error.errorClass).toBe("caller_error");
    expect(secondDelete.error.code).toBe("message_not_found");
    expect(await snapshot(filePath)).toEqual(afterDelete);
  });
});

describe("background mode: delete-and-walk-away (production path)", () => {
  it("the cascade's enqueue pokes ride the commit; the minus-one rebuild runs with no further call", async () => {
    const double = createInferenceCallbacksDouble();
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

    const result = await messages.remove({ filePath }, { messageId: "m3" });
    expect(result.ok).toBe(true);
    await sdk.drainSettled({ filePath });

    const turnForms = readDerivedForms(filePath).filter((form) => form.subjectId === "t1");
    expect(turnForms).toHaveLength(2);
    expect(turnForms.every((form) => form.state === "ready" && form.sourceVersion === 2)).toBe(true);
    expect(rawDetail(filePath)).toEqual([]);
  });
});
