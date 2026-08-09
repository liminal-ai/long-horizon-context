import { describe, expect, it, vi } from "vitest";
import type { Lhc, ThreadRef } from "lhc";

import { runCompactCommand } from "../../src/commands/compact.js";
import {
  CAPTURE_DEGRADED_REFUSAL,
  CAPTURE_PARTIAL_VIEW_MUTATION,
} from "../../src/commands/dispatch.js";
import { CAPTURE_NOT_READY_REFUSAL } from "../../src/intake/session.js";
import type { LhcCommandRuntime } from "../../src/commands/dispatch.js";
import { runPruneCommand } from "../../src/commands/prune.js";

function baseRuntime(overrides: Partial<LhcCommandRuntime> = {}): LhcCommandRuntime {
  let generation = 1;
  let healthy = true;
  let ready = true;
  let phase: "binding" | "ready" | "degraded" | "closed" = "ready";
  return {
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
      threadId: "th",
    },
    sdk: {
      threadView: {
        previewCompact: vi.fn(async () => {
          healthy = false;
          ready = false;
          phase = "degraded";
          return { ok: true, value: { kind: "ok" } };
        }),
        compact: vi.fn(async () => ({
          ok: true,
          value: {
            viewId: "v1",
            tailTokens: 1,
            totalTokens: 1,
            bands: { smooth: { entries: 0, tokens: 0 }, detailed: { entries: 0, tokens: 0 }, brief: { entries: 0, tokens: 0 } },
          },
        })),
        getSessionThreadView: vi.fn(async () => ({
          ok: true,
          value: { threadId: "th", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
        })),
      },
    } as unknown as Lhc,
    threadRef: { threadId: "th", registryPath: "/tmp/r.sqlite" } as ThreadRef,
    cwd: "/work",
    sourceRolloutPath: undefined,
    sourceSessionId: "old",
    isTurnOpen: () => false,
    isCaptureHealthy: () => healthy,
    isCaptureReady: () => ready,
    getCaptureGeneration: () => generation,
    captureGeneration: generation,
    capturePhase: phase,
    captureDegraded: !healthy,
    ...overrides,
  };
}

describe("mutation generation lease fence", () => {
  it("refuses when capture is still binding", async () => {
    const runtime = baseRuntime({
      isCaptureReady: () => false,
      isCaptureHealthy: () => false,
      capturePhase: "binding",
    });
    const outcome = await runCompactCommand("compact", runtime);
    expect(outcome.messages).toContain(CAPTURE_NOT_READY_REFUSAL);
    expect(outcome.restart).toBeUndefined();
  });

  it("refuses after preview when degradation races during await (pre-mutation)", async () => {
    const runtime = baseRuntime();
    const outcome = await runCompactCommand("compact", runtime);
    // Degrades during preview — no SDK compact yet → plain degraded refusal.
    expect(outcome.messages.some((m) => m === CAPTURE_DEGRADED_REFUSAL || m === CAPTURE_NOT_READY_REFUSAL)).toBe(
      true,
    );
    expect(outcome.restart).toBeUndefined();
  });

  it("compact post-mutation race returns explicit partial view receipt", async () => {
    let healthy = true;
    let ready = true;
    let phase: "binding" | "ready" | "degraded" | "closed" = "ready";
    const runtime = baseRuntime({
      isCaptureHealthy: () => healthy,
      isCaptureReady: () => ready,
      capturePhase: phase,
      sdk: {
        threadView: {
          previewCompact: vi.fn(async () => ({ ok: true, value: { kind: "ok" } })),
          compact: vi.fn(async () => {
            healthy = false;
            ready = false;
            phase = "degraded";
            return {
              ok: true,
              value: {
                viewId: "v1",
                tailTokens: 1,
                totalTokens: 1,
                bands: {
                  smooth: { entries: 0, tokens: 0 },
                  detailed: { entries: 0, tokens: 0 },
                  brief: { entries: 0, tokens: 0 },
                },
              },
            };
          }),
          getSessionThreadView: vi.fn(async () => ({
            ok: true,
            value: { threadId: "th", entries: [] },
          })),
        },
      } as unknown as Lhc,
    });
    // Re-bind getters to live vars
    runtime.isCaptureHealthy = () => healthy;
    runtime.isCaptureReady = () => ready;
    Object.defineProperty(runtime, "capturePhase", { get: () => phase });
    Object.defineProperty(runtime, "captureDegraded", { get: () => !healthy });
    const outcome = await runCompactCommand("compact", runtime);
    expect(outcome.messages).toContain(CAPTURE_PARTIAL_VIEW_MUTATION);
    expect(outcome.restart).toBeUndefined();
  });

  it("prune post-mutation race returns explicit partial view receipt", async () => {
    let healthy = true;
    let ready = true;
    const runtime = baseRuntime({
      isCaptureHealthy: () => healthy,
      isCaptureReady: () => ready,
      sdk: {
        threadView: {
          prune: vi.fn(async () => {
            healthy = false;
            ready = false;
            return {
              ok: true,
              value: {
                previousBoundary: 0,
                newBoundary: 1,
                zoneTokensBefore: 10,
                zoneTokensAfter: 5,
                toolResultsPruned: 1,
                noOp: false,
              },
            };
          }),
          getSessionThreadView: vi.fn(async () => ({
            ok: true,
            value: { threadId: "th", entries: [] },
          })),
        },
      } as unknown as Lhc,
    });
    runtime.isCaptureHealthy = () => healthy;
    runtime.isCaptureReady = () => ready;
    const outcome = await runPruneCommand("prune", runtime);
    expect(outcome.messages).toContain(CAPTURE_PARTIAL_VIEW_MUTATION);
    expect(outcome.restart).toBeUndefined();
  });

  it("refuses when generation changes during mutation", async () => {
    let generation = 1;
    const runtime = baseRuntime({
      getCaptureGeneration: () => generation,
      captureGeneration: 1,
      sdk: {
        threadView: {
          previewCompact: vi.fn(async () => {
            generation = 2;
            return { ok: true, value: { kind: "ok" } };
          }),
          compact: vi.fn(async () => ({ ok: true, value: {} })),
          getSessionThreadView: vi.fn(async () => ({ ok: true, value: { threadId: "th", entries: [] } })),
        },
      } as unknown as Lhc,
    });
    const outcome = await runCompactCommand("compact", runtime);
    expect(outcome.messages).toContain(CAPTURE_DEGRADED_REFUSAL);
  });

  it("compact: post-lineage fence failure withholds relaunch guidance", async () => {
    let healthy = true;
    let ready = true;
    let phase: "binding" | "ready" | "degraded" | "closed" = "ready";
    const writeRebuilt = await import("../../src/rollout/write-rebuilt.js");
    const lineageDb = await import("../../src/intake/lineage-db.js");
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue({
      sessionId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      rolloutPath: "/tmp/rebuilt.jsonl",
      lineCount: 2,
      expectedReintakeLines: 2,
      replayedPrefixLines: 1,
      prefixBoundary: { kind: "verified", lineCount: 1, byteLength: 10, sha256: "cc".repeat(32) },
    });
    const lineageSpy = vi.spyOn(lineageDb, "safeRecordSessionThread").mockImplementation(async () => {
      healthy = false;
      ready = false;
      phase = "degraded";
      return { ok: true };
    });
    const runtime = baseRuntime({
      isCaptureHealthy: () => healthy,
      isCaptureReady: () => ready,
      sdk: {
        threadView: {
          previewCompact: vi.fn(async () => ({ ok: true, value: { kind: "ok" } })),
          compact: vi.fn(async () => ({
            ok: true,
            value: {
              viewId: "v1",
              tailTokens: 1,
              totalTokens: 1,
              bands: {
                smooth: { entries: 1, tokens: 4 },
                detailed: { entries: 0, tokens: 0 },
                brief: { entries: 0, tokens: 0 },
              },
            },
          })),
          getSessionThreadView: vi.fn(async () => ({
            ok: true,
            value: { threadId: "th", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
          })),
        },
      } as unknown as Lhc,
    });
    Object.defineProperty(runtime, "capturePhase", { get: () => phase });
    Object.defineProperty(runtime, "captureDegraded", { get: () => !healthy });
    const outcome = await runCompactCommand("compact", runtime);
    expect(outcome.messages).toContain(CAPTURE_PARTIAL_VIEW_MUTATION);
    expect(outcome.messages.join("\n")).toMatch(/reconciliation required/);
    expect(outcome.messages.join("\n")).not.toMatch(/relaunch with: cc-lhc --resume/);
    expect(outcome.restart).toBeUndefined();
    writeSpy.mockRestore();
    lineageSpy.mockRestore();
  });

  it("prune: post-lineage fence failure withholds relaunch guidance", async () => {
    let healthy = true;
    let ready = true;
    const writeRebuilt = await import("../../src/rollout/write-rebuilt.js");
    const lineageDb = await import("../../src/intake/lineage-db.js");
    vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue({
      sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      rolloutPath: "/tmp/pruned.jsonl",
      lineCount: 2,
      expectedReintakeLines: 2,
      replayedPrefixLines: 1,
      prefixBoundary: { kind: "verified", lineCount: 1, byteLength: 10, sha256: "dd".repeat(32) },
    });
    vi.spyOn(lineageDb, "safeRecordSessionThread").mockImplementation(async () => {
      healthy = false;
      ready = false;
      return { ok: true };
    });
    const runtime = baseRuntime({
      isCaptureHealthy: () => healthy,
      isCaptureReady: () => ready,
      sdk: {
        threadView: {
          prune: vi.fn(async () => ({
            ok: true,
            value: {
              previousBoundary: 0,
              newBoundary: 1,
              zoneTokensBefore: 10,
              zoneTokensAfter: 5,
              toolResultsPruned: 1,
              noOp: false,
            },
          })),
          getSessionThreadView: vi.fn(async () => ({
            ok: true,
            value: { threadId: "th", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
          })),
        },
      } as unknown as Lhc,
    });
    const outcome = await runPruneCommand("prune", runtime);
    expect(outcome.messages).toContain(CAPTURE_PARTIAL_VIEW_MUTATION);
    expect(outcome.messages.join("\n")).not.toMatch(/relaunch with: cc-lhc --resume/);
    vi.restoreAllMocks();
  });
});
