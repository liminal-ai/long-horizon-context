/**
 * Correction 9: session-level post-ready watcher runtime failure + stop-during-bind.
 */

import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Lhc, MessageEventInput, ThreadRef } from "lhc";
import { describe, expect, it } from "vitest";

import { startCaptureSession } from "../../src/intake/session.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import type { WatcherIo } from "../../src/rollout/watcher.js";
import { emptyCaptureStats } from "../../src/stats.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > capMs) throw new Error(`timeout: ${label}`);
    await sleep(25);
  }
}

describe("session watcher runtime + stop ownership", () => {
  it("post-ready fstat failure degrades, blocks mutation, no lure intake", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-sess-runtime-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/sess-runtime";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sid = "aaaaaaaa-bbbb-cccc-dddd-111111111111";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sid}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "u0", sessionId: sid, message: { role: "user", content: "seed" } })}\n`,
    );
    const lineageDbPath = join(root, "lineage.sqlite");
    const registryPath = join(root, "reg.sqlite");
    const intake: MessageEventInput[] = [];

    let failFstat = false;
    const realFstat = (await import("node:fs")).fstatSync;
    const io: Partial<WatcherIo> = {
      fstat: (fd) => {
        if (failFstat) throw new Error("injected session fstat fail");
        const st = realFstat(fd);
        return { size: st.size, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
      },
    };

    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      knownRolloutPath: path,
      prefixBoundary: { kind: "none" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath,
      registryPath,
      watcherIo: io,
      log: () => {},
      logError: () => {},
      createThreadFn: async () => ({
        ok: true,
        value: { threadId: "th_rt", registryPath } as ThreadRef,
      }),
      initSdkFn: () => ({}) as Lhc,
      flushBatchFn: async (_s, _t, _i, events) => {
        intake.push(...events);
      },
    });

    try {
      await waitFor(() => session.isCaptureReady(), "ready");
      expect(session.isCaptureReady()).toBe(true);
      failFstat = true;
      await waitFor(() => session.getCaptureHealth().phase === "degraded", "runtime degrade");
      expect(session.isCaptureReady()).toBe(false);
      expect(session.getCaptureHealth().reasons).toContain("watcher_runtime");
      appendFileSync(
        path,
        `${JSON.stringify({ type: "user", uuid: "lure", sessionId: sid, message: { role: "user", content: "lure-after-fail" } })}\n`,
      );
      await sleep(200);
      expect(JSON.stringify(intake)).not.toContain("lure-after-fail");
    } finally {
      await session.stop();
    }
  });

  it("stop during bind hold: no ready, no lifecycle, no SDK init, no watcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-sess-stop-bind-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/stop-bind";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sid = "bbbbbbbb-cccc-dddd-eeee-222222222222";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sid}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "u0", sessionId: sid, message: { role: "user", content: "seed" } })}\n`,
    );
    const lineageDbPath = join(root, "lineage.sqlite");
    const registryPath = join(root, "reg.sqlite");

    let release!: () => void;
    const bindHold = new Promise<void>((r) => {
      release = r;
    });
    let sdkInits = 0;
    let created = 0;
    let watcherConstructs = 0;
    const lifecycle: string[] = [];

    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      knownRolloutPath: path,
      prefixBoundary: { kind: "none" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath,
      registryPath,
      bindHold,
      watchRolloutFileFn: (() => {
        watcherConstructs += 1;
        return {
          initialCatchUp: Promise.resolve(),
          stop: () => {},
        };
      }) as typeof import("../../src/rollout/watcher.js").watchRolloutFile,
      log: () => {},
      logError: () => {},
      onLifecycle: (s) => {
        for (const x of s) lifecycle.push(x.kind);
      },
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_stop", registryPath } as ThreadRef };
      },
      initSdkFn: () => {
        sdkInits += 1;
        return {} as Lhc;
      },
      flushBatchFn: async () => {},
    });

    await sleep(50);
    await session.stop();
    release();
    await sleep(100);

    expect(session.isCaptureReady()).toBe(false);
    expect(session.getCaptureHealth().phase).toBe("closed");
    expect(lifecycle).not.toContain("session_bound");
    expect(lifecycle).toHaveLength(0);
    // Single bindHold gate is before resolve/init/watcher; stop wins ownership.
    expect(created).toBe(0);
    expect(sdkInits).toBe(0);
    expect(watcherConstructs).toBe(0);
  });

  it("stop during continued-capture bindHold: no ready, no lineage write, no watcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-sess-stop-cont-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/stop-cont";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sid = "cccccccc-dddd-eeee-ffff-333333333333";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sid}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "u0", sessionId: sid, message: { role: "user", content: "seed" } })}\n`,
    );
    const lineageDbPath = join(root, "lineage.sqlite");
    const registryPath = join(root, "reg.sqlite");

    let release!: () => void;
    const bindHold = new Promise<void>((r) => {
      release = r;
    });
    let watcherConstructs = 0;
    const lifecycle: string[] = [];
    const priorSdk = {} as Lhc;

    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "continue_resolved" },
      knownRolloutPath: path,
      prefixBoundary: { kind: "none" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath,
      registryPath,
      bindHold,
      continueCapture: {
        threadRef: { threadId: "th_prior", registryPath } as ThreadRef,
        sdk: priorSdk,
        stats: { ...emptyCaptureStats(), threadId: "th_prior" },
        priorGeneration: 1,
      },
      watchRolloutFileFn: (() => {
        watcherConstructs += 1;
        return {
          initialCatchUp: Promise.resolve(),
          stop: () => {},
        };
      }) as typeof import("../../src/rollout/watcher.js").watchRolloutFile,
      log: () => {},
      logError: () => {},
      onLifecycle: (s) => {
        for (const x of s) lifecycle.push(x.kind);
      },
      initSdkFn: () => {
        throw new Error("initSdk must not run on continueCapture");
      },
      flushBatchFn: async () => {},
    });

    await sleep(50);
    await session.stop();
    release();
    await sleep(100);

    expect(session.isCaptureReady()).toBe(false);
    expect(session.getCaptureHealth().phase).toBe("closed");
    expect(lifecycle).not.toContain("session_bound");
    expect(watcherConstructs).toBe(0);
    // No session→thread row written while stopped during bindHold.
    const { lookupSessionLineage } = await import("../../src/intake/lineage-db.js");
    expect(lookupSessionLineage(lineageDbPath, sid)).toBeUndefined();
  });
});
