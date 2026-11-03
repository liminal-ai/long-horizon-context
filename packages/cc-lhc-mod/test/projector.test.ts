import type { SessionThreadView } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerCompact } from "../sidecar/src/compact.ts";
import { DANGLING_RESULT, projectView } from "../sidecar/src/projector.ts";
import { type Harness, harness, recorder, Script, SESSION, writeTranscript } from "./fixture.ts";

const src = (messageId: string) => [{ messageId, idempotencyKey: null }];

const view = (...entries: SessionThreadView["entries"]): SessionThreadView => ({ threadId: "th", entries });

describe("projectView", () => {
  it("serves each band as its own labeled user message, in order", () => {
    const built = projectView(
      view(
        { role: "user", content: "[context · brief]\nolder work", sourceMessages: src("m3") },
        { role: "user", content: "[context · smooth]\nrecent work", sourceMessages: src("m9") },
        { role: "user", content: "next ask", sourceMessages: src("m10") },
      ),
    );
    expect(built.map((m) => [m.role, m.text])).toEqual([
      ["user", "[context · brief]\nolder work"],
      ["user", "[context · smooth]\nrecent work"],
      ["user", "next ask"],
    ]);
    expect(built.every((m) => m.toolUses.length === 0)).toBe(true);
  });

  it("keeps text and tool pairs, with each result on the call and in the next user message", () => {
    const built = projectView(
      view(
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", thinkingSignature: "sig" },
            { type: "text", text: "reading both" },
            { type: "toolCall", toolCallId: "toolu_a", toolName: "Read", arguments: { file_path: "a.ts" } },
            { type: "toolCall", toolCallId: "toolu_b", toolName: "Read", arguments: { file_path: "b.ts" } },
          ],
          sourceMessages: src("m4"),
        },
        { role: "toolResult", toolCallId: "toolu_a", content: "a body", sourceMessages: src("m5") },
        {
          role: "toolResult",
          toolCallId: "toolu_b",
          content: "no such file",
          isError: true,
          sourceMessages: src("m6"),
        },
      ),
    );
    expect(built).toEqual([
      {
        role: "assistant",
        text: "reading both",
        toolUses: [
          { tool_use_id: "toolu_a", tool: "Read", input: { file_path: "a.ts" }, text: "a body" },
          { tool_use_id: "toolu_b", tool: "Read", input: { file_path: "b.ts" }, text: "no such file", isError: true },
        ],
      },
      {
        role: "user",
        text: "",
        toolUses: [],
        toolResults: [{ tool_use_id: "toolu_a", text: "a body", isError: false }],
      },
      {
        role: "user",
        text: "",
        toolUses: [],
        toolResults: [{ tool_use_id: "toolu_b", text: "no such file", isError: true }],
      },
    ]);
  });

  it("names the message in place of an image, a document or an empty result", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } } as const;
    const built = projectView(
      view(
        {
          role: "assistant",
          content: [
            { type: "toolCall", toolCallId: "toolu_i", toolName: "Read", arguments: {} },
            { type: "toolCall", toolCallId: "toolu_e", toolName: "Bash", arguments: {} },
          ],
          sourceMessages: src("m4"),
        },
        { role: "toolResult", toolCallId: "toolu_i", content: "", blocks: [image], sourceMessages: src("m5") },
        { role: "toolResult", toolCallId: "toolu_e", content: "", sourceMessages: src("m6") },
        {
          role: "user",
          content: "what is in this?",
          blocks: [{ type: "text", text: "what is in this?" }, image],
          sourceMessages: src("m7"),
        },
      ),
    );
    expect(built[1]?.toolResults?.[0]?.text).toBe("[image omitted by LHC: m5]");
    expect(built[2]?.toolResults?.[0]?.text).toBe("[empty tool result: m6]");
    expect(built[3]?.text).toBe("what is in this?\n[image omitted by LHC: m7]");
  });

  it("drops an assistant message left with nothing, and answers a call the view never answers", () => {
    const built = projectView(
      view(
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "", thinkingSignature: "sig" }],
          sourceMessages: src("m2"),
        },
        { role: "assistant", content: [{ type: "text", text: "" }], sourceMessages: src("m3") },
        {
          role: "assistant",
          content: [{ type: "toolCall", toolCallId: "toolu_x", toolName: "Bash", arguments: {} }],
          sourceMessages: src("m4"),
        },
        { role: "user", content: "[runtime note] [Request interrupted by user]", sourceMessages: src("m5") },
      ),
    );
    expect(built.map((m) => m.role)).toEqual(["assistant", "user", "user"]);
    expect(built[0]?.toolUses[0]).toMatchObject({ tool_use_id: "toolu_x", text: DANGLING_RESULT, isError: true });
    expect(built[1]?.toolResults).toEqual([{ tool_use_id: "toolu_x", text: DANGLING_RESULT, isError: true }]);
    expect(built.every((m) => m.role === "user" || m.text !== "" || m.toolUses.length > 0)).toBe(true);
  });
});

describe("the request in the view", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.cleanup());

  it("comes from the recorded prompt, and a background notification stays a note", async () => {
    const script = new Script();
    script.toolTurn("turn-1", "set up the repo", "toolu_1");
    script.prompt("rename every widget to gadget");
    script.turnStart("turn-2");
    script.step("turn-2", 0);
    script.answer({ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "grep widget" } });
    script.results("toolu_2");
    script.notification("<task-notification>background build finished</task-notification>");
    script.step("turn-2", 1);
    script.answer({ type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "sed widget" } });
    script.results("toolu_3");
    const r = await recorder(h);
    writeTranscript(h, script.lines);
    await r.capture(script.entries);

    const answer = await answerCompact(r, { sessionId: SESSION, trigger: "auto", target: 10_000 }, (line) =>
      h.log.push(line),
    );

    if (answer.kind !== "view") throw new Error(answer.reason);
    expect(answer.isMidTurn).toBe(true);
    const texts = answer.messages.map((m) => m.text);
    const request = texts.findIndex((text) => text.includes("rename every widget to gadget"));
    const notification = texts.findIndex((text) => text.includes("background build finished"));
    expect(request).toBeGreaterThanOrEqual(0);
    expect(texts[notification]).toMatch(/^\[runtime note\]/);
    expect(answer.messages.at(-1)?.toolResults?.[0]?.tool_use_id).toBe("toolu_3");
  });
});
