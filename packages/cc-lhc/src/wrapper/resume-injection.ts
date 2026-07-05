// In-app session swap: after prune/compact writes a rebuilt rollout, the
// wrapper injects `/resume <newSessionId>\r` into the live pty instead of
// killing and respawning the child. Claude Code hot-swaps the session in-place
// (~1-2s) and keeps appending to the rebuilt rollout file under the same
// session id, so capture hands off to a new session tailing that known path.
//
// Failure detection is a passive tripwire: a bad id leaves the original
// session fully live and prints the plain text "was not found" into the
// stream. If the phrase shows up within the watch window, the swap did not
// take and NOTHING else changes — the old capture keeps running and the user
// gets the manual `/resume` command. Never inject a bare `/resume` (it opens
// an interactive picker).
import type { SessionRestartPlan } from "../commands/dispatch.js";
import { formatSessionResumeLog } from "../commands/dispatch.js";
import { lineageWriteFailureMessage } from "../intake/lineage-db.js";
import type { CaptureSession, ContinueCapture } from "../intake/session.js";

export const RESUME_NOT_FOUND_PHRASE = "was not found";
export const RESUME_TRIPWIRE_WINDOW_MS = 3_000;

export function buildResumeInjection(newSessionId: string): string {
  return `/resume ${newSessionId}\r`;
}

export interface TripwireScanner {
  /** Feed one output chunk; true once the phrase has been seen (spanning chunk boundaries). */
  feed(chunk: string): boolean;
}

/**
 * Rolling substring scanner over a chunk stream. Keeps a carry of the last
 * phrase-length-minus-one characters so a phrase split across chunks still
 * trips. The phrase arrives as plain text even in raw ANSI output, so no
 * escape-sequence stripping is needed.
 */
export function createTripwireScanner(phrase: string = RESUME_NOT_FOUND_PHRASE): TripwireScanner {
  let carry = "";
  let seen = false;
  return {
    feed(chunk: string): boolean {
      if (seen) return true;
      const window = carry + chunk;
      if (window.includes(phrase)) {
        seen = true;
        return true;
      }
      carry = window.slice(Math.max(0, window.length - (phrase.length - 1)));
      return false;
    },
  };
}

export function formatResumeFailure(plan: SessionRestartPlan): string {
  return `resume did not take (session ${plan.newSessionId} not found); original session ${plan.oldSessionId} is still live — run /resume ${plan.newSessionId} manually`;
}

export function formatResumeSuccess(plan: SessionRestartPlan): string {
  return `session ${plan.oldSessionId} preserved; resumed in-place as ${plan.newSessionId} (expect ~${plan.expectedReintakeLines} replayed lines to re-intake)`;
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

export interface ResumeInjectionInput {
  plan: SessionRestartPlan;
  captureSession: CaptureSession | undefined;
  writeToPty: (data: string) => void;
  /** Subscribe to forwarded pty output; returns an unsubscribe function. */
  onOutput: (listener: (data: string) => void) => () => void;
  startCapture: (startedAt: Date, continueCapture: ContinueCapture, rolloutPath: string) => CaptureSession;
  logResume: (message: string) => void;
  recordLineage?: (input: { sessionId: string; threadId: string }) => Promise<void>;
  logLineageError?: (message: string) => void;
  windowMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type ResumeInjectionResult = { ok: true; captureSession: CaptureSession } | { ok: false };

export async function executeResumeInjection(input: ResumeInjectionInput): Promise<ResumeInjectionResult> {
  if (input.captureSession === undefined) {
    throw new Error("capture session required for resume handoff");
  }
  input.logResume(formatSessionResumeLog(input.plan));

  const ctx = input.captureSession.getCommandContext();
  const threadId = ctx.threadRef !== undefined && "threadId" in ctx.threadRef ? ctx.threadRef.threadId : "";
  if (input.recordLineage !== undefined && threadId !== "") {
    try {
      await input.recordLineage({ sessionId: input.plan.newSessionId, threadId });
    } catch (cause) {
      input.logLineageError?.(lineageWriteFailureMessage(cause));
    }
  }

  const windowMs = input.windowMs ?? RESUME_TRIPWIRE_WINDOW_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const scanner = createTripwireScanner();

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
    input.writeToPty(buildResumeInjection(input.plan.newSessionId));
    await Promise.race([trippedPromise, sleep(windowMs)]);
  } finally {
    unsubscribe();
  }

  if (tripped) {
    return { ok: false };
  }

  const continueCapture = await pauseCaptureForResume(input.captureSession);
  const captureSession = input.startCapture(injectedAt, continueCapture, input.plan.rolloutPath);
  return { ok: true, captureSession };
}
