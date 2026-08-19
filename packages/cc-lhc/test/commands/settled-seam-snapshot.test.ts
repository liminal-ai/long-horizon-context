/**
 * Construction is forward-only: ONE snapshot at the settled seam, then the
 * operation runs to completion.
 *
 * These are outcome tests. The suite they replace asserted the opposite
 * contract — that state re-read at eight points during construction could
 * cancel it — and every one of those assertions is deliberately gone.
 */

import type { Lhc, ThreadRef } from "lhc";
import { describe, expect, it, vi } from "vitest";

import { runCompactCommand } from "../../src/commands/compact.js";
import { REBUILT_ROLLOUT_WRITE_ATTEMPTS, settledSeamSnapshot } from "../../src/commands/context-mutation.js";
import { CAPTURE_DEGRADED_REFUSAL, type LhcCommandRuntime, TURN_OPEN_REFUSAL } from "../../src/commands/dispatch.js";
import { runPruneCommand } from "../../src/commands/prune.js";
import { CAPTURE_NOT_READY_REFUSAL } from "../../src/intake/session.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";

const COMPACT_RECEIPT = {
  viewId: "v1",
  tailTokens: 4,
  totalTokens: 9,
  bands: {
    smooth: { entries: 1, tokens: 5 },
    detailed: { entries: 0, tokens: 0 },
    brief: { entries: 0, tokens: 0 },
  },
};

const PRUNE_RECEIPT = {
  previousBoundary: 0,
  newBoundary: 1,
  zoneTokensBefore: 10,
  zoneTokensAfter: 5,
  toolResultsPruned: 1,
  noOp: false,
};

function rebuiltResult(): writeRebuilt.WriteRebuiltRolloutResult {
  return {
    sessionId: "new-2222",
    rolloutPath: "/tmp/new-2222.jsonl",
    lineCount: 3,
    expectedReintakeLines: 3,
    replayedPrefixLines: 2,
    prefixBoundary: { kind: "verified", lineCount: 2, byteLength: 40, sha256: "aa".repeat(32) },
    totalByteLength: 60,
  };
}

interface LiveState {
  turnOpen: boolean;
  ready: boolean;
  healthy: boolean;
  phase: "binding" | "ready" | "degraded" | "closed";
  generation: number;
}

function baseRuntime(sdk: unknown, live: LiveState): LhcCommandRuntime {
  return {
    stats: {
      linesSeen: 0,
      eventsSent: 0,
      skippedSidechain: 0,
      skippedUnknown: 0,
      skippedMeta: 0,
      skippedImage: 0,
      skippedReplay: 0,
      replayedPrefixLines: 0,
      parseFailures: 0,
      derivationsPending: null,
      threadId: "th",
    },
    sdk: sdk as Lhc,
    threadRef: { threadId: "th", registryPath: "/tmp/r.sqlite" } as ThreadRef,
    cwd: "/work",
    sourceRolloutPath: undefined,
    sourceSessionId: "old-1111",
    isTurnOpen: () => live.turnOpen,
    isCaptureHealthy: () => live.healthy,
    isCaptureReady: () => live.ready,
    getCaptureGeneration: () => live.generation,
    get capturePhase() {
      return live.phase;
    },
    get captureDegraded() {
      return live.phase === "degraded";
    },
    get captureGeneration() {
      return live.generation;
    },
  } as LhcCommandRuntime;
}

function settledState(): LiveState {
  return { turnOpen: false, ready: true, healthy: true, phase: "ready", generation: 1 };
}

/** Everything the world can do to the wrapper while construction is running. */
function degradeEverything(live: LiveState): void {
  live.turnOpen = true;
  live.ready = false;
  live.healthy = false;
  live.phase = "degraded";
  live.generation += 1;
}

describe("settled-seam snapshot", () => {
  it("refuses a compact while a turn is open — Claude Code has no mid-turn seam", () => {
    const live = { ...settledState(), turnOpen: true };
    expect(settledSeamSnapshot(baseRuntime({}, live))).toBe(TURN_OPEN_REFUSAL);
  });

  it("refuses while capture is still binding, and says so as binding", () => {
    const live = { ...settledState(), ready: false, healthy: false, phase: "binding" as const };
    expect(settledSeamSnapshot(baseRuntime({}, live))).toBe(CAPTURE_NOT_READY_REFUSAL);
  });

  it("refuses while capture is degraded", () => {
    const live = { ...settledState(), ready: false, healthy: false, phase: "degraded" as const };
    expect(settledSeamSnapshot(baseRuntime({}, live))).toBe(CAPTURE_DEGRADED_REFUSAL);
  });

  it("passes a settled seam", () => {
    expect(settledSeamSnapshot(baseRuntime({}, settledState()))).toBeNull();
  });
});

describe("construction runs to completion", () => {
  it("compacts and hands off even when input, turn, capture and generation all change mid-construction", async () => {
    const live = settledState();
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(rebuiltResult());
    const sdk = {
      threadView: {
        previewCompact: vi.fn(async () => {
          // The whole world moves on between the snapshot and the compact.
          degradeEverything(live);
          return { ok: true, value: { kind: "ok" } };
        }),
        compact: vi.fn(async () => ({ ok: true, value: COMPACT_RECEIPT })),
        getSessionThreadView: vi.fn(async () => ({
          ok: true,
          value: { threadId: "th", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
        })),
      },
    };
    const outcome = await runCompactCommand("compact", baseRuntime(sdk, live));
    expect(outcome.handoff?.rebuilt.sessionId).toBe("new-2222");
    expect(sdk.threadView.compact).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    writeSpy.mockRestore();
  });

  it("prunes and hands off even when capture degrades during the prune", async () => {
    const live = settledState();
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(rebuiltResult());
    const sdk = {
      threadView: {
        prune: vi.fn(async () => {
          degradeEverything(live);
          return { ok: true, value: PRUNE_RECEIPT };
        }),
        getSessionThreadView: vi.fn(async () => ({ ok: true, value: { threadId: "th", entries: [] } })),
      },
    };
    const outcome = await runPruneCommand("prune", baseRuntime(sdk, live));
    expect(outcome.handoff?.rebuilt.sessionId).toBe("new-2222");
    writeSpy.mockRestore();
  });

  it("reads live state exactly once — the snapshot — and never again", async () => {
    const live = settledState();
    let turnReads = 0;
    let readyReads = 0;
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(rebuiltResult());
    const runtime = baseRuntime(
      {
        threadView: {
          previewCompact: vi.fn(async () => ({ ok: true, value: { kind: "ok" } })),
          compact: vi.fn(async () => ({ ok: true, value: COMPACT_RECEIPT })),
          getSessionThreadView: vi.fn(async () => ({ ok: true, value: { threadId: "th", entries: [] } })),
        },
      },
      live,
    );
    runtime.isTurnOpen = () => {
      turnReads += 1;
      return false;
    };
    runtime.isCaptureReady = () => {
      readyReads += 1;
      return true;
    };
    const outcome = await runCompactCommand("compact", runtime);
    expect(outcome.handoff).toBeDefined();
    expect(turnReads).toBe(1);
    expect(readyReads).toBe(1);
    writeSpy.mockRestore();
  });
});

describe("rebuilt rollout write retries", () => {
  it("retries the write from the installed view and hands off on a later attempt", async () => {
    const live = settledState();
    let attempts = 0;
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async () => {
      attempts += 1;
      if (attempts < REBUILT_ROLLOUT_WRITE_ATTEMPTS) throw new Error("ENOSPC");
      return rebuiltResult();
    });
    const viewRead = vi.fn(async () => ({ ok: true, value: { threadId: "th", entries: [] } }));
    const sdk = {
      threadView: {
        previewCompact: vi.fn(async () => ({ ok: true, value: { kind: "ok" } })),
        compact: vi.fn(async () => ({ ok: true, value: COMPACT_RECEIPT })),
        getSessionThreadView: viewRead,
      },
    };
    const outcome = await runCompactCommand("compact", baseRuntime(sdk, live));
    expect(outcome.handoff?.rebuilt.sessionId).toBe("new-2222");
    // Compact ran once; only the materialization was retried, each attempt
    // rebuilding from the durable installed view.
    expect(sdk.threadView.compact).toHaveBeenCalledTimes(1);
    expect(viewRead).toHaveBeenCalledTimes(REBUILT_ROLLOUT_WRITE_ATTEMPTS);
    expect(outcome.messages.join("\n")).toContain(`attempt ${REBUILT_ROLLOUT_WRITE_ATTEMPTS}`);
    writeSpy.mockRestore();
  });

  it("keeps the installed view and reports partial when every write attempt fails", async () => {
    const live = settledState();
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockRejectedValue(new Error("EROFS"));
    const sdk = {
      threadView: {
        previewCompact: vi.fn(async () => ({ ok: true, value: { kind: "ok" } })),
        compact: vi.fn(async () => ({ ok: true, value: COMPACT_RECEIPT })),
        getSessionThreadView: vi.fn(async () => ({ ok: true, value: { threadId: "th", entries: [] } })),
      },
    };
    const outcome = await runCompactCommand("compact", baseRuntime(sdk, live));
    expect(outcome.handoff).toBeUndefined();
    expect(writeSpy).toHaveBeenCalledTimes(REBUILT_ROLLOUT_WRITE_ATTEMPTS);
    const text = outcome.messages.join("\n");
    expect(text).toContain("LHC view is installed and durable");
    expect(text).toContain("re-materializes from it");
    writeSpy.mockRestore();
  });
});
