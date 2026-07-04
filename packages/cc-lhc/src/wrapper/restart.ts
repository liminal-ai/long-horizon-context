import type { SessionRestartPlan } from "../commands/dispatch.js";
import { formatSessionRestartLog } from "../commands/dispatch.js";
import type { CaptureSession, ContinueCapture } from "../intake/session.js";

const KILL_GRACE_MS = 3_000;
export const CLEAR_SCREEN = "\x1b[2J\x1b[H";

export interface PtyLike {
  kill(signal?: string): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
}

export class RestartSpawnFailure extends Error {
  readonly plan: SessionRestartPlan;
  readonly resumeArgv: string[];

  constructor(message: string, plan: SessionRestartPlan, resumeArgv: string[]) {
    super(message);
    this.name = "RestartSpawnFailure";
    this.plan = plan;
    this.resumeArgv = resumeArgv;
  }
}

export function formatRestartSpawnFailure(plan: SessionRestartPlan, cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return `[cc-lhc] FATAL: could not respawn claude (${message}). Original session ${plan.oldSessionId} is intact; run: claude --resume ${plan.newSessionId}`;
}

export function buildResumeArgv(originalArgv: string[], newSessionId: string): string[] {
  return [...originalArgv, "--resume", newSessionId];
}

export async function killPtyWithGrace(
  pty: PtyLike,
  options: { graceMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const graceMs = options.graceMs ?? KILL_GRACE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let exited = false;
  const onExit = (): void => {
    exited = true;
  };
  pty.onExit(onExit);
  pty.kill("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (!exited && Date.now() < deadline) {
    await sleep(50);
  }
  if (!exited) pty.kill("SIGKILL");
}

export async function pauseCaptureForRestart(session: CaptureSession): Promise<ContinueCapture> {
  const ctx = session.getCommandContext();
  if (ctx.sdk === undefined || ctx.threadRef === undefined) {
    throw new Error("capture session not ready for restart");
  }
  const paused: ContinueCapture = {
    threadRef: ctx.threadRef,
    sdk: ctx.sdk,
    stats: session.stats,
  };
  await session.stop();
  return paused;
}

export interface SessionRestartInput {
  plan: SessionRestartPlan;
  originalArgv: string[];
  pty: PtyLike;
  captureSession: CaptureSession | undefined;
  clearScreen: () => void;
  spawnChild: (argv: string[]) => PtyLike;
  startCapture: (startedAt: Date, continueCapture: ContinueCapture) => CaptureSession;
  logRestart: (message: string) => void;
}

export interface SessionRestartResult {
  argv: string[];
  pty: PtyLike;
  captureSession: CaptureSession;
}

export async function executeSessionRestart(input: SessionRestartInput): Promise<SessionRestartResult> {
  input.logRestart(formatSessionRestartLog(input.plan));
  await killPtyWithGrace(input.pty);

  if (input.captureSession === undefined) {
    throw new Error("capture session required for restart");
  }
  const continueCapture = await pauseCaptureForRestart(input.captureSession);
  input.clearScreen();

  const argv = buildResumeArgv(input.originalArgv, input.plan.newSessionId);
  let pty: PtyLike;
  try {
    pty = input.spawnChild(argv);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new RestartSpawnFailure(message, input.plan, argv);
  }
  const captureSession = input.startCapture(new Date(), continueCapture);
  return { argv, pty, captureSession };
}
