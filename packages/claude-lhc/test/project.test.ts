import { describe, expect, test } from "bun:test";
import { projectView } from "../src/projection/project.ts";

const stamp = { sessionId: "S", cwd: "/w", version: "2.1.259", permissionMode: "default", model: "claude-sonnet-5" };
const src = { sourceMessages: [] };

describe("projectView", () => {
  test("bands and prompts are user lines, assistant parts are per-block lines sharing one message id, tool pairs keep ids", () => {
    const lines = projectView({ threadId: "t", entries: [
      { role: "user", content: "[context · smooth]\n<t1>...</t1>", ...src },
      { role: "user", content: "read it", ...src },
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "sig" }, { type: "toolCall", toolCallId: "toolu_1", toolName: "Read", arguments: { f: 1 } }], ...src },
      { role: "toolResult", toolCallId: "toolu_1", content: "ok", ...src },
      { role: "assistant", content: [{ type: "text", text: "done" }], ...src },
    ] }, stamp);
    expect(lines.map((l) => l["type"])).toEqual(["user", "user", "assistant", "user", "assistant"]);
    const [band, prompt, call, result, text] = lines as Array<Record<string, any>>;
    expect(band!["message"].content).toStartWith("[context · smooth]");
    expect(prompt!["permissionMode"]).toBe("default");
    expect(call!["message"].content[0]).toEqual({ type: "tool_use", id: "toolu_1", name: "Read", input: { f: 1 } });
    expect(call!["message"].stop_reason).toBe("tool_use");
    expect(result!["message"].content[0]).toEqual({ tool_use_id: "toolu_1", type: "tool_result", content: "ok", is_error: false });
    expect(text!["message"].stop_reason).toBe("end_turn");
    // parent chain
    for (let i = 1; i < lines.length; i += 1) expect(lines[i]!["parentUuid"]).toBe(lines[i - 1]!["uuid"]);
    expect(lines.every((l) => l["sessionId"] === "S" && l["cwd"] === "/w" && l["version"] === "2.1.259")).toBe(true);
  });
  test("thinking is omitted, never given an invented signature", () => {
    const lines = projectView({ threadId: "t", entries: [{ role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "y" }], ...src }] }, stamp);
    expect(lines).toHaveLength(1);
    expect((lines[0] as any)["message"].content[0].type).toBe("text");
  });
  test("a tool call with no result gets a synthetic error result", () => {
    const lines = projectView({ threadId: "t", entries: [
      { role: "user", content: "go", ...src },
      { role: "assistant", content: [{ type: "toolCall", toolCallId: "toolu_9", toolName: "Bash", arguments: {} }], ...src },
    ] }, stamp);
    const last = lines.at(-1) as any;
    expect(last["message"].content[0].tool_use_id).toBe("toolu_9");
    expect(last["message"].content[0].is_error).toBe(true);
  });
  test("model_change stamps later assistant lines", () => {
    const lines = projectView({ threadId: "t", entries: [
      { kind: "model_change", provider: "anthropic", modelId: "claude-opus-5", ...src },
      { role: "assistant", content: [{ type: "text", text: "y" }], ...src },
    ] }, stamp);
    expect((lines[0] as any)["message"].model).toBe("claude-opus-5");
  });
});
