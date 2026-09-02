/**
 * LIM-145 production handoff: real rollout records feed the parent-owned
 * continuity record, the settled Smart Compact seam accepts one carryover
 * generation without waiting or asking, the rebuilt session receives the
 * manifest, each mechanism is invoked once after the replacement is live, and
 * the generation closes. Covers TC-2.3a/b, TC-2.5a-d, TC-2.6a, TC-2.8a-c and
 * the Monitor relaunch fence.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Writable } from "node:stream";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { qualifyActiveItems, statPathReal } from "../../src/continuity/adapters.js";
import { deliveredResultKeys, RESULT_HOOK_TIMEOUT_SECONDS } from "../../src/continuity/delivery.js";
import { invokeCarryover, relaunchOutputPath } from "../../src/continuity/handoff.js";
import { itemStatus, readItemOutput } from "../../src/continuity/manage.js";
import { createContinuityObserver } from "../../src/continuity/observe.js";
import { type ContinuitySnapshot, closeContinuitySnapshot, snapshotContinuity } from "../../src/continuity/snapshot.js";
import { type ContinuityStore, openContinuityStore } from "../../src/continuity/store.js";
import type { discoverAdoptedTaskProcess } from "../../src/continuity/task-process.js";
import { runTasksCli } from "../../src/continuity/tasks-cli.js";
import { CONTEXT_WINDOW_NOT_YET_OBSERVED } from "../../src/governor/config.js";
import { openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import {
  createAsyncWorkFold,
  type OpenAsyncWork,
  observeAsyncWorkLine,
  openAsyncWork,
} from "../../src/observation/async-work.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import type { ProcessLivenessResult } from "../../src/runtime/process-identity.js";
import { emptyCaptureStats } from "../../src/stats.js";
import type { HandoffResult } from "../../src/wrapper/handoff.js";
import { run } from "../../src/wrapper/run.js";
import {
  LAUNCH_IDS,
  LAUNCHES,
  type LaunchPaths,
  notification,
  qualifyAll,
  toolResult,
  toolUse,
} from "../continuity/helpers.js";

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
/** The hook command the wrapper registers; the test runs the same op in-process. */
const HOOK_COMMAND = "'/usr/bin/node' '/opt/cc-lhc/dist/bin.js' tasks hook";
const OUR_HOOK_ENTRY = { hooks: [{ type: "command", command: HOOK_COMMAND, timeout: RESULT_HOOK_TIMEOUT_SECONDS }] };

function settingsArg(args: readonly string[]): Record<string, unknown> {
  const hits = args.map((a, i) => (a === "--settings" ? i : -1)).filter((i) => i >= 0);
  expect(hits).toHaveLength(1);
  return JSON.parse(args[hits[0]! + 1]!) as Record<string, unknown>;
}

/** Claude Code 2.1.252's rollout record for a UserPromptSubmit hook's accepted context. */
function hookContextRecord(context: string): RolloutLineItem {
  return {
    type: "attachment",
    isSidechain: false,
    userType: "external",
    attachment: {
      type: "hook_additional_context",
      content: [context],
      hookName: "UserPromptSubmit",
      toolUseID: "hook-7ce74903-1313-4672-b351-59461a06e9b3",
      hookEvent: "UserPromptSubmit",
    },
  } as unknown as RolloutLineItem;
}

/** Run the registered hook op the way Claude does: payload on stdin, in the child's environment. */
async function runHook(
  env: Record<string, string>,
  sessionId: string,
  transcriptPath: string,
  reconcile?: import("../../src/continuity/task-process.js").ReconcileDeps,
) {
  let out = "";
  let err = "";
  const stdin = new PassThrough();
  stdin.end(
    JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: process.cwd(),
      prompt_id: "p-1",
      permission_mode: "default",
      hook_event_name: "UserPromptSubmit",
      prompt: "what happened to the reviewer?",
    }),
  );
  const code = await runTasksCli(
    ["tasks", "hook"],
    {
      stdin,
      stdout: new Writable({
        write: (c, _e, cb) => {
          out += c.toString();
          cb();
        },
      }),
      stderr: new Writable({
        write: (c, _e, cb) => {
          err += c.toString();
          cb();
        },
      }),
    },
    { env: { ...env, CLAUDE_CODE_SESSION_ID: sessionId }, ...(reconcile === undefined ? {} : { reconcile }) },
  );
  return { code, out, err };
}
/** Run a `cc-lhc tasks` management op the way the replacement's Bash would: bound by the child's environment. */
async function runTasks(env: Record<string, string>, sessionId: string, argv: string[]) {
  let out = "";
  let err = "";
  const code = await runTasksCli(
    ["tasks", ...argv],
    {
      stdout: new Writable({
        write: (c, _e, cb) => {
          out += c.toString();
          cb();
        },
      }),
      stderr: new Writable({
        write: (c, _e, cb) => {
          err += c.toString();
          cb();
        },
      }),
    },
    { env: { ...env, CLAUDE_CODE_SESSION_ID: sessionId } },
  );
  return { code, out, err };
}
const T = "th_auto";
/** A real, harmless Monitor command: the relaunch proves itself by what it writes. */
const MONITOR_COMMAND = "printf relaunched-once-XyZ";
function monitorLines(command: string): RolloutLineItem[] {
  return [
    toolUse("toolu_mon", "Monitor", { command, description: "CI watch" }),
    toolResult("toolu_mon", { taskId: "mon-1", timeoutMs: 60_000, persistent: false }),
  ];
}
/** A Monitor that stays alive after proving itself, so a restarted wrapper meets a live relaunched process. */
const LONG_MONITOR_COMMAND = "printf relaunched-once-XyZ; sleep 30";

interface FakePty {
  /** The environment the wrapper spawned this child with. */
  env: Record<string, string>;
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

function makeFakePty(pid: number, args: string[], env: Record<string, string> = {}, emitsOutput = true): FakePty {
  const exitCbs: Array<(arg: { exitCode: number; signal?: number }) => void> = [];
  const dataCbs: Array<(data: string) => void> = [];
  const fake: FakePty = {
    pid,
    args,
    env,
    killed: [],
    writes: [],
    fireExit(code, signal) {
      for (const cb of exitCbs) cb({ exitCode: code, ...(signal === undefined ? {} : { signal }) });
    },
    onData: (cb) => {
      dataCbs.push(cb);
      if (emitsOutput) {
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
  // Tall enough that Home's notice rows stay on screen beneath the wrapped status rows.
  Object.defineProperty(stream, "rows", { value: 40, configurable: true });
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

/** A later settled seam over the trigger: a distinct sampling so dedupe cannot swallow it. */
function laterSeam(id: string): LifecycleSignal[] {
  return [
    { kind: "turn_opened", reason: "user_prompt" },
    {
      kind: "sampling_observed",
      samplingId: `req:${id}`,
      providerUsage: { input_tokens: 2, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 3_000 },
    },
    { kind: "turn_settled", reason: "end_turn" },
  ];
}
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
function hostLayout(
  home: string,
  opts: { monitorInRollout?: boolean; agentTranscript?: boolean; monitorCommand?: string } = {},
) {
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
  const rolloutLines = opts.monitorInRollout === false ? [] : monitorLines(opts.monitorCommand ?? MONITOR_COMMAND);
  writeFileSync(rolloutPath, `${rolloutLines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return { paths, rolloutPath };
}

/** Every family launched, as the old child's rollout reports it. */
function fiveFamilyLaunch(paths: LaunchPaths, monitorCommand = MONITOR_COMMAND): RolloutLineItem[] {
  return [
    ...LAUNCHES.agent.lines(paths),
    ...LAUNCHES.workflow.lines(paths),
    ...LAUNCHES.background_shell.lines(paths),
    ...monitorLines(monitorCommand),
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
  /** Per capture session, in start order: the carried work seeded into its fold. */
  seeds: Array<readonly OpenAsyncWork[]>;
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
interface LaunchOptions {
  /** Adopted-task discovery seam handed to run() (LIM-149). */
  discoverTaskProcess?: typeof discoverAdoptedTaskProcess;
  /** Identity probe seam handed to run() — retention requires an exact old-child identity. */
  probeProcessIdentity?: (pid: number) => ProcessLivenessResult;
  /** Raw freeze/kill signal seam handed to run() — mixed carryover freezes the fake old child through this, never a real pid (LIM-149). */
  hostSignal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Paused-host exit-record reader handed to run() (LIM-149). */
  readTaskExit?: (proc: {
    pid: number;
    starttime: string;
  }) => import("../../src/continuity/task-process.js").TaskExitOutcome | null;
  /** The first N replacement candidates never produce output, so they fail viability before the switch. */
  muteCandidates?: number;
  /** A second wrapper process over the same durable authority: reuse this home instead of a fresh one. */
  reuseHome?: string;
  /** The managed session this wrapper's main capture binds (default: the old session). */
  boundSession?: { sessionId: string; rolloutPath: string };
}

async function launch(
  layout: Parameters<typeof hostLayout>[1] = {},
  claudeArgv: string[] = [],
  options: LaunchOptions = {},
): Promise<Rig> {
  const muteCandidates = options.muteCandidates ?? 0;
  let candidates = 0;
  const home = options.reuseHome ?? mkdtempSync(join(tmpdir(), "cc-lhc-continuity-prod-"));
  if (options.reuseHome === undefined) homes.push(home);
  process.env.CC_LHC_HOME = home;
  const { paths, rolloutPath } = hostLayout(home, layout);
  const dbPath = join(home, "cc-lhc.sqlite");
  const sdk = sdkForCapture();
  const spawned: FakePty[] = [];
  const seeds: Array<readonly OpenAsyncWork[]> = [];
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
    const bound = options.boundSession ?? { sessionId: "old-session", rolloutPath };
    const sessionId = isRebuilt ? REBUILT_ID : bound.sessionId;
    const path = isRebuilt ? opts.knownRolloutPath! : bound.rolloutPath;
    // The real fold, wired to the parent exactly as production wires it — including the carried seed.
    // What the wrapper hands each capture as already-open work (the record's carried items for the bound thread).
    const seed = opts.seedAsyncWork?.(T) ?? [];
    seeds.push(seed);
    const fold = createAsyncWorkFold((event) => opts.onAsyncWorkEvent?.(event, T), seed);
    const feed = (lines: RolloutLineItem[]) => {
      for (const line of lines) {
        observeAsyncWorkLine(line, fold);
        const delivered = deliveredResultKeys(line);
        if (delivered.length > 0) opts.onResultDelivery?.(delivered, T);
      }
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
  const runPromise = run(claudeArgv, {
    claudeBin: "fake-claude",
    resultHookCommand: HOOK_COMMAND,
    spawnPty: ((_file: string, args: string[], opts: { env?: Record<string, string> }) => {
      const isCandidate = args.includes(REBUILT_ID);
      if (isCandidate) candidates += 1;
      const mute = isCandidate && candidates <= muteCandidates;
      const fake = makeFakePty(1000 + spawned.length, args, opts.env ?? {}, !mute);
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
    ...(muteCandidates > 0 ? { replacementAttempts: 1 } : {}),
    ...(options.discoverTaskProcess === undefined ? {} : { discoverTaskProcess: options.discoverTaskProcess }),
    ...(options.probeProcessIdentity === undefined ? {} : { probeProcessIdentity: options.probeProcessIdentity }),
    ...(options.hostSignal === undefined ? {} : { hostSignal: options.hostSignal }),
    ...(options.readTaskExit === undefined ? {} : { readTaskExit: options.readTaskExit }),
    handoffTimeouts: {
      sigtermGraceMs: 500,
      sigkillWaitMs: 300,
      captureReadyTimeoutMs: 2_000,
      childLivenessTimeoutMs: muteCandidates > 0 ? 400 : 3_000,
      childStableWindowMs: 100,
    },
  });
  await waitFor(() => lifecycleSink !== undefined && feedOld !== undefined, "old capture");
  await waitFor(() => spawned.length === 1, "first child");
  lifecycleSink!([
    { kind: "session_bound", sessionId: (options.boundSession ?? { sessionId: "old-session" }).sessionId },
  ]);
  return {
    home,
    dbPath,
    monitorOutputDir: join(home, "continuity"),
    rolloutPath,
    paths,
    sdk,
    spawned,
    seeds,
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

/** Close on test end even when an assertion threw first (Windows pins open files). */
function closeQuietly(store: ContinuityStore): void {
  try {
    store.close();
  } catch {
    // already closed by the test body
  }
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

    // The replacement receives one manifest naming every item once with its
    // launch id and the tasks guidance. Whether it is the detailed or the
    // bounded form depends only on path length (both are proven exactly in
    // continuity-note.test.ts); the per-item wording is not owed here.
    expect(rig.receipts).toHaveLength(1);
    const note = rig.receipts[0]!;
    expect(note).toContain("Tracked background work carried into this session (generation 1)");
    for (const id of ALL_IDS) expect(note, id).toContain(`[${id}]`);
    expect(note).toContain("cc-lhc tasks status|output|stop");
    expect(note).not.toContain("cannot return output");
    expect(note).not.toContain("continuity lost");

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
      // The truthful transition and mechanism live durably in the manifest data.
      const carried = snapshotOf(store, 1).items;
      expect(new Map(carried.map((i) => [i.launchId, `${i.transition}/${i.continuation.kind}`]))).toEqual(
        new Map([
          [LAUNCH_IDS.agent, "resumed/send_message"],
          [LAUNCH_IDS.workflow, "resumed/workflow_resume"],
          [LAUNCH_IDS.background_shell, "adopted/parent_output_read"],
          [LAUNCH_IDS.monitor, "restarted/monitor_relaunch"],
          [LAUNCH_IDS.scheduled_wakeup, "rearmed/rearm_at"],
        ]),
      );
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
    onTestFinished(() => closeQuietly(store));
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

  it("TC-2.7c/d/e: the hook is registered beside the user's own hooks; the real hook answers the real payload; only the rollout's record of that context marks exact keys delivered", async () => {
    const userHooks = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/home/u/audit.sh --strict" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "/home/u/prompt-guard.sh", timeout: 3 }] }],
    };
    const userSettingsPath = join(mkdtempSync(join(tmpdir(), "cc-lhc-user-settings-")), "settings.json");
    writeFileSync(userSettingsPath, JSON.stringify({ hooks: userHooks, theme: "dark" }));
    const rig = await launch({}, ["--settings", userSettingsPath]);
    rig.feed(fiveFamilyLaunch(rig.paths));
    await storeHas(rig.dbPath, ALL_IDS);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "handoff result");
    expect(rig.results[0]!.kind).toBe("success");
    await waitFor(() => rig.spawned.length === 2, "replacement child");

    // Every managed child carries one settings payload: the user's hooks exactly, ours appended, the status line merged.
    for (const child of rig.spawned) {
      const settings = settingsArg(child.args);
      expect(settings.theme).toBe("dark");
      expect(settings.hooks).toEqual({
        ...userHooks,
        UserPromptSubmit: [...userHooks.UserPromptSubmit, OUR_HOOK_ENTRY],
      });
      expect(settings.statusLine).toMatchObject({ type: "command" });
      expect(child.env.CC_LHC_RUNTIME_DESCRIPTOR).toBeTruthy();
    }

    // Carried work finishes while idle → pending results (Pass B).
    const store = openContinuityStore(rig.dbPath);
    rig.feedCurrent([notification({ taskIds: ["agent-1"], status: "completed" })]);
    rig.feedCurrent([notification({ taskIds: ["shell-1"], status: "failed" })]);
    await waitFor(() => store.listPendingResults(T).length === 2, "durable results");
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
    };

    // The user submits a real prompt: Claude runs the registered hook in the replacement's environment.
    const replacement = rig.spawned[1]!;
    const hook = await runHook(replacement.env, REBUILT_ID, rebuiltPath);
    expect(hook.code).toBe(0);
    expect(hook.err).toBe("");
    const context = (JSON.parse(hook.out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext;
    expect(context).toContain(`result ${LAUNCH_IDS.agent} · agent · background agent "reviewer" (agent-1) · completed`);
    expect(context).toContain(
      `result ${LAUNCH_IDS.background_shell} · background_shell · background command (shell-1) · failed`,
    );
    expect(context).not.toContain("curl");
    expect(context).not.toContain(rig.paths.tasksDir);
    // Hook invocation alone acknowledges nothing.
    expect(store.listPendingResults(T).map((r) => r.delivery)).toEqual(["pending", "pending"]);
    // A hook run for a foreign session gets nothing.
    expect((await runHook(replacement.env, "ffffffff-0000-0000-0000-000000000000", rebuiltPath)).out).toBe("");

    // Partial/foreign evidence first: a record naming a foreign key and one real key delivers exactly that key.
    const header = context.split("\n")[0]!;
    rig.feedCurrent([
      hookContextRecord(
        `${header}\nresult agent:nobody:toolu_x · agent · ghost · completed\nresult ${LAUNCH_IDS.agent} · agent · x · completed`,
      ),
    ]);
    await waitFor(() => store.getResult(T, LAUNCH_IDS.agent)?.delivery === "delivered", "partial delivery");
    expect(store.getResult(T, LAUNCH_IDS.background_shell)).toMatchObject({ delivery: "pending" });
    // User text quoting a key is not delivery.
    rig.feedCurrent([{ type: "user", message: { role: "user", content: context } } as unknown as RolloutLineItem]);
    expect(store.getResult(T, LAUNCH_IDS.background_shell)).toMatchObject({ delivery: "pending" });

    // Claude's record of the hook's accepted context, in the normal capture path, delivers the rest — once.
    rig.feedCurrent([hookContextRecord(context)]);
    await waitFor(() => store.listPendingResults(T).length === 0, "delivered");
    const delivered = [LAUNCH_IDS.agent, LAUNCH_IDS.background_shell].map((id) => store.getResult(T, id)!);
    expect(delivered.map((r) => r.delivery)).toEqual(["delivered", "delivered"]);
    rig.feedCurrent([hookContextRecord(context)]);
    expect([LAUNCH_IDS.agent, LAUNCH_IDS.background_shell].map((id) => store.getResult(T, id))).toEqual(delivered);
    await waitFor(() => wrapperLog(rig).includes("carried result(s) delivered on a real prompt"), "delivery log");
    expect(wrapperLog(rig).match(/carried result\(s\) delivered on a real prompt/g)).toHaveLength(2);

    // Throughout: no provider call, no PTY write, no rollout mutation, no synthetic turn.
    expect(sdkCalls()).toEqual(before.sdk);
    expect(rig.spawned.map((p) => p.writes.length)).toEqual(before.ptyWrites);
    expect(readFileSync(rebuiltPath).equals(before.rollout)).toBe(true);
    // The next hook run has nothing to add; the panel no longer lists them.
    expect((await runHook(replacement.env, REBUILT_ID, rebuiltPath)).out).toBe("");
    (rig.stdin as unknown as PassThrough).write(Buffer.from([0x1d]));
    await waitFor(() => rig.terminalOutput().includes("type /help for commands"), "panel");
    expect(rig.terminalOutput()).not.toContain("carried work finished");
    store.close();
    await rig.finish();
  }, 15_000);

  it("TC-2.7 fallback: when the user's settings cannot take the hook, the status line still merges, nothing blocks, and results stay pending in the panel", async () => {
    const userSettingsPath = join(mkdtempSync(join(tmpdir(), "cc-lhc-user-settings-")), "settings.json");
    writeFileSync(userSettingsPath, JSON.stringify({ hooks: "nope" }));
    const rig = await launch({}, ["--settings", userSettingsPath]);
    rig.feed(fiveFamilyLaunch(rig.paths));
    await storeHas(rig.dbPath, ALL_IDS);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "handoff result");
    expect(rig.results[0]!.kind).toBe("success");
    await waitFor(() => rig.spawned.length === 2, "replacement child");
    for (const child of rig.spawned) {
      const settings = settingsArg(child.args);
      expect(settings.hooks).toBe("nope");
      expect(settings.statusLine).toMatchObject({ type: "command" });
    }
    await waitFor(
      () => wrapperLog(rig).includes("result delivery hook not installed (hooks is not an object)"),
      "fallback log",
    );
    const store = openContinuityStore(rig.dbPath);
    rig.feedCurrent([notification({ taskIds: ["agent-1"], status: "completed" })]);
    await waitFor(() => store.listPendingResults(T).length === 1, "durable result");
    (rig.stdin as unknown as PassThrough).write(Buffer.from([0x1d]));
    await waitFor(() => rig.terminalOutput().includes("carried work finished"), "panel notice");
    expect(store.listPendingResults(T).map((r) => r.delivery)).toEqual(["pending"]);
    store.close();
    await rig.finish();
  }, 15_000);

  it("TC-2.9a/2.12a-b: a replacement that fails before the switch leaves the old child authoritative and nothing carried; old-session evidence yields one result; the next seam transfers the remainder once under the next generation", async () => {
    const rig = await launch({}, [], { muteCandidates: 1 });
    rig.feed(fiveFamilyLaunch(rig.paths));
    await storeHas(rig.dbPath, ALL_IDS);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "first handoff result");
    expect(rig.results[0]!.kind).toBe("replacement_nonviable");
    expect(rig.sdk.threadView.compact).toHaveBeenCalledOnce();
    expect(rig.spawned).toHaveLength(2);
    // Old routing/authority: the old child was never signalled and still receives input.
    expect(rig.spawned[0]!.killed).toHaveLength(0);
    (rig.stdin as unknown as PassThrough).write(Buffer.from("k"));
    await waitFor(() => rig.spawned[0]!.writes.some((w) => String(w) === "k"), "input routed to the old child");
    expect(wrapperLog(rig)).not.toContain("typed-ahead");
    expect(rig.spawned[1]!.writes).toEqual([]);
    // Zero carry invocation: no relaunch, no closure, no transition claimed.
    expect(existsSync(relaunchOutputPath(rig.monitorOutputDir, LAUNCH_IDS.monitor, 1))).toBe(false);
    expect(wrapperLog(rig)).not.toMatch(/restarted once|adopted|re-armed|generation 1 closed/);
    // One truthful representation: generation 1 prepared and open, every item stamped once, no results.
    withStore(rig.dbPath, (store) => {
      expect(store.getGeneration(T, 1)).toMatchObject({ state: "open", launchIds: expect.arrayContaining(ALL_IDS) });
      expect(store.listItems(T)).toHaveLength(5);
      for (const id of ALL_IDS) expect(store.getItem(T, id)).toMatchObject({ state: "active", generation: 1 });
      expect(store.listPendingResults(T)).toEqual([]);
    });

    // Old-session terminal evidence, plus a duplicate: one item closes, one pending result, no second row.
    rig.feed([notification({ taskIds: ["agent-1"], status: "completed" })]);
    rig.feed([notification({ taskIds: ["agent-1"], status: "completed" })]);
    await waitFor(() => withStore(rig.dbPath, (store) => store.listPendingResults(T).length === 1), "one result");
    withStore(rig.dbPath, (store) => {
      expect(store.getItem(T, LAUNCH_IDS.agent)).toMatchObject({ state: "terminal", generation: 1 });
      expect(store.listItems(T)).toHaveLength(5);
      expect(store.listPendingResults(T).map((r) => [r.launchId, r.generation, r.outcome])).toEqual([
        [LAUNCH_IDS.agent, 1, "completed"],
      ]);
    });

    // A later normal seam: requalify what is still active, allocate generation 2 (1 superseded), transfer once.
    rig.lifecycle(laterSeam("retry"));
    await waitFor(() => rig.results.length === 2, "second handoff result");
    expect(rig.results[1]!.kind).toBe("success");
    expect(rig.sdk.threadView.compact).toHaveBeenCalledTimes(2);
    expect(rig.spawned).toHaveLength(3);
    const remaining = ALL_IDS.filter((id) => id !== LAUNCH_IDS.agent);
    await waitFor(
      () => wrapperLog(rig).includes("generation 2 closed: 4 carried, 0 not carried"),
      "generation 2 closed",
    );
    const relaunched = relaunchOutputPath(rig.monitorOutputDir, LAUNCH_IDS.monitor, 2);
    await waitFor(
      () => existsSync(relaunched) && readFileSync(relaunched, "utf8") === "relaunched-once-XyZ",
      "relaunch output",
    );
    expect(existsSync(relaunchOutputPath(rig.monitorOutputDir, LAUNCH_IDS.monitor, 1))).toBe(false);
    expect(wrapperLog(rig).match(/restarted once/g)).toHaveLength(1);
    // The rebuilt session's manifest names the four remaining items once and not the finished agent.
    const note = rig.receipts[1]!;
    expect(note).toContain("generation 2");
    expect(note).not.toContain("agent-1");
    for (const id of remaining) expect(note.split(`[${id}]`)).toHaveLength(2);
    withStore(rig.dbPath, (store) => {
      expect(store.getGeneration(T, 1)).toMatchObject({ state: "superseded" });
      expect(store.getGeneration(T, 2)).toMatchObject({
        state: "closed",
        launchIds: expect.arrayContaining(remaining),
      });
      expect(store.getGeneration(T, 2)!.launchIds).toHaveLength(4);
      for (const id of remaining) expect(store.getItem(T, id)).toMatchObject({ state: "active", generation: 2 });
      expect(store.getItem(T, LAUNCH_IDS.agent)).toMatchObject({ state: "terminal", generation: 1 });
      expect(store.listItems(T)).toHaveLength(5);
      // Still exactly one result: the failed attempt duplicated nothing.
      expect(store.listPendingResults(T).map((r) => r.launchId)).toEqual([LAUNCH_IDS.agent]);
    });
    await rig.finish();
  }, 20_000);

  it("TC-2.12c: after a failed activation, a shell whose output identity changed is refused by the adapter at the next seam — never adopted — and once it has finished the remainder transfers once", async () => {
    const rig = await launch({}, [], { muteCandidates: 1 });
    rig.feed(fiveFamilyLaunch(rig.paths));
    await storeHas(rig.dbPath, ALL_IDS);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "first handoff result");
    expect(rig.results[0]!.kind).toBe("replacement_nonviable");

    // The recorded output file is replaced by another object at the same path (stale/foreign identity).
    const outputPath = join(rig.paths.tasksDir, "shell-1.output");
    const replacement = `${outputPath}.new`;
    writeFileSync(replacement, "someone else's output\n");
    renameSync(replacement, outputPath);

    rig.lifecycle(laterSeam("stale"));
    await waitFor(
      () => withStore(rig.dbPath, (store) => store.getItem(T, LAUNCH_IDS.background_shell)?.state === "unknown"),
      "adapter refusal recorded",
    );
    await waitFor(
      () => wrapperLog(rig).includes(LAUNCH_IDS.background_shell) && /unverified/.test(wrapperLog(rig)),
      "refusal logged",
    );
    // Refused before any mutation: no second compact, no candidate, old child still routed and untouched.
    expect(rig.sdk.threadView.compact).toHaveBeenCalledOnce();
    expect(rig.results).toHaveLength(1);
    expect(rig.spawned).toHaveLength(2);
    expect(rig.spawned[0]!.killed).toHaveLength(0);
    withStore(rig.dbPath, (store) => {
      expect(store.latestGeneration(T)).toMatchObject({ generation: 1 });
      expect(store.getItem(T, LAUNCH_IDS.background_shell)).toMatchObject({ state: "unknown", generation: 1 });
      expect(store.listPendingResults(T)).toEqual([]);
    });

    // The stale shell finishes (old-session evidence): one result, and the remaining work can move.
    rig.feed([notification({ taskIds: ["shell-1"], status: "stopped" })]);
    await waitFor(() => withStore(rig.dbPath, (store) => store.listPendingResults(T).length === 1), "shell result");
    rig.lifecycle(laterSeam("after-stale"));
    await waitFor(() => rig.results.length === 2, "second handoff result");
    expect(rig.results[1]!.kind).toBe("success");
    expect(rig.sdk.threadView.compact).toHaveBeenCalledTimes(2);
    await waitFor(
      () => wrapperLog(rig).includes("generation 2 closed: 4 carried, 0 not carried"),
      "generation 2 closed",
    );
    const remaining = ALL_IDS.filter((id) => id !== LAUNCH_IDS.background_shell);
    withStore(rig.dbPath, (store) => {
      expect(store.getGeneration(T, 1)).toMatchObject({ state: "superseded" });
      expect([...store.getGeneration(T, 2)!.launchIds].sort()).toEqual([...remaining].sort());
      expect(store.getItem(T, LAUNCH_IDS.background_shell)).toMatchObject({ state: "terminal", generation: 1 });
      for (const id of remaining) expect(store.getItem(T, id)).toMatchObject({ state: "active", generation: 2 });
      expect(store.listPendingResults(T).map((r) => [r.launchId, r.outcome])).toEqual([
        [LAUNCH_IDS.background_shell, "stopped"],
      ]);
    });
    expect(rig.receipts[1]).not.toContain("shell-1");
    expect(wrapperLog(rig).match(/restarted once/g)).toHaveLength(1);
    await rig.finish();
  }, 20_000);

  it("TC-2.9b/2.7c restart: a fresh wrapper bound to the same session reopens the record, seeds carried work, keeps the live relaunched Monitor, and delivers pending results once", async () => {
    // ---- wrapper 1: carry five families, relaunch a long-lived Monitor, one result while idle ----
    const first = await launch({ monitorCommand: LONG_MONITOR_COMMAND });
    first.feed(fiveFamilyLaunch(first.paths, LONG_MONITOR_COMMAND));
    await storeHas(first.dbPath, ALL_IDS);
    first.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => first.results.length === 1, "handoff result");
    expect(first.results[0]!.kind).toBe("success");
    await waitFor(() => first.spawned.length === 2, "replacement child");
    const fence = relaunchOutputPath(first.monitorOutputDir, LAUNCH_IDS.monitor, 1);
    await waitFor(() => existsSync(fence) && readFileSync(fence, "utf8") === "relaunched-once-XyZ", "relaunch output");
    const relaunch = withStore(first.dbPath, (store) => store.getItem(T, LAUNCH_IDS.monitor)!.relaunch!);
    expect(relaunch.process).not.toBeNull();
    first.feedCurrent([notification({ taskIds: ["agent-1"], status: "completed" })]);
    await waitFor(() => withStore(first.dbPath, (store) => store.listPendingResults(T).length === 1), "one result");
    const before = withStore(first.dbPath, (store) => ({
      items: store.listItems(T),
      generation: store.getGeneration(T, 1),
      results: store.listPendingResults(T),
    }));
    expect(before.generation).toMatchObject({ state: "closed" });
    // Another thread's carried item lives in the same database; it is not this session's.
    withStore(first.dbPath, (store) => {
      const other = createContinuityObserver({ store, threadId: "th_other", nowFn: () => 1 });
      for (const line of [
        toolUse("toolu_agent9", "Agent", { description: "other", subagent_type: "general-purpose" }),
        toolResult("toolu_agent9", { status: "async_launched", agentId: "agent-9", description: "agent-9" }),
      ])
        other.observeLine(line);
      qualifyAll(store, "th_other", 2);
      store.allocateGeneration({
        threadId: "th_other",
        oldSessionId: "x",
        launchIds: ["agent:agent-9:toolu_agent9"],
        nowMs: 3,
      });
    });
    // End wrapper 1 cleanly: the replacement child exits; the database, the fence file, and the relaunched process stay.
    expect(await first.finish()).toBeTypeOf("number");
    expect(existsSync(first.dbPath)).toBe(true);
    expect(() => process.kill(relaunch.process!.pid, 0)).not.toThrow();
    const rebuiltPath = join(first.home, `${REBUILT_ID}.jsonl`);
    // The wrapper log appends asynchronously: let wrapper 1's own lines land before slicing.
    await waitFor(
      () => /restarted once/.test(wrapperLog(first)) && /generation 1 closed/.test(wrapperLog(first)),
      "wrapper 1 log",
    );
    await new Promise((r) => setTimeout(r, 150));
    const logBefore = wrapperLog(first).length;

    // ---- wrapper 2: same home, bound to the rebuilt session ----
    const second = await launch({ monitorCommand: LONG_MONITOR_COMMAND }, ["--resume", REBUILT_ID], {
      reuseHome: first.home,
      boundSession: { sessionId: REBUILT_ID, rolloutPath: rebuiltPath },
    });
    const log2 = () => wrapperLog(first).slice(logBefore);
    expect(second.spawned).toHaveLength(1);
    // The main capture of the new wrapper was seeded from the record: the four still-open carried items, nothing foreign.
    expect(second.seeds).toHaveLength(1);
    const remaining = ALL_IDS.filter((id) => id !== LAUNCH_IDS.agent);
    expect(second.seeds[0]!.map((w) => `${w.family}:${w.key}`).sort()).toEqual(
      remaining.map((id) => id.slice(0, id.lastIndexOf(":"))).sort(),
    );
    // Single authority, untouched by the restart: the open items, the generation, the relaunch record, and the
    // result are exactly as wrapper 1 left them. Wrapper 1's orderly exit cleaned up the finished agent's tracking
    // (AC-2.10); its durable result stayed and still answers.
    withStore(first.dbPath, (store) => {
      expect(store.listItems(T)).toEqual(before.items.filter((item) => item.launchId !== LAUNCH_IDS.agent));
      expect(store.getGeneration(T, 1)).toEqual(before.generation);
      expect(store.listPendingResults(T)).toEqual(before.results);
      expect(store.getItem(T, LAUNCH_IDS.monitor)!.relaunch).toEqual(relaunch);
    });
    const cleaned = await runTasks(second.spawned[0]!.env, REBUILT_ID, ["status", LAUNCH_IDS.agent]);
    expect(cleaned.out).toMatch(/state: terminal/);
    expect(cleaned.out).toMatch(/tracking: cleaned up; durable result only/);
    expect(cleaned.out).toMatch(/terminal: completed/);
    expect(existsSync(relaunchOutputPath(first.monitorOutputDir, LAUNCH_IDS.monitor, 2))).toBe(false);
    expect(log2().match(/restarted once|generation \d+ closed|adopted|re-armed/g) ?? []).toEqual([]);
    expect(second.sdk.threadView.compact).not.toHaveBeenCalled();

    // The relaunched Monitor is the same logical item, with its process and output, through the new wrapper's binding.
    const env = second.spawned[0]!.env;
    const status = await runTasks(env, REBUILT_ID, ["status", LAUNCH_IDS.monitor]);
    expect(status.code).toBe(0);
    expect(status.out).toMatch(/state: active/);
    expect(status.out).toMatch(/process: live/);
    expect(status.out).toMatch(/operations: status, output, stop/);
    expect(status.out).toMatch(/identity: verified/);
    const output = await runTasks(env, REBUILT_ID, ["output", LAUNCH_IDS.monitor]);
    expect(output.out).toContain("relaunched-once-XyZ");
    // Foreign thread: not seeded, not reported.
    expect(log2()).not.toContain("th_other");
    const foreign = await runTasks(env, REBUILT_ID, ["status", "agent:agent-9:toolu_agent9"]);
    expect(foreign.code).not.toBe(0);
    expect(foreign.err).toContain("unknown_item");

    // New terminal evidence in the bound session closes the seeded item once; duplicates add nothing.
    second.feed([notification({ taskIds: ["shell-1"], status: "failed" })]);
    await waitFor(() => withStore(first.dbPath, (store) => store.listPendingResults(T).length === 2), "second result");
    second.feed([notification({ taskIds: ["shell-1"], status: "failed" })]);
    second.feed([notification({ taskIds: ["agent-1"], status: "completed" })]);
    withStore(first.dbPath, (store) => {
      expect(store.listItems(T)).toHaveLength(4);
      expect(store.listPendingResults(T).map((r) => [r.launchId, r.outcome])).toEqual([
        [LAUNCH_IDS.agent, "completed"],
        [LAUNCH_IDS.background_shell, "failed"],
      ]);
    });

    // Pending results are deliverable through the new wrapper's hook binding; delivery acknowledges once.
    const hook = await runHook(env, REBUILT_ID, rebuiltPath);
    expect(hook.code).toBe(0);
    const context = (JSON.parse(hook.out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext;
    expect(context).toContain(`result ${LAUNCH_IDS.agent} ·`);
    expect(context).toContain(`result ${LAUNCH_IDS.background_shell} ·`);
    second.feed([hookContextRecord(context)]);
    await waitFor(() => withStore(first.dbPath, (store) => store.listPendingResults(T).length === 0), "delivered");
    const resultsOf = () =>
      withStore(first.dbPath, (store) =>
        [LAUNCH_IDS.agent, LAUNCH_IDS.background_shell].map((id) => store.getResult(T, id)),
      );
    const delivered = resultsOf();
    second.feed([hookContextRecord(context)]);
    expect(resultsOf()).toEqual(delivered);
    expect((await runHook(env, REBUILT_ID, rebuiltPath)).out).toBe("");

    // Management still targets the exact relaunched identity: stop it through the new wrapper.
    const stop = await runTasks(env, REBUILT_ID, ["stop", LAUNCH_IDS.monitor]);
    expect(stop.code).toBe(0);
    await waitFor(() => {
      try {
        process.kill(relaunch.process!.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, "relaunched process gone");
    withStore(first.dbPath, (store) => {
      expect(store.getItem(T, LAUNCH_IDS.monitor)).toMatchObject({
        state: "terminal",
        terminal: { outcome: "stopped" },
      });
      expect(store.listPendingResults(T).map((r) => r.launchId)).toEqual([LAUNCH_IDS.monitor]);
    });
    expect(second.spawned[0]!.writes).toEqual([]);
    await second.finish();
  }, 30_000);

  it("TC-2.9b: malformed carried state is reported and seeds nothing — no item adopted, no evidence consumed, nothing signalled", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-continuity-prod-"));
    homes.push(home);
    const { paths } = hostLayout(home);
    const dbPath = join(home, "cc-lhc.sqlite");
    withStore(dbPath, (store) => {
      const observer = createContinuityObserver({ store, threadId: T, nowFn: () => 1 });
      for (const line of fiveFamilyLaunch(paths)) observer.observeLine(line);
      qualifyAll(store, T, 2);
      store.allocateGeneration({ threadId: T, oldSessionId: "old-session", launchIds: ALL_IDS, nowMs: 3 });
    });
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE cc_continuity_items SET carry_mode = 'bogus' WHERE thread_id = ? AND launch_id = ?").run(
      T,
      LAUNCH_IDS.monitor,
    );
    db.close();

    const rig = await launch({}, [], { reuseHome: home });
    await waitFor(
      () => wrapperLog(rig).includes("carried work unreadable for thread th_auto; nothing seeded"),
      "truthful report",
    );
    expect(wrapperLog(rig)).not.toContain("seeded for thread");
    // Terminal evidence for a carried item is not consumed: the fold holds nothing, so nothing closes and no result appears.
    rig.feed([notification({ taskIds: ["agent-1"], status: "completed" })]);
    await new Promise((r) => setTimeout(r, 200));
    const db2 = new DatabaseSync(dbPath);
    expect(
      db2
        .prepare("SELECT state FROM cc_continuity_items WHERE thread_id = ? AND launch_id = ?")
        .get(T, LAUNCH_IDS.agent),
    ).toEqual({ state: "active" });
    expect(db2.prepare("SELECT count(*) AS n FROM cc_continuity_results").get()).toEqual({ n: 0 });
    db2.close();
    expect(rig.spawned).toHaveLength(1);
    expect(rig.spawned[0]!.killed).toEqual([]);
    expect(existsSync(relaunchOutputPath(rig.monitorOutputDir, LAUNCH_IDS.monitor, 1))).toBe(false);
    await rig.finish();
  }, 15_000);

  it("TC-2.10a-c orderly exit: finished carried work is cleaned up after its result is safe — Monitor fence copied (0600) then removed, user output untouched, open work and its generation preserved, no PTY/provider/rollout activity", async () => {
    const rig = await launch();
    const userOutput = join(rig.paths.tasksDir, "shell-1.output");
    writeFileSync(userOutput, "user bytes 1\n");
    rig.feed(fiveFamilyLaunch(rig.paths));
    await storeHas(rig.dbPath, ALL_IDS);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "handoff result");
    expect(rig.results[0]!.kind).toBe("success");
    await waitFor(() => rig.spawned.length === 2, "replacement child");
    const fence = relaunchOutputPath(rig.monitorOutputDir, LAUNCH_IDS.monitor, 1);
    await waitFor(() => existsSync(fence) && readFileSync(fence, "utf8") === "relaunched-once-XyZ", "relaunch output");
    rig.feedCurrent([notification({ taskIds: ["agent-1"], status: "completed" })]);
    rig.feedCurrent([notification({ taskIds: ["mon-1"], status: "completed" })]);
    await waitFor(() => withStore(rig.dbPath, (store) => store.listPendingResults(T).length === 2), "two results");
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
      open: withStore(rig.dbPath, (store) =>
        [LAUNCH_IDS.background_shell, LAUNCH_IDS.workflow, LAUNCH_IDS.scheduled_wakeup].map((id) =>
          store.getItem(T, id),
        ),
      ),
      generation: withStore(rig.dbPath, (store) => store.getGeneration(T, 1)),
    };

    await rig.finish();

    await waitFor(() => wrapperLog(rig).includes("cc-lhc continuity cleanup: thread th_auto:"), "cleanup log");
    expect(wrapperLog(rig)).toContain(
      "cc-lhc continuity cleanup: thread th_auto: 2 finished item(s) removed, 0 retained, 3 still open, 0 generation row(s) removed",
    );
    withStore(rig.dbPath, (store) => {
      // Finished items: tracking gone, durable results kept.
      expect(store.getItem(T, LAUNCH_IDS.agent)).toBeNull();
      expect(store.getItem(T, LAUNCH_IDS.monitor)).toBeNull();
      expect(store.getResult(T, LAUNCH_IDS.agent)).toMatchObject({
        outcome: "completed",
        artifact: null,
        delivery: "pending",
      });
      const monitor = store.getResult(T, LAUNCH_IDS.monitor)!;
      expect(monitor).toMatchObject({ outcome: "completed", delivery: "pending" });
      expect(monitor.artifact).toMatchObject({
        kind: "owned_copy",
        bytes: "relaunched-once-XyZ".length,
        truncated: false,
      });
      const copy = (monitor.artifact as { path: string }).path;
      expect(copy.startsWith(join(rig.monitorOutputDir, "results"))).toBe(true);
      expect(readFileSync(copy, "utf8")).toBe("relaunched-once-XyZ");
      // 0600 where mode bits exist; on Windows Node reports 0666 for a writable file (ACLs carry the isolation).
      expect(statSync(copy).mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o600);
      // The parent's fence went only after the copy; the user's own output is byte-exact.
      expect(existsSync(fence)).toBe(false);
      expect(readFileSync(userOutput, "utf8")).toBe("user bytes 1\n");
      // Open work and its generation: exactly as before.
      expect(
        [LAUNCH_IDS.background_shell, LAUNCH_IDS.workflow, LAUNCH_IDS.scheduled_wakeup].map((id) =>
          store.getItem(T, id),
        ),
      ).toEqual(before.open);
      expect(store.getGeneration(T, 1)).toEqual(before.generation);
      expect(store.listItems(T)).toHaveLength(3);
      // The durable result still answers status and output.
      expect(itemStatus(store, T, LAUNCH_IDS.monitor)).toMatchObject({
        ok: true,
        status: {
          state: "terminal",
          carryMode: null,
          operations: ["status", "output"],
          terminal: { outcome: "completed" },
        },
      });
      const output = readItemOutput(store, T, LAUNCH_IDS.monitor);
      expect(output.ok && output.bytes.toString("utf8")).toBe("relaunched-once-XyZ");
    });
    expect(sdkCalls()).toEqual(before.sdk);
    expect(rig.spawned.map((p) => p.writes.length)).toEqual(before.ptyWrites);
    expect(readFileSync(rebuiltPath).equals(before.rollout)).toBe(true);
  }, 20_000);

  it("TC-2.10 orderly exit with no bound thread cleans up nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-continuity-prod-"));
    homes.push(home);
    process.env.CC_LHC_HOME = home;
    const { paths } = hostLayout(home);
    const dbPath = join(home, "cc-lhc.sqlite");
    withStore(dbPath, (store) => {
      const observer = createContinuityObserver({ store, threadId: T, nowFn: () => 1 });
      for (const line of fiveFamilyLaunch(paths)) observer.observeLine(line);
      qualifyAll(store, T, 2);
      store.allocateGeneration({ threadId: T, oldSessionId: "old-session", launchIds: ALL_IDS, nowMs: 3 });
      store.recordTerminal({
        threadId: T,
        launchId: LAUNCH_IDS.agent,
        outcome: "completed",
        evidence: "done",
        nowMs: 4,
      });
    });
    const snapshot = () =>
      withStore(dbPath, (store) => ({
        items: store.listItems(T),
        generation: store.getGeneration(T, 1),
        results: store.listPendingResults(T),
      }));
    const before = snapshot();
    const spawned: FakePty[] = [];
    const runPromise = run([], {
      claudeBin: "fake-claude",
      unboundTestChild: true,
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(7000, args);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin: fakeStream(),
      stdout: fakeStream() as never,
      stderr: fakeStream() as never,
      noInference: true,
      resolvedContextPolicy: POLICY as never,
      governorReceiptDbPath: dbPath,
    });
    await waitFor(() => spawned.length === 1, "child");
    spawned[0]!.fireExit(0);
    await runPromise;
    const logPath = join(home, "wrapper.log");
    const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
    await waitFor(
      () => log().includes("cc-lhc continuity cleanup: no bound thread; nothing cleaned up"),
      "no-binding log",
    );
    expect(log()).toContain("cc-lhc continuity cleanup: no bound thread; nothing cleaned up");
    expect(log()).not.toContain("finished item(s) removed");
    expect(snapshot()).toEqual(before);
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
    // With the fence gone, closed-generation readback stays read-only and
    // truthful: no spawn, no terminal recorded, and the log says so.
    withStore(rig.dbPath, (store) => {
      const itemBefore = store.getItem(T, LAUNCH_IDS.monitor);
      rmSync(outputPath);
      const logs: string[] = [];
      const readback = invokeCarryover(
        store,
        snapshotOf(store, 1),
        { monitorOutputDir: rig.monitorOutputDir, cwd: rig.home, log: (line) => logs.push(line) },
        Date.now(),
      );
      expect(readback.results.find((r) => r.launchId === LAUNCH_IDS.monitor)).toMatchObject({
        kind: "failed",
        reason: "monitor relaunch unavailable: generation_closed",
      });
      expect(store.getItem(T, LAUNCH_IDS.monitor)).toEqual(itemBefore);
      const monitorLine = logs.find((l) => l.includes(LAUNCH_IDS.monitor));
      expect(monitorLine).toContain("generation 1 already closed; nothing recorded");
      expect(monitorLine).not.toContain("recorded as failed");
      expect(existsSync(outputPath)).toBe(false); // nothing respawned the fence
      writeFileSync(outputPath, "relaunched-once-XyZ");
    });
    expect(readFileSync(outputPath, "utf8")).toBe("relaunched-once-XyZ");
    // Same logical item in the manifest; the durable transition says restarted,
    // never adopted (detailed-vs-bounded wording is owned by continuity-note.test.ts).
    expect(rig.receipts[0]).toContain(`[${LAUNCH_IDS.monitor}]`);
    expect(rig.receipts[0]).not.toMatch(/monitor "CI watch" \(mon-1\): adopted/);
    withStore(rig.dbPath, (store) => {
      expect(snapshotOf(store, 1).items.find((i) => i.launchId === LAUNCH_IDS.monitor)).toMatchObject({
        transition: "restarted",
        continuation: { kind: "monitor_relaunch" },
      });
    });
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
    onTestFinished(() => closeQuietly(store));
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
    for (const id of ALL_IDS) expect(note, id).toContain(`[${id}]`);
    expect(note).toContain("cc-lhc tasks status|output|stop");
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

describe("LIM-149 TC-4.5d: adopted tasks outlive Smart Compact via the retained completion host", () => {
  /** An identity probe where the listed pids are alive with stable exact identities. */
  function probeFor(alive: Set<number>): (pid: number) => ProcessLivenessResult {
    return (pid: number) =>
      alive.has(pid)
        ? { ok: true, identity: { pid, bootId: "boot-fixture", starttime: `st-${pid}` } }
        : { ok: false, code: "not_found", message: "no such process" };
  }

  /** A second adopted shell launch so success and failure outcomes coexist. */
  function secondShellLines(p: LaunchPaths): RolloutLineItem[] {
    return [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_sh2",
              name: "Bash",
              input: { command: "make check", run_in_background: true },
            },
          ],
        },
      } as unknown as RolloutLineItem,
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_sh2",
              content: `Command running in background with ID: shell-2. Output is being written to: ${join(p.tasksDir, "shell-2.output")}`,
            },
          ],
        },
        toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: "shell-2" },
      } as unknown as RolloutLineItem,
    ];
  }
  const SHELL2_ID = "background_shell:shell-2:toolu_sh2";

  it("adopt-only carryover: host retained (no kill), distinct real outcomes delivered exactly once, host retired after delivery", async () => {
    const alive = new Set([1000]);
    const rig = await launch({ monitorInRollout: false }, [], { probeProcessIdentity: probeFor(alive) });
    writeFileSync(join(rig.paths.tasksDir, "shell-2.output"), "building\n");

    rig.feed([...LAUNCHES.background_shell.lines(rig.paths), ...secondShellLines(rig.paths)]);
    await storeHas(rig.dbPath, [LAUNCH_IDS.background_shell, SHELL2_ID]);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "handoff result");
    expect(rig.results[0]!.kind).toBe("success");

    // The old child was RETAINED, never signalled: it is the completion host.
    const oldPty = rig.spawned[0]!;
    expect(oldPty.killed).toEqual([]);
    expect(wrapperLog(rig)).toContain("retained as completion host for 2 adopted background task(s)");
    const host = withStore(rig.dbPath, (store) => store.retainedHostGeneration(T)?.retainedHost);
    expect(host).toMatchObject({ pid: 1000, bootId: "boot-fixture", starttime: "st-1000" });
    // Receipt truth: cleanup recorded as retained_task_host, not terminated.
    const receiptDb = new DatabaseSync(rig.dbPath, { readOnly: true });
    const kinds = receiptDb
      .prepare("SELECT cleanup_kind FROM cc_handoff_receipts ORDER BY rowid DESC LIMIT 1")
      .get() as { cleanup_kind: string };
    receiptDb.close();
    expect(kinds.cleanup_kind).toBe("retained_task_host");

    // Both items carried as adopt, still active — no invented outcome.
    for (const id of [LAUNCH_IDS.background_shell, SHELL2_ID]) {
      expect(withStore(rig.dbPath, (store) => store.getItem(T, id))).toMatchObject({
        carryMode: "adopt",
        state: "active",
      });
    }

    // Claude (the retained host) supervises to the end and writes the real
    // outcomes: exit 0 for one task, exit 3 for the other (probed 2.1.258).
    appendFileSync(join(rig.paths.tasksDir, "shell-1.output"), "\n[exited with code 0]\n");
    appendFileSync(join(rig.paths.tasksDir, "shell-2.output"), "\n[exited with code 3]\n");

    const rebuiltPath = join(rig.home, `${REBUILT_ID}.jsonl`);
    const sdkCalls = () =>
      Object.fromEntries(
        Object.entries(rig.sdk.threadView).map(([name, fn]) => [
          name,
          (fn as ReturnType<typeof vi.fn>).mock.calls.length,
        ]),
      );
    const before = { sdk: sdkCalls(), ptyWrites: rig.spawned.map((p) => p.writes.length) };

    // The next real prompt's hook settles both from the markers and serves them.
    const replacement = rig.spawned[1]!;
    const hook = await runHook(replacement.env, REBUILT_ID, rebuiltPath);
    expect(hook.code).toBe(0);
    const context = (JSON.parse(hook.out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext;
    expect(context).toContain(`result ${LAUNCH_IDS.background_shell}`);
    expect(context).toContain(`result ${SHELL2_ID}`);
    const one = withStore(rig.dbPath, (store) => store.getItem(T, LAUNCH_IDS.background_shell));
    const two = withStore(rig.dbPath, (store) => store.getItem(T, SHELL2_ID));
    expect(one?.terminal).toMatchObject({ outcome: "completed" });
    expect(one?.terminal?.evidence).toContain("exited with code 0");
    expect(two?.terminal).toMatchObject({ outcome: "failed" });
    expect(two?.terminal?.evidence).toContain("exited with code 3");

    // Exactly-once delivery of both, then a replayed ack changes nothing.
    rig.feedCurrent([hookContextRecord(context)]);
    await waitFor(() => withStore(rig.dbPath, (store) => store.listPendingResults(T).length) === 0, "both delivered");
    const settled = withStore(rig.dbPath, (store) => [
      store.getResult(T, LAUNCH_IDS.background_shell),
      store.getResult(T, SHELL2_ID),
    ]);
    expect(settled.map((r) => r?.outcome)).toEqual(["completed", "failed"]);
    rig.feedCurrent([hookContextRecord(context)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      withStore(rig.dbPath, (store) => [
        store.getResult(T, LAUNCH_IDS.background_shell),
        store.getResult(T, SHELL2_ID),
      ]),
    ).toEqual(settled);
    expect((await runHook(replacement.env, REBUILT_ID, rebuiltPath)).out).toBe("");

    // Delivery was the settle seam: with nothing left to supervise, the host
    // is retired gracefully (its own PTY handle) and the record cleared.
    await waitFor(() => oldPty.killed.length > 0, "host retired");
    expect(oldPty.killed).toContain("SIGTERM");
    expect(oldPty.killed).not.toContain("SIGKILL");
    await waitFor(
      () => withStore(rig.dbPath, (store) => store.retainedHostGeneration(T)) === null,
      "host record cleared",
    );

    // No provider call, no PTY write to the replacement, throughout.
    expect(sdkCalls()).toEqual(before.sdk);
    expect(rig.spawned[1]!.writes.length).toBe(before.ptyWrites[1]);
    await rig.finish();
  }, 20_000);

  /**
   * Seams for a carryover that pauses the wrapper's own supervised child.
   * Every target is that child (pid 1000) or one of its own tasks; the test
   * drives them through injected seams and never touches a real process.
   */
  function pauseSeams() {
    const alive = new Set([1000]);
    const signals: Array<[number, string]> = [];
    const hostSignal = (pid: number, signal: NodeJS.Signals): void => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL" || signal === "SIGTERM") alive.delete(pid);
    };
    const taskFor = (path: string): { pid: number; bootId: string; starttime: string } | null =>
      path.endsWith("shell-1.output")
        ? { pid: 7001, bootId: "boot-task", starttime: "st-7001" }
        : path.endsWith("shell-2.output")
          ? { pid: 7002, bootId: "boot-task", starttime: "st-7002" }
          : null;
    const discoverTaskProcess: typeof discoverAdoptedTaskProcess = (_parentPid, output) => taskFor(output.path);
    /** The task's own exit status, as the paused supervisor's uncollected child record reports it. */
    const readTaskExit = (proc: { pid: number; starttime: string }) =>
      proc.pid === 7001
        ? ({ kind: "exited", code: 0 } as const)
        : proc.pid === 7002
          ? ({ kind: "exited", code: 3 } as const)
          : null;
    return { alive, signals, hostSignal, discoverTaskProcess, readTaskExit, probe: probeFor(alive) };
  }

  function sdkCallCounts(rig: Rig): Record<string, number> {
    return Object.fromEntries(
      Object.entries(rig.sdk.threadView).map(([name, fn]) => [
        name,
        (fn as ReturnType<typeof vi.fn>).mock.calls.length,
      ]),
    );
  }

  it("mixed carryover (shell + agent): the supervised child is paused, its shell keeps running, and the real exit status settles exactly once", async () => {
    const seams = pauseSeams();
    const rig = await launch({ monitorInRollout: false }, [], {
      probeProcessIdentity: seams.probe,
      hostSignal: seams.hostSignal,
      discoverTaskProcess: seams.discoverTaskProcess,
      readTaskExit: seams.readTaskExit,
    });
    rig.feed([...LAUNCHES.agent.lines(rig.paths), ...LAUNCHES.background_shell.lines(rig.paths)]);
    await storeHas(rig.dbPath, [LAUNCH_IDS.agent, LAUNCH_IDS.background_shell]);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "handoff result");
    expect(rig.results[0]!.kind).toBe("success");

    // The supervised child was paused at the switch, never terminated: its
    // shell keeps running, and its own model can start no further work.
    const oldPty = rig.spawned[0]!;
    expect(oldPty.killed).toEqual([]);
    expect(seams.signals).toEqual([[1000, "SIGSTOP"]]);
    expect(withStore(rig.dbPath, (store) => store.retainedHostGeneration(T)?.retainedHost)).toMatchObject({
      pid: 1000,
      bootId: "boot-fixture",
      starttime: "st-1000",
      frozen: true,
    });

    // Both families carried once under the same generation: the agent by the
    // replacement, the shell adopted in place.
    expect(withStore(rig.dbPath, (store) => store.getItem(T, LAUNCH_IDS.agent))).toMatchObject({
      carryMode: "reconstruct",
      generation: 1,
    });
    expect(withStore(rig.dbPath, (store) => store.getItem(T, LAUNCH_IDS.background_shell))).toMatchObject({
      carryMode: "adopt",
      state: "active",
      generation: 1,
    });

    const before = { sdk: sdkCallCounts(rig), replacementWrites: rig.spawned[1]!.writes.length };
    const replacement = rig.spawned[1]!;
    const rebuiltPath = join(rig.home, `${REBUILT_ID}.jsonl`);

    // The next real prompt settles the shell from its own exit status.
    const hook = await runHook(replacement.env, REBUILT_ID, rebuiltPath, { readTaskExit: seams.readTaskExit });
    expect(hook.code).toBe(0);
    const context = (JSON.parse(hook.out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext;
    expect(context).toContain(`result ${LAUNCH_IDS.background_shell}`);
    const settledItem = withStore(rig.dbPath, (store) => store.getItem(T, LAUNCH_IDS.background_shell));
    expect(settledItem?.terminal).toMatchObject({ outcome: "completed" });
    expect(settledItem?.terminal?.evidence).toContain("exited with code 0");

    // Delivered exactly once: a replayed acknowledgement changes no byte.
    rig.feedCurrent([hookContextRecord(context)]);
    await waitFor(() => withStore(rig.dbPath, (store) => store.listPendingResults(T).length) === 0, "delivered");
    const delivered = withStore(rig.dbPath, (store) => store.getResult(T, LAUNCH_IDS.background_shell));
    expect(delivered).toMatchObject({ outcome: "completed", delivery: "delivered" });
    rig.feedCurrent([hookContextRecord(context)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(withStore(rig.dbPath, (store) => store.getResult(T, LAUNCH_IDS.background_shell))).toEqual(delivered);
    expect((await runHook(replacement.env, REBUILT_ID, rebuiltPath, { readTaskExit: seams.readTaskExit })).out).toBe(
      "",
    );

    // Retired only once its last task had settled, and only by exact identity.
    await waitFor(() => seams.signals.some(([, signal]) => signal === "SIGKILL"), "supervised child retired");
    expect(seams.signals).toEqual([
      [1000, "SIGSTOP"],
      [1000, "SIGKILL"],
    ]);
    await waitFor(
      () => withStore(rig.dbPath, (store) => store.retainedHostGeneration(T)) === null,
      "host record cleared",
    );

    // No provider call and no terminal traffic from the old session throughout.
    expect(sdkCallCounts(rig)).toEqual(before.sdk);
    expect(rig.spawned[1]!.writes.length).toBe(before.replacementWrites);
    expect(oldPty.writes).toEqual([]);
    await rig.finish();
  }, 20_000);

  it("mixed carryover (shells + scheduled wakeup): each shell keeps its own real outcome, success and failure distinct", async () => {
    const seams = pauseSeams();
    const rig = await launch({ monitorInRollout: false }, [], {
      probeProcessIdentity: seams.probe,
      hostSignal: seams.hostSignal,
      discoverTaskProcess: seams.discoverTaskProcess,
      readTaskExit: seams.readTaskExit,
    });
    writeFileSync(join(rig.paths.tasksDir, "shell-2.output"), "building\n");
    rig.feed([
      ...LAUNCHES.scheduled_wakeup.lines(rig.paths),
      ...LAUNCHES.background_shell.lines(rig.paths),
      ...secondShellLines(rig.paths),
    ]);
    await storeHas(rig.dbPath, [LAUNCH_IDS.scheduled_wakeup, LAUNCH_IDS.background_shell, SHELL2_ID]);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "handoff result");
    expect(rig.results[0]!.kind).toBe("success");

    expect(rig.spawned[0]!.killed).toEqual([]);
    expect(seams.signals[0]).toEqual([1000, "SIGSTOP"]);
    // The wakeup is rearmed by the replacement, exactly one carried record.
    expect(withStore(rig.dbPath, (store) => store.getItem(T, LAUNCH_IDS.scheduled_wakeup))).toMatchObject({
      carryMode: "rearm",
      generation: 1,
    });
    expect(withStore(rig.dbPath, (store) => store.getGeneration(T, 1)?.launchIds.length)).toBe(3);

    const replacement = rig.spawned[1]!;
    const rebuiltPath = join(rig.home, `${REBUILT_ID}.jsonl`);
    const hook = await runHook(replacement.env, REBUILT_ID, rebuiltPath, { readTaskExit: seams.readTaskExit });
    expect(hook.code).toBe(0);

    const first = withStore(rig.dbPath, (store) => store.getItem(T, LAUNCH_IDS.background_shell));
    const second = withStore(rig.dbPath, (store) => store.getItem(T, SHELL2_ID));
    expect(first?.terminal).toMatchObject({ outcome: "completed" });
    expect(first?.terminal?.evidence).toContain("exited with code 0");
    expect(second?.terminal).toMatchObject({ outcome: "failed" });
    expect(second?.terminal?.evidence).toContain("exited with code 3");

    const context = (JSON.parse(hook.out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext;
    rig.feedCurrent([hookContextRecord(context)]);
    await waitFor(() => withStore(rig.dbPath, (store) => store.listPendingResults(T).length) === 0, "both delivered");
    expect(
      withStore(rig.dbPath, (store) => [
        store.getResult(T, LAUNCH_IDS.background_shell)?.outcome,
        store.getResult(T, SHELL2_ID)?.outcome,
      ]),
    ).toEqual(["completed", "failed"]);
    await rig.finish();
  }, 20_000);

  it("FAIL CLOSED: a mixed carryover whose task process could not be pinned never pauses the child — it is terminated gracefully and the shell closes from Claude's own marker", async () => {
    const seams = pauseSeams();
    const rig = await launch({ monitorInRollout: false }, [], {
      probeProcessIdentity: seams.probe,
      hostSignal: seams.hostSignal,
      discoverTaskProcess: () => null,
      readTaskExit: seams.readTaskExit,
    });
    rig.feed([...LAUNCHES.agent.lines(rig.paths), ...LAUNCHES.background_shell.lines(rig.paths)]);
    await storeHas(rig.dbPath, [LAUNCH_IDS.agent, LAUNCH_IDS.background_shell]);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "handoff result");
    expect(rig.results[0]!.kind).toBe("success");
    // No pause, no host record: the plain graceful discipline, logged truthfully.
    expect(seams.signals).toEqual([]);
    expect(rig.spawned[0]!.killed).toEqual(["SIGTERM"]);
    expect(withStore(rig.dbPath, (store) => store.retainedHostGeneration(T))).toBeNull();
    expect(wrapperLog(rig)).toContain("no task process pinned for background_shell:shell-1:toolu_sh");
    // The agent still carried by the replacement; the shell settles from Claude's marker.
    expect(withStore(rig.dbPath, (store) => store.getItem(T, LAUNCH_IDS.agent))).toMatchObject({
      carryMode: "reconstruct",
      generation: 1,
    });
    appendFileSync(join(rig.paths.tasksDir, "shell-1.output"), "\n[killed]\n");
    const hook = await runHook(rig.spawned[1]!.env, REBUILT_ID, join(rig.home, `${REBUILT_ID}.jsonl`));
    expect(hook.code).toBe(0);
    expect(withStore(rig.dbPath, (store) => store.getItem(T, LAUNCH_IDS.background_shell))?.terminal).toMatchObject({
      outcome: "killed",
    });
    await rig.finish();
  }, 20_000);

  it("a handoff carrying no adopted item keeps the plain graceful discipline and records no host", async () => {
    const rig = await launch({ monitorInRollout: false });
    rig.feed(LAUNCHES.scheduled_wakeup.lines());
    await storeHas(rig.dbPath, [LAUNCH_IDS.scheduled_wakeup]);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "handoff result");
    expect(rig.results[0]!.kind).toBe("success");
    expect(rig.spawned[0]!.killed).toContain("SIGTERM");
    expect(wrapperLog(rig)).not.toContain("retained as completion host");
    expect(withStore(rig.dbPath, (store) => store.retainedHostGeneration(T))).toBeNull();
    await rig.finish();
  }, 15_000);

  it("orderly wrapper exit retires the retained host instead of orphaning it", async () => {
    const alive = new Set([1000]);
    const rig = await launch({ monitorInRollout: false }, [], { probeProcessIdentity: probeFor(alive) });
    rig.feed(LAUNCHES.background_shell.lines(rig.paths));
    await storeHas(rig.dbPath, [LAUNCH_IDS.background_shell]);
    rig.lifecycle(TRIGGER_SIGNALS);
    await waitFor(() => rig.results.length === 1, "handoff result");
    const oldPty = rig.spawned[0]!;
    expect(oldPty.killed).toEqual([]);
    // The task is still running; the wrapper exits. The host must not outlive
    // the wrapper — graceful, so Claude reaps and writes its truthful marker.
    await rig.finish();
    expect(oldPty.killed).toContain("SIGTERM");
    // The wrapper log is appended asynchronously; the line lands after run() resolves on slower hosts.
    await waitFor(
      () => wrapperLog(rig).includes("terminating retained completion host pid 1000 on orderly exit"),
      "teardown log",
    );
  }, 15_000);
});
