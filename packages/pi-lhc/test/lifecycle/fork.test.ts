// Story 4 — fork as new thread. Tests fork detection, new thread creation,
// replay seeding, source immutability, and derived form requeue behavior.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDeterministicInferenceCallbacks, inspect, intakeStream } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnector } from "../../src/index.js";
import { eventsAfterShutdown, kindsOf, startCapture } from "../capture/support.js";
import {
  makeAgentEnd,
  makeAssistantMessage,
  makeMessageEnd,
  makeToolResult,
  makeUserMessage,
} from "../fixtures/synthetic.js";
import { type TempStore, tempStore } from "../fixtures/thread.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

function appendPiMessage(ctx: { sessionManager: { getEntries(): unknown[] } }, id: string, message: unknown): void {
  ctx.sessionManager.getEntries().push({ type: "message", id, parentId: null, message });
}

describe("Story 4: fork as new thread", () => {
  it("finds the fork cutoff from current PI persisted entry identity, not idempotency string search", async () => {
    const started = await startCapture(store, "/work/fork-current-pi");
    const { connector, ctx } = started;
    const forkEntryId = "pi-current-fork-entry";
    const user = makeUserMessage("current PI source prompt");
    const assistant = makeAssistantMessage({ text: "current PI source response" });

    await connector.handlers.message_end(ctx, { type: "message_end", message: user });
    appendPiMessage(ctx, forkEntryId, user);
    await connector.handlers.message_end(ctx, { type: "message_end", message: assistant });
    appendPiMessage(ctx, "pi-current-assistant-entry", assistant);
    await connector.handlers.agent_end(ctx, makeAgentEnd([]));

    await connector.handlers.session_before_fork(ctx, {
      type: "session_before_fork",
      entryId: forkEntryId,
      position: "at",
    });
    await connector.handlers.session_start(ctx, { type: "session_start", reason: "fork" });

    const state = connector.getState();
    expect(state).not.toBeNull();
    if (state === null) return;

    const forkedEvents = await intakeStream.listEvents(state.threadRef);
    expect(forkedEvents.ok).toBe(true);
    if (forkedEvents.ok) {
      expect(kindsOf(forkedEvents.value)).toEqual(["user_prompt", "assistant_text", "turn_end"]);
      expect(forkedEvents.value[0]!.idempotencyKey).toContain(encodeURIComponent(forkEntryId));
    }

    await connector.handlers.session_shutdown(ctx, { reason: "quit" });
  });

  it("TC-3.1 (risk: source-vs-derived): fork creates a new thread; source receives no writes", async () => {
    const started = await startCapture(store, "/work/fork-source");
    const { connector, ctx, threadRef: sourceRef } = started;

    // Capture some events in the source thread with deterministic entryIds.
    const forkEntryId = "entry-fork-point";
    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("source prompt"), forkEntryId));
    await connector.handlers.message_end(
      ctx,
      makeMessageEnd(
        makeAssistantMessage({
          text: "source response",
          toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "file.txt" } }],
        }),
        forkEntryId,
      ),
    );
    await connector.handlers.message_end(
      ctx,
      makeMessageEnd(makeToolResult({ id: "call-1", content: "file content" })),
    );
    await connector.handlers.agent_end(ctx, makeAgentEnd([]));

    // Record the source thread's event count for comparison.
    const sourceEventsBefore = await eventsAfterShutdown(started);

    // Simulate a fork: fire session_before_fork with the fork entryId.
    await connector.handlers.session_before_fork(ctx, { entryId: forkEntryId, position: "at" });

    // print-mode --fork can report reason=startup; detection comes from the hook data.
    await connector.handlers.session_start(ctx, { reason: "startup" });

    // The connector state should now point to a NEW thread (different from source).
    const state = connector.getState();
    expect(state).not.toBeNull();
    if (state === null) return;

    // The forked thread is a different file from the source.
    const sourceId = (sourceRef as { threadId: string }).threadId;
    const forkedId = (state.threadRef as { threadId: string }).threadId;
    expect(forkedId).not.toBe(sourceId);

    // The source thread should have NO new writes — its logical read-back is unchanged.
    const sourceEventsAfter = await intakeStream.listEvents(sourceRef);
    expect(sourceEventsAfter.ok).toBe(true);
    if (sourceEventsAfter.ok) {
      expect(sourceEventsAfter.value.length).toBe(sourceEventsBefore.length);
      // Event kinds and order should be identical.
      expect(kindsOf(sourceEventsAfter.value)).toEqual(kindsOf(sourceEventsBefore));
    }

    // Shut down the forked session.
    await connector.handlers.session_shutdown(ctx, { reason: "quit" });
  });

  it("TC-3.1 fallback: detects fork from PI session tree parentId chain when hook is absent", async () => {
    const started = await startCapture(store, "/work/fork-tree-fallback");
    const { connector, ctx, threadRef: sourceRef } = started;

    const forkEntryId = "pi-entry-source-user";
    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("tree fallback prompt"), forkEntryId));
    await connector.handlers.message_end(
      ctx,
      makeMessageEnd(makeAssistantMessage({ text: "tree fallback response" }), forkEntryId),
    );
    await connector.handlers.agent_end(ctx, makeAgentEnd([]));

    const previousSessionFile = join(store.dir, "source-session.jsonl");
    writeFileSync(
      previousSessionFile,
      [
        JSON.stringify({ type: "session", version: 3 }),
        JSON.stringify({ type: "message", id: forkEntryId, parentId: "root" }),
      ].join("\n"),
    );

    ctx.sessionManager = {
      getEntries: () => [
        { type: "message", id: forkEntryId, parentId: "root" },
        { type: "message", id: "pi-entry-child", parentId: forkEntryId },
      ],
    };

    await connector.handlers.session_start(ctx, { reason: "startup", previousSessionFile });

    const state = connector.getState();
    expect(state).not.toBeNull();
    if (state === null) return;
    expect((state.threadRef as { threadId?: string }).threadId).not.toBe((sourceRef as { threadId?: string }).threadId);

    const forkedEvents = await intakeStream.listEvents(state.threadRef);
    expect(forkedEvents.ok).toBe(true);
    if (forkedEvents.ok) {
      expect(kindsOf(forkedEvents.value)).toEqual(["user_prompt", "assistant_text", "turn_end"]);
    }

    await connector.handlers.session_shutdown(ctx, { reason: "quit" });
  });

  it("TC-3.2: fork seeded by replay; read-back matches source through fork point", async () => {
    const started = await startCapture(store, "/work/fork-replay");
    const { connector, ctx, threadRef: sourceRef } = started;

    // Capture events in the source thread. Use deterministic entryIds for testing.
    const sourceEntryId = "entry-fork-point";
    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("prompt before fork"), sourceEntryId, 1));
    await connector.handlers.message_end(
      ctx,
      makeMessageEnd(makeAssistantMessage({ text: "response before fork" }), sourceEntryId, 2),
    );
    await connector.handlers.agent_end(ctx, makeAgentEnd([]));

    // Record the source thread's events as the expected fork seed.
    const sourceEvents = await intakeStream.listEvents(sourceRef);
    expect(sourceEvents.ok).toBe(true);
    if (!sourceEvents.ok) return;
    const expectedSeed = kindsOf(sourceEvents.value);

    // Simulate fork at the current position.
    await connector.handlers.session_before_fork(ctx, { entryId: sourceEntryId, position: "at" });

    // Start the forked session.
    await connector.handlers.session_start(ctx, { reason: "fork" });

    // The forked thread should be seeded with the source events up to the fork point.
    const state = connector.getState();
    expect(state).not.toBeNull();
    if (state === null) return;

    const forkedEvents = await intakeStream.listEvents(state.threadRef);
    expect(forkedEvents.ok).toBe(true);
    if (forkedEvents.ok) {
      // The forked thread should have the same events as the source through the fork point.
      // The replay mechanism copies events with the matching entryId in their key.
      expect(forkedEvents.value.length).toBeGreaterThan(0);
      // The forked events should match the source events through the fork point.
      const forkedKinds = kindsOf(forkedEvents.value);
      expect(forkedKinds).toEqual(expectedSeed);
    }

    await connector.handlers.session_shutdown(ctx, { reason: "quit" });
  });

  it("TC-3.3: forms requeue on fork (v1: no copy)", async () => {
    // This test verifies that derived forms are NOT copied from source to fork.
    // In v1, forms always requeue on the fork target.
    // The test requires the deterministic provider to have queued derivations.

    let sdkMode: "background" | "manual" = "background";

    // Start a source session with deterministic provider (so derivations run).
    const connector = createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      parseLaunch: () => ({}),
      startupValidationReporter: () => {},
      buildSdkConfig: () => ({
        ok: true,
        value: { inferenceCallbacks: createDeterministicInferenceCallbacks(), mode: sdkMode },
      }),
    });

    const ctx = {
      cwd: "/work/fork-forms",
      hasUI: false,
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
      ui: { notify: () => {} },
      sessionManager: {
        // Provide session entries with entryId for fallback fork detection.
        getEntries: () => [{ type: "message_end", entryId: "source-entry-1", position: "at" }],
      },
    };

    await connector.handlers.session_start(ctx, { reason: "new" });
    const sourceState = connector.getState();
    expect(sourceState).not.toBeNull();
    if (sourceState === null) return;

    // Capture a prompt with matching entryId (for fork seeding) which queues
    // prompt_smoothing derivation.
    const forkEntryId = "source-entry-1";
    await connector.handlers.message_end(ctx, makeMessageEnd(makeUserMessage("queue some derivation"), forkEntryId));
    await connector.handlers.agent_end(ctx, makeAgentEnd([]));

    // Drain to let derivations settle.
    const sourceInstance = connector.getInstance();
    if (sourceInstance) await sourceInstance.dispose();

    // Check source has ready derivations.
    const sourceHealth = await inspect.health(sourceState.threadRef);
    expect(sourceHealth.ok).toBe(true);
    if (sourceHealth.ok) {
      // At least one derivation should be ready (smoothed_prompt).
      expect(sourceHealth.value.owners).toContainEqual({
        owner: "messages",
        kind: "smoothed_prompt",
        counts: { ready: 1, pending: 0, retrying: 0, failed: 0, blocked: 0 },
      });
    }

    // Fork the session using the same entryId used for capture.
    sdkMode = "manual";
    await connector.handlers.session_before_fork(ctx, { entryId: forkEntryId });
    await connector.handlers.session_start(ctx, { reason: "fork" });

    const forkState = connector.getState();
    expect(forkState).not.toBeNull();
    if (forkState === null) return;

    // Check forked thread's health before draining: forms requeue on the target
    // as pending work instead of copying the source's ready rows.
    const forkHealth = await inspect.health(forkState.threadRef);
    expect(forkHealth.ok).toBe(true);
    if (forkHealth.ok) {
      expect(forkHealth.value.owners).toContainEqual({
        owner: "messages",
        kind: "smoothed_prompt",
        counts: { ready: 0, pending: 1, retrying: 0, failed: 0, blocked: 0 },
      });
      expect(forkHealth.value.queue.queued).toBeGreaterThan(0);
    }

    const forkInstance = connector.getInstance();
    if (forkInstance) await forkInstance.dispose();

    await connector.handlers.session_shutdown(ctx, { reason: "quit" });

    // Final verification: source and forked threads have different forms.
    // The forked thread's forms were derived fresh, not copied.
    const sourceHealthFinal = await inspect.health(sourceState.threadRef);
    const forkHealthFinal = await inspect.health(forkState.threadRef);
    expect(sourceHealthFinal.ok).toBe(true);
    expect(forkHealthFinal.ok).toBe(true);
    if (sourceHealthFinal.ok && forkHealthFinal.ok) {
      // Both threads have ready derivations, but they are independent copies.
      const sourceReady = sourceHealthFinal.value.owners
        .filter((o) => o.owner === "messages")
        .reduce((sum, o) => sum + o.counts.ready, 0);
      const forkReady = forkHealthFinal.value.owners
        .filter((o) => o.owner === "messages")
        .reduce((sum, o) => sum + o.counts.ready, 0);

      // Both have derivations - proving forms requeue and derive on fork target.
      expect(sourceReady).toBeGreaterThan(0);
      expect(forkReady).toBeGreaterThan(0);
    }
  });
});
