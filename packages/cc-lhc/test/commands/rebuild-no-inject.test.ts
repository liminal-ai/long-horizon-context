import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lhc, ThreadRef } from "lhc";
import { describe, expect, it, vi } from "vitest";

import { runCompactCommand } from "../../src/commands/compact.js";
import { runPruneCommand } from "../../src/commands/prune.js";
import type { LhcCommandRuntime } from "../../src/commands/dispatch.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import * as lineageDb from "../../src/intake/lineage-db.js";

function makeRuntime(overrides: Partial<LhcCommandRuntime> = {}): LhcCommandRuntime {
  const threadRef = { threadId: "th_rebuild", registryPath: "/tmp/reg.sqlite" } as ThreadRef;
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
      threadId: "th_rebuild",
    },
    sdk: {
      threadView: {
        previewCompact: vi.fn(async () => ({ ok: true, value: { kind: "ok" } })),
        compact: vi.fn(async () => ({
          ok: true,
          value: {
            viewId: "v9",
            tailTokens: 10,
            totalTokens: 20,
            bands: {
              smooth: { entries: 1, tokens: 5 },
              detailed: { entries: 0, tokens: 0 },
              brief: { entries: 0, tokens: 0 },
            },
          },
        })),
        prune: vi.fn(async () => ({
          ok: true,
          value: {
            previousBoundary: 0,
            newBoundary: 1,
            zoneTokensBefore: 50,
            zoneTokensAfter: 10,
            toolResultsPruned: 2,
            noOp: false,
          },
        })),
        getSessionThreadView: vi.fn(async () => ({
          ok: true,
          value: {
            threadId: "th_rebuild",
            entries: [{ role: "user", content: "hi", sourceMessages: [] }],
          },
        })),
      },
    } as unknown as Lhc,
    threadRef,
    cwd: "/work/rebuild",
    sourceRolloutPath: undefined,
    sourceSessionId: "old-session-id",
    isTurnOpen: () => false,
    isCaptureHealthy: () => true,
    isCaptureReady: () => true,
    getCaptureGeneration: () => 1,
    captureGeneration: 1,
    capturePhase: "ready",
    ...overrides,
  };
}

describe("manual compact/prune: wrapper-owned handoff, success-only lineage", () => {
  it("compact returns a handoff request and writes NO lineage at rebuild time", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-compact-proj-"));
    const cwd = "/work/rebuild";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });

    const rebuiltId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue({
      sessionId: rebuiltId,
      rolloutPath: join(projectsRoot, encodeProjectPath(cwd), `${rebuiltId}.jsonl`),
      lineCount: 3,
      expectedReintakeLines: 3,
      replayedPrefixLines: 2,
      prefixBoundary: { kind: "verified", lineCount: 2, byteLength: 40, sha256: "aa".repeat(32) },
      totalByteLength: 100,
    });
    const lineageSpy = vi.spyOn(lineageDb, "safeRecordSessionThread").mockResolvedValue({ ok: true });

    const runtime = makeRuntime({ cwd });
    const outcome = await runCompactCommand("compact", runtime);

    expect(outcome.restart).toBeUndefined();
    expect(writeSpy).toHaveBeenCalledOnce();
    // Success-only lineage: nothing is persisted before the replacement is
    // proven ready-after-replay (the wrapper registers it post-proof).
    expect(lineageSpy).not.toHaveBeenCalled();
    expect(outcome.handoff).toBeDefined();
    expect(outcome.handoff?.operation).toBe("compact");
    expect(outcome.handoff?.oldSessionId).toBe("old-session-id");
    expect(outcome.handoff?.threadId).toBe("th_rebuild");
    expect(outcome.handoff?.rebuilt.sessionId).toBe(rebuiltId);
    expect(outcome.messages.join("\n")).not.toMatch(/resuming in-place/i);
    expect(outcome.messages.join("\n")).toContain("handing off");

    writeSpy.mockRestore();
    lineageSpy.mockRestore();
  });

  it("retries the rebuild, then keeps the installed view with no handoff when every attempt throws", async () => {
    const writeSpy = vi
      .spyOn(writeRebuilt, "writeRebuiltRollout")
      .mockRejectedValue(new Error("disk full"));
    const lineageSpy = vi.spyOn(lineageDb, "safeRecordSessionThread").mockResolvedValue({ ok: true });

    const outcome = await runCompactCommand("compact", makeRuntime());
    expect(outcome.restart).toBeUndefined();
    expect(outcome.handoff).toBeUndefined();
    expect(outcome.messages.join("\n")).toMatch(/rebuilt rollout not written after \d+ attempts/);
    expect(outcome.messages.join("\n")).toMatch(/disk full/);
    // Forward-only: the compact stays installed and the next seam re-materializes.
    expect(outcome.messages.join("\n")).toMatch(/LHC view is installed and durable/);
    expect(lineageSpy).not.toHaveBeenCalled();

    writeSpy.mockRestore();
    lineageSpy.mockRestore();
  });

  it("prune returns a handoff request and writes no lineage", async () => {
    const rebuiltId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue({
      sessionId: rebuiltId,
      rolloutPath: `/tmp/${rebuiltId}.jsonl`,
      lineCount: 2,
      expectedReintakeLines: 2,
      replayedPrefixLines: 1,
      prefixBoundary: { kind: "verified", lineCount: 1, byteLength: 20, sha256: "bb".repeat(32) },
      totalByteLength: 100,
    });
    const lineageSpy = vi.spyOn(lineageDb, "safeRecordSessionThread").mockResolvedValue({ ok: true });

    const outcome = await runPruneCommand("prune", makeRuntime());
    expect(outcome.restart).toBeUndefined();
    expect(lineageSpy).not.toHaveBeenCalled();
    expect(outcome.handoff?.operation).toBe("prune");
    expect(outcome.handoff?.rebuilt.sessionId).toBe(rebuiltId);
    expect(outcome.messages.join("\n")).not.toMatch(/resuming in-place/i);

    writeSpy.mockRestore();
    lineageSpy.mockRestore();
  });

  it("prune no-op mutates nothing and hands nothing off", async () => {
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout");
    const runtime = makeRuntime({
      sdk: {
        threadView: {
          prune: vi.fn(async () => ({
            ok: true,
            value: {
              previousBoundary: 3,
              newBoundary: 3,
              zoneTokensBefore: 5,
              zoneTokensAfter: 5,
              toolResultsPruned: 0,
              noOp: true,
            },
          })),
        },
      } as unknown as Lhc,
    });
    const outcome = await runPruneCommand("prune", runtime);
    expect(outcome.handoff).toBeUndefined();
    expect(outcome.messages.join("\n")).toMatch(/no-op/);
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});
