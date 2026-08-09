import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lhc, ThreadRef } from "lhc";
import { describe, expect, it, vi } from "vitest";

import { runCompactCommand } from "../../src/commands/compact.js";
import { runPruneCommand } from "../../src/commands/prune.js";
import {
  formatRebuildRelaunchGuidance,
  LINEAGE_REGISTRATION_FAILED,
} from "../../src/commands/rebuild-receipt.js";
import type { LhcCommandRuntime } from "../../src/commands/dispatch.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import * as lineageDb from "../../src/intake/lineage-db.js";

function makeRuntime(overrides: Partial<LhcCommandRuntime> = {}): LhcCommandRuntime {
  const threadRef = { threadId: "th_rebuild", registryPath: "/tmp/reg.sqlite" } as ThreadRef;
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

describe("manual compact/prune: no in-app resume injection", () => {
  it("compact registers lineage, returns relaunch guidance, never sets restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-compact-lineage-"));
    const lineageDbPath = join(home, "cc-lhc.sqlite");
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
    });
    const lineageSpy = vi.spyOn(lineageDb, "safeRecordSessionThread").mockResolvedValue({ ok: true });

    const runtime = makeRuntime({ lineageDbPath, cwd });
    const outcome = await runCompactCommand("compact", runtime);

    expect(outcome.restart).toBeUndefined();
    expect(writeSpy).toHaveBeenCalledOnce();
    expect(lineageSpy).toHaveBeenCalledWith(
      lineageDbPath,
      rebuiltId,
      "th_rebuild",
      expect.any(Function),
      expect.anything(),
      { prefix: expect.objectContaining({ kind: "verified", lineCount: 2 }) },
    );
    const guidance = formatRebuildRelaunchGuidance({
      operation: "compact",
      oldSessionId: "old-session-id",
      newSessionId: rebuiltId,
      threadId: "th_rebuild",
    });
    for (const line of guidance) {
      expect(outcome.messages).toContain(line);
    }
    expect(outcome.messages.join("\n")).not.toMatch(/resuming in-place/i);
    expect(outcome.messages.join("\n")).toContain(`cc-lhc --resume ${rebuiltId}`);

    writeSpy.mockRestore();
    lineageSpy.mockRestore();
  });

  it("compact fails closed when lineage registration fails", async () => {
    vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue({
      sessionId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      rolloutPath: "/tmp/rebuilt.jsonl",
      lineCount: 1,
      expectedReintakeLines: 1,
      replayedPrefixLines: 0,
      prefixBoundary: { kind: "verified", lineCount: 0, byteLength: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    });
    vi.spyOn(lineageDb, "safeRecordSessionThread").mockResolvedValue({
      ok: false,
      reason: "lineage_write:disk full",
    });

    const outcome = await runCompactCommand("compact", makeRuntime());
    expect(outcome.restart).toBeUndefined();
    expect(outcome.messages).toContain(LINEAGE_REGISTRATION_FAILED);
    expect(outcome.messages.join("\n")).not.toMatch(/relaunch with: cc-lhc --resume/);

    vi.restoreAllMocks();
  });

  it("prune registers lineage and never sets restart", async () => {
    const rebuiltId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue({
      sessionId: rebuiltId,
      rolloutPath: `/tmp/${rebuiltId}.jsonl`,
      lineCount: 2,
      expectedReintakeLines: 2,
      replayedPrefixLines: 1,
      prefixBoundary: { kind: "verified", lineCount: 1, byteLength: 20, sha256: "bb".repeat(32) },
    });
    const lineageSpy = vi.spyOn(lineageDb, "safeRecordSessionThread").mockResolvedValue({ ok: true });

    const outcome = await runPruneCommand("prune", makeRuntime());
    expect(outcome.restart).toBeUndefined();
    expect(lineageSpy).toHaveBeenCalled();
    expect(outcome.messages.join("\n")).toContain(`cc-lhc --resume ${rebuiltId}`);
    expect(outcome.messages.join("\n")).not.toMatch(/resuming in-place/i);

    vi.restoreAllMocks();
  });
});
