/**
 * LIM-64 production-path wrapper/capture integration (not direct store-API-only proof).
 *
 * Drives run() + lifecycle through the real watcher/capture sink path and
 * asserts durable receipts, exact outcome binding, conservative replay (no
 * second auto mutation; scheduled rows classify as recoverable, LIM-80), and
 * no mutation without a durable receipt.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import { emptyCaptureStats } from "../../src/stats.js";
import type { HandoffResult } from "../../src/wrapper/handoff.js";
import { run } from "../../src/wrapper/run.js";

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

function makeFakePty(pid: number, label: string, args: string[], autoExitOnKill: boolean): FakePty {
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
      setTimeout(() => {
        for (const dataCb of dataCbs) dataCb("render\r\n");
      }, 30);
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

function sdkForCapture(preview?: () => Promise<unknown>) {
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
      previewCompact: vi.fn(
        preview ??
          (async () => ({
            ok: true,
            value: { kind: "ok" },
          })),
      ),
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

function scriptedCaptureSession(
  _deps: CaptureSessionDeps,
  sdk: unknown,
  sessionId: string,
  rolloutPath: string,
  generation: number,
): CaptureSession {
  const stats = { ...emptyCaptureStats(), threadId: "th_auto" };
  return {
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

/** Provider alone below trigger; live estimate pushes next-request pressure over. */
const ESTIMATE_CROSS_SIGNALS: LifecycleSignal[] = [
  { kind: "turn_opened", reason: "user_prompt" },
  {
    kind: "sampling_observed",
    samplingId: "req:est",
    providerUsage: {
      input_tokens: 3_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 500,
    },
  },
  {
    kind: "post_measurement_estimate",
    tokens: 500,
    source: "provider_reported_output_tokens",
    mode: "set",
  },
  {
    kind: "post_measurement_estimate",
    tokens: 2_000,
    source: "host_canonical_payload_byte_estimate",
    mode: "add",
  },
  { kind: "turn_settled", reason: "end_turn" },
];

const dirs: string[] = [];

describe("LIM-64 production wrapper path", () => {
  const savedHome = process.env.CC_LHC_HOME;
  beforeEach(() => {
    mocks.registerLineage.mockClear();
    mocks.captureFactory = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-prod-home-"));
    dirs.push(home);
    process.env.CC_LHC_HOME = home;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.captureFactory = null;
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("one settled receipt → one automatic mutation → exact receipt outcome on handoff success (old→new session)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-prod-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    const captureCalls: CaptureSessionDeps[] = [];
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    let liveSessionId = "old-session";

    const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-rollout-"));
    dirs.push(rolloutDir);
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
      captureCalls.push(opts);
      const generation = captureCalls.length;
      const isRebuilt = opts.knownRolloutPath !== undefined;
      if (isRebuilt) liveSessionId = REBUILT_ID;
      const session = scriptedCaptureSession(
        opts,
        sdk,
        liveSessionId,
        isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
        generation,
      );
      // getRolloutInfo follows liveSessionId so post-success identity is new session.
      (session as { getRolloutInfo: () => { path: string; sessionId: string } }).getRolloutInfo = () => ({
        path: isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
        sessionId: liveSessionId,
      });
      if (opts.onLifecycle !== undefined && !isRebuilt) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const results: HandoffResult[] = [];
    const observes: Array<{ decision: string; wouldMutate: boolean; pressure: number | null }> = [];
    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(8000 + spawned.length, `child${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: receiptDb,
      onGovernorObserve: (record) => {
        observes.push({
          decision: record.decision,
          wouldMutate: record.wouldMutate,
          pressure: record.pressure.nextRequestPressureTokens,
        });
      },
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
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await waitFor(() => results.length === 1, "handoff result");
    expect(results[0]!.kind).toBe("success");
    if (results[0]!.kind === "success") {
      expect(results[0]!.newSessionId).toBe(REBUILT_ID);
    }

    const settled = observes.filter((o) => o.wouldMutate);
    expect(settled.length).toBeGreaterThanOrEqual(1);
    expect(settled[0]!.pressure).toBe(5_500); // 3000 + 500 + 2000

    // Exact receipt for the old-session decision has handoff_success, even though
    // live capture now identifies the new session.
    const store = openGovernorReceiptStore(receiptDb);
    const rows = store.listBySession("old-session");
    const would = rows.filter((r) => r.wouldMutate);
    expect(would).toHaveLength(1);
    expect(would[0]!.handoffOutcome).toEqual({
      kind: "handoff_success",
      newSessionId: REBUILT_ID,
      flushedInputBytes: expect.any(Number),
    });
    // New session must not have stolen the outcome attachment.
    expect(store.listBySession(REBUILT_ID).filter((r) => r.wouldMutate)).toHaveLength(0);
    store.close();

    spawned[spawned.length - 1]!.fireExit(0);
    await runPromise;
    writeSpy.mockRestore();
  }, 20_000);

  it("receipt persistence unavailable → no mutation (append-failure sentinel)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-no-receipt-"));
    dirs.push(dir);
    // Path points at a directory so open/append fails closed.
    const badPath = join(dir, "not-a-file-dir");
    writeFileSync(badPath, "not a sqlite db");

    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const wrapperLogLines: string[] = [];
    let mutationSentinel = false;
    sdk.threadView.previewCompact = vi.fn(async () => {
      mutationSentinel = true;
      return { ok: true, value: { kind: "ok" } };
    }) as never;

    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    // Force store open to succeed with a path that breaks on write: use a
    // read-only parent by opening on a file that is not sqlite — open may throw
    // or append may throw. Prefer inject via non-writable path under a file.
    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(8100 + spawned.length, `child${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: join(badPath, "nested", "cc-lhc.sqlite"),
      wrapperLog: {
        info: (m: string) => wrapperLogLines.push(m),
        warn: (m: string) => wrapperLogLines.push(m),
        warningCount: () => wrapperLogLines.filter((l) => /warn|refused|failed/i.test(l)).length,
        path: "/tmp/fake.log",
      } as never,
      onHandoffResult: () => {
        throw new Error("handoff must not run without durable receipt");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "capture lifecycle sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await new Promise((r) => setTimeout(r, 400));

    expect(mutationSentinel).toBe(false);
    expect(spawned).toHaveLength(1);
    expect(
      wrapperLogLines.some(
        (l) =>
          l.includes("durable receipt unavailable") ||
          l.includes("receipt store unavailable") ||
          l.includes("receipt append failed"),
      ),
    ).toBe(true);

    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("open-failure of receipt store → wouldMutate does not schedule mutation", async () => {
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const wrapperLogLines: string[] = [];
    let mutationSentinel = false;
    sdk.threadView.previewCompact = vi.fn(async () => {
      mutationSentinel = true;
      return { ok: true, value: { kind: "ok" } };
    }) as never;

    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    // Empty string path can fail open depending on platform; use /dev/full-style
    // invalid: a path that is a directory component with no write permission.
    // Safer approach: open against a path where parent is a file.
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-openfail-"));
    dirs.push(dir);
    const fileAsDir = join(dir, "file");
    writeFileSync(fileAsDir, "x");
    const badDb = join(fileAsDir, "cc-lhc.sqlite");

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(8200 + spawned.length, `c${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: badDb,
      wrapperLog: {
        info: (m: string) => wrapperLogLines.push(m),
        warn: (m: string) => wrapperLogLines.push(m),
        warningCount: () => 0,
        path: "/tmp/fake.log",
      } as never,
      onHandoffResult: () => {
        throw new Error("must not handoff");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await new Promise((r) => setTimeout(r, 400));
    expect(mutationSentinel).toBe(false);
    expect(wrapperLogLines.some((l) => l.includes("receipt store unavailable") || l.includes("durable receipt"))).toBe(
      true,
    );
    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("exact replay of scheduled receipt: no second auto mutation, and the row is unclaimed recoverable work (not a permanent latch)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-replay-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const spawned: FakePty[] = [];
    let mutationCalls = 0;
    const sdk = sdkForCapture(async () => {
      mutationCalls += 1;
      return { ok: true, value: { kind: "error", reason: "stop after first" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const wrapperLogLines: string[] = [];

    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    // Crash simulation: pre-seed a scheduled would_mutate receipt with the same
    // native facts the upcoming lifecycle will produce. Restart must not re-run
    // automatic mutation on its own (Slice 1: conservative), but the durable
    // record must classify the row as unclaimed recoverable work rather than a
    // permanent fail-closed latch (LIM-80).
    {
      const { applyGovernorLifecycleBatch, createGovernorRuntimeState } = await import(
        "../../src/governor/observe-state.js"
      );
      const pre = applyGovernorLifecycleBatch(
        createGovernorRuntimeState({
          captureHealthy: true,
          captureGeneration: 1,
          descriptorReady: true,
        }),
        ESTIMATE_CROSS_SIGNALS,
        POLICY as never,
      );
      const settled = pre.observes.find((o) => o.wouldMutate === true);
      expect(settled).toBeDefined();
      const seed = openGovernorReceiptStore(receiptDb);
      const seeded = seed.appendObserve({
        observe: settled!,
        sessionId: "old-session",
        threadId: "th_auto",
      });
      expect(seeded.inserted).toBe(true);
      expect(seeded.receipt.handoffOutcome?.kind).toBe("scheduled");
      seed.close();
    }

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(8300 + spawned.length, `c${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: receiptDb,
      wrapperLog: {
        info: (m: string) => wrapperLogLines.push(m),
        warn: (m: string) => wrapperLogLines.push(m),
        warningCount: () => 0,
        path: "/tmp/fake.log",
      } as never,
      onHandoffResult: () => {
        throw new Error("no handoff in this test");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    // Re-tail the same classification after "crash": must not schedule mutation.
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await new Promise((r) => setTimeout(r, 400));
    expect(mutationCalls).toBe(0);
    expect(
      wrapperLogLines.some(
        (l) =>
          l.includes("fail closed") ||
          l.includes("existing scheduled receipt") ||
          l.includes("no second auto mutation") ||
          l.includes("no re-schedule"),
      ),
    ).toBe(true);

    const store = openGovernorReceiptStore(receiptDb);
    const scheduledRows = store.listBySession("old-session").filter((r) => r.wouldMutate);
    expect(scheduledRows).toHaveLength(1);
    const scheduledRow = scheduledRows[0]!;
    expect(scheduledRow.handoffOutcome?.kind).toBe("scheduled");
    // LIM-80: a scheduled row with no attempt is claimable recoverable work.
    expect(store.getAttempt(scheduledRow.receiptId)).toBeNull();
    const { planRecovery } = await import("../../src/governor/recovery.js");
    const plan = planRecovery({
      receiptId: scheduledRow.receiptId,
      handoffOutcome: scheduledRow.handoffOutcome,
      attempt: null,
      observed: { self: { pid: process.pid, bootId: "test-boot", starttime: "1" } },
    });
    expect(plan.kind).toBe("claim_scheduled_work");
    store.close();

    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("mutation refuse attaches to exact receipt; concurrent would-mutate rows stay independent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-exact-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture(async () => ({
      ok: true,
      value: { kind: "error", reason: "record damage" },
    }));
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;

    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(8400 + spawned.length, `c${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: receiptDb,
      onHandoffResult: () => {
        throw new Error("no handoff");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    // First high-pressure settle.
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await new Promise((r) => setTimeout(r, 400));

    // Second distinct sampling (different sampling id / pressure) while first refused.
    lifecycleSink!([
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "req:second",
        providerUsage: {
          input_tokens: 10_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      { kind: "turn_settled", reason: "end_turn" },
    ]);
    await new Promise((r) => setTimeout(r, 400));

    // Wait for both settled wouldMutate receipts to terminalize (preview refuse).
    await waitFor(
      () => {
        const s = openGovernorReceiptStore(receiptDb);
        try {
          const settled = s
            .listBySession("old-session")
            .filter((r) => r.wouldMutate && r.observePhase === "settled_seam");
          return settled.length >= 2 && settled.every((r) => r.handoffOutcome?.kind === "mutation_refused");
        } finally {
          s.close();
        }
      },
      "both settled receipts terminal",
      12_000,
    );

    const store = openGovernorReceiptStore(receiptDb);
    const would = store.listBySession("old-session").filter((r) => r.wouldMutate && r.observePhase === "settled_seam");
    expect(would.length).toBeGreaterThanOrEqual(2);
    const first = would.find((r) => r.samplingId === "req:est");
    const second = would.find((r) => r.samplingId === "req:second");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.receiptId).not.toBe(second!.receiptId);
    // Each row terminalizes independently — assert exact outcomes, not textual equality.
    expect(first!.handoffOutcome?.kind).toBe("mutation_refused");
    expect(second!.handoffOutcome?.kind).toBe("mutation_refused");
    store.close();

    spawned[0]!.fireExit(0);
    await runPromise;
  }, 20_000);

  it("native summary attention → no LHC operation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-native-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const spawned: FakePty[] = [];
    let mutationSentinel = false;
    const sdk = sdkForCapture(async () => {
      mutationSentinel = true;
      return { ok: true, value: { kind: "ok" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const observes: string[] = [];

    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(8500 + spawned.length, `c${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: receiptDb,
      onGovernorObserve: (r) => observes.push(r.decision),
      onHandoffResult: () => {
        throw new Error("no handoff");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!([
      { kind: "native_compact_observed", summaryPreview: "compacted" },
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "req:nat",
        providerUsage: { input_tokens: 50_000 },
      },
      { kind: "turn_settled", reason: "end_turn" },
    ]);
    await new Promise((r) => setTimeout(r, 300));
    expect(mutationSentinel).toBe(false);
    expect(observes).toContain("native_summary_attention");
    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("provider missing/invalid clears stale estimate and usage (no wouldMutate)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-clear-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const spawned: FakePty[] = [];
    let mutationSentinel = false;
    const sdk = sdkForCapture(async () => {
      mutationSentinel = true;
      return { ok: true, value: { kind: "ok" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const observes: Array<{ decision: string; wouldMutate: boolean }> = [];

    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(8600 + spawned.length, `c${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: receiptDb,
      onGovernorObserve: (r) => observes.push({ decision: r.decision, wouldMutate: r.wouldMutate }),
      onHandoffResult: () => {
        throw new Error("no handoff");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!([
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "old",
        providerUsage: { input_tokens: 900_000 },
      },
      {
        kind: "post_measurement_estimate",
        tokens: 50_000,
        source: "provider_reported_output_tokens",
        mode: "set",
      },
      { kind: "sampling_observed", samplingId: "new" },
      { kind: "turn_settled", reason: "end_turn" },
    ]);
    await new Promise((r) => setTimeout(r, 300));
    expect(mutationSentinel).toBe(false);
    const settled = observes.filter((o) => o.decision === "no_provider_usage");
    expect(settled.length).toBeGreaterThanOrEqual(1);
    expect(observes.every((o) => o.wouldMutate === false)).toBe(true);
    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("respawn-unsafe launch: no mutation; receipt terminal mutation_refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-respawn-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const spawned: FakePty[] = [];
    let mutationSentinel = false;
    const sdk = sdkForCapture(async () => {
      mutationSentinel = true;
      return { ok: true, value: { kind: "ok" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;

    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    // Positional prompt makes respawnArgvSafety fail closed.
    const runPromise = run(["please do the thing"], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(8700 + spawned.length, `c${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: receiptDb,
      onHandoffResult: () => {
        throw new Error("must not handoff");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await new Promise((r) => setTimeout(r, 400));
    expect(mutationSentinel).toBe(false);

    const store = openGovernorReceiptStore(receiptDb);
    const would = store.listBySession("old-session").filter((r) => r.wouldMutate);
    expect(would).toHaveLength(1);
    expect(would[0]!.handoffOutcome?.kind).toBe("mutation_refused");
    expect(String((would[0]!.handoffOutcome as { detail?: string }).detail ?? "")).toMatch(
      /respawn_unsafe|positional/i,
    );
    store.close();

    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("cooldown: no mutation; receipt terminal mutation_deferred cooldown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-cool-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const spawned: FakePty[] = [];
    let mutationCalls = 0;
    // Arrangement: first settle rebuilds, handoff rolls back (rebuilt capture never-ready)
    // → autoBlockedUntilMs cooldown. Second distinct settle (req:cool2) must terminalize
    // mutation_deferred/cooldown with wouldMutate true — not a vacuous open-turn row.
    const sdk = sdkForCapture(async () => ({
      ok: true,
      value: { kind: "error", reason: "stop" },
    }));

    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-cool-roll-"));
    dirs.push(rolloutDir);
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
      const generation = 1;
      const isRebuilt = opts.knownRolloutPath !== undefined;
      const session = scriptedCaptureSession(
        opts,
        sdk,
        isRebuilt ? REBUILT_ID : "old-session",
        isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
        generation,
      );
      // Keep capture never-ready after rebuild so handoff fails/rolls back → cooldown.
      if (isRebuilt) {
        (session as { isCaptureReady: () => boolean }).isCaptureReady = () => false;
        (
          session as {
            getCaptureHealth: () => {
              phase: string;
              generation: number;
              reasons: string[];
              reasonCounts: Record<string, number>;
              durableLineOffset: number;
            };
          }
        ).getCaptureHealth = () => ({
          generation: 2,
          phase: "degraded",
          reasons: ["test"],
          reasonCounts: {},
          durableLineOffset: 0,
        });
      } else if (opts.onLifecycle !== undefined) {
        lifecycleSink = opts.onLifecycle;
      }
      return session;
    };

    sdk.threadView.previewCompact = vi.fn(async () => {
      mutationCalls += 1;
      return { ok: true, value: { kind: "ok" } };
    }) as never;

    const results: HandoffResult[] = [];
    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(8800 + spawned.length, `c${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: receiptDb,
      onHandoffResult: (r) => results.push(r),
      handoffTimeouts: {
        sigtermGraceMs: 200,
        sigkillWaitMs: 200,
        captureReadyTimeoutMs: 300,
        childLivenessTimeoutMs: 500,
        childStableWindowMs: 50,
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await waitFor(() => results.length >= 1, "first handoff result", 12_000);
    expect(mutationCalls).toBeGreaterThanOrEqual(1);

    const mutationAfterFirst = mutationCalls;
    // Second distinct pressure while cooldown active.
    lifecycleSink!([
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "req:cool2",
        providerUsage: {
          input_tokens: 20_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 100,
        },
      },
      {
        kind: "post_measurement_estimate",
        tokens: 100,
        source: "provider_reported_output_tokens",
        mode: "set",
      },
      {
        kind: "post_measurement_estimate",
        tokens: 50_000,
        source: "host_canonical_payload_byte_estimate",
        mode: "add",
      },
      { kind: "turn_settled", reason: "end_turn" },
    ]);
    await waitFor(
      () => {
        const s = openGovernorReceiptStore(receiptDb);
        try {
          return (
            s
              .listBySession("old-session")
              .find(
                (r) => r.samplingId === "req:cool2" && r.observePhase === "settled_seam" && r.wouldMutate === true,
              ) !== undefined
          );
        } finally {
          s.close();
        }
      },
      "settled cool2 receipt",
      8_000,
    );
    expect(mutationCalls).toBe(mutationAfterFirst);

    const store = openGovernorReceiptStore(receiptDb);
    const second = store
      .listBySession("old-session")
      .find((r) => r.samplingId === "req:cool2" && r.observePhase === "settled_seam" && r.wouldMutate === true);
    expect(second).toBeDefined();
    expect(second!.handoffOutcome?.kind).toBe("mutation_deferred");
    expect((second!.handoffOutcome as { reason?: string }).reason).toBe("cooldown");
    store.close();
    writeSpy.mockRestore();
    spawned[spawned.length - 1]!.fireExit(0);
    await runPromise;
  }, 25_000);

  it("wrapper_exiting before claim: no mutation; receipt mutation_deferred wrapper_exiting", async () => {
    // Direct coverage of runAutoOperation's early wrapper_exiting gate (claim path).
    // The lifecycle-side `if (exited) deferAuto("wrapper_exiting")` before setImmediate
    // is only reachable during teardown (exited flipped between insert and schedule);
    // that race cannot be forced without production-only timing and is not faked here.
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-wexit-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const spawned: FakePty[] = [];
    let mutationSentinel = false;
    const sdk = sdkForCapture(async () => {
      mutationSentinel = true;
      return { ok: true, value: { kind: "ok" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(8975 + spawned.length, `c${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: receiptDb,
      onBeforeAutoOperation: ({ markExited }) => {
        markExited();
      },
      onHandoffResult: () => {
        throw new Error("must not handoff");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await waitFor(
      () => {
        const s = openGovernorReceiptStore(receiptDb);
        try {
          const would = s
            .listBySession("old-session")
            .filter((r) => r.wouldMutate && r.observePhase === "settled_seam");
          return would.length >= 1 && would[0]!.handoffOutcome?.kind === "mutation_deferred";
        } finally {
          s.close();
        }
      },
      "wrapper_exiting terminal",
      8_000,
    );
    expect(mutationSentinel).toBe(false);

    const store = openGovernorReceiptStore(receiptDb);
    const would = store.listBySession("old-session").filter((r) => r.wouldMutate && r.observePhase === "settled_seam");
    expect(would).toHaveLength(1);
    expect(would[0]!.handoffOutcome).toMatchObject({
      kind: "mutation_deferred",
      reason: "wrapper_exiting",
    });
    store.close();
    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("handoff-in-progress before claim: no mutation; receipt mutation_deferred handoff_in_progress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-handoff-ip-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const spawned: FakePty[] = [];
    let mutationSentinel = false;
    const sdk = sdkForCapture(async () => {
      mutationSentinel = true;
      return { ok: true, value: { kind: "ok" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(8950 + spawned.length, `c${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: receiptDb,
      onBeforeAutoOperation: ({ markHandoffInProgress, clearHandoffInProgress }) => {
        markHandoffInProgress();
        // Clear after the gate observes the race so run() can tear down on child exit.
        setImmediate(() => clearHandoffInProgress());
      },
      onHandoffResult: () => {
        throw new Error("must not handoff");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await new Promise((r) => setTimeout(r, 500));
    expect(mutationSentinel).toBe(false);

    const store = openGovernorReceiptStore(receiptDb);
    const would = store.listBySession("old-session").filter((r) => r.wouldMutate);
    expect(would).toHaveLength(1);
    expect(would[0]!.handoffOutcome).toMatchObject({
      kind: "mutation_deferred",
      reason: "handoff_in_progress",
    });
    store.close();
    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("command-guard race: no mutation; receipt mutation_deferred command_guard_busy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-guard-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const spawned: FakePty[] = [];
    let mutationSentinel = false;
    const sdk = sdkForCapture(async () => {
      mutationSentinel = true;
      return { ok: true, value: { kind: "ok" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const { CommandInFlightGuard } = await import("../../src/wrapper/command-guard.js");
    const guard = new CommandInFlightGuard();
    expect(guard.tryAcquire("manual-status", Date.now())).toBe(true);

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(8900 + spawned.length, `c${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: receiptDb,
      commandGuard: guard,
      onHandoffResult: () => {
        throw new Error("must not handoff");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await new Promise((r) => setTimeout(r, 500));
    expect(mutationSentinel).toBe(false);

    const store = openGovernorReceiptStore(receiptDb);
    const would = store.listBySession("old-session").filter((r) => r.wouldMutate);
    expect(would).toHaveLength(1);
    expect(would[0]!.handoffOutcome).toMatchObject({
      kind: "mutation_deferred",
      reason: "command_guard_busy",
    });
    store.close();
    guard.release();
    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("auto-operation already scheduled: second receipt mutation_deferred auto_operation_in_flight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-inflight-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const spawned: FakePty[] = [];
    let releaseMutation: (() => void) | undefined;
    const mutationGate = new Promise<void>((r) => {
      releaseMutation = r;
    });
    let mutationStarted = 0;
    const sdk = sdkForCapture(async () => {
      mutationStarted += 1;
      await mutationGate;
      return { ok: true, value: { kind: "error", reason: "held then refuse" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(9000 + spawned.length, `c${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: receiptDb,
      onHandoffResult: () => {
        throw new Error("no handoff");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    // Two settled wouldMutate decisions in ONE lifecycle batch so the second
    // observe sees autoOperationScheduled=true before setImmediate runs
    // runAutoOperation (which would set operationInFlight and force wouldMutate=false).
    lifecycleSink!([
      ...ESTIMATE_CROSS_SIGNALS,
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "req:inflight2",
        providerUsage: {
          // First settle pressure was 5500; need +retryGrowth (1000) and above upper (5000).
          input_tokens: 8_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 100,
        },
      },
      {
        kind: "post_measurement_estimate",
        tokens: 100,
        source: "provider_reported_output_tokens",
        mode: "set",
      },
      {
        kind: "post_measurement_estimate",
        tokens: 2_000,
        source: "host_canonical_payload_byte_estimate",
        mode: "add",
      },
      { kind: "turn_settled", reason: "end_turn" },
    ]);
    await new Promise((r) => setTimeout(r, 200));
    // Only the first auto op should claim mutation.
    expect(mutationStarted).toBe(1);

    const store = openGovernorReceiptStore(receiptDb);
    // Prefer settled wouldMutate row — open_turn classifications share samplingId
    // with wouldMutate=false and must not be confused with the schedule owner.
    const second = store
      .listBySession("old-session")
      .find((r) => r.samplingId === "req:inflight2" && r.wouldMutate === true);
    expect(second).toBeDefined();
    expect(second?.handoffOutcome).toMatchObject({
      kind: "mutation_deferred",
      reason: "auto_operation_in_flight",
    });
    // First receipt should still be scheduled or terminal after claim — not the second's owner.
    const first = store.listBySession("old-session").find((r) => r.samplingId === "req:est" && r.wouldMutate === true);
    expect(first?.receiptId).not.toBe(second?.receiptId);
    store.close();

    releaseMutation?.();
    await new Promise((r) => setTimeout(r, 300));
    spawned[0]!.fireExit(0);
    await runPromise;
  }, 20_000);

  it("outcome-attach failure after mutation starts: loud health; receipt remains scheduled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-attachfail-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const spawned: FakePty[] = [];
    let mutationStarted = false;
    const sdk = sdkForCapture(async () => {
      mutationStarted = true;
      return { ok: true, value: { kind: "error", reason: "record damage" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const wrapperLogLines: string[] = [];
    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(9100 + spawned.length, `c${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: receiptDb,
      wrapperLog: {
        info: (m: string) => wrapperLogLines.push(m),
        warn: (m: string) => wrapperLogLines.push(m),
        warningCount: () => wrapperLogLines.filter((l) => /warn|undurable|failed/i.test(l)).length,
        path: "/tmp/fake.log",
      } as never,
      governorReceiptStoreHook: (store) => ({
        ...store,
        attachHandoffOutcome: () => {
          throw new Error("injected attach failure");
        },
      }),
      onHandoffResult: () => {
        throw new Error("no handoff");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await waitFor(() => mutationStarted, "mutation started");
    await new Promise((r) => setTimeout(r, 400));

    expect(wrapperLogLines.some((l) => l.includes("outcome NOT durable") || l.includes("attach failed"))).toBe(true);

    // Re-open store without the failing hook: receipt still scheduled (unresolved).
    const store = openGovernorReceiptStore(receiptDb);
    const would = store.listBySession("old-session").filter((r) => r.wouldMutate);
    expect(would).toHaveLength(1);
    expect(would[0]!.handoffOutcome?.kind).toBe("scheduled");
    store.close();

    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("true append-failure-after-open: store open ok, append throws → no mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-appendfail-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const spawned: FakePty[] = [];
    let mutationSentinel = false;
    const sdk = sdkForCapture(async () => {
      mutationSentinel = true;
      return { ok: true, value: { kind: "ok" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const wrapperLogLines: string[] = [];
    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(9200 + spawned.length, `c${spawned.length}`, args, true);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: receiptDb,
      wrapperLog: {
        info: (m: string) => wrapperLogLines.push(m),
        warn: (m: string) => wrapperLogLines.push(m),
        warningCount: () => 0,
        path: "/tmp/fake.log",
      } as never,
      governorReceiptStoreHook: (store) => ({
        ...store,
        appendObserve: () => {
          throw new Error("injected append failure after open");
        },
      }),
      onHandoffResult: () => {
        throw new Error("must not handoff");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await new Promise((r) => setTimeout(r, 400));
    expect(mutationSentinel).toBe(false);
    expect(
      wrapperLogLines.some((l) => l.includes("receipt append failed") || l.includes("durable receipt unavailable")),
    ).toBe(true);
    // Store open succeeded — no "receipt store unavailable" required.
    expect(wrapperLogLines.some((l) => l.includes("receipt store unavailable"))).toBe(false);

    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);
});
