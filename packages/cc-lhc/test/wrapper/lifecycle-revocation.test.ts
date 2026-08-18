/**
 * Sticky dual-degradation (non-fatal) and fatal ready-revocation exit seam.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import { type DescriptorIo, loadDescriptor } from "../../src/runtime/descriptor.js";
import type { ProbeProcessIdentity } from "../../src/runtime/process-identity.js";
import { emptyCaptureStats } from "../../src/stats.js";
import { run } from "../../src/wrapper/run.js";
import { indeterminateResult, selfOnlyProbe } from "../helpers/identity.js";

const runMocks = vi.hoisted(() => ({
  captureFactory: null as ((opts: CaptureSessionDeps) => CaptureSession) | null,
}));

vi.mock("../../src/intake/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intake/session.js")>();
  return {
    ...actual,
    startCaptureSession: (opts: CaptureSessionDeps = {}) => {
      if (runMocks.captureFactory !== null) return runMocks.captureFactory(opts);
      return actual.startCaptureSession(opts);
    },
  };
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, capMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

function fakeStreams() {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.defineProperty(stdout, "columns", { value: 80, configurable: true });
  Object.defineProperty(stdout, "rows", { value: 24, configurable: true });
  Object.defineProperty(stdout, "isTTY", { value: true, configurable: true });
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.defineProperty(stderr, "isTTY", { value: false, configurable: true });
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
  (stdin as unknown as { setRawMode: (v: boolean) => void }).setRawMode = () => {};
  return { stdin, stdout, stderr };
}

function baseIo(
  opts: { failWrite?: () => boolean; failUnlink?: () => boolean; readIdentity?: ProbeProcessIdentity } = {},
): DescriptorIo {
  return {
    writeFile: (p, d, m) => {
      if (opts.failWrite?.()) throw new Error("write fail");
      writeFileSync(p, d, { encoding: "utf8", mode: m });
    },
    readFile: (p) => readFileSync(p, "utf8"),
    rename: (from, to) => {
      if (opts.failWrite?.()) throw new Error("rename fail");
      renameSync(from, to);
    },
    unlink: (p) => {
      if (opts.failUnlink?.()) throw new Error("unlink fail");
      unlinkSync(p);
    },
    exists: existsSync,
    mkdir: (p) => mkdirSync(p, { recursive: true, mode: 0o700 }),
    chmod: chmodSync,
    readProcessIdentity: opts.readIdentity ?? selfOnlyProbe(),
    nowMs: () => Date.now(),
    randomId: () => `lc-${Math.random().toString(16).slice(2, 10)}`,
    pid: process.pid,
  };
}

type MutableHealth = {
  generation: number;
  phase: "ready" | "degraded" | "opening";
  reasons: string[];
  reasonCounts: Record<string, number>;
  durableLineOffset: number;
};

function makeLifecycleCapture(opts: {
  onLifecycleRef: { current?: CaptureSessionDeps["onLifecycle"] };
  health: MutableHealth;
  stopImpl?: () => Promise<void>;
  readyPath?: string;
}): CaptureSession {
  const stats = { ...emptyCaptureStats(), threadId: "th_life" };
  return {
    stats,
    getCommandContext: () => ({
      stats,
      sdk: {
        drainSettled: async () => {},
        intakeStream: { messageEvents: async () => ({ ok: true, value: { events: [] } }) },
      },
      threadRef: { threadId: "th_life", registryPath: "/tmp/registry.sqlite" },
      captureDegraded: opts.health.phase === "degraded",
      captureGeneration: opts.health.generation,
      capturePhase: opts.health.phase,
    }),
    getRolloutInfo: () => ({
      path: opts.readyPath ?? "/tmp/life.jsonl",
      sessionId: "life-session",
    }),
    isTurnOpen: () => false,
    isCaptureHealthy: () => opts.health.phase === "ready",
    isCaptureReady: () => opts.health.phase === "ready",
    getCaptureHealth: () => ({
      ...opts.health,
      reasons: [...opts.health.reasons],
      reasonCounts: { ...opts.health.reasonCounts },
    }),
    getCaptureGeneration: () => opts.health.generation,
    stop: vi.fn(opts.stopImpl ?? (async () => {})),
  } as unknown as CaptureSession;
}

describe("wrapper sticky degradation + fatal revoke", () => {
  const savedHome = process.env.CC_LHC_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-lhc-life-"));
    process.env.CC_LHC_HOME = home;
    runMocks.captureFactory = null;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    runMocks.captureFactory = null;
    vi.restoreAllMocks();
  });

  it("two distinct degradation signals stay non-fatal; Claude stays alive; descriptor non-ready", async () => {
    const warns: string[] = [];
    const forceExit = vi.fn();
    const health: MutableHealth = {
      generation: 1,
      phase: "ready",
      reasons: [],
      reasonCounts: {},
      durableLineOffset: 0,
    };
    const onLifecycleRef: { current?: CaptureSessionDeps["onLifecycle"] } = {};
    let ptyKilled = false;
    let onData: ((d: string) => void) | undefined;
    let onExit: ((e: { exitCode: number; signal?: number }) => void) | undefined;

    runMocks.captureFactory = (deps) => {
      onLifecycleRef.current = deps.onLifecycle;
      return makeLifecycleCapture({ onLifecycleRef, health, readyPath: join(home, "r.jsonl") });
    };

    const { stdin, stdout, stderr } = fakeStreams();
    const runPromise = run(["--session-id", "11111111-1111-1111-1111-111111111111", "-p", "sticky"], {
      noInference: true,
      claudeBin: "/bin/true",
      forceWrapperExit: forceExit,
      descriptorIo: baseIo(),
      spawnPty: (() =>
        ({
          pid: 424242,
          write() {},
          resize() {},
          kill() {
            ptyKilled = true;
          },
          onData(cb: (d: string) => void) {
            onData = cb;
          },
          onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
            onExit = cb;
          },
        }) as never) as typeof import("@lydell/node-pty").spawn,
      stdin,
      stdout,
      stderr,
      wrapperLog: {
        path: join(home, "w.log"),
        info() {},
        warn(msg: string) {
          warns.push(msg);
        },
        warningCount: () => warns.length,
      },
    });

    await waitFor(() => onLifecycleRef.current !== undefined, "lifecycle hook");
    // Publish ready via session_bound
    onLifecycleRef.current?.([{ kind: "session_bound", sessionId: "life-session" }]);
    await sleep(30);

    // First degradation reason
    health.phase = "degraded";
    health.reasons = ["watcher_gap"];
    health.reasonCounts = { watcher_gap: 1 };
    onLifecycleRef.current?.([{ kind: "capture_degraded", reason: "watcher_gap", generation: 1 }]);
    await sleep(20);

    // Second distinct reason — must NOT fatal (was degraded→degraded throw)
    health.reasons = ["watcher_gap", "attribution_mismatch"];
    health.reasonCounts = { watcher_gap: 1, attribution_mismatch: 1 };
    onLifecycleRef.current?.([{ kind: "capture_degraded", reason: "attribution_mismatch", generation: 1 }]);
    await sleep(30);

    expect(forceExit).not.toHaveBeenCalled();
    expect(ptyKilled).toBe(false);
    expect(warns.some((w) => w.includes("watcher_gap"))).toBe(true);
    expect(warns.some((w) => w.includes("attribution_mismatch"))).toBe(true);
    expect(warns.some((w) => /FATAL/i.test(w))).toBe(false);
    // Capture health still surfaces both reasons
    const cap = runMocks.captureFactory;
    void cap;
    expect(health.reasons).toEqual(["watcher_gap", "attribution_mismatch"]);

    // Descriptor path should not be loadable as ready (revoked to absent or degraded)
    const runtimeDir = join(home, "runtime");
    if (existsSync(runtimeDir)) {
      const { readdirSync } = await import("node:fs");
      for (const name of readdirSync(runtimeDir)) {
        if (!name.endsWith(".json")) continue;
        const loaded = loadDescriptor(join(runtimeDir, name), baseIo());
        if (loaded.ok) {
          expect(loaded.descriptor.state).not.toBe("ready");
        }
      }
    }

    // Clean exit of fake child
    onExit?.({ exitCode: 0 });
    const code = await runPromise;
    expect(code).toBe(0);
    expect(forceExit).not.toHaveBeenCalled();
    void onData;
  }, 15_000);

  it("fatal revoke: forceWrapperExit called promptly without awaiting capture stop", async () => {
    const forceExit = vi.fn();
    const warns: string[] = [];
    const health: MutableHealth = {
      generation: 1,
      phase: "ready",
      reasons: [],
      reasonCounts: {},
      durableLineOffset: 0,
    };
    const onLifecycleRef: { current?: CaptureSessionDeps["onLifecycle"] } = {};
    let failRevoke = false;
    let stopEntered = false;
    let stopFinished = false;
    let killThrew = false;
    let restoredRaw = false;
    let onExit: ((e: { exitCode: number; signal?: number }) => void) | undefined;

    const dIo = baseIo({
      failWrite: () => failRevoke,
      failUnlink: () => failRevoke,
    });

    runMocks.captureFactory = (deps) => {
      onLifecycleRef.current = deps.onLifecycle;
      return makeLifecycleCapture({
        onLifecycleRef,
        health,
        readyPath: join(home, "r.jsonl"),
        stopImpl: async () => {
          stopEntered = true;
          // Hold forever if awaited — fatal path must not wait.
          await new Promise<void>(() => {});
          stopFinished = true;
        },
      });
    };

    const { stdin, stdout, stderr } = fakeStreams();
    const origSetRaw = (stdin as unknown as { setRawMode: (v: boolean) => void }).setRawMode;
    (stdin as unknown as { setRawMode: (v: boolean) => void }).setRawMode = (v: boolean) => {
      if (v === false) restoredRaw = true;
      origSetRaw?.(v);
    };

    const runPromise = run(["--session-id", "11111111-1111-1111-1111-111111111111", "-p", "fatal"], {
      noInference: true,
      claudeBin: "/bin/true",
      forceWrapperExit: forceExit,
      descriptorIo: dIo,
      spawnPty: (() =>
        ({
          pid: 434343,
          write() {},
          resize() {},
          kill() {
            killThrew = true;
            throw new Error("kill failed");
          },
          onData() {},
          onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
            onExit = cb;
          },
        }) as never) as typeof import("@lydell/node-pty").spawn,
      stdin,
      stdout,
      stderr,
      wrapperLog: {
        path: join(home, "w.log"),
        info() {},
        warn(msg: string) {
          warns.push(msg);
        },
        warningCount: () => warns.length,
      },
    });

    await waitFor(() => onLifecycleRef.current !== undefined, "lifecycle");
    onLifecycleRef.current?.([{ kind: "session_bound", sessionId: "life-session" }]);
    await sleep(40);

    // Ready file must exist before we arm revoke failure
    const runtimeDir = join(home, "runtime");
    await waitFor(() => {
      if (!existsSync(runtimeDir)) return false;
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      return readdirSync(runtimeDir).some((n) => n.endsWith(".json"));
    }, "ready descriptor");

    const { readdirSync } = await import("node:fs");
    const descName = readdirSync(runtimeDir).find((n) => n.endsWith(".json"))!;
    const descPath = join(runtimeDir, descName);
    const pre = loadDescriptor(descPath, baseIo());
    expect(pre.ok).toBe(true);
    if (pre.ok) expect(pre.descriptor.state).toBe("ready");

    failRevoke = true;
    health.phase = "degraded";
    health.reasons = ["fatal_test_reason"];
    const t0 = Date.now();
    onLifecycleRef.current?.([{ kind: "capture_degraded", reason: "fatal_test_reason", generation: 1 }]);
    await waitFor(() => forceExit.mock.calls.length > 0, "forceWrapperExit", 2_000);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(500);
    expect(forceExit).toHaveBeenCalledWith(1);
    expect(killThrew).toBe(true);
    expect(stopEntered).toBe(false);
    expect(stopFinished).toBe(false);
    expect(restoredRaw).toBe(true);
    expect(warns.some((w) => /FATAL/i.test(w))).toBe(true);

    // Stale-owner simulation: identity unestablishable → load refuses even if file remains ready
    const deadIo = baseIo({
      readIdentity: () => indeterminateResult("native_error: identity source unreadable"),
    });
    const after = loadDescriptor(descPath, deadIo);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toMatch(/stale|identity/i);

    // Unblock run Promise (forceWrapperExit also resolves run with 1)
    const code = await Promise.race([runPromise, sleep(200).then(() => -99)]);
    expect(code).toBe(1);
    void onExit;
  }, 15_000);

  it("child-exit revoke failure also schedules forceWrapperExit without drain", async () => {
    const forceExit = vi.fn();
    const health: MutableHealth = {
      generation: 1,
      phase: "ready",
      reasons: [],
      reasonCounts: {},
      durableLineOffset: 0,
    };
    const onLifecycleRef: { current?: CaptureSessionDeps["onLifecycle"] } = {};
    let failRevoke = false;
    let stopEntered = false;
    let onExit: ((e: { exitCode: number; signal?: number }) => void) | undefined;

    const dIo = baseIo({
      failWrite: () => failRevoke,
      failUnlink: () => failRevoke,
    });

    runMocks.captureFactory = (deps) => {
      onLifecycleRef.current = deps.onLifecycle;
      return makeLifecycleCapture({
        onLifecycleRef,
        health,
        readyPath: join(home, "r.jsonl"),
        stopImpl: async () => {
          stopEntered = true;
          await new Promise<void>(() => {});
        },
      });
    };

    const { stdin, stdout, stderr } = fakeStreams();
    const runPromise = run(["--session-id", "11111111-1111-1111-1111-111111111111", "-p", "exit-fatal"], {
      noInference: true,
      claudeBin: "/bin/true",
      forceWrapperExit: forceExit,
      descriptorIo: dIo,
      spawnPty: (() =>
        ({
          pid: 454545,
          write() {},
          resize() {},
          kill() {},
          onData() {},
          onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
            onExit = cb;
          },
        }) as never) as typeof import("@lydell/node-pty").spawn,
      stdin,
      stdout,
      stderr,
      wrapperLog: {
        path: join(home, "w.log"),
        info() {},
        warn() {},
        warningCount: () => 0,
      },
    });

    await waitFor(() => onLifecycleRef.current !== undefined, "lifecycle");
    onLifecycleRef.current?.([{ kind: "session_bound", sessionId: "life-session" }]);
    await sleep(40);
    failRevoke = true;
    // Child exits cleanly; teardown revoke must fail → fatal exit
    onExit?.({ exitCode: 0 });
    await waitFor(() => forceExit.mock.calls.length > 0, "forceWrapperExit on child exit");
    expect(forceExit).toHaveBeenCalledWith(1);
    expect(stopEntered).toBe(false);
    const code = await runPromise;
    expect(code).toBe(1);
  }, 15_000);
});
