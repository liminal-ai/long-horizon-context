// Turn parts, F2 (record-at-intake): capture stamps the host step index on
// the four step-bearing kinds. One step is one provider cycle; PI's per-step
// turn_end is the step edge (never an LHC turn boundary); the counter resets
// per prompt; a message finalized with no open turn keeps NULL, so
// pre-existing threads and a turn a prior process left open are never split.
import { intakeStream, messages, type ThreadRef } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapMessage } from "../../src/capture/map-message.js";
import {
  FIXTURE_TIMESTAMP_MS,
  makeAgentEnd,
  makeAssistantMessage,
  makeMessageEnd,
  makeToolResult,
  makeUserMessage,
} from "../fixtures/synthetic.js";
import { type TempStore, tempStore } from "../fixtures/thread.js";
import { attachCapture, eventsAfterShutdown, startCapture } from "./support.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

function threadIdOf(ref: ThreadRef): string {
  if (!("threadId" in ref)) throw new Error("expected a { threadId } ref");
  return ref.threadId;
}

const turnEnd = { type: "turn_end" as const, turnIndex: 0, message: makeAssistantMessage(), toolResults: [] };

describe("step index at intake", () => {
  it("mapMessage stamps stepIndex on the four step-bearing kinds only, and only when the host supplies one", () => {
    const withStep = { piSessionId: "s", entryId: "e1", stepIndex: 3 };
    const assistant = mapMessage(
      makeAssistantMessage({
        thinking: "hm",
        text: "ok",
        toolCalls: [{ id: "c1", name: "read", arguments: {} }],
      }),
      withStep,
    );
    expect(assistant.map((e) => [e.eventKind, (e.payload as { stepIndex?: number }).stepIndex])).toEqual([
      ["assistant_thinking", 3],
      ["assistant_text", 3],
      ["tool_call", 3],
    ]);
    expect(mapMessage(makeToolResult({ id: "c1", content: "r" }), withStep)[0]!.payload).toMatchObject({
      stepIndex: 3,
    });
    expect(mapMessage(makeUserMessage("hi"), withStep)[0]!.payload).not.toHaveProperty("stepIndex");
    for (const event of mapMessage(makeAssistantMessage({ text: "ok" }), { piSessionId: "s", entryId: "e1" })) {
      expect(event.payload).not.toHaveProperty("stepIndex");
    }
  });

  it("live path: steps advance at PI's turn_end, reset per prompt, and a message with no open turn keeps NULL", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;
    const t = FIXTURE_TIMESTAMP_MS;
    const user = makeUserMessage("task", t);
    const step0 = makeAssistantMessage({
      toolCalls: [{ id: "c0", name: "read", arguments: {} }],
      stopReason: "toolUse",
      timestamp: t + 1,
    });
    const result0 = makeToolResult({ id: "c0", content: "r0", timestamp: t + 2 });
    const step1 = makeAssistantMessage({ text: "done", timestamp: t + 3 });
    const prompt2 = makeUserMessage("next", t + 4);
    const step0b = makeAssistantMessage({ text: "second turn", timestamp: t + 5 });

    await connector.handlers.message_end(makeMessageEnd(user), ctx);
    await connector.handlers.message_end(makeMessageEnd(step0), ctx);
    await connector.handlers.message_end(makeMessageEnd(result0), ctx);
    await connector.handlers.turn_end(turnEnd, ctx);
    await connector.handlers.message_end(makeMessageEnd(step1), ctx);
    await connector.handlers.turn_end(turnEnd, ctx);
    await connector.handlers.agent_end(makeAgentEnd([user, step0, result0, step1]), ctx);
    await connector.handlers.message_end(makeMessageEnd(prompt2), ctx);
    await connector.handlers.message_end(makeMessageEnd(step0b), ctx);
    await connector.handlers.turn_end(turnEnd, ctx);
    await connector.handlers.agent_end(makeAgentEnd([prompt2, step0b]), ctx);

    const events = await eventsAfterShutdown(started);
    const stepOf = (e: (typeof events)[number]): number | undefined => (e.payload as { stepIndex?: number }).stepIndex;
    expect(events.filter((e) => e.eventKind !== "turn_end").map((e) => [e.eventKind, stepOf(e)])).toEqual([
      ["user_prompt", undefined],
      ["tool_call", 0],
      ["tool_result", 0],
      ["assistant_text", 1],
      ["user_prompt", undefined],
      ["assistant_text", 0],
    ]);
    const listed = await messages.list(threadRef);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((m) => [m.turnId, m.kind, m.stepIndex ?? null])).toEqual([
      ["t1", "user_prompt", null],
      ["t1", "tool_call", 0],
      ["t1", "tool_result", 0],
      ["t1", "assistant_text", 1],
      ["t2", "user_prompt", null],
      ["t2", "assistant_text", 0],
    ]);

    // Reattach onto the thread with no open turn known to the fresh
    // accumulator: an assistant message finalized now is not stamped (NULL).
    const reattached = await attachCapture(store, { thread: threadIdOf(threadRef) }, "resume");
    await reattached.connector.handlers.message_end(
      makeMessageEnd(makeAssistantMessage({ text: "orphan", timestamp: t + 6 })),
      reattached.ctx,
    );
    await reattached.connector.handlers.turn_end(turnEnd, reattached.ctx);
    const after = await eventsAfterShutdown(reattached);
    const orphan = after.filter((e) => e.eventKind === "assistant_text").at(-1);
    expect(orphan?.payload).toMatchObject({ text: "orphan" });
    expect(orphan?.payload).not.toHaveProperty("stepIndex");
    const read = await intakeStream.listEvents(threadRef);
    expect(read.ok && read.value.length).toBe(after.length);
  });
});
