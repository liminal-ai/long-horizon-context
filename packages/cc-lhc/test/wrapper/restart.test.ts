import { describe, expect, it, vi } from "vitest";

import type { SessionRestartPlan } from "../../src/commands/dispatch.js";
import type { CaptureSession } from "../../src/intake/session.js";
import {
  buildResumeArgv,
  executeSessionRestart,
  formatRestartSpawnFailure,
  killPtyWithGrace,
  RestartSpawnFailure,
} from "../../src/wrapper/restart.js";

function fakePty(options: { exitOnTerm?: boolean } = {}) {
  const exitOnTerm = options.exitOnTerm !== false;
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  return {
    kill: vi.fn((signal?: string) => {
      if (signal === "SIGTERM" && exitOnTerm) {
        for (const listener of exitListeners) listener({ exitCode: 0, signal: 15 });
      }
      if (signal === "SIGKILL") {
        for (const listener of exitListeners) listener({ exitCode: 0, signal: 9 });
      }
    }),
    onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListeners.push(listener);
    }),
    exitListeners,
  };
}

describe("buildResumeArgv", () => {
  it("appends --resume with the rebuilt session id", () => {
    expect(buildResumeArgv(["claude"], "new-id")).toEqual(["claude", "--resume", "new-id"]);
  });
});

describe("killPtyWithGrace", () => {
  it("escalates to SIGKILL when the child does not exit in time", async () => {
    const pty = fakePty({ exitOnTerm: false });
    await killPtyWithGrace(pty, { graceMs: 10, sleep: async () => {} });
    expect(pty.kill).toHaveBeenCalledWith("SIGTERM");
    expect(pty.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("executeSessionRestart", () => {
  it("kills, stops capture, spawns --resume child, and reuses thread state", async () => {
    const order: string[] = [];
    const oldPty = fakePty();
    const newPty = fakePty();
    const threadRef = { threadId: "th_same" };
    const sdk = { threadView: {} };
    const stats = { threadId: "th_same" };

    const captureSession = {
      stats,
      getCommandContext: () => ({ captureDisabled: false, stats, sdk, threadRef }),
      getRolloutInfo: () => ({ path: "/tmp/old.jsonl", sessionId: "old-session" }),
      stop: vi.fn(async () => {
        order.push("stop");
      }),
    } as unknown as CaptureSession;

    const plan: SessionRestartPlan = {
      oldSessionId: "old-session",
      newSessionId: "new-session",
      rolloutPath: "/tmp/new.jsonl",
      rebuiltLineCount: 4,
      expectedReintakeLines: 4,
    };

    const recordLineage = vi.fn(async () => {});
    const result = await executeSessionRestart({
      plan,
      originalArgv: ["claude"],
      pty: oldPty,
      captureSession,
      clearScreen: () => {
        order.push("clear");
      },
      spawnChild: (argv) => {
        order.push(`spawn:${argv.join(" ")}`);
        return newPty;
      },
      startCapture: (_startedAt, continueCapture) => {
        const threadId = "threadId" in continueCapture.threadRef ? continueCapture.threadRef.threadId : "file";
        order.push(`resume:${threadId}`);
        return {
          stats: continueCapture.stats,
          getCommandContext: () => ({
            captureDisabled: false,
            stats: continueCapture.stats,
            sdk: continueCapture.sdk,
            threadRef: continueCapture.threadRef,
          }),
          getRolloutInfo: () => ({ path: undefined, sessionId: undefined }),
          stop: vi.fn(async () => {}),
        } as unknown as CaptureSession;
      },
      recordLineage,
      logRestart: () => {
        order.push("log");
      },
    });

    expect(recordLineage).toHaveBeenCalledWith({ sessionId: "new-session", threadId: "th_same" });

    expect(oldPty.kill).toHaveBeenCalled();
    expect(order).toEqual(["log", "stop", "clear", "spawn:claude --resume new-session", "resume:th_same"]);
    expect(result.pty).toBe(newPty);
    expect(result.argv).toEqual(["claude", "--resume", "new-session"]);
  });

  it("throws RestartSpawnFailure when spawnChild fails after the old child is killed", async () => {
    const oldPty = fakePty();
    const threadRef = { threadId: "th_same" };
    const captureSession = {
      stats: { threadId: "th_same" },
      getCommandContext: () => ({ captureDisabled: false, stats: {}, sdk: {}, threadRef }),
      getRolloutInfo: () => ({ path: "/tmp/old.jsonl", sessionId: "old-session" }),
      stop: vi.fn(async () => {}),
    } as unknown as CaptureSession;

    const plan: SessionRestartPlan = {
      oldSessionId: "old-session",
      newSessionId: "new-session",
      rolloutPath: "/tmp/new.jsonl",
      rebuiltLineCount: 1,
      expectedReintakeLines: 1,
    };

    const failure = await executeSessionRestart({
      plan,
      originalArgv: ["claude"],
      pty: oldPty,
      captureSession,
      clearScreen: () => {},
      spawnChild: () => {
        throw new Error("spawn exploded");
      },
      startCapture: () => {
        throw new Error("should not start capture");
      },
      logRestart: () => {},
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(RestartSpawnFailure);
    expect(formatRestartSpawnFailure(plan, "spawn exploded")).toBe(
      "[cc-lhc] FATAL: could not respawn claude (spawn exploded). Original session old-session is intact; run: claude --resume new-session",
    );
    expect((failure as RestartSpawnFailure).resumeArgv).toEqual(["claude", "--resume", "new-session"]);
  });

  it("respawns when recordLineage fails", async () => {
    const oldPty = fakePty();
    const newPty = fakePty();
    const threadRef = { threadId: "th_same" };
    const captureSession = {
      stats: { threadId: "th_same" },
      getCommandContext: () => ({ captureDisabled: false, stats: {}, sdk: {}, threadRef }),
      getRolloutInfo: () => ({ path: "/tmp/old.jsonl", sessionId: "old-session" }),
      stop: vi.fn(async () => {}),
    } as unknown as CaptureSession;

    const plan: SessionRestartPlan = {
      oldSessionId: "old-session",
      newSessionId: "new-session",
      rolloutPath: "/tmp/new.jsonl",
      rebuiltLineCount: 1,
      expectedReintakeLines: 1,
    };

    const lineageErrors: string[] = [];
    const result = await executeSessionRestart({
      plan,
      originalArgv: ["claude"],
      pty: oldPty,
      captureSession,
      clearScreen: () => {},
      spawnChild: () => newPty,
      startCapture: (_startedAt, continueCapture) =>
        ({
          stats: continueCapture.stats,
          getCommandContext: () => ({
            captureDisabled: false,
            stats: continueCapture.stats,
            sdk: continueCapture.sdk,
            threadRef: continueCapture.threadRef,
          }),
          getRolloutInfo: () => ({ path: undefined, sessionId: undefined }),
          stop: vi.fn(async () => {}),
        }) as unknown as CaptureSession,
      recordLineage: async () => {
        throw new Error("disk full");
      },
      logLineageError: (message) => {
        lineageErrors.push(message);
      },
      logRestart: () => {},
    });

    expect(result.pty).toBe(newPty);
    expect(lineageErrors.some((line) => line.includes("lineage write failed (continuing)"))).toBe(true);
  });
});
