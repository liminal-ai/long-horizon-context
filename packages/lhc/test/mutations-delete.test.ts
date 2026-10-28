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
    tokenFamily: "o200k",
    inferenceCallbacks,
    mode: overrides.mode ?? "manual",
    lease: { durationMs: 5000 },
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
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

    const records = unwrap(await messages.list({ filePath }));
    expect(records.map((record) => record.messageId)).toEqual(["m1", "m2", "m4"]);

    const turnRecords = unwrap(await turns.listTurns({ filePath }));
    expect(turnRecords).toHaveLength(2);
    expect(turnRecords[0]?.memberMessageIds).toEqual(["m1", "m2", "m4"]);

    expect(unwrap(await intakeStream.listEvents({ filePath }))).toEqual(eventsBefore);
    expect(eventsBefore.some((event) => event.eventKind === "tool_result")).toBe(true);
  });
});

describe("TC-6.2 / AC-6.2 (architecture risk): delete drops own forms, re-queues upward, stops at the chunk", () => {
  it("the deleted message's forms are gone, its turn and chunk re-queue, chunk 2 is byte-stable", async () => {
    const double = createInferenceCallbacksDouble();
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
    expect(result.value.queued.map((item) => item.workItemId).sort()).toEqual([
      "w-c1-chunk_summary_brief-v2",
      "w-c1-chunk_summary_detailed-v2",
      "w-t1-detailed_turn_compression-v2",
      "w-t1-turn_derivation-v2",
    ]);

    const after = readDerivedForms(filePath);
    expect(after.some((form) => form.subjectId === "m3")).toBe(false);
    const clearedSet = new Set(result.value.cleared.map(clearKey));
    for (const form of after.filter((candidate) => clearedSet.has(clearKey(candidate)))) {
      expect(form.state).toBe("pending");
      expect(form.sourceVersion).toBe(2);
    }
    expect(after.filter((form) => !clearedSet.has(clearKey(form)))).toEqual(
      before.filter((form) => !clearedSet.has(clearKey(form)) && form.subjectId !== "m3"),
    );

    const captured = double.captureInputs();
    await drain(sdk, filePath);
    expect(readDerivedForms(filePath).every((form) => form.state === "ready")).toBe(true);
    expect(captured.some((call) => call.op === "compressDetailedTurn")).toBe(true);
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
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "closed prompt" } }),
      validEvent("assistant_text", { payload: { text: "closed answer" } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "open prompt" } }),
    ]);
    await drain(sdk, filePath);
    const before = await snapshot(filePath);

    const openTurn = await messages.remove({ filePath }, { messageId: "m4" });
    expect(openTurn.ok).toBe(false);
    if (openTurn.ok) return;
    expect(openTurn.error.errorClass).toBe("caller_error");
    expect(openTurn.error.code).toBe("turn_open");
    expect(await snapshot(filePath)).toEqual(before);

    const missing = await messages.remove({ filePath }, { messageId: "m99" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("message_not_found");
    expect(await snapshot(filePath)).toEqual(before);

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
    expect(turnForms).toHaveLength(3);
    expect(turnForms.every((form) => form.state === "ready" && form.sourceVersion === 2)).toBe(true);
    expect(rawDetail(filePath)).toEqual([]);
  });
});
