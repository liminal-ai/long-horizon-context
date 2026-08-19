import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import { emptyCaptureStats } from "../../src/stats.js";
import type { HandoffResult } from "../../src/wrapper/handoff.js";
import { defaultLineageDbPath, readPendingCurrentSession } from "../../src/intake/lineage-db.js";
import { defaultRegistryPath } from "../../src/intake/paths.js";
import { acceptCurrentSession, claudeSessionAlias, currentSessionAlias } from "../../src/intake/thread-alias.js";
import { run } from "../../src/wrapper/run.js";

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
  /** Alias whose registry current-pointer advance cannot be written. */
  unwritableAlias: null as string | null,
}));

vi.mock("lhc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lhc")>();
  return {
    ...actual,
    // Only the pointer write for one alias fails. Everything the wrapper does
    // around it — observing the predecessor, recording the acceptance — runs
    // against the real registry.
    threads: {
      ...actual.threads,
      registerCurrentAlias: async (registration: Parameters<typeof actual.threads.registerCurrentAlias>[0]) =>
        registration.alias === mocks.unwritableAlias
          ? {
              ok: false as const,
              error: {
                errorClass: "system_error" as const,
                code: "storage_failure" as const,
                reason: "attempt to write a readonly database",
              },
            }
          : actual.threads.registerCurrentAlias(registration),
    },
  };
});

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
  /** Push a frame from this child on demand (routing assertions). */
  emitData(data: string): void;
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
    emitData(data: string) {
      for (const cb of dataCbs) cb(data);
    },
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
    pruneEnabled: false,
    pruneThresholdTokens: null,
    pruneTargetTokens: null,
    minRunwayTokens: 100,
  },
  sources: Object.fromEntries(
    Object.keys({
      autoCompact: 0,
      lowerBoundTokens: 0,
      upperBoundTokens: 0,
      profile: 0,
      pruneEnabled: 0,
      pruneThresholdTokens: 0,
      pruneTargetTokens: 0,
      minRunwayTokens: 0,
    }).map((k) => [k, "session"]),
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

describe("run: automatic compact with wrapper-owned handoff", () => {
  const savedHome = process.env.CC_LHC_HOME;
  beforeEach(() => {
    mocks.registerLineage.mockClear();
    mocks.captureFactory = null;
    mocks.unwritableAlias = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-auto-home-"));
    receiptDirs.push(home);
    process.env.CC_LHC_HOME = home;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.captureFactory = null;
    mocks.unwritableAlias = null;
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
    const spawnedEnvs: Array<Record<string, string>> = [];
    const spawnOrder: string[] = [];
    const sdk = sdkForCapture();
    const captureCalls: CaptureSessionDeps[] = [];
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;

    const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-auto-handoff-"));
    const rebuiltPath = join(rolloutDir, `${REBUILT_ID}.jsonl`);
    const rebuiltContent = '{"line":1}\n{"line":2}\n{"line":3}\n';
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async () => {
      writeFileSync(rebuiltPath, rebuiltContent);
      return {
        sessionId: REBUILT_ID,
        rolloutPath: rebuiltPath,
        lineCount: 3,
        expectedReintakeLines: 3,
        replayedPrefixLines: 2,
        prefixBoundary: { kind: "verified", lineCount: 2, byteLength: 40, sha256: "aa".repeat(32) },
        totalByteLength: Buffer.byteLength(rebuiltContent),
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
      spawnPty: ((_file: string, args: string[], opts: { env: Record<string, string> }) => {
        const index = spawned.length;
        const fake = makeFakePty(1000 + index, `child${index}`, args, true);
        spawnOrder.push(`spawn:${index}`);
        const origKillForOrder = fake.kill.bind(fake);
        fake.kill = (sig?: string) => {
          spawnOrder.push(`kill:${index}`);
          origKillForOrder(sig);
        };
        spawnedEnvs.push(opts.env);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin,
      stdout: stdout as never,
      stderr: stderr as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: tempReceiptDbPath(),
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
    // The operator types while compact owns the settled session. The bytes are
    // dropped — never delivered to either child, never held for replay — and
    // one line tells them to resend.
    const origKill = spawned[0]!.kill.bind(spawned[0]);
    spawned[0]!.kill = (sig?: string) => {
      (stdin as unknown as PassThrough).write("typed during compaction");
      origKill(sig);
    };
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(TRIGGER_SIGNALS);

    await waitFor(() => results.length === 1, "handoff result");
    const result = results[0]!;
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.newSessionId).toBe(REBUILT_ID);
      expect(result.evidence.processAlive).toBe(true);
      expect(result.orphanPid).toBeUndefined();
    }
    expect(spawned[1]!.writes.join("")).not.toContain("typed during compaction");
    expect(spawned[0]!.writes.join("")).not.toContain("typed during compaction");
    await waitFor(
      () => terminalOutput.includes("input typed during compaction was not delivered"),
      "resend notice",
    );

    // Spawn-first: the replacement existed before the old child was signalled.
    expect(spawnOrder.indexOf("spawn:1")).toBeLessThan(spawnOrder.indexOf("kill:0"));
    // Old child was terminated gracefully; a second child spawned with external --resume.
    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.killed).toContain("SIGTERM");
    expect(spawned[1]!.args).toContain("--resume");
    expect(spawned[1]!.args[spawned[1]!.args.indexOf("--resume") + 1]).toBe(REBUILT_ID);
    // R8: the replacement child carries the same per-child native auto-compact
    // disable as the original, and no --autocompact argv is synthesized.
    expect(spawnedEnvs[1]!.DISABLE_AUTO_COMPACT).toBe("1");
    expect(spawnedEnvs[1]!.DISABLE_COMPACT).toBeUndefined();
    expect(spawned[1]!.args).not.toContain("--autocompact");
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

    // Swap accepted → the thread's current session is the replacement, so a
    // later launch through any older alias resolves forward to it.
    expect(await currentSessionAlias("th_auto", defaultRegistryPath())).toBe(claudeSessionAlias(REBUILT_ID));

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

  it("keeps a live replacement when the registry pointer cannot advance, and records the acceptance", async () => {
    mocks.unwritableAlias = claudeSessionAlias(REBUILT_ID);
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    const captureCalls: CaptureSessionDeps[] = [];
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;

    const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-auto-pending-"));
    const rebuiltPath = join(rolloutDir, `${REBUILT_ID}.jsonl`);
    const rebuiltContent = '{"line":1}\n{"line":2}\n{"line":3}\n';
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async () => {
      writeFileSync(rebuiltPath, rebuiltContent);
      return {
        sessionId: REBUILT_ID,
        rolloutPath: rebuiltPath,
        lineCount: 3,
        expectedReintakeLines: 3,
        replayedPrefixLines: 2,
        prefixBoundary: { kind: "verified", lineCount: 2, byteLength: 40, sha256: "aa".repeat(32) },
        totalByteLength: Buffer.byteLength(rebuiltContent),
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
    // The thread this capture reports is already current on its old session,
    // so the failed advance observes a real predecessor to record.
    await acceptCurrentSession({ sessionId: "old-session", threadId: "th_auto", registryPath: defaultRegistryPath() });
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(TRIGGER_SIGNALS);

    await waitFor(() => results.length === 1, "handoff result");
    const result = results[0]!;
    // The pointer write failed AFTER acceptance. Nothing rolls back: the
    // replacement is live, captured, and reported as the successful outcome.
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.newSessionId).toBe(REBUILT_ID);
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.args[spawned[1]!.args.indexOf("--resume") + 1]).toBe(REBUILT_ID);

    // The registry pointer is genuinely still behind…
    expect(await currentSessionAlias("th_auto", defaultRegistryPath())).toBe(claudeSessionAlias("old-session"));
    // …so the acceptance is recorded host-side, with the predecessor it saw,
    // for the next launch to reconcile.
    expect(readPendingCurrentSession(defaultLineageDbPath(), "th_auto")).toMatchObject({
      threadId: "th_auto",
      sessionId: REBUILT_ID,
      previousSessionId: "old-session",
    });

    spawned[1]!.fireExit(0);
    const code = await runPromise;
    expect(code).toBe(0);
    writeSpy.mockRestore();
  });

  it("stdin bytes arriving during the rebuild are dropped with a resend notice; the swap still completes", async () => {
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const stdin = fakeStream();
    const stdout = fakeStream();

    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async () => {
      // The user types while the rebuild is being written — compact already
      // owns the settled session, so these bytes go nowhere.
      (stdin as unknown as PassThrough).write("x");
      await new Promise((r) => setTimeout(r, 60));
      return {
        sessionId: REBUILT_ID,
        rolloutPath: `/tmp/${REBUILT_ID}.jsonl`,
        lineCount: 1,
        expectedReintakeLines: 1,
        replayedPrefixLines: 0,
        prefixBoundary: {
          kind: "verified",
          lineCount: 0,
          byteLength: 0,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        totalByteLength: 0,
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

    await waitFor(() => results.length === 1, "handoff result");
    // Late input does not cancel a compact that succeeded.
    expect(results[0]!.kind).toBe("success");
    expect(spawned).toHaveLength(2);
    expect(mocks.registerLineage).toHaveBeenCalledOnce();
    // The typed byte reached neither child, and was never held for replay.
    expect(spawned[0]!.writes.join("")).not.toContain("x");
    expect(spawned[1]!.writes.join("")).not.toContain("x");
    await waitFor(
      () => wrapperLogLines.some((line) => line.includes("dropped 1 typed-ahead byte(s)")),
      "typed-ahead drop logged",
    );

    spawned[1]!.fireExit(0);
    await runPromise;
    writeSpy.mockRestore();
  });

  it("a replacement that is never promoted leaves the old session routed: its output and input still flow", async () => {
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-nogrow-"));
    const rebuiltPath = join(rolloutDir, `${REBUILT_ID}.jsonl`);
    const rebuiltContent = '{"line":1}\n';

    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async () => {
      writeFileSync(rebuiltPath, rebuiltContent);
      return {
        sessionId: REBUILT_ID,
        rolloutPath: rebuiltPath,
        lineCount: 1,
        expectedReintakeLines: 1,
        replayedPrefixLines: 0,
        prefixBoundary: {
          kind: "verified",
          lineCount: 0,
          byteLength: 0,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        totalByteLength: Buffer.byteLength(rebuiltContent),
      };
    });

    mocks.captureFactory = (opts) => {
      const isRebuilt = opts.knownRolloutPath !== undefined;
      const sessionId = isRebuilt ? REBUILT_ID : "old-session";
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
    expect(result.kind).toBe("replacement_nonviable");
    if (result.kind === "replacement_nonviable") {
      expect(result.reason).toMatch(/no_output/);
      expect(result.oldSessionId).toBe("old-session");
    }
    // Every candidate resumed the REBUILT id: bounded retries forward, and no
    // rollback child, because nothing was ever switched away from the old
    // session.
    const resumeTargets = spawned
      .filter((f) => f.args.includes("--resume"))
      .map((f) => f.args[f.args.indexOf("--resume") + 1]);
    expect(resumeTargets.length).toBeGreaterThanOrEqual(1);
    expect(new Set(resumeTargets)).toEqual(new Set([REBUILT_ID]));
    // The original child kept the terminal and was never signalled.
    expect(spawned[0]!.killed).toHaveLength(0);
    // The unproven replacement never advanced canonical lineage.
    expect(mocks.registerLineage).not.toHaveBeenCalled();

    // A nonviable replacement must NOT claim a successful compact — it is
    // visible only as last-attempt health state.
    let terminalOutput = "";
    (runStdout as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      terminalOutput += chunk.toString("utf8");
    });
    (stdin as unknown as PassThrough).write(Buffer.from([0x1d]));
    await waitFor(() => terminalOutput.includes("last action:"), "panel after nonviable swap");
    expect(terminalOutput).toContain("last action: none this wrapper session");
    expect(terminalOutput).toMatch(/last attempt: auto_compact replacement not viable/);
    (stdin as unknown as PassThrough).write(Buffer.from([0x1d]));

    // Routing was never touched. The old child still owns the terminal in both
    // directions: its frames reach the screen and the operator's keystrokes
    // reach it — not the candidate that was built and discarded.
    terminalOutput = "";
    spawned[0]!.emitData("OLD-CHILD-STILL-ROUTED");
    await waitFor(() => terminalOutput.includes("OLD-CHILD-STILL-ROUTED"), "old-child output still routed");
    const candidate = spawned.find((f) => f.args.includes(REBUILT_ID));
    expect(candidate).toBeDefined();
    candidate!.emitData("DISCARDED-CANDIDATE-OUTPUT");
    (stdin as unknown as PassThrough).write("typed after the failed swap");
    await waitFor(
      () => spawned[0]!.writes.join("").includes("typed after the failed swap"),
      "input still routed to the old child",
    );
    expect(candidate!.writes.join("")).not.toContain("typed after the failed swap");
    expect(terminalOutput).not.toContain("DISCARDED-CANDIDATE-OUTPUT");

    spawned[0]!.fireExit(0);
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

    const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-race-"));
    const rebuiltPath = join(rolloutDir, `${REBUILT_ID}.jsonl`);
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async (input) => {
      writeFileSync(rebuiltPath, '{"line":1}\n');
      void input;
      return {
        sessionId: REBUILT_ID,
        rolloutPath: rebuiltPath,
        lineCount: 1,
        expectedReintakeLines: 1,
        replayedPrefixLines: 0,
        prefixBoundary: {
          kind: "verified",
          lineCount: 0,
          byteLength: 0,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        totalByteLength: 11,
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

  it("switches routing atomically: old-child output after the switch never reaches the terminal", async () => {
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;

    const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-auto-routing-"));
    receiptDirs.push(rolloutDir);
    const rebuiltPath = join(rolloutDir, `${REBUILT_ID}.jsonl`);
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async () => {
      writeFileSync(rebuiltPath, '{"line":1}\n');
      return {
        sessionId: REBUILT_ID,
        rolloutPath: rebuiltPath,
        lineCount: 1,
        expectedReintakeLines: 1,
        replayedPrefixLines: 0,
        prefixBoundary: {
          kind: "verified",
          lineCount: 0,
          byteLength: 0,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        totalByteLength: 11,
      };
    });

    const captureCalls: CaptureSessionDeps[] = [];
    mocks.captureFactory = (opts) => {
      captureCalls.push(opts);
      const isRebuilt = opts.knownRolloutPath !== undefined;
      const scripted = scriptedCaptureSession(
        opts,
        sdk,
        isRebuilt ? REBUILT_ID : "old-session",
        isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
        captureCalls.length,
      );
      if (!isRebuilt && opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return scripted.session;
    };

    const results: HandoffResult[] = [];
    const stdin = fakeStream();
    const stdout = fakeStream();
    let terminalOutput = "";
    (stdout as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      terminalOutput += chunk.toString("utf8");
    });
    // The old child renders one recognizable frame; the replacement renders
    // another. Whichever child is routed is the only one on screen.
    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const index = spawned.length;
        const fake = makeFakePty(5100 + index, `child${index}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin,
      stdout: stdout as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: tempReceiptDbPath(),
      onHandoffResult: (result) => results.push(result),
      handoffTimeouts: {
        sigtermGraceMs: 300,
        sigkillWaitMs: 200,
        captureReadyTimeoutMs: 2_000,
        childLivenessTimeoutMs: 3_000,
        childStableWindowMs: 60,
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "capture lifecycle sink");
    await waitFor(() => spawned.length === 1, "first child");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(TRIGGER_SIGNALS);
    await waitFor(() => results.length === 1, "handoff result");
    expect(results[0]!.kind).toBe("success");
    expect(spawned).toHaveLength(2);

    // Capture generation moved with the routing, in the same step.
    expect(captureCalls.at(-1)?.expectedSession).toMatchObject({
      sessionId: REBUILT_ID,
      source: "rebuilt_handoff",
    });

    terminalOutput = "";
    spawned[0]!.emitData("OLD-CHILD-CONTAMINATION");
    spawned[1]!.emitData("REPLACEMENT-FRAME");
    await waitFor(() => terminalOutput.includes("REPLACEMENT-FRAME"), "replacement output routed");
    expect(terminalOutput).not.toContain("OLD-CHILD-CONTAMINATION");

    // Input now reaches only the replacement.
    (stdin as unknown as PassThrough).write("after the swap");
    await waitFor(() => spawned[1]!.writes.join("").includes("after the swap"), "input routed to replacement");
    expect(spawned[0]!.writes.join("")).not.toContain("after the swap");

    spawned[1]!.fireExit(0);
    await runPromise;
    writeSpy.mockRestore();
  });

  it("stays below the bound: a nonviable swap is retried at the next seam, and only the bound alarms", async () => {
    const spawned: FakePty[] = [];
    const spawnedEnvs: Array<Record<string, string>> = [];
    const sdk = sdkForCapture();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;

    const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-auto-bound-"));
    receiptDirs.push(rolloutDir);
    const rebuiltPath = join(rolloutDir, `${REBUILT_ID}.jsonl`);
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async () => {
      writeFileSync(rebuiltPath, '{"line":1}\n');
      return {
        sessionId: REBUILT_ID,
        rolloutPath: rebuiltPath,
        lineCount: 1,
        expectedReintakeLines: 1,
        replayedPrefixLines: 0,
        prefixBoundary: {
          kind: "verified",
          lineCount: 0,
          byteLength: 0,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        totalByteLength: 11,
      };
    });

    let compactCalls = 0;
    sdk.threadView.compact = vi.fn(async () => {
      compactCalls += 1;
      return {
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
      };
    }) as never;

    mocks.captureFactory = (opts) => {
      const scripted = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined && lifecycleSink === undefined) lifecycleSink = opts.onLifecycle;
      return scripted.session;
    };

    const results: HandoffResult[] = [];
    const stdin = fakeStream();
    const stdout = fakeStream();
    let terminalOutput = "";
    (stdout as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      terminalOutput += chunk.toString("utf8");
    });

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[], opts: { env: Record<string, string> }) => {
        const index = spawned.length;
        const mute = args.includes(REBUILT_ID);
        const fake = makeFakePty(5400 + index, `child${index}`, args, true, !mute);
        spawnedEnvs.push(opts.env);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin,
      stdout: stdout as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: tempReceiptDbPath(),
      onHandoffResult: (result) => results.push(result),
      replacementAttempts: 1,
      // Two nonviable swaps before the alarm: one below the bound, one at it.
      nonviableSwapLimit: 2,
      handoffTimeouts: {
        sigtermGraceMs: 300,
        sigkillWaitMs: 200,
        captureReadyTimeoutMs: 500,
        childLivenessTimeoutMs: 400,
        childStableWindowMs: 60,
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "capture lifecycle sink");
    await waitFor(() => spawned.length === 1, "first child");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(TRIGGER_SIGNALS);

    // --- below the bound: one nonviable swap costs the session nothing ---
    await waitFor(() => results.length === 1, "first handoff result");
    expect(results[0]!.kind).toBe("replacement_nonviable");
    expect(compactCalls).toBe(1);
    // No alarm, no survival relaunch: exactly the one mute candidate was spawned.
    expect(terminalOutput).not.toContain("cc-lhc rebuilt sessions are not loading");
    expect(spawned).toHaveLength(2);
    // The old child kept the terminal and was never signalled.
    expect(spawned[0]!.killed).toHaveLength(0);

    // --- the next settled seam retries the swap, for free ---
    lifecycleSink!([
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "req:bound2",
        providerUsage: { input_tokens: 4, cache_creation_input_tokens: 6_000, cache_read_input_tokens: 6_000 },
      },
      { kind: "turn_settled", reason: "end_turn" },
    ]);
    await waitFor(() => results.length === 2, "second handoff result");
    expect(results[1]!.kind).toBe("replacement_nonviable");
    // A retry really happened: a second compact and a second candidate.
    expect(compactCalls).toBe(2);

    // --- at the bound: alarm plus survival relaunch, both at once ---
    await waitFor(
      () => terminalOutput.includes("cc-lhc rebuilt sessions are not loading"),
      "standing alarm at the bound",
    );
    await waitFor(() => spawned.length === 4, "survival relaunch child");
    const survival = spawned[3]!;
    expect(survival.args[survival.args.indexOf("--resume") + 1]).toBe("old-session");
    expect(spawnedEnvs[3]!.DISABLE_AUTO_COMPACT).toBeUndefined();
    // Nothing ended: the alarm says so in as many words.
    expect(terminalOutput).toContain("stays live and capture keeps running");
    expect(terminalOutput).not.toContain("terminal state");

    survival.fireExit(0);
    await runPromise;
    writeSpy.mockRestore();
  });

  it("a terminal that throws while repainting the switch leaves the replacement routed and successful", async () => {
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;

    const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-auto-repaint-"));
    receiptDirs.push(rolloutDir);
    const rebuiltPath = join(rolloutDir, `${REBUILT_ID}.jsonl`);
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async () => {
      writeFileSync(rebuiltPath, '{"line":1}\n');
      return {
        sessionId: REBUILT_ID,
        rolloutPath: rebuiltPath,
        lineCount: 1,
        expectedReintakeLines: 1,
        replayedPrefixLines: 0,
        prefixBoundary: {
          kind: "verified",
          lineCount: 0,
          byteLength: 0,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        totalByteLength: 11,
      };
    });

    mocks.captureFactory = (opts) => {
      const isRebuilt = opts.knownRolloutPath !== undefined;
      const scripted = scriptedCaptureSession(
        opts,
        sdk,
        isRebuilt ? REBUILT_ID : "old-session",
        isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
        isRebuilt ? 2 : 1,
      );
      if (!isRebuilt && opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return scripted.session;
    };

    const results: HandoffResult[] = [];
    const stdin = fakeStream();
    const stdout = fakeStream();
    let terminalOutput = "";
    (stdout as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      terminalOutput += chunk.toString("utf8");
    });

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const index = spawned.length;
        const fake = makeFakePty(5500 + index, `child${index}`, args, true);
        // The replacement's very first resize blows up: the terminal is the one
        // thing here the wrapper does not own.
        if (args.includes(REBUILT_ID)) {
          fake.resize = () => {
            throw new Error("ioctl TIOCSWINSZ failed");
          };
        }
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin,
      stdout: stdout as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: tempReceiptDbPath(),
      onHandoffResult: (result) => results.push(result),
      handoffTimeouts: {
        sigtermGraceMs: 300,
        sigkillWaitMs: 200,
        captureReadyTimeoutMs: 1_000,
        childLivenessTimeoutMs: 3_000,
        childStableWindowMs: 60,
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "capture lifecycle sink");
    await waitFor(() => spawned.length === 1, "first child");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(TRIGGER_SIGNALS);

    await waitFor(() => results.length === 1, "handoff result");
    // The repaint failed; the swap did not.
    expect(results[0]!.kind).toBe("success");
    if (results[0]!.kind === "success") {
      expect(results[0]!.switchWarnings?.join("\n")).toContain("first repaint failed");
    }
    expect(mocks.registerLineage).toHaveBeenCalledOnce();
    expect(spawned[0]!.killed.length).toBeGreaterThan(0);

    // Routing is fully on the replacement, not half moved.
    terminalOutput = "";
    spawned[1]!.emitData("REPLACEMENT-ROUTED");
    spawned[0]!.emitData("OLD-CHILD-CONTAMINATION");
    await waitFor(() => terminalOutput.includes("REPLACEMENT-ROUTED"), "replacement output routed");
    expect(terminalOutput).not.toContain("OLD-CHILD-CONTAMINATION");
    (stdin as unknown as PassThrough).write("after the repaint failure");
    await waitFor(
      () => spawned[1]!.writes.join("").includes("after the repaint failure"),
      "input routed to the replacement",
    );

    spawned[1]!.fireExit(0);
    await runPromise;
    writeSpy.mockRestore();
  });

  it("repeated nonviability raises the standing alarm and actively relaunches the old session for survival", async () => {
    const spawned: FakePty[] = [];
    const spawnedEnvs: Array<Record<string, string>> = [];
    const spawnOrder: string[] = [];
    const sdk = sdkForCapture();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;

    const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-auto-nonviable-"));
    receiptDirs.push(rolloutDir);
    const rebuiltPath = join(rolloutDir, `${REBUILT_ID}.jsonl`);
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async () => {
      writeFileSync(rebuiltPath, '{"line":1}\n');
      return {
        sessionId: REBUILT_ID,
        rolloutPath: rebuiltPath,
        lineCount: 1,
        expectedReintakeLines: 1,
        replayedPrefixLines: 0,
        prefixBoundary: {
          kind: "verified",
          lineCount: 0,
          byteLength: 0,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        totalByteLength: 11,
      };
    });

    let compactCalls = 0;
    sdk.threadView.compact = vi.fn(async () => {
      compactCalls += 1;
      return {
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
      };
    }) as never;

    mocks.captureFactory = (opts) => {
      const scripted = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined && lifecycleSink === undefined) lifecycleSink = opts.onLifecycle;
      return scripted.session;
    };

    const results: HandoffResult[] = [];
    const stdin = fakeStream();
    const stdout = fakeStream();
    let terminalOutput = "";
    (stdout as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      terminalOutput += chunk.toString("utf8");
    });

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[], opts: { env: Record<string, string> }) => {
        const index = spawned.length;
        // Every rebuilt-session candidate is mute: Claude will not load the
        // rebuilt rollout. Everything resuming the OLD session renders fine.
        const mute = args.includes(REBUILT_ID);
        const fake = makeFakePty(5200 + index, `child${index}`, args, true, !mute);
        spawnOrder.push(`spawn:${index}:${args.join(" ")}`);
        const origKill = fake.kill.bind(fake);
        fake.kill = (sig?: string) => {
          spawnOrder.push(`kill:${index}`);
          origKill(sig);
        };
        spawnedEnvs.push(opts.env);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin,
      stdout: stdout as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: tempReceiptDbPath(),
      onHandoffResult: (result) => results.push(result),
      replacementAttempts: 1,
      nonviableSwapLimit: 1,
      handoffTimeouts: {
        sigtermGraceMs: 300,
        sigkillWaitMs: 200,
        captureReadyTimeoutMs: 500,
        childLivenessTimeoutMs: 400,
        childStableWindowMs: 60,
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "capture lifecycle sink");
    await waitFor(() => spawned.length === 1, "first child");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(TRIGGER_SIGNALS);

    await waitFor(() => results.length === 1, "handoff result");
    expect(results[0]!.kind).toBe("replacement_nonviable");

    // R16: the old session is relaunched then and there, WITHOUT the injected
    // native-auto-compact disable, so Claude's own compaction keeps it alive.
    await waitFor(() => spawned.length === 3, "survival relaunch child");
    const survival = spawned[2]!;
    expect(survival.args[survival.args.indexOf("--resume") + 1]).toBe("old-session");
    expect(spawnedEnvs[2]!.DISABLE_AUTO_COMPACT).toBeUndefined();
    // The first child (which carries the disable) got it.
    expect(spawnedEnvs[0]!.DISABLE_AUTO_COMPACT).toBe("1");
    // The alarm is standing, unmissable, and states that it is a best guess.
    await waitFor(
      () => terminalOutput.includes("cc-lhc rebuilt sessions are not loading"),
      "standing alarm on the terminal",
    );
    // Spawn-first here too: the old child was still serviceable when the
    // survival child was created.
    expect(spawnOrder.indexOf(`spawn:2:${survival.args.join(" ")}`)).toBeLessThan(spawnOrder.indexOf("kill:0"));
    expect(spawnOrder.indexOf("kill:0")).toBeGreaterThan(-1);
    expect(terminalOutput).toContain("best guess");
    expect(terminalOutput).toContain("without the injected DISABLE_AUTO_COMPACT");

    // A later settled seam does not quietly retry the swap.
    const compactsAtAlarm = compactCalls;
    lifecycleSink!([
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "req:r2",
        providerUsage: { input_tokens: 4, cache_creation_input_tokens: 6_000, cache_read_input_tokens: 6_000 },
      },
      { kind: "turn_settled", reason: "end_turn" },
    ]);
    await new Promise((r) => setTimeout(r, 200));
    expect(compactCalls).toBe(compactsAtAlarm);
    expect(results).toHaveLength(1);

    // The alarm also sits at the top of the panel.
    terminalOutput = "";
    (stdin as unknown as PassThrough).write(Buffer.from([0x1d]));
    await waitFor(() => terminalOutput.includes("LHC context management"), "panel");
    expect(terminalOutput).toContain("cc-lhc rebuilt sessions are not loading");
    (stdin as unknown as PassThrough).write(Buffer.from([0x1d]));

    survival.fireExit(0);
    await runPromise;
    writeSpy.mockRestore();
  });

  it("surfaces pre-rewrite handoff state at startup as a resend notice", async () => {
    const recoveryDir = join(process.env.CC_LHC_HOME!, "recovery");
    mkdirSync(recoveryDir, { recursive: true });
    writeFileSync(join(recoveryDir, "input-legacy.journal"), Buffer.from([0x01, 0x02]));

    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    mocks.captureFactory = (opts) =>
      scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1).session;

    const stderr = fakeStream();
    let stderrText = "";
    (stderr as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(5300 + spawned.length, `child${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: stderr as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: tempReceiptDbPath(),
    });

    await waitFor(() => spawned.length === 1, "child");
    expect(stderrText).toContain("input typed during compaction was not delivered");
    expect(stderrText).toContain("retained-input artifact(s) from an earlier build");
    // Consumed, not carried: the launch continued and the state is gone.
    expect(existsSync(join(recoveryDir, "input-legacy.journal"))).toBe(false);

    spawned[0]!.fireExit(0);
    await runPromise;
  });
});
