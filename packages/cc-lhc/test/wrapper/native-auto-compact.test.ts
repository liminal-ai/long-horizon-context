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
import { PANEL_TITLE } from "../../src/wrapper/panel-commands.js";
import { run } from "../../src/wrapper/run.js";
import { panelText } from "../helpers/panel-text.js";

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

  it("carries inherited values through untouched on both paths", () => {
    // Omission is not clearing: an inherited disable stays exactly as inherited,
    // which is why the wrapper cannot claim native auto-compact then runs.
    const inherited = { PATH: "/bin", DISABLE_AUTO_COMPACT: "1", DISABLE_COMPACT: "1" };
    const passthrough = nativeAutoCompactChildEnv(inherited, true);
    expect(passthrough).toEqual(inherited);

    const injected = nativeAutoCompactChildEnv({ PATH: "/bin", DISABLE_COMPACT: "1" }, false);
    expect(injected.DISABLE_COMPACT).toBe("1");
    expect(injected[NATIVE_AUTO_COMPACT_DISABLE_ENV]).toBe("1");
  });
});

interface FakePty {
  args: string[];
  env: Record<string, string>;
  written: string[];
  fireExit(code: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (arg: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  write(data: string): void;
  resize(): void;
}

function makeFakePty(args: string[], env: Record<string, string>): FakePty {
  const exitCbs: Array<(arg: { exitCode: number; signal?: number }) => void> = [];
  const written: string[] = [];
  return {
    args,
    env,
    written,
    fireExit(code: number) {
      for (const cb of exitCbs) cb({ exitCode: code });
    },
    onData: () => ({ dispose: () => {} }),
    onExit: (cb) => {
      exitCbs.push(cb);
      return { dispose: () => {} };
    },
    kill: () => {},
    write: (data: string) => {
      written.push(data);
    },
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
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > capMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

interface Live {
  spawned: FakePty[];
  logLines: string[];
  stdin: PassThrough;
  terminalOutput: string[];
  finish: () => Promise<number>;
}

/** Launch and keep the child alive so the Control Panel can be driven. */
async function launchLive(argv: string[]): Promise<Live> {
  const spawned: FakePty[] = [];
  const logLines: string[] = [];
  const terminalOutput: string[] = [];
  const stdin = fakeStream();
  const stdout = fakeStream();
  stdout.on("data", (chunk: Buffer | string) => terminalOutput.push(String(chunk)));
  mocks.captureFactory = () => scriptedCaptureSession({ drainSettled: async () => {} });
  const runPromise = run(argv, {
    claudeBin: "fake-claude",
    spawnPty: ((_file: string, args: string[], opts: { env: Record<string, string> }) => {
      const fake = makeFakePty(args, opts.env);
      spawned.push(fake);
      return fake as never;
    }) as never,
    stdin,
    stdout: stdout as never,
    stderr: fakeStream() as never,
    noInference: true,
    wrapperLog: {
      info: (m: string) => logLines.push(m),
      warn: (m: string) => logLines.push(m),
      warningCount: () => 0,
      path: "/tmp/fake.log",
    } as never,
  });
  await waitFor(() => spawned.length > 0, "child spawn");
  return {
    spawned,
    logLines,
    stdin: stdin as unknown as PassThrough,
    terminalOutput,
    finish: async () => {
      spawned[0]!.fireExit(0);
      return runPromise;
    },
  };
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

  it("passes --autocompact through, injects no disable, and records an anomaly stating only that", async () => {
    const { spawned, logLines } = await launch(["--autocompact", "500000"]);
    expect(spawned[0]!.env[NATIVE_AUTO_COMPACT_DISABLE_ENV]).toBeUndefined();
    // The user's flag is preserved exactly — never stripped or rewritten.
    expect(spawned[0]!.args).toContain("--autocompact");
    expect(spawned[0]!.args[spawned[0]!.args.indexOf("--autocompact") + 1]).toBe("500000");
    const anomaly = logLines.find((l) => l.includes("ANOMALY") && l.includes("--autocompact"));
    expect(anomaly).toBeDefined();
    // The notice reports the wrapper's own action, never Claude's resulting
    // behavior: inherited environment and settings are unobservable from here.
    expect(anomaly).toContain("did not inject");
    expect(anomaly).toMatch(/inherited environment and Claude settings still govern/i);
    expect(anomaly).not.toMatch(/stays enabled|is enabled|will (auto-?)?compact/i);
  });
});

describe("run: Control Panel advisory for an explicit --autocompact (AC-1.7)", () => {
  const savedHome = process.env.CC_LHC_HOME;
  const homes: string[] = [];
  const leader = Buffer.from([0x1d]);

  beforeEach(() => {
    mocks.captureFactory = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-lim144-home-"));
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

  it("Home shows one concise 'may run' advisory and Details explains the cause and the way back (TC-1.7a, TC-1.7b)", async () => {
    const live = await launchLive(["--autocompact", "500000"]);
    try {
      live.stdin.write(leader);
      await waitFor(() => panelText(live.terminalOutput.join("")).includes(PANEL_TITLE), "panel home");
      const home = panelText(live.terminalOutput.join(""));
      expect(home).toContain(
        "Claude native Compact may run before Smart Compact — explicit --autocompact on this launch (see /details)",
      );
      // Exactly one advisory row; the raw log anomaly is not repeated on Home.
      expect(home.match(/may run before Smart Compact/g)).toHaveLength(1);
      expect(home).not.toContain("ANOMALY");
      // It never claims native Compact is on.
      expect(home).not.toMatch(/native Compact (is |stays )?(on|enabled)|will (auto-?)?compact/i);

      live.terminalOutput.length = 0;
      live.stdin.write(Buffer.from("/details\r"));
      await waitFor(() => panelText(live.terminalOutput.join("")).includes("to restore"), "details rows");
      const details = panelText(live.terminalOutput.join(""));
      expect(details).toContain(
        "Claude native Compact may run before Smart Compact — explicit --autocompact on this launch",
      );
      expect(details).toContain("detected: launch argv carries `--autocompact 500000` before the -- boundary");
      expect(details).toContain("did not set DISABLE_AUTO_COMPACT=1 for this child");
      expect(details).toContain("not observed: whether Claude native Compact is enabled");
      expect(details).toContain("to restore: relaunch cc-lhc without --autocompact");
      expect(details).toContain("manual /compact stays available");
      expect(details).not.toContain("disabled for this child");
      live.stdin.write(leader);
    } finally {
      expect(await live.finish()).toBe(0);
    }
  }, 15_000);

  it("names the exact form the launch used, including =value and the bare flag", async () => {
    for (const [argv, evidence] of [
      [["--autocompact=auto"], "--autocompact=auto"],
      [["--autocompact"], "--autocompact"],
    ] as const) {
      const live = await launchLive([...argv]);
      try {
        live.stdin.write(leader);
        await waitFor(() => panelText(live.terminalOutput.join("")).includes(PANEL_TITLE), "panel home");
        live.stdin.write(Buffer.from("/details\r"));
        await waitFor(() => panelText(live.terminalOutput.join("")).includes("to restore"), "details rows");
        expect(panelText(live.terminalOutput.join(""))).toContain(
          `launch argv carries \`${evidence}\` before the -- boundary`,
        );
        live.stdin.write(leader);
      } finally {
        await live.finish();
      }
    }
  }, 20_000);

  it("without the flag, neither Home nor Details claims native auto-compact is on (TC-1.7c)", async () => {
    const live = await launchLive([]);
    try {
      live.stdin.write(leader);
      await waitFor(() => panelText(live.terminalOutput.join("")).includes(PANEL_TITLE), "panel home");
      const home = panelText(live.terminalOutput.join(""));
      expect(home).not.toMatch(/native Compact|--autocompact|may run|ANOMALY|WARNING|advisory/i);
      live.terminalOutput.length = 0;
      live.stdin.write(Buffer.from("/details\r"));
      await waitFor(() => panelText(live.terminalOutput.join("")).includes("Claude native Compact"), "details rows");
      const details = panelText(live.terminalOutput.join(""));
      expect(details).toContain("Claude native Compact: disabled for this child (DISABLE_AUTO_COMPACT=1)");
      expect(details).not.toMatch(/may run|to restore|detected:/);
      live.stdin.write(leader);
    } finally {
      expect(await live.finish()).toBe(0);
    }
  }, 15_000);

  it("the advisory is nonblocking: input reaches Claude untouched and no panel opens by itself (TC-1.7d)", async () => {
    const live = await launchLive(["--autocompact", "500000"]);
    try {
      // Give the wrapper a moment: nothing may be painted on the main screen
      // and no modal may open without the user's leader key.
      await new Promise((r) => setTimeout(r, 150));
      expect(live.terminalOutput.join("")).not.toContain(PANEL_TITLE);
      expect(live.terminalOutput.join("")).not.toMatch(/may run|ANOMALY|--autocompact/);

      // Typed input is forwarded to the child immediately — no acknowledgement gate.
      live.stdin.write(Buffer.from("hello claude\r"));
      await waitFor(() => live.spawned[0]!.written.join("").includes("hello claude\r"), "input forwarded");
      expect(live.terminalOutput.join("")).not.toContain(PANEL_TITLE);

      // Opening and closing the panel afterwards leaves input flowing.
      live.stdin.write(leader);
      await waitFor(
        () => panelText(live.terminalOutput.join("")).includes("may run before Smart Compact"),
        "advisory shown",
      );
      live.stdin.write(leader);
      await waitFor(() => live.terminalOutput.some((chunk) => chunk.includes("\u001b[?1049l")), "panel closed");
      live.stdin.write(Buffer.from("again\r"));
      await waitFor(() => live.spawned[0]!.written.join("").includes("again\r"), "input forwarded after panel");
    } finally {
      expect(await live.finish()).toBe(0);
    }
  }, 15_000);
});
