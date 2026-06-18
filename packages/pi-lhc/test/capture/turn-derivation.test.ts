// Story 2 — turn derivation, the load-bearing mechanic. An LHC turn spans a
// whole exchange: it opens on a user prompt, ignores every PI per-step
// `turn_end`, and closes with exactly one LHC `turn_end` at `agent_end`
// (TC-2.2). Session order is the converter's source-event order, never PI's
// per-run `turnIndex` (TC-2.3). The accumulator goldens pin the state machine
// directly, including the hard-kill tolerance (a dangling open turn, and an
// agent_end with no open turn as a no-op).

import type { MessageEventInput } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TurnAccumulator } from "../../src/capture/turn-accumulator.js";
import {
  makeAgentEnd,
  makeAssistantMessage,
  makeMessageEnd,
  makeToolResult,
  makeUserMessage,
  validEvent,
} from "../fixtures/synthetic.js";
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

// A PI per-step turn_end payload (ignored by the converter as a boundary).
function piTurnEnd(turnIndex: number) {
  return { turnIndex, message: makeAssistantMessage({ text: "step" }), toolResults: [] };
}

describe("Story 2: turn derivation — worked example (TC-2.2)", () => {
  it("yields exactly one LHC turn with one turn_end at agent_end; PI per-step turn_ends produce none", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;

    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("ask one question")));
    await connector.handlers.message_end(
      ctx,
      makeMessageEnd(
        makeAssistantMessage({
          thinking: "two tools needed",
          toolCalls: [
            { id: "call_a", name: "read_file", arguments: { path: "a.txt" } },
            { id: "call_b", name: "read_file", arguments: { path: "b.txt" } },
          ],
        }),
      ),
    );
    await connector.handlers.message_end(ctx, makeMessageEnd(makeToolResult({ id: "call_b", content: "b" })));
    await connector.handlers.message_end(ctx, makeMessageEnd(makeToolResult({ id: "call_a", content: "a" })));
    // PI fires a per-step turn_end here — it must NOT become an LHC turn_end.
    await connector.handlers.turn_end(ctx, piTurnEnd(0));
    await connector.handlers.message_end(ctx, makeMessageEnd(makeAssistantMessage({ text: "the answer" })));
    await connector.handlers.turn_end(ctx, piTurnEnd(1));
    await connector.handlers.agent_end(ctx, makeAgentEnd([]));

    const events = await eventsAfterShutdown(started);
    expect(kindsOf(events)).toEqual([
      "user_prompt",
      "assistant_thinking",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "assistant_text",
      "turn_end",
    ]);
    // Exactly one LHC turn_end, and it lands last — at agent_end, not per PI step.
    expect(events.filter((event) => event.eventKind === "turn_end")).toHaveLength(1);
    expect(events.at(-1)?.eventKind).toBe("turn_end");

    const counts = await turnCounts(threadRef);
    expect(counts.closed).toBe(1);
    expect(counts.open).toBe(0);
  });
});

describe("Story 2: turn derivation — source order, not turnIndex (TC-2.3)", () => {
  it("orders two agent runs that each start at turnIndex 0 by source-event order, with no collision", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;

    // Run 1 (PI turnIndex 0)
    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("first prompt")));
    await connector.handlers.message_end(ctx, makeMessageEnd(makeAssistantMessage({ text: "first answer" })));
    await connector.handlers.turn_end(ctx, piTurnEnd(0));
    await connector.handlers.agent_end(ctx, makeAgentEnd([]));
    // Run 2 (PI turnIndex 0 AGAIN — the reset-per-run counter)
    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("second prompt")));
    await connector.handlers.message_end(ctx, makeMessageEnd(makeAssistantMessage({ text: "second answer" })));
    await connector.handlers.turn_end(ctx, piTurnEnd(0));
    await connector.handlers.agent_end(ctx, makeAgentEnd([]));

    const events = await eventsAfterShutdown(started);
    expect(kindsOf(events)).toEqual([
      "user_prompt",
      "assistant_text",
      "turn_end",
      "user_prompt",
      "assistant_text",
      "turn_end",
    ]);
    // Source order decides sequence: run 1 precedes run 2 despite identical turnIndex.
    expect(textOf(events[0]!)).toBe("first prompt");
    expect(textOf(events[3]!)).toBe("second prompt");

    const counts = await turnCounts(threadRef);
    expect(counts.closed).toBe(2);
    expect(counts.open).toBe(0);
  });
});

describe("Story 2: turn accumulator — state machine goldens (AC-2.2)", () => {
  it("emits one turn_end only when a turn is open, and is idempotent across agent_end", () => {
    const acc = new TurnAccumulator({ piSessionId: "sess" });
    expect(acc.hasOpenTurn()).toBe(false);

    acc.onMessage([validEvent("user_prompt")]);
    expect(acc.hasOpenTurn()).toBe(true);

    const emitted = acc.onAgentEnd();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.eventKind).toBe("turn_end");
    expect(emitted[0]?.payload).toEqual({});
    expect(acc.hasOpenTurn()).toBe(false);

    // A second agent_end with no open turn emits nothing (hard-kill / reattach
    // tolerance: turn_end-with-no-open-turn is a no-op).
    expect(acc.onAgentEnd()).toEqual([]);
  });

  it("gives successive turns distinct turn_end idempotency keys", () => {
    const acc = new TurnAccumulator({ piSessionId: "sess" });
    acc.onMessage([validEvent("user_prompt")]);
    const first = acc.onAgentEnd();
    acc.onMessage([validEvent("user_prompt")]);
    const second = acc.onAgentEnd();
    expect(first[0]?.idempotencyKey).not.toBe(second[0]?.idempotencyKey);
  });
});

describe("Story 2: turn derivation — hard-kill golden", () => {
  it("leaves a dangling open turn when the run never reaches agent_end, with no turn_end recorded", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;

    // Hard kill: a user message lands, then the process dies — no assistant
    // close, no agent_end.
    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("dangling prompt")));
    await connector.getInstance()?.sdk.drainSettled(threadRef);

    const counts = await turnCounts(threadRef);
    expect(counts.open).toBe(1);
    expect(counts.closed).toBe(0);

    const events = await eventsAfterShutdown(started);
    expect(events.filter((event) => event.eventKind === "turn_end")).toHaveLength(0);
    expect(kindsOf(events)).toEqual(["user_prompt"]);
  });
});
