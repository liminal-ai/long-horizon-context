import type { OpResult, PruneReceipt, ThreadRef } from "lhc";
import { describe, expect, it, vi } from "vitest";
import { handleToolPrune } from "../../src/commands/tool-prune.js";
import type { ExtensionCommandContext } from "../../src/pi/types.js";
import type { LhcInstance } from "../../src/shared/instance.js";

function threadRef(): ThreadRef {
  return { threadId: "th_0000000000000001", registryPath: "/tmp/registry" };
}

function mockCtx(): {
  ctx: ExtensionCommandContext;
  notifications: Array<{ message: string; type?: string }>;
} {
  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx: ExtensionCommandContext = {
    cwd: "/work/tool-prune",
    hasUI: true,
    ui: {
      notify: (message, type) => {
        notifications.push({ message, ...(type === undefined ? {} : { type }) });
      },
    },
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
    sessionManager: { getEntries: () => [] },
    waitForIdle: async () => {},
    newSession: vi.fn(),
  };
  return { ctx, notifications };
}

function makePruneReceipt(overrides: Partial<PruneReceipt> = {}): PruneReceipt {
  return {
    previousBoundary: 0,
    newBoundary: 1,
    compactPoint: 0,
    targetTokens: 32_000,
    toolResultsPruned: 0,
    tokensBehindBoundary: 0,
    zoneTokensBefore: 40_000,
    zoneTokensAfter: 40_000,
    noOp: true,
    ...overrides,
  };
}

function mockInstance(pruneResult: OpResult<PruneReceipt>) {
  const pruneSpy = vi.fn(async () => pruneResult);
  const instance = {
    sdk: {
      threadView: {
        prune: pruneSpy,
      },
    },
    threadRef: threadRef(),
    dispose: async () => ({ ok: true as const, value: undefined }),
  } as unknown as LhcInstance;
  return { instance, pruneSpy };
}

describe("handleToolPrune", () => {
  it("notifies error and skips SDK when no LHC thread is attached", async () => {
    const { ctx, notifications } = mockCtx();
    const { instance, pruneSpy } = mockInstance({ ok: true, value: makePruneReceipt() });
    const rehydrate = vi.fn(async () => {});

    await handleToolPrune(ctx, "", null, instance, { rehydrate });
    expect(notifications).toEqual([{ message: "pi-lhc: no LHC thread attached", type: "error" }]);
    expect(pruneSpy).not.toHaveBeenCalled();
    expect(rehydrate).not.toHaveBeenCalled();

    notifications.length = 0;
    await handleToolPrune(ctx, "", threadRef(), null, { rehydrate });
    expect(notifications).toEqual([{ message: "pi-lhc: no LHC thread attached", type: "error" }]);
    expect(pruneSpy).not.toHaveBeenCalled();
    expect(rehydrate).not.toHaveBeenCalled();
  });

  it("passes undefined targetTokens for empty or whitespace args", async () => {
    const ref = threadRef();
    const { ctx, notifications } = mockCtx();
    const { instance, pruneSpy } = mockInstance({ ok: true, value: makePruneReceipt() });
    const rehydrate = vi.fn(async () => {});

    for (const args of ["", "  ", "\t"] as const) {
      pruneSpy.mockClear();
      notifications.length = 0;
      rehydrate.mockClear();

      await handleToolPrune(ctx, args, ref, instance, { rehydrate });

      expect(pruneSpy).toHaveBeenCalledOnce();
      expect(pruneSpy).toHaveBeenCalledWith(ref, undefined);
      expect(notifications.some((n) => n.type === "error")).toBe(false);
    }
  });

  it("passes parsed targetTokens for a numeric arg", async () => {
    const ref = threadRef();
    const { ctx } = mockCtx();
    const { instance, pruneSpy } = mockInstance({ ok: true, value: makePruneReceipt() });
    const rehydrate = vi.fn(async () => {});

    await handleToolPrune(ctx, "20000", ref, instance, { rehydrate });

    expect(pruneSpy).toHaveBeenCalledOnce();
    expect(pruneSpy).toHaveBeenCalledWith(ref, { targetTokens: 20_000 });
  });

  it("notifies error and skips SDK for invalid target token args", async () => {
    const ref = threadRef();
    const { ctx, notifications } = mockCtx();
    const { instance, pruneSpy } = mockInstance({ ok: true, value: makePruneReceipt() });
    const rehydrate = vi.fn(async () => {});

    for (const arg of ["abc", "-5"]) {
      pruneSpy.mockClear();
      notifications.length = 0;

      await handleToolPrune(ctx, arg, ref, instance, { rehydrate });

      expect(pruneSpy).not.toHaveBeenCalled();
      expect(rehydrate).not.toHaveBeenCalled();
      expect(notifications).toEqual([
        {
          message: `pi-lhc: tool prune failed — target tokens must be a non-negative integer; received "${arg}"`,
          type: "error",
        },
      ]);
    }
  });

  it("notifies info and skips rehydrate when prune is a no-op", async () => {
    const ref = threadRef();
    const { ctx, notifications } = mockCtx();
    const receipt = makePruneReceipt({
      noOp: true,
      zoneTokensAfter: 25_000,
      targetTokens: 32_000,
    });
    const { instance } = mockInstance({ ok: true, value: receipt });
    const rehydrate = vi.fn(async () => {});

    await handleToolPrune(ctx, "", ref, instance, { rehydrate });

    expect(notifications).toEqual([
      {
        message: "pi-lhc: zone already under target (25000 / 32000 tokens)",
        type: "info",
      },
    ]);
    expect(rehydrate).not.toHaveBeenCalled();
  });

  it("notifies prune summary and rehydrates when prune changes the zone", async () => {
    const ref = threadRef();
    const { ctx, notifications } = mockCtx();
    const receipt = makePruneReceipt({
      noOp: false,
      toolResultsPruned: 3,
      zoneTokensBefore: 50_000,
      zoneTokensAfter: 28_000,
      targetTokens: 32_000,
    });
    const { instance } = mockInstance({ ok: true, value: receipt });
    const rehydrate = vi.fn(async () => {});

    await handleToolPrune(ctx, "32000", ref, instance, { rehydrate });

    expect(notifications).toEqual([
      {
        message: "pi-lhc: pruned 3 tool result(s), reclaimed 22000 tokens (zone now 28000)",
        type: "info",
      },
    ]);
    expect(rehydrate).toHaveBeenCalledOnce();
    expect(rehydrate).toHaveBeenCalledWith(ctx, ref);
  });

  it("notifies SDK error reason without rehydrating", async () => {
    const ref = threadRef();
    const { ctx, notifications } = mockCtx();
    const { instance } = mockInstance({
      ok: false,
      error: {
        errorClass: "system_error",
        code: "storage_failure",
        reason: "could not persist boundary",
      },
    });
    const rehydrate = vi.fn(async () => {});

    await handleToolPrune(ctx, "", ref, instance, { rehydrate });

    expect(notifications).toEqual([
      {
        message: "pi-lhc: tool prune failed — could not persist boundary",
        type: "error",
      },
    ]);
    expect(rehydrate).not.toHaveBeenCalled();
  });
});
