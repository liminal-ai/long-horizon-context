// In-app session swap: after prune/compact writes a rebuilt rollout, the
// wrapper injects `/resume <newSessionId>\r` into the live pty instead of
// killing and respawning the child. Claude Code hot-swaps the session in-place
// (~1-2s) and keeps appending to the rebuilt rollout file under the same
// session id, so capture hands off to a new session tailing that known path.
//
// Outcome detection has two layers. The fast layer is a tripwire scoped to
// this swap's failure line — `Session <newSessionId> was not found.` — scanned
// over the forwarded pty output. The new session id is minted at rebuild time,
// so replayed conversation text cannot contain it; a bare "was not found" in
// replayed history never trips. The ground-truth layer is the rebuilt rollout
// file itself: a successful swap touches and appends to it within ~1-2s, a
// failed one leaves it exactly as the rebuild wrote it. Growth decides; the
// tripwire only shortens the wait when the failure line appears.
//
// The failure line's words arrive separated by cursor-positioning sequences
// (`was\x1b[55Gnot\x1b[59Gfound.`), NOT literal spaces, so the scanner strips
// ANSI escape sequences statefully and drops whitespace before matching.
//
// On failure NOTHING else changes — no lineage row, the old capture keeps
// running, and the user gets the manual `/resume` command. Never inject a
// bare `/resume` (it opens an interactive picker).
//
// Two turn-race protections bracket the swap. BEFORE injecting, the turn
// state is rechecked (claude has async wakes — monitors, background tasks —
// so a turn can open during the rebuild): if one is open the injection is
// aborted cleanly, the original session untouched, the rebuilt file left
// unused on disk. AFTER a confirmed swap, the OLD rollout is compared against
// its size at rebuild time: growth means a background turn raced the swap —
// its content reached the thread record through the old tail's final flush
// but is absent from the rebuilt live context. That collision is recorded
// SILENTLY as a thread runtime_note (queryable later in the record, and
// re-served into rebuilt contexts, unlike an ephemeral debug line); nothing
// prints to the user.
import type { SessionRestartPlan } from "../commands/dispatch.js";
import { formatSessionResumeLog } from "../commands/dispatch.js";
import { lineageWriteFailureMessage } from "../intake/lineage-db.js";
import type { CaptureSession, ContinueCapture } from "../intake/session.js";
import { formatSwapReceipt } from "../rollout/rebuild.js";
import { type RolloutStat, statRolloutFile } from "../rollout/stat-file.js";

export type { RolloutStat } from "../rollout/stat-file.js";

export const RESUME_TRIPWIRE_WINDOW_MS = 3_000;
/**
 * Ctrl-L. Injected into the child after a confirmed swap: Claude Code
 * (verified on 2.1.202) responds with a full TUI repaint that wipes the raw
 * [cc-lhc] lines printed before injection and restores the input-box borders,
 * preserving input-box content. The user-facing receipt itself travels inside
 * the rebuilt rollout as a trailing runtime-note line, so the repaint cannot
 * erase it.
 */
export const REPAINT_NUDGE = "\x0c";
/** After a trip, how long to give a possibly-concurrent swap to touch the rollout before ruling failure. */
export const RESUME_TRIP_GRACE_MS = 750;
/** Without a trip, how much extra time to poll for swap evidence past the tripwire window. */
export const RESUME_CONFIRM_EXTRA_MS = 5_000;
const CONFIRM_POLL_MS = 250;

export function resumeNotFoundPhrase(newSessionId: string): string {
  return `Session ${newSessionId} was not found`;
}

export function buildResumeInjection(newSessionId: string): string {
  return `/resume ${newSessionId}\r`;
}

export interface TripwireScanner {
  /** Feed one output chunk; true once the phrase has been seen (spanning chunk boundaries). */
  feed(chunk: string): boolean;
}

type AnsiMode = "text" | "esc" | "csi" | "str" | "str_esc";

/**
 * Phrase scanner over a raw pty chunk stream. Statefully strips ANSI escape
 * sequences (CSI, OSC/DCS-style strings, single-char escapes — sequences may
 * span chunk boundaries) and drops all whitespace/control characters, then
 * substring-matches the whitespace-stripped phrase against a rolling window.
 * Whitespace-insensitive matching is load-bearing: the TUI renders the failure
 * line's word gaps as cursor-column jumps, so the plain text `was not found`
 * never appears contiguously in the raw stream.
 */
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
          else if (!/[\s\x00-\x1f\x7f]/.test(char)) clean += char;
          break;
        case "esc":
          if (char === "[") mode = "csi";
          else if (char === "]" || char === "P" || char === "^" || char === "_" || char === "X") mode = "str";
          else mode = "text"; // single-character escape; consume it
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
  // Tell the truth about the partial state: the live session was not swapped,
  // but the thread view WAS already compacted/pruned (a view mutation without
  // a swap is valid — the next successful swap serves it) and a rebuilt
  // rollout file sits unused on disk.
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
  /** Subscribe to forwarded pty output; returns an unsubscribe function. */
  onOutput: (listener: (data: string) => void) => () => void;
  startCapture: (startedAt: Date, continueCapture: ContinueCapture, rolloutPath: string) => CaptureSession;
  logResume: (message: string) => void;
  recordLineage?: (input: { sessionId: string; threadId: string }) => Promise<void>;
  logLineageError?: (message: string) => void;
  /** Last-instant turn recheck; an open turn aborts before anything is injected. */
  isTurnOpen?: () => boolean;
  windowMs?: number;
  tripGraceMs?: number;
  confirmExtraMs?: number;
  sleep?: (ms: number) => Promise<void>;
  statRollout?: (path: string) => Promise<RolloutStat | null>;
}

export type ResumeInjectionResult =
  | { ok: true; captureSession: CaptureSession }
  | { ok: false; reason: "turn_open" | "no_swap_evidence" };

/**
 * Silent swap-collision check: the old rollout growing past its
 * rebuild-cutoff size means a background turn raced the swap. Recorded as a
 * thread runtime_note — the record is the queryable place — never printed.
 * The old capture has already done its final-flush stop, so the raced lines
 * themselves are in the record.
 */
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
  } catch {
    // Silent by design: a failed collision note must not disturb the handoff.
  }
}

export async function executeResumeInjection(input: ResumeInjectionInput): Promise<ResumeInjectionResult> {
  if (input.captureSession === undefined) {
    throw new Error("capture session required for resume handoff");
  }

  // Last-instant recheck: a turn may have opened while the rebuild ran
  // (claude wakes asynchronously for monitors and background tasks). Abort
  // before touching the pty — the rebuilt file stays on disk unused.
  if (input.isTurnOpen?.() === true) {
    return { ok: false, reason: "turn_open" };
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
    input.writeToPty(buildResumeInjection(input.plan.newSessionId));
    await Promise.race([trippedPromise, sleep(windowMs)]);
  } finally {
    unsubscribe();
  }

  // Growth of the rebuilt rollout is the ground truth: a successful swap
  // touches/appends it, a failed one leaves the rebuild's bytes alone. The
  // tripwire only decides how long we wait before consulting it.
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

  // Lineage is recorded only once the swap is confirmed, so a failed resume
  // leaves no session→thread row behind to misdirect later --resume/--continue
  // resolution. The cost is the narrow crash-between-swap-and-record window;
  // that is acceptable because the handoff capture below re-records the same
  // mapping the moment it attaches to the rebuilt rollout.
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
  const captureSession = input.startCapture(injectedAt, continueCapture, input.plan.rolloutPath);
  return { ok: true, captureSession };
}
