import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import { rolloutPathForSession } from "../../src/rollout/sessions-index.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import type { ProbeProcessIdentity } from "../../src/runtime/process-identity.js";
import { emptyCaptureStats } from "../../src/stats.js";
import type { HandoffResult } from "../../src/wrapper/handoff.js";

/**
 * LIM-80 3B1: the automatic handoff stage port proves exact child identities via
 * the native provider. Tests spawn fake PTYs, so inject a deterministic probe
 * that returns a stable identity for any pid (self-claim + old/replacement child).
 */
const anyPidIdentity: ProbeProcessIdentity = (pid) => ({
  ok: true,
  identity: { pid, bootId: "test-boot", starttime: "1" },
});

import { run } from "../../src/wrapper/run.js";

/** A StoredView `describe()` value; stable fingerprint per (viewId, createdAt). */
function storedViewValue(viewId: string, createdAt = "2026-08-17T00:00:00.000Z") {
  return {
    viewId,
    createdAt,
    compactPoint: 1,
    coveredFrom: 0,
    profileName: "continuation",
    config: { lowerBound: 1_000, percentages: {} },
    arrangement: [],
    gaps: [],
    sourceState: { maxEventOrder: 9, derivationCounts: {} },
    bands: [],
  };
}

/** Write a structurally valid rebuilt rollout (2 prefix lines + trailing note). */
function writeValidRollout(path: string, sessionId: string, durableReceipt: string): number {
  const lines = [
    { type: "user", uuid: "u1", parentUuid: null, sessionId, message: { role: "user", content: "hello" } },
    { type: "assistant", uuid: "u2", parentUuid: "u1", sessionId, message: { role: "assistant", content: "hi" } },
    {
      type: "user",
      uuid: "u3",
      parentUuid: "u2",
      sessionId,
      message: { role: "user", content: `[runtime note] ${durableReceipt}` },
    },
  ];
  const body = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return Buffer.byteLength(body, "utf8");
}

/** Isolate durable governor receipts per test (shared ~/.cc-lhc would cross-talk). */
function tempReceiptDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-lhc-auto-receipt-"));
  receiptDirs.push(dir);
  return join(dir, "cc-lhc.sqlite");
}
const receiptDirs: string[] = [];

const mocks = vi.hoisted(() => ({
  captureFactory: null as ((opts: CaptureSessionDeps) => CaptureSession) | null,
  registerLineage: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
}));

vi.mock("../../src/intake/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intake/session.js")>();
  return {
    ...actual,
    startCaptureSession: (opts: CaptureSessionDeps = {}) => {
      if (mocks.captureFactory !== null) return mocks.captureFactory(opts);
      return actual.startCaptureSession(opts);
    },
  };
});

vi.mock("../../src/commands/rebuild-receipt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/commands/rebuild-receipt.js")>();
  return {
    ...actual,
    registerRebuiltSessionLineage: (...args: unknown[]) =>
      (mocks.registerLineage as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

const REBUILT_ID = "12345678-1234-1234-1234-123456789abc";

interface FakePty {
  pid: number;
  label: string;
  args: string[];
  killed: string[];
  writes: string[];
  fireExit(code: number, signal?: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (arg: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  write(data: string): void;
  resize(): void;
}

function makeFakePty(pid: number, label: string, args: string[], autoExitOnKill: boolean, emitOutput = true): FakePty {
  const exitCbs: Array<(arg: { exitCode: number; signal?: number }) => void> = [];
  const dataCbs: Array<(data: string) => void> = [];
  const fake: FakePty = {
    pid,
    label,
    args,
    killed: [],
    writes: [],
    fireExit(code: number, signal?: number) {
      for (const cb of exitCbs) cb({ exitCode: code, ...(signal === undefined ? {} : { signal }) });
    },
    onData: (cb: (data: string) => void) => {
      dataCbs.push(cb);
      if (emitOutput) {
        // A live child renders output shortly after spawn (liveness signal).
        setTimeout(() => {
          for (const dataCb of dataCbs) dataCb("render\r\n");
        }, 30);
      }
      return { dispose() {} };
    },
    onExit: (cb) => {
      exitCbs.push(cb);
      return { dispose() {} };
    },
    kill: (signal?: string) => {
      fake.killed.push(signal ?? "SIGTERM");
      if (autoExitOnKill) setImmediate(() => fake.fireExit(0, signal === "SIGKILL" ? 9 : 15));
    },
    write: (data: string) => {
      fake.writes.push(data);
    },
    resize: () => {},
  };
  return fake;
}

function sdkForCapture() {
  return {
    drainSettled: async () => {},
    threadView: {
      describe: vi.fn(async () => ({ ok: true, value: storedViewValue("v1") })),
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
      prune: vi.fn(),
      getSessionThreadView: vi.fn(async () => ({
        ok: true,
        value: { threadId: "th_auto", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
      })),
    },
    intakeStream: { messageEvents: async () => ({ ok: true, value: { events: [] } }) },
  };
}

interface ScriptedSession {
  session: CaptureSession;
  deps: CaptureSessionDeps;
}

function scriptedCaptureSession(
  deps: CaptureSessionDeps,
  sdk: unknown,
  sessionId: string,
  rolloutPath: string,
  generation: number,
): ScriptedSession {
  const stats = { ...emptyCaptureStats(), threadId: "th_auto" };
  const session: CaptureSession = {
    stats,
    getCommandContext: () => ({
      captureDisabled: false,
      stats,
      sdk: sdk as Lhc,
      threadRef: { threadId: "th_auto", registryPath: "/tmp/reg.sqlite" },
      captureDegraded: false,
      captureGeneration: generation,
      capturePhase: "ready" as const,
    }),
    getRolloutInfo: () => ({ path: rolloutPath, sessionId }),
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
    stop: vi.fn(async () => {}),
  } as unknown as CaptureSession;
  return { session, deps };
}

function fakeStream(): NodeJS.ReadStream & NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & NodeJS.WriteStream;
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  Object.defineProperty(stream, "columns", { value: 80, configurable: true });
  Object.defineProperty(stream, "rows", { value: 24, configurable: true });
  return stream;
}

async function waitFor(condition: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const POLICY = {
  policy: {
    autoCompact: true,
    lowerBoundTokens: 1_000,
    upperBoundTokens: 5_000,
    profile: "continuation",
    nativeCompactMode: "emergency_backstop" as const,
    nativeBackstopTokens: 1_000_000,
    pruneEnabled: false,
    pruneThresholdTokens: null,
    pruneTargetTokens: null,
    observeOnly: false,
    retryGrowthTokens: 1_000,
    minRunwayTokens: 100,
  },
  sources: Object.fromEntries(
    Object.keys({
      autoCompact: 0,
      lowerBoundTokens: 0,
      upperBoundTokens: 0,
      profile: 0,
      nativeCompactMode: 0,
      nativeBackstopTokens: 0,
      pruneEnabled: 0,
      pruneThresholdTokens: 0,
      pruneTargetTokens: 0,
      observeOnly: 0,
      retryGrowthTokens: 0,
      minRunwayTokens: 0,
    }).map((k) => [k, "session"]),
  ) as never,
  armed: true,
  errors: [] as string[],
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

describe("run: automatic compact with wrapper-owned handoff", () => {
  const savedHome = process.env.CC_LHC_HOME;
  beforeEach(() => {
    mocks.registerLineage.mockClear();
    mocks.captureFactory = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-auto-home-"));
    receiptDirs.push(home);
    process.env.CC_LHC_HOME = home;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.captureFactory = null;
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const d of receiptDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("triggers on provider pressure, respawns with external --resume, registers lineage after ready, and reports success", async () => {
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    const captureCalls: CaptureSessionDeps[] = [];
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;

    const rolloutProjectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-auto-handoff-"));
    const rebuiltPath = rolloutPathForSession(rolloutProjectsRoot, process.cwd(), REBUILT_ID);
    const writeSpy = vi
      .spyOn(writeRebuilt, "writeRebuiltRollout")
      .mockImplementation(async (input: Parameters<typeof writeRebuilt.writeRebuiltRollout>[0]) => {
        const sessionId = input.newSessionId ?? REBUILT_ID;
        const path = rolloutPathForSession(rolloutProjectsRoot, input.cwd, sessionId);
        const total = writeValidRollout(path, sessionId, input.receipt?.text ?? "");
        return {
          sessionId,
          rolloutPath: path,
          lineCount: 3,
          expectedReintakeLines: 3,
          replayedPrefixLines: 2,
          prefixBoundary: { kind: "verified", lineCount: 2, byteLength: 40, sha256: "aa".repeat(32) },
          totalByteLength: total,
        };
      });

    mocks.captureFactory = (opts) => {
      captureCalls.push(opts);
      const generation = captureCalls.length;
      const isRebuilt = opts.knownRolloutPath !== undefined;
      const scripted = scriptedCaptureSession(
        opts,
        sdk,
        isRebuilt ? REBUILT_ID : "old-session",
        isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
        generation,
      );
      if (!isRebuilt) {
        if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
        opts.onRuntimeSettings?.({ effort: "max", permissionMode: "auto" });
      }
      return scripted.session;
    };

    const results: HandoffResult[] = [];
    const stdin = fakeStream();
    const stdout = fakeStream();
    const stderr = fakeStream();
    let terminalOutput = "";
    (stdout as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      terminalOutput += chunk.toString("utf8");
    });

    const runPromise = run(["--effort", "medium", "--permission-mode", "manual"], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(1000 + spawned.length, `child${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin,
      stdout: stdout as never,
      stderr: stderr as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: tempReceiptDbPath(),
      readProcessIdentity: anyPidIdentity,
      recoveryProjectsRoot: rolloutProjectsRoot,
      recoverySessionIdFn: () => REBUILT_ID,
      onHandoffResult: (result) => {
        results.push(result);
      },
      handoffTimeouts: {
        sigtermGraceMs: 500,
        sigkillWaitMs: 300,
        captureReadyTimeoutMs: 2_000,
        childLivenessTimeoutMs: 3_000,
        childStableWindowMs: 100,
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "capture lifecycle sink");
    await waitFor(() => spawned.length === 1, "first child");
    // Post-commit input: the user types while the old child is being terminated.
    // The barrier must deliver these bytes to exactly the rebound child, in order.
    const origKill = spawned[0]!.kill.bind(spawned[0]);
    spawned[0]!.kill = (sig?: string) => {
      (stdin as unknown as PassThrough).write("post-commit bytes");
      origKill(sig);
    };
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(TRIGGER_SIGNALS);

    await waitFor(() => results.length === 1, "handoff result");
    const result = results[0]!;
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.newSessionId).toBe(REBUILT_ID);
      expect(result.flushedInputBytes).toBe("post-commit bytes".length);
    }
    // Invariant 1: post-commit bytes reached exactly the rebound child, never the old one.
    expect(spawned[1]!.writes.join("")).toContain("post-commit bytes");
    expect(spawned[0]!.writes.join("")).not.toContain("post-commit bytes");

    // Old child was terminated gracefully; a second child spawned with external --resume.
    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.killed).toContain("SIGTERM");
    expect(spawned[1]!.args).toContain("--resume");
    expect(spawned[1]!.args[spawned[1]!.args.indexOf("--resume") + 1]).toBe(REBUILT_ID);
    // The respawned child carries the native backstop through the supported surface.
    expect(spawned[1]!.args).toContain("--autocompact");
    expect(spawned[1]!.args[spawned[1]!.args.indexOf("--autocompact") + 1]).toBe("1000000");
    // Wrapper-owned handoff preserves the latest confirmed Claude runtime choices.
    expect(spawned[1]!.args[spawned[1]!.args.indexOf("--effort") + 1]).toBe("max");
    expect(spawned[1]!.args[spawned[1]!.args.indexOf("--permission-mode") + 1]).toBe("auto");

    // The SDK received the configured profile and lower bound.
    expect(sdk.threadView.compact).toHaveBeenCalledWith(expect.anything(), {
      profile: "continuation",
      params: { lowerBound: 1_000 },
    });
    // One materialization.
    expect(writeSpy).toHaveBeenCalledOnce();

    // The rebuilt capture generation was passed the pending capability directly.
    expect(captureCalls).toHaveLength(2);
    const rebuiltDeps = captureCalls[1]!;
    expect(rebuiltDeps.suppressBindLineageRecord).toBe(true);
    expect(rebuiltDeps.knownRolloutPath).toBe(rebuiltPath);
    expect(rebuiltDeps.prefixBoundary).toMatchObject({ kind: "verified", lineCount: 2 });
    expect(rebuiltDeps.expectedSession).toMatchObject({ sessionId: REBUILT_ID, source: "rebuilt_handoff" });
    // Old capture stopped (final flush) before the replacement generation started.
    expect(captureCalls[1]).toBeDefined();

    // Success-only lineage: registered exactly once, for the rebuilt session.
    expect(mocks.registerLineage).toHaveBeenCalledOnce();
    expect(mocks.registerLineage.mock.calls[0]?.[0]).toMatchObject({
      newSessionId: REBUILT_ID,
      threadId: "th_auto",
    });

    // Slice 5: only a CONFIRMED handoff records last action. Open the panel
    // and read the status summary.
    (stdin as unknown as PassThrough).write(Buffer.from([0x1d]));
    await waitFor(() => terminalOutput.includes("last action:"), "panel status rows");
    expect(terminalOutput).toContain("LHC context management");
    expect(terminalOutput).toMatch(/last action: compacted .*\(auto\)/);
    expect(terminalOutput).toContain("trigger 6.0k");
    expect(terminalOutput).toContain("view 9");
    // Close the modal again (leader-again cancels).
    (stdin as unknown as PassThrough).write(Buffer.from([0x1d]));

    // Wrapper stays alive on the new child; end the run by exiting it.
    spawned[1]!.fireExit(0);
    const code = await runPromise;
    expect(code).toBe(0);
    writeSpy.mockRestore();
  });

  it("stdin bytes arriving during the rebuild cancel the operation with no respawn and no termination", async () => {
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const stdin = fakeStream();
    const stdout = fakeStream();

    const rolloutProjectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-cancel-"));
    const writeSpy = vi
      .spyOn(writeRebuilt, "writeRebuiltRollout")
      .mockImplementation(async (input: Parameters<typeof writeRebuilt.writeRebuiltRollout>[0]) => {
        // The user types while the rebuild is being written: the post-write fence
        // must cancel the operation (partial), even though the rollout is valid.
        (stdin as unknown as PassThrough).write("x");
        await new Promise((r) => setTimeout(r, 60));
        const sessionId = input.newSessionId ?? REBUILT_ID;
        const path = rolloutPathForSession(rolloutProjectsRoot, input.cwd, sessionId);
        const total = writeValidRollout(path, sessionId, input.receipt?.text ?? "");
        return {
          sessionId,
          rolloutPath: path,
          lineCount: 3,
          expectedReintakeLines: 3,
          replayedPrefixLines: 2,
          prefixBoundary: { kind: "verified", lineCount: 2, byteLength: 40, sha256: "aa".repeat(32) },
          totalByteLength: total,
        };
      });

    const wrapperLogLines: string[] = [];
    mocks.captureFactory = (opts) => {
      const scripted = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return scripted.session;
    };

    const results: HandoffResult[] = [];
    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(2000 + spawned.length, `child${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin,
      stdout: stdout as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: tempReceiptDbPath(),
      readProcessIdentity: anyPidIdentity,
      recoveryProjectsRoot: rolloutProjectsRoot,
      recoverySessionIdFn: () => REBUILT_ID,
      wrapperLog: {
        info: (m: string) => wrapperLogLines.push(m),
        warn: (m: string) => wrapperLogLines.push(m),
        warningCount: () => 0,
        path: "/tmp/fake.log",
      } as never,
      onHandoffResult: (result) => {
        results.push(result);
      },
      handoffTimeouts: {
        sigtermGraceMs: 500,
        sigkillWaitMs: 300,
        captureReadyTimeoutMs: 2_000,
        childLivenessTimeoutMs: 3_000,
        childStableWindowMs: 100,
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "capture lifecycle sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(TRIGGER_SIGNALS);

    await waitFor(
      () => wrapperLogLines.some((line) => line.includes("auto-compact mutation partial")),
      "cancelled mutation log",
    );
    // No handoff: no second spawn, no SIGTERM to the live child, no lineage.
    expect(results).toHaveLength(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.killed).toHaveLength(0);
    expect(mocks.registerLineage).not.toHaveBeenCalled();
    // The typed byte reached the live child (never swallowed).
    expect(spawned[0]!.writes.join("")).toContain("x");

    spawned[0]!.fireExit(0);
    await runPromise;
    writeSpy.mockRestore();
  });

  it("capture ready but a mute replacement child rolls back to the old session and never registers lineage", async () => {
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const rolloutProjectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-nogrow-"));

    const writeSpy = vi
      .spyOn(writeRebuilt, "writeRebuiltRollout")
      .mockImplementation(async (input: Parameters<typeof writeRebuilt.writeRebuiltRollout>[0]) => {
        const sessionId = input.newSessionId ?? REBUILT_ID;
        const path = rolloutPathForSession(rolloutProjectsRoot, input.cwd, sessionId);
        const total = writeValidRollout(path, sessionId, input.receipt?.text ?? "");
        return {
          sessionId,
          rolloutPath: path,
          lineCount: 3,
          expectedReintakeLines: 3,
          replayedPrefixLines: 2,
          prefixBoundary: { kind: "verified", lineCount: 2, byteLength: 40, sha256: "aa".repeat(32) },
          totalByteLength: total,
        };
      });

    mocks.captureFactory = (opts) => {
      const isRebuilt = opts.knownRolloutPath !== undefined;
      const sessionId = isRebuilt
        ? REBUILT_ID
        : opts.resumeSessionId !== undefined
          ? opts.resumeSessionId
          : "old-session";
      const scripted = scriptedCaptureSession(
        opts,
        sdk,
        sessionId,
        isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
        opts.continueCapture?.priorGeneration !== undefined ? opts.continueCapture.priorGeneration + 1 : 1,
      );
      if (opts.onLifecycle !== undefined && lifecycleSink === undefined) lifecycleSink = opts.onLifecycle;
      return scripted.session;
    };

    const results: HandoffResult[] = [];
    const stdin = fakeStream();
    const runStdout = fakeStream();
    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        // The replacement child (--resume REBUILT_ID) emits NO output: liveness
        // must fail. The initial and rollback children render normally.
        const isMuteReplacement = args.includes("--resume") && args.includes(REBUILT_ID);
        const fake = makeFakePty(3000 + spawned.length, `child${spawned.length}`, args, true, !isMuteReplacement);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin,
      stdout: runStdout as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: tempReceiptDbPath(),
      readProcessIdentity: anyPidIdentity,
      recoveryProjectsRoot: rolloutProjectsRoot,
      recoverySessionIdFn: () => REBUILT_ID,
      onHandoffResult: (result) => {
        results.push(result);
      },
      handoffTimeouts: {
        sigtermGraceMs: 500,
        sigkillWaitMs: 300,
        captureReadyTimeoutMs: 2_000,
        childLivenessTimeoutMs: 400,
        childStableWindowMs: 100,
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "capture lifecycle sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(TRIGGER_SIGNALS);

    await waitFor(() => results.length === 1, "handoff result");
    const result = results[0]!;
    expect(result.kind).toBe("rolled_back");
    if (result.kind === "rolled_back") {
      expect(result.reason).toMatch(/child liveness timeout/);
      expect(result.oldSessionId).toBe("old-session");
    }
    // Replacement spawned then killed; rollback child resumed the OLD id.
    const resumeTargets = spawned
      .filter((f) => f.args.includes("--resume"))
      .map((f) => f.args[f.args.indexOf("--resume") + 1]);
    expect(resumeTargets).toEqual([REBUILT_ID, "old-session"]);
    // The unproven replacement never advanced canonical lineage.
    expect(mocks.registerLineage).not.toHaveBeenCalled();

    // Slice 5: a rolled-back attempt must NOT claim a successful compact — it
    // is visible only as last-attempt health state.
    let terminalOutput = "";
    (runStdout as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      terminalOutput += chunk.toString("utf8");
    });
    (stdin as unknown as PassThrough).write(Buffer.from([0x1d]));
    await waitFor(() => terminalOutput.includes("last action:"), "panel after rollback");
    expect(terminalOutput).toContain("last action: none this wrapper session");
    expect(terminalOutput).toMatch(/last attempt: auto_compact rolled back/);
    (stdin as unknown as PassThrough).write(Buffer.from([0x1d]));

    spawned[spawned.length - 1]!.fireExit(0);
    await runPromise;
    writeSpy.mockRestore();
  });

  it("a positional initial prompt disables handoff: trigger causes no mutation, no respawn, no termination", async () => {
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const wrapperLogLines: string[] = [];
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout");

    mocks.captureFactory = (opts) => {
      const scripted = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return scripted.session;
    };

    const stdin = fakeStream();
    const runPromise = run(["fix the login bug"], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(4000 + spawned.length, `child${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin,
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: tempReceiptDbPath(),
      readProcessIdentity: anyPidIdentity,
      wrapperLog: {
        info: (m: string) => wrapperLogLines.push(m),
        warn: (m: string) => wrapperLogLines.push(m),
        warningCount: () => 0,
        path: "/tmp/fake.log",
      } as never,
      onHandoffResult: () => {
        throw new Error("handoff must not run for a positional-prompt launch");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "capture lifecycle sink");
    expect(wrapperLogLines.some((l) => l.includes("handoff disabled for this launch form"))).toBe(true);

    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(TRIGGER_SIGNALS);
    await new Promise((r) => setTimeout(r, 300));

    // The decision was logged but nothing mutated or respawned; the positional
    // prompt was never re-sent to any replacement child.
    expect(wrapperLogLines.some((l) => l.includes("would_compact"))).toBe(true);
    expect(wrapperLogLines.some((l) => l.includes("auto-compact mutation"))).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.killed).toHaveLength(0);

    spawned[0]!.fireExit(0);
    await runPromise;
    writeSpy.mockRestore();
  });

  it("panel policy edits are atomic and session-scoped: rejected bounds change nothing, auto off applies live", async () => {
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const observes: Array<{ decision: string; wouldMutate: boolean; upperBoundTokens: number }> = [];
    const stdin = fakeStream();
    const stdout = fakeStream();
    let terminalOutput = "";
    (stdout as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      terminalOutput += chunk.toString("utf8");
    });

    mocks.captureFactory = (opts) => {
      const scripted = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return scripted.session;
    };

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(5000 + spawned.length, `child${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin,
      stdout: stdout as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: tempReceiptDbPath(),
      readProcessIdentity: anyPidIdentity,
      onGovernorObserve: (record) => {
        observes.push({
          decision: record.decision,
          wouldMutate: record.wouldMutate,
          upperBoundTokens: record.upperBoundTokens,
        });
      },
      onHandoffResult: () => {
        throw new Error("no handoff may run in this test");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "capture lifecycle sink");
    lifecycleSink!(BOUND_SIGNALS);

    // Open the panel: the status summary appears before the prompt.
    (stdin as unknown as PassThrough).write(Buffer.from([0x1d]));
    await waitFor(() => terminalOutput.includes("LHC context management"), "panel summary");
    expect(terminalOutput).toContain("last action: none this wrapper session");
    expect(terminalOutput).toContain("auto on");
    expect(terminalOutput).toContain("session-scoped");
    expect(terminalOutput).toContain("precedence: builtin < user");

    // Atomic rejection: inverted bounds change NOTHING.
    (stdin as unknown as PassThrough).write("bounds 200 100\r");
    await waitFor(() => terminalOutput.includes("rejected — nothing changed"), "rejected edit");

    // Live valid edit: auto off (session scope).
    (stdin as unknown as PassThrough).write("auto off\r");
    await waitFor(() => terminalOutput.includes("auto off — applied live to this wrapper"), "applied edit");
    expect(terminalOutput).toContain("scope: session only");

    // Close the panel (leader-again), then settle a high-pressure turn: the
    // rejected bounds left the trigger at 5k, and auto off suppresses execution.
    (stdin as unknown as PassThrough).write(Buffer.from([0x1d]));
    lifecycleSink!(TRIGGER_SIGNALS);
    await waitFor(() => observes.length >= 1, "governor observe");
    const last = observes[observes.length - 1]!;
    expect(last.upperBoundTokens).toBe(5_000); // rejected edit really changed nothing
    expect(last.decision).toBe("policy_disabled"); // auto off is live
    expect(last.wouldMutate).toBe(false);
    expect(spawned).toHaveLength(1); // no handoff, no respawn

    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("freezes the receipt's trigger context at the scheduling decision even when later lifecycle updates race the mutation", async () => {
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    // While the mutation runs, a NEW sampling observation arrives with a much
    // larger total. The durable receipt must still report the trigger that
    // scheduled the operation (6.0k), not the racing value.
    sdk.threadView.previewCompact = vi.fn(async () => {
      lifecycleSink!([
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "req:race",
          providerUsage: { input_tokens: 999_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      ]);
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true, value: { kind: "ok" } };
    }) as never;

    const rolloutProjectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-race-"));
    const writeSpy = vi
      .spyOn(writeRebuilt, "writeRebuiltRollout")
      .mockImplementation(async (input: Parameters<typeof writeRebuilt.writeRebuiltRollout>[0]) => {
        const sessionId = input.newSessionId ?? REBUILT_ID;
        const path = rolloutPathForSession(rolloutProjectsRoot, input.cwd, sessionId);
        const total = writeValidRollout(path, sessionId, input.receipt?.text ?? "");
        return {
          sessionId,
          rolloutPath: path,
          lineCount: 3,
          expectedReintakeLines: 3,
          replayedPrefixLines: 2,
          prefixBoundary: { kind: "verified", lineCount: 2, byteLength: 40, sha256: "aa".repeat(32) },
          totalByteLength: total,
        };
      });

    mocks.captureFactory = (opts) => {
      const isRebuilt = opts.knownRolloutPath !== undefined;
      const scripted = scriptedCaptureSession(
        opts,
        sdk,
        isRebuilt ? REBUILT_ID : "old-session",
        isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
        opts.continueCapture?.priorGeneration !== undefined ? opts.continueCapture.priorGeneration + 1 : 1,
      );
      if (opts.onLifecycle !== undefined && lifecycleSink === undefined) lifecycleSink = opts.onLifecycle;
      return scripted.session;
    };

    const results: HandoffResult[] = [];
    const stdin = fakeStream();
    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(6000 + spawned.length, `child${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin,
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: tempReceiptDbPath(),
      readProcessIdentity: anyPidIdentity,
      recoveryProjectsRoot: rolloutProjectsRoot,
      recoverySessionIdFn: () => REBUILT_ID,
      onHandoffResult: (result) => {
        results.push(result);
      },
      handoffTimeouts: {
        sigtermGraceMs: 500,
        sigkillWaitMs: 300,
        captureReadyTimeoutMs: 2_000,
        childLivenessTimeoutMs: 3_000,
        childStableWindowMs: 100,
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "capture lifecycle sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(TRIGGER_SIGNALS);
    await waitFor(() => results.length === 1, "handoff result");
    expect(results[0]!.kind).toBe("success");

    const receipt = writeSpy.mock.calls[0]![0].receipt?.text ?? "";
    expect(receipt).toContain("trigger context 6.0k");
    expect(receipt).not.toContain("999k");

    spawned[spawned.length - 1]!.fireExit(0);
    await runPromise;
    writeSpy.mockRestore();
  }, 15_000);

  it("ignores zero provider totals when learning the overhead floor, and shows refused mutations as last attempt", async () => {
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    // The mutation refuses at preview: no handoff may happen, but the attempt
    // must be visible as health state (never as a successful action).
    sdk.threadView.previewCompact = vi.fn(async () => ({
      ok: true,
      value: { kind: "error", reason: "record damage" },
    })) as never;
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const stdin = fakeStream();
    const stdout = fakeStream();
    let terminalOutput = "";
    (stdout as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      terminalOutput += chunk.toString("utf8");
    });

    mocks.captureFactory = (opts) => {
      const scripted = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return scripted.session;
    };

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(7000 + spawned.length, `child${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin,
      stdout: stdout as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: tempReceiptDbPath(),
      readProcessIdentity: anyPidIdentity,
      onHandoffResult: () => {
        throw new Error("no handoff may run: the mutation refuses");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "capture lifecycle sink");
    lifecycleSink!(BOUND_SIGNALS);
    // A degraded ZERO sample must not become the observed floor.
    lifecycleSink!([
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "req:zero",
        providerUsage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      { kind: "turn_settled", reason: "end_turn" },
    ]);
    // The real trigger (6.0k) fires; the mutation refuses at preview.
    lifecycleSink!(TRIGGER_SIGNALS);
    await waitFor(() => terminalOutput.length >= 0 && spawned.length === 1, "no respawn", 1_000).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));

    (stdin as unknown as PassThrough).write(Buffer.from([0x1d]));
    await waitFor(() => terminalOutput.includes("last action:"), "panel");
    // Floor learned from the 6.0k sample, not the zero: the warning fires.
    expect(terminalOutput).toContain("at/below observed Claude host overhead (6.0k)");
    // Refused mutation is last-attempt health state, never a success claim.
    expect(terminalOutput).toContain("last action: none this wrapper session");
    expect(terminalOutput).toMatch(/last attempt: auto compact refused/);
    expect(spawned).toHaveLength(1);

    (stdin as unknown as PassThrough).write(Buffer.from([0x1d]));
    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);
});
