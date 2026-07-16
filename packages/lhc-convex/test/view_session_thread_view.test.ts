import { beforeEach, describe, expect, test } from "vitest";
import type { Lhc, SessionThreadViewEntry } from "../src/client/index.js";
import { conversationTurn, eventBatch, type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

type MessageEntry = Extract<SessionThreadViewEntry, { role: string }>;

let fixture: ServiceFixture;
let sdk: Lhc;
let filePath: string;

beforeEach(async () => {
  fixture = serviceFixture();
  sdk = fixture.sdk;
  filePath = (await fixture.createThread()).filePath;
});

function isMessageEntry(entry: SessionThreadViewEntry): entry is MessageEntry {
  return "role" in entry;
}

function messageEntries(entries: readonly SessionThreadViewEntry[]): MessageEntry[] {
  return entries.filter(isMessageEntry);
}

function messageRoles(entries: readonly SessionThreadViewEntry[]): string[] {
  return messageEntries(entries).map((message) => message.role);
}

function entryKinds(entries: readonly SessionThreadViewEntry[]): string[] {
  return entries.map((entry) => ("kind" in entry ? entry.kind : entry.role));
}

function idempotencyKeyPattern(): RegExp {
  return /^convex-fixture-key-\d+$/;
}

async function seedViewBoundary(position: number): Promise<void> {
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("viewBoundaries").collect();
    const row = rows.find((candidate) => candidate.instance === fixture.instance);
    if (row === undefined) throw new Error("view boundary missing");
    await ctx.db.patch("viewBoundaries", row._id, { position });
  });
}

describe("threadView.getSessionThreadView", () => {
  test("returns user and assistant messages for a simple turn", async () => {
    expect((await sdk.intakeStream.messageEvents({ filePath }, eventBatch(["user_prompt", "assistant_text"]))).ok).toBe(
      true,
    );
    const view = await sdk.threadView.getSessionThreadView({ filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(messageEntries(view.value.entries)).toEqual([
      {
        role: "user",
        content: "please read the file",
        sourceMessages: [{ messageId: "m1", idempotencyKey: expect.stringMatching(idempotencyKeyPattern()) }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "here is what I found" }],
        sourceMessages: [{ messageId: "m2", idempotencyKey: expect.stringMatching(idempotencyKeyPattern()) }],
      },
    ]);
  });

  test("groups assistant thinking, text, and tool calls into one assistant message", async () => {
    expect(
      (
        await sdk.intakeStream.messageEvents(
          { filePath },
          eventBatch(["user_prompt", "assistant_thinking", "assistant_text", "tool_call"]),
        )
      ).ok,
    ).toBe(true);
    const view = await sdk.threadView.getSessionThreadView({ filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(messageRoles(view.value.entries)).toEqual(["user", "assistant"]);
    const assistant = messageEntries(view.value.entries)[1];
    expect(assistant?.role).toBe("assistant");
    if (assistant?.role !== "assistant") return;
    expect(assistant.content.map((part) => part.type)).toEqual(["thinking", "text", "toolCall"]);
    expect(assistant.content[2]).toMatchObject({
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "read_file",
      arguments: { path: "notes.txt" },
    });
    expect(assistant.sourceMessages).toEqual([
      { messageId: "m2", idempotencyKey: expect.stringMatching(idempotencyKeyPattern()) },
      { messageId: "m3", idempotencyKey: expect.stringMatching(idempotencyKeyPattern()) },
      { messageId: "m4", idempotencyKey: expect.stringMatching(idempotencyKeyPattern()) },
    ]);
  });

  test("emits toolResult after the assistant message and starts a new assistant after tool results", async () => {
    expect(
      (
        await sdk.intakeStream.messageEvents(
          { filePath },
          eventBatch(["user_prompt", "assistant_thinking", "tool_call", "tool_result", "assistant_text", "turn_end"]),
        )
      ).ok,
    ).toBe(true);
    const view = await sdk.threadView.getSessionThreadView({ filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(messageRoles(view.value.entries)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(messageEntries(view.value.entries)[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      content: "contents of notes.txt",
    });
  });

  test("covers a full conversation turn with native session shapes", async () => {
    expect((await sdk.intakeStream.messageEvents({ filePath }, conversationTurn())).ok).toBe(true);
    const view = await sdk.threadView.getSessionThreadView({ filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(messageRoles(view.value.entries)).toEqual(["user", "assistant", "toolResult"]);
  });

  test("emits model_change and thinking_level_change entries for runtime changes", async () => {
    expect(
      (
        await sdk.intakeStream.messageEvents({ filePath }, [
          validEvent("user_prompt"),
          validEvent("model_change", {
            payload: { previousModel: "anthropic/claude-3", newModel: "openai/gpt-4o" },
          }),
          validEvent("thinking_level_change", { payload: { previousLevel: "low", newLevel: "high" } }),
          validEvent("assistant_text"),
          validEvent("turn_end"),
        ])
      ).ok,
    ).toBe(true);
    const view = await sdk.threadView.getSessionThreadView({ filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(entryKinds(view.value.entries)).toEqual(["user", "model_change", "thinking_level_change", "assistant"]);
    expect(view.value.entries[1]).toEqual({
      kind: "model_change",
      provider: "openai",
      modelId: "gpt-4o",
      sourceMessages: [{ messageId: "m2", idempotencyKey: expect.stringMatching(idempotencyKeyPattern()) }],
    });
    expect(view.value.entries[2]).toEqual({
      kind: "thinking_level_change",
      level: "high",
      sourceMessages: [{ messageId: "m3", idempotencyKey: expect.stringMatching(idempotencyKeyPattern()) }],
    });
  });

  test("serves full tool-result content before compact even when the zone exceeds visibility max", async () => {
    const local = serviceFixture({ view: { visibility: { maxTokens: 10, targetTokens: 5 } } });
    const path = (await local.createThread()).filePath;
    const largeResult = Array<string>(40).fill("tok").join(" ");
    expect(
      (
        await local.sdk.intakeStream.messageEvents({ filePath: path }, [
          validEvent("user_prompt", { payload: { text: "read a large file" } }),
          validEvent("tool_call", {
            payload: { toolCallId: "call-large", toolName: "read_file", arguments: { path: "big.txt" } },
          }),
          validEvent("tool_result", {
            payload: { toolCallId: "call-large", content: largeResult, isError: false },
          }),
          validEvent("turn_end"),
        ])
      ).ok,
    ).toBe(true);
    const view = await local.sdk.threadView.getSessionThreadView({ filePath: path });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const toolResult = messageEntries(view.value.entries).find((entry) => entry.role === "toolResult");
    expect(toolResult).toMatchObject({ role: "toolResult", toolCallId: "call-large", content: largeResult });
    expect(toolResult?.content).not.toContain("abridged");
  });

  test("shortens at-or-behind-boundary tool results like getLlmRequestContext", async () => {
    expect(
      (
        await sdk.intakeStream.messageEvents(
          { filePath },
          eventBatch(["user_prompt", "tool_call", "tool_result", "assistant_text", "turn_end"]),
        )
      ).ok,
    ).toBe(true);
    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const result = listed.value.find((message) => message.kind === "tool_result");
    expect(result).toBeDefined();
    if (result === undefined) return;
    await seedViewBoundary(result.sourceEventOrder);

    const [sessionView, llmContext] = await Promise.all([
      sdk.threadView.getSessionThreadView({ filePath }),
      sdk.threadView.getLlmRequestContext({ filePath }),
    ]);
    expect(sessionView.ok).toBe(true);
    expect(llmContext.ok).toBe(true);
    if (!sessionView.ok || !llmContext.ok) return;
    const sessionToolResult = messageEntries(sessionView.value.entries).find((entry) => entry.role === "toolResult");
    expect(sessionToolResult?.role).toBe("toolResult");
    if (sessionToolResult?.role !== "toolResult") return;
    const llmToolResult = llmContext.value.messages.find((message) =>
      message.content[0]?.text.startsWith("[tool result · read_file"),
    );
    expect(llmToolResult).toBeDefined();
    if (llmToolResult === undefined) return;
    const llmText = llmToolResult.content[0]?.text ?? "";
    const llmBody = llmText.replace(/^\[tool result · [^\]]+\]\n/, "");
    expect(sessionToolResult.content).toBe(llmBody);
  });
});

describe("runtime_note entries", () => {
  test("renders runtime notes as labeled user entries in tail order", async () => {
    const noteText = "<task-notification>task t-123 completed: build finished</task-notification>";
    expect(
      (
        await sdk.intakeStream.messageEvents({ filePath }, [
          validEvent("user_prompt"),
          validEvent("assistant_text"),
          validEvent("runtime_note", { payload: { text: noteText } }),
          validEvent("assistant_text", { payload: { text: "picked up the notification" } }),
        ])
      ).ok,
    ).toBe(true);
    const view = await sdk.threadView.getSessionThreadView({ filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(messageRoles(view.value.entries)).toEqual(["user", "assistant", "user", "assistant"]);
    const note = messageEntries(view.value.entries)[2];
    expect(note).toMatchObject({ role: "user", content: `[runtime note] ${noteText}` });
    if (note?.role !== "user") return;
    expect(note.sourceMessages).toHaveLength(1);
  });
});
