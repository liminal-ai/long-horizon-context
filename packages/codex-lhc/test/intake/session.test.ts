import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Lhc, ThreadRef } from "lhc";

import {
  awaitDrainSettled,
  DRAIN_NOT_SETTLED_MESSAGE,
  startCaptureSession,
} from "../../src/intake/session.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";
import { emptyCaptureStats } from "../../src/stats.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440099";

// Isolate every test from the real ~/.codex-lhc: default registry/lineage/thread
// paths all derive from CODEX_LHC_HOME at call time.
const originalCodexLhcHome = process.env.CODEX_LHC_HOME;
beforeEach(() => {
  process.env.CODEX_LHC_HOME = mkdtempSync(join(tmpdir(), "codex-lhc-home-"));
});
afterEach(() => {
  if (originalCodexLhcHome === undefined) delete process.env.CODEX_LHC_HOME;
  else process.env.CODEX_LHC_HOME = originalCodexLhcHome;
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function rolloutPath(codexHome: string, sessionId: string = SESSION_ID): string {
  const dayDir = join(codexHome, "sessions", "2026", "07", "07");
  mkdirSync(dayDir, { recursive: true });
  return join(dayDir, `rollout-2026-07-07T12-00-00-${sessionId}.jsonl`);
}

function minimalUserLine(content: string): RolloutLineItem {
  return {
    timestamp: "2026-07-07T12:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: content }],
    },
  };
}

describe("startCaptureSession stop()", () => {
  it("awaits in-flight batch flush before returning", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-session-"));
    const cwd = "/work/session-stop-test";
    const filePath = rolloutPath(codexHome);
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(
      filePath,
      `${JSON.stringify(minimalUserLine("first"))}\n`,
    );

    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const flushedBatches: number[] = [];
    let flushCalls = 0;

    const session = startCaptureSession({
      cwd,
      startedAt,
      noInference: true,
      discoverDeps: { expectedCwd: undefined, codexHome, pollMs: 20 },
      log: () => {},
      logError: () => {},
      flushBatchFn: async (_sdk, _threadRef, items: RolloutLineItem[]) => {
        flushCalls += 1;
        if (flushCalls === 1) await firstGate;
        flushedBatches.push(items.length);
      },
    });

    for (let attempt = 0; attempt < 50 && flushCalls < 1; attempt += 1) {
      await sleep(50);
    }
    expect(flushCalls).toBe(1);

    appendLine(filePath, minimalUserLine("second"));
    await sleep(100);

    releaseFirst?.();
    const stopPromise = session.stop();
    await expect(stopPromise).resolves.toBeUndefined();

    expect(flushedBatches).toEqual([1, 1]);
    expect(flushCalls).toBe(2);
    expect(session.stats.linesSeen).toBe(2);
  });

  it("aborts discovery when stopped before session file is found", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-session-abort-"));
    const cwd = "/work/no-rollout-yet";
    mkdirSync(join(codexHome, "sessions", "2026", "07", "07"), { recursive: true });

    let pollCount = 0;
    const session = startCaptureSession({
      cwd,
      startedAt: new Date(),
      noInference: true,
      discoverDeps: {
        expectedCwd: undefined,
        codexHome,
        pollMs: 20,
        sleep: async () => {
          pollCount += 1;
        },
      },
      log: () => {},
      logError: () => {},
    });

    await sleep(80);
    await session.stop();

    expect(pollCount).toBeGreaterThan(0);
    expect(session.stats.threadId).toBeNull();
  });

  it("awaits drainSettled after batch flush when inference is enabled", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-session-drain-"));
    const cwd = "/work/session-drain-test";
    const filePath = rolloutPath(codexHome);
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(filePath, `${JSON.stringify(minimalUserLine("hello"))}\n`);

    let batchFlushed = false;
    let drainAfterBatch = false;
    const drainSettledSpy = async () => {
      drainAfterBatch = batchFlushed;
    };

    const session = startCaptureSession({
      cwd,
      startedAt,
      discoverDeps: { expectedCwd: undefined, codexHome, pollMs: 20 },
      log: () => {},
      logError: () => {},
      flushBatchFn: async () => {
        batchFlushed = true;
      },
      initSdkFn: () =>
        ({
          drainSettled: drainSettledSpy,
        }) as unknown as Lhc,
    });

    for (let attempt = 0; attempt < 50 && !batchFlushed; attempt += 1) {
      await sleep(50);
    }
    expect(batchFlushed).toBe(true);

    await session.stop();
    expect(drainAfterBatch).toBe(true);
  });

  it("caps drainSettled wait at stop and logs when work remains pending", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-session-drain-cap-"));
    const cwd = "/work/session-drain-cap";
    const filePath = rolloutPath(codexHome);
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(filePath, `${JSON.stringify(minimalUserLine("hello"))}\n`);

    const errors: string[] = [];
    const session = startCaptureSession({
      cwd,
      startedAt,
      discoverDeps: { expectedCwd: undefined, codexHome, pollMs: 20 },
      log: () => {},
      logError: (message) => {
        errors.push(message);
      },
      drainSettledCapMs: 30,
      initSdkFn: () => pendingDrainSdk(2, 1),
    });

    await sleep(200);
    await session.stop();
    expect(errors.some((line) => line.includes(DRAIN_NOT_SETTLED_MESSAGE))).toBe(true);
    expect(errors.some((line) => line.includes("3 derivation pending"))).toBe(true);
  });

  it("does not log drain timeout when derivation queue is empty", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-session-drain-quiet-"));
    const cwd = "/work/session-drain-quiet";
    const filePath = rolloutPath(codexHome);
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(filePath, `${JSON.stringify(minimalUserLine("hello"))}\n`);

    const errors: string[] = [];
    const session = startCaptureSession({
      cwd,
      startedAt,
      discoverDeps: { expectedCwd: undefined, codexHome, pollMs: 20 },
      log: () => {},
      logError: (message) => {
        errors.push(message);
      },
      drainSettledCapMs: 30,
      initSdkFn: () => pendingDrainSdk(0, 0),
    });

    await sleep(200);
    await session.stop();
    expect(errors.some((line) => line.includes(DRAIN_NOT_SETTLED_MESSAGE))).toBe(false);
  });
});

describe("resume handoff capture", () => {
  it("tails a known rollout path directly without discovery", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-lhc-home-known-path-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-known-codex-"));
    const rolloutPathValue = rolloutPath(codexHome, "rebuilt-session-uuid");
    writeFileSync(rolloutPathValue, `${JSON.stringify(minimalUserLine("rebuilt line"))}\n`);

    const stats = emptyCaptureStats();
    stats.threadId = "th_known";
    const flushedItems: RolloutLineItem[] = [];
    const session = startCaptureSession({
      cwd: "/work/known-path",
      startedAt: new Date(),
      noInference: true,
      lineageDbPath: join(home, "codex-lhc.sqlite"),
      knownRolloutPath: rolloutPathValue,
      continueCapture: {
        threadRef: { threadId: "th_known", registryPath: join(home, "registry.sqlite") },
        sdk: { drainSettled: async () => {} } as unknown as Lhc,
        stats,
      },
      discoverDeps: { expectedCwd: undefined, codexHome: join(codexHome, "missing"), pollMs: 20 },
      log: () => {},
      logError: () => {},
      flushBatchFn: async (_sdk, _threadRef, items: RolloutLineItem[]) => {
        flushedItems.push(...items);
      },
    });

    for (let attempt = 0; attempt < 50 && flushedItems.length < 1; attempt += 1) {
      await sleep(50);
    }
    expect(flushedItems).toHaveLength(1);
    expect(session.getRolloutInfo().path).toBe(rolloutPathValue);
    expect(session.getRolloutInfo().sessionId).toBe("rebuilt-session-uuid");
    await session.stop();
  });

  it("counts replayed-prefix lines under replayedPrefixLines without inflating linesSeen or skip tallies", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-lhc-home-prefix-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-prefix-rollout-"));
    const rolloutPathValue = rolloutPath(codexHome, "rebuilt-prefix-uuid");
    writeFileSync(
      rolloutPathValue,
      `${JSON.stringify({ timestamp: "2026-07-07T12:00:00.000Z", type: "turn_context", payload: { turn_id: "t1" } })}\n${JSON.stringify({ timestamp: "2026-07-07T12:00:01.000Z", type: "event_msg", payload: { type: "token_count" } })}\n`,
    );

    const stats = emptyCaptureStats();
    stats.threadId = "th_prefix";
    stats.linesSeen = 10;
    stats.skippedUnknown = 5;
    const session = startCaptureSession({
      cwd: "/work/prefix-stats",
      startedAt: new Date(),
      noInference: true,
      lineageDbPath: join(home, "codex-lhc.sqlite"),
      knownRolloutPath: rolloutPathValue,
      replayedPrefixLines: 2,
      continueCapture: {
        threadRef: { threadId: "th_prefix", registryPath: join(home, "registry.sqlite") },
        sdk: { drainSettled: async () => {} } as unknown as Lhc,
        stats,
      },
      log: () => {},
      logError: () => {},
    });

    for (let attempt = 0; attempt < 50 && session.stats.replayedPrefixLines < 2; attempt += 1) {
      await sleep(50);
    }
    expect(session.stats.replayedPrefixLines).toBe(2);
    expect(session.stats.linesSeen).toBe(10);
    expect(session.stats.skippedUnknown).toBe(5);
    expect(session.stats.skippedReplay).toBe(0);

    appendLine(rolloutPathValue, {
      timestamp: "2026-07-07T12:00:02.000Z",
      type: "event_msg",
      payload: { type: "token_count" },
    } as RolloutLineItem);
    for (let attempt = 0; attempt < 50 && session.stats.linesSeen < 11; attempt += 1) {
      await sleep(50);
    }
    expect(session.stats.linesSeen).toBe(11);
    expect(session.stats.skippedUnknown).toBe(6);
    expect(session.stats.replayedPrefixLines).toBe(2);
    await session.stop();
  });
});

function pendingDrainSdk(pending: number, retrying = 0): Lhc {
  return {
    drainSettled: () => new Promise<void>(() => {}),
    threadView: {
      status: async () => ({
        ok: true,
        value: {
          tailTokens: 0,
          threshold: 0,
          compactRecommended: false,
          derivation: { pending, retrying, failed: 0, blocked: 0 },
          view: null,
          visibility: { boundaryPosition: 0, zoneTokens: 0, maxTokens: 32_000 },
        },
      }),
    },
  } as unknown as Lhc;
}

describe("awaitDrainSettled", () => {
  it("logs and proceeds when drainSettled does not resolve before cap", async () => {
    const errors: string[] = [];
    const threadRef = { threadId: "test-thread" } as ThreadRef;
    await awaitDrainSettled(pendingDrainSdk(1), threadRef, {
      capMs: 20,
      logError: (message) => errors.push(message),
    });
    expect(errors.some((line) => line.includes(DRAIN_NOT_SETTLED_MESSAGE))).toBe(true);
    expect(errors.some((line) => line.includes("1 derivation pending"))).toBe(true);
  });

  it("stays quiet when the cap elapses but nothing is pending", async () => {
    const errors: string[] = [];
    const threadRef = { threadId: "test-thread" } as ThreadRef;
    await awaitDrainSettled(pendingDrainSdk(0), threadRef, {
      capMs: 20,
      logError: (message) => errors.push(message),
    });
    expect(errors).toHaveLength(0);
  });
});

function appendLine(filePath: string, item: RolloutLineItem): void {
  writeFileSync(filePath, `${JSON.stringify(item)}\n`, { flag: "a" });
}

describe("embedded session_meta accounting", () => {
  it("counts subsequent session_meta lines under embeddedSessionMeta", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-session-embedded-meta-"));
    const cwd = "/work/embedded-meta";
    const filePath = rolloutPath(codexHome, SESSION_ID);
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(
      filePath,
      `${JSON.stringify({
        timestamp: "2026-07-07T12:00:00.000Z",
        type: "session_meta",
        payload: { session_id: SESSION_ID, id: SESSION_ID, cwd },
      })}\n${JSON.stringify({
        timestamp: "2026-07-07T12:00:01.000Z",
        type: "session_meta",
        payload: { session_id: "other-session", id: "other-session", cwd },
      })}\n${JSON.stringify(minimalUserLine("hello"))}\n`,
    );

    const session = startCaptureSession({
      cwd,
      startedAt,
      noInference: true,
      discoverDeps: { expectedCwd: undefined, codexHome, pollMs: 20 },
      log: () => {},
      logError: () => {},
    });

    for (let attempt = 0; attempt < 50 && session.stats.linesSeen < 3; attempt += 1) {
      await sleep(50);
    }

    expect(session.stats.embeddedSessionMeta).toBe(1);
    expect(session.stats.linesSeen).toBe(3);
    await session.stop();
  });
});

describe("lineage wiring", () => {
  it("reuses a mapped thread instead of creating a new one", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-session-lineage-"));
    const home = mkdtempSync(join(tmpdir(), "codex-lhc-home-map-"));
    const dbPath = join(home, "codex-lhc.sqlite");
    const registryPath = join(home, "registry.sqlite");
    const cwd = "/work/lineage-session";
    const sessionId = SESSION_ID;
    const filePath = rolloutPath(codexHome, sessionId);
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(filePath, `${JSON.stringify(minimalUserLine("hello"))}\n`);

    const { recordSessionThread } = await import("../../src/intake/lineage-db.js");
    recordSessionThread(dbPath, sessionId, "th_mapped");

    let created = 0;
    const logs: string[] = [];
    const session = startCaptureSession({
      cwd,
      startedAt,
      noInference: true,
      lineageDbPath: dbPath,
      registryPath,
      discoverDeps: { expectedCwd: undefined, codexHome, pollMs: 20 },
      log: (message) => logs.push(message),
      logError: () => {},
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_should_not_create", registryPath } };
      },
      flushBatchFn: async () => {},
    });

    for (let attempt = 0; attempt < 50 && session.stats.threadId === null; attempt += 1) {
      await sleep(50);
    }

    expect(created).toBe(0);
    expect(session.stats.threadId).toBe("th_mapped");
    expect(logs.some((line) => line.includes("continuing thread th_mapped"))).toBe(true);
    await session.stop();
  });

  it("starts capture when lineage write fails", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-session-lineage-write-"));
    const home = mkdtempSync(join(tmpdir(), "codex-lhc-home-write-fail-"));
    const dbPath = join(home, "codex-lhc.sqlite");
    const registryPath = join(home, "registry.sqlite");
    const cwd = "/work/lineage-write-fail";
    const filePath = rolloutPath(codexHome, "write-fail-session");
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(filePath, `${JSON.stringify(minimalUserLine("hello"))}\n`);

    const errors: string[] = [];
    let flushed = false;
    let dbOpens = 0;
    const session = startCaptureSession({
      cwd,
      startedAt,
      noInference: true,
      lineageDbPath: dbPath,
      registryPath,
      discoverDeps: { expectedCwd: undefined, codexHome, pollMs: 20 },
      log: () => {},
      logError: (message) => errors.push(message),
      lineageDeps: {
        openDbFn: (path) => {
          dbOpens += 1;
          if (dbOpens > 1) throw new Error("disk full");
          return new DatabaseSync(path);
        },
      },
      createThreadFn: async () => ({ ok: true, value: { threadId: "th_write_fail", registryPath } }),
      flushBatchFn: async () => {
        flushed = true;
      },
    });

    for (let attempt = 0; attempt < 50 && !flushed; attempt += 1) {
      await sleep(50);
    }

    expect(session.stats.threadId).toBe("th_write_fail");
    expect(flushed).toBe(true);
    expect(errors.some((line) => line.includes("lineage write failed (continuing)"))).toBe(true);
    await session.stop();
  });

  it("starts capture with a new thread when lineage read fails", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-session-lineage-read-"));
    const home = mkdtempSync(join(tmpdir(), "codex-lhc-home-read-fail-"));
    const dbPath = join(home, "codex-lhc.sqlite");
    const registryPath = join(home, "registry.sqlite");
    const cwd = "/work/lineage-read-fail";
    const filePath = rolloutPath(codexHome, "read-fail-session");
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(filePath, `${JSON.stringify(minimalUserLine("hello"))}\n`);

    const errors: string[] = [];
    let created = 0;
    let flushed = false;
    const session = startCaptureSession({
      cwd,
      startedAt,
      noInference: true,
      lineageDbPath: dbPath,
      registryPath,
      discoverDeps: { expectedCwd: undefined, codexHome, pollMs: 20 },
      log: () => {},
      logError: (message) => errors.push(message),
      lineageDeps: {
        withDb: () => {
          throw new Error("lineage read fail");
        },
      },
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_read_fail", registryPath } };
      },
      flushBatchFn: async () => {
        flushed = true;
      },
    });

    for (let attempt = 0; attempt < 50 && !flushed; attempt += 1) {
      await sleep(50);
    }

    expect(created).toBe(1);
    expect(session.stats.threadId).toBe("th_read_fail");
    expect(flushed).toBe(true);
    expect(errors.some((line) => line.includes("lineage read failed (continuing)"))).toBe(true);
    await session.stop();
  });
});
