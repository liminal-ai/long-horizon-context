import { describe, expect, it, vi } from "vitest";

import type { SessionRestartPlan } from "../../src/commands/dispatch.js";
import type { CaptureSession } from "../../src/intake/session.js";
import {
  buildResumeInjection,
  createTripwireScanner,
  executeResumeInjection,
  formatResumeFailure,
  formatResumeSuccess,
  RESUME_NOT_FOUND_PHRASE,
} from "../../src/wrapper/resume-injection.js";

const PLAN: SessionRestartPlan = {
  oldSessionId: "old-session",
  newSessionId: "new-session",
  rolloutPath: "/tmp/new.jsonl",
  rebuiltLineCount: 4,
  expectedReintakeLines: 4,
};

function fakeCaptureSession(order: string[]): CaptureSession {
  const stats = { threadId: "th_same" };
  return {
    stats,
    getCommandContext: () => ({
      captureDisabled: false,
      stats,
      sdk: { drainSettled: async () => {} },
      threadRef: { threadId: "th_same", registryPath: "/tmp/registry.sqlite" },
    }),
    getRolloutInfo: () => ({ path: "/tmp/old.jsonl", sessionId: "old-session" }),
    stop: vi.fn(async () => {
      order.push("stop");
    }),
  } as unknown as CaptureSession;
}

describe("buildResumeInjection", () => {
  it("builds the slash command with a trailing carriage return", () => {
    expect(buildResumeInjection("abc-123")).toBe("/resume abc-123\r");
  });
});

describe("createTripwireScanner", () => {
  it("trips on the phrase inside one chunk", () => {
    const scanner = createTripwireScanner();
    expect(scanner.feed("Session 0000 was not found.")).toBe(true);
  });

  it("does not trip on unrelated output", () => {
    const scanner = createTripwireScanner();
    expect(scanner.feed("Welcome back! Session resumed.")).toBe(false);
    expect(scanner.feed("? for shortcuts")).toBe(false);
  });

  it("trips when the phrase spans chunk boundaries", () => {
    const scanner = createTripwireScanner();
    expect(scanner.feed("Session 0000-1111 was n")).toBe(false);
    expect(scanner.feed("ot fo")).toBe(false);
    expect(scanner.feed("und.")).toBe(true);
  });

  it("trips one character at a time", () => {
    const scanner = createTripwireScanner();
    const text = `xx ${RESUME_NOT_FOUND_PHRASE} yy`;
    let tripped = false;
    for (const char of text) {
      if (scanner.feed(char)) tripped = true;
    }
    expect(tripped).toBe(true);
  });

  it("trips with ANSI sequences around the phrase", () => {
    const scanner = createTripwireScanner();
    expect(scanner.feed("\x1b[2K\x1b[1G\x1b[31mSession abc was")).toBe(false);
    expect(scanner.feed(" not found.\x1b[0m\x1b[?25h")).toBe(true);
  });

  it("stays tripped after the first hit", () => {
    const scanner = createTripwireScanner();
    scanner.feed("was not found");
    expect(scanner.feed("anything")).toBe(true);
  });

  it("does not trip on a phrase torn apart by a long interruption", () => {
    const scanner = createTripwireScanner();
    expect(scanner.feed("was not")).toBe(false);
    expect(scanner.feed("... lots of unrelated repaint bytes ...")).toBe(false);
    expect(scanner.feed(" found")).toBe(false);
  });
});

describe("executeResumeInjection", () => {
  it("injects, records lineage, and hands capture off on success", async () => {
    const order: string[] = [];
    const captureSession = fakeCaptureSession(order);
    const written: string[] = [];
    const recordLineage = vi.fn(async () => {
      order.push("lineage");
    });
    const newCapture = { stats: {} } as unknown as CaptureSession;

    const result = await executeResumeInjection({
      plan: PLAN,
      captureSession,
      writeToPty: (data) => {
        order.push("inject");
        written.push(data);
      },
      onOutput: () => () => {},
      startCapture: (startedAt, continueCapture, rolloutPath) => {
        order.push(`capture:${rolloutPath}`);
        expect(startedAt).toBeInstanceOf(Date);
        expect("threadId" in continueCapture.threadRef && continueCapture.threadRef.threadId).toBe("th_same");
        expect(continueCapture.stats).toBe(captureSession.stats);
        return newCapture;
      },
      logResume: (message) => {
        order.push("log");
        expect(message).toContain("resuming in-place as new-session");
      },
      recordLineage,
      windowMs: 5,
    });

    expect(result).toEqual({ ok: true, captureSession: newCapture });
    expect(written).toEqual(["/resume new-session\r"]);
    expect(recordLineage).toHaveBeenCalledWith({ sessionId: "new-session", threadId: "th_same" });
    expect(order).toEqual(["log", "lineage", "inject", "stop", "capture:/tmp/new.jsonl"]);
  });

  it("reports failure and leaves the old capture running when the tripwire fires", async () => {
    const order: string[] = [];
    const captureSession = fakeCaptureSession(order);
    let emitOutput: ((data: string) => void) | undefined;
    let unsubscribed = false;

    const result = await executeResumeInjection({
      plan: PLAN,
      captureSession,
      writeToPty: () => {
        queueMicrotask(() => {
          emitOutput?.("\x1b[2K Session new-session was not ");
          emitOutput?.("found. \x1b[0m");
        });
      },
      onOutput: (listener) => {
        emitOutput = listener;
        return () => {
          unsubscribed = true;
        };
      },
      startCapture: () => {
        throw new Error("must not start a new capture on failure");
      },
      logResume: () => {},
      windowMs: 5_000,
    });

    expect(result).toEqual({ ok: false });
    expect(unsubscribed).toBe(true);
    expect(order).not.toContain("stop");
  });

  it("proceeds with injection when lineage write fails", async () => {
    const order: string[] = [];
    const captureSession = fakeCaptureSession(order);
    const lineageErrors: string[] = [];
    const newCapture = { stats: {} } as unknown as CaptureSession;

    const result = await executeResumeInjection({
      plan: PLAN,
      captureSession,
      writeToPty: () => {},
      onOutput: () => () => {},
      startCapture: () => newCapture,
      logResume: () => {},
      recordLineage: async () => {
        throw new Error("disk full");
      },
      logLineageError: (message) => {
        lineageErrors.push(message);
      },
      windowMs: 5,
    });

    expect(result.ok).toBe(true);
    expect(lineageErrors.some((line) => line.includes("lineage write failed (continuing)"))).toBe(true);
  });

  it("throws when no capture session is available", async () => {
    await expect(
      executeResumeInjection({
        plan: PLAN,
        captureSession: undefined,
        writeToPty: () => {},
        onOutput: () => () => {},
        startCapture: () => ({}) as CaptureSession,
        logResume: () => {},
        windowMs: 5,
      }),
    ).rejects.toThrow("capture session required");
  });
});

describe("receipt formatting", () => {
  it("success receipt has no restart language and carries the reintake estimate", () => {
    const message = formatResumeSuccess(PLAN);
    expect(message).toContain("resumed in-place as new-session");
    expect(message).toContain("~4 replayed lines");
    expect(message).not.toMatch(/restart/i);
  });

  it("failure receipt names the manual command and the still-live session", () => {
    const message = formatResumeFailure(PLAN);
    expect(message).toContain("/resume new-session");
    expect(message).toContain("still live");
  });
});
