/**
 * Outcome coverage for LIM-94: sessions reach compact.
 *
 * These are not gate tests. Each one drives run() to a settled seam over the
 * trigger under a condition that used to suppress the compact, and asserts the
 * compact happened or reached its specified recovery. The named removed gates
 * are: observe-only, no-capture mode, input-during-turn, the 10K retry-growth
 * requirement, the 120-second cooldown, the receipt-database veto, and the
 * retrieval-descriptor readiness dependency.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatDurableReceipt } from "../../src/commands/context-mutation.js";
import { CONFIG_FALLBACK_NOTICE, formatConfigFallbackNotice } from "../../src/governor/config.js";
import { openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
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
  fireExit(code: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (arg: { exitCode: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  write(data: string): void;
  resize(): void;
}

function makeFakePty(pid: number, args: string[]): FakePty {
  const exitCbs: Array<(arg: { exitCode: number }) => void> = [];
  const fake: FakePty = {
    pid,
    args,
    fireExit(code: number) {
      for (const cb of exitCbs) cb({ exitCode: code });
    },
    onData: (cb) => {
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
    write: () => {},
    resize: () => {},
  };
  return fake;
}

function sdkForCapture(onPreview: () => void) {
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
        onPreview();
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
        value: { threadId: "th_auto", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
      })),
    },
    intakeStream: { messageEvents: async () => ({ ok: true, value: { events: [] } }) },
  };
}

type Health = { phase: "binding" | "ready" | "degraded" | "closed"; generation: number };

/** A capture session whose readiness the test controls. */
function scriptedCapture(sdk: unknown, health: () => Health): CaptureSession {
  const stats = { ...emptyCaptureStats(), threadId: "th_auto" };
  return {
    stats,
    getCommandContext: () => ({
      stats,
      sdk: sdk as Lhc,
      threadRef: { threadId: "th_auto", registryPath: "/tmp/reg.sqlite" },
      captureDegraded: health().phase === "degraded",
      captureGeneration: health().generation,
      capturePhase: health().phase,
    }),
    getRolloutInfo: () => ({ path: "/tmp/old-session.jsonl", sessionId: "old-session" }),
    isTurnOpen: () => false,
    isCaptureHealthy: () => health().phase === "ready",
    isCaptureReady: () => health().phase === "ready",
    getCaptureHealth: () => ({
      generation: health().generation,
      phase: health().phase,
      reasons: [],
      reasonCounts: {},
      durableLineOffset: 0,
    }),
    getCaptureGeneration: () => health().generation,
    getLiveAsyncWork: () => [],
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

/**
 * Receipts whose automatic operation actually CONCLUDED. Every receipt is
 * born with an outcome (`deferred_open_turn`, `scheduled`, `not_applicable`),
 * so "has an outcome" observes nothing; only a claimed operation's own end
 * states prove the flight was released.
 */
const OPERATION_CONCLUDED = new Set([
  "mutation_partial",
  "mutation_refused",
  "mutation_noop",
  "handoff_success",
  "handoff_cancelled",
  "handoff_replacement_nonviable",
]);
function operationsConcluded(dbPath: string): number {
  const receipts = openGovernorReceiptStore(dbPath);
  try {
    return receipts.listAll().filter((r) => OPERATION_CONCLUDED.has(r.handoffOutcome?.kind ?? "")).length;
  } finally {
    receipts.close();
  }
}

function policy(over: Record<string, unknown> = {}) {
  const base = {
    lowerBoundTokens: 1_000,
    upperBoundTokens: 5_000,
    profile: "default",
    nativeCompactMode: "emergency_backstop" as const,
    nativeBackstopTokens: 1_000_000,
    pruneEnabled: false,
    pruneThresholdTokens: null,
    pruneTargetTokens: null,
    minRunwayTokens: 100,
    ...over,
  };
  return {
    policy: base,
    sources: Object.fromEntries(Object.keys(base).map((k) => [k, "session"])) as never,
    fallbacks: [],
  };
}

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

const dirs: string[] = [];

interface Rig {
  runPromise: Promise<number>;
  pty: FakePty;
  stdin: PassThrough;
  fire: (signals: LifecycleSignal[]) => void;
  compacts: () => number;
  receiptDb: string;
  logs: string[];
  stderrText: () => string;
  end: () => Promise<number>;
}

async function startRig(options: {
  resolvedContextPolicy?: ReturnType<typeof policy>;
  health?: () => Health;
  breakReceiptStore?: boolean;
}): Promise<Rig> {
  let compacts = 0;
  const logs: string[] = [];
  const sdk = sdkForCapture(() => {
    compacts += 1;
  });
  const health = options.health ?? (() => ({ phase: "ready" as const, generation: 1 }));
  let sink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
  mocks.captureFactory = (opts) => {
    const session = scriptedCapture(sdk, health);
    if (opts.onLifecycle !== undefined) sink = opts.onLifecycle;
    return session;
  };
  const ptys: FakePty[] = [];
  const dir = mkdtempSync(join(tmpdir(), "cc-lhc-reach-"));
  dirs.push(dir);
  // A path whose parent is a regular file: the store cannot be opened at all.
  const fileAsDir = join(dir, "not-a-dir");
  writeFileSync(fileAsDir, "x");
  const stderrChunks: string[] = [];
  const stdin = fakeStream();
  const stderr = fakeStream();
  (stderr as unknown as PassThrough).on("data", (c: Buffer) => stderrChunks.push(c.toString()));

  const runPromise = run([], {
    claudeBin: "fake-claude",
    spawnPty: ((_file: string, args: string[]) => {
      const fake = makeFakePty(9500 + ptys.length, args);
      ptys.push(fake);
      return fake as never;
    }) as never,
    stdin,
    stdout: fakeStream(),
    stderr,
    noInference: true,
    resolvedContextPolicy: (options.resolvedContextPolicy ?? policy()) as never,
    governorReceiptDbPath:
      options.breakReceiptStore === true ? join(fileAsDir, "cc-lhc.sqlite") : join(dir, "r.sqlite"),
    wrapperLog: {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      warningCount: () => 0,
      path: "/tmp/fake.log",
    } as never,
  });

  await waitFor(() => sink !== undefined, "capture lifecycle sink");
  sink!(BOUND);
  return {
    runPromise,
    pty: ptys[0]!,
    stdin: stdin as unknown as PassThrough,
    fire: (signals) => sink!(signals),
    compacts: () => compacts,
    receiptDb: join(dir, "r.sqlite"),
    logs,
    stderrText: () => stderrChunks.join(""),
    end: async () => {
      ptys[ptys.length - 1]!.fireExit(0);
      return runPromise;
    },
  };
}

describe("a session over the trigger reaches compact", () => {
  const savedHome = process.env.CC_LHC_HOME;
  beforeEach(() => {
    mocks.captureFactory = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-reach-home-"));
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

  it("default configuration: a settled seam over the trigger compacts", async () => {
    const rig = await startRig({});
    rig.fire(overTrigger("req:default"));
    await waitFor(() => rig.compacts() > 0, "automatic compact");
    await rig.end();
  }, 15_000);

  it("input typed during the turn does not veto the compact at that seam", async () => {
    const rig = await startRig({});
    // Bytes reaching Claude during the open turn bump the input epoch. They
    // belong to the next turn; they cannot invalidate settled history.
    rig.fire([{ kind: "turn_opened", reason: "user_prompt" }]);
    rig.stdin.write("keystrokes typed mid-turn\r");
    await new Promise((r) => setTimeout(r, 50));
    rig.fire([
      {
        kind: "sampling_observed",
        samplingId: "req:typed",
        providerUsage: { input_tokens: 9_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      { kind: "turn_settled", reason: "end_turn" },
    ]);
    await waitFor(() => rig.compacts() > 0, "compact despite typed-ahead input");
    await rig.end();
  }, 15_000);

  it("an unwritable receipt database does not suppress the compact", async () => {
    const rig = await startRig({ breakReceiptStore: true });
    rig.fire(overTrigger("req:noreceipt"));
    await waitFor(() => rig.compacts() > 0, "compact with no receipt store");
    expect(rig.logs.some((l) => l.includes("in-memory receipt"))).toBe(true);
    await rig.end();
  }, 15_000);

  it("repeated seams with no pressure growth keep compacting — no 10K retry toll, no cooldown", async () => {
    const rig = await startRig({});
    rig.fire(overTrigger("req:a"));
    await waitFor(() => rig.compacts() >= 1, "first compact");
    // The compact call is the start of the automatic operation, not its end:
    // a seam fired while the operation still owns the flight is coalesced by
    // design ("no second mutation"), not replayed. The claim under test is
    // the governor's (no toll, no cooldown between seams), so wait for the
    // first operation's CONCLUDING outcome — attached synchronously just
    // before the flight is released — before the next seam.
    await waitFor(() => operationsConcluded(rig.receiptDb) >= 1, "first operation conclusion");
    // Identical pressure, immediately after: nothing to earn, nothing to wait out.
    rig.fire(overTrigger("req:b"));
    await waitFor(() => rig.compacts() >= 2, "second compact at the same pressure");
    await rig.end();
  }, 20_000);

  it("catching-up capture defers once, then compacts as soon as capture is ready", async () => {
    let phase: Health["phase"] = "binding";
    const rig = await startRig({ health: () => ({ phase, generation: 1 }) });

    rig.fire(overTrigger("req:binding"));
    await waitFor(
      () => rig.logs.some((l) => l.includes("capture_catching_up")),
      "the seam to route to capture catch-up",
    );
    expect(rig.compacts()).toBe(0);

    // Capture finishes catching up. The skipped seam is re-evaluated — no new
    // turn, no timer, no operator action.
    phase = "ready";
    rig.fire([{ kind: "session_bound", sessionId: "old-session" }]);
    await waitFor(() => rig.compacts() > 0, "catch-up evaluation to compact");
    await rig.end();
  }, 20_000);

  it("degraded capture rebuilds from the transcript, then compacts", async () => {
    let phase: Health["phase"] = "degraded";
    const rig = await startRig({ health: () => ({ phase, generation: 1 }) });

    rig.fire(overTrigger("req:degraded"));
    await waitFor(
      () => rig.logs.some((l) => l.includes("capture rebuild: re-reading transcript")),
      "capture rebuild from the persisted transcript",
    );
    expect(rig.compacts()).toBe(0);

    phase = "ready";
    rig.fire([{ kind: "session_bound", sessionId: "old-session" }]);
    await waitFor(() => rig.compacts() > 0, "compact after capture caught up");
    await rig.end();
  }, 20_000);

  it("a missing provider count compacts from the last known count plus the growth estimate", async () => {
    const rig = await startRig({});
    rig.fire([
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "req:good",
        providerUsage: { input_tokens: 4_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      { kind: "turn_settled", reason: "end_turn" },
    ]);
    // Below trigger: nothing yet.
    await new Promise((r) => setTimeout(r, 150));
    expect(rig.compacts()).toBe(0);

    // Next turn's usage line is unreadable. The 4,000 stands, and the growth
    // measured on top of it carries pressure over the trigger.
    rig.fire([
      { kind: "turn_opened", reason: "user_prompt" },
      { kind: "sampling_observed", samplingId: "req:broken" },
      { kind: "post_measurement_estimate", tokens: 2_000, source: "host_canonical_payload_byte_estimate", mode: "add" },
      { kind: "turn_settled", reason: "end_turn" },
    ]);
    await waitFor(() => rig.compacts() > 0, "compact on the last known count plus growth");
    await rig.end();
  }, 20_000);

  it("no configuration stops it: a smuggled autoCompact:false still compacts (TC-1.5d)", async () => {
    const smuggled = { ...policy(), policy: { ...policy().policy, autoCompact: false } } as never;
    const rig = await startRig({ resolvedContextPolicy: smuggled });
    rig.fire(overTrigger("req:smuggled"));
    await waitFor(() => rig.compacts() > 0, "compact despite a foreign off field");
    expect(rig.logs.some((l) => l.includes("policy_disabled"))).toBe(false);
    await rig.end();
  }, 15_000);

  it("invalid configuration keeps compacting and says so at startup and in the compact message", async () => {
    const fallbacks = [
      { origin: "project config /work/.cc-lhc.json", field: null, detail: 'unknown field "x" ignored' },
    ];
    const rig = await startRig({
      resolvedContextPolicy: { ...policy(), fallbacks } as never,
    });
    // Immediate surfacing: startup output and the wrapper log, before any compact.
    expect(rig.stderrText()).toContain(CONFIG_FALLBACK_NOTICE);
    expect(rig.logs.some((l) => l.includes(CONFIG_FALLBACK_NOTICE))).toBe(true);

    rig.fire(overTrigger("req:badcfg"));
    await waitFor(() => rig.compacts() > 0, "compact under fallback configuration");
    await rig.end();
  }, 15_000);
});

describe("the compact message carries host notices", () => {
  it("includes the configuration-fallback notice in the durable receipt", () => {
    const notices = formatConfigFallbackNotice([
      {
        origin: "user config /home/u/.config/cc-lhc/config.json",
        field: "pruneEnabled",
        detail: "pruneEnabled must be a boolean",
      },
    ]);
    const receipt = formatDurableReceipt("auto_compact", { origin: "auto", viewTokens: 1_000 }, notices);
    expect(receipt).toContain("[lhc compact:auto]");
    expect(receipt).toContain(CONFIG_FALLBACK_NOTICE);
    expect(receipt).toContain("pruneEnabled");
  });

  it("says nothing extra when configuration was usable", () => {
    const receipt = formatDurableReceipt("auto_compact", { origin: "auto", viewTokens: 1_000 }, []);
    expect(receipt).not.toContain(CONFIG_FALLBACK_NOTICE);
    expect(receipt.split("\n")).toHaveLength(1);
  });
});
