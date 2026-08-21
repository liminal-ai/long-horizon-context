/**
 * LIM-116 handoff integration: TC-5.3d-e, AR-5, AR-8, automatic cleanup surfaces.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Lhc, ThreadRef } from "lhc";

import {
  runContextMutation,
  type ContextMutationPlan,
} from "../../src/commands/context-mutation.js";
import type { LhcCommandRuntime } from "../../src/commands/dispatch.js";
import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import { mapRolloutLine } from "../../src/intake/map.js";
import * as replayDedupe from "../../src/intake/replay-dedupe.js";
import { createReplayDedupeState, eventContentSignature } from "../../src/intake/replay-dedupe.js";
import type { OpenAsyncWork } from "../../src/observation/async-work.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import type { ProcessLivenessResult } from "../../src/runtime/process-identity.js";
import { emptyCaptureStats } from "../../src/stats.js";
import {
  executeHandoff,
  type CandidateChild,
  type CandidateViability,
  type HandoffPorts,
  type HandoffResult,
  type SwitchOutcome,
} from "../../src/wrapper/handoff.js";
import { openHandoffReceiptStore } from "../../src/wrapper/handoff-receipt-store.js";
import { formatOldChildCleanup, type OldChildCleanup } from "../../src/wrapper/old-child-cleanup.js";
import { run } from "../../src/wrapper/run.js";

const captureMocks = vi.hoisted(() => ({
  factory: null as ((opts: CaptureSessionDeps) => CaptureSession) | null,
}));

vi.mock("../../src/intake/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intake/session.js")>();
  return {
    ...actual,
    startCaptureSession: (opts: CaptureSessionDeps = {}) => {
      if (captureMocks.factory !== null) return captureMocks.factory(opts);
      return actual.startCaptureSession(opts);
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  captureMocks.factory = null;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function work(family: OpenAsyncWork["family"], description: string, taskId?: string): OpenAsyncWork {
  return { key: taskId ?? family, family, description, ...(taskId === undefined ? {} : { taskId }) };
}

function runtimeWith(
  sdk: unknown,
  getLiveAsyncWork: () => OpenAsyncWork[],
): LhcCommandRuntime {
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
      threadId: "th_int",
    },
    sdk: sdk as Lhc,
    threadRef: { threadId: "th_int", registryPath: "/tmp/r.sqlite" } as ThreadRef,
    cwd: "/work/int",
    sourceRolloutPath: "/tmp/old-session.jsonl",
    sourceSessionId: "old-session",
    isTurnOpen: () => false,
    isCaptureHealthy: () => true,
    isCaptureReady: () => true,
    getCaptureGeneration: () => 1,
    captureGeneration: 1,
    capturePhase: "ready",
    getLiveAsyncWork,
  };
}

function sdkMock(onCompact?: () => void, onPrune?: () => void) {
  return {
    threadView: {
      status: vi.fn(async () => ({
        ok: true,
        value: { tailTokens: 10, threshold: 100, visibility: { zoneTokens: 0, maxTokens: 1000 }, derivation: { pending: 0, failed: 0 } },
      })),
      prune: vi.fn(async () => {
        onPrune?.();
        return {
          ok: true,
          value: {
            previousBoundary: 0,
            newBoundary: 2,
            zoneTokensBefore: 50,
            zoneTokensAfter: 10,
            toolResultsPruned: 1,
            noOp: false,
          },
        };
      }),
      previewCompact: vi.fn(async () => ({ ok: true, value: { kind: "ok" } })),
      compact: vi.fn(async () => {
        onCompact?.();
        return {
          ok: true,
          value: {
            viewId: "v1",
            tailTokens: 5,
            totalTokens: 9,
            bands: { smooth: { entries: 1, tokens: 4 }, detailed: { entries: 0, tokens: 0 }, brief: { entries: 0, tokens: 0 } },
          },
        };
      }),
      getSessionThreadView: vi.fn(async () => ({
        ok: true,
        value: { threadId: "th_int", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
      })),
    },
  };
}

const VIABLE: CandidateViability = {
  kind: "viable",
  evidence: { processAlive: true, sessionFileWritten: true },
};

function ports(overrides: Partial<HandoffPorts> = {}): HandoffPorts & { calls: string[]; writes: string[] } {
  const calls: string[] = [];
  const writes: string[] = [];
  const child = {
    write(data: string) {
      writes.push(data);
    },
  };
  const base: HandoffPorts = {
    preHandoffStop: () => null,
    spawnCandidate: (sessionId): CandidateChild => {
      calls.push(`spawn:${sessionId}`);
      return { sessionId, pid: 88, child };
    },
    awaitCandidateViable: async () => VIABLE,
    discardCandidate: async () => {
      calls.push("discard");
    },
    switchToCandidate: (): SwitchOutcome => {
      calls.push("switch");
      return { switched: true, captureStarted: true };
    },
    killOldChild: async () => {
      calls.push("kill");
      return { kind: "terminated", pid: 11 };
    },
    awaitReplacementCaptureReady: async () => "ready",
    reconcileCapture: () => {},
    registerSuccessLineage: async () => ({ ok: true }),
    publishReadyDescriptor: () => true,
    log: () => {},
    warn: () => {},
    ...overrides,
  };
  return Object.assign(base, { calls, writes });
}

describe("TC-5.3d resume and replay do not duplicate the note", () => {
  it("resume/replay preserves existing note and receipt without emitting new events", async () => {
    const live = [work("agent", "reviewer", "a1")];
    const sdk = sdkMock();
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-cont-int-"));
    dirs.push(root);
    const projectsRoot = join(root, "projects");
    mkdirSync(join(projectsRoot, encodeProjectPath("/work/int")), { recursive: true });
    const dbPath = join(root, "cc-lhc.sqlite");
    const store = openHandoffReceiptStore(dbPath);
    vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue({
      sessionId: "new-tmp",
      rolloutPath: "/tmp/new-tmp.jsonl",
      lineCount: 2,
      expectedReintakeLines: 2,
      replayedPrefixLines: 1,
      prefixBoundary: { kind: "verified", lineCount: 1, byteLength: 10, sha256: "ab".repeat(32) },
      totalByteLength: 20,
    });
    const outcome = await runContextMutation(
      { operation: "compact", profile: "continuation", lowerBoundTokens: 100 },
      { ...runtimeWith(sdk, () => live), cwd: "/work/int" },
    );
    expect(outcome.kind).toBe("rebuilt");
    if (outcome.kind !== "rebuilt") return;
    vi.mocked(writeRebuilt.writeRebuiltRollout).mockRestore();
    const rebuilt = await writeRebuilt.writeRebuiltRollout({
      view: { threadId: "th_int", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
      cwd: "/work/int",
      projectsRoot,
      newSessionId: "resume-1",
      receipt: { text: outcome.handoff.durableReceipt },
    });
    const lines = readFileSync(rebuilt.rolloutPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as RolloutLineItem);
    const noteLines = lines.filter((line) => String(line.message?.content ?? "").includes("[runtime note]"));
    expect(noteLines).toHaveLength(1);
    expect(rebuilt.replayedPrefixLines).toBe(rebuilt.lineCount - 1);

    const mapped = mapRolloutLine(noteLines[0]!, lines.length - 1);
    const filterSpy = vi.spyOn(replayDedupe, "filterReplayEvents");
    const firstState = createReplayDedupeState(true, []);
    const first = replayDedupe.filterReplayEvents(mapped.events, firstState);
    const expectedSignatures = mapped.events.map((event) => eventContentSignature(event));
    expect(first.toSend.filter((event) => event.eventKind === "runtime_note")).toHaveLength(1);
    expect(first.toSend).toHaveLength(mapped.events.length);
    expect(first.skipped).toBe(0);
    expect(first.signaturesToAdd).toEqual(expectedSignatures);
    expect(expectedSignatures.length).toBeGreaterThan(0);

    const insertedIds: string[] = [];
    const origInsert = store.insertPrepared.bind(store);
    store.insertPrepared = (row) => {
      insertedIds.push(row.handoffId);
      return origInsert(row);
    };

    const p = ports();
    const firstHandoff = await executeHandoff(outcome.handoff, p, {
      uuidFn: () => "h-resume",
      handoffReceipts: store,
    });
    expect(firstHandoff.kind).toBe("success");
    expect(p.calls.filter((c) => c.startsWith("spawn:"))).toHaveLength(1);
    expect(insertedIds).toEqual(["h-resume"]);
    expect(store.listAll()).toHaveLength(1);
    store.close();

    const resumeState = createReplayDedupeState(true, first.signaturesToAdd);
    const replayed = replayDedupe.filterReplayEvents(mapped.events, resumeState);
    expect(replayed.toSend.filter((event) => event.eventKind === "runtime_note")).toHaveLength(0);
    expect(replayed.toSend).toHaveLength(0);
    expect(replayed.skipped).toBe(mapped.events.length);
    expect(replayed.signaturesToAdd).toEqual([]);
    expect(filterSpy).toHaveBeenCalledTimes(2);
    expect(filterSpy.mock.calls[0]?.[0]).toEqual(mapped.events);
    expect(filterSpy.mock.calls[1]?.[0]).toEqual(mapped.events);
    expect(filterSpy.mock.results[0]?.value).toMatchObject({
      toSend: first.toSend,
      signaturesToAdd: expectedSignatures,
    });
    expect(filterSpy.mock.results[1]?.value).toMatchObject({ toSend: [], skipped: mapped.events.length });

    const reopened = openHandoffReceiptStore(dbPath);
    const origReopenInsert = reopened.insertPrepared.bind(reopened);
    reopened.insertPrepared = (row) => {
      insertedIds.push(row.handoffId);
      return origReopenInsert(row);
    };
    expect(insertedIds, "replay inserted a second handoff receipt").toEqual(["h-resume"]);
    expect(reopened.listAll()).toHaveLength(1);
    expect(reopened.listAll().map((row) => row.handoffId)).toEqual(["h-resume"]);
    expect(reopened.readBack("h-resume")?.cleanupKind).toBe("terminated");
    reopened.close();
  });
});

describe("TC-5.3e failed handoff has no success outcome", () => {
  it("rejected candidate never activates its note or emits a success cleanup outcome", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-fail-h-"));
    dirs.push(dir);
    const dbPath = join(dir, "cc-lhc.sqlite");
    const store = openHandoffReceiptStore(dbPath);
    const live = [work("agent", "reviewer", "a1")];
    const sdk = sdkMock();
    vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue({
      sessionId: "cand-1",
      rolloutPath: "/tmp/cand-1.jsonl",
      lineCount: 2,
      expectedReintakeLines: 2,
      replayedPrefixLines: 1,
      prefixBoundary: { kind: "verified", lineCount: 1, byteLength: 10, sha256: "ab".repeat(32) },
      totalByteLength: 20,
    });
    const outcome = await runContextMutation(
      { operation: "auto_compact", profile: "continuation", lowerBoundTokens: 100, liveAsyncWork: live },
      runtimeWith(sdk, () => live),
    );
    expect(outcome.kind).toBe("rebuilt");
    if (outcome.kind !== "rebuilt") return;
    expect(outcome.handoff.durableReceipt).toContain("reviewer");

    const p = ports({
      awaitCandidateViable: async () => ({
        kind: "exited",
        evidence: { processAlive: false, sessionFileWritten: false },
      }),
    });
    const result = await executeHandoff(outcome.handoff, p, {
      handoffReceipts: store,
      uuidFn: () => "h-fail",
      replacementAttempts: 1,
    });
    expect(result.kind).toBe("replacement_nonviable");
    expect(p.calls).not.toContain("switch");
    expect(p.calls).not.toContain("kill");
    const row = store.readBack("h-fail");
    expect(row?.terminalDisposition).toBe("failed_before_switch");
    expect(row?.cleanupKind).toBeNull();
    expect(p.writes).toEqual([]);
    store.close();
  });
});

describe("AR-5 interactive manual snapshot", () => {
  it("interactive manual compact and prune always freeze getLiveAsyncWork() at final settled seam", async () => {
    vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async (_input) => ({
      sessionId: "new-manual",
      rolloutPath: "/tmp/new-manual.jsonl",
      lineCount: 2,
      expectedReintakeLines: 2,
      replayedPrefixLines: 1,
      prefixBoundary: { kind: "verified", lineCount: 1, byteLength: 10, sha256: "ab".repeat(32) },
      totalByteLength: 20,
    }));
    for (const operation of ["compact", "prune"] as const) {
      let live: OpenAsyncWork[] = [work("agent", "seam-work", "a1")];
      const sdk = sdkMock(
        () => {
          live = [work("monitor", "late-work", "m1")];
        },
        () => {
          live = [work("monitor", "late-work", "m1")];
        },
      );
      const plan: ContextMutationPlan =
        operation === "compact"
          ? { operation, profile: "continuation", lowerBoundTokens: 100 }
          : { operation, profile: "continuation", lowerBoundTokens: 100, manualPruneTargetTokens: 50 };
      const outcome = await runContextMutation(plan, runtimeWith(sdk, () => live));
      expect(outcome.kind, operation).toBe("rebuilt");
      if (outcome.kind !== "rebuilt") continue;
      expect(outcome.handoff.liveAsyncWork.map((item) => item.description)).toEqual(["seam-work"]);
      expect(outcome.handoff.durableReceipt).toContain("seam-work");
      expect(outcome.handoff.durableReceipt).not.toContain("late-work");
      expect(outcome.handoff.operation).toBe(operation);
    }
  });
});

describe("AR-8 one trailing runtime note and no injection/rewrite/second replacement", () => {
  it("continuity adds one trailing runtime note and never PTY-injects, rewrites active rollout, or launches another replacement", async () => {
    const live = [work("agent", "reviewer", "a1"), work("background_shell", "build", "b1")];
    const sdk = sdkMock();
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-ar8-"));
    dirs.push(root);
    const sourcePath = join(root, "old-session.jsonl");
    const sourceBytes = Buffer.from('{"type":"user","message":{"role":"user","content":"live source"}}\n');
    writeFileSync(sourcePath, sourceBytes);

    let launched = false;
    const postLaunchWrites: string[] = [];
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async (input) => {
      if (launched) {
        postLaunchWrites.push(input.sourceRolloutPath ?? input.cwd);
      }
      expect(input.receipt?.text.split("[lhc compact:manual]")).toHaveLength(2);
      expect(input.receipt?.text).toContain("Smart Compact rebuilt this session.");
      expect(input.receipt?.text).toContain("reviewer");
      expect(input.cwd).toBe("/work/int");
      return {
        sessionId: "new-2222",
        rolloutPath: join(root, "new-2222.jsonl"),
        lineCount: 2,
        expectedReintakeLines: 2,
        replayedPrefixLines: 1,
        prefixBoundary: { kind: "verified", lineCount: 1, byteLength: 10, sha256: "ab".repeat(32) },
        totalByteLength: 20,
      };
    });
    const outcome = await runContextMutation(
      { operation: "compact", profile: "continuation", lowerBoundTokens: 100 },
      { ...runtimeWith(sdk, () => live), sourceRolloutPath: sourcePath },
    );
    expect(outcome.kind).toBe("rebuilt");
    if (outcome.kind !== "rebuilt") return;
    expect(writeSpy).toHaveBeenCalledOnce();
    expect(outcome.handoff.durableReceipt.match(/\[runtime note\]/g) ?? []).toHaveLength(0);
    expect(outcome.handoff.durableReceipt).toContain("[lhc compact:manual]");
    expect(outcome.handoff.durableReceipt).toContain("reviewer");
    const sourceBeforeLaunch = readFileSync(sourcePath);

    const p = ports({
      spawnCandidate: (sessionId) => {
        launched = true;
        p.calls.push(`spawn:${sessionId}`);
        return { sessionId, pid: 88, child: { write: (data: string) => p.writes.push(data) } };
      },
    });
    const result = await executeHandoff(outcome.handoff, p);
    expect(result.kind).toBe("success");
    expect(launched).toBe(true);
    expect(p.calls.filter((c) => c.startsWith("spawn:"))).toEqual(["spawn:new-2222"]);
    expect(p.calls.indexOf("spawn:new-2222")).toBeLessThan(p.calls.indexOf("switch"));
    expect(p.calls.indexOf("switch")).toBeLessThan(p.calls.indexOf("kill"));
    expect(p.writes).toEqual([]);
    expect(p.calls).not.toContain("discard");
    expect(postLaunchWrites).toEqual([]);
    expect(readFileSync(sourcePath).equals(sourceBeforeLaunch)).toBe(true);
    expect(readFileSync(sourcePath).equals(sourceBytes)).toBe(true);
  });
});

describe("automatic Smart Compact exposes cleanup once on a user-visible surface", () => {
  const REBUILT_ID = "12345678-1234-1234-1234-123456789abc";
  /** Valid Claude session UUID so resolveLaunchSession takes the explicit resume seam. */
  const LAUNCH_SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
  const POLICY = {
    policy: {
      autoCompact: true,
      lowerBoundTokens: 1_000,
      upperBoundTokens: 5_000,
      profile: "continuation",
      pruneEnabled: false,
      pruneThresholdTokens: null,
      pruneTargetTokens: null,
      minRunwayTokens: 100,
    },
    sources: Object.fromEntries(
      [
        "autoCompact",
        "lowerBoundTokens",
        "upperBoundTokens",
        "profile",
        "pruneEnabled",
        "pruneThresholdTokens",
        "pruneTargetTokens",
        "minRunwayTokens",
      ].map((k) => [k, "session"]),
    ) as never,
    fallbacks: [],
  };
  const BOUND_SIGNALS: LifecycleSignal[] = [{ kind: "session_bound", sessionId: "old-session" }];
  const TRIGGER_SIGNALS: LifecycleSignal[] = [
    { kind: "turn_opened", reason: "user_prompt" },
    {
      kind: "sampling_observed",
      samplingId: "req:r1",
      providerUsage: { input_tokens: 2, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 3_000 },
    },
    { kind: "turn_settled", reason: "end_turn" },
  ];

  function fakeStream(isTTY: boolean): NodeJS.ReadStream & NodeJS.WriteStream {
    const stream = new PassThrough() as unknown as NodeJS.ReadStream & NodeJS.WriteStream;
    Object.defineProperty(stream, "isTTY", { value: isTTY, configurable: true });
    Object.defineProperty(stream, "columns", { value: 200, configurable: true });
    Object.defineProperty(stream, "rows", { value: 40, configurable: true });
    if (isTTY) {
      (stream as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};
    }
    return stream;
  }

  async function waitFor(
    condition: () => boolean,
    label: string,
    running: Promise<number>,
    diagnostics: () => string,
    capMs = 8_000,
  ): Promise<void> {
    const start = Date.now();
    let settled: { status: "returned"; code: number } | { status: "rejected"; cause: unknown } | undefined;
    const seen = running.then(
      (code) => {
        settled = { status: "returned", code };
      },
      (cause: unknown) => {
        settled = { status: "rejected", cause };
      },
    );
    while (!condition()) {
      if (settled !== undefined) {
        const extra = diagnostics().trim();
        if (settled.status === "rejected") {
          const detail =
            settled.cause instanceof Error ? (settled.cause.stack ?? settled.cause.message) : String(settled.cause);
          throw new Error(`wrapper rejected while waiting for ${label}: ${detail}${extra ? `; ${extra}` : ""}`);
        }
        throw new Error(
          `wrapper returned ${settled.code} while waiting for ${label}${extra ? `; ${extra}` : ""}`,
        );
      }
      if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    void seen;
  }

  async function runAutomatic(kind: OldChildCleanup["kind"]): Promise<{
    result: HandoffResult;
    terminalOutput: string;
    logLines: string[];
    childWrites: string;
    runPromise: Promise<number>;
    spawned: Array<{ fireExit: (code: number) => void }>;
    restoreHome: () => void;
  }> {
    const autoExit = kind === "terminated";
    const spawned: Array<{
      pid: number;
      args: string[];
      writes: string[];
      fireExit: (code: number) => void;
      kill: (signal?: string) => void;
    }> = [];
    const sdk = sdkMock();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-auto-clean-"));
    dirs.push(rolloutDir);
    const rebuiltPath = join(rolloutDir, `${REBUILT_ID}.jsonl`);
    vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async () => {
      writeFileSync(rebuiltPath, '{"line":1}\n');
      return {
        sessionId: REBUILT_ID,
        rolloutPath: rebuiltPath,
        lineCount: 1,
        expectedReintakeLines: 1,
        replayedPrefixLines: 0,
        prefixBoundary: { kind: "verified", lineCount: 0, byteLength: 0, sha256: "aa".repeat(32) },
        totalByteLength: 10,
      };
    });
    captureMocks.factory = (opts) => {
      const generation = 1;
      const isRebuilt = opts.knownRolloutPath !== undefined;
      const stats = { ...emptyCaptureStats(), threadId: "th_auto" };
      const session = {
        stats,
        getCommandContext: () => ({
          stats,
          sdk: sdk as unknown as Lhc,
          threadRef: { threadId: "th_auto", registryPath: "/tmp/reg.sqlite" },
          captureDegraded: false,
          captureGeneration: generation,
          capturePhase: "ready" as const,
        }),
        getRolloutInfo: () => ({
          path: isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
          sessionId: isRebuilt ? REBUILT_ID : "old-session",
        }),
        isTurnOpen: () => false,
        isCaptureHealthy: () => true,
        isCaptureReady: () => true,
        getCaptureHealth: () => ({
          generation,
          phase: "ready" as const,
          reasons: [],
          reasonCounts: {},
          durableLineOffset: 0,
        }),
        getCaptureGeneration: () => generation,
        getLiveAsyncWork: () => [],
        stop: vi.fn(async () => {}),
      } as unknown as CaptureSession;
      if (!isRebuilt && opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const logLines: string[] = [];
    const results: HandoffResult[] = [];
    const stdin = fakeStream(true);
    const stdout = fakeStream(true);
    const stderr = fakeStream(false);
    let terminalOutput = "";
    let stderrText = "";
    (stdout as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      terminalOutput += chunk.toString("utf8");
    });
    (stderr as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-auto-home-"));
    dirs.push(home);
    const savedHome = process.env.CC_LHC_HOME;
    process.env.CC_LHC_HOME = home;
    const diagnostics = (): string => {
      const parts: string[] = [];
      if (stderrText.trim() !== "") parts.push(`stderr: ${stderrText.trim()}`);
      if (logLines.length > 0) parts.push(`log: ${logLines.join(" | ")}`);
      return parts.join("; ");
    };

    const probe = (pid: number): ProcessLivenessResult =>
      kind === "unknown"
        ? { ok: false, code: "indeterminate", message: "denied" }
        : { ok: true, identity: { pid, bootId: "boot-1", starttime: "11" } };

    const runPromise = run(["--resume", LAUNCH_SESSION], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const exitCbs: Array<(arg: { exitCode: number }) => void> = [];
        const fake = {
          pid: 6100 + spawned.length,
          args,
          writes: [] as string[],
          fireExit(code: number) {
            for (const cb of exitCbs) cb({ exitCode: code });
          },
          onData: (cb: (data: string) => void) => {
            setTimeout(() => cb("render\r\n"), 20);
            return { dispose() {} };
          },
          onExit: (cb: (arg: { exitCode: number }) => void) => {
            exitCbs.push(cb);
            return { dispose() {} };
          },
          kill: (signal?: string) => {
            if (autoExit) setImmediate(() => fake.fireExit(signal === "SIGKILL" ? 9 : 0));
          },
          write: (data: string) => {
            fake.writes.push(data);
          },
          resize: () => {},
        };
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin,
      stdout: stdout as never,
      stderr: stderr as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: join(home, "cc-lhc.sqlite"),
      probeProcessIdentity: probe,
      wrapperLog: {
        info: (m: string) => logLines.push(m),
        warn: (m: string) => logLines.push(m),
        warningCount: () => 0,
        path: join(home, "wrapper.log"),
      } as never,
      onHandoffResult: (result) => {
        results.push(result);
      },
      handoffTimeouts: {
        sigtermGraceMs: 40,
        sigkillWaitMs: 40,
        captureReadyTimeoutMs: 2_000,
        childLivenessTimeoutMs: 3_000,
        childStableWindowMs: 80,
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "capture lifecycle sink", runPromise, diagnostics);
    await waitFor(() => spawned.length === 1, "first child", runPromise, diagnostics);
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(TRIGGER_SIGNALS);
    await waitFor(() => results.length === 1, "handoff result", runPromise, diagnostics);
    const result = results[0]!;
    (stdin as unknown as PassThrough).write(Buffer.from([0x1d]));
    await waitFor(() => terminalOutput.includes("last action:"), "panel", runPromise, diagnostics);
    return {
      result,
      terminalOutput,
      logLines,
      childWrites: spawned.flatMap((child) => child.writes).join(""),
      runPromise,
      spawned,
      restoreHome: () => {
        if (savedHome === undefined) delete process.env.CC_LHC_HOME;
        else process.env.CC_LHC_HOME = savedHome;
      },
    };
  }

  for (const kind of ["terminated", "surviving_orphan", "unknown"] as const) {
    it(`automatic ${kind} appears once on the panel and once in the wrapper log`, async () => {
      const { result, terminalOutput, logLines, childWrites, runPromise, spawned, restoreHome } =
        await runAutomatic(kind);
      try {
        expect(result.kind).toBe("success");
        if (result.kind !== "success") return;
        expect(result.oldChildCleanup.kind).toBe(kind);
        const needle = formatOldChildCleanup(result.oldChildCleanup);
        expect(terminalOutput.split(needle).length - 1).toBe(1);
        expect(logLines.join("\n").split(needle).length - 1).toBe(1);
        expect(childWrites).not.toContain(needle);
        expect(terminalOutput.match(/\[runtime note\]/g) ?? []).toHaveLength(0);
        spawned[spawned.length - 1]!.fireExit(0);
        await runPromise;
      } finally {
        restoreHome();
      }
    }, 15_000);
  }
});
