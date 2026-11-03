import { describe, expect, test } from "vitest";
import {
  joinedText,
  mapAssistantBlocks,
  mapUserBlocks,
  nonTextBlocks,
  stringifyToolResultContent,
  textEvent,
  usageContextTokens,
} from "../src/index.js";

const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
const pdf = {
  type: "document",
  source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQ=" },
  title: "spec.pdf",
};

describe("mapAssistantBlocks", () => {
  const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 5 };

  test("assistant blocks map in order with provenance and usage, keyed by the caller's harness", () => {
    const events = mapAssistantBlocks("claude-code", "a1", {
      model: "claude-sonnet-5",
      usage,
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "x" } },
        { type: "text", text: "done" },
      ],
    });
    expect(events.map((e) => e.eventKind)).toEqual(["assistant_thinking", "tool_call", "assistant_text"]);
    expect(events.map((e) => e.harness)).toEqual(["claude-code", "claude-code", "claude-code"]);
    expect(events[0]?.idempotencyKey).toBe("claude-code:a1:0:assistant_thinking");
    expect(events[0]?.payload).toEqual({
      text: "",
      signature: "sig",
      provider: "anthropic",
      api: "messages",
      model: "claude-sonnet-5",
    });
    expect(events[1]?.payload).toEqual({ toolCallId: "toolu_1", toolName: "Read", arguments: { file_path: "x" } });
    expect(events[2]?.payload).toEqual({
      text: "done",
      providerUsage: usage,
      provider: "anthropic",
      api: "messages",
      model: "claude-sonnet-5",
    });
  });

  test("empty text blocks are dropped", () => {
    expect(mapAssistantBlocks("h", "a3", { content: [{ type: "text", text: "" }] })).toEqual([]);
  });

  test("redacted thinking and server-side tool blocks ride verbatim on their events", () => {
    const redacted = { type: "redacted_thinking", data: "EqQB" };
    const use = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "lhc" } };
    const found = {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [{ type: "web_search_result", title: "T", url: "https://x", encrypted_content: "ENC" }],
    };
    const failed = {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_2",
      content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
    };
    const events = mapAssistantBlocks("h", "a9", {
      model: "claude-sonnet-5",
      content: [redacted, use, found, failed, { type: "text", text: "done" }],
    });
    expect(events.map((e) => e.eventKind)).toEqual([
      "assistant_thinking",
      "tool_call",
      "tool_result",
      "tool_result",
      "assistant_text",
    ]);
    expect(events[0]?.payload).toMatchObject({ text: "", block: redacted });
    expect(events[1]?.payload).toMatchObject({
      toolCallId: "srvtoolu_1",
      toolName: "web_search",
      arguments: { query: "lhc" },
      block: use,
    });
    expect(events[2]?.payload).toEqual({ toolCallId: "srvtoolu_1", content: "", isError: false, blocks: [found] });
    expect(events[3]?.payload).toEqual({ toolCallId: "srvtoolu_2", content: "", isError: true, blocks: [failed] });
  });
});

describe("mapUserBlocks", () => {
  test("tool results map by tool_use_id with stringified content", () => {
    const [event] = mapUserBlocks("h", "r1", [
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
        is_error: true,
      },
    ]);
    expect(event?.eventKind).toBe("tool_result");
    expect(event?.idempotencyKey).toBe("h:r1:0:tool_result");
    expect(event?.payload).toEqual({ toolCallId: "toolu_1", content: "a\nb", isError: true });
  });

  test("a Read of a PNG or PDF keeps the native content array; text-only results stay strings", () => {
    const events = mapUserBlocks("h", "r9", [
      { type: "tool_result", tool_use_id: "toolu_png", content: [png] },
      { type: "tool_result", tool_use_id: "toolu_pdf", content: [pdf, { type: "text", text: "3 pages" }] },
      { type: "tool_result", tool_use_id: "toolu_txt", content: [{ type: "text", text: "plain" }] },
    ]);
    expect(events.map((e) => e.payload)).toEqual([
      { toolCallId: "toolu_png", isError: false, content: "", blocks: [png] },
      { toolCallId: "toolu_pdf", isError: false, content: "3 pages", blocks: [pdf, { type: "text", text: "3 pages" }] },
      { toolCallId: "toolu_txt", isError: false, content: "plain" },
    ]);
  });

  test("injected user text (task notification, hook output) is a system runtime note", () => {
    const [note] = mapUserBlocks("h", "n1", [
      { type: "text", text: "<task-notification>agent done</task-notification>" },
    ]);
    expect(note?.eventKind).toBe("runtime_note");
    expect(note?.actor).toBe("system");
    expect(note?.idempotencyKey).toBe("h:n1:0:runtime_note");
    const [hook] = mapUserBlocks("h", "n2", "<user-prompt-submit-hook>lint ok</user-prompt-submit-hook>");
    expect(hook?.payload).toEqual({ text: "<user-prompt-submit-hook>lint ok</user-prompt-submit-hook>" });
  });
});

describe("content helpers", () => {
  test("stringifyToolResultContent", () => {
    expect(stringifyToolResultContent("s")).toBe("s");
    expect(stringifyToolResultContent(undefined)).toBe("");
    expect(stringifyToolResultContent(null)).toBe("");
    expect(stringifyToolResultContent([{ type: "text", text: "a" }, { type: "x" }])).toBe('a\n{"type":"x"}');
    expect(stringifyToolResultContent({ k: 1 })).toBe('{"k":1}');
  });

  test("a prompt with an attached image keeps the native array as blocks; text stays the text", () => {
    const content = [png, { type: "text", text: "what is this?" }];
    expect(joinedText(content)).toBe("what is this?");
    expect(nonTextBlocks(content)).toEqual(content);
    expect(nonTextBlocks([png])).toEqual([png]);
    expect(nonTextBlocks("plain")).toBeUndefined();
    expect(textEvent("h", "user_prompt", "hi", "user", "k", { blocks: [png] })).toEqual({
      eventKind: "user_prompt",
      idempotencyKey: "k",
      actor: "user",
      harness: "h",
      payload: { text: "hi", blocks: [png] },
    });
  });

  test("context tokens are input plus cache tokens", () => {
    expect(
      usageContextTokens({ input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 }),
    ).toBe(1002);
    expect(usageContextTokens({ output_tokens: 5 })).toBeUndefined();
    expect(usageContextTokens(undefined)).toBeUndefined();
  });
});
