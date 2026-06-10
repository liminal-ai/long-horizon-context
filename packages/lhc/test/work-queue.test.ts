// Story 5 (Chunk 5): derivation work queueing. TC-2.6 (complete batch
// result), TC-2.7/TC-2.9 (message-owned work and its kind gate), the work
// halves of TC-3.3/TC-3.6 (Story 4's named debt, paid here), TC-3.8's
// two-work-items assertion, TC-5.4's no-work-item clause, and the two
// architecture-risk regressions: restart survival extended to work items and
// the complete-surface rollback. Work items are asserted through the owning
// domains' listQueuedWork read-back and openRaw — never through the batch
// result alone. The work-queue util has no public SDK surface; everything
// here enters through the SDK or the in-process CLI.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  intakeStream,
  messages,
  runCli,
  threads,
  turns,
  type MessageEventInput,
  type WorkItemRecord,
} from "../src/index.js";
import {
  openRaw,
  setIntakeClock,
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
  setIntakeClock(null);
});

async function createThread(): Promise<string> {
  const filePath = store.threadPath();
  const created = await threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  return filePath;
}

async function send(filePath: string, batch: MessageEventInput[]) {
  const result = await intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`fixture batch failed: ${result.error.reason}`);
  return result.value;
}

async function queuedFor(
  filePath: string,
  owner: "messages" | "turns",
): Promise<WorkItemRecord[]> {
  const result =
    owner === "messages"
      ? await messages.listQueuedWork({ filePath })
      : await turns.listQueuedWork({ filePath });
  if (!result.ok) throw new Error(`queued-work read-back failed: ${result.error.reason}`);
  return result.value;
}

// Below-SDK count of durable work-item rows: the batch result alone is not
// proof of durability (anti-shim requirement).
function rawWorkItemCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM work_item").get() as { n: number | bigint };
    return Number(row.n);
  } finally {
    db.close();
  }
}

// Full logical read-back across every record kind the epic owns — the
// complete-surface rollback regression compares this whole.
async function readBack(filePath: string) {
  const [events, projected, turnRecords, messageWork, turnWork] = await Promise.all([
    intakeStream.listEvents({ filePath }),
    messages.listMessages({ filePath }),
    turns.listTurns({ filePath }),
    messages.listQueuedWork({ filePath }),
    turns.listQueuedWork({ filePath }),
  ]);
  if (!events.ok || !projected.ok || !turnRecords.ok || !messageWork.ok || !turnWork.ok) {
    throw new Error("read-back failed");
  }
  return {
    events: events.value,
    messages: projected.value,
    turns: turnRecords.value,
    messageWork: messageWork.value,
    turnWork: turnWork.value,
  };
}

const FIXED_INSTANT = "2026-06-10T12:00:00.000Z";

describe("Flow 2 (SDK): message-owned work queueing", () => {
  it("TC-2.7: a prompt and a tool result each durably queue their kind, owner messages (AC-2.8)", async () => {
    setIntakeClock(() => new Date(FIXED_INSTANT));
    const filePath = await createThread();
    const result = await send(filePath, [validEvent("user_prompt"), validEvent("tool_result")]);

    // The batch result reports both items with full identity.
    expect(result.queuedWork).toContainEqual({
      workItemId: "w-m1-prompt_smoothing",
      owner: "messages",
      kind: "prompt_smoothing",
      sourceRef: { messageId: "m1" },
    });
    expect(result.queuedWork).toContainEqual({
      workItemId: "w-m2-tool_result_summary",
      owner: "messages",
      kind: "tool_result_summary",
      sourceRef: { messageId: "m2" },
    });

    // Durable read-back through the owning domain: deterministic ids, status
    // queued, queuedAt from the injected clock.
    expect(await queuedFor(filePath, "messages")).toEqual([
      {
        workItemId: "w-m1-prompt_smoothing",
        owner: "messages",
        kind: "prompt_smoothing",
        sourceRef: { messageId: "m1" },
        status: "queued",
        queuedAt: FIXED_INSTANT,
      },
      {
        workItemId: "w-m2-tool_result_summary",
        owner: "messages",
        kind: "tool_result_summary",
        sourceRef: { messageId: "m2" },
        status: "queued",
        queuedAt: FIXED_INSTANT,
      },
    ]);

    // The prompt opened a turn that is still open: no turn-owned work yet,
    // and each domain reads back only its own items.
    expect(await queuedFor(filePath, "turns")).toEqual([]);
    expect(rawWorkItemCount(filePath)).toBe(2);
  });

  it("TC-2.9: text, thinking, and note messages queue nothing — the kind gate is exact (AC-2.8)", async () => {
    const filePath = await createThread();
    const result = await send(filePath, [
      validEvent("assistant_text"),
      validEvent("assistant_thinking"),
      validEvent("runtime_note"),
    ]);
    expect(result.queuedWork).toEqual([]);
    expect(await queuedFor(filePath, "messages")).toEqual([]);
    expect(await queuedFor(filePath, "turns")).toEqual([]);
    expect(rawWorkItemCount(filePath)).toBe(0);
  });

  it("TC-2.6: a mixed batch's result is complete — outcomes, messageIds, transitions, queuedWork, position (AC-2.7)", async () => {
    const filePath = await createThread();
    const original = validEvent("user_prompt");
    await send(filePath, [original]);

    const result = await send(filePath, [
      original, // duplicate: skipped
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);

    expect(result.events).toEqual([
      {
        idempotencyKey: original.idempotencyKey,
        outcome: "skipped",
        skipReason: "duplicate_idempotency_key",
      },
      expect.objectContaining({ outcome: "recorded", messageId: "m2" }),
      expect.objectContaining({ outcome: "recorded" }),
    ]);
    // turn_end produces no message.
    expect(result.events[2]).not.toHaveProperty("messageId");
    expect(result.turnTransitions).toEqual([{ action: "closed", turnId: "t1" }]);
    expect(result.queuedWork).toEqual([
      {
        workItemId: "w-t1-turn_derivation",
        owner: "turns",
        kind: "turn_derivation",
        sourceRef: { turnId: "t1" },
      },
    ]);
    expect(result.threadPosition).toEqual({ lastEventOrder: 3 });
  });
});

describe("Flow 3 (SDK): turn-owned work queueing — Story 4's debt paid", () => {
  it("TC-3.3 (work half): explicit close durably queues w-t1-turn_derivation, owner turns (AC-3.4, AC-3.6)", async () => {
    setIntakeClock(() => new Date(FIXED_INSTANT));
    const filePath = await createThread();
    const result = await send(filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);

    expect(result.queuedWork).toContainEqual({
      workItemId: "w-t1-turn_derivation",
      owner: "turns",
      kind: "turn_derivation",
      sourceRef: { turnId: "t1" },
    });
    expect(await queuedFor(filePath, "turns")).toEqual([
      {
        workItemId: "w-t1-turn_derivation",
        owner: "turns",
        kind: "turn_derivation",
        sourceRef: { turnId: "t1" },
        status: "queued",
        queuedAt: FIXED_INSTANT,
      },
    ]);
  });

  it("TC-3.6 (work half): implicit close queues the same work-item contract as the explicit path (AC-3.6)", async () => {
    const explicitPath = await createThread();
    await send(explicitPath, [validEvent("user_prompt"), validEvent("assistant_text")]);
    await send(explicitPath, [validEvent("turn_end")]);

    const implicitPath = await createThread();
    await send(implicitPath, [validEvent("user_prompt"), validEvent("assistant_text")]);
    await send(implicitPath, [validEvent("user_prompt")]);

    const explicitItems = await queuedFor(explicitPath, "turns");
    const implicitItems = await queuedFor(implicitPath, "turns");
    expect(explicitItems).toHaveLength(1);
    // Same item contract modulo queuedAt (wall clock differs between runs).
    const contract = (items: WorkItemRecord[]) =>
      items.map(({ queuedAt: _queuedAt, ...rest }) => rest);
    expect(contract(implicitItems)).toEqual(contract(explicitItems));
    expect(contract(explicitItems)).toEqual([
      {
        workItemId: "w-t1-turn_derivation",
        owner: "turns",
        kind: "turn_derivation",
        sourceRef: { turnId: "t1" },
        status: "queued",
      },
    ]);
  });

  it("TC-3.8 (work count): a multi-turn batch queues one turn_derivation item per closed turn (AC-3.6)", async () => {
    const filePath = await createThread();
    await send(filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);

    const turnWork = await queuedFor(filePath, "turns");
    expect(turnWork.map((item) => item.workItemId)).toEqual([
      "w-t1-turn_derivation",
      "w-t2-turn_derivation",
    ]);
    expect(turnWork.every((item) => item.kind === "turn_derivation")).toBe(true);
    expect(turnWork.every((item) => item.status === "queued")).toBe(true);
  });

  it("TC-5.4 (no-work-item clause): a skipped event queues nothing (AC-5.4)", async () => {
    const filePath = await createThread();
    const prompt = validEvent("user_prompt");
    const end = validEvent("turn_end");
    await send(filePath, [prompt, validEvent("assistant_text"), end]);
    await send(filePath, [validEvent("user_prompt")]); // t2 now open
    const baseline = await readBack(filePath);
    const baselineCount = rawWorkItemCount(filePath);

    const resend = await send(filePath, [prompt, end]);
    expect(resend.events.map((entry) => entry.outcome)).toEqual(["skipped", "skipped"]);
    expect(resend.queuedWork).toEqual([]);
    expect(await readBack(filePath)).toEqual(baseline);
    expect(rawWorkItemCount(filePath)).toBe(baselineCount);
  });
});

describe("architecture-risk: durability and rollback over the complete record surface", () => {
  it("restart survival: a reopened thread file holds its work items intact, status queued", async () => {
    const filePath = await createThread();
    await send(filePath, [
      validEvent("user_prompt"),
      validEvent("tool_call"),
      validEvent("tool_result"),
      validEvent("turn_end"),
    ]);
    const before = await readBack(filePath);
    expect(before.messageWork).toHaveLength(2);
    expect(before.turnWork).toHaveLength(1);

    // Every SDK operation opens and closes its own handle, so a fresh
    // read-back is a real reopen of the real file. The raw scan proves the
    // rows live in the thread file itself — not an in-memory queue.
    const db = openRaw(filePath);
    try {
      const rows = db
        .prepare("SELECT work_item_id, status FROM work_item ORDER BY work_item_id")
        .all() as unknown as Array<{ work_item_id: string; status: string }>;
      expect(rows).toEqual([
        { work_item_id: "w-m1-prompt_smoothing", status: "queued" },
        { work_item_id: "w-m3-tool_result_summary", status: "queued" },
        { work_item_id: "w-t1-turn_derivation", status: "queued" },
      ]);
    } finally {
      db.close();
    }
    expect(await readBack(filePath)).toEqual(before);
  });

  it("complete-surface rollback: a rejected batch leaves events, messages, turns, and work items at baseline (AC-4.6)", async () => {
    const filePath = await createThread();
    await send(filePath, [validEvent("user_prompt"), validEvent("tool_result"), validEvent("turn_end")]);
    const baseline = await readBack(filePath);
    const baselineCount = rawWorkItemCount(filePath);

    // A valid prefix that would queue work, then one invalid event: the
    // batch must reject whole and queue nothing.
    const rejected = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      { ...validEvent("user_prompt"), eventKind: "bogus" } as unknown as MessageEventInput,
    ]);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe("invalid_event");

    expect(await readBack(filePath)).toEqual(baseline);
    expect(rawWorkItemCount(filePath)).toBe(baselineCount);
  });
});

describe("CLI in-process: list-queued-work on both owning domains", () => {
  it("messages list-queued-work and turns list-queued-work each return only their owner's items", async () => {
    const filePath = await createThread();
    await send(filePath, [validEvent("user_prompt"), validEvent("turn_end")]);

    const messagesListed = await runCli(["messages", "list-queued-work", "--file-path", filePath]);
    expect(messagesListed.exitCode).toBe(0);
    const messagesParsed = JSON.parse(messagesListed.stdout) as {
      ok: boolean;
      value: WorkItemRecord[];
    };
    expect(messagesParsed.ok).toBe(true);
    expect(messagesParsed.value).toHaveLength(1);
    expect(messagesParsed.value[0]).toMatchObject({
      workItemId: "w-m1-prompt_smoothing",
      owner: "messages",
      kind: "prompt_smoothing",
      sourceRef: { messageId: "m1" },
      status: "queued",
    });

    const turnsListed = await runCli(["turns", "list-queued-work", "--file-path", filePath]);
    expect(turnsListed.exitCode).toBe(0);
    const turnsParsed = JSON.parse(turnsListed.stdout) as {
      ok: boolean;
      value: WorkItemRecord[];
    };
    expect(turnsParsed.ok).toBe(true);
    expect(turnsParsed.value).toHaveLength(1);
    expect(turnsParsed.value[0]).toMatchObject({
      workItemId: "w-t1-turn_derivation",
      owner: "turns",
      kind: "turn_derivation",
      sourceRef: { turnId: "t1" },
      status: "queued",
    });
  });

  it("list-queued-work on an unknown thread id fails with thread_not_found", async () => {
    const listed = await runCli([
      "messages",
      "list-queued-work",
      "--thread-id",
      "th_nope",
      "--registry",
      store.registryPath,
    ]);
    expect(listed.exitCode).toBe(1);
    const parsed = JSON.parse(listed.stdout) as { ok: boolean; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("thread_not_found");
  });
});
