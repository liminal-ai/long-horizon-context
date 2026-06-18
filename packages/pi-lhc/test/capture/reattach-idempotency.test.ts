// Story 2 — SV-001 regression: existing-thread resume/reload must keep recording
// new finalized events. The connector seeds its capture counters from the
// thread's durable committed state at attach, so a fresh connector's idempotency
// keys continue past the prior session's instead of restarting at 0 and
// skipping new events as false duplicates — while the converter's same-key
// dedup (the reload/replay safety net) stays intact.

import { createDeterministicProvider, intakeStream, type MessageEventInput, type ThreadRef } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../../src/capture/converter.js";
import { mapMessage } from "../../src/capture/map-message.js";
import { TurnAccumulator } from "../../src/capture/turn-accumulator.js";
import { initInstance } from "../../src/lifecycle/instance.js";
import { makeAgentEnd, makeAssistantMessage, makeMessageEnd, makeUserMessage } from "../fixtures/synthetic.js";
import { makeTempThread, type TempStore, tempStore } from "../fixtures/thread.js";
import { attachCapture, eventsAfterShutdown, kindsOf, startCapture, turnCounts } from "./support.js";

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

function userTexts(events: readonly MessageEventInput[]): string[] {
  return events.filter((event) => event.eventKind === "user_prompt").map(textOf);
}

function threadIdOf(ref: ThreadRef): string {
  if (!("threadId" in ref)) throw new Error("expected a { threadId } ref");
  return ref.threadId;
}

describe("Story 2: existing-thread reattach idempotency (SV-001)", () => {
  it("(1) a fresh connector resuming an existing thread records a new finalized event instead of skipping it", async () => {
    // Session A records one exchange, then shuts down.
    const a = await startCapture(store);
    await a.connector.handlers.message_end(a.ctx, makeMessageEnd(makeUserMessage("first")));
    await a.connector.handlers.agent_end(a.ctx, makeAgentEnd([]));
    const threadId = threadIdOf(a.threadRef);
    await a.connector.handlers.session_shutdown(a.ctx, { reason: "shutdown" });

    // A brand-new connector attaches to the SAME thread by id and records a new
    // message — it must NOT be skipped as a prior-key collision.
    const b = await attachCapture(store, { session: threadId }, "resume");
    expect(b.connector.snapshot().lastDiagnostic).toBeNull();
    await b.connector.handlers.message_end(b.ctx, makeMessageEnd(makeUserMessage("second after resume")));
    await b.connector.handlers.agent_end(b.ctx, makeAgentEnd([]));
    expect(b.connector.snapshot().lastDiagnostic).toBeNull();

    const events = await eventsAfterShutdown(b);
    expect(userTexts(events)).toEqual(["first", "second after resume"]);
    const counts = await turnCounts(b.threadRef);
    expect(counts.closed).toBe(2);
  });

  it("(2) a reload onto an existing thread also continues recording new finalized events", async () => {
    const a = await startCapture(store);
    await a.connector.handlers.message_end(a.ctx, makeMessageEnd(makeUserMessage("first")));
    await a.connector.handlers.agent_end(a.ctx, makeAgentEnd([]));
    const threadId = threadIdOf(a.threadRef);
    await a.connector.handlers.session_shutdown(a.ctx, { reason: "reload" });

    const b = await attachCapture(store, { session: threadId }, "reload");
    await b.connector.handlers.message_end(b.ctx, makeMessageEnd(makeUserMessage("second after reload")));
    await b.connector.handlers.agent_end(b.ctx, makeAgentEnd([]));

    const events = await eventsAfterShutdown(b);
    expect(userTexts(events)).toEqual(["first", "second after reload"]);
    const counts = await turnCounts(b.threadRef);
    expect(counts.closed).toBe(2);
  });

  it("(2b) a reload re-delivering the same logical events skips them instead of recording duplicates", async () => {
    const a = await startCapture(store);
    await a.connector.handlers.message_end(a.ctx, makeMessageEnd(makeUserMessage("first"), "entry-user-1"));
    await a.connector.handlers.agent_end(a.ctx, makeAgentEnd([]));
    const threadId = threadIdOf(a.threadRef);
    await a.connector.handlers.session_shutdown(a.ctx, { reason: "reload" });

    const b = await attachCapture(store, { session: threadId }, "reload");
    await b.connector.handlers.message_end(b.ctx, makeMessageEnd(makeUserMessage("first"), "entry-user-1"));
    await b.connector.handlers.agent_end(b.ctx, makeAgentEnd([]));

    const events = await eventsAfterShutdown(b);
    expect(kindsOf(events)).toEqual(["user_prompt", "turn_end"]);
    expect(userTexts(events)).toEqual(["first"]);
    const counts = await turnCounts(b.threadRef);
    expect(counts.closed).toBe(1);

    const built = await initInstance(b.threadRef, {
      provider: createDeterministicProvider(),
      mode: "background",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const instance = built.value;
    const acc = new TurnAccumulator({ piSessionId: threadId });
    const userEvents = mapMessage(makeUserMessage("first"), {
      piSessionId: threadId,
      entryId: "entry-user-1",
    });
    acc.onMessage(userEvents);
    const turnEnd = acc.onAgentEnd();
    const replay = await capture([...userEvents, ...turnEnd], instance);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.events).toEqual([
        {
          idempotencyKey: userEvents[0]!.idempotencyKey,
          outcome: "skipped",
          skipReason: "duplicate_idempotency_key",
        },
        {
          idempotencyKey: turnEnd[0]!.idempotencyKey,
          outcome: "skipped",
          skipReason: "duplicate_idempotency_key",
        },
      ]);
    }
    await instance.dispose();
  });

  it("(3) normal resume records new messages and does not duplicate the prior session's history", async () => {
    // Session A: one complete turn.
    const a = await startCapture(store);
    await a.connector.handlers.message_end(a.ctx, makeMessageEnd(makeUserMessage("first")));
    await a.connector.handlers.message_end(a.ctx, makeMessageEnd(makeAssistantMessage({ text: "answer one" })));
    await a.connector.handlers.agent_end(a.ctx, makeAgentEnd([]));
    const threadId = threadIdOf(a.threadRef);
    await a.connector.handlers.session_shutdown(a.ctx, { reason: "shutdown" });

    // Resume: PI does not re-fire history, so the connector sees only the new
    // turn — which must record, leaving the prior turn intact and un-duplicated.
    const b = await attachCapture(store, { session: threadId }, "resume");
    await b.connector.handlers.message_end(b.ctx, makeMessageEnd(makeUserMessage("second")));
    await b.connector.handlers.message_end(b.ctx, makeMessageEnd(makeAssistantMessage({ text: "answer two" })));
    await b.connector.handlers.agent_end(b.ctx, makeAgentEnd([]));

    const events = await eventsAfterShutdown(b);
    expect(kindsOf(events)).toEqual([
      "user_prompt",
      "assistant_text",
      "turn_end",
      "user_prompt",
      "assistant_text",
      "turn_end",
    ]);
    expect(userTexts(events)).toEqual(["first", "second"]);
    // Two distinct closed turns — the turn_end keys did not collide either.
    const counts = await turnCounts(b.threadRef);
    expect(counts.closed).toBe(2);
    expect(counts.open).toBe(0);
  });

  it("(4) preserves duplicate-safe re-delivery: re-flushing an identical batch is skipped, not duplicated", async () => {
    const thread = await makeTempThread(store);
    const built = await initInstance(thread.threadRef, {
      provider: createDeterministicProvider(),
      mode: "background",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const instance = built.value;

    // Build one turn's events with stable keys, then deliver the SAME batch
    // twice — the second delivery (the reload / crash-replay shape) must dedup.
    const acc = new TurnAccumulator({ piSessionId: "sess" });
    const userEvents = mapMessage(makeUserMessage("hello"), { piSessionId: "sess", entryId: "s0" });
    acc.onMessage(userEvents);
    const batch = [...userEvents, ...acc.onAgentEnd()];

    const first = await capture(batch, instance);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.events.every((entry) => entry.outcome === "recorded")).toBe(true);

    const second = await capture(batch, instance);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.events.every((entry) => entry.outcome === "skipped")).toBe(true);

    const read = await intakeStream.listEvents(instance.threadRef);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toHaveLength(batch.length);

    await instance.dispose();
  });

  it("(5) records two distinct same-content user prompts when PI provides distinct entry ids", async () => {
    const started = await startCapture(store);

    await started.connector.handlers.message_end(
      started.ctx,
      makeMessageEnd(makeUserMessage("repeatable prompt"), "entry-repeat-1"),
    );
    await started.connector.handlers.agent_end(started.ctx, makeAgentEnd([]));
    await started.connector.handlers.message_end(
      started.ctx,
      makeMessageEnd(makeUserMessage("repeatable prompt"), "entry-repeat-2"),
    );
    await started.connector.handlers.agent_end(started.ctx, makeAgentEnd([]));

    const events = await eventsAfterShutdown(started);
    expect(userTexts(events)).toEqual(["repeatable prompt", "repeatable prompt"]);
    expect(events.filter((event) => event.eventKind === "user_prompt").map((event) => event.idempotencyKey)).toEqual([
      expect.stringContaining("entry-repeat-1"),
      expect.stringContaining("entry-repeat-2"),
    ]);
    const counts = await turnCounts(started.threadRef);
    expect(counts.closed).toBe(2);
  });

  it("(6) skips a same-entry re-delivery after reload by duplicate_idempotency_key", async () => {
    const a = await startCapture(store);
    await a.connector.handlers.message_end(a.ctx, makeMessageEnd(makeUserMessage("reload replay"), "entry-replay-1"));
    await a.connector.handlers.agent_end(a.ctx, makeAgentEnd([]));
    const threadId = threadIdOf(a.threadRef);
    await a.connector.handlers.session_shutdown(a.ctx, { reason: "reload" });

    const b = await attachCapture(store, { session: threadId }, "reload");
    await b.connector.handlers.message_end(b.ctx, makeMessageEnd(makeUserMessage("reload replay"), "entry-replay-1"));
    await b.connector.handlers.agent_end(b.ctx, makeAgentEnd([]));

    const events = await eventsAfterShutdown(b);
    expect(userTexts(events)).toEqual(["reload replay"]);

    const built = await initInstance(b.threadRef, {
      provider: createDeterministicProvider(),
      mode: "background",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const instance = built.value;
    const acc = new TurnAccumulator({ piSessionId: threadId });
    const userEvents = mapMessage(makeUserMessage("reload replay"), {
      piSessionId: threadId,
      entryId: "entry-replay-1",
    });
    acc.onMessage(userEvents);
    const turnEnd = acc.onAgentEnd();
    const replay = await capture([...userEvents, ...turnEnd], instance);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.events.every((entry) => entry.skipReason === "duplicate_idempotency_key")).toBe(true);
    }
    await instance.dispose();
  });

  it("(7) records distinct same-content no-entry prompts by PI source position, and skips reload re-delivery of the same position", async () => {
    const a = await startCapture(store);
    await a.connector.handlers.message_end(a.ctx, makeMessageEnd(makeUserMessage("same text"), undefined, 40));
    await a.connector.handlers.agent_end(a.ctx, makeAgentEnd([]));
    await a.connector.handlers.message_end(a.ctx, makeMessageEnd(makeUserMessage("same text"), undefined, 41));
    await a.connector.handlers.agent_end(a.ctx, makeAgentEnd([]));
    const threadId = threadIdOf(a.threadRef);
    await a.connector.handlers.session_shutdown(a.ctx, { reason: "reload" });

    const b = await attachCapture(store, { session: threadId }, "reload");
    await b.connector.handlers.message_end(b.ctx, makeMessageEnd(makeUserMessage("same text"), undefined, 40));
    await b.connector.handlers.agent_end(b.ctx, makeAgentEnd([]));

    const events = await eventsAfterShutdown(b);
    expect(userTexts(events)).toEqual(["same text", "same text"]);
    const promptKeys = events.filter((event) => event.eventKind === "user_prompt").map((event) => event.idempotencyKey);
    expect(promptKeys).toHaveLength(2);
    expect(promptKeys[0]).toContain("message_end:40");
    expect(promptKeys[1]).toContain("message_end:41");
    expect(promptKeys[0]).not.toBe(promptKeys[1]);
  });

  it("(8) skips reload re-delivery of the same no-entry/no-position prompt by connector source order", async () => {
    const a = await startCapture(store);
    await a.connector.handlers.message_end(a.ctx, makeMessageEnd(makeUserMessage("source-order replay")));
    await a.connector.handlers.agent_end(a.ctx, makeAgentEnd([]));
    const threadId = threadIdOf(a.threadRef);
    await a.connector.handlers.session_shutdown(a.ctx, { reason: "reload" });

    const b = await attachCapture(store, { session: threadId }, "reload");
    await b.connector.handlers.message_end(b.ctx, makeMessageEnd(makeUserMessage("source-order replay")));
    await b.connector.handlers.agent_end(b.ctx, makeAgentEnd([]));

    const events = await eventsAfterShutdown(b);
    expect(kindsOf(events)).toEqual(["user_prompt", "turn_end"]);
    expect(userTexts(events)).toEqual(["source-order replay"]);
    const promptKeys = events.filter((event) => event.eventKind === "user_prompt").map((event) => event.idempotencyKey);
    expect(promptKeys).toEqual([expect.stringContaining("message_end:sourceSeq:0")]);
    const counts = await turnCounts(b.threadRef);
    expect(counts.closed).toBe(1);
  });
});
