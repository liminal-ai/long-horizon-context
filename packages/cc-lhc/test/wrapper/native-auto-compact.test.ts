/**
 * Native auto-compact launch policy (LIM-95, R8 addendum + R12).
 *
 * Outcome tests: what environment each managed Claude child is actually spawned
 * with, and what the wrapper records when the user supplies their own flag.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import { emptyCaptureStats } from "../../src/stats.js";
import {
  argvSuppliesNativeAutocompact,
  NATIVE_AUTO_COMPACT_DISABLE_ENV,
  nativeAutoCompactChildEnv,
} from "../../src/wrapper/native-auto-compact.js";
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

describe("native auto-compact argv detection", () => {
  it("recognizes both the space and the = form", () => {
    expect(argvSuppliesNativeAutocompact(["--autocompact", "500000"])).toBe(true);
    expect(argvSuppliesNativeAutocompact(["--autocompact=auto"])).toBe(true);
  });

  it("does not recognize a plain launch", () => {
    expect(argvSuppliesNativeAutocompact([])).toBe(false);
    expect(argvSuppliesNativeAutocompact(["--model", "opus"])).toBe(false);
  });

  it("stops at the passthrough boundary", () => {
    expect(argvSuppliesNativeAutocompact(["--", "--autocompact", "500000"])).toBe(false);
  });
});

describe("native auto-compact child environment", () => {
  it("disables native auto-compact by default without touching manual /compact", () => {
    const env = nativeAutoCompactChildEnv({ PATH: "/bin" }, false);
    expect(env[NATIVE_AUTO_COMPACT_DISABLE_ENV]).toBe("1");
    expect(env.DISABLE_COMPACT).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  it("omits the disable when the user supplied --autocompact", () => {
    const env = nativeAutoCompactChildEnv({ PATH: "/bin" }, true);
    expect(env[NATIVE_AUTO_COMPACT_DISABLE_ENV]).toBeUndefined();
    expect(env.DISABLE_COMPACT).toBeUndefined();
  });
});

interface FakePty {
  args: string[];
  env: Record<string, string>;
  fireExit(code: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (arg: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  write(data: string): void;
  resize(): void;
}

function makeFakePty(args: string[], env: Record<string, string>): FakePty {
  const exitCbs: Array<(arg: { exitCode: number; signal?: number }) => void> = [];
  return {
    args,
    env,
    fireExit(code: number) {
      for (const cb of exitCbs) cb({ exitCode: code });
    },
    onData: () => ({ dispose: () => {} }),
    onExit: (cb) => {
      exitCbs.push(cb);
      return { dispose: () => {} };
    },
    kill: () => {},
    write: () => {},
    resize: () => {},
  };
}

function scriptedCaptureSession(sdk: unknown): CaptureSession {
  const stats = { ...emptyCaptureStats(), threadId: "th_lim95" };
  return {
    stats,
    getCommandContext: () => ({
      captureDisabled: false,
      stats,
      sdk: sdk as Lhc,
      threadRef: { threadId: "th_lim95", registryPath: "/tmp/reg.sqlite" },
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

async function launch(argv: string[]): Promise<{ spawned: FakePty[]; logLines: string[] }> {
  const spawned: FakePty[] = [];
  const logLines: string[] = [];
  mocks.captureFactory = () => scriptedCaptureSession({ drainSettled: async () => {} });

  const runPromise = run(argv, {
    claudeBin: "fake-claude",
    spawnPty: ((_file: string, args: string[], opts: { env: Record<string, string> }) => {
      const fake = makeFakePty(args, opts.env);
      spawned.push(fake);
      return fake as never;
    }) as never,
    stdin: fakeStream(),
    stdout: fakeStream() as never,
    stderr: fakeStream() as never,
    noInference: true,
    wrapperLog: {
      info: (m: string) => logLines.push(m),
      warn: (m: string) => logLines.push(m),
      warningCount: () => 0,
      path: "/tmp/fake.log",
    } as never,
  });

  for (let attempt = 0; attempt < 400 && spawned.length === 0; attempt += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (spawned.length === 0) throw new Error("child was never spawned");
  spawned[0]!.fireExit(0);
  await runPromise;
  return { spawned, logLines };
}

describe("run: managed Claude child launch environment", () => {
  const savedHome = process.env.CC_LHC_HOME;
  const homes: string[] = [];

  beforeEach(() => {
    mocks.captureFactory = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-lim95-home-"));
    homes.push(home);
    process.env.CC_LHC_HOME = home;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.captureFactory = null;
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const dir of homes.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("disables native auto-compact for a normal managed launch", async () => {
    const { spawned } = await launch([]);
    expect(spawned[0]!.env[NATIVE_AUTO_COMPACT_DISABLE_ENV]).toBe("1");
    // Manual /compact must survive: DISABLE_COMPACT is never injected.
    expect(spawned[0]!.env.DISABLE_COMPACT).toBeUndefined();
    // No backstop argv is synthesized any more.
    expect(spawned[0]!.args).not.toContain("--autocompact");
  });

  it("omits the disable and records an anomaly when the user supplies --autocompact", async () => {
    const { spawned, logLines } = await launch(["--autocompact", "500000"]);
    expect(spawned[0]!.env[NATIVE_AUTO_COMPACT_DISABLE_ENV]).toBeUndefined();
    // The user's flag is preserved exactly — never stripped or rewritten.
    expect(spawned[0]!.args).toContain("--autocompact");
    expect(spawned[0]!.args[spawned[0]!.args.indexOf("--autocompact") + 1]).toBe("500000");
    expect(logLines.some((l) => l.includes("ANOMALY") && l.includes("--autocompact"))).toBe(true);
  });
});
