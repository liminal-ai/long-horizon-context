import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("lhc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lhc")>();
  return {
    ...actual,
    estimateTokens: (text: string) => {
      if (text === "__above_threshold__") return 150_000;
      return actual.estimateTokens(text);
    },
  };
});

import type { LlmRequestContext, PreviewCompactOutcome } from "lhc";
import * as captureModule from "../../src/capture/converter.js";
import {
  COMPACT_HOOKS,
  CONNECTOR_HOOKS,
  type CompactDiagnostic,
  createConnector,
  handleSessionBeforeCompact,
} from "../../src/index.js";
import { createSessionState } from "../../src/lifecycle/state.js";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "../../src/pi/types.js";
import { startCapture, syntheticCtx } from "../capture/support.js";
import { makeAgentEnd, makeMessageEnd, makeSessionStart, makeUserMessage } from "../fixtures/synthetic.js";
import { type TempStore, tempStore } from "../fixtures/thread.js";
import { makeBeforeCompactEvent, makeBranchEntries, makeCompactReceipt } from "./fixtures.js";

function aboveThresholdContext(): LlmRequestContext {
  return {
    threadId: "th_test",
    messages: [{ role: "user", content: [{ type: "text", text: "__above_threshold__" }] }],
  };
}

function belowThresholdContext(): LlmRequestContext {
  return {
    threadId: "th_test",
    messages: [{ role: "user", content: [{ type: "text", text: "still open" }] }],
  };
}

function okPreview(firstKeptMessageId = "m14"): PreviewCompactOutcome {
  return {
    kind: "ok",
    preview: {
      compactPoint: 28,
      wouldProduceBands: true,
      tailTokens: 1000,
      firstKeptMessageId,
    },
  };
}

function mockInstance(
  overrides: {
    preview?: PreviewCompactOutcome;
    previewOk?: boolean;
    compactOk?: boolean;
    compactError?: string;
    compactReceipt?: ReturnType<typeof makeCompactReceipt>;
    sessionViewOk?: boolean;
    servingContext?: LlmRequestContext;
    servingContextOk?: boolean;
  } = {},
) {
  const compactSpy = vi.fn(async (_ref: unknown, _opts?: { signal?: { aborted: boolean } }) => {
    if (overrides.compactOk === false) {
      return {
        ok: false as const,
        error: {
          code: "storage_failure",
          reason: overrides.compactError ?? "fail",
          errorClass: "system_error" as const,
        },
      };
    }
    return { ok: true as const, value: overrides.compactReceipt ?? makeCompactReceipt() };
  });
  const previewSpy = vi.fn(async (_ref: unknown, _opts?: { signal?: { aborted: boolean } }) => {
    if (overrides.previewOk === false) {
      return {
        ok: false as const,
        error: { code: "storage_failure", reason: "preview fail", errorClass: "system_error" as const },
      };
    }
    return { ok: true as const, value: overrides.preview ?? okPreview() };
  });
  const getSessionThreadView = vi.fn(async (_ref?: unknown) => {
    if (overrides.sessionViewOk === false) {
      return {
        ok: false as const,
        error: { code: "storage_failure", reason: "view fail", errorClass: "system_error" as const },
      };
    }
    return {
      ok: true as const,
      value: {
        threadId: "th_test",
        entries: [
          {
            role: "user" as const,
            content: "kept",
            sourceMessages: [
              {
                messageId: "m14",
                idempotencyKey: `pi:th_test:entry:entry_3:block:0:kind:user_prompt`,
              },
            ],
          },
        ],
      },
    };
  });
  const getLlmRequestContext = vi.fn(async (_ref?: unknown) => {
    if (overrides.servingContextOk === false) {
      return {
        ok: false as const,
        error: { code: "storage_failure", reason: "context fail", errorClass: "system_error" as const },
      };
    }
    return {
      ok: true as const,
      value: overrides.servingContext ?? aboveThresholdContext(),
    };
  });

  return {
    instance: {
      sdk: {
        threadView: {
          previewCompact: previewSpy,
          compact: compactSpy,
          getSessionThreadView,
          getLlmRequestContext,
        },
      },
    },
    compactSpy,
    previewSpy,
    flushSpy: vi.fn(async () => {}),
    sessionView: getSessionThreadView,
    servingContext: getLlmRequestContext,
  };
}

describe("handleSessionBeforeCompact", () => {
  let ctx: ExtensionContext;
  let diagnostics: CompactDiagnostic[];

  beforeEach(() => {
    ctx = syntheticCtx();
    diagnostics = [];
  });

  it("returns compaction for manual reason with LHC band summary", async () => {
    const mocks = mockInstance();
    const result = await handleSessionBeforeCompact(makeBeforeCompactEvent({ reason: "manual" }), ctx, {
      state: createSessionState({ threadId: "th_test" }),
      instance: mocks.instance as never,
      piSessionId: "th_test",
      flushPendingCapture: mocks.flushSpy,
      getSessionView: async () => mocks.sessionView() as never,
      findSeedEntryMap: () => null,
      recordCancel: (d) => {
        diagnostics.push(d);
      },
    });

    expect(result.cancel).toBeUndefined();
    expect(result.compaction?.summary).toContain("[context · brief]");
    expect(mocks.compactSpy).toHaveBeenCalledOnce();
    expect(mocks.previewSpy).toHaveBeenCalledOnce();
  });

  it("runs the same path for threshold and overflow reasons", async () => {
    for (const reason of ["threshold", "overflow"] as const) {
      const mocks = mockInstance();
      const result = await handleSessionBeforeCompact(
        makeBeforeCompactEvent({ reason, willRetry: reason === "overflow" }),
        ctx,
        {
          state: createSessionState({ threadId: "th_test" }),
          instance: mocks.instance as never,
          piSessionId: "th_test",
          flushPendingCapture: mocks.flushSpy,
          getSessionView: async () => mocks.sessionView() as never,
          findSeedEntryMap: () => null,
        },
      );
      expect(result.compaction).toBeDefined();
      expect(mocks.compactSpy).toHaveBeenCalledOnce();
    }
  });

  it("cancels capture_incomplete after flush before preview when capture failed", async () => {
    const mocks = mockInstance();
    const state = createSessionState({ threadId: "th_test" });
    state.health.lastCaptureFailure = { code: "invalid_event", message: "agent_end failed", recordedGap: true };
    const result = await handleSessionBeforeCompact(makeBeforeCompactEvent(), ctx, {
      state,
      instance: mocks.instance as never,
      piSessionId: "th_test",
      flushPendingCapture: mocks.flushSpy,
      getSessionView: async () => mocks.sessionView() as never,
      findSeedEntryMap: () => null,
      recordCancel: (d) => {
        diagnostics.push(d);
      },
    });
    expect(diagnostics[0]?.code).toBe("capture_incomplete");
    expect(result).toEqual({ cancel: true });
    expect(mocks.previewSpy).not.toHaveBeenCalled();
    expect(mocks.compactSpy).not.toHaveBeenCalled();
  });

  it("proceeds when preview returns ok for normal compactable state", async () => {
    const mocks = mockInstance({ preview: okPreview() });
    const previewSpy = vi.fn(async () => ({ ok: true as const, value: okPreview() }));
    mocks.instance.sdk.threadView.previewCompact = previewSpy;
    const result = await handleSessionBeforeCompact(makeBeforeCompactEvent(), ctx, {
      state: createSessionState({ threadId: "th_test" }),
      instance: mocks.instance as never,
      piSessionId: "th_test",
      flushPendingCapture: mocks.flushSpy,
      getSessionView: async () => mocks.sessionView() as never,
      findSeedEntryMap: () => null,
    });
    expect(result.compaction).toBeDefined();
  });

  it("passes per-model compactParams through to preview and compact", async () => {
    const mocks = mockInstance();
    const params = { lowerBound: 140_000, percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 } };
    const result = await handleSessionBeforeCompact(makeBeforeCompactEvent(), ctx, {
      state: createSessionState({ threadId: "th_test" }),
      instance: mocks.instance as never,
      piSessionId: "th_test",
      flushPendingCapture: mocks.flushSpy,
      getSessionView: async () => mocks.sessionView() as never,
      findSeedEntryMap: () => null,
      compactParams: params,
    });
    expect(result.compaction).toBeDefined();
    expect(mocks.previewSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ params }));
    expect(mocks.compactSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ params }));
  });

  it("cancels no_op below compact threshold without calling preview", async () => {
    const mocks = mockInstance({ servingContext: belowThresholdContext() });
    const result = await handleSessionBeforeCompact(makeBeforeCompactEvent(), ctx, {
      state: createSessionState({ threadId: "th_test" }),
      instance: mocks.instance as never,
      piSessionId: "th_test",
      flushPendingCapture: mocks.flushSpy,
      getSessionView: async () => mocks.sessionView() as never,
      findSeedEntryMap: () => null,
      recordCancel: (d) => {
        diagnostics.push(d);
      },
    });
    expect(result).toEqual({ cancel: true });
    expect(diagnostics[0]?.code).toBe("no_op");
    expect(diagnostics[0]?.reason).toMatch(/below the ~50k compact floor/);
    expect(mocks.previewSpy).not.toHaveBeenCalled();
    expect(mocks.compactSpy).not.toHaveBeenCalled();
  });

  for (const reason of ["threshold", "overflow"] as const) {
    it(`${reason} compact skips the floor — forced-by-context-pressure compacts must never wedge on it`, async () => {
      const mocks = mockInstance({ servingContext: belowThresholdContext() });
      const result = await handleSessionBeforeCompact(makeBeforeCompactEvent({ reason }), ctx, {
        state: createSessionState({ threadId: "th_test" }),
        instance: mocks.instance as never,
        piSessionId: "th_test",
        flushPendingCapture: mocks.flushSpy,
        getSessionView: async () => mocks.sessionView() as never,
        findSeedEntryMap: () => null,
        recordCancel: (d) => {
          diagnostics.push(d);
        },
      });
      expect(diagnostics.some((d) => d.code === "no_op")).toBe(false);
      expect(mocks.previewSpy).toHaveBeenCalled();
      expect(result.compaction).toBeDefined();
    });
  }

  it("proceeds past an unchanged-view preview — explicit compact is never second-guessed", async () => {
    const mocks = mockInstance({
      preview: {
        kind: "ok",
        preview: { compactPoint: 0, wouldProduceBands: false, tailTokens: 10, firstKeptMessageId: null },
      },
    });
    const result = await handleSessionBeforeCompact(makeBeforeCompactEvent(), ctx, {
      state: createSessionState({ threadId: "th_test" }),
      instance: mocks.instance as never,
      piSessionId: "th_test",
      flushPendingCapture: mocks.flushSpy,
      getSessionView: async () => mocks.sessionView() as never,
      findSeedEntryMap: () => null,
      recordCancel: (d) => {
        diagnostics.push(d);
      },
    });
    // wouldProduceBands=false must NOT cancel. compactPoint 0 + null firstKept
    // is a thread with no mappable messages at all — still a real mapping
    // failure, not the post-eviction summary-only splice.
    expect(result).toEqual({ cancel: true });
    expect(diagnostics[0]?.code).toBe("mapping_failed");
    expect(diagnostics.some((d) => d.code === "no_op")).toBe(false);
  });

  it("summary-only splice: empty mappable tail after eviction still writes bands", async () => {
    const mocks = mockInstance({
      preview: {
        kind: "ok",
        preview: { compactPoint: 6, wouldProduceBands: true, tailTokens: 0, firstKeptMessageId: null },
      },
      compactReceipt: makeCompactReceipt({ compactPoint: 6, tailTokens: 0, firstKeptMessageId: null }),
    });
    const result = await handleSessionBeforeCompact(makeBeforeCompactEvent(), ctx, {
      state: createSessionState({ threadId: "th_test" }),
      instance: mocks.instance as never,
      piSessionId: "th_test",
      flushPendingCapture: mocks.flushSpy,
      getSessionView: async () => mocks.sessionView() as never,
      findSeedEntryMap: () => null,
      recordCancel: (d) => {
        diagnostics.push(d);
      },
    });
    expect(result.cancel).toBeUndefined();
    expect(result.compaction?.firstKeptEntryId).toBe("pi-lhc:summary-only");
    expect(result.compaction?.summary).toContain("[context · brief]");
    expect(mocks.compactSpy).toHaveBeenCalledOnce();
    expect(diagnostics).toEqual([]);
  });

  it("uses the installed receipt when preview was empty but compact kept a firstKept", async () => {
    const mocks = mockInstance({
      preview: {
        kind: "ok",
        preview: { compactPoint: 6, wouldProduceBands: true, tailTokens: 0, firstKeptMessageId: null },
      },
      compactReceipt: makeCompactReceipt({ compactPoint: 6, firstKeptMessageId: "m14" }),
    });
    const result = await handleSessionBeforeCompact(makeBeforeCompactEvent(), ctx, {
      state: createSessionState({ threadId: "th_test" }),
      instance: mocks.instance as never,
      piSessionId: "th_test",
      flushPendingCapture: mocks.flushSpy,
      getSessionView: async () => mocks.sessionView() as never,
      findSeedEntryMap: () => null,
      recordCancel: (d) => {
        diagnostics.push(d);
      },
    });
    expect(result.cancel).toBeUndefined();
    expect(result.compaction?.firstKeptEntryId).toBe("entry_3");
    expect(diagnostics).toEqual([]);
  });

  it("uses the installed empty tail when preview still had a firstKept", async () => {
    const mocks = mockInstance({
      compactReceipt: makeCompactReceipt({ compactPoint: 6, tailTokens: 0, firstKeptMessageId: null }),
    });
    const result = await handleSessionBeforeCompact(makeBeforeCompactEvent(), ctx, {
      state: createSessionState({ threadId: "th_test" }),
      instance: mocks.instance as never,
      piSessionId: "th_test",
      flushPendingCapture: mocks.flushSpy,
      getSessionView: async () => mocks.sessionView() as never,
      findSeedEntryMap: () => null,
      recordCancel: (d) => {
        diagnostics.push(d);
      },
    });
    expect(result.cancel).toBeUndefined();
    expect(result.compaction?.firstKeptEntryId).toBe("pi-lhc:summary-only");
    expect(diagnostics).toEqual([]);
  });

  it("cancels mapping_failed before compact writes", async () => {
    const mocks = mockInstance();
    const result = await handleSessionBeforeCompact(
      makeBeforeCompactEvent({ branchEntries: makeBranchEntries(1) }),
      ctx,
      {
        state: createSessionState({ threadId: "th_test" }),
        instance: mocks.instance as never,
        piSessionId: "th_test",
        flushPendingCapture: mocks.flushSpy,
        getSessionView: async () => mocks.sessionView() as never,
        findSeedEntryMap: () => null,
        recordCancel: (d) => {
          diagnostics.push(d);
        },
      },
    );
    expect(result).toEqual({ cancel: true });
    expect(diagnostics[0]?.code).toBe("mapping_failed");
    expect(mocks.compactSpy).not.toHaveBeenCalled();
  });

  it("cancels compact_error and records diagnostic", async () => {
    const mocks = mockInstance({ compactOk: false, compactError: "corrupt state" });
    const result = await handleSessionBeforeCompact(makeBeforeCompactEvent(), ctx, {
      state: createSessionState({ threadId: "th_test" }),
      instance: mocks.instance as never,
      piSessionId: "th_test",
      flushPendingCapture: mocks.flushSpy,
      getSessionView: async () => mocks.sessionView() as never,
      findSeedEntryMap: () => null,
      recordCancel: (d) => {
        diagnostics.push(d);
      },
    });
    expect(result).toEqual({ cancel: true });
    expect(diagnostics[0]?.code).toBe("compact_error");
  });

  it("flushes pending capture before preview", async () => {
    const mocks = mockInstance();
    await handleSessionBeforeCompact(makeBeforeCompactEvent(), ctx, {
      state: createSessionState({ threadId: "th_test" }),
      instance: mocks.instance as never,
      piSessionId: "th_test",
      flushPendingCapture: mocks.flushSpy,
      getSessionView: async () => mocks.sessionView() as never,
      findSeedEntryMap: () => null,
    });
    expect(mocks.flushSpy).toHaveBeenCalled();
    expect(mocks.previewSpy).toHaveBeenCalled();
    expect(mocks.flushSpy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.previewSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("forwards abort signal to preview and compact", async () => {
    const mocks = mockInstance();
    const controller = new AbortController();
    controller.abort();
    await handleSessionBeforeCompact(makeBeforeCompactEvent({ signal: controller.signal }), ctx, {
      state: createSessionState({ threadId: "th_test" }),
      instance: mocks.instance as never,
      piSessionId: "th_test",
      flushPendingCapture: mocks.flushSpy,
      getSessionView: async () => mocks.sessionView() as never,
      findSeedEntryMap: () => null,
    });
    const previewArgs = mocks.previewSpy.mock.calls[0]?.[1];
    const compactArgs = mocks.compactSpy.mock.calls[0]?.[1];
    expect(previewArgs?.signal?.aborted).toBe(true);
    expect(compactArgs?.signal?.aborted).toBe(true);
  });

  it("never returns undefined across reason and error paths", async () => {
    const cases: Array<() => Promise<unknown>> = [
      async () =>
        handleSessionBeforeCompact(makeBeforeCompactEvent(), syntheticCtx(), {
          state: null,
          instance: null,
          piSessionId: null,
          flushPendingCapture: async () => {},
          getSessionView: async () =>
            ({
              ok: false,
              error: { code: "storage_failure", reason: "x", errorClass: "system_error" },
            }) as never,
          findSeedEntryMap: () => null,
        }),
      async () => {
        const mocks = mockInstance({ previewOk: false });
        return handleSessionBeforeCompact(makeBeforeCompactEvent({ reason: "overflow" }), ctx, {
          state: createSessionState({ threadId: "th_test" }),
          instance: mocks.instance as never,
          piSessionId: "th_test",
          flushPendingCapture: mocks.flushSpy,
          getSessionView: async () => mocks.sessionView() as never,
          findSeedEntryMap: () => null,
        });
      },
      async () => {
        const mocks = mockInstance();
        mocks.previewSpy.mockRejectedValueOnce(new Error("boom"));
        return handleSessionBeforeCompact(makeBeforeCompactEvent({ reason: "threshold" }), ctx, {
          state: createSessionState({ threadId: "th_test" }),
          instance: mocks.instance as never,
          piSessionId: "th_test",
          flushPendingCapture: mocks.flushSpy,
          getSessionView: async () => mocks.sessionView() as never,
          findSeedEntryMap: () => null,
        });
      },
    ];

    for (const run of cases) {
      const result = await run();
      expect(result === undefined || result === null).toBe(false);
      expect(result).toMatchObject({ cancel: true });
    }
  });
});

describe("connector compact hooks", () => {
  let store: TempStore;
  beforeEach(() => {
    store = tempStore();
  });
  afterEach(() => {
    store.cleanup();
  });

  it("registers compact hooks with epic hooks", () => {
    const registered: string[] = [];
    const pi = {
      on(name: string) {
        registered.push(name);
      },
      registerCommand: () => {},
      registerTool: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      appendEntry: () => {},
      getThinkingLevel: () => "medium",
      setThinkingLevel: () => {},
      setModel: async () => true,
    } as ExtensionAPI;

    createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      readLaunchFlags: () => ({ ok: true, value: {} }),
      startupValidationReporter: () => {},
    }).register(pi);

    expect(new Set(registered)).toEqual(new Set(CONNECTOR_HOOKS));
    for (const hook of COMPACT_HOOKS) expect(registered).toContain(hook);
  });

  it("accumulates compact diagnostics and clears buffer on session_compact", async () => {
    const connector = createConnector({
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      readLaunchFlags: () => ({ ok: true, value: {} }),
      startupValidationReporter: () => {},
      buildSdkConfig: () => ({ ok: true, value: { mode: "manual" } }),
    });
    const entries: SessionEntry[] = [];
    const pi = {
      on() {},
      registerCommand: () => {},
      registerTool: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      appendEntry: () => {},
      getThinkingLevel: () => "medium",
      setThinkingLevel: () => {},
      setModel: async () => true,
    } as ExtensionAPI;
    connector.register(pi);

    const ctx = syntheticCtx("/work", entries);
    await connector.compactHandlers.session_before_compact(makeBeforeCompactEvent(), ctx);
    await connector.compactHandlers.session_before_compact(makeBeforeCompactEvent(), ctx);
    expect(connector.getCompactDiagnostics()).toHaveLength(2);
    expect(connector.getLastCompactDiagnostic()?.code).toBeDefined();

    await connector.compactHandlers.session_compact(
      { type: "session_compact", compactionEntry: { type: "compaction" }, fromExtension: true },
      ctx,
    );
    expect(connector.getCompactDiagnostics()).toEqual([]);
    expect(connector.getLastCompactDiagnostic()).toBeNull();
  });

  it("writes warning log to LHC on compact cancel", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;

    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("still open")), ctx);
    await connector.compactHandlers.session_before_compact(makeBeforeCompactEvent(), ctx);

    expect(connector.getCompactDiagnostics()).toEqual([
      expect.objectContaining({
        code: "no_op",
        reason: expect.stringMatching(/below the ~50k compact floor/),
      }),
    ]);

    const instance = connector.getInstance();
    expect(instance).not.toBeNull();
    if (instance === null) return;

    const logs = await instance.sdk.logging.query(threadRef, { level: "warning", reason: "no_op" });
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value.some((entry) => entry.message.includes("no_op"))).toBe(true);
  });

  it("capture_incomplete when agent_end turn-close failed and compact flush is empty", async () => {
    const realCapture = captureModule.capture;
    const captureSpy = vi.spyOn(captureModule, "capture").mockImplementation(async (events, instance) => {
      if (events.some((event) => event.eventKind === "turn_end")) {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "invalid_event",
            reason: "turn_end rejected for test",
          },
        };
      }
      return realCapture(events, instance);
    });

    try {
      const started = await startCapture(store);
      const { connector, ctx } = started;

      await connector.handlers.message_end(makeMessageEnd(makeUserMessage("first")), ctx);
      await connector.handlers.agent_end(makeAgentEnd([]), ctx);
      expect(connector.getState()?.health.lastCaptureFailure?.code).toBe("invalid_event");

      const result = await connector.compactHandlers.session_before_compact(makeBeforeCompactEvent(), ctx);
      expect(result).toEqual({ cancel: true });
      expect(connector.getCompactDiagnostics()).toEqual([expect.objectContaining({ code: "capture_incomplete" })]);
    } finally {
      captureSpy.mockRestore();
    }
  });

  it("no_op when stale capture failure was cleared by a successful pending flush", async () => {
    const started = await startCapture(store);
    const { connector, ctx } = started;

    await connector.handlers.message_end(
      { type: "message_end", message: { role: "badRole", content: [] } as never },
      ctx,
    );
    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("still open")), ctx);
    expect(connector.getState()?.health.lastCaptureFailure).toBeDefined();

    const result = await connector.compactHandlers.session_before_compact(makeBeforeCompactEvent(), ctx);
    expect(result).toEqual({ cancel: true });
    expect(connector.getCompactDiagnostics()).toEqual([
      expect.objectContaining({
        code: "no_op",
        reason: expect.stringMatching(/below the ~50k compact floor/),
      }),
    ]);
  });

  it("clears compact diagnostics on session_before_switch without successful compact", async () => {
    const started = await startCapture(store);
    const { connector, ctx } = started;

    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("still open")), ctx);
    await connector.compactHandlers.session_before_compact(makeBeforeCompactEvent(), ctx);
    expect(connector.getCompactDiagnostics()).toHaveLength(1);

    await connector.handlers.session_before_switch({ type: "session_before_switch", reason: "new" }, ctx);
    expect(connector.getCompactDiagnostics()).toEqual([]);
    expect(connector.getLastCompactDiagnostic()).toBeNull();
  });

  it("clears compact diagnostics on session_shutdown without successful compact", async () => {
    const started = await startCapture(store);
    const { connector, ctx } = started;

    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("still open")), ctx);
    await connector.compactHandlers.session_before_compact(makeBeforeCompactEvent(), ctx);
    expect(connector.getCompactDiagnostics()).toHaveLength(1);

    await connector.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
    expect(connector.getCompactDiagnostics()).toEqual([]);
    expect(connector.getLastCompactDiagnostic()).toBeNull();
  });

  it("does not leak compact diagnostics into the next session_start", async () => {
    const started = await startCapture(store);
    const { connector, ctx } = started;

    await connector.handlers.message_end(makeMessageEnd(makeUserMessage("still open")), ctx);
    await connector.compactHandlers.session_before_compact(makeBeforeCompactEvent(), ctx);
    expect(connector.getCompactDiagnostics()).toHaveLength(1);

    await connector.handlers.session_shutdown({ type: "session_shutdown", reason: "reload" }, ctx);
    await connector.handlers.session_start(makeSessionStart("reload"), ctx);
    expect(connector.getCompactDiagnostics()).toEqual([]);
    expect(connector.getLastCompactDiagnostic()).toBeNull();
  });
});
