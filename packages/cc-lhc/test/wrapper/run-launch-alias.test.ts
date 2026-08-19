import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultLineageDbPath, defaultRegistryPath } from "../../src/intake/paths.js";
import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import {
  acceptCurrentSession,
  bindLaunchThread,
  claudeSessionAlias,
  currentSessionAlias,
} from "../../src/intake/thread-alias.js";
import { acquireThreadOwner } from "../../src/runtime/thread-owner.js";
import { emptyCaptureStats } from "../../src/stats.js";
import { run } from "../../src/wrapper/run.js";

const launchMocks = vi.hoisted(() => ({
  captureCalls: [] as CaptureSessionDeps[],
}));

vi.mock("../../src/intake/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intake/session.js")>();
  return {
    ...actual,
    startCaptureSession: (opts: CaptureSessionDeps = {}) => {
      launchMocks.captureCalls.push(opts);
      return {
        stats: emptyCaptureStats(),
        getCommandContext: () => ({
          sdk: undefined,
          threadRef: undefined,
          rolloutPath: undefined,
          captureDegraded: false,
          captureGeneration: 1,
          capturePhase: "binding" as const,
        }),
        getRolloutInfo: () => ({ path: undefined, sessionId: undefined }),
        isTurnOpen: () => false,
        isCaptureHealthy: () => false,
        isCaptureReady: () => false,
        getCaptureHealth: () => ({ generation: 1, phase: "binding" as const, reasons: [] }),
        getCaptureGeneration: () => 1,
        stop: async () => {},
      } as unknown as CaptureSession;
    },
  };
});

const OLD_SESSION = "11111111-1111-4111-8111-111111111111";
const CURRENT_SESSION = "22222222-2222-4222-8222-222222222222";

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
    fireExit(code) {
      for (const cb of exitCbs) cb({ exitCode: code });
    },
    onData: () => ({ dispose() {} }),
    onExit: (cb) => {
      exitCbs.push(cb);
      return { dispose() {} };
    },
    kill: () => {},
    write: () => {},
    resize: () => {},
  };
  return fake;
}

function fakeStream(): NodeJS.ReadStream & NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & NodeJS.WriteStream;
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  Object.defineProperty(stream, "columns", { value: 80, configurable: true });
  Object.defineProperty(stream, "rows", { value: 24, configurable: true });
  return stream;
}

async function launchOn(sessionId: string): Promise<{ spawned: FakePty[]; code: number }> {
  const spawned: FakePty[] = [];
  const runPromise = run(["--resume", sessionId], {
    claudeBin: "fake-claude",
    spawnPty: ((_file: string, args: string[]) => {
      const fake = makeFakePty(2000 + spawned.length, args);
      spawned.push(fake);
      setTimeout(() => fake.fireExit(0), 20);
      return fake as never;
    }) as never,
    stdin: fakeStream(),
    stdout: fakeStream(),
    stderr: fakeStream(),
    noInference: true,
  });
  const code = await runPromise;
  return { spawned, code };
}

describe("run: launching through an alias of a thread", () => {
  const savedHome = process.env.CC_LHC_HOME;
  const homes: string[] = [];

  beforeEach(() => {
    launchMocks.captureCalls.length = 0;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-launch-alias-"));
    homes.push(home);
    process.env.CC_LHC_HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const home of homes.splice(0)) {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("resumes an old alias onto the thread's current session and owns that thread", async () => {
    await bindLaunchThread({
      sessionId: OLD_SESSION,
      registryPath: defaultRegistryPath(),
      lineageDbPath: defaultLineageDbPath(),
      createThread: async () => "th_launch",
    });
    await acceptCurrentSession({
      sessionId: CURRENT_SESSION,
      threadId: "th_launch",
      registryPath: defaultRegistryPath(),
    });

    const { spawned, code } = await launchOn(OLD_SESSION);

    expect(code).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toContain("--resume");
    expect(spawned[0]!.args[spawned[0]!.args.indexOf("--resume") + 1]).toBe(CURRENT_SESSION);
    // Capture was bound to the same thread, through the current session.
    expect(launchMocks.captureCalls[0]?.launchThread).toEqual({ threadId: "th_launch", createdAtLaunch: false });
    expect(launchMocks.captureCalls[0]?.expectedSession).toEqual({
      sessionId: CURRENT_SESSION,
      source: "current_alias",
    });
  });

  it("creates and owns a thread for a session the registry has never seen", async () => {
    const { spawned, code } = await launchOn(OLD_SESSION);

    expect(code).toBe(0);
    expect(spawned[0]!.args[spawned[0]!.args.indexOf("--resume") + 1]).toBe(OLD_SESSION);
    const binding = launchMocks.captureCalls[0]?.launchThread;
    expect(binding?.createdAtLaunch).toBe(true);
    expect(binding?.threadId).toMatch(/^th_[0-9a-f]{16}$/);
    // The launch session became the new thread's current one.
    expect(await currentSessionAlias(binding!.threadId, defaultRegistryPath())).toBe(claudeSessionAlias(OLD_SESSION));
  });

  it("refuses a launch on another alias while the thread already has a live owner", async () => {
    await bindLaunchThread({
      sessionId: OLD_SESSION,
      registryPath: defaultRegistryPath(),
      lineageDbPath: defaultLineageDbPath(),
      createThread: async () => "th_taken",
    });
    await acceptCurrentSession({
      sessionId: CURRENT_SESSION,
      threadId: "th_taken",
      registryPath: defaultRegistryPath(),
    });
    const held = acquireThreadOwner("th_taken");

    const spawned: FakePty[] = [];
    let stderrText = "";
    const stderr = fakeStream();
    (stderr as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });
    try {
      const code = await run(["--resume", OLD_SESSION], {
        claudeBin: "fake-claude",
        spawnPty: ((_file: string, args: string[]) => {
          const fake = makeFakePty(3000 + spawned.length, args);
          spawned.push(fake);
          return fake as never;
        }) as never,
        stdin: fakeStream(),
        stdout: fakeStream(),
        stderr,
        noInference: true,
      });

      expect(code).toBe(2);
      expect(spawned).toHaveLength(0);
      expect(stderrText).toContain("cc-lhc refused duplicate thread owner");
      expect(stderrText).toContain("th_taken");
    } finally {
      held.release();
    }
  });
});
