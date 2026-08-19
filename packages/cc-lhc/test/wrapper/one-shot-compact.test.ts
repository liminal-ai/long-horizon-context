/**
 * One-shot pre-launch compaction (R9 / R14.2).
 *
 * A one-shot seat runs one prompt and exits, so it compacts at the start of the
 * next invocation, before any Claude process exists. These drive run() through
 * that seam: pressure read from the persisted transcript plus the pending
 * prompt, the compact and rebuilt session written before launch, one child
 * launched on the rebuilt session with the original prompt, and the thread's
 * current session advancing only once that prompt is observed landing.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultRegistryPath } from "../../src/intake/paths.js";
import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import { currentSessionAlias } from "../../src/intake/thread-alias.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import { emptyCaptureStats } from "../../src/stats.js";
import { run } from "../../src/wrapper/run.js";

const RESUMED_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const REBUILT_ID = "bbbbbbbb-5555-6666-7777-888888888888";

const mocks = vi.hoisted(() => ({
  captureFactory: null as ((opts: CaptureSessionDeps) => CaptureSession) | null,
  /** Persisted transcript path the resumed session resolves to, or null. */
  transcriptPath: null as string | null,
  registerLineage: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
  /** When set, prompt acceptance waits on this before touching the registry. */
  acceptanceGate: null as Promise<void> | null,
  acceptanceCalls: 0,
  /** Owner-lease files present at the moment acceptance actually ran. */
  ownerLeasesDuringAcceptance: [] as string[][],
}));

vi.mock("../../src/rollout/discover.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/rollout/discover.js")>();
  return {
    ...actual,
    findExpectedSessionFileOnce: async (_cwd: string, sessionId: string) =>
      sessionId === RESUMED_ID ? mocks.transcriptPath : null,
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

vi.mock("../../src/intake/thread-alias.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intake/thread-alias.js")>();
  return {
    ...actual,
    recordSwapAcceptance: async (input: Parameters<typeof actual.recordSwapAcceptance>[0]) => {
      mocks.acceptanceCalls += 1;
      if (mocks.acceptanceGate !== null) await mocks.acceptanceGate;
      const { readdirSync } = await import("node:fs");
      const { join: joinPath } = await import("node:path");
      try {
        mocks.ownerLeasesDuringAcceptance.push(
          readdirSync(joinPath(process.env.CC_LHC_HOME ?? "", "owners")).filter((n) => n.endsWith(".json")),
        );
      } catch {
        mocks.ownerLeasesDuringAcceptance.push([]);
      }
      return actual.recordSwapAcceptance(input);
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

interface FakePty {
  pid: number;
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

function makeFakePty(pid: number, args: string[]): FakePty {
  const exitCbs: Array<(arg: { exitCode: number; signal?: number }) => void> = [];
  const dataCbs: Array<(data: string) => void> = [];
  const fake: FakePty = {
    pid,
    args,
    killed: [],
    writes: [],
    fireExit(code: number, signal?: number) {
      for (const cb of exitCbs) cb({ exitCode: code, ...(signal === undefined ? {} : { signal }) });
    },
    onData: (cb) => {
      dataCbs.push(cb);
      setTimeout(() => {
        for (const dataCb of dataCbs) dataCb("render\r\n");
      }, 20);
      return { dispose() {} };
    },
    onExit: (cb) => {
      exitCbs.push(cb);
      return { dispose() {} };
    },
    kill: (signal?: string) => {
      fake.killed.push(signal ?? "SIGTERM");
      setImmediate(() => fake.fireExit(0, signal === "SIGKILL" ? 9 : 15));
    },
    write: (data: string) => {
      fake.writes.push(data);
    },
    resize: () => {},
  };
  return fake;
}

interface CompactSdkOptions {
  compactFails?: boolean;
}

function sdkForCapture(options: CompactSdkOptions = {}) {
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
      compact: vi.fn(async () =>
        options.compactFails === true
          ? { ok: false, error: { errorClass: "system_error", code: "storage_failure", reason: "disk on fire" } }
          : {
              ok: true,
              value: {
                viewId: "v1",
                tailTokens: 5,
                totalTokens: 900,
                bands: {
                  smooth: { entries: 1, tokens: 4 },
                  detailed: { entries: 0, tokens: 0 },
                  brief: { entries: 0, tokens: 0 },
                },
              },
            },
      ),
      prune: vi.fn(),
      getSessionThreadView: vi.fn(async () => ({
        ok: true,
        value: { threadId: "th_one_shot", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
      })),
    },
    intakeStream: { messageEvents: async () => ({ ok: true, value: { events: [] } }) },
  };
}

type ScriptedPhase = "ready" | "degraded" | "binding";

/** Each scripted session's stop(), keyed by the deps it was built from. */
const scriptedStops = new WeakMap<CaptureSessionDeps, ReturnType<typeof vi.fn>>();

/** A capture session the test drives directly: phase, turn state, lifecycle. */
function scriptedCaptureSession(
  opts: CaptureSessionDeps,
  sdk: unknown,
  phase: ScriptedPhase,
  generation: number,
  turnOpen = false,
): CaptureSession {
  const threadId =
    opts.launchThread?.threadId ??
    (opts.continueCapture !== undefined && "threadId" in opts.continueCapture.threadRef
      ? opts.continueCapture.threadRef.threadId
      : "th_one_shot");
  const stats = { ...emptyCaptureStats(), threadId };
  const stopSpy = vi.fn(async () => {});
  scriptedStops.set(opts, stopSpy);
  return {
    stats,
    getCommandContext: () => ({
      stats,
      sdk: sdk as Lhc,
      threadRef: { threadId, registryPath: defaultRegistryPath() },
      captureDegraded: phase === "degraded",
      captureGeneration: generation,
      capturePhase: phase,
    }),
    getRolloutInfo: () => ({
      path: opts.knownRolloutPath,
      sessionId: opts.expectedSession?.sessionId,
    }),
    isTurnOpen: () => turnOpen,
    isCaptureHealthy: () => phase === "ready",
    isCaptureReady: () => phase === "ready",
    getCaptureHealth: () => ({
      generation,
      phase,
      reasons: [],
      reasonCounts: {},
      durableLineOffset: 0,
    }),
    getCaptureGeneration: () => generation,
    stop: stopSpy,
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

async function waitForAsync(condition: () => Promise<boolean>, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
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

/** The last authoritative provider reading a persisted transcript carries. */
function transcriptSampling(totalTokens: number): LifecycleSignal[] {
  return [
    { kind: "turn_opened", reason: "user_prompt" },
    {
      kind: "sampling_observed",
      samplingId: "req:prior",
      providerUsage: {
        input_tokens: totalTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    { kind: "turn_settled", reason: "end_turn" },
  ];
}

interface OneShotHarness {
  spawned: FakePty[];
  captureCalls: CaptureSessionDeps[];
  /** Lifecycle sink of the capture generation bound to the launched session. */
  launchedSink: () => ((signals: readonly LifecycleSignal[]) => void) | undefined;
  /** Children alive when the rebuilt session was written; -1 = never written. */
  spawnedWhenRebuilt: () => number;
  /** Whether the capture bound to the resumed session was stopped. */
  resumedStopped: () => boolean;
}

describe("run: one-shot pre-launch compaction", () => {
  const savedHome = process.env.CC_LHC_HOME;
  const dirs: string[] = [];
  let rolloutDir: string;

  beforeEach(() => {
    mocks.captureFactory = null;
    mocks.registerLineage.mockClear();
    mocks.acceptanceGate = null;
    mocks.acceptanceCalls = 0;
    mocks.ownerLeasesDuringAcceptance = [];
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-one-shot-home-"));
    dirs.push(home);
    process.env.CC_LHC_HOME = home;
    rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-one-shot-rollout-"));
    dirs.push(rolloutDir);
    const transcript = join(rolloutDir, `${RESUMED_ID}.jsonl`);
    writeFileSync(transcript, '{"line":1}\n');
    mocks.transcriptPath = transcript;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.captureFactory = null;
    mocks.transcriptPath = null;
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  /**
   * One one-shot invocation. `transcriptTokens` is the last authoritative
   * provider reading recovered from the persisted transcript (null = none), and
   * `capturePhase` is what catching up from that transcript reached.
   */
  function launchOneShot(input: {
    prompt: string;
    transcriptTokens: number | null;
    capturePhase?: ScriptedPhase;
    /** The caught-up transcript ends inside an unfinished turn. */
    transcriptTurnOpen?: boolean;
    compactFails?: boolean;
    writeFails?: boolean;
    /** Capture on the rebuilt session refuses to start. */
    rebuiltCaptureThrows?: boolean;
    /** Argv this invocation launches with (defaults to `-p <prompt> --resume`). */
    argv?: string[];
    onSpawn?: (fake: FakePty, index: number) => void;
  }): { harness: OneShotHarness; runPromise: Promise<number>; rebuiltPath: string; writeSpy: ReturnType<typeof vi.spyOn> } {
    const sdk = sdkForCapture(input.compactFails === true ? { compactFails: true } : {});
    const spawned: FakePty[] = [];
    /** Children alive when the rebuilt session was written; -1 = never written. */
    let spawnedWhenRebuilt = -1;
    const captureCalls: CaptureSessionDeps[] = [];
    const sinks = new Map<string, (signals: readonly LifecycleSignal[]) => void>();

    const rebuiltPath = join(rolloutDir, `${REBUILT_ID}.jsonl`);
    const rebuiltContent = '{"line":1}\n{"line":2}\n';
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async () => {
      // The whole seam runs before any Claude process exists.
      spawnedWhenRebuilt = spawned.length;
      if (input.writeFails === true) throw new Error("rebuilt rollout write failed");
      writeFileSync(rebuiltPath, rebuiltContent);
      return {
        sessionId: REBUILT_ID,
        rolloutPath: rebuiltPath,
        lineCount: 2,
        expectedReintakeLines: 2,
        replayedPrefixLines: 2,
        prefixBoundary: { kind: "verified", lineCount: 2, byteLength: 24, sha256: "cc".repeat(32) },
        totalByteLength: Buffer.byteLength(rebuiltContent),
      };
    });

    mocks.captureFactory = (opts) => {
      captureCalls.push(opts);
      const sessionId = opts.expectedSession?.sessionId ?? "";
      const isRebuilt = sessionId === REBUILT_ID;
      if (isRebuilt && input.rebuiltCaptureThrows === true) {
        throw new Error("rebuilt capture would not start");
      }
      const session = scriptedCaptureSession(
        opts,
        sdk,
        isRebuilt ? "ready" : (input.capturePhase ?? "ready"),
        captureCalls.length,
        isRebuilt ? false : input.transcriptTurnOpen === true,
      );
      if (opts.onLifecycle !== undefined) {
        sinks.set(sessionId, opts.onLifecycle);
        // The transcript's own history reaches the pre-launch seam the same way
        // live capture reaches the wrapper: as lifecycle from the bound file.
        if (!isRebuilt && input.transcriptTokens !== null) {
          opts.onLifecycle(transcriptSampling(input.transcriptTokens));
        }
      }
      return session;
    };

    const runPromise = run(input.argv ?? ["-p", input.prompt, "--resume", RESUMED_ID], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(9100 + spawned.length, args);
        spawned.push(fake);
        input.onSpawn?.(fake, spawned.length - 1);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: join(rolloutDir, "receipts.sqlite"),
      preLaunchCaptureTimeoutMs: 2_000,
    });

    return {
      harness: {
        spawned,
        captureCalls,
        launchedSink: () => sinks.get(REBUILT_ID) ?? sinks.get(RESUMED_ID),
        spawnedWhenRebuilt: () => spawnedWhenRebuilt,
        resumedStopped: () =>
          captureCalls[0] !== undefined && (scriptedStops.get(captureCalls[0])?.mock.calls.length ?? 0) > 0,
      },
      runPromise,
      rebuiltPath,
      writeSpy,
    };
  }

  it("over trigger: compacts before launch, launches once on the rebuilt session with the original prompt", async () => {
    const { harness, runPromise } = launchOneShot({ prompt: "do the thing", transcriptTokens: 6_000 });

    await waitFor(() => harness.spawned.length === 1, "the single launched child");
    const args = harness.spawned[0]!.args;
    expect(args[args.indexOf("--resume") + 1]).toBe(REBUILT_ID);
    expect(args).toContain("do the thing");
    // Exactly one execution of the prompt: one child, one occurrence in its argv.
    expect(args.filter((token) => token === "do the thing")).toHaveLength(1);

    // No Claude child existed while the compact ran and the rebuild was written.
    expect(harness.spawnedWhenRebuilt()).toBe(0);

    // Capture was caught up on the resumed session first, then moved onto the
    // rebuilt one — both before any Claude process existed.
    expect(harness.captureCalls).toHaveLength(2);
    expect(harness.captureCalls[0]!.expectedSession?.sessionId).toBe(RESUMED_ID);
    expect(harness.captureCalls[1]!.expectedSession?.sessionId).toBe(REBUILT_ID);
    expect(harness.captureCalls[1]!.prefixBoundary).toMatchObject({ kind: "verified", lineCount: 2 });
    expect(harness.captureCalls[1]!.suppressBindLineageRecord).toBe(true);
    expect(mocks.registerLineage).toHaveBeenCalledOnce();

    harness.spawned[0]!.fireExit(0);
    await runPromise;
    expect(harness.spawned).toHaveLength(1);
  }, 20_000);

  it("the current-session pointer advances only when the rebuilt session is observed taking the prompt", async () => {
    const { harness, runPromise } = launchOneShot({ prompt: "do the thing", transcriptTokens: 6_000 });

    await waitFor(() => harness.spawned.length === 1, "launched child");
    await waitFor(() => harness.launchedSink() !== undefined, "rebuilt lifecycle sink");
    const registryPath = defaultRegistryPath();
    const threadId = harness.captureCalls[0]!.launchThread!.threadId;

    // Before intake the thread still belongs to the session this invocation resumed.
    expect(await currentSessionAlias(threadId, registryPath)).toBe(`claude-code:${RESUMED_ID}`);

    // Claude writes the prompt into the rebuilt rollout: the intake evidence.
    harness.launchedSink()!([{ kind: "turn_opened", reason: "user_prompt" }]);
    await waitForAsync(
      async () => (await currentSessionAlias(threadId, registryPath)) === `claude-code:${REBUILT_ID}`,
      "current-session pointer to advance after prompt intake",
    );

    harness.spawned[0]!.fireExit(0);
    await runPromise;
  }, 20_000);

  it("teardown settles the prompt acceptance before it hands back the thread lease", async () => {
    let releaseAcceptance: (() => void) | undefined;
    mocks.acceptanceGate = new Promise<void>((r) => {
      releaseAcceptance = r;
    });
    const { harness, runPromise } = launchOneShot({ prompt: "do the thing", transcriptTokens: 6_000 });

    await waitFor(() => harness.spawned.length === 1, "launched child");
    await waitFor(() => harness.launchedSink() !== undefined, "rebuilt lifecycle sink");
    const threadId = harness.captureCalls[0]!.launchThread!.threadId;

    // Claude takes the prompt and the one-shot child exits immediately after —
    // the acceptance is still in flight when teardown begins. The duplicate
    // signal must not produce a second attempt.
    harness.launchedSink()!([{ kind: "turn_opened", reason: "user_prompt" }]);
    harness.launchedSink()!([{ kind: "turn_opened", reason: "user_prompt" }]);
    harness.spawned[0]!.fireExit(0);

    await waitFor(() => mocks.acceptanceCalls === 1, "the single acceptance attempt");
    const settledEarly = await Promise.race([
      runPromise.then(() => "settled" as const),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 400)),
    ]);
    expect(settledEarly).toBe("pending");
    expect(mocks.acceptanceCalls).toBe(1);

    releaseAcceptance?.();
    await runPromise;
    expect(mocks.acceptanceCalls).toBe(1);
    // The wrapper still owned the thread when the acceptance ran.
    expect(mocks.ownerLeasesDuringAcceptance).toHaveLength(1);
    expect(mocks.ownerLeasesDuringAcceptance[0]!.length).toBe(1);
    expect(await currentSessionAlias(threadId, defaultRegistryPath())).toBe(`claude-code:${REBUILT_ID}`);
  }, 20_000);

  it("launch that never takes the prompt keeps the old pointer and never resends", async () => {
    const { harness, runPromise } = launchOneShot({ prompt: "do the thing", transcriptTokens: 6_000 });

    await waitFor(() => harness.spawned.length === 1, "launched child");
    const registryPath = defaultRegistryPath();
    const threadId = harness.captureCalls[0]!.launchThread!.threadId;

    // The child dies without ever writing a prompt into the rebuilt rollout.
    harness.spawned[0]!.fireExit(1);
    await runPromise;

    expect(await currentSessionAlias(threadId, registryPath)).toBe(`claude-code:${RESUMED_ID}`);
    // Nothing was relaunched: the prompt is the operator's to resend.
    expect(harness.spawned).toHaveLength(1);
  }, 20_000);

  it("under trigger: no compact, one launch on the session this invocation resumed", async () => {
    const { harness, runPromise, writeSpy } = launchOneShot({ prompt: "hi", transcriptTokens: 1_000 });

    await waitFor(() => harness.spawned.length === 1, "launched child");
    const args = harness.spawned[0]!.args;
    expect(args[args.indexOf("--resume") + 1]).toBe(RESUMED_ID);
    expect(args).toContain("hi");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(harness.captureCalls).toHaveLength(1);

    harness.spawned[0]!.fireExit(0);
    await runPromise;
    const threadId = harness.captureCalls[0]!.launchThread!.threadId;
    expect(await currentSessionAlias(threadId, defaultRegistryPath())).toBe(`claude-code:${RESUMED_ID}`);
  }, 20_000);

  it("the pending prompt is part of the pressure: the same transcript crosses only with a big enough prompt", async () => {
    const small = launchOneShot({ prompt: "hi", transcriptTokens: 4_900 });
    await waitFor(() => small.harness.spawned.length === 1, "small-prompt child");
    expect(small.harness.spawned[0]!.args[small.harness.spawned[0]!.args.indexOf("--resume") + 1]).toBe(RESUMED_ID);
    small.harness.spawned[0]!.fireExit(0);
    await small.runPromise;
    small.writeSpy.mockRestore();

    const big = launchOneShot({ prompt: "x".repeat(2_000), transcriptTokens: 4_900 });
    await waitFor(() => big.harness.spawned.length === 1, "big-prompt child");
    expect(big.harness.spawned[0]!.args[big.harness.spawned[0]!.args.indexOf("--resume") + 1]).toBe(REBUILT_ID);
    big.harness.spawned[0]!.fireExit(0);
    await big.runPromise;
  }, 30_000);

  it("no provider reading in the transcript: pressure falls back to the estimate and still compacts", async () => {
    const { harness, runPromise } = launchOneShot({ prompt: "x".repeat(24_000), transcriptTokens: null });

    await waitFor(() => harness.spawned.length === 1, "launched child");
    expect(harness.spawned[0]!.args[harness.spawned[0]!.args.indexOf("--resume") + 1]).toBe(REBUILT_ID);

    harness.spawned[0]!.fireExit(0);
    await runPromise;
  }, 20_000);

  it("capture that came back degraded does not compact: the prompt runs once on the resumed session", async () => {
    const { harness, runPromise, writeSpy } = launchOneShot({
      prompt: "do the thing",
      transcriptTokens: 6_000,
      capturePhase: "degraded",
    });

    await waitFor(() => harness.spawned.length === 1, "launched child");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(harness.spawned[0]!.args[harness.spawned[0]!.args.indexOf("--resume") + 1]).toBe(RESUMED_ID);
    expect(harness.spawned[0]!.args).toContain("do the thing");
    // The bound capture is left alive to keep catching up behind the prompt.
    expect(harness.resumedStopped()).toBe(false);
    expect(harness.captureCalls).toHaveLength(1);

    harness.spawned[0]!.fireExit(0);
    await runPromise;
    expect(harness.spawned).toHaveLength(1);
    const threadId = harness.captureCalls[0]!.launchThread!.threadId;
    expect(await currentSessionAlias(threadId, defaultRegistryPath())).toBe(`claude-code:${RESUMED_ID}`);
  }, 20_000);

  it("catch-up that never reaches ready inside the bound does not compact; the launch still happens", async () => {
    const { harness, runPromise, writeSpy } = launchOneShot({
      prompt: "do the thing",
      transcriptTokens: 6_000,
      capturePhase: "binding",
    });

    await waitFor(() => harness.spawned.length === 1, "launched child", 12_000);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(harness.spawned[0]!.args[harness.spawned[0]!.args.indexOf("--resume") + 1]).toBe(RESUMED_ID);
    expect(harness.spawned[0]!.args).toContain("do the thing");
    expect(harness.resumedStopped()).toBe(false);

    harness.spawned[0]!.fireExit(0);
    await runPromise;
    expect(harness.spawned).toHaveLength(1);
  }, 30_000);

  it("a transcript ending in an unfinished turn is not a settled snapshot: no compact, one launch", async () => {
    const { harness, runPromise, writeSpy } = launchOneShot({
      prompt: "do the thing",
      transcriptTokens: 6_000,
      transcriptTurnOpen: true,
    });

    await waitFor(() => harness.spawned.length === 1, "launched child");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(harness.spawned[0]!.args[harness.spawned[0]!.args.indexOf("--resume") + 1]).toBe(RESUMED_ID);
    expect(harness.spawned[0]!.args).toContain("do the thing");
    expect(harness.resumedStopped()).toBe(false);

    harness.spawned[0]!.fireExit(0);
    await runPromise;
    const threadId = harness.captureCalls[0]!.launchThread!.threadId;
    expect(await currentSessionAlias(threadId, defaultRegistryPath())).toBe(`claude-code:${RESUMED_ID}`);
  }, 20_000);

  it("capture that will not start on the rebuilt session falls back to the resumed session, still captured", async () => {
    const { harness, runPromise } = launchOneShot({
      prompt: "do the thing",
      transcriptTokens: 6_000,
      rebuiltCaptureThrows: true,
    });

    await waitFor(() => harness.spawned.length === 1, "launched child");
    const args = harness.spawned[0]!.args;
    expect(args[args.indexOf("--resume") + 1]).toBe(RESUMED_ID);
    expect(args.filter((token) => token === "do the thing")).toHaveLength(1);
    // The resumed session's capture was never stopped for a replacement that
    // never existed.
    expect(harness.resumedStopped()).toBe(false);

    harness.spawned[0]!.fireExit(0);
    await runPromise;
    expect(harness.spawned).toHaveLength(1);
    const threadId = harness.captureCalls[0]!.launchThread!.threadId;
    expect(await currentSessionAlias(threadId, defaultRegistryPath())).toBe(`claude-code:${RESUMED_ID}`);
  }, 20_000);

  it("--print= is a one-shot too: it compacts before launch and the argv token is untouched", async () => {
    const { harness, runPromise } = launchOneShot({
      prompt: "unused",
      transcriptTokens: 6_000,
      argv: ["--print=1", "do the thing", "--resume", RESUMED_ID],
    });

    await waitFor(() => harness.spawned.length === 1, "launched child");
    const args = harness.spawned[0]!.args;
    expect(args[args.indexOf("--resume") + 1]).toBe(REBUILT_ID);
    // The launch argv is replayed byte for byte onto the rebuilt session.
    expect(args).toContain("--print=1");
    expect(args.filter((token) => token === "do the thing")).toHaveLength(1);

    harness.spawned[0]!.fireExit(0);
    await runPromise;
    expect(harness.spawned).toHaveLength(1);
  }, 20_000);

  it("compact failure launches the prompt on the resumed session, once", async () => {
    const { harness, runPromise } = launchOneShot({
      prompt: "do the thing",
      transcriptTokens: 6_000,
      compactFails: true,
    });

    await waitFor(() => harness.spawned.length === 1, "launched child");
    expect(harness.spawned[0]!.args[harness.spawned[0]!.args.indexOf("--resume") + 1]).toBe(RESUMED_ID);
    expect(harness.spawned[0]!.args).toContain("do the thing");
    expect(mocks.registerLineage).not.toHaveBeenCalled();

    harness.spawned[0]!.fireExit(0);
    await runPromise;
    expect(harness.spawned).toHaveLength(1);
  }, 20_000);

  it("rebuilt-rollout write failure launches the prompt on the resumed session, once", async () => {
    const { harness, runPromise } = launchOneShot({
      prompt: "do the thing",
      transcriptTokens: 6_000,
      writeFails: true,
    });

    await waitFor(() => harness.spawned.length === 1, "launched child");
    expect(harness.spawned[0]!.args[harness.spawned[0]!.args.indexOf("--resume") + 1]).toBe(RESUMED_ID);
    expect(mocks.registerLineage).not.toHaveBeenCalled();

    harness.spawned[0]!.fireExit(0);
    await runPromise;
    expect(harness.spawned).toHaveLength(1);
  }, 20_000);

  it("a one-shot on a session with no persisted transcript launches directly", async () => {
    mocks.transcriptPath = null;
    const { harness, runPromise, writeSpy } = launchOneShot({ prompt: "hello", transcriptTokens: 6_000 });

    await waitFor(() => harness.spawned.length === 1, "launched child");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(harness.spawned[0]!.args[harness.spawned[0]!.args.indexOf("--resume") + 1]).toBe(RESUMED_ID);

    harness.spawned[0]!.fireExit(0);
    await runPromise;
  }, 20_000);
});
