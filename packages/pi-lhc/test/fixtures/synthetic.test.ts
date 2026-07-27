import { describe, expect, it } from "vitest";
import {
  eventBatch,
  makeAgentEnd,
  makeAssistantMessage,
  makeMessageEnd,
  makeSessionStart,
  makeToolResult,
  makeUserMessage,
  validEvent,
} from "./synthetic.js";

describe("synthetic builders", () => {
  it("build PI messages that fan out in PI's confirmed content-part order", () => {
    const user = makeUserMessage("hello");
    expect(user.role).toBe("user");
    expect(user.content).toEqual([{ type: "text", text: "hello" }]);

    const assistant = makeAssistantMessage({
      thinking: "hmm",
      text: "answer",
      toolCalls: [
        { id: "call-a", name: "read_file" },
        { id: "call-b", name: "write_file" },
      ],
    });
    expect(assistant.role).toBe("assistant");
    // thinking → text → toolCall×N (research §5a)
    expect(assistant.content.map((p) => p.type)).toEqual(["thinking", "text", "toolCall", "toolCall"]);

    const toolResult = makeToolResult({ id: "call-a", isError: true, content: "boom" });
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("call-a");
    expect(toolResult.isError).toBe(true);
  });

  it("supplies PI-required assistant fields by default; omits truly optional ones (exactOptionalPropertyTypes)", () => {
    const assistant = makeAssistantMessage({ text: "defaults fill the wire" });
    // stopReason / usage / timestamp / provider / model are mandatory on the PI wire.
    expect(assistant.stopReason).toBe("stop");
    expect(assistant.usage.totalTokens).toBe(0);
    expect(typeof assistant.timestamp).toBe("number");
    expect(assistant.provider).toBe("test");
    expect(assistant.model).toBe("test-model");
    // Truly optional fields stay absent rather than undefined.
    expect("errorMessage" in assistant).toBe(false);
    expect("responseId" in assistant).toBe(false);
    const toolResult = makeToolResult({ id: "call-a" });
    expect("isError" in toolResult).toBe(false);
  });

  it("build correctly-typed LHC intake events with unique idempotency keys", () => {
    const batch = eventBatch(["user_prompt", "assistant_text", "turn_end"]);
    expect(batch.map((e) => e.eventKind)).toEqual(["user_prompt", "assistant_text", "turn_end"]);
    const keys = batch.map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length); // keys are unique per build

    const toolCall = validEvent("tool_call", {
      payload: { toolCallId: "x", toolName: "run", arguments: { a: 1 } },
    });
    expect(toolCall.eventKind).toBe("tool_call");
    expect(toolCall.payload.toolCallId).toBe("x");
  });

  it("build event-stream payloads for the lifecycle hooks", () => {
    expect(makeSessionStart("resume").reason).toBe("resume");
    const msg = makeUserMessage("hi");
    expect(makeMessageEnd(msg).message).toBe(msg);
    expect(makeAgentEnd([msg]).messages).toEqual([msg]);
  });
});
