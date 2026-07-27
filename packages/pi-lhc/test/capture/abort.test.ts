// Story 2 — graceful interrupt (TC-2.6). A turn PI marks aborted is captured
// whole: the partial assistant content is recorded, the aborted disposition is
// carried through (the mapper carries stopReason — research §5b — onto the only
// durable vehicle, a runtime_note), and the turn closes complete-but-aborted at
// agent_end. The interrupted content is never discarded.

import type { MessageEventInput } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeAgentEnd, makeAssistantMessage, makeMessageEnd, makeUserMessage } from "../fixtures/synthetic.js";
import { type TempStore, tempStore } from "../fixtures/thread.js";
import { eventsAfterShutdown, kindsOf, startCapture, turnCounts } from "./support.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

function textOf(event: MessageEventInput): string {
  return (event.payload as { text?: string }).text ?? "";
}

describe("Story 2: graceful interrupt (TC-2.6)", () => {
  it("records partial assistant content, carries the aborted disposition, and closes the turn complete-but-aborted", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;

    const user = makeUserMessage("write a long essay");
    const assistant = makeAssistantMessage({
      thinking: "starting the essay",
      text: "Once upon a",
      stopReason: "aborted",
    });
    await connector.handlers.message_end(makeMessageEnd(user), ctx);
    await connector.handlers.message_end(makeMessageEnd(assistant), ctx);
    // agent_end.messages final state governs outcome (schema v5).
    await connector.handlers.agent_end(makeAgentEnd([user, assistant]), ctx);

    // A graceful interrupt is not a capture failure.
    expect(connector.snapshot().lastDiagnostic).toBeNull();

    const events = await eventsAfterShutdown(started);
    expect(kindsOf(events)).toEqual([
      "user_prompt",
      "assistant_thinking",
      "assistant_text",
      "runtime_note",
      "turn_end",
    ]);

    // Partial content is preserved verbatim — nothing discarded.
    expect(textOf(events[1]!)).toBe("starting the essay");
    expect(textOf(events[2]!)).toBe("Once upon a");
    // The aborted disposition is carried through on the runtime_note.
    expect(textOf(events[3]!).toLowerCase()).toContain("abort");
    // turn_end host facts: aborted outcome (schema v5).
    expect(events.at(-1)?.payload).toMatchObject({
      outcome: "aborted",
      outcomeReason: "aborted",
    });

    // The interrupted turn closes at agent_end, and LHC opens the next empty turn.
    const counts = await turnCounts(threadRef);
    expect(counts.closed).toBe(1);
    expect(counts.open).toBe(1);
  });
});
