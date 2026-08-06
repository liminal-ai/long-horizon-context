import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Lhc, ThreadRef } from "lhc";
import { describe, expect, it } from "vitest";
import { awaitDrainSettled, DRAIN_NOT_SETTLED_MESSAGE, startCaptureSession } from "../../src/intake/session.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";
import { emptyCaptureStats } from "../../src/stats.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("startCaptureSession stop()", () => {
  it("awaits in-flight batch flush before returning", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-session-"));
    const cwd = "/work/session-stop-test";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const rolloutPath = join(projectDir, "session.jsonl");
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        type: "user",
        uuid: "batch-one",
        message: { role: "user", content: "first" },
      })}\n`,
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
      discoverDeps: { projectsRoot, pollMs: 20 },
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

    appendLine(rolloutPath, {
      type: "user",
      uuid: "batch-two",
      message: { role: "user", content: "second" },
    });
    await sleep(100);

    releaseFirst?.();
    const stopPromise = session.stop();
    await expect(stopPromise).resolves.toBeUndefined();

    expect(flushedBatches).toEqual([1, 1]);
    expect(flushCalls).toBe(2);
    expect(session.stats.linesSeen).toBe(2);
  });

  it("aborts discovery when stopped before session file is found", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-session-abort-"));
    const cwd = "/work/no-rollout-yet";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });

    let pollCount = 0;
    const session = startCaptureSession({
      cwd,
      startedAt: new Date(),
      noInference: true,
      discoverDeps: {
        projectsRoot,
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
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-session-drain-"));
    const cwd = "/work/session-drain-test";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const rolloutPath = join(projectDir, "session.jsonl");
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        type: "user",
        uuid: "drain-one",
        message: { role: "user", content: "hello" },
      })}\n`,
    );

    let batchFlushed = false;
    let drainAfterBatch = false;
    const drainSettledSpy = async () => {
      drainAfterBatch = batchFlushed;
    };

    const session = startCaptureSession({
      cwd,
      startedAt,
      discoverDeps: { projectsRoot, pollMs: 20 },
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
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-session-drain-cap-"));
    const cwd = "/work/session-drain-cap";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const rolloutPath = join(projectDir, "session.jsonl");
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        type: "user",
        uuid: "drain-cap",
        message: { role: "user", content: "hello" },
      })}\n`,
    );

    const errors: string[] = [];
    const session = startCaptureSession({
      cwd,
      startedAt,
      discoverDeps: { projectsRoot, pollMs: 20 },
      log: () => {},
      logError: (message) => {
        errors.push(message);
      },
      drainSettledCapMs: 30,
      initSdkFn: () =>
        ({
          drainSettled: () => new Promise<void>(() => {}),
        }) as unknown as Lhc,
    });

    await sleep(200);
    await session.stop();
    expect(errors).toContain(DRAIN_NOT_SETTLED_MESSAGE);
  });
});

describe("resume handoff capture", () => {
  it("tails a known rollout path directly without discovery", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-home-known-path-"));
    const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-known-rollout-"));
    const rolloutPath = join(rolloutDir, "rebuilt-session.jsonl");
    writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        type: "user",
        uuid: "rebuilt-1",
        message: { role: "user", content: "rebuilt line" },
      })}\n`,
    );

    const stats = emptyCaptureStats();
    stats.threadId = "th_known";
    const flushedItems: RolloutLineItem[] = [];
    const session = startCaptureSession({
      cwd: "/work/known-path",
      startedAt: new Date(),
      noInference: true,
      lineageDbPath: join(home, "cc-lhc.sqlite"),
      knownRolloutPath: rolloutPath,
      continueCapture: {
        threadRef: { threadId: "th_known", registryPath: join(home, "registry.sqlite") },
        sdk: { drainSettled: async () => {} } as unknown as Lhc,
        stats,
      },
      // Discovery would never resolve here; knownRolloutPath must bypass it.
      discoverDeps: { projectsRoot: join(rolloutDir, "no-projects"), pollMs: 20 },
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
    expect(session.getRolloutInfo().path).toBe(rolloutPath);
    expect(session.getRolloutInfo().sessionId).toBe("rebuilt-session");
    await session.stop();
  });

  it("counts replayed-prefix lines under replayedPrefixLines without inflating linesSeen or skip tallies", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-home-prefix-"));
    const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-prefix-rollout-"));
    const rolloutPath = join(rolloutDir, "rebuilt-prefix.jsonl");
    // Two replayed-prefix lines that map to unknown skips (no events).
    writeFileSync(
      rolloutPath,
      `${JSON.stringify({ type: "mode", mode: "normal" })}\n${JSON.stringify({ type: "mode", mode: "normal" })}\n`,
    );

    const stats = emptyCaptureStats();
    stats.threadId = "th_prefix";
    stats.linesSeen = 10;
    stats.skippedUnknown = 5;
    const session = startCaptureSession({
      cwd: "/work/prefix-stats",
      startedAt: new Date(),
      noInference: true,
      lineageDbPath: join(home, "cc-lhc.sqlite"),
      knownRolloutPath: rolloutPath,
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

    // A genuinely new line past the prefix counts normally again.
    appendLine(rolloutPath, { type: "mode", mode: "normal" } as RolloutLineItem);
    for (let attempt = 0; attempt < 50 && session.stats.linesSeen < 11; attempt += 1) {
      await sleep(50);
    }
    expect(session.stats.linesSeen).toBe(11);
    expect(session.stats.skippedUnknown).toBe(6);
    expect(session.stats.replayedPrefixLines).toBe(2);
    await session.stop();
  });

  it("never re-records prefix lines: known and synthetic prefix content both stay out of intake", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-home-prefix-events-"));
    const dbPath = join(home, "cc-lhc.sqlite");
    const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-prefix-events-rollout-"));
    const rolloutPath = join(rolloutDir, "rebuilt-events.jsonl");

    // A realistic rebuilt prefix: one line whose content matches the original
    // capture (signature known) and one synthetic line a compact rebuild
    // produces (band summary — signature matches nothing). Neither may
    // re-enter intake: rebuilt bytes are ours, the thread already holds the
    // real history behind them.
    const userLine = {
      type: "user",
      uuid: "prefix-user",
      message: { role: "user", content: "please read the file" },
    } as RolloutLineItem;
    const syntheticLine = {
      type: "user",
      uuid: "prefix-synthetic",
      message: { role: "user", content: "[history summary] earlier work compressed to a band summary" },
    } as RolloutLineItem;
    writeFileSync(rolloutPath, `${JSON.stringify(userLine)}\n${JSON.stringify(syntheticLine)}\n`);

    // Persist only the first line's signature as already-seen — the state a
    // real handoff inherits for verbatim tail content. The synthetic line
    // deliberately has no known signature: it must be excluded by prefix
    // position alone, not by dedupe.
    const { mapRolloutLine } = await import("../../src/intake/map.js");
    const { eventContentSignature } = await import("../../src/intake/replay-dedupe.js");
    const { appendThreadSignatures } = await import("../../src/intake/lineage-db.js");
    const signatures = mapRolloutLine(userLine, 0).events.map((event) => eventContentSignature(event));
    expect(signatures).toHaveLength(1);
    appendThreadSignatures(dbPath, "th_prefix_events", signatures);

    const stats = emptyCaptureStats();
    stats.threadId = "th_prefix_events";
    stats.linesSeen = 10;
    stats.eventsSent = 8;
    const intakeCalls: number[] = [];
    const session = startCaptureSession({
      cwd: "/work/prefix-event-stats",
      startedAt: new Date(),
      noInference: true,
      lineageDbPath: dbPath,
      knownRolloutPath: rolloutPath,
      replayedPrefixLines: 2,
      continueCapture: {
        threadRef: { threadId: "th_prefix_events", registryPath: join(home, "registry.sqlite") },
        sdk: {
          drainSettled: async () => {},
          intakeStream: {
            messageEvents: async (_ref: unknown, events: unknown[]) => {
              intakeCalls.push(events.length);
              return { ok: true, value: { events: events.map(() => ({ outcome: "recorded" })) } };
            },
          },
        } as unknown as Lhc,
        stats,
      },
      log: () => {},
      logError: () => {},
    });

    for (let attempt = 0; attempt < 50 && session.stats.replayedPrefixLines < 2; attempt += 1) {
      await sleep(50);
    }
    // Both prefix lines counted once as prefix lines, zero events produced —
    // the synthetic line included, despite dedupe never having seen it.
    expect(session.stats.replayedPrefixLines).toBe(2);
    expect(session.stats.skippedReplay).toBe(0);
    expect(session.stats.linesSeen).toBe(10);
    expect(session.stats.eventsSent).toBe(8);
    expect(intakeCalls).toEqual([]);

    // A genuinely new post-prefix line intakes normally.
    appendLine(rolloutPath, {
      type: "user",
      uuid: "post-prefix-user",
      message: { role: "user", content: "a brand new prompt" },
    } as RolloutLineItem);
    for (let attempt = 0; attempt < 50 && session.stats.eventsSent < 9; attempt += 1) {
      await sleep(50);
    }
    expect(session.stats.linesSeen).toBe(11);
    expect(session.stats.eventsSent).toBe(9);
    expect(session.stats.skippedReplay).toBe(0);
    expect(session.stats.replayedPrefixLines).toBe(2);
    await session.stop();
  });
});

describe("awaitDrainSettled", () => {
  it("logs and proceeds when drainSettled does not resolve before cap", async () => {
    const errors: string[] = [];
    const threadRef = { threadId: "test-thread" } as ThreadRef;
    await awaitDrainSettled({ drainSettled: () => new Promise<void>(() => {}) } as unknown as Lhc, threadRef, {
      capMs: 20,
      logError: (message) => errors.push(message),
    });
    expect(errors).toContain(DRAIN_NOT_SETTLED_MESSAGE);
  });
});

function appendLine(filePath: string, item: RolloutLineItem): void {
  writeFileSync(filePath, `${JSON.stringify(item)}\n`, { flag: "a" });
}

describe("lineage wiring", () => {
  it("reuses a mapped thread instead of creating a new one", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-session-lineage-"));
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-home-map-"));
    const dbPath = join(home, "cc-lhc.sqlite");
    const registryPath = join(home, "registry.sqlite");
    const cwd = "/work/lineage-session";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const sessionId = "mapped-session";
    const rolloutPath = join(projectDir, `${sessionId}.jsonl`);
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        type: "user",
        uuid: "line-1",
        message: { role: "user", content: "hello" },
      })}\n`,
    );

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
      discoverDeps: { projectsRoot, pollMs: 20 },
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
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-session-lineage-write-"));
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-home-write-fail-"));
    const dbPath = join(home, "cc-lhc.sqlite");
    const registryPath = join(home, "registry.sqlite");
    const cwd = "/work/lineage-write-fail";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const sessionId = "write-fail-session";
    const rolloutPath = join(projectDir, `${sessionId}.jsonl`);
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        type: "user",
        uuid: "line-1",
        message: { role: "user", content: "hello" },
      })}\n`,
    );

    const errors: string[] = [];
    let flushed = false;
    let dbOpens = 0;
    const session = startCaptureSession({
      cwd,
      startedAt,
      noInference: true,
      lineageDbPath: dbPath,
      registryPath,
      discoverDeps: { projectsRoot, pollMs: 20 },
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
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-session-lineage-read-"));
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-home-read-fail-"));
    const dbPath = join(home, "cc-lhc.sqlite");
    const registryPath = join(home, "registry.sqlite");
    const cwd = "/work/lineage-read-fail";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const sessionId = "read-fail-session";
    const rolloutPath = join(projectDir, `${sessionId}.jsonl`);
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        type: "user",
        uuid: "line-1",
        message: { role: "user", content: "hello" },
      })}\n`,
    );

    const errors: string[] = [];
    let created = 0;
    let flushed = false;
    const session = startCaptureSession({
      cwd,
      startedAt,
      noInference: true,
      lineageDbPath: dbPath,
      registryPath,
      discoverDeps: { projectsRoot, pollMs: 20 },
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

  it("continues restart capture when lineage signature read fails", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-session-restart-cont-"));
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-home-restart-cont-"));
    const dbPath = join(home, "cc-lhc.sqlite");
    const registryPath = join(home, "registry.sqlite");
    const cwd = "/work/restart-continue";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const sessionId = "restart-cont-session";
    const rolloutPath = join(projectDir, `${sessionId}.jsonl`);
    const startedAt = new Date(Date.now() - 60_000);

    writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        type: "user",
        uuid: "line-1",
        message: { role: "user", content: "hello" },
      })}\n`,
    );

    const errors: string[] = [];
    let flushed = false;
    const stats = emptyCaptureStats();
    stats.threadId = "th_restart";
    const threadRef = { threadId: "th_restart", registryPath };
    const sdk = { drainSettled: async () => {} } as unknown as Lhc;

    const session = startCaptureSession({
      cwd,
      startedAt,
      noInference: true,
      lineageDbPath: dbPath,
      registryPath,
      continueCapture: { threadRef, sdk, stats },
      discoverDeps: { projectsRoot, pollMs: 20 },
      log: () => {},
      logError: (message) => errors.push(message),
      lineageDeps: {
        withDb: () => {
          throw new Error("lineage read fail");
        },
      },
      flushBatchFn: async () => {
        flushed = true;
      },
    });

    for (let attempt = 0; attempt < 50 && !flushed; attempt += 1) {
      await sleep(50);
    }

    expect(session.stats.threadId).toBe("th_restart");
    expect(flushed).toBe(true);
    expect(errors.some((line) => line.includes("lineage read failed (continuing)"))).toBe(true);
    await session.stop();
  });
});
