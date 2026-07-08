import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import type { Lhc, SessionThreadView, ThreadRef } from "lhc";

import { prepareChildArgv } from "../bin/prepare-child-argv.js";
import { defaultLineageDbPath, safeRecordSessionThread, type LineageDbDeps } from "../intake/lineage-db.js";
import {
  type CaptureSession,
  type CaptureSessionDeps,
  type ContinueCapture,
  startCaptureSession,
} from "../intake/session.js";
import { parseRolloutFilename } from "../rollout/discover.js";
import { writeRebuiltRollout, type WriteRebuiltRolloutResult } from "../rollout/write-rebuilt.js";

export const DEFAULT_SWAP_TERMINATE_GRACE_MS = 500;
export const DEFAULT_SWAP_CONFIRM_WINDOW_MS = 5_000;
export const DEFAULT_SWAP_CONFIRM_POLL_MS = 100;

export interface ChildExit {
  exitCode: number;
  signal?: number | string;
}

export interface SwapChildHandle {
  kill(signal: NodeJS.Signals): void;
  waitForExit(): Promise<ChildExit>;
  isAlive(): boolean;
}

export interface SwapChildControl {
  current(): SwapChildHandle;
  spawn(argv: string[]): SwapChildHandle | Promise<SwapChildHandle>;
  markSwapKill?(child: SwapChildHandle): void;
  unmarkSwapKill?(child: SwapChildHandle): void;
}

export type SwapConfirmMode = "growth" | "child_alive";

export interface SwapReceipt {
  ok: boolean;
  status: "success" | "rebuild_failed" | "respawn_failed" | "confirm_failed" | "recovery_failed";
  messages: string[];
  oldSessionId: string;
  newSessionId?: string;
  rolloutPath?: string;
  manualCommand?: string;
  confirmMode?: SwapConfirmMode;
}

export type SessionSwapResult =
  | {
      ok: true;
      receipt: SwapReceipt & {
        ok: true;
        status: "success";
        newSessionId: string;
        rolloutPath: string;
        confirmMode: SwapConfirmMode;
      };
      rebuilt: WriteRebuiltRolloutResult;
      captureSession: CaptureSession;
      child: SwapChildHandle;
      confirmMode: SwapConfirmMode;
    }
  | {
      ok: false;
      phase: "rebuild";
      receipt: SwapReceipt & { ok: false; status: "rebuild_failed" };
      error: unknown;
    }
  | {
      ok: false;
      phase: "respawn" | "confirm";
      receipt: SwapReceipt & { ok: false; status: "respawn_failed" | "confirm_failed" };
      rebuilt: WriteRebuiltRolloutResult;
      recovered: true;
      recoveryChild: SwapChildHandle;
      captureSession: CaptureSession;
      error?: unknown;
    }
  | {
      ok: false;
      phase: "recovery";
      receipt: SwapReceipt & { ok: false; status: "recovery_failed" };
      rebuilt: WriteRebuiltRolloutResult;
      recovered: false;
      error: unknown;
      exitCode: number;
    };

export interface RolloutGrowthStat {
  size: number;
  mtimeMs: number;
  lineCount: number;
}

export interface ExecuteSessionSwapInput {
  session: CaptureSession;
  threadRef: ThreadRef;
  view: SessionThreadView;
  sourceRolloutPath: string;
  sourceSessionId?: string;
  op: string;
  tokensBefore?: number;
  tokensAfter?: number;
  child: SwapChildControl;
  cwd?: string;
  codexHome?: string;
  noInference?: boolean;
  captureDeps?: Partial<CaptureSessionDeps>;
  lineageDbPath?: string;
  lineageDeps?: LineageDbDeps;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  /** Called after rebuild succeeds, immediately before capture stop and child kill/respawn. */
  onBeforeRespawn?: () => void;
  writeRebuiltRolloutFn?: typeof writeRebuiltRollout;
  startCaptureSessionFn?: typeof startCaptureSession;
  statRollout?: (path: string) => Promise<RolloutGrowthStat | null>;
  sleep?: (ms: number) => Promise<void>;
  terminateGraceMs?: number;
  confirmWindowMs?: number;
  confirmPollMs?: number;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function threadIdFromRef(threadRef: ThreadRef): string {
  return "threadId" in threadRef ? threadRef.threadId : "";
}

function sessionIdFromPath(path: string): string | undefined {
  return parseRolloutFilename(basename(path)) ?? undefined;
}

function resumeArgv(sessionId: string): string[] {
  return prepareChildArgv(["resume", sessionId]).argv;
}

function manualResumeCommand(sessionId: string): string {
  return `codex resume ${sessionId}`;
}

async function defaultStatRollout(path: string): Promise<RolloutGrowthStat | null> {
  try {
    const [stats, content] = await Promise.all([stat(path), readFile(path, "utf8")]);
    const lineCount = content === "" ? 0 : content.split("\n").filter((line) => line.length > 0).length;
    return { size: stats.size, mtimeMs: stats.mtimeMs, lineCount };
  } catch {
    return null;
  }
}

function grew(before: RolloutGrowthStat | null, after: RolloutGrowthStat | null, lineCountBaseline: number): boolean {
  if (after === null) return false;
  if (before === null) return after.lineCount > lineCountBaseline;
  return after.size > before.size || after.mtimeMs > before.mtimeMs || after.lineCount > lineCountBaseline;
}

async function terminateChild(
  child: SwapChildHandle,
  markSwapKill: ((child: SwapChildHandle) => void) | undefined,
  sleep: (ms: number) => Promise<void>,
  graceMs: number,
): Promise<void> {
  if (!child.isAlive()) {
    await child.waitForExit().catch(() => {});
    return;
  }

  markSwapKill?.(child);
  child.kill("SIGTERM");
  const exited = await Promise.race([
    child.waitForExit().then(() => true),
    sleep(graceMs).then(() => false),
  ]);
  if (exited) return;

  if (child.isAlive()) {
    markSwapKill?.(child);
    child.kill("SIGKILL");
  }
  await child.waitForExit().catch(() => {});
}

type SwapConfirmResult = { ok: true; mode: SwapConfirmMode } | { ok: false };

async function waitForSwapConfirm(
  path: string,
  child: SwapChildHandle,
  baseline: RolloutGrowthStat | null,
  lineCountBaseline: number,
  input: Required<Pick<ExecuteSessionSwapInput, "sleep" | "confirmWindowMs" | "confirmPollMs" | "statRollout">>,
): Promise<SwapConfirmResult> {
  const started = Date.now();
  while (Date.now() - started <= input.confirmWindowMs) {
    const current = await input.statRollout(path);
    if (grew(baseline, current, lineCountBaseline)) return { ok: true, mode: "growth" };
    if (!child.isAlive()) return { ok: false };
    await input.sleep(input.confirmPollMs);
  }
  if (grew(baseline, await input.statRollout(path), lineCountBaseline)) return { ok: true, mode: "growth" };
  return child.isAlive() ? { ok: true, mode: "child_alive" } : { ok: false };
}

function captureContinuation(
  session: CaptureSession,
  threadRef: ThreadRef,
  sdkOverride?: Lhc,
): ContinueCapture {
  const ctx = session.getCommandContext();
  const sdk = sdkOverride ?? ctx.sdk;
  if (sdk === undefined) {
    throw new Error("capture session not ready for swap handoff");
  }
  return {
    threadRef,
    sdk,
    stats: session.stats,
  };
}

function startDirectCapture(
  input: ExecuteSessionSwapInput,
  continueCapture: ContinueCapture,
  rolloutPath: string,
  replayedPrefixLines: number,
): CaptureSession {
  const start = input.startCaptureSessionFn ?? startCaptureSession;
  return start({
    cwd: input.cwd ?? process.cwd(),
    lineageDbPath: input.lineageDbPath ?? defaultLineageDbPath(),
    ...(input.noInference === undefined ? {} : { noInference: input.noInference }),
    ...(input.captureDeps ?? {}),
    knownRolloutPath: rolloutPath,
    replayedPrefixLines,
    continueCapture,
  });
}

async function spawnRecovery(
  input: ExecuteSessionSwapInput,
  continueCapture: ContinueCapture,
  originalSessionId: string,
): Promise<{ child: SwapChildHandle; captureSession: CaptureSession }> {
  const recoveryChild = await input.child.spawn(resumeArgv(originalSessionId));
  input.child.unmarkSwapKill?.(recoveryChild);
  const captureSession = startDirectCapture(input, continueCapture, input.sourceRolloutPath, 0);
  return { child: recoveryChild, captureSession };
}

export async function executeSessionSwap(input: ExecuteSessionSwapInput): Promise<SessionSwapResult> {
  const log = input.log ?? (() => {});
  const logError = input.logError ?? (() => {});
  const writeRebuilt = input.writeRebuiltRolloutFn ?? writeRebuiltRollout;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const statRollout = input.statRollout ?? defaultStatRollout;
  const terminateGraceMs = input.terminateGraceMs ?? DEFAULT_SWAP_TERMINATE_GRACE_MS;
  const confirmWindowMs = input.confirmWindowMs ?? DEFAULT_SWAP_CONFIRM_WINDOW_MS;
  const confirmPollMs = input.confirmPollMs ?? DEFAULT_SWAP_CONFIRM_POLL_MS;
  const oldSessionId = input.sourceSessionId ?? sessionIdFromPath(input.sourceRolloutPath) ?? "unknown";
  const threadId = threadIdFromRef(input.threadRef);

  let rebuilt: WriteRebuiltRolloutResult;
  try {
    rebuilt = await writeRebuilt({
      view: input.view,
      cwd: input.cwd ?? process.cwd(),
      sourceRolloutPath: input.sourceRolloutPath,
      ...(input.codexHome === undefined ? {} : { codexHome: input.codexHome }),
      swapReceipt: {
        oldSessionId,
        threadId,
        op: input.op,
        ...(input.tokensBefore === undefined ? {} : { tokensBefore: input.tokensBefore }),
        ...(input.tokensAfter === undefined ? {} : { tokensAfter: input.tokensAfter }),
      },
    });
  } catch (error) {
    const message = `swap rebuild failed: ${detail(error)}; current session left running unchanged`;
    logError(message);
    return {
      ok: false,
      phase: "rebuild",
      error,
      receipt: {
        ok: false,
        status: "rebuild_failed",
        oldSessionId,
        messages: [message],
      },
    };
  }

  const manualCommand = manualResumeCommand(rebuilt.sessionId);
  const continueCapture = captureContinuation(input.session, input.threadRef);
  const baseline = await statRollout(rebuilt.rolloutPath);

  input.onBeforeRespawn?.();

  await input.session.stop();
  await terminateChild(input.child.current(), input.child.markSwapKill, sleep, terminateGraceMs);

  let newChild: SwapChildHandle | undefined;
  try {
    log(`codex-lhc swap: spawning ${manualCommand}`);
    newChild = await input.child.spawn(resumeArgv(rebuilt.sessionId));
    input.child.markSwapKill?.(newChild);
  } catch (error) {
    const messages = [
      `swap respawn failed for ${rebuilt.sessionId}: ${detail(error)}`,
      `manual recovery command: ${manualCommand}`,
      `recovering original session with ${manualResumeCommand(oldSessionId)}`,
    ];
    for (const message of messages) logError(message);
    try {
      const recovered = await spawnRecovery(input, continueCapture, oldSessionId);
      return {
        ok: false,
        phase: "respawn",
        rebuilt,
        recovered: true,
        recoveryChild: recovered.child,
        captureSession: recovered.captureSession,
        error,
        receipt: {
          ok: false,
          status: "respawn_failed",
          oldSessionId,
          newSessionId: rebuilt.sessionId,
          rolloutPath: rebuilt.rolloutPath,
          manualCommand,
          messages,
        },
      };
    } catch (recoveryError) {
      const recoveryMessage = `swap recovery failed; run ${manualResumeCommand(oldSessionId)} manually: ${detail(recoveryError)}`;
      logError(recoveryMessage);
      return {
        ok: false,
        phase: "recovery",
        rebuilt,
        recovered: false,
        error: recoveryError,
        exitCode: 1,
        receipt: {
          ok: false,
          status: "recovery_failed",
          oldSessionId,
          newSessionId: rebuilt.sessionId,
          rolloutPath: rebuilt.rolloutPath,
          manualCommand,
          messages: [...messages, recoveryMessage],
        },
      };
    }
  }

  const confirmed = await waitForSwapConfirm(rebuilt.rolloutPath, newChild, baseline, rebuilt.lineCount, {
    sleep,
    statRollout,
    confirmWindowMs,
    confirmPollMs,
  });

  if (!confirmed.ok) {
    const messages = [
      `swap did not confirm for ${rebuilt.sessionId}; rebuilt rollout did not grow`,
      `manual recovery command: ${manualCommand}`,
      `recovering original session with ${manualResumeCommand(oldSessionId)}`,
    ];
    for (const message of messages) logError(message);
    await terminateChild(newChild, input.child.markSwapKill, sleep, terminateGraceMs);
    try {
      const recovered = await spawnRecovery(input, continueCapture, oldSessionId);
      return {
        ok: false,
        phase: "confirm",
        rebuilt,
        recovered: true,
        recoveryChild: recovered.child,
        captureSession: recovered.captureSession,
        receipt: {
          ok: false,
          status: "confirm_failed",
          oldSessionId,
          newSessionId: rebuilt.sessionId,
          rolloutPath: rebuilt.rolloutPath,
          manualCommand,
          messages,
        },
      };
    } catch (recoveryError) {
      const recoveryMessage = `swap recovery failed; run ${manualResumeCommand(oldSessionId)} manually: ${detail(recoveryError)}`;
      logError(recoveryMessage);
      return {
        ok: false,
        phase: "recovery",
        rebuilt,
        recovered: false,
        error: recoveryError,
        exitCode: 1,
        receipt: {
          ok: false,
          status: "recovery_failed",
          oldSessionId,
          newSessionId: rebuilt.sessionId,
          rolloutPath: rebuilt.rolloutPath,
          manualCommand,
          messages: [...messages, recoveryMessage],
        },
      };
    }
  }

  input.child.unmarkSwapKill?.(newChild);
  if (threadId !== "") {
    await safeRecordSessionThread(
      input.lineageDbPath ?? defaultLineageDbPath(),
      rebuilt.sessionId,
      threadId,
      logError,
      input.lineageDeps,
    );
  }
  const captureSession = startDirectCapture(input, continueCapture, rebuilt.rolloutPath, rebuilt.replayedPrefixLines);
  const messages = [`swap confirmed (${confirmed.mode}): ${oldSessionId} -> ${rebuilt.sessionId}`];
  return {
    ok: true,
    rebuilt,
    captureSession,
    child: newChild,
    confirmMode: confirmed.mode,
    receipt: {
      ok: true,
      status: "success",
      oldSessionId,
      newSessionId: rebuilt.sessionId,
      rolloutPath: rebuilt.rolloutPath,
      confirmMode: confirmed.mode,
      messages,
    },
  };
}
