/**
 * Controlled handoff: the wrapper-owned child swap that makes a rebuilt session
 * live. This module owns the ORDER of the transaction; run.ts supplies the
 * machinery through HandoffPorts (process, routing, descriptor, capture).
 *
 * The order is spawn-first (R5). A working session exists at every moment:
 *
 *   spawn the replacement OFF-ROUTE  →  establish observable viability  →
 *   atomically switch input/output routing and the capture generation  →
 *   best-effort kill of the old child (loud orphan notice if it survives)
 *
 * The old child blocks nothing structurally: it is a separate process on a
 * separate session and a separate rollout file, the wrapper owns the real
 * terminal and all routing, and the wrapper is the only writer of LHC state
 * and rollout files. Killing it first was hygiene promoted into a sequencing
 * gate; it is now the last step and its failure cannot stop the swap.
 *
 * Forward-only invariants carried here:
 *  - There is no rollback. The oversized session is never restored. The only
 *    sanctioned way to stay on the old session is a replacement that never
 *    became viable — and that is not a rollback, because nothing was ever
 *    switched away from.
 *  - Bookkeeping never governs. Lineage, the current-session pointer, the
 *    retrieval descriptor and capture health are recorded after the switch and
 *    only ever produce warnings; none of them can kill a live replacement.
 *  - Old artifacts are never rewritten; the old rollout is only read.
 *  - Candidate and active child references stay distinct until the switch.
 */

import type { HandoffRequest } from "../commands/context-mutation.js";

export const DEFAULT_CAPTURE_READY_TIMEOUT_MS = 20_000;
/**
 * How long the candidate gets to emit its first PTY output. A resumed Claude
 * renders the loaded history immediately; a child that dies or stays mute
 * before this deadline is not a live replacement.
 */
export const DEFAULT_CHILD_LIVENESS_TIMEOUT_MS = 10_000;
/** After first output, the child must survive this window without exiting. */
export const DEFAULT_CHILD_STABLE_WINDOW_MS = 750;
/** Spawn/viability attempts for one swap before the seam is given up. */
export const DEFAULT_REPLACEMENT_ATTEMPTS = 2;

export interface HandoffChild {
  write(data: string): void;
}

/**
 * A replacement process that exists but owns nothing: no terminal output, no
 * stdin, no capture generation. Distinct from the active child until the
 * routing switch promotes it.
 */
export interface CandidateChild {
  sessionId: string;
  pid: number;
  child: HandoffChild;
}

/**
 * What was observed about a candidate before routing switched.
 *
 * `processAlive` is the decisive evidence: the child rendered and survived the
 * stabilization window. `sessionFileWritten` is corroborating evidence that
 * Claude accepted the rebuilt rollout enough to append to it — it is recorded
 * when it appears and never required, because a healthy resumed child may
 * render its history without appending anything until the next interaction.
 * Prompt intake is never required here: that is the one-shot pointer rule, not
 * an interactive viability rule.
 */
export interface ReplacementEvidence {
  processAlive: boolean;
  sessionFileWritten: boolean;
}

export type CandidateViability =
  | { kind: "viable"; evidence: ReplacementEvidence }
  | { kind: "exited"; evidence: ReplacementEvidence }
  | { kind: "no_output"; evidence: ReplacementEvidence };

/** What the atomic switch managed to carry across with the routing. */
export interface SwitchOutcome {
  /** A new capture generation is bound to the rebuilt session. */
  captureStarted: boolean;
  /** Non-fatal detail when capture or the descriptor did not come across. */
  captureWarning?: string;
}

export interface HandoffPorts {
  /**
   * The two things that can still stop a swap before it starts, neither of
   * them about the compact: this launch form cannot respawn a child at all, and
   * the wrapper process is already exiting. Returns a reason or null.
   */
  preHandoffStop(): string | null;
  /**
   * Spawn `claude --resume <sessionId>` OFF-ROUTE: its output is held, its
   * stdin is unconnected, and it owns no capture generation. Throws on spawn
   * failure.
   */
  spawnCandidate(sessionId: string): CandidateChild;
  /**
   * Observable viability for the candidate: it emitted PTY output and survived
   * the stabilization window, raced against exit and a bounded timeout.
   * Terminal content is never parsed. Session-file growth is collected as
   * corroborating evidence, never as a requirement.
   */
  awaitCandidateViable(
    candidate: CandidateChild,
    timeoutMs: number,
    stableWindowMs: number,
  ): Promise<CandidateViability>;
  /** Kill a candidate that never became viable. It was never routed to. */
  discardCandidate(candidate: CandidateChild): Promise<void>;
  /**
   * THE SWITCH. Input routing, output routing, the retrieval descriptor and
   * the capture generation move to the candidate in one step, and all later
   * old-child output is ignored. Must not throw: capture or descriptor trouble
   * comes back as a warning on a completed switch.
   */
  switchToCandidate(candidate: CandidateChild): SwitchOutcome;
  /** Best-effort termination of the now-unrouted old child. */
  killOldChild(): Promise<{ exited: boolean; pid: number }>;
  /** Ready-after-replay for the replacement generation (health, not a gate). */
  awaitReplacementCaptureReady(timeoutMs: number): Promise<"ready" | "degraded" | "timeout">;
  /** Rebuild capture state from the persisted transcript after a bad reading. */
  reconcileCapture(reason: string): void;
  /** Canonical lineage + current-session pointer for the accepted replacement. */
  registerSuccessLineage(request: HandoffRequest): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Publish the ready descriptor for the new generation. False = degraded. */
  publishReadyDescriptor(): boolean;
  log(message: string): void;
  warn(message: string): void;
}

export type HandoffResult =
  | { kind: "cancelled"; reason: string }
  | {
      kind: "success";
      newSessionId: string;
      evidence: ReplacementEvidence;
      attempts: number;
      /** PID of an old child that survived termination and was left running. */
      orphanPid?: number;
      lineageWarning?: string;
      descriptorWarning?: string;
      captureWarning?: string;
    }
  /**
   * The replacement never became viable, so nothing was ever switched. The old
   * session keeps the terminal, untouched, and the installed view and rebuilt
   * rollout stay on disk. This is the only sanctioned way to remain on the old
   * session, and it is not a rollback.
   */
  | {
      kind: "replacement_nonviable";
      reason: string;
      attempts: number;
      oldSessionId: string;
      rebuiltSessionId: string;
    };

/** User-facing handoff result. */
export function formatHandoffResult(result: HandoffResult): string {
  switch (result.kind) {
    case "success": {
      const orphan =
        result.orphanPid === undefined ? "" : `; old child pid ${result.orphanPid} ORPHANED (kill failed)`;
      return `handoff complete — session ${result.newSessionId} live${orphan}`;
    }
    case "cancelled":
      return `handoff cancelled: ${result.reason}`;
    case "replacement_nonviable":
      return (
        `replacement ${result.rebuiltSessionId} did not become viable after ${result.attempts} attempt(s): ` +
        `${result.reason}; session ${result.oldSessionId} continues live and unchanged`
      );
  }
}

export interface HandoffOptions {
  captureReadyTimeoutMs?: number;
  childLivenessTimeoutMs?: number;
  childStableWindowMs?: number;
  replacementAttempts?: number;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface EstablishedReplacement {
  candidate: CandidateChild;
  evidence: ReplacementEvidence;
  attempts: number;
}

/**
 * Spawn and prove a replacement while the old session is still live and
 * untouched. Every failure here is discovered at zero cost to the session, so
 * the answer is another attempt, and the answer to running out of attempts is
 * to keep the old session — never to undo anything.
 */
async function establishReplacement(
  sessionId: string,
  ports: HandoffPorts,
  attemptsAllowed: number,
  livenessTimeoutMs: number,
  stableWindowMs: number,
): Promise<EstablishedReplacement | { failures: string[]; attempts: number }> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
    let candidate: CandidateChild;
    try {
      candidate = ports.spawnCandidate(sessionId);
    } catch (cause) {
      failures.push(`attempt ${attempt}: spawn failed: ${reasonOf(cause)}`);
      continue;
    }
    ports.log(`cc-lhc handoff: candidate ${sessionId} spawned off-route pid=${candidate.pid} (attempt ${attempt})`);
    const viability = await ports.awaitCandidateViable(candidate, livenessTimeoutMs, stableWindowMs);
    if (viability.kind === "viable") {
      return { candidate, evidence: viability.evidence, attempts: attempt };
    }
    failures.push(`attempt ${attempt}: candidate ${viability.kind}`);
    await ports.discardCandidate(candidate).catch((cause: unknown) => {
      ports.warn(`cc-lhc handoff: discarding nonviable candidate pid=${candidate.pid} failed: ${reasonOf(cause)}`);
    });
  }
  return { failures, attempts: attemptsAllowed };
}

export async function executeHandoff(
  request: HandoffRequest,
  ports: HandoffPorts,
  options: HandoffOptions = {},
): Promise<HandoffResult> {
  const readyTimeoutMs = options.captureReadyTimeoutMs ?? DEFAULT_CAPTURE_READY_TIMEOUT_MS;
  const childLivenessTimeoutMs = options.childLivenessTimeoutMs ?? DEFAULT_CHILD_LIVENESS_TIMEOUT_MS;
  const childStableWindowMs = options.childStableWindowMs ?? DEFAULT_CHILD_STABLE_WINDOW_MS;
  const attemptsAllowed = options.replacementAttempts ?? DEFAULT_REPLACEMENT_ATTEMPTS;
  const rebuiltId = request.rebuilt.sessionId;

  const stop = ports.preHandoffStop();
  if (stop !== null) {
    ports.log(`cc-lhc handoff cancelled (${request.operation}): ${stop}`);
    return { kind: "cancelled", reason: stop };
  }

  const established = await establishReplacement(
    rebuiltId,
    ports,
    attemptsAllowed,
    childLivenessTimeoutMs,
    childStableWindowMs,
  );
  if (!("candidate" in established)) {
    const reason = established.failures.join("; ");
    ports.warn(
      `cc-lhc handoff: replacement ${rebuiltId} never became viable (${reason}); ` +
        `session ${request.oldSessionId} continues live — nothing was switched and nothing was undone`,
    );
    return {
      kind: "replacement_nonviable",
      reason,
      attempts: established.attempts,
      oldSessionId: request.oldSessionId,
      rebuiltSessionId: rebuiltId,
    };
  }

  // ---- THE SWITCH: routing and capture generation move together ----
  const switched = ports.switchToCandidate(established.candidate);
  ports.log(
    `cc-lhc handoff switch (${request.operation}): ${request.oldSessionId} -> ${rebuiltId} ` +
      `(pid ${established.candidate.pid}, session file written: ${established.evidence.sessionFileWritten})`,
  );
  if (switched.captureWarning !== undefined) ports.warn(`cc-lhc handoff WARNING: ${switched.captureWarning}`);

  // ---- everything below records what already happened; none of it can undo it ----
  let lineageWarning: string | undefined;
  const lineage = await ports.registerSuccessLineage(request);
  if (!lineage.ok) {
    lineageWarning = `success lineage registration failed: ${lineage.reason}`;
    ports.warn(`cc-lhc handoff WARNING: ${lineageWarning}`);
  }

  // The old child owns nothing now. Kill it for hygiene; if the kernel will not
  // take it, say so loudly by PID and carry on with the live replacement.
  let orphanPid: number | undefined;
  const killed = await ports.killOldChild();
  if (!killed.exited) {
    orphanPid = killed.pid;
    ports.warn(
      `cc-lhc handoff: ORPHANED old Claude child pid=${killed.pid} (session ${request.oldSessionId}) — ` +
        "it survived termination and is no longer routed to anything; kill it manually to reclaim its memory",
    );
  }

  let captureWarning = switched.captureWarning;
  if (switched.captureStarted) {
    const ready = await ports.awaitReplacementCaptureReady(readyTimeoutMs);
    if (ready !== "ready") {
      captureWarning = `replacement capture ${ready} — reconciling from the transcript`;
      ports.warn(`cc-lhc handoff WARNING: ${captureWarning}`);
      ports.reconcileCapture(`replacement capture ${ready}`);
    }
  } else {
    ports.reconcileCapture(switched.captureWarning ?? "replacement capture did not start");
  }

  // Retrieval is a capability over the captured archive, so it publishes after
  // capture has caught up — never before, and never as a condition of the swap.
  let descriptorWarning: string | undefined;
  if (!ports.publishReadyDescriptor()) {
    descriptorWarning = "ready descriptor publish failed — retrieval stays fail-closed this generation";
    ports.warn(`cc-lhc handoff WARNING: ${descriptorWarning}`);
  }

  ports.log(`cc-lhc handoff success (${request.operation}): session ${rebuiltId} live`);
  return {
    kind: "success",
    newSessionId: rebuiltId,
    evidence: established.evidence,
    attempts: established.attempts,
    ...(orphanPid === undefined ? {} : { orphanPid }),
    ...(lineageWarning === undefined ? {} : { lineageWarning }),
    ...(descriptorWarning === undefined ? {} : { descriptorWarning }),
    ...(captureWarning === undefined ? {} : { captureWarning }),
  };
}
