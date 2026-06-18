// Story 2 — parallel-tool correlation (TC-2.4), error-result capture (TC-2.5),
// and idempotent re-delivery (TC-2.7, the idempotency architecture-risk). The
// first two run the production path and read the thread back; TC-2.7 drives
// capture() directly so it can assert the per-event skip outcomes the SDK
// returns on re-delivery.

import { createDeterministicProvider, intakeStream } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../../src/capture/converter.js";
import { mapMessage } from "../../src/capture/map-message.js";
import { TurnAccumulator } from "../../src/capture/turn-accumulator.js";
import { initInstance } from "../../src/lifecycle/instance.js";
import {
  makeAgentEnd,
  makeAssistantMessage,
  makeMessageEnd,
  makeToolResult,
  makeUserMessage,
} from "../fixtures/synthetic.js";
import { makeTempThread, type TempStore, tempStore } from "../fixtures/thread.js";
import { eventsAfterShutdown, kindsOf, startCapture } from "./support.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

interface ToolResultPayload {
  toolCallId: string;
  content: string;
  isError?: boolean;
}
function toolResultPayload(event: { payload: unknown }): ToolResultPayload {
  return event.payload as ToolResultPayload;
}

describe("Story 2: parallel tool calls (TC-2.4)", () => {
  it("correlates each out-of-order tool_result to its call by toolCallId, not arrival order", async () => {
    const started = await startCapture(store);
    const { connector, ctx } = started;

    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("read both files")));
    await connector.handlers.message_end(
      ctx,
      makeMessageEnd(
        makeAssistantMessage({
          toolCalls: [
            { id: "call_a", name: "read_file", arguments: { path: "a.txt" } },
            { id: "call_b", name: "read_file", arguments: { path: "b.txt" } },
          ],
        }),
      ),
    );
    // Results complete out of arrival order: b before a.
    await connector.handlers.message_end(ctx, makeMessageEnd(makeToolResult({ id: "call_b", content: "b body" })));
    await connector.handlers.message_end(ctx, makeMessageEnd(makeToolResult({ id: "call_a", content: "a body" })));
    await connector.handlers.message_end(ctx, makeMessageEnd(makeAssistantMessage({ text: "read both" })));
    await connector.handlers.agent_end(ctx, makeAgentEnd([]));

    const events = await eventsAfterShutdown(started);
    const results = events.filter((event) => event.eventKind === "tool_result");
    expect(results).toHaveLength(2);

    // Each result carries its own call's id and content — correlation is by id.
    const contentById = new Map(
      results.map((event) => [toolResultPayload(event).toolCallId, toolResultPayload(event).content]),
    );
    expect(contentById.get("call_b")).toBe("b body");
    expect(contentById.get("call_a")).toBe("a body");

    // Arrival order is preserved in the record (b then a), each correctly tagged
    // — proving the tag, not the position, is the correlation.
    expect(toolResultPayload(results[0]!).toolCallId).toBe("call_b");
    expect(toolResultPayload(results[1]!).toolCallId).toBe("call_a");
  });
});

describe("Story 2: error tool result (TC-2.5)", () => {
  it("captures an error tool_result with the error flag and its content, dropping nothing", async () => {
    const started = await startCapture(store);
    const { connector, ctx } = started;

    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("read missing.txt")));
    await connector.handlers.message_end(
      ctx,
      makeMessageEnd(
        makeAssistantMessage({ toolCalls: [{ id: "call_a", name: "read_file", arguments: { path: "missing.txt" } }] }),
      ),
    );
    await connector.handlers.message_end(
      ctx,
      makeMessageEnd(makeToolResult({ id: "call_a", isError: true, content: "ENOENT: no such file" })),
    );
    await connector.handlers.message_end(ctx, makeMessageEnd(makeAssistantMessage({ text: "it does not exist" })));
    await connector.handlers.agent_end(ctx, makeAgentEnd([]));

    const events = await eventsAfterShutdown(started);
    // Nothing dropped because the tool failed.
    expect(kindsOf(events)).toEqual(["user_prompt", "tool_call", "tool_result", "assistant_text", "turn_end"]);

    const result = events.find((event) => event.eventKind === "tool_result");
    expect(result).toBeDefined();
    expect(toolResultPayload(result!).isError).toBe(true);
    expect(toolResultPayload(result!).content).toBe("ENOENT: no such file");
  });

  it("records unsupported tool_result content parts as omission runtime_notes", () => {
    const events = mapMessage(
      {
        role: "toolResult",
        toolCallId: "call_file",
        content: [{ type: "fileRef", path: "artifact.bin" }],
      },
      { piSessionId: "sess" },
    );

    expect(kindsOf(events)).toEqual(["tool_result", "runtime_note"]);
    expect(toolResultPayload(events[0]!).toolCallId).toBe("call_file");
    expect(toolResultPayload(events[0]!).content).toBe("");
    expect(events[1]!.payload).toEqual({
      text: "unsupported content omitted: file reference (artifact.bin)",
    });
  });

  it("gives each unsupported tool_result part a distinct omission key", () => {
    const events = mapMessage(
      {
        role: "toolResult",
        toolCallId: "call_file",
        content: [
          { type: "fileRef", path: "artifact-a.bin" },
          { type: "fileRef", path: "artifact-b.bin" },
        ],
      },
      { piSessionId: "sess" },
    );

    expect(kindsOf(events)).toEqual(["tool_result", "runtime_note", "runtime_note"]);
    expect(events[1]!.idempotencyKey).not.toBe(events[2]!.idempotencyKey);
    expect(events[1]!.idempotencyKey).toContain("call_file:omission:0");
    expect(events[2]!.idempotencyKey).toContain("call_file:omission:1");
  });
});

describe("Story 2: idempotent re-delivery (TC-2.7, idempotency risk)", () => {
  it("skips a re-delivered batch by idempotency key and records no duplicates", async () => {
    const thread = await makeTempThread(store);
    const built = await initInstance(thread.threadRef, {
      provider: createDeterministicProvider(),
      mode: "background",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const instance = built.value;

    // Build one logical turn's events through the real map + accumulator, so the
    // keys are exactly what production would emit.
    const acc = new TurnAccumulator({ piSessionId: "sess" });
    const userEvents = mapMessage(makeUserMessage("hello"), { piSessionId: "sess", entryId: "s0" });
    acc.onMessage(userEvents);
    const assistantEvents = mapMessage(makeAssistantMessage({ text: "hi there" }), {
      piSessionId: "sess",
      entryId: "s1",
    });
    acc.onMessage(assistantEvents);
    const turnEnd = acc.onAgentEnd();
    const batch = [...userEvents, ...assistantEvents, ...turnEnd];

    const first = await capture(batch, instance);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.events.every((entry) => entry.outcome === "recorded")).toBe(true);
    }

    // Re-delivery (the reload / crash-replay path): identical keys → all skipped.
    const second = await capture(batch, instance);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.events.every((entry) => entry.outcome === "skipped")).toBe(true);
      expect(second.value.events.every((entry) => entry.skipReason === "duplicate_idempotency_key")).toBe(true);
    }

    // No duplicate records landed on the thread.
    const read = await intakeStream.listEvents(instance.threadRef);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toHaveLength(batch.length);

    await instance.dispose();
  });
});
