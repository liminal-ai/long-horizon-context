/**
 * TC-3.7a: once Claude owns the terminal, routine status, warnings, and state
 * changes put zero wrapper bytes on the screen — the terminal receives exactly
 * what the child wrote, byte for byte.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import { emptyCaptureStats } from "../../src/stats.js";
import { firstLoadMarkerPath, markShown, ONBOARDING_VERSION } from "../../src/wrapper/first-load.js";
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
  emit(data: string): void;
  fireExit(code: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (arg: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  write(data: string): void;
  resize(): void;
}

function makeFakePty(): FakePty {
  const exitCbs: Array<(arg: { exitCode: number; signal?: number }) => void> = [];
  const dataCbs: Array<(data: string) => void> = [];
  return {
    emit: (data) => {
      for (const cb of dataCbs) cb(data);
    },
    fireExit: (code) => {
      for (const cb of exitCbs) cb({ exitCode: code });
    },
    onData: (cb) => {
      dataCbs.push(cb);
      return { dispose: () => {} };
    },
    onExit: (cb) => {
      exitCbs.push(cb);
      return { dispose: () => {} };
    },
    kill: () => {},
    write: () => {},
    resize: () => {},
  };
}

function ttyStream(): NodeJS.ReadStream & NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & NodeJS.WriteStream;
  Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  Object.defineProperty(stream, "columns", { value: 100, configurable: true });
  Object.defineProperty(stream, "rows", { value: 30, configurable: true });
  (stream as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};
  return stream;
}

async function waitFor(condition: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > capMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

function settledAt(total: number, id: string): LifecycleSignal[] {
  return [
    { kind: "turn_opened", reason: "user_prompt" },
    {
      kind: "sampling_observed",
      samplingId: id,
      providerUsage: { input_tokens: total, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    { kind: "turn_settled", reason: "end_turn" },
  ];
}

describe("TC-3.7a terminal silence after Claude owns the screen", () => {
  const savedHome = process.env.CC_LHC_HOME;
  let home = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-lhc-silence-"));
    process.env.CC_LHC_HOME = home;
    markShown(firstLoadMarkerPath(home), ONBOARDING_VERSION);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.captureFactory = null;
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("routine settles, a native summary, degraded capture, warnings, and a policy notice add no bytes: stdout is exactly the child's bytes", async () => {
    const chunks: string[] = [];
    const warnings: string[] = [];
    const stdin = ttyStream();
    const stdout = ttyStream();
    stdout.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
    let lifecycle: ((signals: readonly LifecycleSignal[]) => void) | undefined;
    let pty: FakePty | undefined;
    mocks.captureFactory = (opts) => {
      lifecycle = opts.onLifecycle;
      const stats = { ...emptyCaptureStats(), threadId: "th_quiet" };
      return {
        stats,
        getCommandContext: () => ({
          captureDisabled: false,
          stats,
          sdk: { drainSettled: async () => {} } as unknown as Lhc,
          threadRef: { threadId: "th_quiet", registryPath: "/tmp/reg.sqlite" },
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
        getLiveAsyncWork: () => [],
        stop: vi.fn(async () => {}),
      } as unknown as CaptureSession;
    };
    const runPromise = run([], {
      claudeBin: "fake-claude",
      spawnPty: (() => {
        pty = makeFakePty();
        return pty as never;
      }) as never,
      stdin,
      stdout: stdout as never,
      stderr: ttyStream() as never,
      noInference: true,
      governorReceiptDbPath: join(home, "receipts.sqlite"),
      wrapperLog: {
        info: () => {},
        warn: (m: string) => warnings.push(m),
        warningCount: () => warnings.length,
        path: "/tmp/fake.log",
      } as never,
    });
    await waitFor(() => pty !== undefined && lifecycle !== undefined, "child + capture");
    const child = pty!;
    const signals = lifecycle!;

    let expected = "";
    const paint = (text: string): void => {
      expected += text;
      child.emit(text);
    };

    paint("\x1b[2J\x1b[HClaude screen line 1\r\n");
    // Routine status: settled turns below the trigger, a big one still below, and back down.
    signals(settledAt(1_000, "req:1"));
    paint("assistant: hello\r\n");
    signals(settledAt(120_000, "req:2"));
    signals(settledAt(2_000, "req:3"));
    // A native Compact summary observed on the managed session (loud in the panel/log only).
    signals([{ kind: "native_compact_observed", summaryPreview: "summary" } as LifecycleSignal]);
    // Capture degrades and recovers.
    signals([{ kind: "capture_degraded", reason: "watcher_gap" } as LifecycleSignal]);
    paint("\r\x1b[2Kstill Claude\r\n");
    // Warnings and a policy-source notice go to the wrapper log.
    warnings.push("cc-lhc: synthetic warning");
    await new Promise((r) => setTimeout(r, 150));

    expect(chunks.join("")).toBe(expected);
    expect(chunks.join("")).not.toContain("[cc-lhc]");
    expect(warnings.join("\n")).toContain("ANOMALY: Claude native Compact ran on a managed session");

    child.fireExit(0);
    expect(await runPromise).toBe(0);
  }, 15_000);

  it("the wrapper source has no writer left that puts a [cc-lhc] line or a carriage-return repaint on the live screen", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../../src/wrapper/run.ts"), "utf8");
    // Every stdout write is the panel renderer, the alt-screen guard, held child
    // bytes, or cursor restoration at exit.
    for (const line of source.split("\n").filter((row) => row.includes("stdout.write("))) {
      expect(line, line).not.toMatch(/\[cc-lhc\]|\\r\\n/);
    }
    expect(source).not.toContain("writeWrapperLine");
  });
});
