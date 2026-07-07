import { spawn as defaultSpawn } from "@lydell/node-pty";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionRestartPlan } from "../../src/commands/dispatch.js";
import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import * as statFile from "../../src/rollout/stat-file.js";
import { emptyCaptureStats } from "../../src/stats.js";
import { DEFAULT_LEADER_BYTE } from "../../src/wrapper/modal.js";
import { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } from "../../src/wrapper/panel.js";
import { onTerminalResize, OUTPUT_HOLD_OVERFLOW_MESSAGE, resizePty, run, type PtySpawn } from "../../src/wrapper/run.js";
import { createWrapperLog } from "../../src/wrapper/wrapper-log.js";

const SWAP_PLAN: SessionRestartPlan = {
  oldSessionId: "old-session",
  newSessionId: "00000000-1111-2222-3333-444444444444",
  rolloutPath: "/tmp/new.jsonl",
  rebuiltLineCount: 4,
  expectedReintakeLines: 4,
  replayedPrefixLines: 3,
};

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    }),
    getRolloutInfo: () => ({ path: "/tmp/old.jsonl", sessionId: "old-session" }),
    isTurnOpen: () => false,
    stop: vi.fn(stopImpl),
  } as unknown as CaptureSession;
}

function statRolloutGrowth() {
  let calls = 0;
  return async (): Promise<statFile.RolloutStat | null> => {
    calls += 1;
    if (calls === 1) return { size: 100, mtimeMs: 1 };
    return { size: 130, mtimeMs: 2 };
  };
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
    const stdout = fakeStdout(100, 30);
    onTerminalResize({ resize }, stdout);
    expect(resize).toHaveBeenCalledWith(100, 30);
  });

  it("falls back when stdout has no dimensions", () => {
    const resize = vi.fn();
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    onTerminalResize({ resize }, stdout);
    expect(resize).toHaveBeenCalledWith(80, 24);
  });
});

describe("run", () => {
  const savedLeader = process.env.CC_LHC_LEADER;

  beforeEach(() => {
    runMocks.dispatchLhcCommand.mockReset();
    runMocks.captureFactory = null;
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

  it("auto-dismisses after confirmed swap when post-confirm handoff throws", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "cc-lhc-run-swap-"));
    const logPath = join(logDir, "wrapper.log");
    const wrapperLog = createWrapperLog(logPath);

    runMocks.captureFactory = () =>
      makeCaptureSession(async () => {
        throw new Error("sdk drain rejected");
      });

    runMocks.dispatchLhcCommand.mockResolvedValue({
      messages: ["compact view=v4"],
      restart: SWAP_PLAN,
    });

    vi.spyOn(statFile, "statRolloutFile").mockImplementation(statRolloutGrowth());

    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });

    const runPromise = run(["-c", "sleep 30"], {
      claudeBin: "bash",
      stdin,
      stdout,
      wrapperLog,
      noInference: true,
      resumeWindowMs: 5,
    });

    await sleep(100);
    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => output.some((chunk) => chunk.includes(ENTER_ALT_SCREEN)), "modal entry");
    (stdin as unknown as PassThrough).write(Buffer.from("compact\r"));

    await waitFor(() => output.includes(LEAVE_ALT_SCREEN), "confirmed swap auto-dismiss");
    await sleep(100);

    const joined = output.join("");
    expect(joined).not.toContain("command error");
    expect(joined).not.toContain("sdk drain rejected");

    const logText = await readFile(logPath, "utf8");
    expect(logText).toMatch(/resume handoff failed \(swap confirmed\)/);
    expect(logText).toMatch(/sdk drain rejected/);

    process.kill(process.pid, "SIGTERM");
    await runPromise;
  }, 20_000);

  it("leaves the alt screen and flushes held output before the /resume pty write during a confirmed swap", async () => {
    const timeline: string[] = [];
    const ptyWrites: string[] = [];

    runMocks.captureFactory = () => makeCaptureSession();
    runMocks.dispatchLhcCommand.mockImplementation(async () => {
      await sleep(400);
      return { messages: ["compact view=v4"], restart: SWAP_PLAN };
    });
    vi.spyOn(statFile, "statRolloutFile").mockImplementation(statRolloutGrowth());

    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });
    const originalWrite = stdout.write.bind(stdout);
    let sawLeave = false;
    vi.spyOn(stdout, "write").mockImplementation((chunk, ...args) => {
      const text = String(chunk);
      if (text.includes(LEAVE_ALT_SCREEN)) {
        timeline.push("leave");
        sawLeave = true;
      } else if (sawLeave && !timeline.includes("held-flush") && /tick\d/.test(text)) {
        timeline.push("held-flush");
      }
      return originalWrite(chunk, ...args);
    });

    const spawnPty: PtySpawn = (file, args, opts) => {
      const proc = defaultSpawn(file, args, opts);
      const originalPtyWrite = proc.write.bind(proc);
      proc.write = (data: string) => {
        if (data.includes("/resume ")) {
          timeline.push("resume-pty");
          ptyWrites.push(data);
        }
        return originalPtyWrite(data);
      };
      return proc;
    };

    const runPromise = run(
      ["-c", 'i=0; while true; do i=$((i+1)); echo "tick$i"; sleep 0.05; done'],
      {
        claudeBin: "bash",
        stdin,
        stdout,
        spawnPty,
        noInference: true,
        resumeWindowMs: 5,
      },
    );

    await sleep(150);
    await waitFor(() => output.some((chunk) => chunk.includes("tick2")), "child ticks to hold");
    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => output.some((chunk) => chunk.includes(ENTER_ALT_SCREEN)), "modal entry");
    (stdin as unknown as PassThrough).write(Buffer.from("compact\r"));
    await waitFor(() => timeline.includes("leave"), "alt-screen leave at injection");
    await waitFor(() => timeline.includes("held-flush"), "held output flush at injection");
    await waitFor(() => timeline.includes("resume-pty"), "/resume pty write");

    const joined = output.join("");
    const leavePos = joined.indexOf(LEAVE_ALT_SCREEN);
    const tickAfterLeave = joined.indexOf("tick", leavePos + LEAVE_ALT_SCREEN.length);
    const leaveIdx = timeline.indexOf("leave");
    const heldIdx = timeline.indexOf("held-flush");
    const resumeIdx = timeline.indexOf("resume-pty");
    expect(leavePos).toBeGreaterThan(-1);
    expect(tickAfterLeave).toBeGreaterThan(leavePos);
    expect(leaveIdx).toBeGreaterThan(-1);
    expect(heldIdx).toBeGreaterThan(leaveIdx);
    expect(resumeIdx).toBeGreaterThan(heldIdx);
    expect(ptyWrites.some((line) => line.includes(`/resume ${SWAP_PLAN.newSessionId}`))).toBe(true);

    process.kill(process.pid, "SIGTERM");
    await runPromise;
  }, 20_000);

  it("reopens the panel with a failure receipt when swap fails after dismissal", async () => {
    runMocks.captureFactory = () => makeCaptureSession();
    runMocks.dispatchLhcCommand.mockResolvedValue({
      messages: ["compact view=v4"],
      restart: SWAP_PLAN,
    });
    vi.spyOn(statFile, "statRolloutFile").mockImplementation(async () => ({ size: 100, mtimeMs: 1 }));

    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });

    const runPromise = run(["-c", "sleep 30"], {
      claudeBin: "bash",
      stdin,
      stdout,
      noInference: true,
      resumeWindowMs: 5,
      resumeConfirmExtraMs: 50,
    });

    await sleep(100);
    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => output.some((chunk) => chunk.includes(ENTER_ALT_SCREEN)), "modal entry");
    (stdin as unknown as PassThrough).write(Buffer.from("compact\r"));

    await waitFor(() => output.join("").includes("resume did not take"), "failure receipt on reopened panel");
    const joined = output.join("");
    const firstLeave = joined.indexOf(LEAVE_ALT_SCREEN);
    const reopenEnter = joined.indexOf(ENTER_ALT_SCREEN, firstLeave + 1);
    expect(firstLeave).toBeGreaterThan(-1);
    expect(reopenEnter).toBeGreaterThan(firstLeave);

    process.kill(process.pid, "SIGTERM");
    await runPromise;
  }, 20_000);

  it("logs a late swap failure instead of clobbering a user-opened panel after dismissal", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "cc-lhc-run-late-fail-"));
    const logPath = join(logDir, "wrapper.log");
    const wrapperLog = createWrapperLog(logPath);

    runMocks.captureFactory = () => makeCaptureSession();
    runMocks.dispatchLhcCommand.mockResolvedValue({
      messages: ["compact view=v4"],
      restart: SWAP_PLAN,
    });
    vi.spyOn(statFile, "statRolloutFile").mockImplementation(async () => ({ size: 100, mtimeMs: 1 }));

    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });

    const runPromise = run(["-c", "sleep 30"], {
      claudeBin: "bash",
      stdin,
      stdout,
      wrapperLog,
      noInference: true,
      resumeWindowMs: 5,
      resumeConfirmExtraMs: 50,
    });

    await sleep(100);
    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => output.some((chunk) => chunk.includes(ENTER_ALT_SCREEN)), "modal entry");
    (stdin as unknown as PassThrough).write(Buffer.from("compact\r"));
    await waitFor(() => output.some((chunk) => chunk.includes(LEAVE_ALT_SCREEN)), "dismiss at injection");

    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => output.filter((chunk) => chunk.includes(ENTER_ALT_SCREEN)).length >= 2, "user reopens panel");
    (stdin as unknown as PassThrough).write(Buffer.from("status"));
    await waitFor(() => output.join("").includes("long-horizon commands> status"), "user panel line intact");

    await waitFor(
      async () => (await readFile(logPath, "utf8")).includes("swap failed after panel dismissal"),
      "late failure logged",
    );

    const joined = output.join("");
    const secondEnter = joined.indexOf(ENTER_ALT_SCREEN, joined.indexOf(LEAVE_ALT_SCREEN) + 1);
    const afterUserPanel = joined.slice(secondEnter);
    expect(afterUserPanel).toContain("long-horizon commands> status");
    expect(afterUserPanel).not.toContain("resume did not take");

    const logText = await readFile(logPath, "utf8");
    expect(logText).toMatch(/\[warn\].*swap failed after panel dismissal \(user panel active\)/);
    expect(logText).toMatch(/resume did not take/);

    process.kill(process.pid, "SIGTERM");
    await runPromise;
  }, 20_000);

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
        messages: ["compact view=v4"],
        restart: SWAP_PLAN,
      };
    });

    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });

    const runPromise = run(["-c", "sleep 30"], {
      claudeBin: "bash",
      stdin,
      stdout,
      noInference: true,
      resumeWindowMs: 5,
    });

    await sleep(100);
    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => output.some((chunk) => chunk.includes(ENTER_ALT_SCREEN)), "modal entry");
    (stdin as unknown as PassThrough).write(Buffer.from("compact\r"));

    await waitFor(
      () => output.join("").includes("turn opened during rebuild"),
      "turn-open refusal receipt",
    );
    const joined = output.join("");
    expect(joined.split(LEAVE_ALT_SCREEN).length - 1).toBe(0);

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
        return { messages: ["compact view=v4", "resuming session in-place..."], restart: SWAP_PLAN };
      }
      return { messages: ["noop"] };
    });

    vi.spyOn(statFile, "statRolloutFile").mockImplementation(statRolloutGrowth());

    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    const passthroughWrites: string[] = [];
    let modalOpen = false;
    const isChildTick = (chunk: string): boolean => /^(tick\d+\r\n)+$/.test(chunk);
    const isAllowedPassthroughWrite = (chunk: string): boolean => {
      if (chunk.includes(ENTER_ALT_SCREEN) || chunk.includes(LEAVE_ALT_SCREEN)) return true;
      if (chunk.includes("/resume ") || chunk.includes("\x0c") || chunk.includes("^L")) return true;
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

    const runPromise = run(["-c", 'i=0; while true; do i=$((i+1)); echo "tick$i"; sleep 0.05; done'], {
      claudeBin: "bash",
      stdin,
      stdout,
      stderr,
      wrapperLog,
      noInference: true,
      outputHoldCapBytes: 512,
      resumeWindowMs: 5,
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
    await waitFor(() => modalOpen, "modal for resume log");
    (stdin as unknown as PassThrough).write(Buffer.from("compact\r"));
    await waitFor(async () => (await readFile(logPath, "utf8")).includes("resuming in-place as"), "resume log");
    await waitFor(() => !modalOpen, "swap auto-dismiss");
    expect(wrapperPassthroughWrites()).toEqual([]);

    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => modalOpen, "modal for overflow");
    await waitFor(() => !modalOpen, "overflow restore", 10_000);
    expect(wrapperPassthroughWrites()).toEqual([]);

    const logText = await readFile(logPath, "utf8");
    expect(logText).toMatch(/\[warn\].*CC_LHC_LEADER/);
    expect(logText).toMatch(/\[info\].*cc-lhc-capture lines=/);
    expect(logText).toMatch(/\[warn\] capture diagnostic/);
    expect(logText).toMatch(new RegExp(`\\[warn\\] ${OUTPUT_HOLD_OVERFLOW_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(logText).toMatch(/command receipt \(modal dismissed early\)/);
    expect(logText).toMatch(/resuming in-place as/);

    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    process.kill(process.pid, "SIGTERM");
    await runPromise;
  }, 30_000);
});
