// Schema v5 host-facts wiring in pi-lhc: providerUsage on assistant_text,
// turn_end outcome/timing, idempotency-key stability under payload enrichment,
// the documented pure-tool-call usage gap (R1), and hard-kill NULL facts.
import { createDeterministicInferenceCallbacks, intakeStream, messages, turns } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../../src/capture/converter.js";
import { mapMessage } from "../../src/capture/map-message.js";
import { TurnAccumulator } from "../../src/capture/turn-accumulator.js";
import { initInstance } from "../../src/lifecycle/instance.js";
import {
  FIXTURE_TIMESTAMP_MS,
  makeAgentEnd,
  makeAssistantMessage,
  makeMessageEnd,
  makeUserMessage,
  zeroUsage,
} from "../fixtures/synthetic.js";
import { makeTempThread, type TempStore, tempStore } from "../fixtures/thread.js";
import { eventsAfterShutdown, kindsOf, startCapture, turnCounts } from "./support.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

const SAMPLE_USAGE = zeroUsage({ input: 100, output: 20, totalTokens: 120 });

describe("schema v5: providerUsage on assistant_text", () => {
  it("attaches msg.usage verbatim as providerUsage when a text part exists", () => {
    const events = mapMessage(
      makeAssistantMessage({
        text: "hello",
        usage: SAMPLE_USAGE,
        responseId: "resp-1",
      }),
      { piSessionId: "s", entryId: "e1" },
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.eventKind).toBe("assistant_text");
    expect(events[0]!.payload).toEqual({
      text: "hello",
      providerUsage: SAMPLE_USAGE,
    });
  });

  it("R1 gap: pure tool-call assistant yields tool_call only — no assistant_text, no usage anywhere", () => {
    // Documented CAPTURE-GAPS / schema-v6 candidate: no vehicle for usage.
    const usage = zeroUsage({ input: 99, output: 11, totalTokens: 110 });
    const events = mapMessage(
      makeAssistantMessage({
        toolCalls: [{ id: "call_x", name: "read_file", arguments: { path: "a.txt" } }],
        stopReason: "toolUse",
        usage,
      }),
      { piSessionId: "s", entryId: "e-tool-only" },
    );
    expect(events.map((e) => e.eventKind)).toEqual(["tool_call"]);
    expect(events.some((e) => e.eventKind === "assistant_text")).toBe(false);
    for (const event of events) {
      expect(JSON.stringify(event.payload)).not.toContain("providerUsage");
      expect(JSON.stringify(event.payload)).not.toContain('"input":99');
    }
  });

  it("R1 gap: thinking-only assistant has no assistant_text and drops usage", () => {
    const events = mapMessage(
      makeAssistantMessage({
        thinking: "pondering",
        usage: SAMPLE_USAGE,
      }),
      { piSessionId: "s", entryId: "e-think" },
    );
    expect(events.map((e) => e.eventKind)).toEqual(["assistant_thinking"]);
    expect(JSON.stringify(events[0]!.payload)).not.toContain("providerUsage");
  });
});

describe("schema v5: turn outcome and timing", () => {
  it("latches startedAt from the first message timestamp and maps stopReason → outcome", () => {
    const acc = new TurnAccumulator({ piSessionId: "sess" });
    const user = makeUserMessage("prompt", FIXTURE_TIMESTAMP_MS);
    const assistant = makeAssistantMessage({
      text: "done",
      stopReason: "stop",
      timestamp: FIXTURE_TIMESTAMP_MS + 5000,
    });
    acc.onMessage(mapMessage(user, { piSessionId: "sess", entryId: "u1" }), user);
    acc.onMessage(mapMessage(assistant, { piSessionId: "sess", entryId: "a1" }), assistant);
    const [turnEnd] = acc.onAgentEnd({ messages: [user, assistant] });
    expect(turnEnd?.eventKind).toBe("turn_end");
    expect(turnEnd?.payload).toEqual({
      outcome: "completed",
      startedAt: new Date(FIXTURE_TIMESTAMP_MS).toISOString(),
      endedAt: new Date(FIXTURE_TIMESTAMP_MS + 5000).toISOString(),
    });
  });

  it("maps length → completed with outcomeReason length; error/aborted → aborted", () => {
    const cases: Array<{
      stopReason: "length" | "error" | "aborted" | "toolUse";
      errorMessage?: string;
      want: { outcome: "completed" | "aborted"; outcomeReason?: string };
    }> = [
      { stopReason: "length", want: { outcome: "completed", outcomeReason: "length" } },
      { stopReason: "toolUse", want: { outcome: "completed" } },
      {
        stopReason: "error",
        errorMessage: "provider blew up",
        want: { outcome: "aborted", outcomeReason: "provider blew up" },
      },
      { stopReason: "error", want: { outcome: "aborted", outcomeReason: "error" } },
      { stopReason: "aborted", want: { outcome: "aborted", outcomeReason: "aborted" } },
    ];
    for (const c of cases) {
      const acc = new TurnAccumulator({ piSessionId: "sess" });
      const user = makeUserMessage("p", FIXTURE_TIMESTAMP_MS);
      const assistant = makeAssistantMessage({
        text: "x",
        stopReason: c.stopReason,
        ...(c.errorMessage !== undefined ? { errorMessage: c.errorMessage } : {}),
        timestamp: FIXTURE_TIMESTAMP_MS + 1,
      });
      acc.onMessage(mapMessage(user, { piSessionId: "sess", entryId: `u-${c.stopReason}` }), user);
      acc.onMessage(mapMessage(assistant, { piSessionId: "sess", entryId: `a-${c.stopReason}` }), assistant);
      const [turnEnd] = acc.onAgentEnd({ messages: [assistant] });
      expect(turnEnd?.payload).toMatchObject(c.want);
    }
  });

  it("final agent_end state governs: mid-turn abort that ends clean → completed", () => {
    const acc = new TurnAccumulator({ piSessionId: "sess" });
    const user = makeUserMessage("p", FIXTURE_TIMESTAMP_MS);
    const midAbort = makeAssistantMessage({
      text: "partial",
      stopReason: "aborted",
      timestamp: FIXTURE_TIMESTAMP_MS + 1,
    });
    const finalClean = makeAssistantMessage({
      text: "finished after continue",
      stopReason: "stop",
      timestamp: FIXTURE_TIMESTAMP_MS + 2,
    });
    acc.onMessage(mapMessage(user, { piSessionId: "sess", entryId: "u" }), user);
    acc.onMessage(mapMessage(midAbort, { piSessionId: "sess", entryId: "a1" }), midAbort);
    acc.onMessage(mapMessage(finalClean, { piSessionId: "sess", entryId: "a2" }), finalClean);
    // agent_end.messages ends with the clean stop — that governs.
    const [turnEnd] = acc.onAgentEnd({ messages: [user, midAbort, finalClean] });
    expect(turnEnd?.payload).toMatchObject({ outcome: "completed" });
    expect(turnEnd?.payload).not.toHaveProperty("outcomeReason");
  });

  it("live path: aborted stopReason closes with outcome aborted and projects to turns", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;
    const user = makeUserMessage("write a long essay", FIXTURE_TIMESTAMP_MS);
    const assistant = makeAssistantMessage({
      text: "Once upon a",
      stopReason: "aborted",
      timestamp: FIXTURE_TIMESTAMP_MS + 100,
      usage: SAMPLE_USAGE,
    });
    await connector.handlers.message_end(makeMessageEnd(user), ctx);
    await connector.handlers.message_end(makeMessageEnd(assistant), ctx);
    await connector.handlers.agent_end(makeAgentEnd([user, assistant]), ctx);

    const events = await eventsAfterShutdown(started);
    const turnEnd = events.find((e) => e.eventKind === "turn_end");
    expect(turnEnd?.payload).toEqual({
      outcome: "aborted",
      outcomeReason: "aborted",
      startedAt: new Date(FIXTURE_TIMESTAMP_MS).toISOString(),
      endedAt: new Date(FIXTURE_TIMESTAMP_MS + 100).toISOString(),
    });
    const assistantText = events.find((e) => e.eventKind === "assistant_text");
    expect(assistantText?.payload).toEqual({
      text: "Once upon a",
      providerUsage: SAMPLE_USAGE,
    });

    const listed = await turns.listTurns(threadRef);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const closed = listed.value.find((t) => t.status === "closed");
    expect(closed).toMatchObject({
      outcome: "aborted",
      outcomeReason: "aborted",
      startedAt: new Date(FIXTURE_TIMESTAMP_MS).toISOString(),
      endedAt: new Date(FIXTURE_TIMESTAMP_MS + 100).toISOString(),
    });
  });
});

describe("schema v5: hard-kill leaves turn open with NULL host facts", () => {
  it("records no turn_end and leaves the open turn without outcome/timing", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;
    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("dangling prompt")), ctx);
    await connector.getInstance()?.sdk.drainSettled(threadRef);

    const counts = await turnCounts(threadRef);
    expect(counts.open).toBe(1);
    expect(counts.closed).toBe(0);

    const listed = await turns.listTurns(threadRef);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const open = listed.value.find((t) => t.status === "open");
    expect(open).toBeDefined();
    expect(open).not.toHaveProperty("outcome");
    expect(open).not.toHaveProperty("startedAt");
    expect(open).not.toHaveProperty("endedAt");

    const events = await eventsAfterShutdown(started);
    expect(events.filter((e) => e.eventKind === "turn_end")).toHaveLength(0);
    expect(kindsOf(events)).toEqual(["user_prompt"]);
  });
});

describe("schema v5: idempotency keys ignore payload enrichment (R2)", () => {
  it("enriched vs bare assistant_text / turn_end produce identical keys", () => {
    const bare = mapMessage(makeAssistantMessage({ text: "same text", usage: zeroUsage() }), {
      piSessionId: "s",
      entryId: "e1",
    });
    const rich = mapMessage(
      makeAssistantMessage({
        text: "same text",
        usage: zeroUsage({ input: 999, output: 1, totalTokens: 1000 }),
      }),
      { piSessionId: "s", entryId: "e1" },
    );
    expect(bare[0]!.idempotencyKey).toBe(rich[0]!.idempotencyKey);
    expect(bare[0]!.payload).not.toEqual(rich[0]!.payload);

    const accBare = new TurnAccumulator({ piSessionId: "s" });
    const accRich = new TurnAccumulator({ piSessionId: "s" });
    const user = makeUserMessage("p", FIXTURE_TIMESTAMP_MS);
    const userEvents = mapMessage(user, { piSessionId: "s", entryId: "u1" });
    accBare.onMessage(userEvents);
    accRich.onMessage(userEvents, user);
    const bareEnd = accBare.onAgentEnd();
    const richEnd = accRich.onAgentEnd({
      messages: [makeAssistantMessage({ text: "x", stopReason: "stop", timestamp: FIXTURE_TIMESTAMP_MS + 1 })],
    });
    expect(bareEnd[0]!.idempotencyKey).toBe(richEnd[0]!.idempotencyKey);
    expect(bareEnd[0]!.payload).toEqual({});
    expect(richEnd[0]!.payload).toMatchObject({ outcome: "completed" });
  });

  it("reattach-idempotency keeps first-landed host facts (dedup does not update)", async () => {
    const thread = await makeTempThread(store);
    const built = await initInstance(thread.threadRef, {
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
      mode: "background",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const instance = built.value;

    const user = makeUserMessage("hello", FIXTURE_TIMESTAMP_MS);
    const assistant = makeAssistantMessage({
      text: "world",
      usage: zeroUsage({ input: 1, output: 1, totalTokens: 2 }),
      stopReason: "stop",
      timestamp: FIXTURE_TIMESTAMP_MS + 10,
    });
    const acc = new TurnAccumulator({ piSessionId: "sess" });
    const userEvents = mapMessage(user, { piSessionId: "sess", entryId: "s0" });
    acc.onMessage(userEvents, user);
    const assistantEvents = mapMessage(assistant, { piSessionId: "sess", entryId: "s1" });
    acc.onMessage(assistantEvents, assistant);
    const turnEnd = acc.onAgentEnd({ messages: [user, assistant] });
    const firstBatch = [...userEvents, ...assistantEvents, ...turnEnd];

    const first = await capture(firstBatch, instance);
    expect(first.ok).toBe(true);

    // Re-delivery with *different* facts under the same keys — must skip, not update.
    const richerAssistant = mapMessage(
      makeAssistantMessage({
        text: "world",
        usage: zeroUsage({ input: 999, output: 999, totalTokens: 1998 }),
        stopReason: "stop",
        timestamp: FIXTURE_TIMESTAMP_MS + 10,
      }),
      { piSessionId: "sess", entryId: "s1" },
    );
    const acc2 = new TurnAccumulator({ piSessionId: "sess" });
    acc2.onMessage(userEvents, user);
    acc2.onMessage(richerAssistant, assistant);
    const richerEnd = acc2.onAgentEnd({
      messages: [
        user,
        makeAssistantMessage({
          text: "world",
          stopReason: "aborted",
          timestamp: FIXTURE_TIMESTAMP_MS + 99,
        }),
      ],
    });
    expect(richerAssistant[0]!.idempotencyKey).toBe(assistantEvents[0]!.idempotencyKey);
    expect(richerEnd[0]!.idempotencyKey).toBe(turnEnd[0]!.idempotencyKey);

    const second = await capture([...userEvents, ...richerAssistant, ...richerEnd], instance);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.events.every((e) => e.outcome === "skipped")).toBe(true);
    }

    const read = await intakeStream.listEvents(instance.threadRef);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const landedText = read.value.find((e) => e.eventKind === "assistant_text");
    expect(landedText?.payload).toEqual({
      text: "world",
      providerUsage: zeroUsage({ input: 1, output: 1, totalTokens: 2 }),
    });
    const landedEnd = read.value.find((e) => e.eventKind === "turn_end");
    expect(landedEnd?.payload).toMatchObject({ outcome: "completed" });
    expect(landedEnd?.payload).not.toMatchObject({ outcome: "aborted" });

    // messages surface also keeps first-landed providerUsage.
    const listed = await messages.list(instance.threadRef);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const asst = listed.value.find((m) => m.kind === "assistant_text");
      expect(asst?.providerUsage).toEqual(zeroUsage({ input: 1, output: 1, totalTokens: 2 }));
    }

    await instance.dispose();
  });
});
