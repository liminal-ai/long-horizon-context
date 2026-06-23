// Story 2 — converter orchestration: ordered fan-out (TC-2.1), capture-failure
// isolation (TC-2.8, atomicity risk), and runtime-change capture (TC-2.9). The
// production path runs end to end — PI hook → converter → real LHC intake —
// and every assertion reads the durable thread back. TC-2.8 also exercises
// capture() directly because the two failure shapes (writable→gap vs
// store-unavailable→health) are the architecture-risk contract.
import { rmSync } from "node:fs";
import { createDeterministicInferenceCallbacks, inspect, intakeStream, type MessageEventInput, threads } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../../src/capture/converter.js";
import { initInstance } from "../../src/lifecycle/instance.js";
import type { LhcInstance } from "../../src/shared/instance.js";
import {
  makeAgentEnd,
  makeAssistantMessage,
  makeMessageEnd,
  makeToolResult,
  makeUserMessage,
  validEvent,
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

function textOf(event: MessageEventInput): string {
  return (event.payload as { text?: string }).text ?? "";
}

describe("Story 2: converter — capture and fan-out (TC-2.1)", () => {
  it("records a user/assistant/toolResult sequence in source order, fanning the assistant out thinking → text → tool_call", async () => {
    const started = await startCapture(store);
    const { connector, ctx } = started;

    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("read the file")));
    await connector.handlers.message_end(
      ctx,
      makeMessageEnd(
        makeAssistantMessage({
          thinking: "I should open it",
          text: "here is the answer",
          toolCalls: [{ id: "call_x", name: "read_file", arguments: { path: "notes.txt" } }],
        }),
      ),
    );
    await connector.handlers.message_end(ctx, makeMessageEnd(makeToolResult({ id: "call_x", content: "file body" })));
    await connector.handlers.agent_end(ctx, makeAgentEnd([]));

    // No silent capture failure on the happy path.
    expect(connector.snapshot().lastDiagnostic).toBeNull();

    const events = await eventsAfterShutdown(started);
    expect(kindsOf(events)).toEqual([
      "user_prompt",
      "assistant_thinking",
      "assistant_text",
      "tool_call",
      "tool_result",
      "turn_end",
    ]);

    expect(textOf(events[0]!)).toBe("read the file");
    expect(textOf(events[1]!)).toBe("I should open it");
    expect(textOf(events[2]!)).toBe("here is the answer");
    expect(events[3]!.payload).toMatchObject({
      toolCallId: "call_x",
      toolName: "read_file",
      arguments: { path: "notes.txt" },
    });
    expect(events[4]!.payload).toMatchObject({ toolCallId: "call_x", content: "file body" });
  });
});

describe("Story 2: converter — runtime-change capture (TC-2.9)", () => {
  it("captures model_select and thinking_level_select as ordered runtime_notes carrying new + previous values", async () => {
    const started = await startCapture(store);
    const { connector, ctx } = started;

    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("go")));
    await connector.handlers.model_select(ctx, {
      model: { provider: "openai", id: "gpt-4o" },
      previousModel: { provider: "anthropic", id: "claude-3" },
    });
    await connector.handlers.thinking_level_select(ctx, { level: "high", previousLevel: "low" });
    await connector.handlers.message_end(ctx, makeMessageEnd(makeAssistantMessage({ text: "done" })));
    await connector.handlers.agent_end(ctx, makeAgentEnd([]));

    const events = await eventsAfterShutdown(started);
    // Ordering relative to the surrounding messages is preserved.
    expect(kindsOf(events)).toEqual(["user_prompt", "runtime_note", "runtime_note", "assistant_text", "turn_end"]);

    const modelNote = textOf(events[1]!);
    expect(modelNote).toContain("anthropic/claude-3");
    expect(modelNote).toContain("openai/gpt-4o");

    const levelNote = textOf(events[2]!);
    expect(levelNote).toContain("low");
    expect(levelNote).toContain("high");
  });

  it("records repeated identical model_select hooks as distinct source-position events", async () => {
    const started = await startCapture(store);
    const { connector, ctx } = started;
    const event = { model: { provider: "openai", id: "gpt-4o" }, position: 12 };

    await connector.handlers.model_select(ctx, event);
    await connector.handlers.model_select(ctx, { ...event, position: 13 });
    await connector.handlers.model_select(ctx, event);

    const events = await eventsAfterShutdown(started);
    expect(kindsOf(events)).toEqual(["runtime_note", "runtime_note"]);
    expect(events[0]!.idempotencyKey).toContain("model_select:12");
    expect(events[1]!.idempotencyKey).toContain("model_select:13");
    expect(events[0]!.idempotencyKey).not.toBe(events[1]!.idempotencyKey);
  });

  it("records repeated identical no-position model_select hooks as distinct connector-source events", async () => {
    const started = await startCapture(store);
    const { connector, ctx } = started;
    const event = { model: { provider: "openai", id: "gpt-4o" } };

    await connector.handlers.model_select(ctx, event);
    await connector.handlers.model_select(ctx, event);

    const events = await eventsAfterShutdown(started);
    expect(kindsOf(events)).toEqual(["runtime_note", "runtime_note"]);
    expect(events[0]!.idempotencyKey).toContain("model_select:sourceSeq:0");
    expect(events[1]!.idempotencyKey).toContain("model_select:sourceSeq:1");
    expect(events[0]!.idempotencyKey).not.toBe(events[1]!.idempotencyKey);
  });
});

describe("Story 2: converter — connector fallback idempotency", () => {
  it("records repeated same-content no-entry/no-position messages as distinct connector-source events", async () => {
    const started = await startCapture(store);
    const { connector, ctx } = started;

    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("same text")));
    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("same text")));

    const events = await eventsAfterShutdown(started);
    expect(kindsOf(events)).toEqual(["user_prompt", "user_prompt"]);
    expect(events[0]!.idempotencyKey).toContain("message_end:sourceSeq:0");
    expect(events[1]!.idempotencyKey).toContain("message_end:sourceSeq:1");
    expect(events[0]!.idempotencyKey).not.toBe(events[1]!.idempotencyKey);
  });
});

describe("Story 2: converter — failure isolation (TC-2.8, atomicity risk)", () => {
  async function liveInstance(): Promise<LhcInstance> {
    const thread = await makeTempThread(store);
    const built = await initInstance(thread.threadRef, {
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
      mode: "background",
    });
    if (!built.ok) throw new Error(`instance init failed: ${built.error.reason}`);
    return built.value;
  }

  it("(a) a malformed event on a writable thread records a durable, queryable gap and never throws", async () => {
    const instance = await liveInstance();
    // A turn_end with a non-empty payload is rejected by LHC validation
    // (invalid_event) — a writable-thread malformed event, the AC-2.7 case.
    const malformed = {
      eventKind: "turn_end",
      idempotencyKey: "malformed-1",
      actor: "system",
      harness: "pi",
      payload: { stowaway: true },
    } as unknown as MessageEventInput;

    const result = await capture([malformed], instance);
    expect(result.ok).toBe(false);

    // The session continues: a durable, queryable gap is recorded on the thread.
    const read = await intakeStream.listEvents(instance.threadRef);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const gaps = read.value.filter(
      (event) =>
        event.eventKind === "runtime_note" && (event.payload as { text: string }).text.toLowerCase().includes("gap"),
    );
    expect(gaps).toHaveLength(1);

    const health = await inspect.health(instance.threadRef);
    expect(health.ok).toBe(true);
    if (!health.ok) return;
    expect(health.value.owners).toContainEqual({
      owner: "capture",
      kind: "capture_gap",
      counts: { ready: 0, pending: 0, retrying: 0, failed: 1, blocked: 0 },
    });
    expect(health.value.failures).toContainEqual({
      owner: "capture",
      subjectKind: "event",
      subjectId: String(gaps[0]!.eventOrder),
      derivationType: "capture_gap",
      reason: (gaps[0]!.payload as { text: string }).text,
      attempts: 0,
    });

    await instance.dispose();
  });

  it("(b) an unavailable thread store surfaces a structured failure with no gap and no throw", async () => {
    const deadInstance: LhcInstance = {
      sdk: (await liveInstance()).sdk,
      threadRef: { filePath: `${store.dir}/does-not-exist.sqlite` },
      dispose: () => Promise.resolve({ ok: true, value: undefined }),
    };

    // capture isolates the failure into a structured result rather than throwing.
    const result = await capture([validEvent("user_prompt")], deadInstance);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["thread_not_found", "storage_failure"]).toContain(result.error.code);
    // It is NOT misclassified as the writable-thread malformed-event case.
    expect(result.error.code).not.toBe("invalid_event");
  });

  it("(b) an unavailable store routes to an extension health signal (recordedGap:false), session continues", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;

    // Make the live thread's store unavailable mid-session, then capture.
    const id = (threadRef as { threadId: string }).threadId;
    const row = await threads.resolve({ threadId: id, registryPath: store.registryPath });
    expect(row.ok).toBe(true);
    if (!row.ok) return;
    rmSync(row.value.filePath, { force: true });

    // The hook must not throw despite the dead store.
    await expect(
      connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("after the store died"))),
    ).resolves.toBeUndefined();

    const health = connector.getState()?.health.lastCaptureFailure;
    expect(health).toBeDefined();
    expect(health?.recordedGap).toBe(false);

    await connector.handlers.session_shutdown(ctx, { reason: "shutdown" });
  });

  it("(c) an unmappable hook input on a writable thread records a durable gap, surfaces in health, and does not throw", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;

    await expect(
      connector.handlers.message_end(ctx, {
        position: 71,
        message: { role: "badRole", content: [] } as never,
      }),
    ).resolves.toBeUndefined();
    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("session continues"), undefined, 72));

    const read = await intakeStream.listEvents(threadRef);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const gaps = read.value.filter(
      (event) => event.eventKind === "runtime_note" && (event.payload as { text: string }).text.includes("capture gap"),
    );
    expect(gaps).toHaveLength(1);
    expect((gaps[0]!.payload as { text: string }).text).toContain("unmappable PI hook input");

    const health = await inspect.health(threadRef);
    expect(health.ok).toBe(true);
    if (!health.ok) return;
    expect(health.value.failures).toContainEqual({
      owner: "capture",
      subjectKind: "event",
      subjectId: String(gaps[0]!.eventOrder),
      derivationType: "capture_gap",
      reason: (gaps[0]!.payload as { text: string }).text,
      attempts: 0,
    });

    await connector.handlers.session_shutdown(ctx, { reason: "shutdown" });
    const events = await intakeStream.listEvents(threadRef);
    expect(events.ok).toBe(true);
    if (events.ok) expect(events.value.some((event) => textOf(event) === "session continues")).toBe(true);
  });
});
