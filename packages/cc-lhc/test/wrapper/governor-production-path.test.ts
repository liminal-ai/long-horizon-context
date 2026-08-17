/**
 * LIM-64 production-path wrapper/capture integration (not direct store-API-only proof).
 *
 * Drives run() + lifecycle through the real watcher/capture sink path and
 * asserts durable receipts, exact outcome binding, conservative replay (no
 * second auto mutation; scheduled rows classify as recoverable, LIM-80), and
 * no mutation without a durable receipt.
 */

import {
  existsSync,
  writeSync as fsWriteSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectRolloutBytes } from "../../src/commands/recovery-ops.js";
import { type GovernorReceiptStore, openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
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
import { createInputJournal, type InputJournalDeps, readInputJournal } from "../../src/wrapper/input-journal.js";
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
  ready = true,
  turnOpen = false,
): CaptureSession {
  const stats = { ...emptyCaptureStats(), threadId: "th_auto" };
  const phase = ready ? ("ready" as const) : ("degraded" as const);
  return {
    stats,
    getCommandContext: () => ({
      captureDisabled: false,
      stats,
      sdk: sdk as Lhc,
      threadRef: { threadId: "th_auto", registryPath: "/tmp/reg.sqlite" },
      captureDegraded: !ready,
      captureGeneration: generation,
      capturePhase: phase,
    }),
    getRolloutInfo: () => ({ path: rolloutPath, sessionId }),
    isTurnOpen: () => turnOpen,
    isCaptureHealthy: () => ready,
    isCaptureReady: () => ready,
    getCaptureHealth: () => ({
      generation,
      phase,
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
      readProcessIdentity: anyPidIdentity,
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

    // LIM-80 3B1: the automatic handoff proved exact child identities and journaled
    // durable stages; the terminal attempt carries oldChild + replacementChild +
    // the input-journal pointer, and NO input bytes leak into SQLite.
    const doneAttempt = store.getAttempt(would[0]!.receiptId)!;
    expect(doneAttempt.stage).toBe("terminal");
    expect(doneAttempt.terminalOutcomeKind).toBe("handoff_success");
    expect(doneAttempt.artifacts.oldChild).toBeDefined();
    expect(doneAttempt.artifacts.replacementChild).toBeDefined();
    expect(doneAttempt.artifacts.inputJournalPath).toBeDefined();
    expect(doneAttempt.artifacts.inputJournalId).toBeDefined();
    // A DELIVERED journal is cleaned once the terminal completion is durable.
    expect(existsSync(doneAttempt.artifacts.inputJournalPath!)).toBe(false);
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
      readProcessIdentity: anyPidIdentity,
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

  it("post-commit binary input is journaled, retained on completion failure, and never leaks into SQLite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lim64-completefail-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const rolloutProjectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-completefail-proj-"));
    dirs.push(rolloutProjectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-completefail-rec-"));
    dirs.push(recoveryDir);
    const spawned: FakePty[] = [];
    const sdk = sdkForCapture();
    const writeSpy = validWriteSpy(rolloutProjectsRoot);
    let liveSessionId = "old-session";
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    const wrapperLogLines: string[] = [];
    const results: HandoffResult[] = [];
    // Post-commit stdin includes NUL / high bytes and a unique marker.
    const MARKER = "SECRET-MARKER-9c3f";
    const secretBytes = Buffer.concat([Buffer.from([0x00, 0xff, 0xfe, 0x01]), Buffer.from(MARKER, "utf8")]);
    const stdin = fakeStream();
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
      stdin,
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: receiptDb,
      recoveryProjectsRoot: rolloutProjectsRoot,
      recoverySessionIdFn: () => REBUILT_ID,
      recoveryDir,
      readProcessIdentity: anyPidIdentity,
      wrapperLog: {
        info: (m: string) => wrapperLogLines.push(m),
        warn: (m: string) => wrapperLogLines.push(m),
        warningCount: () => wrapperLogLines.filter((l) => /warn|undurable|failed/i.test(l)).length,
        path: "/tmp/fake.log",
      } as never,
      // A PROVEN-terminal completion (final handoff result) whose completeAttempt
      // cannot be persisted must be loud and leave the receipt scheduled — and
      // retain the delivered journal.
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
    await waitFor(() => spawned.length >= 1, "first child");
    // The operator types (binary) AFTER commit: hook the old child's SIGTERM
    // (fired inside terminateOldChild, i.e. during the active barrier).
    const origKill = spawned[0]!.kill.bind(spawned[0]);
    spawned[0]!.kill = (sig?: string) => {
      (stdin as unknown as PassThrough).write(secretBytes);
      origKill(sig);
    };
    lifecycleSink!(BOUND_SIGNALS);
    lifecycleSink!(ESTIMATE_CROSS_SIGNALS);
    await waitFor(() => results.length === 1, "handoff completed", 12_000);
    expect(results[0]!.kind).toBe("success");
    await new Promise((r) => setTimeout(r, 200));

    // The handoff happened + delivered the buffered bytes to the new child, but
    // the terminal completion could not be recorded → loud, receipt scheduled.
    expect(wrapperLogLines.some((l) => l.includes("outcome NOT durable"))).toBe(true);
    expect(spawned[1]!.writes.join("")).toContain(secretBytes.toString("latin1"));

    const store = openGovernorReceiptStore(receiptDb);
    const would = store.listBySession("old-session").filter((r) => r.wouldMutate);
    expect(would).toHaveLength(1);
    const receipt = would[0]!;
    expect(receipt.handoffOutcome?.kind).toBe("scheduled");

    // The attempt advanced through the durable stages; its journal is RETAINED.
    const attempt = store.getAttempt(receipt.receiptId)!;
    expect(attempt.stage).toBe("descriptor_published");
    const journalPath = attempt.artifacts.inputJournalPath!;
    expect(existsSync(journalPath)).toBe(true);

    // The journal holds the exact ordered bytes (binary-safe) in `delivered`.
    const journal = readInputJournal(journalPath, {
      receiptId: receipt.receiptId,
      attemptId: attempt.attemptId,
      oldSessionId: "old-session",
      rebuiltSessionId: REBUILT_ID,
    });
    expect(journal.ok).toBe(true);
    if (journal.ok) {
      expect(journal.state).toBe("delivered");
      expect(journal.chunks.equals(secretBytes)).toBe(true);
    }

    // No input bytes leak into SQLite: neither the attempt nor the receipt row
    // contains the marker (nor its base64), only the journal pointer.
    const markerB64 = secretBytes.toString("base64");
    const attemptJson = JSON.stringify(attempt);
    const receiptJson = JSON.stringify(store.getById(receipt.receiptId));
    for (const blob of [attemptJson, receiptJson]) {
      expect(blob).not.toContain(MARKER);
      expect(blob).not.toContain(markerB64);
    }
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

/** Deterministic identity for any pid (self-claim + fake old/replacement child). */
const anyPidIdentity: ProbeProcessIdentity = (pid) => ({
  ok: true,
  identity: { pid, bootId: "test-boot", starttime: "1" },
});

function identityProbe(
  map: Record<number, ProcessLivenessResult>,
  opts: { defaultOk?: boolean } = {},
): ProbeProcessIdentity {
  // LIM-80 3B1: handoff paths probe the fake old/replacement child pids too;
  // `defaultOk` returns a stable synthetic identity for any unlisted pid so the
  // stage port can prove child identity. Owner-liveness tests keep the default
  // (unlisted → not_found) so a dead foreign owner remains reclaimable.
  return (pid: number) =>
    map[pid] ??
    (opts.defaultOk
      ? { ok: true, identity: { pid, bootId: "child-boot", starttime: "1" } }
      : { ok: false, code: "not_found", message: `no pid ${pid}` });
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
      readProcessIdentity: identityProbe({ [process.pid]: { ok: true, identity: SELF_ID } }, { defaultOk: true }),
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
      readProcessIdentity: identityProbe({ [process.pid]: { ok: true, identity: SELF_ID } }, { defaultOk: true }),
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
      readProcessIdentity: identityProbe({ [process.pid]: { ok: true, identity: SELF_ID } }, { defaultOk: true }),
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
      readProcessIdentity: identityProbe({ [process.pid]: { ok: true, identity: SELF_ID } }, { defaultOk: true }),
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

  // ── LIM-80 Slice 3B2: restart continuation of an interrupted handoff ──
  const DEAD_OWNER: ProcessIdentity = { pid: 811111, bootId: "crashed", starttime: "1" };
  const DEAD_REPL: ProcessIdentity = { pid: 822222, bootId: "crashed", starttime: "2" };
  const DEAD_OLD: ProcessIdentity = { pid: 833333, bootId: "crashed", starttime: "3" };
  const RESTART_REBUILT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const RESTART_OLD = "old-session";
  const RESTART_RECEIPT_TEXT = "[lhc compact:auto] restart.";

  async function seedInterrupted(opts: {
    receiptDb: string;
    projectsRoot: string;
    recoveryDir: string;
    journalState: "none" | "pending-empty" | "pending-bytes" | "delivering" | "delivered";
    journalBytes?: Buffer;
    corruptRollout?: boolean;
    rebuiltSessionId?: string;
  }): Promise<{ receiptId: string; attemptId: string; journalPath: string | undefined; rolloutPath: string }> {
    const rebuiltSessionId = opts.rebuiltSessionId ?? RESTART_REBUILT;
    const rolloutPath = rolloutPathForSession(opts.projectsRoot, process.cwd(), rebuiltSessionId);
    writeValidRollout(rolloutPath, rebuiltSessionId, RESTART_RECEIPT_TEXT);
    const { readFileSync } = await import("node:fs");
    const inspected = inspectRolloutBytes(readFileSync(rolloutPath), {
      reservedSessionId: rebuiltSessionId,
      rebuiltRolloutPath: rolloutPath,
      durableReceipt: RESTART_RECEIPT_TEXT,
    });
    if (inspected.kind !== "ok") throw new Error("seed rollout not ok");
    const v = inspected.verification;
    if (opts.corruptRollout) writeFileSync(rolloutPath, '{"corrupt":true}\n');

    const store = openGovernorReceiptStore(opts.receiptDb);
    const observe = await settledWouldMutateObserve();
    const { receipt } = store.appendObserve({ observe, sessionId: RESTART_OLD, threadId: "th_auto" });
    const receiptId = receipt.receiptId;
    const claim = store.claimAttempt({ receiptId, owner: DEAD_OWNER });
    if (claim.kind !== "claimed") throw new Error(`seed claim ${claim.kind}`);
    const attemptId = claim.attempt.attemptId;
    const artifacts: RecoveryArtifacts = {
      threadId: "th_auto",
      oldSessionId: RESTART_OLD,
      rebuiltSessionId,
      rebuiltRolloutPath: rolloutPath,
      durableReceipt: RESTART_RECEIPT_TEXT,
      rolloutFullSha256: v.rolloutFullSha256,
      rolloutPrefixSha256: v.rolloutPrefixSha256,
      rolloutPrefixLineCount: v.rolloutPrefixLineCount,
      rolloutPrefixByteLength: v.rolloutPrefixByteLength,
      rolloutLineCount: v.rolloutLineCount,
      rolloutByteLength: v.rolloutByteLength,
      oldChild: DEAD_OLD,
      replacementChild: DEAD_REPL,
    };
    let adv = store.advanceAttempt({ receiptId, attemptId, stage: "descriptor_published", artifacts });
    if (adv.kind !== "advanced") throw new Error(`seed advance ${adv.kind}`);

    let journalPath: string | undefined;
    if (opts.journalState !== "none") {
      const journal = createInputJournal({
        dir: opts.recoveryDir,
        binding: { receiptId, attemptId, oldSessionId: RESTART_OLD, rebuiltSessionId },
      });
      const bytes = opts.journalBytes ?? Buffer.from([0x00, 0xff, 0x41, 0x42]);
      if (opts.journalState !== "pending-empty") journal.appendChunk(bytes);
      if (opts.journalState === "delivering" || opts.journalState === "delivered") journal.markDelivering();
      if (opts.journalState === "delivered") journal.markDelivered();
      journal.close();
      journalPath = journal.path;
      adv = store.advanceAttempt({
        receiptId,
        attemptId,
        stage: "descriptor_published",
        artifacts: {
          inputJournalPath: journal.path,
          inputJournalId: journal.journalId,
          // 3B2 finding 9: the origin attempt id the journal header was created under.
          inputJournalOriginAttemptId: attemptId,
        },
      });
      if (adv.kind !== "advanced") throw new Error(`seed journal advance ${adv.kind}`);
    }
    store.close();
    return { receiptId, attemptId, journalPath, rolloutPath };
  }

  function restartRun(opts: {
    receiptDb: string;
    recoveryDir: string;
    spawned: FakePty[];
    boundSessionId: string;
    onHandoffResult?: (r: HandoffResult) => void;
    identity?: Record<number, ProcessLivenessResult>;
    /** Full custom identity probe (e.g. a stateful one that flips between reads). */
    identityFn?: ProbeProcessIdentity;
    /** Force the rebuilt (respawn) capture to come up degraded → executeHandoff rolls back. */
    rebuiltDegraded?: boolean;
    /** Make the OLD-session capture report an open turn → a non-stale pre-commit cancel. */
    oldTurnOpen?: boolean;
    /** A stdin stream the test can write to (bumps the input epoch). */
    stdin?: NodeJS.ReadStream & NodeJS.WriteStream;
    /** Injected input-journal fs seam (write/fsync/unlink failure injection). */
    inputJournalDeps?: InputJournalDeps;
    /** Make the initial (old-session) child's write throw when the predicate matches. */
    childWriteThrows?: (data: string) => boolean;
    /** Wrap the receipt store (e.g. to force completeAttempt to throw). */
    storeHook?: (store: GovernorReceiptStore) => GovernorReceiptStore;
  }): { runPromise: Promise<number>; sink: () => ((s: readonly LifecycleSignal[]) => void) | undefined } {
    const sdk = sdkForCapture();
    let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    let captureCalls = 0;
    mocks.captureFactory = (o) => {
      captureCalls += 1;
      // A rebuilt capture (case B controlled replacement) is bound by its known
      // rollout path to the REBUILT session, so the new child proves the rebuilt
      // session; the initial launch binds to `boundSessionId`.
      const isRebuilt = o.knownRolloutPath !== undefined;
      const boundTo = isRebuilt ? RESTART_REBUILT : opts.boundSessionId;
      const rolloutPath = isRebuilt ? o.knownRolloutPath! : `/tmp/${boundTo}.jsonl`;
      const ready = !(isRebuilt && opts.rebuiltDegraded === true);
      const turnOpen = !isRebuilt && opts.oldTurnOpen === true;
      const session = scriptedCaptureSession(o, sdk, boundTo, rolloutPath, captureCalls, ready, turnOpen);
      (session as { getRolloutInfo: () => { path: string; sessionId: string } }).getRolloutInfo = () => ({
        path: rolloutPath,
        sessionId: boundTo,
      });
      if (o.onLifecycle !== undefined && !isRebuilt) lifecycleSink = o.onLifecycle;
      return session;
    };
    const base = baseRunOptions(opts.receiptDb, opts.spawned, 9600);
    const spawnPty =
      opts.childWriteThrows === undefined
        ? base.spawnPty
        : (_file: string, args: string[]) => {
            const fake = makeFakePty(9600 + opts.spawned.length, `c${opts.spawned.length}`, args, true);
            const first = opts.spawned.length === 0;
            const origWrite = fake.write;
            fake.write = (data: string) => {
              if (first && opts.childWriteThrows!(data)) throw new Error("simulated child write failure");
              origWrite(data);
            };
            opts.spawned.push(fake);
            return fake as never;
          };
    const runPromise = run([], {
      ...base,
      spawnPty: spawnPty as never,
      ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
      ...(opts.inputJournalDeps === undefined ? {} : { inputJournalDeps: opts.inputJournalDeps }),
      ...(opts.storeHook === undefined ? {} : { governorReceiptStoreHook: opts.storeHook }),
      recoveryDir: opts.recoveryDir,
      readProcessIdentity:
        opts.identityFn ??
        identityProbe(
          { [process.pid]: { ok: true, identity: SELF_ID }, ...(opts.identity ?? {}) },
          { defaultOk: true },
        ),
      onHandoffResult: opts.onHandoffResult ?? (() => {}),
      handoffTimeouts: {
        sigtermGraceMs: 300,
        sigkillWaitMs: 200,
        captureReadyTimeoutMs: 2_000,
        childLivenessTimeoutMs: 3_000,
        childStableWindowMs: 100,
      },
    }) as Promise<number>;
    return { runPromise, sink: () => lifecycleSink };
  }

  async function waitTerminal(receiptDb: string, receiptId: string, cap = 8_000): Promise<void> {
    await waitFor(
      () => {
        const s = openGovernorReceiptStore(receiptDb);
        try {
          return s.getAttempt(receiptId)?.stage === "terminal";
        } finally {
          s.close();
        }
      },
      "restart attempt terminal",
      cap,
    );
  }

  // Case A (finding 1/2): the wrapper relaunched on the rebuilt session with a
  // fresh child. The recorded replacementChild is DEAD, so the live child is
  // ADOPTED as a new recovery generation (never overwriting the immutable
  // replacementChild), then the attempt terminalizes. A delivered journal reports
  // its actual byte count (finding 6); an empty journal reports zero.
  for (const { js, flushed } of [
    { js: "delivered", flushed: 4 },
    { js: "pending-empty", flushed: 0 },
  ] as const) {
    it(`restart on rebuilt session, journal=${js} → adopt generation, terminal handoff_success (flushed=${flushed})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-"));
      dirs.push(dir);
      const receiptDb = join(dir, "cc-lhc.sqlite");
      const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-proj-"));
      dirs.push(projectsRoot);
      const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-rec-"));
      dirs.push(recoveryDir);
      const { receiptId, journalPath } = await seedInterrupted({
        receiptDb,
        projectsRoot,
        recoveryDir,
        journalState: js,
      });

      const spawned: FakePty[] = [];
      const { runPromise, sink } = restartRun({ receiptDb, recoveryDir, spawned, boundSessionId: RESTART_REBUILT });
      await waitFor(() => sink() !== undefined, "sink");
      sink()!(BOUND_SIGNALS);
      await waitTerminal(receiptDb, receiptId);

      // The restart path never calls the SDK compact (structurally); assert terminal.
      const store = openGovernorReceiptStore(receiptDb);
      expect(store.getById(receiptId)?.handoffOutcome).toEqual({
        kind: "handoff_success",
        newSessionId: RESTART_REBUILT,
        flushedInputBytes: flushed,
      });
      // Exactly one adopt_ready generation event; the immutable original is preserved.
      const done = store.getAttempt(receiptId)!;
      expect(done.artifacts.replacementChild).toEqual(DEAD_REPL);
      expect(done.artifacts.replacementGenerationEvents).toHaveLength(1);
      expect(done.artifacts.replacementGenerationEvents![0]!.kind).toBe("adopt_ready");
      store.close();
      if (journalPath !== undefined) expect(existsSync(journalPath)).toBe(false);

      spawned[0]?.fireExit(0);
      await runPromise;
    }, 15_000);
  }

  it("restart on rebuilt session, journal=NONE → OPEN (a post-commit attempt with no journal cannot infer bytes absent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-none-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-none-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-none-rec-"));
    dirs.push(recoveryDir);
    const { receiptId } = await seedInterrupted({ receiptDb, projectsRoot, recoveryDir, journalState: "none" });

    const spawned: FakePty[] = [];
    const { runPromise, sink } = restartRun({ receiptDb, recoveryDir, spawned, boundSessionId: RESTART_REBUILT });
    await waitFor(() => sink() !== undefined, "sink");
    sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 500));

    const store = openGovernorReceiptStore(receiptDb);
    expect(store.getAttempt(receiptId)?.stage).not.toBe("terminal");
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("scheduled");
    store.close();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(recoveryDir).some((f) => f.startsWith("restart-"))).toBe(true);

    spawned[0]?.fireExit(0);
    await runPromise;
  }, 15_000);

  it("restart delivers pending journal bytes to the live rebuilt child, then terminalizes success and cleans the journal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-deliver-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-deliver-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-deliver-rec-"));
    dirs.push(recoveryDir);
    const bytes = Buffer.from([0x00, 0xff, 0x68, 0x69]);
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
      journalBytes: bytes,
    });

    const spawned: FakePty[] = [];
    const { runPromise, sink } = restartRun({ receiptDb, recoveryDir, spawned, boundSessionId: RESTART_REBUILT });
    await waitFor(() => sink() !== undefined, "sink");
    sink()!(BOUND_SIGNALS);
    await waitTerminal(receiptDb, receiptId);

    const store = openGovernorReceiptStore(receiptDb);
    expect(store.getById(receiptId)?.handoffOutcome).toEqual({
      kind: "handoff_success",
      newSessionId: RESTART_REBUILT,
      flushedInputBytes: bytes.length,
    });
    store.close();
    // The exact bytes reached the current child; the delivered journal is cleaned.
    expect(spawned[0]!.writes.join("")).toContain(bytes.toString("latin1"));
    expect(existsSync(journalPath!)).toBe(false);

    spawned[0]?.fireExit(0);
    await runPromise;
  }, 15_000);

  it("restart with a `delivering` journal is INDETERMINATE: no send, attempt stays open, operator artifact written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-amb-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-amb-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-amb-rec-"));
    dirs.push(recoveryDir);
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "delivering",
      journalBytes: Buffer.from("ambiguous"),
    });

    const spawned: FakePty[] = [];
    const { runPromise, sink } = restartRun({ receiptDb, recoveryDir, spawned, boundSessionId: RESTART_REBUILT });
    await waitFor(() => sink() !== undefined, "sink");
    sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 500));

    const store = openGovernorReceiptStore(receiptDb);
    const attempt = store.getAttempt(receiptId);
    // NEVER terminalized as success; attempt open, receipt scheduled.
    expect(attempt?.stage).not.toBe("terminal");
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("scheduled");
    store.close();
    // No bytes sent to the child; journal retained; an operator artifact exists.
    expect(spawned[0]!.writes.join("")).not.toContain("ambiguous");
    expect(existsSync(journalPath!)).toBe(true);
    // Journal retained in `delivering` (indeterminate); operator artifact present.
    const jr = readInputJournal(journalPath!);
    expect(jr.ok && jr.state).toBe("delivering");
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(recoveryDir).some((f) => f.startsWith("restart-"))).toBe(true);

    spawned[0]?.fireExit(0);
    await runPromise;
  }, 15_000);

  it("restart with corrupt rollout does NOT terminalize (open, repairable)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-corrupt-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-corrupt-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-corrupt-rec-"));
    dirs.push(recoveryDir);
    const { receiptId } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "delivered",
      corruptRollout: true,
    });

    const spawned: FakePty[] = [];
    const { runPromise, sink } = restartRun({ receiptDb, recoveryDir, spawned, boundSessionId: RESTART_REBUILT });
    await waitFor(() => sink() !== undefined, "sink");
    sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 500));

    const store = openGovernorReceiptStore(receiptDb);
    expect(store.getAttempt(receiptId)?.stage).not.toBe("terminal");
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("scheduled");
    store.close();

    spawned[0]?.fireExit(0);
    await runPromise;
  }, 15_000);

  it("restart on the OLD session (finding 3): controlled replacement re-establishes the rebuilt child, appends a respawn generation, delivers pre-crash bytes to it FIRST, terminalizes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-old-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-old-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-old-rec-"));
    dirs.push(recoveryDir);
    const bytes = Buffer.from([0x00, 0xff, 0x41, 0x42]);
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
      journalBytes: bytes,
    });

    const spawned: FakePty[] = [];
    // The wrapper relaunched bound to the OLD session (descriptor was not repointed).
    const { runPromise, sink } = restartRun({ receiptDb, recoveryDir, spawned, boundSessionId: RESTART_OLD });
    await waitFor(() => sink() !== undefined, "sink");
    sink()!(BOUND_SIGNALS);
    await waitTerminal(receiptDb, receiptId, 12_000);

    const store = openGovernorReceiptStore(receiptDb);
    // Terminal handoff_success re-established on the rebuilt session, NOT a refusal.
    expect(store.getById(receiptId)?.handoffOutcome).toEqual({
      kind: "handoff_success",
      newSessionId: RESTART_REBUILT,
      flushedInputBytes: bytes.length,
    });
    const done = store.getAttempt(receiptId)!;
    // A two-phase respawn generation was APPENDED (immutable original preserved):
    // a PREPARED event (old child + own journal) then a READY event (replacement).
    expect(done.artifacts.replacementChild).toEqual(DEAD_REPL);
    const events = done.artifacts.replacementGenerationEvents!;
    expect(events).toHaveLength(2);
    const prep = events.find((e) => e.kind === "respawn_prepared")!;
    const ready = events.find((e) => e.kind === "respawn_ready")!;
    expect(prep).toBeDefined();
    expect(ready).toBeDefined();
    expect(prep.generationId).toBe(ready.generationId);
    if (prep.kind === "respawn_prepared") {
      expect(prep.oldChild).toBeDefined();
      expect(prep.journalPath).toBeDefined();
    }
    const currentJournalPath = prep.kind === "respawn_prepared" ? prep.journalPath : undefined;
    store.close();
    // The pre-crash bytes reached the NEWLY spawned rebuilt child (spawned[1]),
    // never the old-session child, and the pre-crash journal is cleaned.
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    expect(spawned[1]!.writes.join("")).toContain(bytes.toString("latin1"));
    expect(existsSync(journalPath!)).toBe(false);
    expect(currentJournalPath).toBeDefined();
    expect(existsSync(currentJournalPath!)).toBe(false);

    spawned[spawned.length - 1]?.fireExit(0);
    await runPromise;
  }, 20_000);

  it("finding 1: a DIFFERENT recorded replacement identity that is still LIVE blocks terminalization (no second same-session child gets abandoned)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-foreign-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-foreign-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-foreign-rec-"));
    dirs.push(recoveryDir);
    const { receiptId } = await seedInterrupted({ receiptDb, projectsRoot, recoveryDir, journalState: "delivered" });

    const spawned: FakePty[] = [];
    // The recorded replacementChild (DEAD_REPL) is actually still LIVE at its exact
    // identity: a second same-session child. It must never be terminalized past.
    const { runPromise, sink } = restartRun({
      receiptDb,
      recoveryDir,
      spawned,
      boundSessionId: RESTART_REBUILT,
      identity: { 822222: { ok: true, identity: { pid: 822222, bootId: "crashed", starttime: "2" } } },
    });
    await waitFor(() => sink() !== undefined, "sink");
    sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 500));

    const store = openGovernorReceiptStore(receiptDb);
    expect(store.getAttempt(receiptId)?.stage).not.toBe("terminal");
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("scheduled");
    store.close();

    spawned[0]?.fireExit(0);
    await runPromise;
  }, 15_000);

  it("finding 1: a reused pid (live process, different identity) reads as ABSENT, so the fresh child is adopted and the attempt terminalizes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-reuse-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-reuse-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-reuse-rec-"));
    dirs.push(recoveryDir);
    const { receiptId } = await seedInterrupted({ receiptDb, projectsRoot, recoveryDir, journalState: "delivered" });

    const spawned: FakePty[] = [];
    // pid 822222 is now a DIFFERENT live process (starttime changed): exact-identity
    // probe reads not_found, so the recorded replacementChild is proven absent.
    const { runPromise, sink } = restartRun({
      receiptDb,
      recoveryDir,
      spawned,
      boundSessionId: RESTART_REBUILT,
      identity: { 822222: { ok: true, identity: { pid: 822222, bootId: "crashed", starttime: "99999" } } },
    });
    await waitFor(() => sink() !== undefined, "sink");
    sink()!(BOUND_SIGNALS);
    await waitTerminal(receiptDb, receiptId);

    const store = openGovernorReceiptStore(receiptDb);
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("handoff_success");
    expect(store.getAttempt(receiptId)!.artifacts.replacementGenerationEvents).toHaveLength(1);
    store.close();

    spawned[0]?.fireExit(0);
    await runPromise;
  }, 15_000);

  it("repeated restart is idempotent: a delivered journal terminalizes once with no duplicate send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-idem-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-idem-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-idem-rec-"));
    dirs.push(recoveryDir);
    const { receiptId } = await seedInterrupted({ receiptDb, projectsRoot, recoveryDir, journalState: "delivered" });

    // First restart run → terminal.
    {
      const spawned: FakePty[] = [];
      const { runPromise, sink } = restartRun({ receiptDb, recoveryDir, spawned, boundSessionId: RESTART_REBUILT });
      await waitFor(() => sink() !== undefined, "sink1");
      sink()!(BOUND_SIGNALS);
      await waitTerminal(receiptDb, receiptId);
      spawned[0]?.fireExit(0);
      await runPromise;
    }
    // Second restart run → still exactly one terminal handoff_success; no throw, no re-send.
    {
      const spawned: FakePty[] = [];
      const { runPromise, sink } = restartRun({ receiptDb, recoveryDir, spawned, boundSessionId: RESTART_REBUILT });
      await waitFor(() => sink() !== undefined, "sink2");
      sink()!(BOUND_SIGNALS);
      await new Promise((r) => setTimeout(r, 400));
      const store = openGovernorReceiptStore(receiptDb);
      expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("handoff_success");
      expect(store.getAttempt(receiptId)?.stage).toBe("terminal");
      store.close();
      expect(spawned[0]!.writes.join("")).toBe("");
      spawned[0]?.fireExit(0);
      await runPromise;
    }
  }, 20_000);

  it("finding 6: user input before re-establishment (nonzero epoch) → CANCEL on the live old session; no respawn, no stale-rollout retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-epoch-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-epoch-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-epoch-rec-"));
    dirs.push(recoveryDir);
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
    });

    const spawned: FakePty[] = [];
    const stdin = fakeStream();
    // The wrapper relaunched on the OLD session; the user types BEFORE recovery runs.
    const { runPromise, sink } = restartRun({ receiptDb, recoveryDir, spawned, boundSessionId: RESTART_OLD, stdin });
    await waitFor(() => sink() !== undefined && spawned.length >= 1, "sink+child");
    stdin.write("hello\r"); // accepted input → bumps the governor input epoch
    await waitFor(() => spawned[0]!.writes.join("").includes("hello"), "input reached old child");
    sink()!(BOUND_SIGNALS);
    await waitTerminal(receiptDb, receiptId);

    const store = openGovernorReceiptStore(receiptDb);
    // Terminal CANCELLED (stale rollout), never a re-established success.
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("handoff_cancelled");
    expect(store.getAttempt(receiptId)!.artifacts.replacementGenerationEvents).toBeUndefined();
    store.close();
    // No rebuilt child was spawned; the old session keeps running; the journal is retained.
    expect(spawned).toHaveLength(1);
    expect(existsSync(journalPath!)).toBe(true);

    spawned[0]?.fireExit(0);
    await runPromise;
  }, 15_000);

  it("finding 1 (ordering): exact old session + nonzero epoch + an EXACT-LIVE recorded replacement → OPEN, never a stale-rollout cancel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-flepoch-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-flepoch-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-flepoch-rec-"));
    dirs.push(recoveryDir);
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
    });

    const spawned: FakePty[] = [];
    const stdin = fakeStream();
    // The recorded replacementChild (DEAD_REPL) is actually still LIVE at its exact
    // identity, AND the user typed before recovery (nonzero epoch). The live foreign
    // replacement must win: leave OPEN, never terminalize a stale-rollout cancel.
    const { runPromise, sink } = restartRun({
      receiptDb,
      recoveryDir,
      spawned,
      boundSessionId: RESTART_OLD,
      stdin,
      identity: { 822222: { ok: true, identity: { pid: 822222, bootId: "crashed", starttime: "2" } } },
    });
    await waitFor(() => sink() !== undefined && spawned.length >= 1, "sink+child");
    stdin.write("hello\r");
    await waitFor(() => spawned[0]!.writes.join("").includes("hello"), "input reached old child");
    sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 600));

    const store = openGovernorReceiptStore(receiptDb);
    // NOT terminalized (no cancel): the live replacement keeps the attempt open.
    expect(store.getAttempt(receiptId)?.stage).not.toBe("terminal");
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("scheduled");
    expect(store.getAttempt(receiptId)!.artifacts.replacementGenerationEvents).toBeUndefined();
    store.close();
    // No child mutation; the journal is retained; a truthful operator artifact exists.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.killed).toHaveLength(0);
    expect(existsSync(journalPath!)).toBe(true);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(recoveryDir).some((f) => f.startsWith("restart-"))).toBe(true);

    spawned[0]?.fireExit(0);
    await runPromise;
  }, 15_000);

  it("finding 6/7: wrapper on an unrelated session (neither rebuilt nor exact old) → OPEN, no mutation, no signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-wrong-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-wrong-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-wrong-rec-"));
    dirs.push(recoveryDir);
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
    });

    const spawned: FakePty[] = [];
    // Bound to a THIRD session: not the rebuilt session, not the exact old session.
    const { runPromise, sink } = restartRun({ receiptDb, recoveryDir, spawned, boundSessionId: "some-other-session" });
    await waitFor(() => sink() !== undefined, "sink");
    sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 500));

    const store = openGovernorReceiptStore(receiptDb);
    expect(store.getAttempt(receiptId)?.stage).not.toBe("terminal");
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("scheduled");
    store.close();
    // No child was signalled/replaced; the journal is retained.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.killed).toHaveLength(0);
    expect(existsSync(journalPath!)).toBe(true);

    spawned[0]?.fireExit(0);
    await runPromise;
  }, 15_000);

  it("finding 5: a controlled replacement that rolls back terminalizes handoff_rolled_back with the byte total and disposes the chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-rb-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-rb-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-rb-rec-"));
    dirs.push(recoveryDir);
    const bytes = Buffer.from([0x41, 0x42, 0x43, 0x44]);
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
      journalBytes: bytes,
    });

    const spawned: FakePty[] = [];
    // The wrapper relaunched on the OLD session; the rebuilt capture comes up degraded,
    // so executeHandoff rolls back to a fresh old-session child.
    const { runPromise, sink } = restartRun({
      receiptDb,
      recoveryDir,
      spawned,
      boundSessionId: RESTART_OLD,
      rebuiltDegraded: true,
    });
    await waitFor(() => sink() !== undefined, "sink");
    sink()!(BOUND_SIGNALS);
    await waitTerminal(receiptDb, receiptId, 12_000);

    const store = openGovernorReceiptStore(receiptDb);
    const outcome = store.getById(receiptId)?.handoffOutcome;
    expect(outcome?.kind).toBe("handoff_rolled_back");
    if (outcome?.kind === "handoff_rolled_back") expect(outcome.detail).toContain(`${bytes.length} input byte(s)`);
    const prep = store
      .getAttempt(receiptId)!
      .artifacts.replacementGenerationEvents?.find((e) => e.kind === "respawn_prepared");
    const currentJournalPath = prep?.kind === "respawn_prepared" ? prep.journalPath : undefined;
    store.close();
    // The whole chain was disposed after the durable terminal; no stale-rollout retry.
    expect(existsSync(journalPath!)).toBe(false);
    expect(currentJournalPath).toBeDefined();
    expect(existsSync(currentJournalPath!)).toBe(false);

    spawned[spawned.length - 1]?.fireExit(0);
    await runPromise;
  }, 20_000);

  it("finding 4/8: case A delivers the WHOLE chain (origin + an earlier prepared-but-unready segment) in order and reports the total", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-chain-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-chain-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-chain-rec-"));
    dirs.push(recoveryDir);
    const originBytes = Buffer.from([0x01, 0x02]);
    const { receiptId, attemptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
      journalBytes: originBytes,
    });

    // Seed an earlier respawn generation that PREPARED (own journal + a now-DEAD old
    // child) but crashed before READY. Its journal is a second chain segment.
    const DEAD_PREP_OLD: ProcessIdentity = { pid: 844444, bootId: "crashed", starttime: "4" };
    const genBytes = Buffer.from([0x03, 0x04, 0x05]);
    const store0 = openGovernorReceiptStore(receiptDb);
    const genJournal = createInputJournal({
      dir: recoveryDir,
      binding: { receiptId, attemptId, oldSessionId: RESTART_OLD, rebuiltSessionId: RESTART_REBUILT },
    });
    genJournal.appendChunk(genBytes);
    genJournal.close();
    const adv = store0.advanceAttempt({
      receiptId,
      attemptId,
      stage: "descriptor_published",
      artifacts: {
        replacementGenerationEvents: [
          {
            kind: "respawn_prepared",
            generationId: "gen-crashed",
            originAttemptId: attemptId,
            oldChild: DEAD_PREP_OLD,
            journalPath: genJournal.path,
            journalId: genJournal.journalId,
          },
        ],
      },
    });
    expect(adv.kind).toBe("advanced");
    store0.close();

    const spawned: FakePty[] = [];
    const { runPromise, sink } = restartRun({ receiptDb, recoveryDir, spawned, boundSessionId: RESTART_REBUILT });
    await waitFor(() => sink() !== undefined, "sink");
    sink()!(BOUND_SIGNALS);
    await waitTerminal(receiptDb, receiptId);

    const store = openGovernorReceiptStore(receiptDb);
    // Total = origin (2) + prepared-segment (3); an adopt_ready event was appended.
    expect(store.getById(receiptId)?.handoffOutcome).toEqual({
      kind: "handoff_success",
      newSessionId: RESTART_REBUILT,
      flushedInputBytes: originBytes.length + genBytes.length,
    });
    const events = store.getAttempt(receiptId)!.artifacts.replacementGenerationEvents!;
    expect(events.some((e) => e.kind === "adopt_ready")).toBe(true);
    store.close();
    // Ordered delivery: origin bytes precede the prepared-segment bytes on the child.
    const written = spawned[0]!.writes.join("");
    expect(written.indexOf(originBytes.toString("latin1"))).toBeLessThan(written.indexOf(genBytes.toString("latin1")));
    // Both chain segments were disposed after the durable terminal.
    expect(existsSync(journalPath!)).toBe(false);
    expect(existsSync(genJournal.path)).toBe(false);

    spawned[0]?.fireExit(0);
    await runPromise;
  }, 15_000);

  it("Fable blocker 1/2: fresh rebuilt-session input durably retires every pending generation and a second run never replays it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-retire-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-retire-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-retire-rec-"));
    dirs.push(recoveryDir);
    const { receiptId, attemptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
      journalBytes: Buffer.from("ORIGIN"),
    });

    const store0 = openGovernorReceiptStore(receiptDb);
    const generation = createInputJournal({
      dir: recoveryDir,
      binding: { receiptId, attemptId, oldSessionId: RESTART_OLD, rebuiltSessionId: RESTART_REBUILT },
    });
    generation.appendChunk(Buffer.from("GENERATION"));
    generation.close();
    expect(
      store0.advanceAttempt({
        receiptId,
        attemptId,
        stage: "descriptor_published",
        artifacts: {
          replacementGenerationEvents: [
            {
              kind: "respawn_prepared",
              generationId: "gen-retired",
              originAttemptId: attemptId,
              oldChild: { pid: 866666, bootId: "dead", starttime: "6" },
              journalPath: generation.path,
              journalId: generation.journalId,
            },
          ],
        },
      }).kind,
    ).toBe("advanced");
    store0.close();

    const spawned: FakePty[] = [];
    const stdin = fakeStream();
    const first = restartRun({ receiptDb, recoveryDir, spawned, boundSessionId: RESTART_REBUILT, stdin });
    await waitFor(() => first.sink() !== undefined && spawned.length >= 1, "sink+rebuilt child");
    stdin.write("FRESH\r");
    await waitFor(() => spawned[0]!.writes.join("").includes("FRESH"), "fresh input reached rebuilt child");
    first.sink()!(BOUND_SIGNALS);
    await waitTerminal(receiptDb, receiptId);

    const store1 = openGovernorReceiptStore(receiptDb);
    expect(store1.getById(receiptId)?.handoffOutcome?.kind).toBe("handoff_cancelled");
    store1.close();
    const originRetired = readInputJournal(journalPath!);
    const generationRetired = readInputJournal(generation.path);
    expect(originRetired.ok && originRetired.state).toBe("pending");
    expect(generationRetired.ok && generationRetired.state).toBe("pending");
    const artifacts = readdirSync(recoveryDir)
      .filter((name) => name.startsWith(`restart-${receiptId}-`) && name.endsWith(".json"))
      .map(
        (name) => JSON.parse(readFileSync(join(recoveryDir, name), "utf8")) as { unresolvedJournalSegments?: string[] },
      );
    expect(
      artifacts.some(
        (artifact) =>
          artifact.unresolvedJournalSegments?.includes(journalPath!) === true &&
          artifact.unresolvedJournalSegments.includes(generation.path),
      ),
    ).toBe(true);
    spawned[0]?.fireExit(0);
    await first.runPromise;

    // Process-memory epoch resets on a new invocation. The terminal receipt remains
    // the durable retirement fact, so neither retained segment can be replayed.
    const spawned2: FakePty[] = [];
    const second = restartRun({ receiptDb, recoveryDir, spawned: spawned2, boundSessionId: RESTART_REBUILT });
    await waitFor(() => second.sink() !== undefined, "sink2");
    second.sink()!(BOUND_SIGNALS);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(spawned2[0]!.writes.join("")).not.toContain("ORIGIN");
    expect(spawned2[0]!.writes.join("")).not.toContain("GENERATION");
    spawned2[0]?.fireExit(0);
    await second.runPromise;
  }, 20_000);

  it("Fable blocker 1: a crash-window after retirement marking but before terminal completion cannot replay after epoch reset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-retire-crash-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-retire-crash-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-retire-crash-rec-"));
    dirs.push(recoveryDir);
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
      journalBytes: Buffer.from("NEVER-REPLAY"),
    });

    const spawned: FakePty[] = [];
    const stdin = fakeStream();
    const first = restartRun({
      receiptDb,
      recoveryDir,
      spawned,
      boundSessionId: RESTART_REBUILT,
      stdin,
      storeHook: (store) => ({
        ...store,
        completeAttempt: () => {
          throw new Error("simulated crash-window before retirement terminal");
        },
      }),
    });
    await waitFor(() => first.sink() !== undefined && spawned.length >= 1, "sink+rebuilt child");
    stdin.write("FRESH\r");
    await waitFor(() => spawned[0]!.writes.join("").includes("FRESH"), "fresh input reached rebuilt child");
    first.sink()!(BOUND_SIGNALS);
    await waitFor(() => {
      const store = openGovernorReceiptStore(receiptDb);
      try {
        const attempt = store.getAttempt(receiptId);
        return (
          attempt?.stage !== "terminal" &&
          attempt?.artifacts.staleInputRetirementReason !== undefined &&
          attempt.artifacts.staleInputRetirementArtifactPath !== undefined
        );
      } finally {
        store.close();
      }
    }, "durable retirement marker without terminal");
    expect(existsSync(journalPath!)).toBe(true);
    spawned[0]?.fireExit(0);
    await first.runPromise;

    // A new process starts with epoch zero. The durable retirement marker, not
    // process memory, forces cancellation and prevents journal delivery.
    const spawned2: FakePty[] = [];
    const second = restartRun({ receiptDb, recoveryDir, spawned: spawned2, boundSessionId: RESTART_REBUILT });
    await waitFor(() => second.sink() !== undefined, "sink2");
    second.sink()!(BOUND_SIGNALS);
    await waitTerminal(receiptDb, receiptId);
    const store2 = openGovernorReceiptStore(receiptDb);
    expect(store2.getById(receiptId)?.handoffOutcome?.kind).toBe("handoff_cancelled");
    store2.close();
    expect(spawned2[0]!.writes.join("")).not.toContain("NEVER-REPLAY");
    expect(existsSync(journalPath!)).toBe(true);
    spawned2[0]?.fireExit(0);
    await second.runPromise;
  }, 20_000);

  it("finding 1: old-child identity changes between prepareBarrier and terminateOldChild → ABORT (no kill, no spawn), attempt open, prepared journal retained", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-idchg-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-idchg-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-idchg-rec-"));
    dirs.push(recoveryDir);
    const { receiptId } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
    });

    // pid 9600 (the old-session child) matches for the first two reads (continuation
    // probe + prepareBarrier), then CHANGES identity — so terminateOldChild's exact
    // pre-kill re-read sees a stranger and aborts.
    const OLD_MATCH: ProcessIdentity = { pid: 9600, bootId: "child-boot", starttime: "1" };
    const OLD_CHANGED: ProcessIdentity = { pid: 9600, bootId: "child-boot", starttime: "9" };
    let reads9600 = 0;
    const identityFn: ProbeProcessIdentity = (pid) => {
      if (pid === process.pid) return { ok: true, identity: SELF_ID };
      if (pid === 9600) {
        reads9600 += 1;
        return { ok: true, identity: reads9600 <= 2 ? OLD_MATCH : OLD_CHANGED };
      }
      return { ok: true, identity: { pid, bootId: "child-boot", starttime: "1" } };
    };

    const spawned: FakePty[] = [];
    const { runPromise, sink } = restartRun({
      receiptDb,
      recoveryDir,
      spawned,
      boundSessionId: RESTART_OLD,
      identityFn,
    });
    await waitFor(() => sink() !== undefined, "sink");
    sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 600));

    const store = openGovernorReceiptStore(receiptDb);
    // Aborted: attempt open, receipt scheduled — never terminal.
    expect(store.getAttempt(receiptId)?.stage).not.toBe("terminal");
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("scheduled");
    // A PREPARED event was durably recorded (before the barrier) with its own journal,
    // but NO ready — and its journal is retained for recovery.
    const events = store.getAttempt(receiptId)!.artifacts.replacementGenerationEvents ?? [];
    const prep = events.find((e) => e.kind === "respawn_prepared");
    expect(prep).toBeDefined();
    expect(events.some((e) => e.kind === "respawn_ready")).toBe(false);
    if (prep?.kind === "respawn_prepared") expect(existsSync(prep.journalPath)).toBe(true);
    store.close();
    // Zero kill signal, zero replacement spawn.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.killed).toHaveLength(0);

    spawned[0]?.fireExit(0);
    await runPromise;
  }, 15_000);

  it("finding 4: a NON-stale pre-commit cancel (old turn open) leaves the attempt OPEN — never a stale-rollout terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-cxl-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-cxl-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-cxl-rec-"));
    dirs.push(recoveryDir);
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
    });

    const spawned: FakePty[] = [];
    const { runPromise, sink } = restartRun({
      receiptDb,
      recoveryDir,
      spawned,
      boundSessionId: RESTART_OLD,
      oldTurnOpen: true, // preCommitGate → "turn opened during rebuild" (non-stale cancel)
    });
    await waitFor(() => sink() !== undefined, "sink");
    sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 600));

    const store = openGovernorReceiptStore(receiptDb);
    // Not terminalized as cancelled: a capture/turn cancel is transient, not stale input.
    expect(store.getAttempt(receiptId)?.stage).not.toBe("terminal");
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("scheduled");
    store.close();
    // No child was signalled/replaced; the journal is retained.
    expect(spawned).toHaveLength(1);
    expect(existsSync(journalPath!)).toBe(true);

    spawned[0]?.fireExit(0);
    await runPromise;
  }, 15_000);

  it("finding 4: the stale-rollout (nonzero epoch) cancel writes a durable artifact naming the unresolved segment BEFORE terminalizing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-stale-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-stale-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-stale-rec-"));
    dirs.push(recoveryDir);
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
    });

    const spawned: FakePty[] = [];
    const stdin = fakeStream();
    const { runPromise, sink } = restartRun({ receiptDb, recoveryDir, spawned, boundSessionId: RESTART_OLD, stdin });
    await waitFor(() => sink() !== undefined && spawned.length >= 1, "sink+child");
    stdin.write("hi\r");
    await waitFor(() => spawned[0]!.writes.join("").includes("hi"), "input reached old child");
    sink()!(BOUND_SIGNALS);
    await waitTerminal(receiptDb, receiptId);

    const store = openGovernorReceiptStore(receiptDb);
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("handoff_cancelled");
    store.close();
    // A durable byte-free artifact was written, naming every unresolved segment.
    const { readdirSync, readFileSync } = await import("node:fs");
    const artifact = readdirSync(recoveryDir).find((f) => f.startsWith("restart-"));
    expect(artifact).toBeDefined();
    const body = JSON.parse(readFileSync(join(recoveryDir, artifact!), "utf8"));
    expect(body.unresolvedJournalSegments).toContain(journalPath!);
    expect(existsSync(journalPath!)).toBe(true);

    spawned[0]?.fireExit(0);
    await runPromise;
  }, 15_000);

  it("finding 2: a child-write failure on the SECOND chain segment leaves segment 1 delivered and segment 2 delivering; a rerun re-sends nothing already delivered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-cw-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-cw-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-cw-rec-"));
    dirs.push(recoveryDir);
    const originBytes = Buffer.from("AA");
    const genBytes = Buffer.from("BB");
    const { receiptId, attemptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
      journalBytes: originBytes,
    });
    // Add a second (prepared) chain segment with distinct pending bytes.
    const store0 = openGovernorReceiptStore(receiptDb);
    const genJournal = createInputJournal({
      dir: recoveryDir,
      binding: { receiptId, attemptId, oldSessionId: RESTART_OLD, rebuiltSessionId: RESTART_REBUILT },
    });
    genJournal.appendChunk(genBytes);
    genJournal.close();
    store0.advanceAttempt({
      receiptId,
      attemptId,
      stage: "descriptor_published",
      artifacts: {
        replacementGenerationEvents: [
          {
            kind: "respawn_prepared",
            generationId: "g-crash",
            originAttemptId: attemptId,
            oldChild: { pid: 855555, bootId: "crashed", starttime: "5" },
            journalPath: genJournal.path,
            journalId: genJournal.journalId,
          },
        ],
      },
    });
    store0.close();

    const spawned: FakePty[] = [];
    const { runPromise, sink } = restartRun({
      receiptDb,
      recoveryDir,
      spawned,
      boundSessionId: RESTART_REBUILT,
      childWriteThrows: (d) => d.includes("BB"), // fail the SECOND segment's write
    });
    await waitFor(() => sink() !== undefined, "sink");
    sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 600));

    const store = openGovernorReceiptStore(receiptDb);
    expect(store.getAttempt(receiptId)?.stage).not.toBe("terminal"); // indeterminate → open
    store.close();
    // Segment 1 landed durably (delivered); segment 2 is delivering (indeterminate).
    const s1 = readInputJournal(journalPath!);
    const s2 = readInputJournal(genJournal.path);
    expect(s1.ok && s1.state).toBe("delivered");
    expect(s2.ok && s2.state).toBe("delivering");
    // Segment 1's bytes reached the child exactly once; segment 2's never did.
    expect(spawned[0]!.writes.join("")).toContain("AA");
    expect(spawned[0]!.writes.join("")).not.toContain("BB");

    spawned[0]?.fireExit(0);
    await runPromise;

    // A SECOND wrapper run must not re-send the already-delivered segment 1.
    const spawned2: FakePty[] = [];
    const r2 = restartRun({ receiptDb, recoveryDir, spawned: spawned2, boundSessionId: RESTART_REBUILT });
    await waitFor(() => r2.sink() !== undefined, "sink2");
    r2.sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 500));
    expect(spawned2[0]!.writes.join("")).not.toContain("AA"); // no duplicate send
    spawned2[0]?.fireExit(0);
    await r2.runPromise;
  }, 20_000);

  it("finding 6: journal cleanup failure AFTER a durable terminal retains the journal with a warning; a rerun re-sends nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-clean-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-clean-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-clean-rec-"));
    dirs.push(recoveryDir);
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "delivered",
    });

    const spawned: FakePty[] = [];
    // unlink throws → disposeChain warns + retains after the durable terminal.
    const r1 = restartRun({
      receiptDb,
      recoveryDir,
      spawned,
      boundSessionId: RESTART_REBUILT,
      inputJournalDeps: {
        unlinkSync: () => {
          throw new Error("simulated cleanup failure");
        },
      },
    });
    await waitFor(() => r1.sink() !== undefined, "sink");
    r1.sink()!(BOUND_SIGNALS);
    await waitTerminal(receiptDb, receiptId);

    const store = openGovernorReceiptStore(receiptDb);
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("handoff_success");
    store.close();
    // The journal is safely retained on disk (cleanup only runs after the durable terminal).
    expect(existsSync(journalPath!)).toBe(true);
    spawned[0]?.fireExit(0);
    await r1.runPromise;

    // A SECOND run sees a terminal receipt → no re-processing, no duplicate send.
    const spawned2: FakePty[] = [];
    const r2 = restartRun({ receiptDb, recoveryDir, spawned: spawned2, boundSessionId: RESTART_REBUILT });
    await waitFor(() => r2.sink() !== undefined, "sink2");
    r2.sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 500));
    expect(spawned2[0]!.writes.join("")).toBe("");
    spawned2[0]?.fireExit(0);
    await r2.runPromise;
  }, 20_000);

  it("finding 6: terminal completeAttempt failure (store throws) leaves the attempt OPEN with delivered journals retained; a healthy rerun terminalizes without re-sending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-store-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-store-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-store-rec-"));
    dirs.push(recoveryDir);
    // The chain has already reached `delivered` before the crash.
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "delivered",
    });

    const spawned: FakePty[] = [];
    // Wrap the store so terminal completeAttempt THROWS (persistence fails).
    const r1 = restartRun({
      receiptDb,
      recoveryDir,
      spawned,
      boundSessionId: RESTART_REBUILT,
      storeHook: (store) => ({
        ...store,
        completeAttempt: () => {
          throw new Error("simulated terminal store failure");
        },
      }),
    });
    await waitFor(() => r1.sink() !== undefined, "sink");
    r1.sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 600));

    const store = openGovernorReceiptStore(receiptDb);
    // Truthful: NOT terminalized (completion never persisted); receipt still scheduled.
    expect(store.getAttempt(receiptId)?.stage).not.toBe("terminal");
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("scheduled");
    store.close();
    // Every journal is retained in `delivered` state (never disposed without a terminal).
    expect(existsSync(journalPath!)).toBe(true);
    const held = readInputJournal(journalPath!);
    expect(held.ok && held.state).toBe("delivered");
    spawned[0]?.fireExit(0);
    await r1.runPromise;

    // A SECOND run with a HEALTHY store terminalizes; a delivered chain re-sends nothing.
    const spawned2: FakePty[] = [];
    const r2 = restartRun({ receiptDb, recoveryDir, spawned: spawned2, boundSessionId: RESTART_REBUILT });
    await waitFor(() => r2.sink() !== undefined, "sink2");
    r2.sink()!(BOUND_SIGNALS);
    await waitTerminal(receiptDb, receiptId);
    const s2 = openGovernorReceiptStore(receiptDb);
    expect(s2.getById(receiptId)?.handoffOutcome?.kind).toBe("handoff_success");
    s2.close();
    expect(spawned2[0]!.writes.join("")).toBe(""); // nothing re-sent
    spawned2[0]?.fireExit(0);
    await r2.runPromise;
  }, 20_000);

  it("Fable blocker 2: controlled replacement terminal-store failure retains the freshly prepared generation journal in delivered state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-current-store-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-current-store-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-current-store-rec-"));
    dirs.push(recoveryDir);
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
      journalBytes: Buffer.from("OLD"),
    });

    const spawned: FakePty[] = [];
    const r1 = restartRun({
      receiptDb,
      recoveryDir,
      spawned,
      boundSessionId: RESTART_OLD,
      storeHook: (store) => ({
        ...store,
        completeAttempt: () => {
          throw new Error("simulated controlled-replacement terminal store failure");
        },
      }),
    });
    await waitFor(() => r1.sink() !== undefined, "sink");
    r1.sink()!(BOUND_SIGNALS);
    await waitFor(() => {
      const store = openGovernorReceiptStore(receiptDb);
      try {
        return (
          store
            .getAttempt(receiptId)
            ?.artifacts.replacementGenerationEvents?.some((event) => event.kind === "respawn_ready") ?? false
        );
      } finally {
        store.close();
      }
    }, "replacement ready");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const store = openGovernorReceiptStore(receiptDb);
    const attempt = store.getAttempt(receiptId)!;
    expect(attempt.stage).not.toBe("terminal");
    expect(store.getById(receiptId)?.handoffOutcome?.kind).toBe("scheduled");
    const prep = attempt.artifacts.replacementGenerationEvents?.find((event) => event.kind === "respawn_prepared");
    const currentJournalPath = prep?.kind === "respawn_prepared" ? prep.journalPath : undefined;
    store.close();
    expect(currentJournalPath).toBeDefined();
    expect(existsSync(journalPath!)).toBe(true);
    expect(existsSync(currentJournalPath!)).toBe(true);
    const origin = readInputJournal(journalPath!);
    const current = readInputJournal(currentJournalPath!);
    expect(origin.ok && origin.state).toBe("delivered");
    expect(current.ok && current.state).toBe("delivered");

    spawned[spawned.length - 1]?.fireExit(0);
    await r1.runPromise;
  }, 20_000);

  it("finding 2: markDelivering fails before its state record is durable → re-read PENDING, no child bytes, attempt open; a healthy rerun delivers exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-md1-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-md1-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-md1-rec-"));
    dirs.push(recoveryDir);
    const bytes = Buffer.from("ZZ");
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
      journalBytes: bytes,
    });

    const spawned: FakePty[] = [];
    // Every delivery-path writeSync throws → markDelivering's state record never lands.
    const r1 = restartRun({
      receiptDb,
      recoveryDir,
      spawned,
      boundSessionId: RESTART_REBUILT,
      inputJournalDeps: {
        writeSync: () => {
          throw new Error("simulated markDelivering write failure");
        },
      },
    });
    await waitFor(() => r1.sink() !== undefined, "sink");
    r1.sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 600));

    const store = openGovernorReceiptStore(receiptDb);
    expect(store.getAttempt(receiptId)?.stage).not.toBe("terminal"); // retryable → open
    store.close();
    // Re-read shows PENDING (no durable delivering record), and NO child bytes were sent.
    const reread = readInputJournal(journalPath!);
    expect(reread.ok && reread.state).toBe("pending");
    expect(spawned[0]!.writes.join("")).not.toContain("ZZ");
    spawned[0]?.fireExit(0);
    await r1.runPromise;

    // A healthy rerun delivers EXACTLY ONCE and terminalizes.
    const spawned2: FakePty[] = [];
    const r2 = restartRun({ receiptDb, recoveryDir, spawned: spawned2, boundSessionId: RESTART_REBUILT });
    await waitFor(() => r2.sink() !== undefined, "sink2");
    r2.sink()!(BOUND_SIGNALS);
    await waitTerminal(receiptDb, receiptId);
    const s2 = openGovernorReceiptStore(receiptDb);
    expect(s2.getById(receiptId)?.handoffOutcome).toEqual({
      kind: "handoff_success",
      newSessionId: RESTART_REBUILT,
      flushedInputBytes: bytes.length,
    });
    s2.close();
    const w = spawned2[0]!.writes.join("");
    expect(w.split("ZZ").length - 1).toBe(1); // exactly once
    spawned2[0]?.fireExit(0);
    await r2.runPromise;
  }, 20_000);

  it("finding 2: markDelivered fails AFTER child.write → re-read DELIVERING (indeterminate), attempt open; a healthy rerun never re-sends or terminalizes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-md2-"));
    dirs.push(dir);
    const receiptDb = join(dir, "cc-lhc.sqlite");
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-md2-proj-"));
    dirs.push(projectsRoot);
    const recoveryDir = mkdtempSync(join(tmpdir(), "cc-lhc-3b2-md2-rec-"));
    dirs.push(recoveryDir);
    const bytes = Buffer.from("QQ");
    const { receiptId, journalPath } = await seedInterrupted({
      receiptDb,
      projectsRoot,
      recoveryDir,
      journalState: "pending-bytes",
      journalBytes: bytes,
    });

    const spawned: FakePty[] = [];
    // First delivery-path writeSync (markDelivering) lands; the second (markDelivered) throws.
    let writes = 0;
    const r1 = restartRun({
      receiptDb,
      recoveryDir,
      spawned,
      boundSessionId: RESTART_REBUILT,
      inputJournalDeps: {
        writeSync: (fd, b, o, l) => {
          writes += 1;
          if (writes >= 2) throw new Error("simulated markDelivered write failure");
          return fsWriteSync(fd, b, o, l);
        },
      },
    });
    await waitFor(() => r1.sink() !== undefined, "sink");
    r1.sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 600));

    const store = openGovernorReceiptStore(receiptDb);
    expect(store.getAttempt(receiptId)?.stage).not.toBe("terminal"); // indeterminate → open
    store.close();
    // Durable delivering (markDelivering landed), and the child DID receive the bytes once.
    const reread = readInputJournal(journalPath!);
    expect(reread.ok && reread.state).toBe("delivering");
    expect(spawned[0]!.writes.join("").split("QQ").length - 1).toBe(1);
    spawned[0]?.fireExit(0);
    await r1.runPromise;

    // A healthy rerun sees `delivering` → blocked: never re-send, never a false terminal.
    const spawned2: FakePty[] = [];
    const r2 = restartRun({ receiptDb, recoveryDir, spawned: spawned2, boundSessionId: RESTART_REBUILT });
    await waitFor(() => r2.sink() !== undefined, "sink2");
    r2.sink()!(BOUND_SIGNALS);
    await new Promise((r) => setTimeout(r, 600));
    const s2 = openGovernorReceiptStore(receiptDb);
    expect(s2.getAttempt(receiptId)?.stage).not.toBe("terminal");
    expect(s2.getById(receiptId)?.handoffOutcome?.kind).toBe("scheduled");
    s2.close();
    expect(spawned2[0]!.writes.join("")).not.toContain("QQ"); // never re-sent
    spawned2[0]?.fireExit(0);
    await r2.runPromise;
  }, 20_000);
});
