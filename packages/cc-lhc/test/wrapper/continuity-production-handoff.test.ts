/**
 * LIM-145 production handoff: real rollout records feed the parent-owned
 * continuity record, the settled Smart Compact seam accepts one carryover
 * generation without waiting or asking, the rebuilt session receives the
 * manifest, each mechanism is invoked once after the replacement is live, and
 * the generation closes. Covers TC-2.3a/b, TC-2.5a-d, TC-2.6a, TC-2.8a-c and
 * the Monitor relaunch fence.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qualifyActiveItems, statPathReal } from "../../src/continuity/adapters.js";
import { invokeCarryover, relaunchOutputPath } from "../../src/continuity/handoff.js";
import { createContinuityObserver } from "../../src/continuity/observe.js";
import { type ContinuitySnapshot, closeContinuitySnapshot, snapshotContinuity } from "../../src/continuity/snapshot.js";
import { type ContinuityStore, openContinuityStore } from "../../src/continuity/store.js";
import { CONTEXT_WINDOW_NOT_YET_OBSERVED } from "../../src/governor/config.js";
import { openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import { createAsyncWorkFold, observeAsyncWorkLine, openAsyncWork } from "../../src/observation/async-work.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import { emptyCaptureStats } from "../../src/stats.js";
import type { HandoffResult } from "../../src/wrapper/handoff.js";
import { run } from "../../src/wrapper/run.js";
import { LAUNCH_IDS, LAUNCHES, type LaunchPaths, notification, toolResult, toolUse } from "../continuity/helpers.js";

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
const T = "th_auto";
/** A real, harmless Monitor command: the relaunch proves itself by what it writes. */
const MONITOR_COMMAND = "printf relaunched-once-XyZ";
const MONITOR_LINES = [
  toolUse("toolu_mon", "Monitor", { command: MONITOR_COMMAND, description: "CI watch" }),
  toolResult("toolu_mon", { taskId: "mon-1", timeoutMs: 60_000, persistent: false }),
];

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
    fireExit(code, signal) {
      for (const cb of exitCbs) cb({ exitCode: code, ...(signal === undefined ? {} : { signal }) });
    },
    onData: (cb) => {
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
      setImmediate(() => fake.fireExit(0, signal === "SIGKILL" ? 9 : 15));
    },
    write: (data) => {
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
        value: { threadId: T, entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
      })),
    },
    intakeStream: { messageEvents: async () => ({ ok: true, value: { events: [] } }) },
  };
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
    lowerBoundTokens: 1_000,
    upperBoundTokens: 5_000,
    profile: "default",
    pruneEnabled: false,
    pruneThresholdTokens: null,
    pruneTargetTokens: null,
    minRunwayTokens: 100,
  },
  sources: Object.fromEntries(
    [
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
  contextWindow: CONTEXT_WINDOW_NOT_YET_OBSERVED,
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

/** The old session's host layout, as Claude Code 2.1.252 lays it out, plus its rollout file. */
function hostLayout(home: string, opts: { monitorInRollout?: boolean; agentTranscript?: boolean } = {}) {
  const root = join(home, "claude-projects");
  const sessionDir = join(root, "session-old");
  const tasksDir = join(home, "tasks");
  mkdirSync(join(sessionDir, "subagents", "workflows", "wf_run-1"), { recursive: true });
  mkdirSync(join(sessionDir, "workflows", "scripts"), { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  if (opts.agentTranscript !== false) writeFileSync(join(sessionDir, "subagents", "agent-agent-1.jsonl"), "");
  writeFileSync(join(sessionDir, "subagents", "workflows", "wf_run-1", "journal.jsonl"), "");
  writeFileSync(join(sessionDir, "workflows", "scripts", "deploy-wf_run-1.js"), "");
  writeFileSync(join(tasksDir, "shell-1.output"), "");
  writeFileSync(join(tasksDir, "mon-1.output"), "");
  const paths: LaunchPaths = { sessionDir, tasksDir };
  const rolloutPath = `${sessionDir}.jsonl`;
  const rolloutLines = opts.monitorInRollout === false ? [] : MONITOR_LINES;
  writeFileSync(rolloutPath, `${rolloutLines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return { paths, rolloutPath };
}

/** Every family launched, as the old child's rollout reports it. */
function fiveFamilyLaunch(paths: LaunchPaths): RolloutLineItem[] {
  return [
    ...LAUNCHES.agent.lines(paths),
    ...LAUNCHES.workflow.lines(paths),
    ...LAUNCHES.background_shell.lines(paths),
    ...MONITOR_LINES,
    ...LAUNCHES.scheduled_wakeup.lines(paths),
  ];
}

interface Rig {
  home: string;
  dbPath: string;
  monitorOutputDir: string;
  rolloutPath: string;
  paths: LaunchPaths;
  sdk: ReturnType<typeof sdkForCapture>;
  spawned: FakePty[];
  stdin: NodeJS.ReadStream & NodeJS.WriteStream;
  results: HandoffResult[];
  receipts: string[];
  terminalOutput: () => string;
  feed: (lines: RolloutLineItem[]) => void;
  /** Feed the newest capture (the replacement after a handoff). */
  feedCurrent: (lines: RolloutLineItem[]) => void;
  lifecycle: (signals: readonly LifecycleSignal[]) => void;
  runPromise: Promise<number>;
  finish: () => Promise<number>;
}

const homes: string[] = [];

/** Launch the wrapper on the old session with capture fed by real rollout records. */
async function launch(layout: Parameters<typeof hostLayout>[1] = {}): Promise<Rig> {
  const home = mkdtempSync(join(tmpdir(), "cc-lhc-continuity-prod-"));
  homes.push(home);
  process.env.CC_LHC_HOME = home;
  const { paths, rolloutPath } = hostLayout(home, layout);
  const dbPath = join(home, "cc-lhc.sqlite");
  const sdk = sdkForCapture();
  const spawned: FakePty[] = [];
  const results: HandoffResult[] = [];
  const receipts: string[] = [];
  let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
  let feedOld: ((lines: RolloutLineItem[]) => void) | undefined;
  let feedCurrent: ((lines: RolloutLineItem[]) => void) | undefined;

  const rebuiltPath = join(home, `${REBUILT_ID}.jsonl`);
  vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async (input) => {
    receipts.push(input.receipt?.text ?? "");
    const content = '{"line":1}\n{"line":2}\n{"line":3}\n';
    writeFileSync(rebuiltPath, content);
    return {
      sessionId: REBUILT_ID,
      rolloutPath: rebuiltPath,
      lineCount: 3,
      expectedReintakeLines: 3,
      replayedPrefixLines: 2,
      prefixBoundary: { kind: "verified", lineCount: 2, byteLength: 40, sha256: "aa".repeat(32) },
      totalByteLength: Buffer.byteLength(content),
    };
  });

  let generation = 0;
  mocks.captureFactory = (opts) => {
    generation += 1;
    const isRebuilt = opts.knownRolloutPath !== undefined;
    const sessionId = isRebuilt ? REBUILT_ID : "old-session";
    const path = isRebuilt ? opts.knownRolloutPath! : rolloutPath;
    // The real fold, wired to the parent exactly as production wires it — including the carried seed.
    const fold = createAsyncWorkFold((event) => opts.onAsyncWorkEvent?.(event, T), opts.seedAsyncWork ?? []);
    const feed = (lines: RolloutLineItem[]) => {
      for (const line of lines) observeAsyncWorkLine(line, fold);
    };
    feedCurrent = feed;
    if (!isRebuilt) {
      lifecycleSink = opts.onLifecycle;
      feedOld = feed;
    }
    const stats = { ...emptyCaptureStats(), threadId: T };
    const gen = generation;
    return {
      stats,
      getCommandContext: () => ({
        stats,
        sdk: sdk as unknown as Lhc,
        threadRef: { threadId: T, registryPath: join(home, "reg.sqlite") },
        captureDegraded: false,
        captureGeneration: gen,
        capturePhase: "ready" as const,
      }),
      getRolloutInfo: () => ({ path, sessionId }),
      isTurnOpen: () => false,
      isCaptureHealthy: () => true,
      isCaptureReady: () => true,
      getCaptureHealth: () => ({
        generation: gen,
        phase: "ready" as const,
        reasons: [],
        reasonCounts: {},
        durableLineOffset: 0,
      }),
      getCaptureGeneration: () => gen,
      getLiveAsyncWork: () => openAsyncWork(fold),
      stop: vi.fn(async () => {}),
    } as unknown as CaptureSession;
  };

  const stdin = fakeStream();
  const stdout = fakeStream();
  let terminalOutput = "";
  (stdout as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
    terminalOutput += chunk.toString("utf8");
  });
  const runPromise = run([], {
    claudeBin: "fake-claude",
    spawnPty: ((_file: string, args: string[]) => {
      const fake = makeFakePty(1000 + spawned.length, args);
      spawned.push(fake);
      return fake as never;
    }) as never,
    stdin,
    stdout: stdout as never,
    stderr: fakeStream() as never,
    noInference: true,
    resolvedContextPolicy: POLICY as never,
    governorReceiptDbPath: dbPath,
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
  await waitFor(() => lifecycleSink !== undefined && feedOld !== undefined, "old capture");
  await waitFor(() => spawned.length === 1, "first child");
  lifecycleSink!(BOUND_SIGNALS);
  return {
    home,
    dbPath,
    monitorOutputDir: join(home, "continuity"),
    rolloutPath,
    paths,
    sdk,
    spawned,
    stdin,
    results,
    receipts,
    terminalOutput: () => terminalOutput,
    feed: (lines) => feedOld!(lines),
    feedCurrent: (lines) => feedCurrent!(lines),
    lifecycle: (signals) => lifecycleSink!(signals),
    runPromise,
    finish: async () => {
      spawned[spawned.length - 1]!.fireExit(0);
      return runPromise;
    },
  };
}

/** Wait until the parent has recorded every launch the old rollout reported. */
async function storeHas(dbPath: string, launchIds: readonly string[]): Promise<void> {
  await waitFor(() => {
    const store = openContinuityStore(dbPath);
    try {
      return launchIds.every((id) => store.getItem(T, id) !== null);
    } finally {
      store.close();
    }
  }, "continuity record");
}

function withStore<R>(dbPath: string, fn: (store: ContinuityStore) => R): R {
  const store = openContinuityStore(dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** The generation's snapshot, re-read from the store alone. */
function snapshotOf(store: ContinuityStore, generation: number): ContinuitySnapshot {
  const gen = store.getGeneration(T, generation);
  if (gen === null) throw new Error("no generation");
  const closure = closeContinuitySnapshot(store, { threadId: T, generation, nowMs: Date.now() });
  return {
    threadId: T,
    generation,
    oldSessionId: gen.oldSessionId,
    createdAtMs: gen.createdAtMs,
    items: closure.carried,
  };
}

const ALL_IDS = Object.values(LAUNCH_IDS);

/** The wrapper log appends asynchronously: read it fresh each time. */
function wrapperLog(rig: Pick<Rig, "home">): string {
  const path = join(rig.home, "wrapper.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
const savedHome = process.env.CC_LHC_HOME;

describe("LIM-145 production handoff: carry active work through Smart Compact", () => {
  beforeEach(() => {
    mocks.captureFactory = null;
    mocks.registerLineage.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.captureFactory = null;
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("TC-2.3a/2.5a-c/2.6a/2.8a: five live families, no delay, no consent — one snapshot, the manifest in the rebuilt session, one closed generation", async () => {
    const rig = await launch();
    rig.feed(fiveFamilyLaunch(rig.paths));
    await storeHas(rig.dbPath, ALL_IDS);
    const before = Date.now();
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "handoff result");
    // No wait for the work, no question asked: the seam ran straight into the swap.
    expect(rig.results[0]!.kind).toBe("success");
    expect(Date.now() - before).toBeLessThan(5_000);
    expect(rig.sdk.threadView.compact).toHaveBeenCalledOnce();
    expect(rig.terminalOutput()).not.toMatch(/Compact now|wait|confirm|\[y\/n\]/i);

    // The replacement receives one manifest: every family once, with its truthful transition.
    expect(rig.receipts).toHaveLength(1);
    const note = rig.receipts[0]!;
    expect(note).toContain("Tracked background work carried into this session (generation 1)");
    expect(note).toContain('background agent "reviewer" (agent-1): resumed: continue it with SendMessage to agent-1');
    expect(note).toContain("workflow");
    expect(note).toContain("resumed: continue it with Workflow resumeFromRunId wf_run-1");
    expect(note).toContain(
      `background command (shell-1): adopted: still running, uninterrupted; output file ${join(rig.paths.tasksDir, "shell-1.output")}`,
    );
    expect(note).toContain('monitor "CI watch" (mon-1): restarted: its previous run ended with the replaced process');
    expect(note).toContain(`output file ${relaunchOutputPath(rig.monitorOutputDir, LAUNCH_IDS.monitor, 1)}`);
    expect(note).toContain("scheduled wakeup (fires in");
    expect(note).toContain("re-armed");
    expect(note).not.toContain("cannot return output");

    // The generation closed after the transfer; every item is its member and still active.
    withStore(rig.dbPath, (store) => {
      expect(store.getGeneration(T, 1)).toMatchObject({ state: "closed", oldSessionId: "old-session" });
      expect(store.latestGeneration(T)?.generation).toBe(1);
      for (const id of ALL_IDS) expect(store.getItem(T, id), id).toMatchObject({ generation: 1, state: "active" });
      expect(store.getItem(T, LAUNCH_IDS.monitor)?.verifiedIdentity).toEqual({
        kind: "monitor_launch",
        toolUseId: "toolu_mon",
        rolloutPath: rig.rolloutPath,
      });
    });
    await waitFor(
      () => wrapperLog(rig).includes("cc-lhc continuity: generation 1 closed: 5 carried, 0 not carried"),
      "closure log",
    );
    await rig.finish();
  }, 15_000);

  it("TC-2.7a/2.7e: carried work finishing while the replacement is idle writes one durable pending result with zero provider calls, no PTY input, no rollout mutation; the panel shows it read-only", async () => {
    const rig = await launch();
    rig.feed(fiveFamilyLaunch(rig.paths));
    await storeHas(rig.dbPath, ALL_IDS);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "handoff result");
    expect(rig.results[0]!.kind).toBe("success");
    await waitFor(() => rig.spawned.length === 2, "replacement child");

    const store = openContinuityStore(rig.dbPath);
    const rebuiltPath = join(rig.home, `${REBUILT_ID}.jsonl`);
    const sdkCalls = () =>
      Object.fromEntries(
        Object.entries(rig.sdk.threadView).map(([name, fn]) => [
          name,
          (fn as ReturnType<typeof vi.fn>).mock.calls.length,
        ]),
      );
    const before = {
      sdk: sdkCalls(),
      ptyWrites: rig.spawned.map((p) => p.writes.length),
      rollout: readFileSync(rebuiltPath),
      terminal: rig.terminalOutput().length,
      receipts: rig.receipts.length,
    };
    expect(store.listPendingResults(T)).toHaveLength(0);

    // The carried agent and shell finish in the rebuilt session's own rollout while Claude is idle;
    // the same evidence arriving again is absorbed.
    rig.feedCurrent([notification({ taskIds: ["agent-1"], status: "completed" })]);
    rig.feedCurrent([notification({ taskIds: ["shell-1"], status: "failed" })]);
    rig.feedCurrent([notification({ taskIds: ["agent-1"], status: "completed" })]);
    await waitFor(() => store.listPendingResults(T).length === 2, "durable results");

    const pending = store.listPendingResults(T);
    expect(pending.map((r) => [r.launchId, r.outcome, r.generation, r.delivery, r.artifact?.kind ?? null])).toEqual([
      [LAUNCH_IDS.agent, "completed", 1, "pending", null],
      [LAUNCH_IDS.background_shell, "failed", 1, "pending", "adopted_output"],
    ]);
    expect(pending[0]!.label).toBe('background agent "reviewer" (agent-1)');
    expect(pending[1]!.artifact?.path).toBe(join(rig.paths.tasksDir, "shell-1.output"));
    expect(store.getItem(T, LAUNCH_IDS.agent)).toMatchObject({ state: "terminal", terminal: { outcome: "completed" } });
    expect(store.getItem(T, LAUNCH_IDS.monitor)).toMatchObject({ state: "active" });

    // Zero activity outside the database.
    expect(sdkCalls()).toEqual(before.sdk);
    expect(rig.sdk.threadView.compact).toHaveBeenCalledOnce();
    expect(rig.spawned.map((p) => p.writes.length)).toEqual(before.ptyWrites);
    expect(readFileSync(rebuiltPath).equals(before.rollout)).toBe(true);
    expect(rig.terminalOutput().length).toBe(before.terminal);
    expect(rig.receipts).toHaveLength(before.receipts);

    // Opening the Control Panel shows the pending results; it delivers nothing.
    (rig.stdin as unknown as PassThrough).write(Buffer.from([0x1d]));
    await waitFor(() => rig.terminalOutput().includes("carried work finished"), "panel notice");
    // The 80x24 fake terminal wraps and clips the Home viewport; the first notice row is on screen.
    const panel = rig.terminalOutput();
    expect(panel).toContain('carried work finished: background agent "reviewer"');
    expect(panel).not.toContain("curl");
    expect(store.listPendingResults(T).map((r) => r.delivery)).toEqual(["pending", "pending"]);
    expect(rig.spawned.map((p) => p.writes.length)).toEqual(before.ptyWrites);
    expect(readFileSync(rebuiltPath).equals(before.rollout)).toBe(true);
    expect(sdkCalls()).toEqual(before.sdk);
    store.close();
    await rig.finish();
  }, 15_000);

  it("Monitor: relaunched exactly once under relaunchKey(launchId, generation), reported restarted, never repeated", async () => {
    const rig = await launch();
    rig.feed(fiveFamilyLaunch(rig.paths));
    await storeHas(rig.dbPath, ALL_IDS);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "handoff result");
    expect(rig.results[0]!.kind).toBe("success");

    // The exact command ran once, after the replacement was live, writing to the fence file.
    const outputPath = relaunchOutputPath(rig.monitorOutputDir, LAUNCH_IDS.monitor, 1);
    await waitFor(
      () => existsSync(outputPath) && readFileSync(outputPath, "utf8") === "relaunched-once-XyZ",
      "relaunch output",
    );
    const restarted = () =>
      wrapperLog(rig).match(/monitor monitor:[^\n]* restarted once \(generation 1, pid \d+\)/g) ?? [];
    await waitFor(() => restarted().length >= 1, "restart log");
    expect(restarted()).toHaveLength(1);

    // Invoking the same generation again starts nothing: the fence holds.
    withStore(rig.dbPath, (store) => {
      const again = invokeCarryover(
        store,
        snapshotOf(store, 1),
        { monitorOutputDir: rig.monitorOutputDir, cwd: rig.home, log: () => {} },
        Date.now(),
      );
      expect(again.results.find((r) => r.launchId === LAUNCH_IDS.monitor)).toEqual({
        launchId: LAUNCH_IDS.monitor,
        kind: "already_relaunched",
        outputPath,
      });
      expect(store.getItem(T, LAUNCH_IDS.monitor)).toMatchObject({ state: "active", carryMode: "reconstruct" });
      // LIM-146: the parent recorded its one relaunch — verified output identity and the exact
      // process identity — so the replacement can read and stop it through `cc-lhc tasks`.
      expect(store.getItem(T, LAUNCH_IDS.monitor)).toMatchObject({
        operations: ["status", "output", "stop"],
        relaunch: { outputPath, output: { path: outputPath }, process: { pid: expect.any(Number) } },
      });
    });
    expect(readFileSync(outputPath, "utf8")).toBe("relaunched-once-XyZ");
    // Same logical item, reported as a restart — never adopted or uninterrupted.
    expect(rig.receipts[0]).toMatch(/monitor "CI watch" \(mon-1\): restarted/);
    expect(rig.receipts[0]).not.toMatch(/monitor "CI watch" \(mon-1\): adopted/);
    await rig.finish();
  }, 15_000);

  it("TC-2.5d: a Monitor whose launch cannot be resolved is closed as failed and Compact proceeds without it", async () => {
    const rig = await launch({ monitorInRollout: false });
    rig.feed(fiveFamilyLaunch(rig.paths));
    await storeHas(rig.dbPath, ALL_IDS);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "handoff result");
    expect(rig.results[0]!.kind).toBe("success");
    expect(rig.sdk.threadView.compact).toHaveBeenCalledOnce();
    withStore(rig.dbPath, (store) => {
      expect(store.getItem(T, LAUNCH_IDS.monitor)).toMatchObject({
        state: "terminal",
        terminal: { outcome: "failed", evidence: "monitor relaunch unavailable: launch_not_found" },
      });
      expect(store.getGeneration(T, 1)).toMatchObject({ state: "closed" });
      expect(store.getGeneration(T, 1)?.launchIds).not.toContain(LAUNCH_IDS.monitor);
    });
    const note = rig.receipts[0]!;
    expect(note).not.toContain("monitor");
    expect(note).toContain("(generation 1)");
    expect(existsSync(relaunchOutputPath(rig.monitorOutputDir, LAUNCH_IDS.monitor, 1))).toBe(false);
    await waitFor(() => wrapperLog(rig).includes("generation 1 closed: 4 carried, 0 not carried"), "closure log");
    expect(wrapperLog(rig)).toMatch(
      /monitor monitor:[^\n]* cannot be carried \(launch_not_found\); recorded as failed/,
    );
    await rig.finish();
  }, 15_000);

  it("an invocation that fails after the swap records one truthful failed outcome; the generation still closes", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-continuity-invoke-"));
    homes.push(home);
    const { paths, rolloutPath } = hostLayout(home);
    const store = openContinuityStore(join(home, "cc-lhc.sqlite"));
    const observer = createContinuityObserver({ store, threadId: T });
    for (const line of fiveFamilyLaunch(paths)) observer.observeLine(line);
    const context = { platform: "linux" as const, sourceRolloutPath: rolloutPath, statPath: statPathReal };
    expect(qualifyActiveItems(store, T, context, 1_000).qualified).toHaveLength(5);
    const snapshot = snapshotContinuity(store, { threadId: T, oldSessionId: "old-session", nowMs: 2_000 });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    // Between the snapshot and the invocation the rollout became unreadable: no command is invented.
    const logs: string[] = [];
    const transfer = invokeCarryover(
      store,
      snapshot.snapshot,
      { monitorOutputDir: join(home, "continuity"), cwd: home, readRollout: () => null, log: (m) => logs.push(m) },
      3_000,
    );
    expect(transfer.results.find((r) => r.launchId === LAUNCH_IDS.monitor)).toEqual({
      launchId: LAUNCH_IDS.monitor,
      kind: "failed",
      reason: "monitor relaunch unavailable: rollout_unreadable",
    });
    expect(transfer.results.filter((r) => r.kind !== "failed")).toHaveLength(4);
    expect(store.getItem(T, LAUNCH_IDS.monitor)).toMatchObject({
      state: "terminal",
      terminal: {
        outcome: "failed",
        evidence: "monitor relaunch unavailable: rollout_unreadable",
        observedAtMs: 3_000,
      },
    });
    expect(transfer.closure).toMatchObject({ closed: true, refusal: null });
    expect(transfer.closure.terminalSinceSnapshot.map((t) => t.launchId)).toEqual([LAUNCH_IDS.monitor]);
    expect(store.getGeneration(T, 1)?.state).toBe("closed");
    expect(existsSync(relaunchOutputPath(join(home, "continuity"), LAUNCH_IDS.monitor, 1))).toBe(false);
    // No retry: a second invocation of the closed generation repeats nothing and reopens nothing.
    const again = invokeCarryover(
      store,
      snapshot.snapshot,
      { monitorOutputDir: join(home, "continuity"), cwd: home, log: () => {} },
      4_000,
    );
    expect(store.getItem(T, LAUNCH_IDS.monitor)?.terminal?.observedAtMs).toBe(3_000);
    expect(again.closure.closed).toBe(true);
    expect(logs.some((m) => m.includes(MONITOR_COMMAND))).toBe(false);
    store.close();
  });

  it("TC-2.5d: an item no adapter can carry refuses the seam before any mutation; the old session stays", async () => {
    const rig = await launch({ agentTranscript: false });
    rig.feed(fiveFamilyLaunch(rig.paths));
    await storeHas(rig.dbPath, ALL_IDS);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => {
      const receipts = openGovernorReceiptStore(rig.dbPath);
      try {
        return receipts.listAll().some((r) => r.handoffOutcome?.kind === "mutation_refused");
      } finally {
        receipts.close();
      }
    }, "refused receipt");
    const outcome = withStore(rig.dbPath, () => {
      const receipts = openGovernorReceiptStore(rig.dbPath);
      try {
        return receipts.listAll().find((r) => r.handoffOutcome?.kind === "mutation_refused")?.handoffOutcome;
      } finally {
        receipts.close();
      }
    });
    expect(outcome).toMatchObject({
      kind: "mutation_refused",
      detail: expect.stringContaining("unqualified items cannot be carried"),
    });
    expect((outcome as { detail: string }).detail).toContain(LAUNCH_IDS.agent);
    expect(rig.sdk.threadView.previewCompact).not.toHaveBeenCalled();
    expect(rig.sdk.threadView.compact).not.toHaveBeenCalled();
    expect(rig.spawned).toHaveLength(1);
    expect(rig.results).toHaveLength(0);
    withStore(rig.dbPath, (store) => {
      expect(store.latestGeneration(T)).toBeNull();
      expect(store.getItem(T, LAUNCH_IDS.agent)).toMatchObject({ carryMode: "unqualified", generation: 0 });
    });
    await rig.finish();
  }, 15_000);

  it("manual /smart-compact runs the same observe/qualify/snapshot/note/invoke/close flow as automatic", async () => {
    const rig = await launch();
    rig.feed(fiveFamilyLaunch(rig.paths));
    await storeHas(rig.dbPath, ALL_IDS);
    // Below the trigger: nothing automatic runs. The operator asks for it.
    rig.lifecycle([
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "req:r0",
        providerUsage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 10 },
      },
      { kind: "turn_settled", reason: "end_turn" },
    ]);
    await new Promise((r) => setTimeout(r, 150));
    expect(rig.results).toHaveLength(0);
    (rig.stdin as unknown as PassThrough).write(Buffer.from([0x1d]));
    await waitFor(() => rig.terminalOutput().includes("/smart-compact"), "panel");
    (rig.stdin as unknown as PassThrough).write(Buffer.from("/smart-compact\r"));
    await waitFor(() => rig.results.length === 1, "manual handoff result");
    expect(rig.results[0]!.kind).toBe("success");
    expect(rig.sdk.threadView.compact).toHaveBeenCalledOnce();

    // Same manifest, same generation, same invocation, same closure as the automatic seam.
    expect(rig.receipts).toHaveLength(1);
    const note = rig.receipts[0]!;
    expect(note).toContain("[lhc compact:manual]");
    expect(note).toContain("Tracked background work carried into this session (generation 1)");
    for (const fragment of [
      "resumed: continue it with SendMessage to agent-1",
      "resumed: continue it with Workflow resumeFromRunId wf_run-1",
      "adopted: still running",
      "restarted:",
      "re-armed",
    ]) {
      expect(note).toContain(fragment);
    }
    expect(note).not.toContain("cannot return output");
    expect(note).not.toContain("continuity lost");
    const outputPath = relaunchOutputPath(rig.monitorOutputDir, LAUNCH_IDS.monitor, 1);
    await waitFor(
      () => existsSync(outputPath) && readFileSync(outputPath, "utf8") === "relaunched-once-XyZ",
      "relaunch output",
    );
    await waitFor(() => wrapperLog(rig).includes("generation 1 closed: 5 carried, 0 not carried"), "closure log");
    withStore(rig.dbPath, (store) => {
      expect(store.getGeneration(T, 1)).toMatchObject({ state: "closed", oldSessionId: "old-session" });
      for (const id of ALL_IDS) expect(store.getItem(T, id), id).toMatchObject({ generation: 1, state: "active" });
    });
    await rig.finish();
  }, 15_000);

  it("no raw Monitor command is retained: not in SQLite, the manifest, the wrapper log, or the terminal", async () => {
    const rig = await launch();
    rig.feed(fiveFamilyLaunch(rig.paths));
    await storeHas(rig.dbPath, ALL_IDS);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "handoff result");
    const outputPath = relaunchOutputPath(rig.monitorOutputDir, LAUNCH_IDS.monitor, 1);
    await waitFor(() => existsSync(outputPath) && readFileSync(outputPath, "utf8").length > 0, "relaunch output");
    await rig.finish();
    await waitFor(() => wrapperLog(rig).includes("generation 1 closed"), "closure log");
    for (const [surface, text] of [
      ["sqlite", readFileSync(rig.dbPath, "latin1")],
      ["sqlite-wal", existsSync(`${rig.dbPath}-wal`) ? readFileSync(`${rig.dbPath}-wal`, "latin1") : ""],
      ["manifest", rig.receipts.join("\n")],
      ["wrapper log", wrapperLog(rig)],
      ["terminal", rig.terminalOutput()],
    ] as const) {
      expect(text, surface).not.toContain(MONITOR_COMMAND);
      expect(text, surface).not.toContain("printf");
    }
    // The command lives only where it always did: the old session's rollout.
    expect(readFileSync(rig.rolloutPath, "utf8")).toContain(MONITOR_COMMAND);
  }, 15_000);
});
