/**
 * LIM-80 Slice 2: RecoveryPort wiring in runContextMutation (command operation
 * only; the concrete store-backed port and run.ts replay are Slice 3).
 *
 * - Manual calls with no port are behaviorally unchanged.
 * - With a port, the write mock writes a real, structurally valid reserved
 *   JSONL file, and the callbacks fire in exact stage order with the reserved
 *   id/path passed through; the outcome is `rebuilt` only after a verified
 *   rollout_written.
 * - Negatives: unreadable baseline refuses before compact; a viewId mismatch
 *   after compact is partial with no reserve/write; a post-compact input fence
 *   is partial; malformed fresh output is partial with no rollout_written;
 *   a reserved-path mismatch is partial.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Lhc, ThreadRef } from "lhc";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ContextMutationPlan, runContextMutation } from "../../src/commands/context-mutation.js";
import type { LhcCommandRuntime } from "../../src/commands/dispatch.js";
import type { RecoveryPort, RolloutVerificationArtifacts } from "../../src/commands/recovery-ops.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-lhc-port-"));
  dirs.push(dir);
  return dir;
}

function storedView(viewId: string) {
  return {
    ok: true as const,
    value: {
      viewId,
      createdAt: "2026-08-17T00:00:00.000Z",
      compactPoint: 1,
      coveredFrom: 0,
      profileName: "continuation",
      config: { lowerBound: 200, percentages: {} },
      arrangement: [],
      gaps: [],
      sourceState: { maxEventOrder: 9, derivationCounts: {} },
      bands: [],
    },
  };
}

/**
 * `describeSeq` lets a test return different describe() values across calls
 * (baseline before compact, installed after compact).
 */
function sdkMock(opts: { installedViewId?: string; describeSeq?: Array<{ ok: true; value: unknown }> } = {}) {
  let describeCall = 0;
  const describe = vi.fn(async () => {
    if (opts.describeSeq) {
      const v = opts.describeSeq[Math.min(describeCall, opts.describeSeq.length - 1)];
      describeCall += 1;
      return v;
    }
    return opts.installedViewId ? storedView(opts.installedViewId) : { ok: true as const, value: null };
  });
  return {
    threadView: {
      status: vi.fn(async () => ({
        ok: true,
        value: {
          tailTokens: 10,
          threshold: 100,
          visibility: { zoneTokens: 0, maxTokens: 1000 },
          derivation: { pending: 0, failed: 0 },
        },
      })),
      previewCompact: vi.fn(async () => ({ ok: true, value: { kind: "ok" } })),
      compact: vi.fn(async () => ({
        ok: true,
        value: {
          viewId: opts.installedViewId ?? "v1",
          tailTokens: 5,
          totalTokens: 9,
          bands: {
            smooth: { entries: 1, tokens: 4 },
            detailed: { entries: 0, tokens: 0 },
            brief: { entries: 0, tokens: 0 },
          },
        },
      })),
      describe,
      getSessionThreadView: vi.fn(async () => ({
        ok: true,
        value: { threadId: "th_cm", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
      })),
    },
  };
}

function runtimeWith(sdk: ReturnType<typeof sdkMock>, overrides: Partial<LhcCommandRuntime> = {}): LhcCommandRuntime {
  return {
    captureDisabled: false,
    stats: { threadId: "th_cm" } as unknown as LhcCommandRuntime["stats"],
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
    ...overrides,
  };
}

const COMPACT_PLAN: ContextMutationPlan = {
  operation: "auto_compact",
  profile: "continuation",
  lowerBoundTokens: 240_000,
};

const STATIC_REBUILT = {
  sessionId: "abcdabcd-abcd-abcd-abcd-abcdabcdabcd",
  rolloutPath: "/tmp/rebuilt.jsonl",
  lineCount: 2,
  expectedReintakeLines: 2,
  replayedPrefixLines: 1,
  prefixBoundary: { kind: "verified" as const, lineCount: 1, byteLength: 10, sha256: "ab".repeat(32) },
  totalByteLength: 20,
};

/**
 * A write mock that writes a REAL, structurally valid reserved JSONL file so
 * verifyWrittenRollout passes: one prefix line + the trailing runtime-note
 * receipt, chained uuids, sessionId == reserved id.
 */
function realWriteMock(rolloutPath: string) {
  return vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async (input) => {
    const sessionId = input.newSessionId ?? STATIC_REBUILT.sessionId;
    const receiptText = input.receipt?.text ?? "";
    const prefix = {
      type: "user",
      uuid: "uuid-0",
      parentUuid: null,
      sessionId,
      message: { role: "user", content: "hello world" },
    };
    const receipt = {
      type: "user",
      uuid: "uuid-1",
      parentUuid: "uuid-0",
      sessionId,
      message: { role: "user", content: `[runtime note] ${receiptText}` },
    };
    const serialized = `${JSON.stringify(prefix)}\n${JSON.stringify(receipt)}\n`;
    await mkdir(dirname(rolloutPath), { recursive: true });
    await writeFile(rolloutPath, serialized, "utf8");
    const prefixSerialized = `${JSON.stringify(prefix)}\n`;
    return {
      sessionId,
      rolloutPath,
      lineCount: 2,
      expectedReintakeLines: 2,
      replayedPrefixLines: 1,
      prefixBoundary: {
        kind: "verified",
        lineCount: 1,
        byteLength: Buffer.byteLength(prefixSerialized),
        sha256: "unused",
      },
      totalByteLength: Buffer.byteLength(serialized),
    } as never;
  });
}

describe("runContextMutation RecoveryPort wiring (LIM-80 Slice 2)", () => {
  it("no port: no describe calls, no reserved newSessionId, unchanged rebuilt outcome", async () => {
    const sdk = sdkMock({ installedViewId: "v9" });
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(STATIC_REBUILT as never);
    const outcome = await runContextMutation(COMPACT_PLAN, runtimeWith(sdk));
    expect(outcome.kind).toBe("rebuilt");
    expect(sdk.threadView.describe).not.toHaveBeenCalled();
    expect(writeSpy.mock.calls[0]![0].newSessionId).toBeUndefined();
  });

  it("with port: real file write → callbacks fire baseline → installed → reserve → rollout_written; reserved id/path pass through; rebuilt", async () => {
    const dir = tempDir();
    const reservedSessionId = "reserved-1111";
    const rolloutPath = join(dir, "projects", "proj", `${reservedSessionId}.jsonl`);
    const sdk = sdkMock({ installedViewId: "v9" });
    realWriteMock(rolloutPath);

    const calls: string[] = [];
    let recorded: RolloutVerificationArtifacts | undefined;
    const port: RecoveryPort = {
      recordBaseline: (fp) => calls.push(`baseline:${fp}`),
      recordViewInstalled: (a) => calls.push(`installed:${a.viewId}`),
      reserveRebuiltSession: (receipt) => {
        calls.push(`reserve:${receipt.slice(0, 6)}`);
        return { sessionId: reservedSessionId, rolloutPath };
      },
      recordRolloutWritten: (v) => {
        calls.push("rollout_written");
        recorded = v;
      },
    };
    const outcome = await runContextMutation(COMPACT_PLAN, runtimeWith(sdk), port);
    expect(outcome.kind).toBe("rebuilt");
    expect(calls[0]).toMatch(/^baseline:/);
    expect(calls[1]).toBe("installed:v9");
    expect(calls[2]).toMatch(/^reserve:/);
    expect(calls[3]).toBe("rollout_written");
    expect(recorded?.rebuiltSessionId).toBe(reservedSessionId);
    expect(recorded?.rebuiltRolloutPath).toBe(rolloutPath);
    expect(recorded?.rolloutFullSha256).toHaveLength(64);
    if (outcome.kind === "rebuilt") expect(outcome.handoff.rebuilt.sessionId).toBe(reservedSessionId);
  });

  it("with port: unreadable baseline refuses BEFORE preview/compact", async () => {
    const sdk = sdkMock({ describeSeq: [{ ok: false as unknown as true, value: undefined }] });
    // First describe (baseline) fails.
    sdk.threadView.describe = vi.fn(async () => ({ ok: false as const, error: { reason: "db busy" } })) as never;
    const previewSpy = sdk.threadView.previewCompact;
    const compactSpy = sdk.threadView.compact;
    const port: RecoveryPort = {
      recordBaseline: vi.fn(),
      recordViewInstalled: vi.fn(),
      reserveRebuiltSession: vi.fn(() => ({ sessionId: "x", rolloutPath: "/x" })),
      recordRolloutWritten: vi.fn(),
    };
    const outcome = await runContextMutation(COMPACT_PLAN, runtimeWith(sdk), port);
    expect(outcome.kind).toBe("refused");
    expect(previewSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    expect(port.recordBaseline).not.toHaveBeenCalled();
  });

  it("with port: installed-view id mismatch after compact → partial, no reserve/write", async () => {
    // baseline returns none; after-compact describe returns a DIFFERENT viewId than the compact receipt.
    const sdk = sdkMock({ installedViewId: "v9", describeSeq: [{ ok: true, value: null }, storedView("v-other")] });
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout");
    const port: RecoveryPort = {
      recordBaseline: vi.fn(),
      recordViewInstalled: vi.fn(),
      reserveRebuiltSession: vi.fn(() => ({ sessionId: "x", rolloutPath: "/x" })),
      recordRolloutWritten: vi.fn(),
    };
    const outcome = await runContextMutation(COMPACT_PLAN, runtimeWith(sdk), port);
    expect(outcome.kind).toBe("partial");
    expect(port.recordViewInstalled).not.toHaveBeenCalled();
    expect(port.reserveRebuiltSession).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("with port: post-compact input fence → partial, no reserve/rollout_written", async () => {
    const sdk = sdkMock({ installedViewId: "v9" });
    let inputArrived = false;
    const calls: string[] = [];
    const port: RecoveryPort = {
      recordBaseline: () => calls.push("baseline"),
      recordViewInstalled: () => {
        calls.push("installed");
        inputArrived = true;
      },
      reserveRebuiltSession: () => {
        calls.push("reserve");
        return { sessionId: "x", rolloutPath: "/x" };
      },
      recordRolloutWritten: () => calls.push("rollout_written"),
    };
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue(STATIC_REBUILT as never);
    const outcome = await runContextMutation(
      { ...COMPACT_PLAN, inputEpochChanged: () => inputArrived },
      runtimeWith(sdk),
      port,
    );
    expect(outcome.kind).toBe("partial");
    expect(calls).toContain("installed");
    expect(calls).not.toContain("reserve");
    expect(calls).not.toContain("rollout_written");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("with port: malformed fresh output → partial, no rollout_written, no handoff", async () => {
    const sdk = sdkMock({ installedViewId: "v9" });
    // write returns a path to a file that is NOT structurally valid (wrong session id in it).
    const dir = tempDir();
    const rolloutPath = join(dir, "bad.jsonl");
    vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async () => {
      const bad = {
        type: "user",
        uuid: "u0",
        parentUuid: null,
        sessionId: "SOMEONE-ELSE",
        message: { role: "user", content: "[runtime note] r" },
      };
      await writeFile(rolloutPath, `${JSON.stringify(bad)}\n`, "utf8");
      return { ...STATIC_REBUILT, sessionId: "reserved-2222", rolloutPath } as never;
    });
    const recordRolloutWritten = vi.fn();
    const port: RecoveryPort = {
      recordBaseline: vi.fn(),
      recordViewInstalled: vi.fn(),
      reserveRebuiltSession: () => ({ sessionId: "reserved-2222", rolloutPath }),
      recordRolloutWritten,
    };
    const outcome = await runContextMutation(COMPACT_PLAN, runtimeWith(sdk), port);
    expect(outcome.kind).toBe("partial");
    expect(recordRolloutWritten).not.toHaveBeenCalled();
  });

  it("with port: reserved-path mismatch after write → partial, no rollout_written", async () => {
    const sdk = sdkMock({ installedViewId: "v9" });
    vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue({
      ...STATIC_REBUILT,
      rolloutPath: "/actual/written/path.jsonl",
    } as never);
    const recordRolloutWritten = vi.fn();
    const port: RecoveryPort = {
      recordBaseline: vi.fn(),
      recordViewInstalled: vi.fn(),
      reserveRebuiltSession: () => ({
        sessionId: STATIC_REBUILT.sessionId,
        rolloutPath: "/reserved/different/path.jsonl",
      }),
      recordRolloutWritten,
    };
    const outcome = await runContextMutation(COMPACT_PLAN, runtimeWith(sdk), port);
    expect(outcome.kind).toBe("partial");
    expect(recordRolloutWritten).not.toHaveBeenCalled();
    if (outcome.kind === "partial")
      expect(outcome.messages.some((m) => m.includes("does not equal reserved"))).toBe(true);
  });
});
