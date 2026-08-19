/**
 * LIM-100 outcomes: an automatic compact swap does not silently kill live
 * background work.
 *
 * Every test drives run() to a settled seam over the trigger. What changes is
 * whether the operator is at a terminal and whether anything asynchronous is
 * still running; what is asserted is how many times the compact-and-swap path
 * actually ran.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import type { GovernorDurableReceipt } from "../../src/governor/types.js";
import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import type { OpenAsyncWork } from "../../src/observation/async-work.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import { emptyCaptureStats } from "../../src/stats.js";
import { run } from "../../src/wrapper/run.js";

const mocks = vi.hoisted(() => ({
  captureFactory: null as ((opts: CaptureSessionDeps) => CaptureSession) | null,
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

interface FakePty {
  pid: number;
  args: string[];
  writes: string[];
  /** Push a frame from this child on demand (output-hold pressure). */
  emitData(data: string): void;
  fireExit(code: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (arg: { exitCode: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  write(data: string): void;
  resize(): void;
}

function makeFakePty(pid: number, args: string[]): FakePty {
  const exitCbs: Array<(arg: { exitCode: number }) => void> = [];
  const dataCbs: Array<(data: string) => void> = [];
  const fake: FakePty = {
    pid,
    args,
    writes: [],
    emitData(data: string) {
      for (const cb of dataCbs) cb(data);
    },
    fireExit(code: number) {
      for (const cb of exitCbs) cb({ exitCode: code });
    },
    onData: (cb) => {
      dataCbs.push(cb);
      setTimeout(() => cb("render\r\n"), 20);
      return { dispose() {} };
    },
    onExit: (cb) => {
      exitCbs.push(cb);
      return { dispose() {} };
    },
    kill: () => {
      setImmediate(() => fake.fireExit(0));
    },
    write: (data: string) => {
      fake.writes.push(data);
    },
    resize: () => {},
  };
  return fake;
}

function sdkForCapture(onCompactAttempt: () => void) {
  return {
    drainSettled: async () => {},
    threadView: {
      status: vi.fn(async () => ({
        ok: true,
        value: {
          tailTokens: 10,
          threshold: 100,
          visibility: { zoneTokens: 0, maxTokens: 1_000 },
          derivation: { pending: 0, failed: 0 },
        },
      })),
      previewCompact: vi.fn(async () => {
        onCompactAttempt();
        return { ok: true, value: { kind: "ok" } };
      }),
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
        value: { threadId: "th_async", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
      })),
    },
    intakeStream: { messageEvents: async () => ({ ok: true, value: { events: [] } }) },
  };
}

function scriptedCapture(sdk: unknown, liveWork: () => OpenAsyncWork[]): CaptureSession {
  const stats = { ...emptyCaptureStats(), threadId: "th_async" };
  return {
    stats,
    getCommandContext: () => ({
      stats,
      sdk: sdk as Lhc,
      threadRef: { threadId: "th_async", registryPath: "/tmp/reg.sqlite" },
      captureDegraded: false,
      captureGeneration: 1,
      capturePhase: "ready" as const,
    }),
    getRolloutInfo: () => ({ path: "/tmp/old-session.jsonl", sessionId: "old-session" }),
    isTurnOpen: () => false,
    isCaptureHealthy: () => true,
    isCaptureReady: () => true,
    getCaptureHealth: () => ({
      generation: 1,
      phase: "ready" as const,
      reasons: [],
      reasonCounts: {},
      durableLineOffset: 0,
    }),
    getCaptureGeneration: () => 1,
    getLiveAsyncWork: () => liveWork(),
    stop: vi.fn(async () => {}),
  } as unknown as CaptureSession;
}

function fakeStream(isTTY: boolean): NodeJS.ReadStream & NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & NodeJS.WriteStream;
  Object.defineProperty(stream, "isTTY", { value: isTTY, configurable: true });
  Object.defineProperty(stream, "columns", { value: 100, configurable: true });
  Object.defineProperty(stream, "rows", { value: 30, configurable: true });
  (stream as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};
  return stream;
}

async function waitFor(condition: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function settle(ms = 120): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const POLICY = (() => {
  const base = {
    autoCompact: true,
    lowerBoundTokens: 1_000,
    upperBoundTokens: 5_000,
    profile: "continuation",
    pruneEnabled: false,
    pruneThresholdTokens: null,
    pruneTargetTokens: null,
    minRunwayTokens: 100,
  };
  return {
    policy: base,
    sources: Object.fromEntries(Object.keys(base).map((k) => [k, "session"])) as never,
    fallbacks: [],
  };
})();

const BOUND: LifecycleSignal[] = [{ kind: "session_bound", sessionId: "old-session" }];

function overTrigger(samplingId: string): LifecycleSignal[] {
  return [
    { kind: "turn_opened", reason: "user_prompt" },
    {
      kind: "sampling_observed",
      samplingId,
      providerUsage: {
        input_tokens: 9_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 10,
      },
    },
    { kind: "turn_settled", reason: "end_turn" },
  ];
}

function monitorWork(taskId = "m1"): OpenAsyncWork {
  return { key: taskId, family: "monitor", taskId, description: "CI watch" };
}

const dirs: string[] = [];

interface Rig {
  runPromise: Promise<number>;
  stdin: PassThrough;
  pty: () => FakePty;
  fire: (signals: LifecycleSignal[]) => void;
  compactAttempts: () => number;
  terminal: () => string;
  logs: string[];
  setLiveWork: (work: OpenAsyncWork[]) => void;
  /** Every durable governor receipt, read straight out of the store's file. */
  receipts: () => GovernorDurableReceipt[];
  /**
   * Receipts for the executable settled seam. Open-turn classifications are
   * ordinary observation and keep being written; what an unauthorized swap
   * must never leave behind is one of these.
   */
  settledReceipts: () => GovernorDurableReceipt[];
  end: () => Promise<number>;
}

async function startRig(
  options: {
    interactive?: boolean;
    liveWork?: OpenAsyncWork[];
    /** Terminal that cannot be drawn on: every alt-screen switch throws. */
    breakTerminalWrites?: boolean;
    outputHoldCapBytes?: number;
  } = {},
): Promise<Rig> {
  let compactAttempts = 0;
  let live = options.liveWork ?? [];
  const logs: string[] = [];
  const sdk = sdkForCapture(() => {
    compactAttempts += 1;
  });
  let sink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
  mocks.captureFactory = (opts) => {
    const session = scriptedCapture(sdk, () => live);
    if (opts.onLifecycle !== undefined && sink === undefined) sink = opts.onLifecycle;
    return session;
  };
  const ptys: FakePty[] = [];
  const dir = mkdtempSync(join(tmpdir(), "cc-lhc-async-confirm-"));
  dirs.push(dir);
  const receiptDbPath = join(dir, "r.sqlite");

  const interactive = options.interactive ?? true;
  const stdin = fakeStream(interactive);
  const stdout = fakeStream(interactive);
  let terminal = "";
  (stdout as unknown as PassThrough).on("data", (chunk: Buffer) => {
    terminal += chunk.toString("utf8");
  });
  if (options.breakTerminalWrites === true) {
    const realWrite = stdout.write.bind(stdout) as (chunk: string) => boolean;
    (stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      if (chunk.includes("\x1b[?1049h")) throw new Error("terminal write failed");
      return realWrite(chunk);
    };
  }

  const runPromise = run([], {
    claudeBin: "fake-claude",
    spawnPty: ((_file: string, args: string[]) => {
      const fake = makeFakePty(9700 + ptys.length, args);
      ptys.push(fake);
      return fake as never;
    }) as never,
    stdin,
    stdout,
    stderr: fakeStream(false),
    noInference: true,
    resolvedContextPolicy: POLICY as never,
    governorReceiptDbPath: receiptDbPath,
    ...(options.outputHoldCapBytes === undefined ? {} : { outputHoldCapBytes: options.outputHoldCapBytes }),
    wrapperLog: {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      warningCount: () => 0,
      path: "/tmp/fake.log",
    } as never,
  });

  const readReceipts = (): GovernorDurableReceipt[] => {
    const store = openGovernorReceiptStore(receiptDbPath);
    try {
      return store.listAll();
    } finally {
      store.close();
    }
  };

  await waitFor(() => sink !== undefined, "capture lifecycle sink");
  await waitFor(() => ptys.length === 1, "first child");
  sink!(BOUND);
  return {
    runPromise,
    stdin: stdin as unknown as PassThrough,
    pty: () => ptys[ptys.length - 1]!,
    fire: (signals) => sink!(signals),
    compactAttempts: () => compactAttempts,
    terminal: () => terminal,
    logs,
    setLiveWork: (work) => {
      live = work;
    },
    receipts: readReceipts,
    settledReceipts: () => readReceipts().filter((receipt) => receipt.observePhase === "settled_seam"),
    end: async () => {
      ptys[ptys.length - 1]!.fireExit(0);
      return runPromise;
    },
  };
}

describe("an automatic swap asks before it kills live background work", () => {
  const savedHome = process.env.CC_LHC_HOME;
  beforeEach(() => {
    mocks.captureFactory = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-async-home-"));
    dirs.push(home);
    process.env.CC_LHC_HOME = home;
  });
  afterEach(async () => {
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

  it("compacts with no prompt when nothing asynchronous is open", async () => {
    const rig = await startRig({ liveWork: [] });
    rig.fire(overTrigger("req:empty"));
    await waitFor(() => rig.compactAttempts() === 1, "compact with an empty set");
    expect(rig.terminal()).not.toContain("live background work");
    await rig.end();
  }, 15_000);

  it("shows the work and waits, instead of swapping, when something is open", async () => {
    const rig = await startRig({ liveWork: [monitorWork()] });
    rig.fire(overTrigger("req:ask"));
    await waitFor(() => rig.terminal().includes("live background work"), "confirmation on screen");
    expect(rig.terminal()).toContain("will kill 1 piece of live background work");
    expect(rig.terminal()).toContain('monitor "CI watch" (m1)');
    // Nothing has been swapped while the question is unanswered, and nothing
    // has been written down either.
    await settle();
    expect(rig.compactAttempts()).toBe(0);
    expect(rig.settledReceipts()).toEqual([]);
    expect(rig.receipts().some((receipt) => receipt.wouldMutate)).toBe(false);
    rig.stdin.write("n");
    await settle();
    await rig.end();
  }, 15_000);

  it("compacts exactly once on an explicit yes", async () => {
    const rig = await startRig({ liveWork: [monitorWork()] });
    rig.fire(overTrigger("req:yes"));
    await waitFor(() => rig.terminal().includes("live background work"), "confirmation on screen");
    // Still nothing durable while the question stands.
    expect(rig.settledReceipts()).toEqual([]);
    rig.stdin.write("y");
    await waitFor(() => rig.compactAttempts() === 1, "compact after yes");
    await settle(200);
    expect(rig.compactAttempts()).toBe(1);
    expect(rig.logs.some((line) => line.includes("operator authorized compact over 1 live background item"))).toBe(
      true,
    );
    // Yes enters the ordinary path: one receipt, one classification, and no
    // trace of the confirmation itself.
    const written = rig.settledReceipts();
    expect(written).toHaveLength(1);
    expect(written[0]?.wouldMutate).toBe(true);
    expect(written[0]?.observePhase).toBe("settled_seam");
    expect(written[0]?.handoffOutcome?.kind).not.toBe("mutation_deferred");
    // The answer was ours: no keystroke reached Claude.
    expect(rig.pty().writes.join("")).not.toContain("y");
    await rig.end();
  }, 15_000);

  it("swaps nothing on a decline, and asks again at the next seam", async () => {
    const rig = await startRig({ liveWork: [monitorWork()] });
    rig.fire(overTrigger("req:no"));
    await waitFor(() => rig.terminal().includes("live background work"), "first confirmation");
    rig.stdin.write("n");
    await settle(200);
    expect(rig.compactAttempts()).toBe(0);
    expect(rig.logs.some((line) => line.includes("compact not authorized"))).toBe(true);
    // Nothing about an unauthorized seam is written down.
    expect(rig.settledReceipts()).toEqual([]);
    expect(rig.receipts().some((receipt) => receipt.wouldMutate)).toBe(false);

    // The next settled seam over the trigger asks again — nothing was
    // remembered, and the work is still open.
    const before = rig.terminal().length;
    rig.fire(overTrigger("req:no-again"));
    await waitFor(() => rig.terminal().slice(before).includes("live background work"), "second confirmation");
    expect(rig.compactAttempts()).toBe(0);
    rig.stdin.write("y");
    await waitFor(() => rig.compactAttempts() === 1, "compact after the second ask");
    await rig.end();
  }, 20_000);

  it("swaps nothing when the prompt is dismissed", async () => {
    const rig = await startRig({ liveWork: [monitorWork()] });
    rig.fire(overTrigger("req:dismiss"));
    await waitFor(() => rig.terminal().includes("live background work"), "confirmation on screen");
    rig.stdin.write("\x03");
    await settle(200);
    expect(rig.compactAttempts()).toBe(0);
    expect(rig.logs.some((line) => line.includes("operator dismissed the prompt"))).toBe(true);
    expect(rig.settledReceipts()).toEqual([]);
    expect(rig.receipts().some((receipt) => receipt.wouldMutate)).toBe(false);
    await rig.end();
  }, 15_000);

  it("swaps nothing when terminal input goes away with the prompt up", async () => {
    const rig = await startRig({ liveWork: [monitorWork()] });
    rig.fire(overTrigger("req:eof"));
    await waitFor(() => rig.terminal().includes("live background work"), "confirmation on screen");
    rig.stdin.end();
    await settle(200);
    expect(rig.compactAttempts()).toBe(0);
    expect(rig.logs.some((line) => line.includes("terminal input closed before an answer"))).toBe(true);
    expect(rig.settledReceipts()).toEqual([]);
    expect(rig.receipts().some((receipt) => receipt.wouldMutate)).toBe(false);
    await rig.end();
  }, 15_000);

  it("stops asking once the work has closed", async () => {
    const rig = await startRig({ liveWork: [monitorWork()] });
    rig.fire(overTrigger("req:closes"));
    await waitFor(() => rig.terminal().includes("live background work"), "confirmation on screen");
    rig.stdin.write("n");
    await settle(200);
    // The monitor finished while the operator was deciding.
    rig.setLiveWork([]);
    rig.fire(overTrigger("req:closed-now"));
    await waitFor(() => rig.compactAttempts() === 1, "compact once the set is empty");
    await rig.end();
  }, 20_000);

  it("names every open item, in the plural, when several are running", async () => {
    const rig = await startRig({
      liveWork: [
        { key: "a1", family: "agent", taskId: "a1", description: "reviewer" },
        { key: "w1", family: "workflow", taskId: "w1", description: "story-build" },
        monitorWork("m9"),
      ],
    });
    rig.fire(overTrigger("req:many"));
    await waitFor(() => rig.terminal().includes("live background work"), "confirmation on screen");
    const screen = rig.terminal();
    expect(screen).toContain("will kill 3 pieces of live background work");
    expect(screen).toContain('background agent "reviewer" (a1)');
    expect(screen).toContain('workflow "story-build" (w1)');
    expect(screen).toContain('monitor "CI watch" (m9)');
    rig.stdin.write("n");
    await settle();
    await rig.end();
  }, 15_000);

  it("swaps nothing, and records nothing, when the prompt cannot be drawn", async () => {
    const rig = await startRig({ liveWork: [monitorWork()], breakTerminalWrites: true });
    rig.fire(overTrigger("req:render-fail"));
    await waitFor(() => rig.logs.some((line) => line.includes("could not be shown")), "render failure reported");
    await settle(200);
    expect(rig.compactAttempts()).toBe(0);
    expect(rig.settledReceipts()).toEqual([]);
    expect(rig.receipts().some((receipt) => receipt.wouldMutate)).toBe(false);
    await rig.end();
  }, 15_000);

  it("swaps nothing, and records nothing, when the prompt is interrupted", async () => {
    // Held child output overflowed its cap: the panel is torn down under the
    // operator without an answer.
    const rig = await startRig({ liveWork: [monitorWork()], outputHoldCapBytes: 64 });
    rig.fire(overTrigger("req:interrupted"));
    await waitFor(() => rig.terminal().includes("live background work"), "confirmation on screen");
    rig.pty().emitData("x".repeat(4_096));
    await waitFor(() => rig.logs.some((line) => line.includes("the prompt was interrupted")), "interruption reported");
    await settle(200);
    expect(rig.compactAttempts()).toBe(0);
    expect(rig.settledReceipts()).toEqual([]);
    expect(rig.receipts().some((receipt) => receipt.wouldMutate)).toBe(false);
    await rig.end();
  }, 15_000);

  it("does not ask, and behaves exactly as before, without a terminal", async () => {
    // A one-shot launch has nobody to ask; the swap runs as it always has.
    const rig = await startRig({ interactive: false, liveWork: [monitorWork()] });
    rig.fire(overTrigger("req:headless"));
    await waitFor(() => rig.compactAttempts() === 1, "compact with no terminal");
    expect(rig.terminal()).not.toContain("live background work");
    await rig.end();
  }, 15_000);

  it("does not ask while the seam is under the trigger", async () => {
    const rig = await startRig({ liveWork: [monitorWork()] });
    rig.fire([
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "req:small",
        providerUsage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      { kind: "turn_settled", reason: "end_turn" },
    ]);
    await settle(200);
    expect(rig.terminal()).not.toContain("live background work");
    expect(rig.compactAttempts()).toBe(0);
    await rig.end();
  }, 15_000);

  it("does not ask mid-turn, only at the settled seam", async () => {
    const rig = await startRig({ liveWork: [monitorWork()] });
    rig.fire([
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "req:open",
        providerUsage: { input_tokens: 9_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    ]);
    await settle(200);
    expect(rig.terminal()).not.toContain("live background work");
    expect(rig.compactAttempts()).toBe(0);
    // The same turn settling does ask.
    rig.fire([{ kind: "turn_settled", reason: "end_turn" }]);
    await waitFor(() => rig.terminal().includes("live background work"), "confirmation at the settled seam");
    rig.stdin.write("n");
    await settle();
    await rig.end();
  }, 15_000);

  it("keeps the operator's own panel rather than clobbering it", async () => {
    const rig = await startRig({ liveWork: [monitorWork()] });
    // The operator opened the control panel (ctrl-]) and is typing.
    rig.stdin.write("\x1dstat");
    await settle(80);
    rig.fire(overTrigger("req:panel-busy"));
    await settle(200);
    expect(rig.compactAttempts()).toBe(0);
    expect(rig.terminal()).not.toContain("live background work");
    expect(rig.logs.some((line) => line.includes("the panel is busy"))).toBe(true);
    expect(rig.settledReceipts()).toEqual([]);
    expect(rig.receipts().some((receipt) => receipt.wouldMutate)).toBe(false);
    expect(rig.terminal()).toContain("long-horizon commands> stat");
    rig.stdin.write("\x03");
    await settle();
    await rig.end();
  }, 15_000);
});
