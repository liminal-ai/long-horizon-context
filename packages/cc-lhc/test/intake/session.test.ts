import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Lhc, ThreadRef } from "lhc";

import { encodeProjectPath } from "../../src/rollout/discover.js";
import {
  awaitDrainSettled,
  DRAIN_NOT_SETTLED_MESSAGE,
  startCaptureSession,
} from "../../src/intake/session.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

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
    expect(session.stats.threadId).not.toBeNull();
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

describe("awaitDrainSettled", () => {
  it("logs and proceeds when drainSettled does not resolve before cap", async () => {
    const errors: string[] = [];
    const threadRef = { threadId: "test-thread" } as ThreadRef;
    await awaitDrainSettled(
      { drainSettled: () => new Promise<void>(() => {}) } as unknown as Lhc,
      threadRef,
      { capMs: 20, logError: (message) => errors.push(message) },
    );
    expect(errors).toContain(DRAIN_NOT_SETTLED_MESSAGE);
  });
});

function appendLine(filePath: string, item: RolloutLineItem): void {
  writeFileSync(filePath, `${JSON.stringify(item)}\n`, { flag: "a" });
}
