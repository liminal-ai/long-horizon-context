/**
 * LIM-64 production-path wrapper/capture integration (not direct store-API-only proof).
 *
 * Drives run() + lifecycle through the real watcher/capture sink path and
 * asserts durable receipts, exact outcome binding, conservative replay (no
 * second auto mutation; scheduled rows classify as recoverable, LIM-80), and
 * no mutation without a durable receipt.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import { type RecoveryArtifacts, type RecoveryStage, storedViewFingerprint } from "../../src/governor/recovery.js";
import type { GovernorHandoffOutcome } from "../../src/governor/types.js";
import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import { rolloutPathForSession } from "../../src/rollout/sessions-index.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import type {
  ProbeProcessIdentity,
  ProcessIdentity,
  ProcessLivenessResult,
} from "../../src/runtime/process-identity.js";
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

/** A StoredView `describe()` payload; fingerprint is stable per (viewId, createdAt). */
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

/**
 * Write a structurally valid rebuilt rollout the recovery port + inspection
 * accept: chained uuids, every sessionId === reserved id, trailing runtime-note
 * exactly the durable receipt. Prefix = all-but-trailing.
 */
function writeValidRollout(path: string, sessionId: string, durableReceipt: string): { totalByteLength: number } {
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
  return { totalByteLength: Buffer.byteLength(body, "utf8") };
}

/**
 * A writeRebuiltRollout spy that produces a valid rollout at the reserved path
 * (projectsRoot + encoded cwd + `${newSessionId}.jsonl`), matching the port's
 * reservation so runContextMutation reaches a verified `rebuilt`.
 */
function validWriteSpy(projectsRoot: string) {
  return vi
    .spyOn(writeRebuilt, "writeRebuiltRollout")
    .mockImplementation(async (input: Parameters<typeof writeRebuilt.writeRebuiltRollout>[0]) => {
      const sessionId = input.newSessionId ?? REBUILT_ID;
      const durableReceipt = input.receipt?.text ?? "";
      const path = rolloutPathForSession(projectsRoot, input.cwd, sessionId);
      const { totalByteLength } = writeValidRollout(path, sessionId, durableReceipt);
      return {
        sessionId,
        rolloutPath: path,
        lineCount: 3,
        expectedReintakeLines: 3,
        replayedPrefixLines: 2,
        prefixBoundary: { kind: "verified" as const, lineCount: 2, byteLength: 0, sha256: "unused-in-verify" },
        totalByteLength,
      };
    });
}

function sdkForCapture(preview?: () => Promise<unknown>) {
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

    const rolloutProjectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-proj-"));
    dirs.push(rolloutProjectsRoot);
    const writeSpy = validWriteSpy(rolloutProjectsRoot);

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
      recoveryProjectsRoot: rolloutProjectsRoot,
      recoverySessionIdFn: () => REBUILT_ID,
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

  it("exact replay of a scheduled receipt drives recovery (claim + open attempt on transient failure), not a permanent latch", async () => {
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
    // Re-tail the same classification after "crash": exact replay of a scheduled
    // receipt is no longer a permanent latch — it drives a recovery pass that
    // claims the receipt and records a baseline. Here the SDK preview errors,
    // which is a TRANSIENT pre-mutation failure: the attempt must stay OPEN at
    // operation_claimed (never terminalized), and the receipt stays scheduled.
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);

    await waitFor(
      () => {
        const s = openGovernorReceiptStore(receiptDb);
        try {
          const row = s.listBySession("old-session").find((r) => r.wouldMutate);
          return row !== undefined && s.getAttempt(row.receiptId) !== null;
        } finally {
          s.close();
        }
      },
      "scheduled receipt claimed by recovery (open attempt)",
      8_000,
    );

    // Recovery ran the preview at least once (no LHC compact, no handoff), proving
    // no fail-closed latch. The transient failure did NOT terminalize.
    expect(mutationCalls).toBeGreaterThanOrEqual(1);
    expect(sdk.threadView.compact).not.toHaveBeenCalled();
    expect(wrapperLogLines.some((l) => l.includes("scheduling recovery") || l.includes("left OPEN"))).toBe(true);

    const store = openGovernorReceiptStore(receiptDb);
    const recovered = store.listBySession("old-session").filter((r) => r.wouldMutate);
    expect(recovered).toHaveLength(1);
    const row = recovered[0]!;
    // Receipt stays scheduled; attempt stays OPEN at the truthful durable stage.
    expect(row.handoffOutcome?.kind).toBe("scheduled");
    const attempt = store.getAttempt(row.receiptId);
    expect(attempt).not.toBeNull();
    expect(attempt?.stage).toBe("operation_claimed");
    expect(attempt?.terminalOutcomeKind).toBeNull();
    expect(attempt?.artifacts.preMutationViewFingerprint).toBeDefined();
    store.close();

    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("transient preview failure leaves each receipt OPEN independently (own attempt, no cross-contamination)", async () => {
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

    // A preview error is TRANSIENT: each settled receipt gets its OWN open attempt
    // at operation_claimed and stays scheduled (never terminalized).
    await waitFor(
      () => {
        const s = openGovernorReceiptStore(receiptDb);
        try {
          const settled = s
            .listBySession("old-session")
            .filter((r) => r.wouldMutate && r.observePhase === "settled_seam");
          return (
            settled.length >= 2 &&
            settled.every((r) => r.handoffOutcome?.kind === "scheduled" && s.getAttempt(r.receiptId) !== null)
          );
        } finally {
          s.close();
        }
      },
      "both settled receipts claimed with open attempts",
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
    // Each receipt has its OWN independent open attempt; neither terminalized.
    const firstAttempt = store.getAttempt(first!.receiptId);
    const secondAttempt = store.getAttempt(second!.receiptId);
    expect(firstAttempt?.stage).toBe("operation_claimed");
    expect(secondAttempt?.stage).toBe("operation_claimed");
    expect(firstAttempt?.attemptId).not.toBe(secondAttempt?.attemptId);
    expect(first!.handoffOutcome?.kind).toBe("scheduled");
    expect(second!.handoffOutcome?.kind).toBe("scheduled");
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
    const rolloutProjectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-cool-proj-"));
    dirs.push(rolloutProjectsRoot);
    const writeSpy = validWriteSpy(rolloutProjectsRoot);

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
      recoveryProjectsRoot: rolloutProjectsRoot,
      recoverySessionIdFn: () => REBUILT_ID,
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

  it("terminal completion that cannot be persisted stays scheduled, loudly (proven-terminal handoff success)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-completefail-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const rolloutProjectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-completefail-proj-"));
    dirs.push(rolloutProjectsRoot);
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    const writeSpy = validWriteSpy(rolloutProjectsRoot);
    let liveSessionId = "old-session";
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const wrapperLogLines: string[] = [];
    const results: HandoffResult[] = [];
    mocks.captureFactory = (opts) => {
      const isRebuilt = opts.knownRolloutPath !== undefined;
      if (isRebuilt) liveSessionId = REBUILT_ID;
      const session = scriptedCaptureSession(
        opts,
        sdk,
        liveSessionId,
        isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
        isRebuilt ? 2 : 1,
      );
      (session as { getRolloutInfo: () => { path: string; sessionId: string } }).getRolloutInfo = () => ({
        path: isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
        sessionId: liveSessionId,
      });
      if (opts.onLifecycle !== undefined && !isRebuilt) lifecycleSink = opts.onLifecycle;
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
      recoveryProjectsRoot: rolloutProjectsRoot,
      recoverySessionIdFn: () => REBUILT_ID,
      wrapperLog: {
        info: (m: string) => wrapperLogLines.push(m),
        warn: (m: string) => wrapperLogLines.push(m),
        warningCount: () => wrapperLogLines.filter((l) => /warn|undurable|failed/i.test(l)).length,
        path: "/tmp/fake.log",
      } as never,
      // A PROVEN-terminal completion (final handoff result) whose completeAttempt
      // cannot be persisted must be loud and leave the receipt scheduled.
      governorReceiptStoreHook: (store) => ({
        ...store,
        completeAttempt: () => {
          throw new Error("injected completeAttempt failure");
        },
      }),
      onHandoffResult: (r) => results.push(r),
      handoffTimeouts: {
        sigtermGraceMs: 500,
        sigkillWaitMs: 300,
        captureReadyTimeoutMs: 2_000,
        childLivenessTimeoutMs: 3_000,
        childStableWindowMs: 100,
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await waitFor(() => results.length === 1, "handoff completed", 12_000);
    expect(results[0]!.kind).toBe("success");
    await new Promise((r) => setTimeout(r, 200));

    // The handoff happened, but its terminal outcome could not be recorded.
    expect(wrapperLogLines.some((l) => l.includes("outcome NOT durable"))).toBe(true);

    // Re-open store without the failing hook: receipt still scheduled (unresolved),
    // recoverable on a later pass — never a silent success.
    const store = openGovernorReceiptStore(receiptDb);
    const would = store.listBySession("old-session").filter((r) => r.wouldMutate);
    expect(would).toHaveLength(1);
    expect(would[0]!.handoffOutcome?.kind).toBe("scheduled");
    store.close();
    writeSpy.mockRestore();

    spawned[spawned.length - 1]!.fireExit(0);
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

// ── LIM-80 Slice 3A recovery (production run path) ───────────────────────
const SELF_ID: ProcessIdentity = { pid: 314159, bootId: "self-boot", starttime: "100" };
const FOREIGN: ProcessIdentity = { pid: 99999, bootId: "other-boot", starttime: "200" };

function identityProbe(map: Record<number, ProcessLivenessResult>): ProbeProcessIdentity {
  return (pid: number) => map[pid] ?? { ok: false, code: "not_found", message: `no pid ${pid}` };
}

async function settledWouldMutateObserve() {
  const { applyGovernorLifecycleBatch, createGovernorRuntimeState } = await import(
    "../../src/governor/observe-state.js"
  );
  const pre = applyGovernorLifecycleBatch(
    createGovernorRuntimeState({ captureHealthy: true, captureGeneration: 1, descriptorReady: true }),
    ESTIMATE_CROSS_SIGNALS,
    POLICY as never,
  );
  return pre.observes.find((o) => o.wouldMutate === true)!;
}

/** Seed a scheduled receipt with one durable attempt at a chosen stage/owner. */
async function seedReceiptWithAttempt(
  receiptDb: string,
  opts: {
    sessionId: string;
    threadId: string;
    owner: ProcessIdentity;
    stage?: RecoveryStage;
    artifacts?: RecoveryArtifacts;
    receiptTerminal?: GovernorHandoffOutcome;
  },
): Promise<string> {
  const store = openGovernorReceiptStore(receiptDb);
  try {
    const observe = await settledWouldMutateObserve();
    const { receipt } = store.appendObserve({ observe, sessionId: opts.sessionId, threadId: opts.threadId });
    const receiptId = receipt.receiptId;
    const claim = store.claimAttempt({ receiptId, owner: opts.owner });
    if (claim.kind !== "claimed") throw new Error(`seed claim ${claim.kind}`);
    const attemptId = claim.attempt.attemptId;
    if (opts.stage !== undefined && opts.stage !== "operation_claimed" && opts.stage !== "terminal") {
      const adv = store.advanceAttempt({ receiptId, attemptId, stage: opts.stage, artifacts: opts.artifacts ?? {} });
      if (adv.kind !== "advanced" && adv.kind !== "unchanged") throw new Error(`seed advance ${adv.kind}`);
    } else if (opts.artifacts !== undefined) {
      store.advanceAttempt({ receiptId, attemptId, stage: "operation_claimed", artifacts: opts.artifacts });
    }
    if (opts.receiptTerminal !== undefined) store.attachHandoffOutcome(receiptId, opts.receiptTerminal);
    return receiptId;
  } finally {
    store.close();
  }
}

function baseRunOptions(receiptDb: string, spawned: FakePty[], basePid: number) {
  return {
    claudeBin: "fake-claude",
    spawnPty: ((_file: string, args: string[]) => {
      const fake = makeFakePty(basePid + spawned.length, `c${spawned.length}`, args, true);
      spawned.push(fake);
      return fake as never;
    }) as never,
    stdin: fakeStream(),
    stdout: fakeStream() as never,
    stderr: fakeStream() as never,
    noInference: true,
    resolvedContextPolicy: POLICY as never,
    governorReceiptDbPath: receiptDb,
  };
}

describe("LIM-80 Slice 3A recovery (production wrapper path)", () => {
  const savedHome = process.env.CC_LHC_HOME;
  beforeEach(() => {
    mocks.registerLineage.mockClear();
    mocks.captureFactory = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-rec-home-"));
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

  it("startup scan reclaims a kernel-proven-dead foreign owner and re-prepares (preview error → stays open under new owner)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rec-reclaim-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    // No baseline recorded → owned resume is reprepare_from_scratch.
    const receiptId = await seedReceiptWithAttempt(receiptDb, {
      sessionId: "old-session",
      threadId: "th_auto",
      owner: FOREIGN,
      stage: "operation_claimed",
    });

    const spawned: FakePty[] = [];
    let previewCalls = 0;
    const sdk = sdkForCapture(async () => {
      previewCalls += 1;
      return { ok: true, value: { kind: "error", reason: "stop" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      ...baseRunOptions(receiptDb, spawned, 9300),
      readProcessIdentity: identityProbe({
        [process.pid]: { ok: true, identity: SELF_ID },
        [FOREIGN.pid]: { ok: false, code: "not_found", message: "gone" },
      }),
      onHandoffResult: () => {
        throw new Error("no handoff (preview errors)");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    // Reclaim moves ownership to self (epoch 2). The re-prepare then hits a
    // TRANSIENT preview error, so the attempt stays OPEN under the new owner.
    await waitFor(
      () => {
        const s = openGovernorReceiptStore(receiptDb);
        try {
          const a = s.getAttempt(receiptId);
          return a?.owner.pid === SELF_ID.pid && a?.claimEpoch === 2 && previewCalls >= 1;
        } finally {
          s.close();
        }
      },
      "receipt reclaimed (open under new owner)",
      8_000,
    );
    expect(previewCalls).toBeGreaterThanOrEqual(1);
    expect(sdk.threadView.compact).not.toHaveBeenCalled();

    const store = openGovernorReceiptStore(receiptDb);
    const attempt = store.getAttempt(receiptId);
    // Reclaimed but NOT terminalized: transient failure stays open at the
    // truthful durable stage for a later recovery pass.
    expect(attempt?.stage).toBe("operation_claimed");
    expect(attempt?.terminalOutcomeKind).toBeNull();
    expect(attempt?.owner).toEqual(SELF_ID);
    expect(attempt?.claimEpoch).toBe(2);
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("scheduled");
    store.close();

    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("startup scan recovers a scheduled receipt with NO attempt (crash after insert, before claim) without any replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rec-preclaim-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    // Seed a scheduled receipt with NO durable attempt for the current session.
    {
      const seed = openGovernorReceiptStore(receiptDb);
      const inserted = seed.appendObserve({
        observe: await settledWouldMutateObserve(),
        sessionId: "old-session",
        threadId: "th_auto",
      });
      expect(inserted.inserted).toBe(true);
      expect(inserted.receipt.handoffOutcome?.kind).toBe("scheduled");
      expect(seed.getAttempt(inserted.receipt.receiptId)).toBeNull();
      seed.close();
    }

    const spawned: FakePty[] = [];
    let previewCalls = 0;
    const sdk = sdkForCapture(async () => {
      previewCalls += 1;
      return { ok: true, value: { kind: "error", reason: "stop" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      ...baseRunOptions(receiptDb, spawned, 9380),
      readProcessIdentity: identityProbe({ [process.pid]: { ok: true, identity: SELF_ID } }),
      onHandoffResult: () => {
        throw new Error("no handoff (preview errors)");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    // ONLY session_bound — no ESTIMATE re-tail. Startup scan alone must recover it.
    lifecycleSink!(BOUND_SIGNALS);
    await waitFor(
      () => {
        const s = openGovernorReceiptStore(receiptDb);
        try {
          const row = s.listBySession("old-session").find((r) => r.wouldMutate);
          return row !== undefined && s.getAttempt(row.receiptId) !== null;
        } finally {
          s.close();
        }
      },
      "startup scan claimed the pre-claim scheduled receipt",
      8_000,
    );
    // Recovered by the startup scan (claim), not by replay. Transient preview error
    // leaves the attempt OPEN.
    expect(previewCalls).toBeGreaterThanOrEqual(1);
    const store = openGovernorReceiptStore(receiptDb);
    const row = store.listBySession("old-session").find((r) => r.wouldMutate)!;
    const attempt = store.getAttempt(row.receiptId);
    expect(attempt).not.toBeNull();
    expect(attempt?.owner).toEqual(SELF_ID);
    expect(attempt?.stage).toBe("operation_claimed");
    expect(row.handoffOutcome?.kind).toBe("scheduled");
    store.close();

    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("startup scan waits for a live foreign owner: no reclaim, no mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rec-wait-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const receiptId = await seedReceiptWithAttempt(receiptDb, {
      sessionId: "old-session",
      threadId: "th_auto",
      owner: FOREIGN,
      stage: "operation_claimed",
    });

    const spawned: FakePty[] = [];
    let previewCalls = 0;
    const sdk = sdkForCapture(async () => {
      previewCalls += 1;
      return { ok: true, value: { kind: "ok" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      ...baseRunOptions(receiptDb, spawned, 9350),
      readProcessIdentity: identityProbe({
        [process.pid]: { ok: true, identity: SELF_ID },
        [FOREIGN.pid]: { ok: true, identity: FOREIGN },
      }),
      onHandoffResult: () => {
        throw new Error("no handoff");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 500));
    expect(previewCalls).toBe(0);

    const store = openGovernorReceiptStore(receiptDb);
    const attempt = store.getAttempt(receiptId);
    // Live owner is never stolen: unchanged owner + epoch, still scheduled.
    expect(attempt?.owner).toEqual(FOREIGN);
    expect(attempt?.claimEpoch).toBe(1);
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("scheduled");
    store.close();

    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("startup scan never touches another session's open receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rec-filter-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    // Owned by a dead process but belongs to a DIFFERENT session: must be ignored.
    const foreignReceipt = await seedReceiptWithAttempt(receiptDb, {
      sessionId: "some-other-session",
      threadId: "th_other",
      owner: FOREIGN,
      stage: "operation_claimed",
    });

    const spawned: FakePty[] = [];
    let previewCalls = 0;
    const sdk = sdkForCapture(async () => {
      previewCalls += 1;
      return { ok: true, value: { kind: "ok" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      ...baseRunOptions(receiptDb, spawned, 9400),
      readProcessIdentity: identityProbe({
        [process.pid]: { ok: true, identity: SELF_ID },
        [FOREIGN.pid]: { ok: false, code: "not_found", message: "gone" },
      }),
      onHandoffResult: () => {
        throw new Error("no handoff");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 500));
    expect(previewCalls).toBe(0);

    const store = openGovernorReceiptStore(receiptDb);
    const attempt = store.getAttempt(foreignReceipt);
    expect(attempt?.owner).toEqual(FOREIGN);
    expect(attempt?.stage).toBe("operation_claimed");
    expect(store.getById(foreignReceipt)?.handoffOutcome?.kind).toBe("scheduled");
    store.close();

    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("terminal receipt with a stale open attempt: bookkeeping aligned, no mutation replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rec-terminal-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const receiptId = await seedReceiptWithAttempt(receiptDb, {
      sessionId: "old-session",
      threadId: "th_auto",
      owner: SELF_ID,
      stage: "operation_claimed",
      receiptTerminal: { kind: "mutation_refused", detail: "already refused before crash" },
    });

    const spawned: FakePty[] = [];
    let previewCalls = 0;
    const sdk = sdkForCapture(async () => {
      previewCalls += 1;
      return { ok: true, value: { kind: "ok" } };
    });
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    mocks.captureFactory = (opts) => {
      const session = scriptedCaptureSession(opts, sdk, "old-session", "/tmp/old-session.jsonl", 1);
      if (opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      ...baseRunOptions(receiptDb, spawned, 9450),
      readProcessIdentity: identityProbe({ [process.pid]: { ok: true, identity: SELF_ID } }),
      onHandoffResult: () => {
        throw new Error("no handoff");
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    await waitFor(
      () => {
        const s = openGovernorReceiptStore(receiptDb);
        try {
          return s.getAttempt(receiptId)?.stage === "terminal";
        } finally {
          s.close();
        }
      },
      "attempt bookkeeping aligned",
      8_000,
    );
    // Terminal receipt is authoritative: no mutation replay.
    expect(previewCalls).toBe(0);
    expect(sdk.threadView.compact).not.toHaveBeenCalled();

    const store = openGovernorReceiptStore(receiptDb);
    const attempt = store.getAttempt(receiptId);
    expect(attempt?.stage).toBe("terminal");
    expect(attempt?.terminalOutcomeKind).toBe("mutation_refused");
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("mutation_refused");
    store.close();

    spawned[0]!.fireExit(0);
    await runPromise;
  }, 15_000);

  it("installed-view recovery re-materializes the rollout and reaches handoff success — no second compact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rec-reconcile-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const rolloutProjectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-rec-proj-"));
    dirs.push(rolloutProjectsRoot);
    const reservedPath = rolloutPathForSession(rolloutProjectsRoot, process.cwd(), REBUILT_ID);
    const installedFp = storedViewFingerprint(storedViewValue("v1") as never);

    // Crash after compact landed + reservation, before the rollout write.
    const receiptId = await seedReceiptWithAttempt(receiptDb, {
      sessionId: "old-session",
      threadId: "th_auto",
      owner: SELF_ID,
      stage: "view_installed",
      artifacts: {
        threadId: "th_auto",
        oldSessionId: "old-session",
        viewId: "v1",
        installedViewFingerprint: installedFp,
        rebuiltSessionId: REBUILT_ID,
        rebuiltRolloutPath: reservedPath,
        durableReceipt: "[lhc compact:auto] recovered.",
      },
    });

    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    const writeSpy = validWriteSpy(rolloutProjectsRoot);
    let liveSessionId = "old-session";
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const results: HandoffResult[] = [];
    mocks.captureFactory = (opts) => {
      const isRebuilt = opts.knownRolloutPath !== undefined;
      if (isRebuilt) liveSessionId = REBUILT_ID;
      const session = scriptedCaptureSession(
        opts,
        sdk,
        liveSessionId,
        isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
        isRebuilt ? 2 : 1,
      );
      (session as { getRolloutInfo: () => { path: string; sessionId: string } }).getRolloutInfo = () => ({
        path: isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
        sessionId: liveSessionId,
      });
      if (opts.onLifecycle !== undefined && !isRebuilt) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      ...baseRunOptions(receiptDb, spawned, 9500),
      recoveryProjectsRoot: rolloutProjectsRoot,
      recoverySessionIdFn: () => REBUILT_ID,
      readProcessIdentity: identityProbe({ [process.pid]: { ok: true, identity: SELF_ID } }),
      onHandoffResult: (r) => results.push(r),
      handoffTimeouts: {
        sigtermGraceMs: 500,
        sigkillWaitMs: 300,
        captureReadyTimeoutMs: 2_000,
        childLivenessTimeoutMs: 3_000,
        childStableWindowMs: 100,
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    lifecycleSink!(BOUND_SIGNALS);
    await waitFor(() => results.length === 1, "recovery handoff", 12_000);
    expect(results[0]!.kind).toBe("success");
    // The installed view is authoritative: recovery NEVER compacts again.
    expect(sdk.threadView.compact).not.toHaveBeenCalled();
    expect(sdk.threadView.previewCompact).not.toHaveBeenCalled();

    const store = openGovernorReceiptStore(receiptDb);
    expect(store.getById(receiptId)?.handoffOutcome).toEqual({
      kind: "handoff_success",
      newSessionId: REBUILT_ID,
      flushedInputBytes: expect.any(Number),
    });
    expect(store.getAttempt(receiptId)?.stage).toBe("terminal");
    store.close();

    spawned[spawned.length - 1]!.fireExit(0);
    await runPromise;
    writeSpy.mockRestore();
  }, 20_000);

  it("exact replay and startup scan coalesce into a single recovery (one preview, one compact, one handoff)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rec-coalesce-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const rolloutProjectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-coalesce-proj-"));
    dirs.push(rolloutProjectsRoot);
    // Seed an attempt at operation_claimed (no baseline → reprepare) owned by self,
    // so BOTH the startup scan (open attempt) and an exact re-tail target it. A
    // clean recovery reaches ONE handoff success; coalescing is proven by exactly
    // one preview/compact/handoff despite two triggers.
    const receiptId = await seedReceiptWithAttempt(receiptDb, {
      sessionId: "old-session",
      threadId: "th_auto",
      owner: SELF_ID,
      stage: "operation_claimed",
    });

    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    const writeSpy = validWriteSpy(rolloutProjectsRoot);
    let liveSessionId = "old-session";
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const results: HandoffResult[] = [];
    mocks.captureFactory = (opts) => {
      const isRebuilt = opts.knownRolloutPath !== undefined;
      if (isRebuilt) liveSessionId = REBUILT_ID;
      const session = scriptedCaptureSession(
        opts,
        sdk,
        liveSessionId,
        isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
        isRebuilt ? 2 : 1,
      );
      (session as { getRolloutInfo: () => { path: string; sessionId: string } }).getRolloutInfo = () => ({
        path: isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
        sessionId: liveSessionId,
      });
      if (opts.onLifecycle !== undefined && !isRebuilt) lifecycleSink = opts.onLifecycle;
      return session;
    };

    const runPromise = run([], {
      ...baseRunOptions(receiptDb, spawned, 9550),
      recoveryProjectsRoot: rolloutProjectsRoot,
      recoverySessionIdFn: () => REBUILT_ID,
      readProcessIdentity: identityProbe({ [process.pid]: { ok: true, identity: SELF_ID } }),
      onHandoffResult: (r) => results.push(r),
      handoffTimeouts: {
        sigtermGraceMs: 500,
        sigkillWaitMs: 300,
        captureReadyTimeoutMs: 2_000,
        childLivenessTimeoutMs: 3_000,
        childStableWindowMs: 100,
      },
    });

    await waitFor(() => lifecycleSink !== undefined, "sink");
    // session_bound → startup scan; the same batch re-tails the classification.
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await waitFor(() => results.length === 1, "single coalesced recovery handoff", 12_000);
    await new Promise((r) => setTimeout(r, 300));

    // Coalesced: exactly ONE handoff, one preview, one compact despite two triggers.
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("success");
    expect(sdk.threadView.previewCompact).toHaveBeenCalledTimes(1);
    expect(sdk.threadView.compact).toHaveBeenCalledTimes(1);

    const store = openGovernorReceiptStore(receiptDb);
    expect(store.getAttempt(receiptId)?.stage).toBe("terminal");
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("handoff_success");
    store.close();
    writeSpy.mockRestore();

    spawned[spawned.length - 1]!.fireExit(0);
    await runPromise;
  }, 20_000);
});
