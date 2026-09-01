import type { Lhc, ThreadRef } from "lhc";
import { describe, expect, it, vi } from "vitest";

import { type ContextMutationPlan, runContextMutation } from "../../src/commands/context-mutation.js";
import type { LhcCommandRuntime } from "../../src/commands/dispatch.js";
import { BUILTIN_CONTEXT_POLICIES } from "../../src/governor/config.js";
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

function sdkMock(zoneTokens: number) {
  return {
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
          zoneTokensBefore: zoneTokens,
          zoneTokensAfter: 10,
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
          totalTokens: 9,
          bands: {
            smooth: { entries: 1, tokens: 4 },
            detailed: { entries: 0, tokens: 0 },
            brief: { entries: 0, tokens: 0 },
          },
        },
      })),
      getSessionThreadView: vi.fn(async () => ({
        ok: true,
        value: { threadId: "th_cm", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
      })),
    },
  };
}

function runtimeWith(sdk: ReturnType<typeof sdkMock>): LhcCommandRuntime {
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
      threadId: "th_cm",
    },
    sdk: sdk as unknown as Lhc,
    threadRef: { threadId: "th_cm", registryPath: "/tmp/r.sqlite" } as ThreadRef,
    cwd: "/work/cm",
    sourceRolloutPath: undefined,
    sourceSessionId: "old-cm",
    isTurnOpen: () => false,
    isCaptureHealthy: () => true,
    isCaptureReady: () => true,
    getCaptureGeneration: () => 1,
    captureGeneration: 1,
    capturePhase: "ready",
  };
}

const COMPACT_PLAN: ContextMutationPlan = {
  operation: "auto_compact",
  profile: "default",
  lowerBoundTokens: 240_000,
};

describe("runContextMutation", () => {
  it("passes the configured profile and lower bound to BOTH preview and compact", async () => {
    const sdk = sdkMock(0);
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(REBUILT);
    const outcome = await runContextMutation(
      { ...COMPACT_PLAN, profile: "balanced", lowerBoundTokens: 111_000 },
      runtimeWith(sdk),
    );
    expect(outcome.kind).toBe("rebuilt");
    const expected = { profile: "cc-lhc-balanced", params: { lowerBound: 111_000 } };
    expect(sdk.threadView.previewCompact).toHaveBeenCalledWith(expect.anything(), expected);
    expect(sdk.threadView.compact).toHaveBeenCalledWith(expect.anything(), expected);
    writeSpy.mockRestore();
  });

  it("compact plus due prune applies both view mutations with ONE view read and ONE rebuild", async () => {
    const sdk = sdkMock(500);
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(REBUILT);
    const outcome = await runContextMutation(
      { ...COMPACT_PLAN, pruneIfDue: { thresholdTokens: 400, targetTokens: 100 } },
      runtimeWith(sdk),
    );
    expect(outcome.kind).toBe("rebuilt");
    expect(sdk.threadView.prune).toHaveBeenCalledWith(expect.anything(), { targetTokens: 100 });
    expect(sdk.threadView.compact).toHaveBeenCalledOnce();
    expect(sdk.threadView.getSessionThreadView).toHaveBeenCalledOnce();
    expect(writeSpy).toHaveBeenCalledOnce();
    if (outcome.kind === "rebuilt") {
      expect(outcome.messages.join("\n")).toMatch(/prune boundary/);
      expect(outcome.messages.join("\n")).toMatch(/Smart Compact view=/);
    }
    writeSpy.mockRestore();
  });

  it("skips the combined prune when the zone is below threshold", async () => {
    const sdk = sdkMock(50);
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(REBUILT);
    const outcome = await runContextMutation(
      { ...COMPACT_PLAN, pruneIfDue: { thresholdTokens: 400, targetTokens: 100 } },
      runtimeWith(sdk),
    );
    expect(outcome.kind).toBe("rebuilt");
    expect(sdk.threadView.prune).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("a failed due-prune reports but does not abort the compact", async () => {
    const sdk = sdkMock(500);
    sdk.threadView.prune = vi.fn(async () => ({
      ok: false as const,
      error: { code: "x", reason: "prune broke", errorClass: "system_error" },
    })) as never;
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(REBUILT);
    const outcome = await runContextMutation(
      { ...COMPACT_PLAN, pruneIfDue: { thresholdTokens: 400, targetTokens: 100 } },
      runtimeWith(sdk),
    );
    expect(outcome.kind).toBe("rebuilt");
    if (outcome.kind === "rebuilt") {
      expect(outcome.messages.join("\n")).toMatch(/prune error: prune broke/);
    }
    expect(sdk.threadView.compact).toHaveBeenCalledOnce();
    writeSpy.mockRestore();
  });

  it("compact refusal from the SDK preview leaves everything unchanged", async () => {
    const sdk = sdkMock(0);
    sdk.threadView.previewCompact = vi.fn(async () => ({
      ok: true as const,
      value: { kind: "error" as const, reason: "record damage" },
    })) as never;
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout");
    const outcome = await runContextMutation(COMPACT_PLAN, runtimeWith(sdk));
    expect(outcome.kind).toBe("refused");
    expect(sdk.threadView.compact).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("handoff request carries operation, ids, thread, and the verified prefix boundary", async () => {
    const sdk = sdkMock(0);
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(REBUILT);
    const outcome = await runContextMutation(COMPACT_PLAN, runtimeWith(sdk));
    expect(outcome.kind).toBe("rebuilt");
    if (outcome.kind === "rebuilt") {
      expect(outcome.handoff.operation).toBe("auto_compact");
      expect(outcome.handoff.oldSessionId).toBe("old-cm");
      expect(outcome.handoff.threadId).toBe("th_cm");
      expect(outcome.handoff.rebuilt.prefixBoundary.kind).toBe("verified");
    }
    writeSpy.mockRestore();
  });
});

describe("window-derived target reaches view construction (TC-1.2b, TC-1.2c)", () => {
  it("passes the 200k built-in target of 70,000 directly, with no multiplier", async () => {
    const sdk = sdkMock(0);
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(REBUILT);
    const policy = BUILTIN_CONTEXT_POLICIES["200k"];
    const outcome = await runContextMutation(
      { operation: "auto_compact", profile: policy.profile, lowerBoundTokens: policy.lowerBoundTokens },
      runtimeWith(sdk),
    );
    expect(outcome.kind).toBe("rebuilt");
    const expected = { profile: "continuation", params: { lowerBound: 70_000 } };
    expect(sdk.threadView.previewCompact).toHaveBeenCalledWith(expect.anything(), expected);
    expect(sdk.threadView.compact).toHaveBeenCalledWith(expect.anything(), expected);
    writeSpy.mockRestore();
  });

  it("reports the actual rebuilt size when protected material exceeds the target", async () => {
    const sdk = sdkMock(0);
    sdk.threadView.compact = vi.fn(async () => ({
      ok: true,
      value: {
        viewId: "v-oversize",
        tailTokens: 60_000,
        totalTokens: 95_000,
        bands: {
          smooth: { entries: 1, tokens: 35_000 },
          detailed: { entries: 0, tokens: 0 },
          brief: { entries: 0, tokens: 0 },
        },
      },
    }));
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(REBUILT);
    const outcome = await runContextMutation(
      { operation: "auto_compact", profile: "default", lowerBoundTokens: 70_000 },
      runtimeWith(sdk),
    );
    expect(outcome.kind).toBe("rebuilt");
    if (outcome.kind !== "rebuilt") return;
    expect(outcome.handoff.metrics.viewTokens).toBe(95_000);
    expect(outcome.handoff.metrics.targetTokens).toBe(70_000);
    const text = JSON.stringify(outcome.handoff);
    expect(text).toContain("rebuilt LHC view 95k (70k target)");
    expect(text).not.toMatch(/target (met|reached)/i);
    writeSpy.mockRestore();
  });
});
