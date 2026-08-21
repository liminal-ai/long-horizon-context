/**
 * LIM-118: TC-1.4a-b, AR-11. Detach presentation; command and late receipt
 * each settle exactly once.
 */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import { emptyCaptureStats } from "../../src/stats.js";
import { DEFAULT_LEADER_BYTE } from "../../src/wrapper/modal.js";
import { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } from "../../src/wrapper/panel.js";
import { run } from "../../src/wrapper/run.js";

const LEADER = Buffer.from([DEFAULT_LEADER_BYTE]);

const runMocks = vi.hoisted(() => ({
  dispatchLhcCommand: vi.fn(),
  captureFactory: null as ((opts: CaptureSessionDeps) => CaptureSession) | null,
}));

vi.mock("../../src/commands/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/commands/dispatch.js")>();
  return {
    ...actual,
    dispatchLhcCommand: (...args: Parameters<typeof actual.dispatchLhcCommand>) =>
      runMocks.dispatchLhcCommand(...args),
  };
});

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

function makeCaptureSession(): CaptureSession {
  const stats = { ...emptyCaptureStats(), threadId: "th_detach" };
  return {
    stats,
    getCommandContext: () => ({
      stats,
      sdk: undefined,
      threadRef: { threadId: "th_detach", registryPath: "/tmp/reg.sqlite" },
      captureDegraded: false,
      captureGeneration: 1,
      capturePhase: "ready" as const,
    }),
    getRolloutInfo: () => ({ path: "/tmp/old.jsonl", sessionId: "old" }),
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

async function waitFor(condition: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("TC-1.4a Detach from running command", () => {
  beforeEach(() => {
    runMocks.dispatchLhcCommand.mockReset();
    runMocks.captureFactory = () => makeCaptureSession();
  });
  afterEach(() => {
    runMocks.captureFactory = null;
  });

  it("closing during a command detaches presentation while one execution continues", async () => {
    let resolveCommand: (outcome: { messages: string[] }) => void = () => {};
    runMocks.dispatchLhcCommand.mockImplementation(
      () =>
        new Promise<{ messages: string[] }>((resolve) => {
          resolveCommand = resolve;
        }),
    );
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.defineProperty(stdout, "columns", { value: 80, configurable: true });
    Object.defineProperty(stdout, "rows", { value: 24, configurable: true });
    Object.defineProperty(stdout, "isTTY", { value: false, configurable: true });
    Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
    let out = "";
    (stdout as unknown as PassThrough).on("data", (chunk: Buffer) => {
      out += chunk.toString("latin1");
    });
    const exitCbs: Array<(arg: { exitCode: number }) => void> = [];
    const pty = {
      pid: 7,
      write: () => {},
      resize: () => {},
      kill: () => {
        setImmediate(() => {
          for (const cb of exitCbs) cb({ exitCode: 0 });
        });
      },
      onData: (cb: (data: string) => void) => {
        setTimeout(() => cb("tick\r\n"), 10);
        return { dispose() {} };
      },
      onExit: (cb: (arg: { exitCode: number }) => void) => {
        exitCbs.push(cb);
        return { dispose() {} };
      },
    };
    const runPromise = run([], {
      claudeBin: "fake",
      spawnPty: (() => pty) as never,
      stdin,
      stdout,
      noInference: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(LEADER);
    await waitFor(() => out.includes(ENTER_ALT_SCREEN), "panel open");
    (stdin as unknown as PassThrough).write(Buffer.from("smart-compact\r"));
    await waitFor(() => runMocks.dispatchLhcCommand.mock.calls.length === 1, "command started");
    (stdin as unknown as PassThrough).write(Buffer.from([0x03]));
    await waitFor(() => out.includes(LEAVE_ALT_SCREEN), "panel closed");
    expect(runMocks.dispatchLhcCommand).toHaveBeenCalledTimes(1);
    expect(runMocks.dispatchLhcCommand.mock.calls[0]?.[0]).toBe("/lhc-compact");
    resolveCommand({ messages: ["Smart Compact rebuilt v1"] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(runMocks.dispatchLhcCommand).toHaveBeenCalledTimes(1);
    pty.kill();
    await runPromise;
  }, 15_000);
});

describe("TC-1.4b Deliver late result truthfully", () => {
  beforeEach(() => {
    runMocks.dispatchLhcCommand.mockReset();
    runMocks.captureFactory = () => makeCaptureSession();
  });
  afterEach(() => {
    runMocks.captureFactory = null;
  });

  it.each([
    {
      name: "success",
      settle: (resolve: (outcome: { messages: string[] }) => void) => {
        resolve({ messages: ["Smart Compact rebuilt v1"] });
      },
      message: "Smart Compact rebuilt v1",
    },
    {
      name: "rejected",
      settle: (resolve: (outcome: { messages: string[] }) => void) => {
        resolve({ messages: ["turn in progress - rerun when idle"] });
      },
      message: "turn in progress - rerun when idle",
    },
    {
      name: "failure",
      settle: (_resolve: (outcome: { messages: string[] }) => void, reject: (cause: Error) => void) => {
        reject(new Error("compact failed"));
      },
      message: "command error: compact failed",
    },
  ])("late $name retains original label and appears once on each supported surface", async ({ settle, message }) => {
    let resolveCommand: (outcome: { messages: string[] }) => void = () => {};
    let rejectCommand: (cause: Error) => void = () => {};
    runMocks.dispatchLhcCommand.mockImplementation(
      () =>
        new Promise<{ messages: string[] }>((resolve, reject) => {
          resolveCommand = resolve;
          rejectCommand = reject;
        }),
    );
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.defineProperty(stdout, "columns", { value: 80, configurable: true });
    Object.defineProperty(stdout, "rows", { value: 24, configurable: true });
    Object.defineProperty(stdout, "isTTY", { value: false, configurable: true });
    Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
    let out = "";
    (stdout as unknown as PassThrough).on("data", (chunk: Buffer) => {
      out += chunk.toString("latin1");
    });
    const logs: string[] = [];
    const exitCbs: Array<(arg: { exitCode: number }) => void> = [];
    const pty = {
      pid: 8,
      write: () => {},
      resize: () => {},
      kill: () => {
        setImmediate(() => {
          for (const cb of exitCbs) cb({ exitCode: 0 });
        });
      },
      onData: (cb: (data: string) => void) => {
        setTimeout(() => cb("tick\r\n"), 10);
        return { dispose() {} };
      },
      onExit: (cb: (arg: { exitCode: number }) => void) => {
        exitCbs.push(cb);
        return { dispose() {} };
      },
    };
    const runPromise = run([], {
      claudeBin: "fake",
      spawnPty: (() => pty) as never,
      stdin,
      stdout,
      noInference: true,
      wrapperLog: {
        info: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
        warningCount: () => 0,
        path: "/tmp/fake.log",
      } as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(LEADER);
    await waitFor(() => out.includes(ENTER_ALT_SCREEN), "panel open");
    (stdin as unknown as PassThrough).write(Buffer.from("smart-compact\r"));
    await waitFor(() => runMocks.dispatchLhcCommand.mock.calls.length === 1, "started");
    expect(runMocks.dispatchLhcCommand.mock.calls[0]?.[0]).toBe("/lhc-compact");
    (stdin as unknown as PassThrough).write(Buffer.from([0x03]));
    await waitFor(() => out.includes(LEAVE_ALT_SCREEN), "detached");
    settle(resolveCommand, rejectCommand);
    await waitFor(
      () => logs.filter((line) => line.includes("[smart-compact]") && line.includes(message)).length === 1,
      "late log receipt",
    );
    expect(logs.filter((line) => line.includes("[smart-compact]") && line.includes(message))).toHaveLength(1);
    expect(logs.filter((line) => line.includes("modal dismissed early") && line.includes(message))).toHaveLength(1);
    const reopenAt = out.length;
    (stdin as unknown as PassThrough).write(LEADER);
    await waitFor(() => out.slice(reopenAt).includes(ENTER_ALT_SCREEN), "reopen");
    await waitFor(() => out.slice(reopenAt).includes("smart-compact finished:"), "panel late receipt");
    const panel = out.slice(reopenAt);
    expect(panel.split("smart-compact finished:").length - 1).toBe(1);
    expect(panel.split("smart-compact finished:")[1]).toContain(message);
    expect(runMocks.dispatchLhcCommand).toHaveBeenCalledTimes(1);
    pty.kill();
    await runPromise;
  }, 15_000);
});

describe("AR-11 detached command and late receipt settle once", () => {
  beforeEach(() => {
    runMocks.dispatchLhcCommand.mockReset();
    runMocks.captureFactory = () => makeCaptureSession();
  });
  afterEach(() => {
    runMocks.captureFactory = null;
  });

  it("detached command promise and late receipt each settle exactly once", async () => {
    let settles = 0;
    let resolveCommand: (outcome: { messages: string[] }) => void = () => {};
    runMocks.dispatchLhcCommand.mockImplementation(
      () =>
        new Promise<{ messages: string[] }>((resolve) => {
          resolveCommand = (outcome) => {
            settles += 1;
            resolve(outcome);
          };
        }),
    );
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.defineProperty(stdout, "columns", { value: 80, configurable: true });
    Object.defineProperty(stdout, "rows", { value: 24, configurable: true });
    Object.defineProperty(stdout, "isTTY", { value: false, configurable: true });
    Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
    let out = "";
    (stdout as unknown as PassThrough).on("data", (chunk: Buffer) => {
      out += chunk.toString("latin1");
    });
    const logs: string[] = [];
    const exitCbs: Array<(arg: { exitCode: number }) => void> = [];
    const pty = {
      pid: 9,
      write: () => {},
      resize: () => {},
      kill: () => {
        setImmediate(() => {
          for (const cb of exitCbs) cb({ exitCode: 0 });
        });
      },
      onData: (cb: (data: string) => void) => {
        setTimeout(() => cb("tick\r\n"), 10);
        return { dispose() {} };
      },
      onExit: (cb: (arg: { exitCode: number }) => void) => {
        exitCbs.push(cb);
        return { dispose() {} };
      },
    };
    const runPromise = run([], {
      claudeBin: "fake",
      spawnPty: (() => pty) as never,
      stdin,
      stdout,
      noInference: true,
      wrapperLog: {
        info: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
        warningCount: () => 0,
        path: "/tmp/fake.log",
      } as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(LEADER);
    await waitFor(() => out.includes(ENTER_ALT_SCREEN), "open");
    (stdin as unknown as PassThrough).write(Buffer.from("status\r"));
    await waitFor(() => runMocks.dispatchLhcCommand.mock.calls.length === 1, "dispatch started");
    (stdin as unknown as PassThrough).write(Buffer.from([0x03]));
    await waitFor(() => out.includes(LEAVE_ALT_SCREEN), "detached");
    resolveCommand({ messages: ["done-once"] });
    await waitFor(() => settles === 1, "promise settled");
    await waitFor(
      () => logs.filter((line) => line.includes("[status]") && line.includes("done-once")).length === 1,
      "late log receipt",
    );
    const reopenAt = out.length;
    (stdin as unknown as PassThrough).write(LEADER);
    await waitFor(() => out.slice(reopenAt).includes("status finished:"), "panel late receipt");
    expect(settles).toBe(1);
    expect(runMocks.dispatchLhcCommand).toHaveBeenCalledTimes(1);
    expect(logs.filter((line) => line.includes("[status]") && line.includes("done-once"))).toHaveLength(1);
    expect(out.slice(reopenAt).split("status finished:").length - 1).toBe(1);
    expect(out.slice(reopenAt).split("done-once").length - 1).toBe(1);
    pty.kill();
    await runPromise;
  }, 15_000);
});
