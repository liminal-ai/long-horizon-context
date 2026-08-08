import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDeterministicInferenceCallbacks,
  initLhc,
  type Lhc,
  type SessionThreadViewEntry,
  type SessionThreadViewMessage,
} from "../src/index.js";
import {
  boundaryTokens,
  conversationTurn,
  eventBatch,
  seedViewBoundary,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

let store: TempStore;
let sdk: Lhc;
let filePath: string;

async function newThread(sdk: Lhc): Promise<string> {
  const path = store.threadPath();
  const created = await sdk.threads.newThread({ filePath: path, registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  return path;
}

beforeEach(async () => {
  store = tempStore();
  sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
  filePath = await newThread(sdk);
});
afterEach(() => {
  store.cleanup();
});

function isMessageEntry(entry: SessionThreadViewEntry): entry is SessionThreadViewMessage {
  return "role" in entry;
}

function messageEntries(entries: readonly SessionThreadViewEntry[]): SessionThreadViewMessage[] {
  return entries.filter(isMessageEntry);
}

function messageRoles(entries: readonly SessionThreadViewEntry[]): string[] {
  return messageEntries(entries).map((message) => message.role);
}

function entryKinds(entries: readonly SessionThreadViewEntry[]): string[] {
  return entries.map((entry) => ("kind" in entry ? entry.kind : entry.role));
}

function idempotencyKeyPattern(): RegExp {
  return /^fixture-key-\d+$/;
}

describe("threadView.getSessionThreadView", () => {
  it("returns user and assistant messages for a simple turn", async () => {
    const captured = await sdk.intakeStream.messageEvents({ filePath }, eventBatch(["user_prompt", "assistant_text"]));
    expect(captured.ok).toBe(true);

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

  it("groups assistant thinking, text, and tool calls into one assistant message", async () => {
    const captured = await sdk.intakeStream.messageEvents(
      { filePath },
      eventBatch(["user_prompt", "assistant_thinking", "assistant_text", "tool_call"]),
    );
    expect(captured.ok).toBe(true);

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

  it("emits toolResult after the assistant message and starts a new assistant after tool results", async () => {
    const captured = await sdk.intakeStream.messageEvents(
      { filePath },
      eventBatch(["user_prompt", "assistant_thinking", "tool_call", "tool_result", "assistant_text", "turn_end"]),
    );
    expect(captured.ok).toBe(true);

    const view = await sdk.threadView.getSessionThreadView({ filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    expect(messageRoles(view.value.entries)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    const toolResult = messageEntries(view.value.entries)[2];
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      content: "contents of notes.txt",
    });
  });

  it("covers a full conversation turn with native session shapes", async () => {
    const captured = await sdk.intakeStream.messageEvents({ filePath }, conversationTurn());
    expect(captured.ok).toBe(true);

    const view = await sdk.threadView.getSessionThreadView({ filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    expect(messageRoles(view.value.entries)).toEqual(["user", "assistant", "toolResult"]);
  });

  it("emits model_change and thinking_level_change entries for runtime changes", async () => {
    const captured = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      validEvent("model_change", {
        payload: { previousModel: "anthropic/claude-3", newModel: "openai/gpt-4o" },
      }),
      validEvent("thinking_level_change", { payload: { previousLevel: "low", newLevel: "high" } }),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);
    expect(captured.ok).toBe(true);

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

  it("splits assistant groups at identity boundaries so signatures keep their own provenance", async () => {
    // Two thinking rows with different capture identities inside one
    // assistant run (model changed mid-turn). Message-level provenance
    // covers every signature in a group, so the group must split — otherwise
    // the second signature would serve under the first identity and the
    // host's identity gate would re-emit the wrong ciphertext.
    const captured = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      validEvent("assistant_thinking", {
        payload: {
          text: "plan a",
          signature: "SIG_A",
          provider: "openai",
          model: "gpt-a",
          api: "responses",
        },
      }),
      validEvent("assistant_thinking", {
        payload: {
          text: "plan b",
          signature: "SIG_B",
          provider: "openai",
          model: "gpt-b",
          api: "responses",
        },
      }),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);
    expect(captured.ok).toBe(true);

    const view = await sdk.threadView.getSessionThreadView({ filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    const assistants = view.value.entries.filter(
      (entry): entry is SessionThreadViewMessage & { role: "assistant" } =>
        isMessageEntry(entry) && entry.role === "assistant",
    );
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.model).toBe("gpt-a");
    expect(assistants[1]?.model).toBe("gpt-b");
    const first = assistants[0]?.content[0];
    const second = assistants[1]?.content[0];
    expect(first?.type === "thinking" && first.thinkingSignature).toBe("SIG_A");
    expect(second?.type === "thinking" && second.thinkingSignature).toBe("SIG_B");
    // The trailing plain text (no provenance) inherits the open group.
    expect(assistants[1]?.content.some((part) => part.type === "text")).toBe(true);
  });

  it("serves full tool-result content before compact even when the zone exceeds visibility max", async () => {
    const sdkWithBudgets = initLhc({
      mode: "manual",
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
      view: { visibility: { maxTokens: 10, targetTokens: 5 } },
    });
    const path = store.threadPath();
    const created = await sdkWithBudgets.threads.newThread({ filePath: path, registryPath: store.registryPath });
    if (!created.ok) throw new Error(created.error.reason);

    const largeResult = boundaryTokens(40);
    const captured = await sdkWithBudgets.intakeStream.messageEvents({ filePath: path }, [
      validEvent("user_prompt", { payload: { text: "read a large file" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-large", toolName: "read_file", arguments: { path: "big.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call-large", content: largeResult, isError: false },
      }),
      validEvent("turn_end"),
    ]);
    expect(captured.ok).toBe(true);

    const view = await sdkWithBudgets.threadView.getSessionThreadView({ filePath: path });
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    const toolResult = messageEntries(view.value.entries).find((entry) => entry.role === "toolResult");
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: "call-large",
      content: largeResult,
    });
    expect(toolResult?.content).not.toContain("abridged");
  });

  it("shortens at-or-behind-boundary tool results like getLlmRequestContext", async () => {
    const captured = await sdk.intakeStream.messageEvents(
      { filePath },
      eventBatch(["user_prompt", "tool_call", "tool_result", "assistant_text", "turn_end"]),
    );
    expect(captured.ok).toBe(true);

    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const result = listed.value.find((message) => message.kind === "tool_result");
    expect(result).toBeDefined();
    if (result === undefined) return;

    seedViewBoundary(filePath, result.sourceEventOrder);

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
  it("renders runtime notes as labeled user entries in tail order", async () => {
    const noteText = "<task-notification>task t-123 completed: build finished</task-notification>";
    const captured = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("runtime_note", { payload: { text: noteText } }),
      validEvent("assistant_text", { payload: { text: "picked up the notification" } }),
    ]);
    expect(captured.ok).toBe(true);

    const view = await sdk.threadView.getSessionThreadView({ filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    expect(messageRoles(view.value.entries)).toEqual(["user", "assistant", "user", "assistant"]);
    const note = messageEntries(view.value.entries)[2];
    expect(note).toMatchObject({
      role: "user",
      content: `[runtime note] ${noteText}`,
    });
    if (note?.role !== "user") return;
    expect(note.sourceMessages).toHaveLength(1);
  });
});
