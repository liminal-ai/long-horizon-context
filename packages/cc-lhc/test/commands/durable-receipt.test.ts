import type { Lhc, ThreadRef } from "lhc";
import { describe, expect, it, vi } from "vitest";

import {
  formatDurableReceipt,
  formatTokensShort,
  runContextMutation,
} from "../../src/commands/context-mutation.js";
import type { LhcCommandRuntime } from "../../src/commands/dispatch.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";

const REBUILT = {
  sessionId: "abcdabcd-abcd-abcd-abcd-abcdabcdabcd",
  rolloutPath: "/tmp/rebuilt.jsonl",
  lineCount: 2,
  expectedReintakeLines: 2,
  replayedPrefixLines: 1,
  prefixBoundary: { kind: "verified" as const, lineCount: 1, byteLength: 10, sha256: "ab".repeat(32) },
  totalByteLength: 20,
};

function runtime(zoneTokens = 0): { runtime: LhcCommandRuntime; sdk: Record<string, unknown> } {
  const sdk = {
    threadView: {
      status: vi.fn(async () => ({
        ok: true,
        value: {
          tailTokens: 10,
          threshold: 100,
          visibility: { zoneTokens, maxTokens: 1000 },
          derivation: { pending: 0, failed: 0 },
        },
      })),
      prune: vi.fn(async () => ({
        ok: true,
        value: {
          previousBoundary: 0,
          newBoundary: 2,
          zoneTokensBefore: 82_000,
          zoneTokensAfter: 30_000,
          toolResultsPruned: 3,
          noOp: false,
        },
      })),
      previewCompact: vi.fn(async () => ({ ok: true, value: { kind: "ok" } })),
      compact: vi.fn(async () => ({
        ok: true,
        value: {
          viewId: "v1",
          tailTokens: 5,
          totalTokens: 247_000,
          bands: {
            smooth: { entries: 1, tokens: 4 },
            detailed: { entries: 0, tokens: 0 },
            brief: { entries: 0, tokens: 0 },
          },
        },
      })),
      getSessionThreadView: vi.fn(async () => ({
        ok: true,
        value: { threadId: "th_r", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
      })),
    },
  };
  return {
    sdk,
    runtime: {
      captureDisabled: false,
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
        threadId: "th_r",
      },
      sdk: sdk as unknown as Lhc,
      threadRef: { threadId: "th_r", registryPath: "/tmp/r.sqlite" } as ThreadRef,
      cwd: "/work/r",
      sourceRolloutPath: undefined,
      sourceSessionId: "old-r",
      isTurnOpen: () => false,
      isCaptureHealthy: () => true,
      isCaptureReady: () => true,
      getCaptureGeneration: () => 1,
      captureGeneration: 1,
      capturePhase: "ready",
    },
  };
}

describe("durable operation receipt", () => {
  it("matches the specified shapes", () => {
    expect(
      formatDurableReceipt("auto_compact", {
        origin: "auto",
        triggerContextTokens: 508_000,
        viewTokens: 247_000,
        targetTokens: 240_000,
      }),
    ).toBe("[lhc compact:auto] trigger context 508k; rebuilt LHC view 247k (240k target).");
    expect(
      formatDurableReceipt("prune", { origin: "manual", zoneTokensBefore: 82_000, zoneTokensAfter: 30_000 }),
    ).toBe("[lhc prune:manual] tool-result zone 82k -> 30k.");
    expect(formatTokensShort(1_426)).toBe("1.4k");
    expect(formatTokensShort(941)).toBe("941");
  });

  it("automatic compact writes EXACTLY ONE labeled receipt and no legacy swap note", async () => {
    const { runtime: rt } = runtime();
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(REBUILT);
    const outcome = await runContextMutation(
      {
        operation: "auto_compact",
        profile: "continuation",
        lowerBoundTokens: 240_000,
        triggerContextTokens: 508_000,
      },
      rt,
    );
    expect(outcome.kind).toBe("rebuilt");
    expect(writeSpy).toHaveBeenCalledOnce();
    const input = writeSpy.mock.calls[0]![0];
    expect(input.receipt?.text).toBe(
      "[lhc compact:auto] trigger context 508k; rebuilt LHC view 247k (240k target).",
    );
    expect(input.receipt?.text).not.toMatch(/preserved|resume|session /);
    if (outcome.kind === "rebuilt") {
      expect(outcome.handoff.durableReceipt).toBe(input.receipt?.text);
      expect(outcome.handoff.metrics).toMatchObject({
        origin: "auto",
        triggerContextTokens: 508_000,
        viewTokens: 247_000,
        targetTokens: 240_000,
      });
    }
    writeSpy.mockRestore();
  });

  it("manual prune writes the prune-labeled receipt", async () => {
    const { runtime: rt } = runtime();
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(REBUILT);
    const outcome = await runContextMutation(
      { operation: "prune", profile: "continuation", lowerBoundTokens: 240_000 },
      rt,
    );
    expect(outcome.kind).toBe("rebuilt");
    const input = writeSpy.mock.calls[0]![0];
    expect(input.receipt?.text).toBe("[lhc prune:manual] tool-result zone 82k -> 30k.");
    writeSpy.mockRestore();
  });

  it("manual compact with a due combined prune stays one receipt carrying both facts", async () => {
    const { runtime: rt } = runtime(500_000);
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(REBUILT);
    const outcome = await runContextMutation(
      {
        operation: "compact",
        profile: "continuation",
        lowerBoundTokens: 240_000,
        pruneIfDue: { thresholdTokens: 100_000, targetTokens: 30_000 },
      },
      rt,
    );
    expect(outcome.kind).toBe("rebuilt");
    expect(writeSpy).toHaveBeenCalledOnce();
    const input = writeSpy.mock.calls[0]![0];
    expect(input.receipt?.text).toBe(
      "[lhc compact:manual] tool-result zone 82k -> 30k; rebuilt LHC view 247k (240k target).",
    );
    writeSpy.mockRestore();
  });
});
