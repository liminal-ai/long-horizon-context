import { beforeEach, describe, expect, test } from "vitest";
import type { EventRecord, Lhc, MessageRecord } from "../src/client/index.js";
import { eventBatch, type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

let fixture: ServiceFixture;
let sdk: Lhc;

beforeEach(() => {
  fixture = serviceFixture();
  sdk = fixture.sdk;
});

async function createThread(): Promise<string> {
  return (await fixture.createThread()).filePath;
}

async function readEvents(filePath: string): Promise<EventRecord[]> {
  const result = await sdk.intakeStream.listEvents({ filePath });
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

async function readMessages(filePath: string): Promise<MessageRecord[]> {
  const result = await sdk.messages.list({ filePath });
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

describe("Flow 2 (SDK): message materialization", () => {
  test("TC-2.2: each kind materializes a kind-appropriate block; turn_end stays event-only", async () => {
    const filePath = await createThread();
    const batch = [
      validEvent("user_prompt", { payload: { text: "please summarize the file" } }),
      validEvent("assistant_text", { payload: { text: "the file describes turn handling" } }),
      validEvent("assistant_thinking", { payload: { text: "the request needs the file first" } }),
      validEvent("runtime_note", { payload: { text: "harness reconnected" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-42", toolName: "read_file", arguments: { path: "notes.txt", offset: 10 } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call-42", content: "line one\nline two", isError: false },
      }),
      validEvent("turn_end"),
    ];
    const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.events.map((entry) => entry.outcome)).toEqual(Array.from({ length: 7 }, () => "recorded"));
    expect(result.value.events.map((entry) => entry.messageId)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      undefined,
    ]);
    expect((await readEvents(filePath)).map((event) => event.eventKind)).toEqual([
      "user_prompt",
      "assistant_text",
      "assistant_thinking",
      "runtime_note",
      "tool_call",
      "tool_result",
      "turn_end",
    ]);
    const materialized = await readMessages(filePath);
    expect(materialized.map((message) => message.messageId)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(materialized.map((message) => message.sourceEventOrder)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(materialized.map((message) => message.kind)).toEqual([
      "user_prompt",
      "assistant_text",
      "assistant_thinking",
      "runtime_note",
      "tool_call",
      "tool_result",
    ]);
    expect(materialized[0]!.blocks).toEqual([{ blockType: "text", content: { text: "please summarize the file" } }]);
    expect(materialized[1]!.blocks).toEqual([
      { blockType: "text", content: { text: "the file describes turn handling" } },
    ]);
    expect(materialized[2]!.blocks).toEqual([
      { blockType: "text", content: { text: "the request needs the file first" } },
    ]);
    expect(materialized[3]!.blocks).toEqual([{ blockType: "text", content: { text: "harness reconnected" } }]);
    expect(materialized[4]!.blocks).toEqual([
      {
        blockType: "tool_call",
        content: { toolCallId: "call-42", toolName: "read_file", arguments: { path: "notes.txt", offset: 10 } },
      },
    ]);
    expect(materialized[5]!.blocks).toEqual([
      {
        blockType: "tool_result",
        content: { toolCallId: "call-42", content: "line one\nline two", isError: false },
      },
    ]);
    for (const message of materialized) expect(message.turnId).toBe("t1");
  });

  test("TC-2.3: identical content in two threads yields identical positive integer token estimates", async () => {
    const threadA = await createThread();
    const threadB = await createThread();
    const buildBatch = () => [
      validEvent("user_prompt", { payload: { text: "estimate me consistently" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "c1", toolName: "search", arguments: { query: "same query" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "c1", content: "same result content", isError: false } }),
    ];
    expect((await sdk.intakeStream.messageEvents({ filePath: threadA }, buildBatch())).ok).toBe(true);
    expect((await sdk.intakeStream.messageEvents({ filePath: threadB }, buildBatch())).ok).toBe(true);
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

  test("TC-2.4: a 300KB tool result reads back byte-identical through the SDK", async () => {
    const filePath = await createThread();
    const bigContent = "tool output line δσπ 😀 — verbatim?\n".repeat(8_000);
    expect(Buffer.byteLength(bigContent, "utf8")).toBeGreaterThan(300_000);
    expect(
      (
        await sdk.intakeStream.messageEvents({ filePath }, [
          validEvent("tool_result", { payload: { toolCallId: "big-1", content: bigContent, isError: false } }),
        ])
      ).ok,
    ).toBe(true);
    const events = await readEvents(filePath);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventKind).toBe("tool_result");
    if (events[0]!.eventKind === "tool_result") expect(events[0]!.payload.content === bigContent).toBe(true);
    const materialized = await readMessages(filePath);
    expect(materialized).toHaveLength(1);
    expect(materialized[0]!.blocks).toHaveLength(1);
    const block = materialized[0]!.blocks[0]!;
    expect(block.blockType).toBe("tool_result");
    expect(block.content["content"] === bigContent).toBe(true);
    expect(block.content["toolCallId"]).toBe("big-1");
  });

  test("TC-2.5: actor and harness are recorded as given and carried onto messages", async () => {
    const filePath = await createThread();
    expect(
      (
        await sdk.intakeStream.messageEvents({ filePath }, [
          validEvent("user_prompt", { actor: "user:lee", harness: "pi-extension/1.2" }),
          validEvent("assistant_text", { actor: "agent:claude", harness: "claude-code/2.0" }),
        ])
      ).ok,
    ).toBe(true);
    expect((await readEvents(filePath)).map((event) => [event.actor, event.harness])).toEqual([
      ["user:lee", "pi-extension/1.2"],
      ["agent:claude", "claude-code/2.0"],
    ]);
    expect((await readMessages(filePath)).map((message) => [message.actor, message.harness])).toEqual([
      ["user:lee", "pi-extension/1.2"],
      ["agent:claude", "claude-code/2.0"],
    ]);
  });

  test("TC-5.4: a skipped event creates no duplicate message", async () => {
    const filePath = await createThread();
    const batch = eventBatch(["user_prompt", "turn_end"]);
    expect((await sdk.intakeStream.messageEvents({ filePath }, batch)).ok).toBe(true);
    const baseline = await readMessages(filePath);
    expect(baseline).toHaveLength(1);
    const resend = await sdk.intakeStream.messageEvents({ filePath }, batch);
    expect(resend.ok).toBe(true);
    if (!resend.ok) return;
    expect(resend.value.events.every((entry) => entry.outcome === "skipped")).toBe(true);
    expect(resend.value.events.every((entry) => entry.messageId === undefined)).toBe(true);
    expect(await readMessages(filePath)).toEqual(baseline);
    const counts = await fixture.test.run(async (ctx) => {
      const rows = await ctx.db.query("messages").collect();
      return rows.map((message) => rows.filter((candidate) => candidate.sourceOrder === message.sourceOrder).length);
    });
    expect(counts).toEqual([1]);
  });
});
