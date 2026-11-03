import { expect, it } from "vitest";
import { answerCompact } from "../sidecar/src/compact.ts";
import { projectView } from "../sidecar/src/projector.ts";
import { harness, recorder, Script, SESSION, writeTranscript } from "./fixture.ts";

it("preserves a completed tool result when a background delivery lands while the tool runs", async () => {
  const h = harness();
  try {
    const script = new Script();
    script.prompt("run the build");
    script.turnStart("turn-1");
    script.step("turn-1", 0);
    script.answer({ type: "tool_use", id: "toolu_build", name: "Bash", input: { command: "build" } });
    script.delivery("<task-notification>background lint finished</task-notification>");
    script.results("toolu_build");
    writeTranscript(h, script.lines);
    const r = await recorder(h);
    await r.capture(script.entries);
    const answer = await answerCompact(r, { sessionId: SESSION, trigger: "auto", target: 10_000 }, () => {});
    if (answer.kind !== "view") throw new Error(answer.reason);
    const results = answer.messages.flatMap((m) => m.toolResults ?? []);
    expect(results).toEqual([{ tool_use_id: "toolu_build", text: "out toolu_build", isError: false }]);
  } finally {
    h.cleanup();
  }
});

it("keeps one result per call when a note splits a response's tool calls", () => {
  const src = (messageId: string) => [{ messageId, idempotencyKey: null }];
  const built = projectView({
    threadId: "th",
    entries: [
      {
        role: "assistant",
        content: [{ type: "toolCall", toolCallId: "toolu_a", toolName: "Read", arguments: {} }],
        sourceMessages: src("m2"),
      },
      {
        role: "user",
        content: "[runtime note] <task-notification>job done</task-notification>",
        sourceMessages: src("m3"),
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", toolCallId: "toolu_b", toolName: "Read", arguments: {} }],
        sourceMessages: src("m4"),
      },
      { role: "toolResult", toolCallId: "toolu_a", content: "a body", sourceMessages: src("m5") },
      { role: "toolResult", toolCallId: "toolu_b", content: "b body", sourceMessages: src("m6") },
    ],
  });
  const results = built.flatMap((m) => m.toolResults ?? []);
  expect(results).toEqual([
    { tool_use_id: "toolu_a", text: "a body", isError: false },
    { tool_use_id: "toolu_b", text: "b body", isError: false },
  ]);
  expect(built.map((m) => m.role)).toEqual(["assistant", "user", "user", "user"]);
  expect(built.at(-1)?.text).toContain("job done");
});

it("settles a call that never got a result before a later turn's prompt and answer", () => {
  const src = (messageId: string) => [{ messageId, idempotencyKey: null }];
  const built = projectView({
    threadId: "th",
    entries: [
      {
        role: "assistant",
        content: [{ type: "toolCall", toolCallId: "toolu_x", toolName: "Bash", arguments: {} }],
        sourceMessages: src("m2"),
      },
      { role: "user", content: "next question", sourceMessages: src("m3") },
      { role: "assistant", content: [{ type: "text", text: "next answer" }], sourceMessages: src("m4") },
    ],
  });
  expect(built.map((m) => [m.role, m.text, m.toolResults?.[0]?.isError ?? null])).toEqual([
    ["assistant", "", null],
    ["user", "", true],
    ["user", "next question", null],
    ["assistant", "next answer", null],
  ]);
});
