// COMPATIBILITY MODULE — not used by the default compact/prune path on Claude
// Code 2.1.226. Retained for unit coverage of the historical injection design
// Installed-binary exhibit 2026-08-09: in-app `/resume` of a session file
// created after TUI startup returns "No conversations found to resume".
import type { SessionRestartPlan } from "../commands/dispatch.js";
import { formatSessionResumeLog } from "../commands/dispatch.js";
import { lineageWriteFailureMessage } from "../intake/lineage-db.js";
import type { CaptureSession, ContinueCapture } from "../intake/session.js";
import { formatSwapReceipt } from "../rollout/rebuild.js";
import { type RolloutStat, statRolloutFile } from "../rollout/stat-file.js";

export type { RolloutStat } from "../rollout/stat-file.js";

export const RESUME_TRIPWIRE_WINDOW_MS = 3_000;
export const REPAINT_NUDGE = "\x0c";
export const RESUME_TRIP_GRACE_MS = 750;
export const RESUME_CONFIRM_EXTRA_MS = 5_000;
const CONFIRM_POLL_MS = 250;

export function resumeNotFoundPhrase(newSessionId: string): string {
  return `Session ${newSessionId} was not found`;
}

export function buildResumeInjection(newSessionId: string): string {
  return `/resume ${newSessionId}\r`;
}

export interface TripwireScanner {
  feed(chunk: string): boolean;
}

type AnsiMode = "text" | "esc" | "csi" | "str" | "str_esc";

export function createTripwireScanner(phrase: string): TripwireScanner {
  const normalizedPhrase = phrase.replace(/\s+/g, "");
  let carry = "";
  let mode: AnsiMode = "text";
  let seen = false;

  const cleanChunk = (chunk: string): string => {
    let clean = "";
    for (const char of chunk) {
      switch (mode) {
        case "text":
          if (char === "\x1b") mode = "esc";
          // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strips raw PTY control bytes
          else if (!/[\s\x00-\x1f\x7f]/.test(char)) clean += char;
          break;
        case "esc":
          if (char === "[") mode = "csi";
          else if (char === "]" || char === "P" || char === "^" || char === "_" || char === "X") mode = "str";
          else mode = "text";
          break;
        case "csi":
          if (char >= "\x40" && char <= "\x7e") mode = "text";
          break;
        case "str":
          if (char === "\x07") mode = "text";
          else if (char === "\x1b") mode = "str_esc";
          break;
        case "str_esc":
          mode = char === "\\" ? "text" : "str";
          break;
      }
    }
    return clean;
  };

  return {
    feed(chunk: string): boolean {
      if (seen) return true;
      const window = carry + cleanChunk(chunk);
      if (window.includes(normalizedPhrase)) {
        seen = true;
        return true;
      }
      carry = window.slice(Math.max(0, window.length - (normalizedPhrase.length - 1)));
      return false;
    },
  };
}

export function formatResumeFailure(plan: SessionRestartPlan): string {
  return `resume did not take; original session ${plan.oldSessionId} is still live — run /resume ${plan.newSessionId} manually`;
}

export function formatResumeAbortTurnOpen(plan: SessionRestartPlan): string {
  return `swap aborted: turn opened during rebuild — live session ${plan.oldSessionId} untouched; the thread view is already compacted/pruned and the next successful swap will serve it; rerun when idle`;
}

export function formatSwapCollisionNote(plan: SessionRestartPlan, sizeBefore: number, sizeAfter: number): string {
  return (
    `[swap collision] background turn raced session swap ${plan.oldSessionId} -> ${plan.newSessionId}: ` +
    `old rollout grew ${sizeBefore} -> ${sizeAfter} bytes past the rebuild cutoff. ` +
    `The raced content is in the thread record via the old session tail but absent from the rebuilt live context.`
  );
}

export function formatResumeSuccess(plan: SessionRestartPlan): string {
  return formatSwapReceipt(plan.oldSessionId, plan.newSessionId, plan.expectedReintakeLines);
}

export async function pauseCaptureForResume(session: CaptureSession): Promise<ContinueCapture> {
  const ctx = session.getCommandContext();
  if (ctx.sdk === undefined || ctx.threadRef === undefined) {
    throw new Error("capture session not ready for resume handoff");
  }
  const paused: ContinueCapture = {
    threadRef: ctx.threadRef,
    sdk: ctx.sdk,
    stats: session.stats,
  };
  await session.stop();
  return paused;
}

function rolloutGrew(before: RolloutStat | null, after: RolloutStat | null): boolean {
  if (after === null) return false;
  if (before === null) return true;
  return after.size > before.size || after.mtimeMs > before.mtimeMs;
}

export interface ResumeInjectionInput {
  plan: SessionRestartPlan;
  captureSession: CaptureSession | undefined;
  writeToPty: (data: string) => void;
  onOutput: (listener: (data: string) => void) => () => void;
  startCapture: (startedAt: Date, continueCapture: ContinueCapture, rolloutPath: string) => CaptureSession;
  logResume: (message: string) => void;
  logHandoffError?: (message: string) => void;
  recordLineage?: (input: { sessionId: string; threadId: string }) => Promise<void>;
  logLineageError?: (message: string) => void;
  isTurnOpen?: () => boolean;
  isCaptureHealthy?: () => boolean;
  getCaptureGeneration?: () => number;
  onBeforeInject?: () => void;
  windowMs?: number;
  tripGraceMs?: number;
  confirmExtraMs?: number;
  sleep?: (ms: number) => Promise<void>;
  statRollout?: (path: string) => Promise<RolloutStat | null>;
}

export type ResumeInjectionResult =
  | { ok: true; captureSession: CaptureSession }
  | { ok: false; reason: "turn_open" | "no_swap_evidence" | "capture_unhealthy" };

async function recordSwapCollisionIfGrown(
  plan: SessionRestartPlan,
  continueCapture: ContinueCapture,
  statRollout: (path: string) => Promise<RolloutStat | null>,
): Promise<void> {
  if (plan.oldRolloutPath === undefined || plan.oldRolloutSizeAtRebuild === undefined) return;
  try {
    const now = await statRollout(plan.oldRolloutPath);
    if (now === null || now.size <= plan.oldRolloutSizeAtRebuild) return;
    await continueCapture.sdk.intakeStream.messageEvents(continueCapture.threadRef, [
      {
        eventKind: "runtime_note",
        idempotencyKey: `cc-lhc:swap-collision:${plan.newSessionId}`,
        actor: "system",
        harness: "cc",
        payload: { text: formatSwapCollisionNote(plan, plan.oldRolloutSizeAtRebuild, now.size) },
      },
    ]);
  } catch {}
}

export async function executeResumeInjection(input: ResumeInjectionInput): Promise<ResumeInjectionResult> {
  if (input.captureSession === undefined) {
    throw new Error("capture session required for resume handoff");
  }

  if (input.isTurnOpen?.() === true) {
    return { ok: false, reason: "turn_open" };
  }
  if (input.isCaptureHealthy?.() === false) {
    return { ok: false, reason: "capture_unhealthy" };
  }
  if (
    input.plan.captureGeneration !== undefined &&
    input.getCaptureGeneration !== undefined &&
    input.getCaptureGeneration() !== input.plan.captureGeneration
  ) {
    return { ok: false, reason: "capture_unhealthy" };
  }

  input.logResume(formatSessionResumeLog(input.plan));

  const windowMs = input.windowMs ?? RESUME_TRIPWIRE_WINDOW_MS;
  const tripGraceMs = input.tripGraceMs ?? RESUME_TRIP_GRACE_MS;
  const confirmExtraMs = input.confirmExtraMs ?? RESUME_CONFIRM_EXTRA_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const statRollout = input.statRollout ?? statRolloutFile;
  const scanner = createTripwireScanner(resumeNotFoundPhrase(input.plan.newSessionId));

  const beforeStat = await statRollout(input.plan.rolloutPath);
  const swapEvidence = async (): Promise<boolean> => rolloutGrew(beforeStat, await statRollout(input.plan.rolloutPath));

  let tripped = false;
  let resolveTripped: () => void = () => {};
  const trippedPromise = new Promise<void>((resolve) => {
    resolveTripped = resolve;
  });
  const unsubscribe = input.onOutput((data) => {
    if (!tripped && scanner.feed(data)) {
      tripped = true;
      resolveTripped();
    }
  });

  const injectedAt = new Date();
  try {
    input.onBeforeInject?.();
    input.writeToPty(buildResumeInjection(input.plan.newSessionId));
    await Promise.race([trippedPromise, sleep(windowMs)]);
  } finally {
    unsubscribe();
  }

  let swapped: boolean;
  if (tripped) {
    await sleep(tripGraceMs);
    swapped = await swapEvidence();
  } else {
    swapped = await swapEvidence();
    for (let waited = 0; !swapped && waited < confirmExtraMs; waited += CONFIRM_POLL_MS) {
      await sleep(CONFIRM_POLL_MS);
      swapped = await swapEvidence();
    }
  }
  if (!swapped) {
    return { ok: false, reason: "no_swap_evidence" };
  }

  input.writeToPty(REPAINT_NUDGE);

  let captureSession = input.captureSession;
  try {
    const ctx = input.captureSession.getCommandContext();
    const threadId = ctx.threadRef !== undefined && "threadId" in ctx.threadRef ? ctx.threadRef.threadId : "";
    if (input.recordLineage !== undefined && threadId !== "") {
      try {
        await input.recordLineage({ sessionId: input.plan.newSessionId, threadId });
      } catch (cause) {
        input.logLineageError?.(lineageWriteFailureMessage(cause));
      }
    }

    const continueCapture = await pauseCaptureForResume(input.captureSession);
    await recordSwapCollisionIfGrown(input.plan, continueCapture, statRollout);
    captureSession = input.startCapture(injectedAt, continueCapture, input.plan.rolloutPath);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    input.logHandoffError?.(`resume handoff failed (swap confirmed): ${message}`);
  }
  return { ok: true, captureSession };
}
