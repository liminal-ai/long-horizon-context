// TC-4.5: closed-loop proof through the PI connector hooks.

import type { ModelAssignment, ModelCall, ModelCallResult, SdkConfig, ThreadRef } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Connector, createConnector } from "../../src/index.js";
import { type AssignmentKind, defaultAssignments } from "../../src/inference/model-call.js";
import type { ExtensionContext, SessionEntry } from "../../src/pi/types.js";
import { fakeModelCallFailure, fakeModelCallRouter, fakeModelCallText } from "../fixtures/model-call.js";
import { makeAssistantMessage, makeUserMessage } from "../fixtures/synthetic.js";
import { type TempStore, tempStore } from "../fixtures/thread.js";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function assignments(
  overrides: Partial<Record<AssignmentKind, Partial<ModelAssignment>>> = {},
): Record<AssignmentKind, ModelAssignment> {
  const base = defaultAssignments({ provider: "openai", id: "good" });
  return {
    smoothed_prompt: { ...base.smoothed_prompt, ...(overrides.smoothed_prompt ?? {}) },
    smooth_turn_compression: { ...base.smooth_turn_compression, ...(overrides.smooth_turn_compression ?? {}) },
    tool_result_summary: { ...base.tool_result_summary, ...(overrides.tool_result_summary ?? {}) },
    chunk_summary_brief: { ...base.chunk_summary_brief, ...(overrides.chunk_summary_brief ?? {}) },
  };
}

async function captureClosedTurn(
  connector: Connector,
  ctx: ExtensionContext,
  entries: SessionEntry[],
  userText: string,
  assistantText: string,
): Promise<void> {
  const user = makeUserMessage(userText);
  const assistant = makeAssistantMessage({ text: assistantText });
  await connector.handlers.message_end(
    {
      type: "message_end",
      message: user,
    },
    ctx,
  );
  entries.push({ type: "message", id: `${userText}-user`, parentId: null, message: user });
  await connector.handlers.message_end(
    {
      type: "message_end",
      message: assistant,
    },
    ctx,
  );
  entries.push({ type: "message", id: `${userText}-assistant`, parentId: `${userText}-user`, message: assistant });
  await connector.handlers.agent_end(
    {
      type: "agent_end",
      messages: [user, assistant],
    },
    ctx,
  );
}

describe("Story 5: Inference Host Routing — Closed Loop (TC-4.5)", () => {
  let store: TempStore;
  let connector: Connector;
  let ctx: ExtensionContext;
  let entries: SessionEntry[];
  let threadRef: ThreadRef | null;

  beforeEach(() => {
    store = tempStore();
    threadRef = null;
    entries = [];
    ctx = {
      cwd: "/test/closed-loop",
      hasUI: false,
      modelRegistry: {
        find: (provider: string, model: string) => (provider === "openai" ? { provider, id: model } : undefined),
        hasConfiguredAuth: () => true,
        getAvailable: () => [{ provider: "openai", id: "good" }],
      },
      ui: { notify: () => {} },
      sessionManager: { getEntries: () => entries },
    };
  });

  afterEach(async () => {
    if (threadRef !== null) {
      await connector.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
    }
    store.cleanup();
  });

  it("persists ready derivations with compression fallback queryable through inspect/health", async () => {
    const modelCall = fakeModelCallRouter({
      "openai/good": fakeModelCallText("ready derived text"),
      "openai/fail": fakeModelCallFailure("auth", "missing auth"),
    });
    const sdkConfig: SdkConfig = {
      inference: {
        call: modelCall,
        assignments: assignments({ smooth_turn_compression: { model: "fail" } }),
      },
      mode: "background",
      retry: { budget: 1, backoffBaseMs: 0, backoffCapMs: 0 },
      guards: { smoothTurnCompression: { tinyTurnTokens: 1 } },
    };

    connector = createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      buildSdkConfig: () => ({ ok: true, value: sdkConfig }),
      startupValidationReporter: () => {},
    });
    await connector.handlers.session_start({ type: "session_start", reason: "new" }, ctx);
    const instance = connector.getInstance();
    const state = connector.getState();
    expect(instance).not.toBeNull();
    expect(state).not.toBeNull();
    if (instance === null || state === null) return;
    threadRef = state.threadRef;

    await captureClosedTurn(connector, ctx, entries, "please summarize this file", "here is the summary");
    await instance.sdk.drainSettled(threadRef);

    const health = await instance.sdk.inspect.health(threadRef);
    expect(health.ok).toBe(true);
    if (!health.ok) return;
    expect(health.value.owners.some((o) => o.counts.ready > 0)).toBe(true);
    expect(health.value.owners).toContainEqual(
      expect.objectContaining({
        owner: "turns",
        kind: "smooth_turn_compression",
        counts: expect.objectContaining({ ready: 1, failed: 0 }),
      }),
    );
    expect(health.value.failures.some((f) => f.derivationType === "smooth_turn_compression")).toBe(false);

    const turnList = await instance.sdk.turns.listTurns(threadRef);
    expect(turnList.ok).toBe(true);
    if (!turnList.ok) return;
    const compression = turnList.value[0]?.derivations?.find(
      (form) => form.derivationType === "smooth_turn_compression",
    );
    const rendering = turnList.value[0]?.derivations?.find((form) => form.derivationType === "turn_rendering");
    expect(rendering).toMatchObject({ state: "ready" });
    expect(compression).toMatchObject({
      state: "ready",
      content: rendering?.content,
      metadata: expect.objectContaining({
        fallbackFloor: "turn_rendering",
        lastError: expect.stringContaining("auth"),
      }),
    });

    const overview = await instance.sdk.inspect.overview(threadRef);
    expect(overview.ok).toBe(true);
    if (overview.ok) {
      expect(overview.value.derivation.ready).toBeGreaterThan(0);
      expect(overview.value.derivation.failed).toBe(0);
    }
  }, 30000);

  it("forces a stale background result and preserves the newer edited form", async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<ModelCallResult>();
    let smoothedCalls = 0;
    const modelCall: ModelCall = async (input) => {
      if (input.model === "slow-smoothed") {
        smoothedCalls += 1;
        if (smoothedCalls === 1) {
          firstStarted.resolve();
          return releaseFirst.promise;
        }
        return { ok: true, text: `fresh:${input.messages.map((m) => m.content).join("\n")}` };
      }
      return { ok: true, text: "ready" };
    };
    const sdkConfig: SdkConfig = {
      inference: {
        call: modelCall,
        assignments: assignments({ smoothed_prompt: { model: "slow-smoothed" } }),
      },
      mode: "background",
      retry: { budget: 1, backoffBaseMs: 0, backoffCapMs: 0 },
    };

    connector = createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      buildSdkConfig: () => ({ ok: true, value: sdkConfig }),
      startupValidationReporter: () => {},
    });
    await connector.handlers.session_start({ type: "session_start", reason: "new" }, ctx);
    const instance = connector.getInstance();
    const state = connector.getState();
    expect(instance).not.toBeNull();
    expect(state).not.toBeNull();
    if (instance === null || state === null) return;
    threadRef = state.threadRef;

    const user = makeUserMessage("first prompt");
    const assistant = makeAssistantMessage({ text: "first response" });
    await connector.handlers.message_end(
      {
        type: "message_end",
        message: user,
      },
      ctx,
    );
    entries.push({ type: "message", id: "stale-user", parentId: null, message: user });
    await connector.handlers.message_end(
      {
        type: "message_end",
        message: assistant,
      },
      ctx,
    );
    await firstStarted.promise;
    entries.push({ type: "message", id: "stale-assistant", parentId: "stale-user", message: assistant });
    await connector.handlers.agent_end(
      {
        type: "agent_end",
        messages: [user, assistant],
      },
      ctx,
    );

    const beforeEdit = await instance.sdk.messages.list(threadRef);
    expect(beforeEdit.ok).toBe(true);
    if (!beforeEdit.ok) return;
    const userMessage = beforeEdit.value.find((message) => message.kind === "user_prompt");
    expect(userMessage?.messageId).toBe("m1");

    const editedText = "edited prompt wins";
    const edit = await instance.sdk.messages.edit(threadRef, {
      messageId: "m1",
      content: editedText,
    });
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    expect(edit.value.queued.some((item) => item.workItemId === "w-m1-prompt_smoothing-v2")).toBe(true);

    releaseFirst.resolve({ ok: true, text: "STALE SHOULD NOT LAND" });
    await instance.sdk.drainSettled(threadRef);

    const afterEdit = await instance.sdk.messages.show(threadRef, "m1");
    expect(afterEdit.ok).toBe(true);
    if (!afterEdit.ok) return;
    expect(afterEdit.value.blocks[0]?.content["text"]).toBe(editedText);
    const smoothed = afterEdit.value.derivations.find((form) => form.derivationType === "smoothed_prompt");
    expect(smoothed).toEqual(
      expect.objectContaining({
        state: "ready",
        sourceVersion: 2,
        content: expect.stringContaining(editedText),
      }),
    );
    expect(smoothed?.content).not.toContain("STALE SHOULD NOT LAND");
    expect(smoothedCalls).toBeGreaterThanOrEqual(2);
  }, 30000);
});
