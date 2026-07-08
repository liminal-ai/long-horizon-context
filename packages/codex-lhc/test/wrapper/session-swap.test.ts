import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { messages, type Lhc, type SessionThreadView, type ThreadRef } from "lhc";
import { afterEach, describe, expect, it } from "vitest";

import { defaultLineageDbPath, lookupThreadForSession } from "../../src/intake/lineage-db.js";
import { defaultRegistryPath } from "../../src/intake/paths.js";
import { type CaptureSession, startCaptureSession } from "../../src/intake/session.js";
import { writeRebuiltRollout } from "../../src/rollout/write-rebuilt.js";
import {
  executeSessionSwap,
  type ChildExit,
  type SwapChildControl,
  type SwapChildHandle,
} from "../../src/wrapper/session-swap.js";

const FAKE_CODEX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-codex.mjs");
const OLD_SESSION_ID = "550e8400-e29b-41d4-a716-446655440099";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempEnv(): { lhcHome: string; codexHome: string } {
  const lhcHome = mkdtempSync(join(tmpdir(), "codex-lhc-swap-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-swap-codex-"));
  process.env.CODEX_LHC_HOME = lhcHome;
  process.env.CODEX_LHC_FAKE_CODEX_HOME = codexHome;
  delete process.env.CODEX_LHC_NO_INFERENCE;
  return { lhcHome, codexHome };
}

function rolloutPath(codexHome: string, sessionId: string): string {
  const dayDir = join(codexHome, "sessions", "2026", "07", "07");
  mkdirSync(dayDir, { recursive: true });
  return join(dayDir, `rollout-2026-07-07T12-00-00-${sessionId}.jsonl`);
}

function writeOldRollout(codexHome: string): string {
  const path = rolloutPath(codexHome, OLD_SESSION_ID);
  const lines = [
    {
      timestamp: "2026-07-07T12:00:00.000Z",
      type: "session_meta",
      payload: { session_id: OLD_SESSION_ID, id: OLD_SESSION_ID, cwd: process.cwd(), cli_version: "0.142.5" },
    },
    {
      timestamp: "2026-07-07T12:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "old prompt" }] },
    },
    {
      timestamp: "2026-07-07T12:00:02.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "old answer" }] },
    },
  ];
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

function textBlocks(listed: Awaited<ReturnType<typeof messages.list>>): Array<{ kind: string; text: string }> {
  if (!listed.ok) throw new Error(`messages.list failed: ${listed.error.reason}`);
  const out: Array<{ kind: string; text: string }> = [];
  for (const message of listed.value) {
    const text = message.blocks
      .filter((block) => block.blockType === "text")
      .map((block) => block.content.text)
      .join("\n");
    out.push({ kind: message.kind, text });
  }
  return out;
}

async function waitForCaptureReady(session: CaptureSession): Promise<{ sdk: Lhc; threadRef: ThreadRef }> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ctx = session.getCommandContext();
    if (ctx.sdk !== undefined && ctx.threadRef !== undefined && session.stats.eventsSent >= 2) {
      return { sdk: ctx.sdk, threadRef: ctx.threadRef };
    }
    await sleep(25);
  }
  throw new Error("capture session did not become ready");
}

class ProcessHandle implements SwapChildHandle {
  private alive = true;
  private exitValue: ChildExit | undefined;
  private readonly waiters: Array<(exit: ChildExit) => void> = [];

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.on("exit", (code, signal) => {
      this.alive = false;
      this.exitValue = { exitCode: code ?? 0, ...(signal === null ? {} : { signal }) };
      for (const resolve of this.waiters.splice(0)) resolve(this.exitValue);
    });
  }

  kill(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  waitForExit(): Promise<ChildExit> {
    if (this.exitValue !== undefined) return Promise.resolve(this.exitValue);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  isAlive(): boolean {
    return this.alive;
  }
}

class FakeChildControl implements SwapChildControl {
  readonly spawned: string[][] = [];
  readonly killedSignals: NodeJS.Signals[] = [];
  private currentHandle: SwapChildHandle;
  failFirstSpawn = false;
  appendOnResume = true;
  resumeSleepMs = "120000";

  constructor(private readonly codexHome: string) {
    this.currentHandle = this.spawnFake([], { CODEX_LHC_FAKE_MODE: "sleep", CODEX_LHC_FAKE_SLEEP_MS: "120000" });
  }

  current(): SwapChildHandle {
    return this.currentHandle;
  }

  async stopCurrent(): Promise<void> {
    if (this.currentHandle.isAlive()) this.currentHandle.kill("SIGKILL");
    await this.currentHandle.waitForExit().catch(() => {});
  }

  async spawn(argv: string[]): Promise<SwapChildHandle> {
    this.spawned.push(argv);
    if (this.failFirstSpawn) {
      this.failFirstSpawn = false;
      throw new Error("simulated spawn failure");
    }
    const handle = this.spawnFake(argv, {
      CODEX_LHC_FAKE_MODE: "resume-append",
      CODEX_LHC_FAKE_RESUME_APPEND: this.appendOnResume ? "1" : "0",
      CODEX_LHC_FAKE_SLEEP_MS: this.appendOnResume ? "150" : this.resumeSleepMs,
    });
    this.currentHandle = handle;
    return handle;
  }

  private spawnFake(argv: string[], extraEnv: Record<string, string>): SwapChildHandle {
    const handle = new ProcessHandle(
      spawn(process.execPath, [FAKE_CODEX, ...argv], {
        env: {
          ...process.env,
          CODEX_LHC_FAKE_CODEX_HOME: this.codexHome,
          CODEX_LHC_FAKE_SESSION_ID: OLD_SESSION_ID,
          ...extraEnv,
        },
      }),
    );
    const originalKill = handle.kill.bind(handle);
    handle.kill = (signal: NodeJS.Signals): void => {
      this.killedSignals.push(signal);
      originalKill(signal);
    };
    return handle;
  }
}

const originalHome = process.env.CODEX_LHC_HOME;
const originalFakeHome = process.env.CODEX_LHC_FAKE_CODEX_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_LHC_HOME;
  else process.env.CODEX_LHC_HOME = originalHome;
  if (originalFakeHome === undefined) delete process.env.CODEX_LHC_FAKE_CODEX_HOME;
  else process.env.CODEX_LHC_FAKE_CODEX_HOME = originalFakeHome;
});

async function captureOldThread(codexHome: string, oldRollout: string): Promise<{
  session: CaptureSession;
  sdk: Lhc;
  threadRef: ThreadRef;
  view: SessionThreadView;
}> {
  const session = startCaptureSession({
    knownRolloutPath: oldRollout,
    noInference: true,
    discoverDeps: { codexHome, pollMs: 20 },
    log: () => {},
    logError: () => {},
  });
  const ready = await waitForCaptureReady(session);
  const view = await ready.sdk.threadView.getSessionThreadView(ready.threadRef);
  if (!view.ok) throw new Error(`view failed: ${view.error.reason}`);
  return { session, sdk: ready.sdk, threadRef: ready.threadRef, view: view.value };
}

describe("executeSessionSwap", () => {
  it("swaps to a rebuilt resume, records lineage, and hands capture past the replayed prefix", async () => {
    const { codexHome } = tempEnv();
    const oldRollout = writeOldRollout(codexHome);
    const old = await captureOldThread(codexHome, oldRollout);
    const control = new FakeChildControl(codexHome);
    const oldLinesSeen = old.session.stats.linesSeen;

    const result = await executeSessionSwap({
      session: old.session,
      threadRef: old.threadRef,
      view: old.view,
      sourceRolloutPath: oldRollout,
      sourceSessionId: OLD_SESSION_ID,
      op: "compact",
      tokensBefore: 100,
      tokensAfter: 10,
      child: control,
      codexHome,
      noInference: true,
      terminateGraceMs: 20,
      confirmWindowMs: 1_000,
      confirmPollMs: 25,
      log: () => {},
      logError: () => {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected successful swap");
    expect(result.confirmMode).toBe("growth");
    expect(control.killedSignals).toContain("SIGTERM");
    expect(control.spawned[0]?.slice(0, 2)).toEqual(["resume", result.rebuilt.sessionId]);
    expect(control.spawned[0]).toContain("model_auto_compact_token_limit=100000000");
    expect(lookupThreadForSession(defaultLineageDbPath(), result.rebuilt.sessionId)).toBe(
      "threadId" in old.threadRef ? old.threadRef.threadId : undefined,
    );

    for (
      let attempt = 0;
      attempt < 80 &&
      (result.captureSession.stats.replayedPrefixLines < result.rebuilt.replayedPrefixLines ||
        result.captureSession.stats.linesSeen < oldLinesSeen + 3);
      attempt += 1
    ) {
      await sleep(25);
    }
    expect(result.captureSession.stats.replayedPrefixLines).toBe(result.rebuilt.replayedPrefixLines);
    expect(result.captureSession.stats.linesSeen).toBe(oldLinesSeen + 3);

    const listed = await messages.list(old.threadRef);
    const texts = textBlocks(listed);
    expect(texts).toContainEqual(
      expect.objectContaining({ kind: "runtime_note", text: expect.stringContaining("codex-lhc compact") }),
    );
    expect(texts).toContainEqual(expect.objectContaining({ kind: "assistant_text", text: "resume append ok" }));

    await result.captureSession.stop();
    if (result.child.isAlive()) result.child.kill("SIGKILL");
    await result.child.waitForExit().catch(() => {});
  });

  it("leaves the current child and capture untouched when rebuild throws", async () => {
    let killed = false;
    const fakeHandle: SwapChildHandle = {
      kill: () => {
        killed = true;
      },
      waitForExit: async () => ({ exitCode: 0 }),
      isAlive: () => true,
    };
    const control = {
      current() {
        return fakeHandle;
      },
      spawn: async () => fakeHandle,
    };
    let stopped = false;
    const session = {
      stats: { linesSeen: 0 },
      getCommandContext: () => ({ captureDisabled: false, stats: {} as never, sdk: undefined, threadRef: undefined }),
      getRolloutInfo: () => ({ path: undefined, sessionId: undefined }),
      isTurnOpen: () => false,
      stop: async () => {
        stopped = true;
      },
    } as unknown as CaptureSession;

    const result = await executeSessionSwap({
      session,
      threadRef: { threadId: "th_throw", registryPath: defaultRegistryPath() },
      view: { threadId: "th_throw", entries: [] },
      sourceRolloutPath: "/tmp/rollout-2026-07-07T12-00-00-old.jsonl",
      op: "compact",
      child: control,
      writeRebuiltRolloutFn: async () => {
        throw new Error("boom");
      },
      logError: () => {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rebuild failure");
    expect(result.phase).toBe("rebuild");
    expect(killed).toBe(false);
    expect(stopped).toBe(false);
  });

  it("prints the manual new-session command and recovers the original session after respawn failure", async () => {
    const { codexHome } = tempEnv();
    const oldRollout = writeOldRollout(codexHome);
    const old = await captureOldThread(codexHome, oldRollout);
    const control = new FakeChildControl(codexHome);
    control.failFirstSpawn = true;
    const errors: string[] = [];

    const result = await executeSessionSwap({
      session: old.session,
      threadRef: old.threadRef,
      view: old.view,
      sourceRolloutPath: oldRollout,
      sourceSessionId: OLD_SESSION_ID,
      op: "prune",
      child: control,
      codexHome,
      noInference: true,
      terminateGraceMs: 20,
      confirmWindowMs: 200,
      confirmPollMs: 25,
      logError: (message) => errors.push(message),
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.phase !== "respawn") throw new Error("expected respawn failure");
    expect(result.phase).toBe("respawn");
    expect(result.recovered).toBe(true);
    expect(errors.some((line) => line.includes("manual recovery command: codex resume "))).toBe(true);
    expect(control.spawned[1]?.slice(0, 2)).toEqual(["resume", OLD_SESSION_ID]);
    await result.captureSession.stop();
    result.recoveryChild.kill("SIGKILL");
    await result.recoveryChild.waitForExit().catch(() => {});
  });

  it("confirms by child_alive when interactive resume loads history without appending", async () => {
    const { codexHome } = tempEnv();
    const oldRollout = writeOldRollout(codexHome);
    const old = await captureOldThread(codexHome, oldRollout);
    const control = new FakeChildControl(codexHome);
    control.appendOnResume = false;
    const oldLinesSeen = old.session.stats.linesSeen;

    const result = await executeSessionSwap({
      session: old.session,
      threadRef: old.threadRef,
      view: old.view,
      sourceRolloutPath: oldRollout,
      sourceSessionId: OLD_SESSION_ID,
      op: "compact",
      child: control,
      codexHome,
      noInference: true,
      terminateGraceMs: 20,
      confirmWindowMs: 120,
      confirmPollMs: 25,
      logError: () => {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected child-alive success");
    expect(result.confirmMode).toBe("child_alive");
    expect(result.receipt.confirmMode).toBe("child_alive");
    expect(lookupThreadForSession(defaultLineageDbPath(), result.rebuilt.sessionId)).toBe(
      "threadId" in old.threadRef ? old.threadRef.threadId : undefined,
    );
    expect(control.spawned[0]?.slice(0, 2)).not.toEqual(["resume", OLD_SESSION_ID]);
    expect(control.spawned).toHaveLength(1);
    for (
      let attempt = 0;
      attempt < 80 &&
      (result.captureSession.stats.replayedPrefixLines < result.rebuilt.replayedPrefixLines ||
        result.captureSession.stats.linesSeen < oldLinesSeen + 2 ||
        result.captureSession.getRolloutInfo().path !== result.rebuilt.rolloutPath);
      attempt += 1
    ) {
      await sleep(25);
    }
    expect(result.captureSession.getRolloutInfo().path).toBe(result.rebuilt.rolloutPath);
    expect(result.captureSession.stats.replayedPrefixLines).toBe(result.rebuilt.replayedPrefixLines);
    expect(result.captureSession.stats.linesSeen).toBe(oldLinesSeen + 2);
    await result.captureSession.stop();
    if (result.child.isAlive()) result.child.kill("SIGKILL");
    await result.child.waitForExit().catch(() => {});
  });

  it("recovers the original session when no-growth child exits before confirm", async () => {
    const { codexHome } = tempEnv();
    const oldRollout = writeOldRollout(codexHome);
    const old = await captureOldThread(codexHome, oldRollout);
    const control = new FakeChildControl(codexHome);
    control.appendOnResume = false;
    control.resumeSleepMs = "10";

    const result = await executeSessionSwap({
      session: old.session,
      threadRef: old.threadRef,
      view: old.view,
      sourceRolloutPath: oldRollout,
      sourceSessionId: OLD_SESSION_ID,
      op: "compact",
      child: control,
      codexHome,
      noInference: true,
      terminateGraceMs: 20,
      confirmWindowMs: 200,
      confirmPollMs: 25,
      logError: () => {},
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.phase !== "confirm") throw new Error("expected confirm failure");
    expect(result.phase).toBe("confirm");
    expect(result.recovered).toBe(true);
    expect(control.spawned[0]?.slice(0, 2)).not.toEqual(["resume", OLD_SESSION_ID]);
    expect(control.spawned[1]?.slice(0, 2)).toEqual(["resume", OLD_SESSION_ID]);
    await result.captureSession.stop();
    if (result.recoveryChild.isAlive()) result.recoveryChild.kill("SIGKILL");
    await result.recoveryChild.waitForExit().catch(() => {});
  });

  it("does not leave the failed new child running when recovery spawns", async () => {
    const { codexHome } = tempEnv();
    const oldRollout = writeOldRollout(codexHome);
    const old = await captureOldThread(codexHome, oldRollout);
    const control = new FakeChildControl(codexHome);
    control.appendOnResume = false;
    control.resumeSleepMs = "10";
    let failedNewAliveAtRecovery: boolean | undefined;
    let failedNew: SwapChildHandle | undefined;
    const originalSpawn = control.spawn.bind(control);
    control.spawn = async (argv: string[]) => {
      const child = await originalSpawn(argv);
      if (control.spawned.length === 1) failedNew = child;
      if (argv[1] === OLD_SESSION_ID && failedNew !== undefined) {
        failedNewAliveAtRecovery = failedNew.isAlive();
      }
      return child;
    };

    const result = await executeSessionSwap({
      session: old.session,
      threadRef: old.threadRef,
      view: old.view,
      sourceRolloutPath: oldRollout,
      sourceSessionId: OLD_SESSION_ID,
      op: "compact",
      child: control,
      codexHome,
      noInference: true,
      terminateGraceMs: 20,
      confirmWindowMs: 200,
      confirmPollMs: 25,
      logError: () => {},
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.phase !== "confirm") throw new Error("expected confirm failure");
    expect(failedNewAliveAtRecovery).toBe(false);
    await result.captureSession.stop();
    if (result.recoveryChild.isAlive()) result.recoveryChild.kill("SIGKILL");
    await result.recoveryChild.waitForExit().catch(() => {});
  });

  it("returns recovery_failed when original-session recovery cannot spawn", async () => {
    const { codexHome } = tempEnv();
    const oldRollout = writeOldRollout(codexHome);
    const old = await captureOldThread(codexHome, oldRollout);
    const control = new FakeChildControl(codexHome);
    control.appendOnResume = false;
    control.resumeSleepMs = "5";
    const originalSpawn = control.spawn.bind(control);
    control.spawn = async (argv: string[]) => {
      const resumeIdx = argv.indexOf("resume");
      const sessionId = resumeIdx >= 0 ? argv[resumeIdx + 1] : undefined;
      if (sessionId === OLD_SESSION_ID) throw new Error("recovery spawn failed");
      return originalSpawn(argv);
    };

    const result = await executeSessionSwap({
      session: old.session,
      threadRef: old.threadRef,
      view: old.view,
      sourceRolloutPath: oldRollout,
      sourceSessionId: OLD_SESSION_ID,
      op: "compact",
      child: control,
      codexHome,
      noInference: true,
      terminateGraceMs: 20,
      confirmWindowMs: 150,
      confirmPollMs: 50,
      logError: () => {},
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.phase !== "recovery") throw new Error("expected recovery failure");
    expect(result.phase).toBe("recovery");
    expect(result.exitCode).toBe(1);
    expect(result.receipt.messages.at(-1)).toContain("codex resume");
  });

  it("passes log hooks through to post-swap direct capture", async () => {
    const { codexHome } = tempEnv();
    const oldRollout = writeOldRollout(codexHome);
    const old = await captureOldThread(codexHome, oldRollout);
    const control = new FakeChildControl(codexHome);
    const captureErrors: string[] = [];
    const consoleErrors: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };

    try {
      const result = await executeSessionSwap({
        session: old.session,
        threadRef: old.threadRef,
        view: old.view,
        sourceRolloutPath: oldRollout,
        sourceSessionId: OLD_SESSION_ID,
        op: "compact",
        child: control,
        codexHome,
        noInference: true,
        terminateGraceMs: 20,
        confirmWindowMs: 1_000,
        confirmPollMs: 25,
        log: () => {},
        logError: (message) => captureErrors.push(message),
        startCaptureSessionFn: (captureInput) => {
          if (captureInput === undefined) throw new Error("expected capture input");
          captureInput.logError?.("post-swap capture probe");
          return startCaptureSession({
            ...captureInput,
            knownRolloutPath: captureInput.knownRolloutPath!,
          });
        },
      });

      expect(result.ok).toBe(true);
      expect(captureErrors).toContain("post-swap capture probe");
      expect(consoleErrors).toEqual([]);
      if (result.ok) {
        await result.captureSession.stop();
        if (result.child.isAlive()) result.child.kill("SIGKILL");
        await result.child.waitForExit().catch(() => {});
      }
    } finally {
      console.error = origConsoleError;
    }
  });
});
