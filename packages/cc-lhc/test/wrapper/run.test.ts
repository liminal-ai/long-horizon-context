import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import { emptyCaptureStats } from "../../src/stats.js";
import { DEFAULT_LEADER_BYTE } from "../../src/wrapper/modal.js";
import { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } from "../../src/wrapper/panel.js";
import {
  OUTPUT_HOLD_OVERFLOW_MESSAGE,
  onTerminalResize,
  resizePty,
  run,
  settleReceipts,
} from "../../src/wrapper/run.js";
import { createWrapperLog } from "../../src/wrapper/wrapper-log.js";

const FAKE_PTY_CHILD = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/fake-pty-child.mjs");

const runMocks = vi.hoisted(() => ({
  dispatchLhcCommand: vi.fn(),
  captureFactory: null as ((opts: CaptureSessionDeps) => CaptureSession) | null,
}));

vi.mock("../../src/commands/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/commands/dispatch.js")>();
  return {
    ...actual,
    dispatchLhcCommand: (...args: Parameters<typeof actual.dispatchLhcCommand>) => runMocks.dispatchLhcCommand(...args),
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

function fakeStdout(cols: number, rows: number): NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.defineProperty(stream, "columns", { value: cols, configurable: true });
  Object.defineProperty(stream, "rows", { value: rows, configurable: true });
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  return stream;
}

function fakeStderr(): NodeJS.WriteStream {
  return new PassThrough() as unknown as NodeJS.WriteStream;
}

function fakeStdin(): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  return stream;
}

function makeCaptureSession(stopImpl: () => Promise<void> = async () => {}): CaptureSession {
  const stats = { ...emptyCaptureStats(), threadId: "th_test" };
  const health = {
    generation: 1,
    phase: "ready" as const,
    reasons: [] as string[],
    reasonCounts: {} as Record<string, number>,
    durableLineOffset: 0,
  };
  return {
    stats,
    getCommandContext: () => ({
      captureDisabled: false,
      stats,
      sdk: {
        drainSettled: async () => {},
        intakeStream: {
          messageEvents: async () => ({ ok: true, value: { events: [] } }),
        },
      },
      threadRef: { threadId: "th_test", registryPath: "/tmp/registry.sqlite" },
      captureDegraded: false,
      captureGeneration: 1,
      capturePhase: "ready" as const,
    }),
    getRolloutInfo: () => ({ path: "/tmp/old.jsonl", sessionId: "old-session" }),
    isTurnOpen: () => false,
    isCaptureHealthy: () => health.phase === "ready",
    isCaptureReady: () => health.phase === "ready",
    getCaptureHealth: () => ({ ...health, reasons: [...health.reasons] }),
    getCaptureGeneration: () => health.generation,
    stop: vi.fn(stopImpl),
  } as unknown as CaptureSession;
}

describe("resizePty", () => {
  it("calls pty.resize with the given dimensions", () => {
    const resize = vi.fn();
    resizePty({ resize }, 120, 40);
    expect(resize).toHaveBeenCalledWith(120, 40);
  });
});

describe("onTerminalResize", () => {
  it("reads cols/rows from stdout", () => {
    const resize = vi.fn();
    onTerminalResize({ resize }, fakeStdout(100, 30));
    expect(resize).toHaveBeenCalledWith(100, 30);
  });

  it("falls back when stdout has no dimensions", () => {
    const resize = vi.fn();
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    onTerminalResize({ resize }, stdout);
    expect(resize).toHaveBeenCalledWith(80, 24);
  });
});

describe("settleReceipts", () => {
  it("always keeps messages for operator dismiss (no swap auto-dismiss)", () => {
    expect(settleReceipts(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("run", () => {
  const savedLeader = process.env.CC_LHC_LEADER;

  beforeEach(() => {
    runMocks.dispatchLhcCommand.mockReset();
    runMocks.captureFactory = () => makeCaptureSession();
  });

  afterEach(() => {
    if (savedLeader === undefined) delete process.env.CC_LHC_LEADER;
    else process.env.CC_LHC_LEADER = savedLeader;
    vi.restoreAllMocks();
  });

  it("forwards stub child stdout and propagates exit code", async () => {
    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString());
    });

    const exitCode = await run(["-c", "echo hello; exit 3"], {
      claudeBin: "bash",
      stdin,
      stdout,
      noCapture: true,
    });

    expect(output.join("")).toContain("hello");
    expect(exitCode).toBe(3);
  });

  it("shows compact relaunch guidance in modal without writing /resume to the PTY", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "cc-lhc-run-guidance-"));
    const wrapperLog = createWrapperLog(join(logDir, "wrapper.log"));
    const ptyWrites: string[] = [];

    runMocks.dispatchLhcCommand.mockResolvedValue({
      messages: [
        "compact view=v2 tail=1 total=1",
        "LHC compact: rebuilt session new-id written; live Claude session old-session is unchanged.",
        "Exit Claude, then relaunch with: cc-lhc --resume new-id",
      ],
    });

    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });

    const { spawn } = await import("@lydell/node-pty");
    const runPromise = run([FAKE_PTY_CHILD], {
      claudeBin: "node",
      spawnPty: ((file, args, opts) => {
        const pty = spawn(file, args, opts);
        const origWrite = pty.write.bind(pty);
        pty.write = (data: string) => {
          ptyWrites.push(data);
          return origWrite(data);
        };
        return pty;
      }) as typeof spawn,
      stdin,
      stdout,
      wrapperLog,
      noInference: true,
    });

    await sleep(100);
    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => output.some((chunk) => chunk.includes(ENTER_ALT_SCREEN)), "modal entry");
    (stdin as unknown as PassThrough).write(Buffer.from("compact\r"));

    await waitFor(() => output.join("").includes("cc-lhc --resume new-id"), "guidance visible");
    // Panel stays open (no auto-dismiss swap)
    expect(output.some((chunk) => chunk.includes(ENTER_ALT_SCREEN))).toBe(true);
    // No in-app /resume injection on the child PTY
    expect(ptyWrites.some((w) => w.includes("/resume"))).toBe(false);
    expect(output.join("")).not.toMatch(/resuming in-place/i);

    (stdin as unknown as PassThrough).write(Buffer.from([0x1b])); // Esc dismiss
    await waitFor(() => output.some((chunk) => chunk.includes(LEAVE_ALT_SCREEN)), "dismiss");
    process.kill(process.pid, "SIGTERM");
    await runPromise;
  }, 15_000);

  it("does not inject /resume when dispatch returns no restart plan", async () => {
    runMocks.dispatchLhcCommand.mockResolvedValue({
      messages: ["status ok"],
    });
    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("latin1")));

    const runPromise = run([FAKE_PTY_CHILD], {
      claudeBin: "node",
      stdin,
      stdout,
      noInference: true,
    });
    await sleep(80);
    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => output.some((c) => c.includes(ENTER_ALT_SCREEN)), "modal");
    (stdin as unknown as PassThrough).write(Buffer.from("status\r"));
    await waitFor(() => output.join("").includes("status ok"), "status receipt");
    process.kill(process.pid, "SIGTERM");
    await runPromise;
  }, 10_000);

  it("keeps the panel open for turn-open refusal without an early dismiss", async () => {
    let turnOpen = false;
    runMocks.captureFactory = () => {
      const session = makeCaptureSession();
      session.isTurnOpen = () => turnOpen;
      return session;
    };
    runMocks.dispatchLhcCommand.mockImplementation(async () => {
      turnOpen = true;
      return {
        messages: ["turn opened during rebuild — refused"],
      };
    });

    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });

    const runPromise = run([FAKE_PTY_CHILD], {
      claudeBin: "node",
      stdin,
      stdout,
      noInference: true,
    });

    await sleep(100);
    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => output.some((chunk) => chunk.includes(ENTER_ALT_SCREEN)), "modal entry");
    (stdin as unknown as PassThrough).write(Buffer.from("compact\r"));

    await waitFor(() => output.join("").includes("turn opened during rebuild"), "turn-open refusal receipt");
    const joined = output.join("");
    expect(joined.split(LEAVE_ALT_SCREEN).length - 1).toBe(0);

    process.kill(process.pid, "SIGTERM");
    await runPromise;
  }, 15_000);

  it("names the in-flight command in busy refusals and lands its late receipt on a reopened panel", async () => {
    runMocks.captureFactory = () => makeCaptureSession();
    let resolveSlow: (outcome: { messages: string[] }) => void = () => {};
    runMocks.dispatchLhcCommand.mockImplementation(async (line: string) => {
      if (line === "/lhc-status") {
        return new Promise<{ messages: string[] }>((resolve) => {
          resolveSlow = resolve;
        });
      }
      return { messages: ["stats line"] };
    });

    const stdout = fakeStdout(120, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });

    const runPromise = run([FAKE_PTY_CHILD], {
      claudeBin: "node",
      stdin,
      stdout,
      noInference: true,
    });

    await sleep(100);
    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => output.some((chunk) => chunk.includes(ENTER_ALT_SCREEN)), "modal entry");
    (stdin as unknown as PassThrough).write(Buffer.from("status\r"));
    // every executing command shows a progress line, not a frozen prompt
    await waitFor(() => output.join("").includes("running"), "progress line");

    // detach with ctrl-C, reopen, and try another command: the busy refusal
    // names what is still running
    (stdin as unknown as PassThrough).write(Buffer.from([0x03]));
    await waitFor(() => output.some((chunk) => chunk.includes(LEAVE_ALT_SCREEN)), "detach restore");
    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => output.filter((chunk) => chunk.includes(ENTER_ALT_SCREEN)).length >= 2, "panel reopened");
    (stdin as unknown as PassThrough).write(Buffer.from("stats\r"));
    await waitFor(() => output.join("").includes("status still running ("), "named busy refusal");

    // the detached command settles while the reopened panel is up: its
    // receipt lands there, labelled as late
    resolveSlow({ messages: ["tail=42"] });
    await waitFor(() => output.join("").includes("status finished:"), "late receipt label");
    expect(output.join("")).toContain("tail=42");

    process.kill(process.pid, "SIGTERM");
    await runPromise;
  }, 20_000);

  it("routes passthrough diagnostics to wrapper log with zero stdout/stderr writes", async () => {
    process.env.CC_LHC_LEADER = "invalid";

    const logDir = mkdtempSync(join(tmpdir(), "cc-lhc-run-doctrine-"));
    const logPath = join(logDir, "wrapper.log");
    const wrapperLog = createWrapperLog(logPath);

    let emitCaptureError: (() => void) | undefined;
    let compactCalls = 0;
    runMocks.captureFactory = (opts) => {
      emitCaptureError = () => opts.logError?.("capture diagnostic");
      return makeCaptureSession();
    };

    runMocks.dispatchLhcCommand.mockImplementation(async (line: string) => {
      if (line === "/lhc-compact") {
        compactCalls += 1;
        if (compactCalls === 1) {
          await sleep(400);
          return { messages: ["compact slow"] };
        }
        // Interim architecture: relaunch guidance, no restart plan / inject.
        return {
          messages: [
            "compact view=v4",
            "LHC compact: rebuilt session new-id written; live Claude session old-session is unchanged.",
            "Exit Claude, then relaunch with: cc-lhc --resume new-id",
          ],
        };
      }
      return { messages: ["noop"] };
    });

    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    const passthroughWrites: string[] = [];
    let modalOpen = false;
    const isChildTick = (chunk: string): boolean => /^(tick\d+\r\n)+$/.test(chunk);
    const isAllowedPassthroughWrite = (chunk: string): boolean => {
      if (chunk.includes(ENTER_ALT_SCREEN) || chunk.includes(LEAVE_ALT_SCREEN)) return true;
      if (chunk.includes("\x0c") || chunk.includes("^L")) return true;
      const stripped = chunk.replaceAll(ENTER_ALT_SCREEN, "").replaceAll(LEAVE_ALT_SCREEN, "");
      if (stripped.length === 0) return true;
      return isChildTick(stripped);
    };

    const trackPassthrough = (chunk: string): void => {
      if (chunk.includes(ENTER_ALT_SCREEN)) modalOpen = true;
      if (chunk.includes(LEAVE_ALT_SCREEN)) modalOpen = false;
      if (!modalOpen) passthroughWrites.push(chunk);
    };

    const wrapperPassthroughWrites = (): string[] =>
      passthroughWrites.filter((chunk) => !isAllowedPassthroughWrite(chunk));

    const stdoutWrite = vi.spyOn(stdout, "write").mockImplementation((chunk, ...args) => {
      trackPassthrough(String(chunk));
      return (PassThrough.prototype.write as typeof stdout.write).call(stdout, chunk, ...args);
    });
    const stderrWrite = vi.spyOn(stderr, "write").mockImplementation((chunk, ...args) => {
      trackPassthrough(String(chunk));
      return (PassThrough.prototype.write as typeof stderr.write).call(stderr, chunk, ...args);
    });

    // ticks mode generates continuous child output so the hold can overflow.
    const runPromise = run([FAKE_PTY_CHILD, "ticks"], {
      claudeBin: "node",
      stdin,
      stdout,
      stderr,
      wrapperLog,
      noInference: true,
      outputHoldCapBytes: 512,
    });

    await sleep(150);
    expect(wrapperPassthroughWrites()).toEqual([]);

    process.kill(process.pid, "SIGUSR1");
    await sleep(100);
    expect(wrapperPassthroughWrites()).toEqual([]);

    emitCaptureError?.();
    await sleep(100);
    expect(wrapperPassthroughWrites()).toEqual([]);

    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => modalOpen, "modal for detach");
    (stdin as unknown as PassThrough).write(Buffer.from("compact\r"));
    await sleep(50);
    (stdin as unknown as PassThrough).write(Buffer.from([0x03]));
    await waitFor(() => !modalOpen, "detach restore");
    await waitFor(() => compactCalls >= 1, "detached command to settle");
    await waitFor(async () => (await readFile(logPath, "utf8")).includes("modal dismissed early"), "detached receipt");
    expect(wrapperPassthroughWrites()).toEqual([]);

    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => modalOpen, "modal for compact guidance");
    (stdin as unknown as PassThrough).write(Buffer.from("compact\r"));
    // Panel stays open with relaunch guidance (no inject auto-dismiss).
    await waitFor(async () => {
      const text = await readFile(logPath, "utf8");
      return compactCalls >= 2 || text.includes("command receipt");
    }, "second compact settled");
    expect(wrapperPassthroughWrites()).toEqual([]);
    (stdin as unknown as PassThrough).write(Buffer.from([0x1b]));
    await waitFor(() => !modalOpen, "dismiss guidance");

    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => modalOpen, "modal for overflow");
    await waitFor(() => !modalOpen, "overflow restore", 10_000);
    expect(wrapperPassthroughWrites()).toEqual([]);

    const logText = await readFile(logPath, "utf8");
    expect(logText).toMatch(/\[warn\].*CC_LHC_LEADER/);
    expect(logText).toMatch(/\[info\].*cc-lhc-capture lines=/);
    expect(logText).toMatch(/\[warn\] capture diagnostic/);
    expect(logText).toMatch(
      new RegExp(`\\[warn\\] ${OUTPUT_HOLD_OVERFLOW_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    expect(logText).toMatch(/command receipt \(modal dismissed early\)/);

    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    process.kill(process.pid, "SIGTERM");
    await runPromise;
  }, 30_000);
});
