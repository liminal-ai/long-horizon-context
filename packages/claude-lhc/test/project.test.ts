import { describe, expect, test } from "vitest";
import { type NativeEntry, projectView } from "../src/projection/project.ts";

const stamp = { sessionId: "S", cwd: "/w", version: "2.1.259", permissionMode: "default", model: "claude-sonnet-5" };
const src = { sourceMessages: [] };

type ProjectedMessage = { id: string; model: string; stop_reason: string; content: string | NativeEntry[] };
const message = (line: NativeEntry | undefined): ProjectedMessage => line!["message"] as ProjectedMessage;
const firstBlock = (line: NativeEntry | undefined): NativeEntry | undefined =>
  (message(line).content as NativeEntry[])[0];

describe("projectView", () => {
  test("bands and prompts are user lines, assistant parts are per-block lines sharing one message id, tool pairs keep ids", () => {
    const lines = projectView(
      {
        threadId: "t",
        entries: [
          { role: "user", content: "[context · smooth]\n<t1>...</t1>", ...src },
          { role: "user", content: "read it", ...src },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
              { type: "toolCall", toolCallId: "toolu_1", toolName: "Read", arguments: { f: 1 } },
            ],
            ...src,
          },
          { role: "toolResult", toolCallId: "toolu_1", content: "ok", ...src },
          { role: "assistant", content: [{ type: "text", text: "done" }], ...src },
        ],
      },
      stamp,
    );
    expect(lines.map((l) => l["type"])).toEqual(["user", "user", "assistant", "assistant", "user", "assistant"]);
    const [band, prompt, thinking, call, result, text] = lines;
    expect(firstBlock(thinking)).toEqual({ type: "thinking", thinking: "hmm", signature: "sig" });
    expect(message(thinking).id).toBe(message(call).id);
    expect(String(message(band).content).startsWith("[context · smooth]")).toBe(true);
    expect(prompt!["permissionMode"]).toBe("default");
    expect(firstBlock(call)).toEqual({ type: "tool_use", id: "toolu_1", name: "Read", input: { f: 1 } });
    expect(message(call).stop_reason).toBe("tool_use");
    expect(firstBlock(result)).toEqual({
      tool_use_id: "toolu_1",
      type: "tool_result",
      content: "ok",
      is_error: false,
    });
    expect(message(text).stop_reason).toBe("end_turn");
    for (let i = 1; i < lines.length; i += 1) expect(lines[i]!["parentUuid"]).toBe(lines[i - 1]!["uuid"]);
    expect(lines.every((l) => l["sessionId"] === "S" && l["cwd"] === "/w" && l["version"] === "2.1.259")).toBe(true);
  });
  test("signed thinking re-enters verbatim (empty text kept); unsigned thinking is dropped, never given an invented signature", () => {
    const lines = projectView(
      {
        threadId: "t",
        entries: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", thinkingSignature: "sig-A" },
              { type: "thinking", thinking: "x" },
              { type: "text", text: "y" },
            ],
            ...src,
          },
        ],
      },
      stamp,
    );
    expect(lines.map((l) => firstBlock(l))).toEqual([
      { type: "thinking", thinking: "", signature: "sig-A" },
      { type: "text", text: "y" },
    ]);
    expect(lines.every((l) => message(l).id === message(lines[0]).id)).toBe(true);
    expect(message(lines[0]).stop_reason).toBe("end_turn");
  });
  test("the omit arm drops signed and redacted thinking", () => {
    const lines = projectView(
      {
        threadId: "t",
        entries: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", thinkingSignature: "sig-A" },
              { type: "redacted_thinking", block: { type: "redacted_thinking", data: "E" } },
              { type: "text", text: "y" },
            ],
            ...src,
          },
        ],
      },
      stamp,
      "omit",
    );
    expect(lines).toHaveLength(1);
    expect(firstBlock(lines[0])?.["type"]).toBe("text");
  });
  test("a tool call with no result gets a synthetic error result", () => {
    const lines = projectView(
      {
        threadId: "t",
        entries: [
          { role: "user", content: "go", ...src },
          {
            role: "assistant",
            content: [{ type: "toolCall", toolCallId: "toolu_9", toolName: "Bash", arguments: {} }],
            ...src,
          },
        ],
      },
      stamp,
    );
    const last = firstBlock(lines.at(-1));
    expect(last?.["tool_use_id"]).toBe("toolu_9");
    expect(last?.["is_error"]).toBe(true);
  });
  test("served blocks are written as the native content array: an attached image and a Read of a PNG come back as image blocks, never text", () => {
    const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
    const lines = projectView(
      {
        threadId: "t",
        entries: [
          {
            role: "user",
            content: "[image · image/png · 8 B]\nlook",
            blocks: [png, { type: "text", text: "look" }],
            ...src,
          },
          {
            role: "assistant",
            content: [{ type: "toolCall", toolCallId: "toolu_1", toolName: "Read", arguments: { file_path: "a.png" } }],
            ...src,
          },
          { role: "toolResult", toolCallId: "toolu_1", content: "[image · image/png · 8 B]", blocks: [png], ...src },
          { role: "toolResult", toolCallId: "toolu_2", content: "abridged text", ...src },
        ],
      },
      stamp,
    );
    const [prompt, , result, abridged] = lines;
    expect(message(prompt).content).toEqual([png, { type: "text", text: "look" }]);
    expect(firstBlock(result)).toEqual({
      tool_use_id: "toolu_1",
      type: "tool_result",
      content: [png],
      is_error: false,
    });
    expect(firstBlock(abridged)?.["content"]).toBe("abridged text");
    expect(JSON.stringify(lines)).not.toContain("[image ·");
  });
  test("server-side tool blocks and redacted thinking are written verbatim inside the assistant message", () => {
    const use = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "x" } };
    const found = { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] };
    const lines = projectView(
      {
        threadId: "t",
        entries: [
          {
            role: "assistant",
            content: [
              { type: "redacted_thinking", block: { type: "redacted_thinking", data: "E" } },
              { type: "server_tool_use", block: use },
              { type: "web_search_tool_result", block: found },
              { type: "text", text: "found" },
            ],
            ...src,
          },
        ],
      },
      stamp,
    );
    expect(lines.map((l) => firstBlock(l))).toEqual([
      { type: "redacted_thinking", data: "E" },
      use,
      found,
      { type: "text", text: "found" },
    ]);
    expect(message(lines[0]).stop_reason).toBe("end_turn");
    expect(lines.every((l) => message(l).id === message(lines[0]).id)).toBe(true);
  });
  test("model_change stamps later assistant lines", () => {
    const lines = projectView(
      {
        threadId: "t",
        entries: [
          { kind: "model_change", provider: "anthropic", modelId: "claude-opus-5", ...src },
          { role: "assistant", content: [{ type: "text", text: "y" }], ...src },
        ],
      },
      stamp,
    );
    expect(message(lines[0]).model).toBe("claude-opus-5");
  });
});
