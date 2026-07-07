import { describe, expect, it, vi } from "vitest";

import type { SessionRestartPlan } from "../../src/commands/dispatch.js";
import type { CaptureSession } from "../../src/intake/session.js";
import {
  buildResumeInjection,
  createTripwireScanner,
  executeResumeInjection,
  formatResumeAbortTurnOpen,
  formatResumeFailure,
  formatResumeSuccess,
  formatSwapCollisionNote,
  REPAINT_NUDGE,
  type RolloutStat,
  resumeNotFoundPhrase,
} from "../../src/wrapper/resume-injection.js";

const NEW_ID = "00000000-1111-2222-3333-444444444444";

const PLAN: SessionRestartPlan = {
  oldSessionId: "old-session",
  newSessionId: NEW_ID,
  rolloutPath: "/tmp/new.jsonl",
  rebuiltLineCount: 4,
  expectedReintakeLines: 4,
  replayedPrefixLines: 3,
};

// Byte-for-byte from a live claude 2.1.201 failure capture (/tmp/resume-x-nonexistent.log):
// the words of the failure line arrive separated by cursor-column sequences, not spaces.
const RAW_FAILURE_CHUNK = `  ⎿  \x1b[39mSession \x1b[1m${NEW_ID}\x1b[51G\x1b[22mwas\x1b[55Gnot\x1b[59Gfound.\r\x1b[1B\x1b[K`;

function scanner(id: string = NEW_ID) {
  return createTripwireScanner(resumeNotFoundPhrase(id));
}

function fakeCaptureSession(
  order: string[],
  options: { messageEvents?: (threadRef: unknown, events: unknown[]) => Promise<unknown> } = {},
): CaptureSession {
  const stats = { threadId: "th_same" };
  const messageEvents = options.messageEvents ?? (async () => ({ ok: true, value: { events: [] } }));
  return {
    stats,
    getCommandContext: () => ({
      captureDisabled: false,
      stats,
      sdk: { drainSettled: async () => {}, intakeStream: { messageEvents } },
      threadRef: { threadId: "th_same", registryPath: "/tmp/registry.sqlite" },
    }),
    getRolloutInfo: () => ({ path: "/tmp/old.jsonl", sessionId: "old-session" }),
    isTurnOpen: () => false,
    stop: vi.fn(async () => {
      order.push("stop");
    }),
  } as unknown as CaptureSession;
}

/**
 * Path-aware statRollout double: the rebuilt rollout grows across calls (swap
 * evidence), the old rollout reports a fixed post-swap size.
 */
function statByPathFake(oldStat: RolloutStat): (path: string) => Promise<RolloutStat | null> {
  let newCalls = 0;
  return async (path: string) => {
    if (path === "/tmp/old.jsonl") return oldStat;
    newCalls += 1;
    return newCalls === 1 ? { size: 100, mtimeMs: 1 } : { size: 130, mtimeMs: 2 };
  };
}

/** statRollout double: first call returns `before`, later calls walk `after` (last repeats). */
function statSequence(before: RolloutStat | null, ...after: Array<RolloutStat | null>) {
  let calls = 0;
  return async (): Promise<RolloutStat | null> => {
    calls += 1;
    if (calls === 1) return before;
    return after[Math.min(calls - 2, after.length - 1)] ?? null;
  };
}

describe("buildResumeInjection", () => {
  it("builds the slash command with a trailing carriage return", () => {
    expect(buildResumeInjection("abc-123")).toBe("/resume abc-123\r");
  });
});

describe("createTripwireScanner", () => {
  it("trips on the real raw failure bytes (words split by cursor sequences)", () => {
    expect(scanner().feed(RAW_FAILURE_CHUNK)).toBe(true);
  });

  it("does not trip on a failure line for a different session id", () => {
    const otherId = "99999999-8888-7777-6666-555555555555";
    expect(scanner(otherId).feed(RAW_FAILURE_CHUNK)).toBe(false);
  });

  it("does not trip on replayed conversation text discussing the phrase", () => {
    const s = scanner();
    expect(s.feed("the tripwire greps for Session abc was not found in the stream")).toBe(false);
    expect(s.feed('we saw "was not found" render during the swap')).toBe(false);
  });

  it("trips on the plain-text form with literal spaces", () => {
    expect(scanner().feed(`Session ${NEW_ID} was not found.`)).toBe(true);
  });

  it("trips when the raw bytes are split across chunks, including mid-escape-sequence", () => {
    const s = scanner();
    // Split inside the id, inside "\x1b[55G", and inside "found."
    const cut1 = RAW_FAILURE_CHUNK.indexOf("2222");
    const cut2 = RAW_FAILURE_CHUNK.indexOf("[55G") + 2;
    const cut3 = RAW_FAILURE_CHUNK.indexOf("fou") + 2;
    expect(s.feed(RAW_FAILURE_CHUNK.slice(0, cut1))).toBe(false);
    expect(s.feed(RAW_FAILURE_CHUNK.slice(cut1, cut2))).toBe(false);
    expect(s.feed(RAW_FAILURE_CHUNK.slice(cut2, cut3))).toBe(false);
    expect(s.feed(RAW_FAILURE_CHUNK.slice(cut3))).toBe(true);
  });

  it("trips one character at a time", () => {
    const s = scanner();
    let tripped = false;
    for (const char of RAW_FAILURE_CHUNK) {
      if (s.feed(char)) tripped = true;
    }
    expect(tripped).toBe(true);
  });

  it("stays tripped after the first hit", () => {
    const s = scanner();
    s.feed(RAW_FAILURE_CHUNK);
    expect(s.feed("anything")).toBe(true);
  });
});

describe("executeResumeInjection", () => {
  it("hands capture off and records lineage only after swap evidence, in order", async () => {
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
        expect(message).toContain(`resuming in-place as ${NEW_ID}`);
      },
      recordLineage,
      windowMs: 5,
      sleep: async () => {},
      statRollout: statSequence({ size: 100, mtimeMs: 1 }, { size: 130, mtimeMs: 2 }),
    });

    expect(result).toEqual({ ok: true, captureSession: newCapture });
    expect(written).toEqual([`/resume ${NEW_ID}\r`, REPAINT_NUDGE]);
    expect(recordLineage).toHaveBeenCalledWith({ sessionId: NEW_ID, threadId: "th_same" });
    expect(order).toEqual(["log", "inject", "inject", "lineage", "stop", "capture:/tmp/new.jsonl"]);
  });

  it("calls onBeforeInject immediately before the /resume pty write", async () => {
    const order: string[] = [];
    const captureSession = fakeCaptureSession(order);

    await executeResumeInjection({
      plan: PLAN,
      captureSession,
      onBeforeInject: () => {
        order.push("before-inject");
      },
      writeToPty: (data) => {
        order.push(`pty:${data}`);
      },
      onOutput: () => () => {},
      startCapture: () => ({ stats: {} }) as unknown as CaptureSession,
      logResume: () => {},
      windowMs: 5,
      sleep: async () => {},
      statRollout: statSequence({ size: 100, mtimeMs: 1 }, { size: 130, mtimeMs: 2 }),
    });

    const beforeIdx = order.indexOf("before-inject");
    const injectIdx = order.indexOf(`pty:/resume ${NEW_ID}\r`);
    expect(beforeIdx).toBeGreaterThan(-1);
    expect(injectIdx).toBeGreaterThan(beforeIdx);
  });

  it("injects the repaint nudge only after a confirmed swap, never on failure", async () => {
    const written: string[] = [];

    const failed = await executeResumeInjection({
      plan: PLAN,
      captureSession: fakeCaptureSession([]),
      writeToPty: (data) => {
        written.push(data);
      },
      onOutput: () => () => {},
      startCapture: () => {
        throw new Error("must not start a new capture on failure");
      },
      logResume: () => {},
      windowMs: 5,
      confirmExtraMs: 500,
      sleep: async () => {},
      statRollout: statSequence({ size: 100, mtimeMs: 1 }, { size: 100, mtimeMs: 1 }),
    });

    expect(failed).toEqual({ ok: false, reason: "no_swap_evidence" });
    expect(written).toEqual([`/resume ${NEW_ID}\r`]);
  });

  it("treats a trip as failure when the rollout never grew: no lineage, old capture untouched", async () => {
    const order: string[] = [];
    const captureSession = fakeCaptureSession(order);
    const recordLineage = vi.fn(async () => {});
    let emitOutput: ((data: string) => void) | undefined;
    let unsubscribed = false;

    const result = await executeResumeInjection({
      plan: PLAN,
      captureSession,
      writeToPty: () => {
        queueMicrotask(() => {
          const cut = RAW_FAILURE_CHUNK.indexOf("not");
          emitOutput?.(RAW_FAILURE_CHUNK.slice(0, cut));
          emitOutput?.(RAW_FAILURE_CHUNK.slice(cut));
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
      recordLineage,
      windowMs: 5_000,
      sleep: async () => {},
      statRollout: statSequence({ size: 100, mtimeMs: 1 }, { size: 100, mtimeMs: 1 }),
    });

    expect(result).toEqual({ ok: false, reason: "no_swap_evidence" });
    expect(unsubscribed).toBe(true);
    expect(recordLineage).not.toHaveBeenCalled();
    expect(order).not.toContain("stop");
  });

  it("rescues a trip when the rollout grew anyway (false positive self-heals)", async () => {
    const order: string[] = [];
    const captureSession = fakeCaptureSession(order);
    const newCapture = { stats: {} } as unknown as CaptureSession;
    let emitOutput: ((data: string) => void) | undefined;

    const result = await executeResumeInjection({
      plan: PLAN,
      captureSession,
      writeToPty: () => {
        queueMicrotask(() => {
          emitOutput?.(RAW_FAILURE_CHUNK);
        });
      },
      onOutput: (listener) => {
        emitOutput = listener;
        return () => {};
      },
      startCapture: () => newCapture,
      logResume: () => {},
      windowMs: 5_000,
      sleep: async () => {},
      statRollout: statSequence({ size: 100, mtimeMs: 1 }, { size: 145, mtimeMs: 3 }),
    });

    expect(result).toEqual({ ok: true, captureSession: newCapture });
    expect(order).toContain("stop");
  });

  it("fails when no trip fires but the rollout never shows swap evidence", async () => {
    const order: string[] = [];
    const captureSession = fakeCaptureSession(order);
    const recordLineage = vi.fn(async () => {});

    const result = await executeResumeInjection({
      plan: PLAN,
      captureSession,
      writeToPty: () => {},
      onOutput: () => () => {},
      startCapture: () => {
        throw new Error("must not start a new capture on failure");
      },
      logResume: () => {},
      recordLineage,
      windowMs: 5,
      confirmExtraMs: 500,
      sleep: async () => {},
      statRollout: statSequence({ size: 100, mtimeMs: 1 }, { size: 100, mtimeMs: 1 }),
    });

    expect(result).toEqual({ ok: false, reason: "no_swap_evidence" });
    expect(recordLineage).not.toHaveBeenCalled();
    expect(order).not.toContain("stop");
  });

  it("keeps polling past the window and succeeds when growth arrives late", async () => {
    const captureSession = fakeCaptureSession([]);
    const newCapture = { stats: {} } as unknown as CaptureSession;

    const result = await executeResumeInjection({
      plan: PLAN,
      captureSession,
      writeToPty: () => {},
      onOutput: () => () => {},
      startCapture: () => newCapture,
      logResume: () => {},
      windowMs: 5,
      confirmExtraMs: 2_000,
      sleep: async () => {},
      statRollout: statSequence(
        { size: 100, mtimeMs: 1 },
        { size: 100, mtimeMs: 1 },
        { size: 100, mtimeMs: 1 },
        { size: 160, mtimeMs: 4 },
      ),
    });

    expect(result.ok).toBe(true);
  });

  it("proceeds with the handoff when the lineage write fails", async () => {
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
      sleep: async () => {},
      statRollout: statSequence({ size: 100, mtimeMs: 1 }, { size: 130, mtimeMs: 2 }),
    });

    expect(result.ok).toBe(true);
    expect(lineageErrors.some((line) => line.includes("lineage write failed (continuing)"))).toBe(true);
  });

  it("aborts before injecting anything when a turn opened during the rebuild", async () => {
    const order: string[] = [];
    const captureSession = fakeCaptureSession(order);
    const written: string[] = [];
    const logs: string[] = [];

    const result = await executeResumeInjection({
      plan: PLAN,
      captureSession,
      writeToPty: (data) => {
        written.push(data);
      },
      onOutput: () => () => {},
      startCapture: () => {
        throw new Error("must not start a new capture on abort");
      },
      logResume: (message) => {
        logs.push(message);
      },
      isTurnOpen: () => true,
      windowMs: 5,
      sleep: async () => {},
      statRollout: statSequence({ size: 100, mtimeMs: 1 }, { size: 130, mtimeMs: 2 }),
    });

    expect(result).toEqual({ ok: false, reason: "turn_open" });
    expect(written).toEqual([]);
    expect(logs).toEqual([]);
    expect(order).not.toContain("stop");
  });

  it("records a silent runtime_note when the old rollout grew past the rebuild cutoff", async () => {
    const order: string[] = [];
    const recorded: unknown[][] = [];
    const captureSession = fakeCaptureSession(order, {
      messageEvents: async (_threadRef, events) => {
        recorded.push(events);
        return { ok: true, value: { events: [] } };
      },
    });
    const plan: SessionRestartPlan = { ...PLAN, oldRolloutPath: "/tmp/old.jsonl", oldRolloutSizeAtRebuild: 500 };
    const statByPath = statByPathFake({ size: 650, mtimeMs: 9 });

    const result = await executeResumeInjection({
      plan,
      captureSession,
      writeToPty: () => {},
      onOutput: () => () => {},
      startCapture: () => ({ stats: {} }) as unknown as CaptureSession,
      logResume: () => {},
      windowMs: 5,
      sleep: async () => {},
      statRollout: statByPath,
    });

    expect(result.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    const note = recorded[0]![0] as { eventKind: string; idempotencyKey: string; payload: { text: string } };
    expect(note.eventKind).toBe("runtime_note");
    expect(note.idempotencyKey).toBe(`cc-lhc:swap-collision:${NEW_ID}`);
    expect(note.payload.text).toBe(formatSwapCollisionNote(plan, 500, 650));
    // The old capture stopped (final flush) before the collision was measured.
    expect(order).toContain("stop");
  });

  it("records nothing when the old rollout did not grow", async () => {
    const recorded: unknown[][] = [];
    const captureSession = fakeCaptureSession([], {
      messageEvents: async (_threadRef, events) => {
        recorded.push(events);
        return { ok: true, value: { events: [] } };
      },
    });
    const plan: SessionRestartPlan = { ...PLAN, oldRolloutPath: "/tmp/old.jsonl", oldRolloutSizeAtRebuild: 500 };
    const statByPath = statByPathFake({ size: 500, mtimeMs: 9 });

    const result = await executeResumeInjection({
      plan,
      captureSession,
      writeToPty: () => {},
      onOutput: () => () => {},
      startCapture: () => ({ stats: {} }) as unknown as CaptureSession,
      logResume: () => {},
      windowMs: 5,
      sleep: async () => {},
      statRollout: statByPath,
    });

    expect(result.ok).toBe(true);
    expect(recorded).toEqual([]);
  });

  it("keeps the handoff alive when the collision note write fails", async () => {
    const captureSession = fakeCaptureSession([], {
      messageEvents: async () => {
        throw new Error("thread db locked");
      },
    });
    const plan: SessionRestartPlan = { ...PLAN, oldRolloutPath: "/tmp/old.jsonl", oldRolloutSizeAtRebuild: 500 };
    const statByPath = statByPathFake({ size: 650, mtimeMs: 9 });

    const result = await executeResumeInjection({
      plan,
      captureSession,
      writeToPty: () => {},
      onOutput: () => () => {},
      startCapture: () => ({ stats: {} }) as unknown as CaptureSession,
      logResume: () => {},
      windowMs: 5,
      sleep: async () => {},
      statRollout: statByPath,
    });

    expect(result.ok).toBe(true);
  });

  it("returns ok and logs when post-confirm capture stop throws", async () => {
    const order: string[] = [];
    const handoffErrors: string[] = [];
    const captureSession = fakeCaptureSession(order);
    captureSession.stop = vi.fn(async () => {
      order.push("stop");
      throw new Error("sdk drain rejected");
    });

    const result = await executeResumeInjection({
      plan: PLAN,
      captureSession,
      writeToPty: () => {},
      onOutput: () => () => {},
      startCapture: () => {
        throw new Error("must not start capture after stop failure");
      },
      logResume: () => {},
      logHandoffError: (message) => {
        handoffErrors.push(message);
      },
      windowMs: 5,
      sleep: async () => {},
      statRollout: statSequence({ size: 100, mtimeMs: 1 }, { size: 130, mtimeMs: 2 }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.captureSession).toBe(captureSession);
    expect(handoffErrors.some((line) => line.includes("resume handoff failed (swap confirmed)"))).toBe(true);
    expect(handoffErrors.some((line) => line.includes("sdk drain rejected"))).toBe(true);
    expect(order).toContain("stop");
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
        sleep: async () => {},
      }),
    ).rejects.toThrow("capture session required");
  });
});

describe("receipt formatting", () => {
  it("success receipt has no restart language and carries the reintake estimate", () => {
    const message = formatResumeSuccess(PLAN);
    expect(message).toContain(`resumed in-place as ${NEW_ID}`);
    expect(message).toContain("~4 replayed lines");
    expect(message).not.toMatch(/restart/i);
  });

  it("turn-open abort receipt tells the truth about the partial state", () => {
    const message = formatResumeAbortTurnOpen(PLAN);
    expect(message).toContain("turn opened during rebuild");
    expect(message).toContain("live session old-session untouched");
    expect(message).toContain("thread view is already compacted/pruned");
    expect(message).toContain("next successful swap will serve it");
    expect(message).toContain("rerun when idle");
  });

  it("failure receipt names the manual command and the still-live session", () => {
    const message = formatResumeFailure(PLAN);
    expect(message).toContain(`/resume ${NEW_ID}`);
    expect(message).toContain("still live");
  });
});
