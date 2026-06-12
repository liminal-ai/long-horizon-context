// Story 3 (Flow 2, projection half): TC-2.2 through TC-2.5, TC-5.4's
// no-duplicate-message clause, and the projection rung of the rollback ladder
// (an induced projection failure rejects the whole batch). Everything enters
// through the SDK or the in-process CLI; the spawned-CLI leg of TC-2.4 lives
// in cli-process-projection.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  intakeStream,
  messages,
  threads,
  type EventRecord,
  type MessageRecord,
} from "../src/index.js";
import {
  eventBatch,
  openRaw,
  setIntakeWalkHook,
  tempStore,
  validEvent,
  type TempStore,
} from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  setIntakeWalkHook(null);
  store.cleanup();
});

async function createThread(): Promise<string> {
  const filePath = store.threadPath();
  const created = await threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  return filePath;
}

async function readEvents(filePath: string): Promise<EventRecord[]> {
  const result = await intakeStream.listEvents({ filePath });
  if (!result.ok) throw new Error(`event read-back failed: ${result.error.reason}`);
  return result.value;
}

async function readMessages(filePath: string): Promise<MessageRecord[]> {
  const result = await messages.listMessages({ filePath });
  if (!result.ok) throw new Error(`message read-back failed: ${result.error.reason}`);
  return result.value;
}

describe("Flow 2 (SDK): message projection", () => {
  it("TC-2.2: one of each kind projects six messages with kind-appropriate blocks; turn_end stays event-only (AC-2.2, AC-2.3)", async () => {
    const filePath = await createThread();
    const batch = [
      validEvent("user_prompt", { payload: { text: "please summarize the file" } }),
      validEvent("assistant_text", { payload: { text: "the file describes turn handling" } }),
      validEvent("assistant_thinking", { payload: { text: "the request needs the file first" } }),
      validEvent("runtime_note", { payload: { text: "harness reconnected" } }),
      validEvent("tool_call", {
        payload: {
          toolCallId: "call-42",
          toolName: "read_file",
          arguments: { path: "notes.txt", offset: 10 },
        },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call-42", content: "line one\nline two", isError: false },
      }),
      validEvent("turn_end"),
    ];

    const result = await intakeStream.messageEvents({ filePath }, batch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // messageId appears on every recorded message-producing entry, in walk
    // order; the turn_end entry is recorded but carries no messageId.
    expect(result.value.events.map((entry) => entry.outcome)).toEqual(
      Array.from({ length: 7 }, () => "recorded"),
    );
    expect(result.value.events.map((entry) => entry.messageId)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      undefined,
    ]);

    // turn_end is present in the event order but absent from messages.
    expect((await readEvents(filePath)).map((event) => event.eventKind)).toEqual([
      "user_prompt",
      "assistant_text",
      "assistant_thinking",
      "runtime_note",
      "tool_call",
      "tool_result",
      "turn_end",
    ]);

    const projected = await readMessages(filePath);
    expect(projected.map((message) => message.messageId)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
    ]);
    expect(projected.map((message) => message.sourceEventOrder)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(projected.map((message) => message.kind)).toEqual([
      "user_prompt",
      "assistant_text",
      "assistant_thinking",
      "runtime_note",
      "tool_call",
      "tool_result",
    ]);

    // Full block structure per kind, content verbatim — not just block count.
    expect(projected[0]!.blocks).toEqual([
      { blockType: "text", content: { text: "please summarize the file" } },
    ]);
    expect(projected[1]!.blocks).toEqual([
      { blockType: "text", content: { text: "the file describes turn handling" } },
    ]);
    expect(projected[2]!.blocks).toEqual([
      { blockType: "text", content: { text: "the request needs the file first" } },
    ]);
    expect(projected[3]!.blocks).toEqual([
      { blockType: "text", content: { text: "harness reconnected" } },
    ]);
    expect(projected[4]!.blocks).toEqual([
      {
        blockType: "tool_call",
        content: {
          toolCallId: "call-42",
          toolName: "read_file",
          arguments: { path: "notes.txt", offset: 10 },
        },
      },
    ]);
    expect(projected[5]!.blocks).toEqual([
      {
        blockType: "tool_result",
        content: { toolCallId: "call-42", content: "line one\nline two", isError: false },
      },
    ]);

    // Story 4 stamps membership at intake: the prompt opened t1 and every
    // message in the batch belongs to it (turn_end closed it, no message).
    for (const message of projected) {
      expect(message.turnId).toBe("t1");
    }
  });

  it("TC-2.3: identical content in two threads yields identical token estimates; every message carries one (AC-2.4)", async () => {
    const threadA = await createThread();
    const threadB = await createThread();
    const buildBatch = () => [
      validEvent("user_prompt", { payload: { text: "estimate me consistently" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "c1", toolName: "search", arguments: { query: "same query" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "c1", content: "same result content", isError: false },
      }),
    ];

    const inA = await intakeStream.messageEvents({ filePath: threadA }, buildBatch());
    const inB = await intakeStream.messageEvents({ filePath: threadB }, buildBatch());
    expect(inA.ok).toBe(true);
    expect(inB.ok).toBe(true);

    const messagesA = await readMessages(threadA);
    const messagesB = await readMessages(threadB);
    expect(messagesA).toHaveLength(3);
    for (const message of [...messagesA, ...messagesB]) {
      expect(typeof message.tokenEstimate).toBe("number");
      expect(Number.isInteger(message.tokenEstimate)).toBe(true);
      expect(message.tokenEstimate).toBeGreaterThan(0);
    }
    expect(messagesA.map((message) => message.tokenEstimate)).toEqual(
      messagesB.map((message) => message.tokenEstimate),
    );
  });

  it("TC-2.4: a 300KB tool result reads back byte-identical through the SDK (AC-2.5)", async () => {
    const filePath = await createThread();
    // Varied content (unicode included) repeated past any rendering
    // threshold; byte-identity is asserted on the full string, not a length
    // or checksum shortcut.
    const bigContent = "tool output line δσπ 😀 — verbatim?\n".repeat(8000);
    expect(Buffer.byteLength(bigContent, "utf8")).toBeGreaterThan(300_000);

    const result = await intakeStream.messageEvents({ filePath }, [
      validEvent("tool_result", {
        payload: { toolCallId: "big-1", content: bigContent, isError: false },
      }),
    ]);
    expect(result.ok).toBe(true);

    const events = await readEvents(filePath);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventKind).toBe("tool_result");
    if (events[0]!.eventKind !== "tool_result") return;
    expect(events[0]!.payload.content === bigContent).toBe(true);

    const projected = await readMessages(filePath);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.blocks).toHaveLength(1);
    const block = projected[0]!.blocks[0]!;
    expect(block.blockType).toBe("tool_result");
    expect(block.content["content"] === bigContent).toBe(true);
    expect(block.content["toolCallId"]).toBe("big-1");
  });

  it("TC-2.5: actor and harness are recorded as given and carried onto messages (AC-2.6)", async () => {
    const filePath = await createThread();
    const batch = [
      validEvent("user_prompt", { actor: "user:lee", harness: "pi-extension/1.2" }),
      validEvent("assistant_text", { actor: "agent:claude", harness: "claude-code/2.0" }),
    ];
    const result = await intakeStream.messageEvents({ filePath }, batch);
    expect(result.ok).toBe(true);

    const events = await readEvents(filePath);
    expect(events.map((event) => [event.actor, event.harness])).toEqual([
      ["user:lee", "pi-extension/1.2"],
      ["agent:claude", "claude-code/2.0"],
    ]);

    const projected = await readMessages(filePath);
    expect(projected.map((message) => [message.actor, message.harness])).toEqual([
      ["user:lee", "pi-extension/1.2"],
      ["agent:claude", "claude-code/2.0"],
    ]);
  });

  it("TC-5.4 (message clause): a skipped event creates no duplicate message (AC-5.4)", async () => {
    const filePath = await createThread();
    const batch = eventBatch(["user_prompt", "turn_end"]);
    const first = await intakeStream.messageEvents({ filePath }, batch);
    expect(first.ok).toBe(true);
    const baseline = await readMessages(filePath);
    expect(baseline).toHaveLength(1);

    const resend = await intakeStream.messageEvents({ filePath }, batch);
    expect(resend.ok).toBe(true);
    if (!resend.ok) return;
    expect(resend.value.events.every((entry) => entry.outcome === "skipped")).toBe(true);
    expect(resend.value.events.every((entry) => entry.messageId === undefined)).toBe(true);

    expect(await readMessages(filePath)).toEqual(baseline);

    // Below the SDK: exactly one message row per source event order.
    const db = openRaw(filePath);
    try {
      const counts = db
        .prepare("SELECT source_event_order, COUNT(*) AS n FROM message GROUP BY source_event_order")
        .all() as unknown as Array<{ source_event_order: number | bigint; n: number | bigint }>;
      expect(counts).toHaveLength(1);
      expect(Number(counts[0]!.n)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("architecture-risk: an induced projection failure rejects the whole batch — no recorded events without messages", async () => {
    const filePath = await createThread();
    const seeded = await intakeStream.messageEvents({ filePath }, [validEvent("user_prompt")]);
    expect(seeded.ok).toBe(true);
    const baselineEvents = await readEvents(filePath);
    const baselineMessages = await readMessages(filePath);
    expect(baselineEvents).toHaveLength(1);
    expect(baselineMessages).toHaveLength(1);

    // Real mechanism: after the new batch's first event records and projects,
    // the seam drops the block table, so the second event's projection insert
    // fails inside the transaction.
    setIntakeWalkHook((db, eventIndex) => {
      if (eventIndex === 0) db.exec("DROP TABLE message_block");
    });
    const result = await intakeStream.messageEvents(
      { filePath },
      eventBatch(["assistant_text", "assistant_thinking"]),
    );
    setIntakeWalkHook(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("system_error");
    expect(result.error.code).toBe("storage_failure");

    // Read-back state, not the error result alone: events and messages are
    // both at baseline — projection failure stranded no event rows.
    expect(await readEvents(filePath)).toEqual(baselineEvents);
    expect(await readMessages(filePath)).toEqual(baselineMessages);
  });
});
