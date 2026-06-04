import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../../src/commands/run.js";
import { countLocalTokens, localTokenizerMetadataFields } from "../../src/token-counting/local-token-counter.js";
import { ThreadEventStore, ThreadEventStoreError } from "../../src/thread-events/store.js";
import type { ThreadEventAppendInput } from "../../src/thread-events/schema.js";

function tempThreadDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "lhc-thread-events-")), "thread.sqlite");
}

function appendInput(overrides: Partial<ThreadEventAppendInput> = {}): ThreadEventAppendInput {
  return {
    idempotencyKey: "idem-user-1",
    eventKind: "user_prompt",
    actor: { actorKind: "user", actorId: "user-1", displayName: "Lee" },
    harness: { runtime: "codex", externalThreadId: "external-thread-1" },
    occurredAt: "2026-05-30T12:00:00.000Z",
    origin: { envelopeId: "env-1", envelopeOrder: 1 },
    payload: { text: "Hello" },
    ...overrides,
  } as ThreadEventAppendInput;
}

function turnEndInput(overrides: Partial<ThreadEventAppendInput> = {}): ThreadEventAppendInput {
  return appendInput({
    idempotencyKey: "idem-turn-end-1",
    eventKind: "turn_end",
    actor: { actorKind: "runtime", actorId: "codex-cli" },
    payload: {},
    ...overrides,
  });
}

function basicTurnEvents(): ThreadEventAppendInput[] {
  return [
    appendInput({
      idempotencyKey: "idem-user-1",
      eventKind: "user_prompt",
      actor: { actorKind: "user", actorId: "user-1", displayName: "Lee" },
      payload: { text: "Can you inspect this repository?" },
      origin: { envelopeId: "env-1", envelopeOrder: 1 },
    }),
    appendInput({
      idempotencyKey: "idem-assistant-text-1",
      eventKind: "assistant_text",
      actor: { actorKind: "assistant", actorId: "assistant-1", displayName: "Agent" },
      payload: { text: "I will inspect the repository." },
      origin: { envelopeId: "env-1", envelopeOrder: 2 },
    }),
    appendInput({
      idempotencyKey: "idem-thinking-1",
      eventKind: "assistant_thinking",
      actor: { actorKind: "assistant", actorId: "assistant-1", displayName: "Agent" },
      payload: { thinkingKind: "reasoning", text: "Need to list files first." },
      origin: { envelopeId: "env-1", envelopeOrder: 3 },
    }),
    appendInput({
      idempotencyKey: "idem-tool-call-1",
      eventKind: "tool_call",
      actor: { actorKind: "assistant", actorId: "assistant-1", displayName: "Agent" },
      payload: { toolCallId: "call-1", toolName: "list_files", argumentsJson: { path: "." } },
      origin: { envelopeId: "env-1", envelopeOrder: 4 },
    }),
    appendInput({
      idempotencyKey: "idem-tool-result-1",
      eventKind: "tool_result",
      actor: { actorKind: "tool", actorId: "list_files" },
      payload: { toolCallId: "call-1", text: "package.json\npackages/" },
      origin: { envelopeId: "env-1", envelopeOrder: 5 },
    }),
  ];
}

async function seededStore(options: ConstructorParameters<typeof ThreadEventStore>[0] = {}): Promise<ThreadEventStore> {
  const store = new ThreadEventStore({ threadDbPath: tempThreadDbPath(), ...options });
  await store.createThread({ clientThreadId: "client-alpha", title: "Alpha" });
  return store;
}

describe("lhc thread-event store skeleton contracts", () => {
  it("stores wrapped causes on ThreadEventStoreError using the standard Error cause", () => {
    const cause = new Error("underlying failure");
    const error = new ThreadEventStoreError("Thread event SQLite operation failed.", cause);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ThreadEventStoreError");
    expect(error.cause).toBe(cause);
    expect(error.causeValue).toBe(cause);
  });

  it("creates threads explicitly and returns existing client threads without another source event", async () => {
    let idCounter = 0;
    const store = new ThreadEventStore({
      threadDbPath: tempThreadDbPath(),
      now: () => new Date("2026-05-30T12:01:00.000Z"),
      idGenerator: () => `generated-${++idCounter}`,
    });

    try {
      const created = await store.createThread({ clientThreadId: "client-alpha", title: "Alpha" });
      expect(created.created).toBe(true);
      expect(created.thread).toMatchObject({
        threadId: "generated-1",
        clientThreadId: "client-alpha",
        title: "Alpha",
        createdAt: "2026-05-30T12:01:00.000Z",
        updatedAt: "2026-05-30T12:01:00.000Z",
      });
      expect(created.event).toMatchObject({
        threadEventId: "generated-2",
        threadId: "generated-1",
        eventOrder: 1,
        eventKind: "thread_created",
        payload: { _tag: "thread_created", clientThreadId: "client-alpha", title: "Alpha" },
      });

      const existing = await store.createThread({ clientThreadId: "client-alpha", title: "Ignored retry title" });
      expect(existing).toEqual({ thread: created.thread, created: false });
      expect(await store.list()).toHaveLength(1);
      expect(await store.listThreads()).toEqual([created.thread]);
    } finally {
      store.close();
    }
  });

  it("creates anonymous threads by mirroring generated canonical id to clientThreadId", async () => {
    let idCounter = 0;
    const store = new ThreadEventStore({
      threadDbPath: tempThreadDbPath(),
      now: () => new Date("2026-05-30T12:01:00.000Z"),
      idGenerator: () => `generated-${++idCounter}`,
    });

    try {
      const created = await store.createThread({ clientThreadId: "generated-1" });
      expect(created.created).toBe(true);
      expect(created.thread).toMatchObject({ threadId: "generated-1", clientThreadId: "generated-1" });
      expect(created.event?.harness).toMatchObject({ runtime: "lhc" });
    } finally {
      store.close();
    }
  });

  it("reports missing client threads on append without inserting source events", async () => {
    const store = new ThreadEventStore({ threadDbPath: tempThreadDbPath() });
    try {
      await expect(store.appendMany("missing-thread", [appendInput()])).rejects.toThrow(/missing|not found/i);
      expect(await store.list()).toEqual([]);
      expect(await store.listThreads()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("appends batches sequentially and projects messages and blocks in the same source-event transaction", async () => {
    const store = await seededStore({
      now: () => new Date("2026-05-30T12:02:00.000Z"),
    });

    try {
      const appended = await store.appendMany("client-alpha", basicTurnEvents());

      expect(appended.events.map((event) => event.eventKind)).toEqual([
        "user_prompt",
        "assistant_text",
        "assistant_thinking",
        "tool_call",
        "tool_result",
      ]);
      expect(appended.messages).toEqual([
        expect.objectContaining({ messageOrder: 1, messageKind: "user", sourceEventOrder: 2 }),
        expect.objectContaining({ messageOrder: 2, messageKind: "assistant", sourceEventOrder: 3 }),
        expect.objectContaining({ messageOrder: 3, messageKind: "assistant", sourceEventOrder: 4 }),
        expect.objectContaining({ messageOrder: 4, messageKind: "assistant", sourceEventOrder: 5 }),
        expect.objectContaining({ messageOrder: 5, messageKind: "tool_result", sourceEventOrder: 6 }),
      ]);
      expect(appended.blocks).toEqual([
        expect.objectContaining({ blockKind: "text", payload: { text: "Can you inspect this repository?" } }),
        expect.objectContaining({ blockKind: "text", payload: { text: "I will inspect the repository." } }),
        expect.objectContaining({ blockKind: "thinking", payload: { thinkingKind: "reasoning", text: "Need to list files first." } }),
        expect.objectContaining({ blockKind: "tool_call", payload: { toolCallId: "call-1", toolName: "list_files", argumentsJson: { path: "." } } }),
        expect.objectContaining({ blockKind: "tool_result", payload: { toolCallId: "call-1", text: "package.json\npackages/" } }),
      ]);
    } finally {
      store.close();
    }
  });

  it("persists all appendMany successes in one batch", async () => {
    const store = await seededStore();
    try {
      await store.appendMany("client-alpha", basicTurnEvents());
      expect((await store.list()).map((event) => event.eventKind)).toEqual([
        "thread_created",
        "user_prompt",
        "assistant_text",
        "assistant_thinking",
        "tool_call",
        "tool_result",
      ]);
    } finally {
      store.close();
    }
  });

  it("returns existing events for duplicate idempotency keys without duplicating projections", async () => {
    const store = await seededStore();
    try {
      const first = await store.appendMany("client-alpha", basicTurnEvents());
      const duplicate = await store.appendMany("client-alpha", basicTurnEvents());
      expect(duplicate.events).toEqual(first.events);
      expect(await store.list()).toHaveLength(6);
      const read = await store.readThread("client-alpha");
      expect(read?.messages).toHaveLength(5);
    } finally {
      store.close();
    }
  });

  it("stops append batches on first failure while preserving earlier committed event transactions", async () => {
    const store = await seededStore();
    try {
      await expect(store.appendMany("client-alpha", [
        appendInput({ idempotencyKey: "ok-1", payload: { text: "First" } }),
        appendInput({ idempotencyKey: "bad-1", eventKind: "assistant_text", payload: {} }),
        appendInput({ idempotencyKey: "not-written", payload: { text: "Third" } }),
      ])).rejects.toThrow();
      expect((await store.list()).map((event) => event.idempotencyKey)).toEqual(["thread_created:client-alpha", "ok-1"]);
    } finally {
      store.close();
    }
  });

  it("rejects old junk-drawer and non-canonical thinking source events", async () => {
    const store = await seededStore();
    try {
      await expect(store.appendMany("client-alpha", [appendInput({
        idempotencyKey: "legacy-thinking",
        eventKind: "runtime_note",
        payload: { type: "thinking", text: "legacy junk drawer thinking" },
      })])).rejects.toThrow(/thinking|canonical|runtime_note/i);
    } finally {
      store.close();
    }
  });

  it("rejects append input that provides service-generated fields", async () => {
    const store = await seededStore();
    try {
      await expect(store.appendMany("client-alpha", [{
        ...appendInput(),
        threadEventId: "caller-must-not-set-this",
        eventOrder: 10,
        schemaVersion: "thread_event.v1",
      } as unknown as ThreadEventAppendInput])).rejects.toThrow(/generated|threadEventId|eventOrder|schemaVersion/i);
    } finally {
      store.close();
    }
  });

  it("rejects append envelope root fields that look service-generated", async () => {
    const store = await seededStore();
    try {
      await expect(store.appendMany({
        clientThreadId: "client-alpha",
        events: [appendInput({ idempotencyKey: "root-reject-1", payload: { text: "Should not persist" } })],
        threadId: "caller-must-not-set-this",
        eventOrder: 999,
        schemaVersion: "evil",
      } as unknown as Parameters<typeof store.appendMany>[0])).rejects.toThrow(/generated|threadId|eventOrder|schemaVersion/i);
      expect((await store.list()).map((event) => event.idempotencyKey)).toEqual(["thread_created:client-alpha"]);
    } finally {
      store.close();
    }
  });

  it("persists turn_end without message projection and atomically writes a deterministic trigger", async () => {
    const store = await seededStore();
    try {
      await store.appendMany("client-alpha", basicTurnEvents());
      const result = await store.appendMany("client-alpha", [turnEndInput()]);

      expect(result.events).toEqual([expect.objectContaining({ eventKind: "turn_end" })]);
      expect(result.messages).toEqual([]);
      expect(result.blocks).toEqual([]);
      expect(result.triggered).toBe(true);
      expect(result.trigger).toMatchObject({
        threadId: result.thread.threadId,
        turnEndEventOrder: 7,
        status: "pending",
      });
      expect(await store.listTurnProcessingTriggers()).toEqual([result.trigger]);
    } finally {
      store.close();
    }
  });

  it("skips events after first turn_end until the next user_prompt", async () => {
    const store = await seededStore();
    try {
      await store.appendMany("client-alpha", [
        appendInput({ idempotencyKey: "prompt-1", payload: { text: "First prompt" } }),
        turnEndInput({ idempotencyKey: "turn-end-1" }),
        appendInput({ idempotencyKey: "late-assistant", eventKind: "assistant_text", payload: { text: "Should be ignored" } }),
        appendInput({ idempotencyKey: "prompt-2", payload: { text: "Second prompt" } }),
      ]);

      expect((await store.list()).map((event) => event.idempotencyKey)).toEqual([
        "thread_created:client-alpha",
        "prompt-1",
        "turn-end-1",
        "prompt-2",
      ]);
    } finally {
      store.close();
    }
  });

  it("re-enters skip mode when a retried batch hits a duplicate winning turn_end", async () => {
    const store = await seededStore();
    try {
      const batch = [
        appendInput({ idempotencyKey: "prompt-1", payload: { text: "First prompt" } }),
        turnEndInput({ idempotencyKey: "turn-end-1" }),
        appendInput({ idempotencyKey: "late-assistant", eventKind: "assistant_text", payload: { text: "Should be ignored" } }),
      ];
      await store.appendMany("client-alpha", batch);
      await store.appendMany("client-alpha", batch);
      expect((await store.list()).map((event) => event.idempotencyKey)).toEqual([
        "thread_created:client-alpha",
        "prompt-1",
        "turn-end-1",
      ]);
    } finally {
      store.close();
    }
  });

  it("persists turn_end with no open span without creating a trigger", async () => {
    const store = await seededStore();
    try {
      const result = await store.appendMany("client-alpha", [turnEndInput()]);
      expect(result.triggered).toBe(false);
      expect(result.reason).toBe("no_open_turn_span");
      expect(result.messages).toEqual([]);
      expect(result.blocks).toEqual([]);
      expect(await store.listTurnProcessingTriggers()).toEqual([]);
      expect((await store.list()).map((event) => event.eventKind)).toEqual(["thread_created", "turn_end"]);
    } finally {
      store.close();
    }
  });

  it("rejects turn_end payloads with extra fields", async () => {
    const store = await seededStore();
    try {
      await expect(store.appendMany("client-alpha", [turnEndInput({ payload: { extra: "nope" } })])).rejects.toThrow(/turn_end|payload|extra/i);
    } finally {
      store.close();
    }
  });
});

describe("lhc turn worker and chunk skeleton contracts", () => {
  it("worker persists local tokenizer metadata by default and blocks chunking without projection count", async () => {
    const store = await seededStore({
      now: () => new Date("2026-05-30T12:10:00.000Z"),
    });
    try {
      await store.appendMany("client-alpha", [...basicTurnEvents(), turnEndInput()]);
      const result = await store.processNextTurnEndTrigger();
      expect(result.completed).toBe(true);
      expect(result.turn).toMatchObject({
        processingStatus: "failed",
        smooth: expect.objectContaining({ status: "ready" }),
        lowerBandProjection: expect.objectContaining({ status: "failed", errorCode: "LOWER_BAND_PROJECTION_TOKEN_COUNTER_MISSING" }),
      });
      expect(await store.readChunks("client-alpha")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("injected lower-band projection token counter metadata still wins", async () => {
    const store = await seededStore({
      lowerBandProjectionTokenCounter: {
        async countTurnLowerBandProjection() {
          return { count: 42, metadata: { source: "provider_input_count", trustClass: "exact" } };
        },
      },
    });
    try {
      await store.appendMany("client-alpha", [...basicTurnEvents(), turnEndInput()]);
      const result = await store.processNextTurnEndTrigger();
      expect(result.completed).toBe(true);
      expect(result.turn?.lowerBandProjection).toMatchObject({
        status: "ready",
        tokenCountMetadata: { count: 42, source: "provider_input_count", trustClass: "exact" },
      });
    } finally {
      store.close();
    }
  });

  it("local tokenizer counts are positive and deterministic", () => {
    expect(countLocalTokens("hello world")).toBeGreaterThan(0);
    expect(countLocalTokens("hello world")).toBe(countLocalTokens("hello world"));
    expect(localTokenizerMetadataFields()).toMatchObject({
      source: "local_tokenizer",
      trustClass: "tokenizer_count",
      encodingMethod: "tiktoken:o200k_base",
    });
  });

  it("does not claim another trigger for the same thread while one worker is running", async () => {
    const store = await seededStore({
      lowerBandProjectionTokenCounter: {
        async countTurnLowerBandProjection() {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return { count: 12, metadata: { source: "provider_input_count", trustClass: "exact" } };
        },
      },
    });
    try {
      await store.appendMany("client-alpha", [
        appendInput({ idempotencyKey: "prompt-1", payload: { text: "First" } }),
        turnEndInput({ idempotencyKey: "end-1" }),
        appendInput({ idempotencyKey: "prompt-2", payload: { text: "Second" } }),
        turnEndInput({ idempotencyKey: "end-2" }),
      ]);

      const first = store.processNextTurnEndTrigger();
      const second = await store.processNextTurnEndTrigger();
      expect(second).toMatchObject({ completed: false, reason: "no_pending_trigger" });
      expect(await first).toMatchObject({ completed: true });
    } finally {
      store.close();
    }
  });

  it("does not process a later same-thread trigger before earlier triggers are complete", async () => {
    const store = await seededStore();
    try {
      await store.appendMany("client-alpha", [
        appendInput({ idempotencyKey: "prompt-1", payload: { text: "First" } }),
        turnEndInput({ idempotencyKey: "end-1" }),
        appendInput({ idempotencyKey: "prompt-2", payload: { text: "Second" } }),
        turnEndInput({ idempotencyKey: "end-2" }),
      ]);
      const triggers = await store.listTurnProcessingTriggers();
      expect(triggers).toHaveLength(2);
      await expect(store.processTurnEndTrigger(triggers[1]?.triggerId ?? "missing")).resolves.toMatchObject({
        completed: false,
        reason: "turn_not_ready",
      });
    } finally {
      store.close();
    }
  });

  it("worker chunks an eligible current turn incrementally and is idempotent on rerun", async () => {
    const store = await seededStore({
      lowerBandProjectionTokenCounter: {
        async countTurnLowerBandProjection() {
          return { count: 80, metadata: { source: "provider_input_count", trustClass: "exact" } };
        },
      },
    });
    try {
      await store.appendMany("client-alpha", [...basicTurnEvents(), turnEndInput()]);
      const first = await store.processNextTurnEndTrigger();
      const retry = await store.processTurnEndTrigger(first.trigger?.triggerId ?? "missing");
      expect(first.completed).toBe(true);
      expect(retry).toMatchObject({ completed: false, reason: "no_pending_trigger" });
      expect(await store.readChunks("client-alpha")).toEqual([
        expect.objectContaining({ lifecycleStatus: "open", sourceTurnIds: [first.turn?.turnId] }),
      ]);
    } finally {
      store.close();
    }
  });

  it("worker writes ready detailed and brief artifacts inline when a chunk closes", async () => {
    const store = await seededStore({
      chunkPolicy: { targetMinSmoothTokens: 10, targetSoftMaxSmoothTokens: 20, hardMaxSmoothTokens: 30 },
      lowerBandProjectionTokenCounter: {
        async countTurnLowerBandProjection() {
          return { count: 25, metadata: { source: "provider_input_count", trustClass: "exact" } };
        },
      },
      chunkCompressionProvider: {
        async compressChunk({ band }) {
          return { text: `${band} compressed`, metadata: { source: "test-provider" } };
        },
      },
    });
    try {
      await store.appendMany("client-alpha", [...basicTurnEvents(), turnEndInput()]);
      await store.processNextTurnEndTrigger();
      expect(await store.readChunks("client-alpha")).toEqual([
        expect.objectContaining({
          lifecycleStatus: "closed",
          lowerBand: expect.objectContaining({
            detailed: expect.objectContaining({ status: "ready", text: "detailed compressed" }),
            brief: expect.objectContaining({ status: "ready", text: "brief compressed" }),
          }),
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it("retry fills missing artifacts on an already-closed chunk before completing the trigger", async () => {
    const store = await seededStore({
      chunkPolicy: { targetMinSmoothTokens: 10, targetSoftMaxSmoothTokens: 20, hardMaxSmoothTokens: 30 },
      lowerBandProjectionTokenCounter: {
        async countTurnLowerBandProjection() {
          return { count: 25, metadata: { source: "provider_input_count", trustClass: "exact" } };
        },
      },
      chunkCompressionProvider: {
        async compressChunk({ band }) {
          return { text: `${band} retry-compressed`, metadata: { source: "retry-provider" } };
        },
      },
    });
    try {
      await store.appendMany("client-alpha", [...basicTurnEvents(), turnEndInput()]);
      const result = await store.processNextTurnEndTrigger();
      expect(result.completed).toBe(true);
      expect(await store.readChunks("client-alpha")).toEqual([
        expect.objectContaining({
          lowerBand: expect.objectContaining({
            detailed: expect.objectContaining({ status: "ready" }),
            brief: expect.objectContaining({ status: "ready" }),
          }),
        }),
      ]);
    } finally {
      store.close();
    }
  });
});

describe("lhc read/replay and CLI skeleton contracts", () => {
  it("reads a projected thread domain object from the same source events", async () => {
    const store = await seededStore();
    try {
      await store.appendMany("client-alpha", basicTurnEvents());

      const read = await store.readThread("client-alpha");
      expect(read).toBeDefined();
      expect(read?.thread).toMatchObject({ clientThreadId: "client-alpha", title: "Alpha" });
      expect(read?.events.map((event) => event.eventKind)).toEqual([
        "thread_created",
        "user_prompt",
        "assistant_text",
        "assistant_thinking",
        "tool_call",
        "tool_result",
      ]);
      expect(read?.messages.map((message) => message.messageKind)).toEqual([
        "user",
        "assistant",
        "assistant",
        "assistant",
        "tool_result",
      ]);
      expect(read?.turns).toEqual([]);
      expect(read?.chunks).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("persists and replays a canonical basic-session fixture after reopening the store", async () => {
    const dbPath = tempThreadDbPath();
    const first = new ThreadEventStore({
      threadDbPath: dbPath,
      lowerBandProjectionTokenCounter: {
        async countTurnLowerBandProjection() {
          return { count: 64, metadata: { source: "provider_input_count", trustClass: "exact" } };
        },
      },
    });
    try {
      await first.createThread({ clientThreadId: "fixture-basic-session", title: "Fixture" });
      await first.appendMany("fixture-basic-session", [...basicTurnEvents(), turnEndInput()]);
      await first.processNextTurnEndTrigger();
    } finally {
      first.close();
    }

    const reopened = new ThreadEventStore({ threadDbPath: dbPath });
    try {
      const read = await reopened.readThread("fixture-basic-session");
      expect(read?.events.map((event) => event.eventKind)).toEqual([
        "thread_created",
        "user_prompt",
        "assistant_text",
        "assistant_thinking",
        "tool_call",
        "tool_result",
        "turn_end",
      ]);
      expect(read?.turns).toHaveLength(1);
      expect(read?.chunks).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it("wires the thread-events CLI to create, append, list, and read operations", async () => {
    const dbPath = tempThreadDbPath();
    const eventFile = path.join(path.dirname(dbPath), "events.json");
    writeFileSync(eventFile, JSON.stringify({ clientThreadId: "client-alpha", events: basicTurnEvents() }, null, 2));

    const created = await runCli(["thread-events", "create", "--event-db", dbPath, "--client-thread-id", "client-alpha", "--title", "Alpha"]);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ created: true, thread: { clientThreadId: "client-alpha", title: "Alpha" } });

    const appended = await runCli(["thread-events", "append", "--event-db", dbPath, "--file", eventFile]);
    expect(appended.exitCode).toBe(0);
    expect(JSON.parse(appended.stdout)).toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ eventKind: "user_prompt" })]) });

    const listed = await runCli(["thread-events", "list", "--event-db", dbPath, "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout).map((event: { eventKind: string }) => event.eventKind)).toEqual([
      "thread_created",
      "user_prompt",
      "assistant_text",
      "assistant_thinking",
      "tool_call",
      "tool_result",
    ]);

    const read = await runCli(["thread-events", "read", "--event-db", dbPath, "--client-thread-id", "client-alpha", "--json"]);
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({
      thread: { clientThreadId: "client-alpha" },
      messages: expect.arrayContaining([expect.objectContaining({ messageKind: "user" })]),
    });
  });

  it("returns a structured JSON append failure when the target thread is missing", async () => {
    const dbPath = tempThreadDbPath();
    const eventFile = path.join(path.dirname(dbPath), "event.json");
    writeFileSync(eventFile, JSON.stringify(appendInput(), null, 2));

    const result = await runCli(["thread-events", "append", "--event-db", dbPath, "--client-thread-id", "missing", "--file", eventFile]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/missing|not found/i);
  });

  it("rejects CLI append envelopes with service-generated root fields", async () => {
    const dbPath = tempThreadDbPath();
    const eventFile = path.join(path.dirname(dbPath), "bad-envelope.json");
    writeFileSync(eventFile, JSON.stringify({
      clientThreadId: "client-alpha",
      events: [appendInput({ idempotencyKey: "cli-root-reject-1", payload: { text: "Should not persist" } })],
      threadId: "caller-must-not-set-this",
      eventOrder: 999,
      schemaVersion: "evil",
    }, null, 2));

    await runCli(["thread-events", "create", "--event-db", dbPath, "--client-thread-id", "client-alpha", "--title", "Alpha"]);
    const result = await runCli(["thread-events", "append", "--event-db", dbPath, "--file", eventFile]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/generated|threadId|eventOrder|schemaVersion/i);

    const listed = await runCli(["thread-events", "list", "--event-db", dbPath, "--json"]);
    expect(JSON.parse(listed.stdout).map((event: { idempotencyKey: string }) => event.idempotencyKey)).toEqual(["thread_created:client-alpha"]);
  });
});
