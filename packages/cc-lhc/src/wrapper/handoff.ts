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

import { randomUUID } from "node:crypto";

import type { HandoffRequest } from "../commands/context-mutation.js";
import {
  type DurableHandoffReceipt,
  type HandoffReceiptPort,
  cleanupFields,
} from "./handoff-receipt-store.js";
import { formatOldChildCleanup, type OldChildCleanup } from "./old-child-cleanup.js";

export type { OldChildCleanup } from "./old-child-cleanup.js";
export { formatOldChildCleanup } from "./old-child-cleanup.js";

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

/**
 * What the switch did. `switched: false` is not a refusal and not a gate — it
 * is the physical state of the candidate process at the one instant promotion
 * reads it. A candidate that proved viable and then died before routing could
 * move to it cannot be routed to, and because nothing moved there is nothing to
 * undo: the old child is still routed, still live, and still owns its capture
 * generation and descriptor.
 */
export type SwitchOutcome =
  | { switched: false; reason: string }
  | {
      switched: true;
      /** A new capture generation is bound to the rebuilt session. */
      captureStarted: boolean;
      /** Non-fatal detail when capture did not come across with the routing. */
      captureWarning?: string;
      /** Non-fatal detail from the switch itself: repaint, descriptor adoption. */
      switchWarnings?: readonly string[];
    };

export interface HandoffPorts {
  /**
   * The one thing that can still stop a swap before it starts, and it is not
   * about the compact: the wrapper process is already exiting, so there is
   * nobody left to route a replacement to. Returns a reason or null.
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
   * THE SWITCH. Confirms the candidate still exists and has not exited, then
   * moves input routing, output routing, the retrieval descriptor and the
   * capture generation to it in one step, after which all later old-child
   * output is ignored.
   *
   * Must not throw. A candidate that died between proving viable and being
   * promoted returns `switched: false` having moved nothing; once it reports
   * `switched: true`, repaint, descriptor and capture trouble come back as
   * warnings on a switch that already happened.
   */
  switchToCandidate(candidate: CandidateChild): SwitchOutcome;
  /** Best-effort termination of the now-unrouted old child. */
  killOldChild(): Promise<OldChildCleanup>;
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
      /** In-memory proven cleanup classification; user/log/receipt share this value. */
      oldChildCleanup: OldChildCleanup;
      /** Durable evidence row id; present even when SQLite writes fail soft. */
      handoffId: string;
      /** Old-child cleanup could not be carried out or could not be observed. */
      oldChildWarning?: string;
      lineageWarning?: string;
      descriptorWarning?: string;
      captureWarning?: string;
      /** Repaint or descriptor-adoption detail from the switch itself. */
      switchWarnings?: readonly string[];
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
    case "success":
      return `handoff complete — session ${result.newSessionId} live; ${formatOldChildCleanup(result.oldChildCleanup)}`;
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
  /** Evidence-only durable handoff receipt. Failures are loud and never gate routing. */
  handoffReceipts?: HandoffReceiptPort;
  uuidFn?: () => string;
  nowFn?: () => Date;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function failSoftReceipt(
  ports: HandoffPorts,
  phase: string,
  handoffId: string,
  step: () => void,
): void {
  try {
    step();
  } catch (cause) {
    ports.warn(`cc-lhc handoff receipt ${phase} failed for ${handoffId}: ${reasonOf(cause)}`);
  }
}

function persistPreparedReceipt(
  ports: HandoffPorts,
  receipts: HandoffReceiptPort | undefined,
  row: DurableHandoffReceipt,
): void {
  if (receipts === undefined) return;
  failSoftReceipt(ports, "insert", row.handoffId, () => {
    receipts.insertPrepared(row);
  });
  failSoftReceipt(ports, "insert readback", row.handoffId, () => {
    const read = receipts.readBack(row.handoffId);
    if (read === null) {
      throw new Error("prepared row missing after insert");
    }
  });
}

function persistFailedBeforeSwitch(
  ports: HandoffPorts,
  receipts: HandoffReceiptPort | undefined,
  prepared: DurableHandoffReceipt,
  nowIso: string,
): void {
  if (receipts === undefined) return;
  const failed: DurableHandoffReceipt = {
    ...prepared,
    terminalDisposition: "failed_before_switch",
    cleanupKind: null,
    cleanupPid: null,
    detail: null,
    completedAt: nowIso,
  };
  failSoftReceipt(ports, "update", prepared.handoffId, () => {
    receipts.update(failed);
  });
  failSoftReceipt(ports, "update readback", prepared.handoffId, () => {
    const read = receipts.readBack(prepared.handoffId);
    if (read === null) throw new Error("failed-before-switch row missing after update");
  });
}

function persistSuccessCleanup(
  ports: HandoffPorts,
  receipts: HandoffReceiptPort | undefined,
  prepared: DurableHandoffReceipt,
  cleanup: OldChildCleanup,
  nowIso: string,
): void {
  if (receipts === undefined) return;
  const success: DurableHandoffReceipt = {
    ...prepared,
    terminalDisposition: "success",
    ...cleanupFields(cleanup),
    completedAt: nowIso,
  };
  failSoftReceipt(ports, "update", prepared.handoffId, () => {
    receipts.update(success);
  });
  failSoftReceipt(ports, "update readback", prepared.handoffId, () => {
    const read = receipts.readBack(prepared.handoffId);
    if (read === null) throw new Error("success row missing after update");
  });
}

/**
 * Run one step of the after-the-switch settlement.
 *
 * Past the switch the replacement is live, routed, and talking to the operator.
 * Everything left to do is recording what already happened — lineage, the old
 * child's corpse, capture health, the retrieval descriptor — so a port that
 * throws yields a warning and nothing else. None of it may unmake the swap, and
 * none of it may report a live replacement as a failure.
 */
async function settleAfterSwitch<T>(
  ports: HandoffPorts,
  what: string,
  step: () => T | Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; warning: string }> {
  try {
    return { ok: true, value: await step() };
  } catch (cause) {
    const warning = `${what} threw after the switch: ${reasonOf(cause)}`;
    ports.warn(`cc-lhc handoff WARNING: ${warning}`);
    return { ok: false, warning };
  }
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
  const receipts = options.handoffReceipts;
  const nowIso = () => (options.nowFn?.() ?? new Date()).toISOString();

  const stop = ports.preHandoffStop();
  if (stop !== null) {
    ports.log(`cc-lhc handoff cancelled (${request.operation}): ${stop}`);
    return { kind: "cancelled", reason: stop };
  }

  const handoffId = options.uuidFn?.() ?? randomUUID();
  const prepared: DurableHandoffReceipt = {
    handoffId,
    operation: request.operation,
    oldSessionId: request.oldSessionId,
    newSessionId: rebuiltId,
    preparedAt: nowIso(),
    terminalDisposition: null,
    cleanupKind: null,
    cleanupPid: null,
    detail: null,
    completedAt: null,
  };
  persistPreparedReceipt(ports, receipts, prepared);

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
    persistFailedBeforeSwitch(ports, receipts, prepared, nowIso());
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
  if (!switched.switched) {
    // The candidate proved viable and then died before routing could reach it.
    // That is a fact about a process, not a decision about a compact: nothing
    // moved, so the old child is still routed, still live, and still owns its
    // capture generation and descriptor. A later settled seam simply retries.
    ports.warn(
      `cc-lhc handoff: replacement ${rebuiltId} was not promoted — ${switched.reason}; ` +
        `session ${request.oldSessionId} continues live, still routed and untouched`,
    );
    persistFailedBeforeSwitch(ports, receipts, prepared, nowIso());
    return {
      kind: "replacement_nonviable",
      reason: switched.reason,
      attempts: established.attempts,
      oldSessionId: request.oldSessionId,
      rebuiltSessionId: rebuiltId,
    };
  }

  ports.log(
    `cc-lhc handoff switch (${request.operation}): ${request.oldSessionId} -> ${rebuiltId} ` +
      `(pid ${established.candidate.pid}, session file written: ${established.evidence.sessionFileWritten})`,
  );
  const switchWarnings = switched.switchWarnings ?? [];
  for (const warning of switchWarnings) ports.warn(`cc-lhc handoff WARNING: ${warning}`);
  if (switched.captureWarning !== undefined) ports.warn(`cc-lhc handoff WARNING: ${switched.captureWarning}`);

  // ---- The replacement is live and routed. Everything below records what
  // already happened; none of it can undo it or call it a failure. ----
  let lineageWarning: string | undefined;
  const lineage = await settleAfterSwitch(ports, "lineage registration", () =>
    ports.registerSuccessLineage(request),
  );
  if (!lineage.ok) {
    lineageWarning = lineage.warning;
  } else if (!lineage.value.ok) {
    lineageWarning = `success lineage registration failed: ${lineage.value.reason}`;
    ports.warn(`cc-lhc handoff WARNING: ${lineageWarning}`);
  }

  // The old child owns nothing now. Classify cleanup from identity evidence;
  // the in-memory value is what user output, the wrapper log, and the durable
  // receipt all report. Receipt write failure cannot change it.
  let oldChildWarning: string | undefined;
  const killed = await settleAfterSwitch(ports, "old-child cleanup", () => ports.killOldChild());
  const oldChildCleanup: OldChildCleanup = killed.ok
    ? killed.value
    : {
        kind: "unknown",
        detail: `old Claude child (session ${request.oldSessionId}) may still be running: ${killed.warning}`,
      };
  const cleanupText = formatOldChildCleanup(oldChildCleanup);
  if (!killed.ok || oldChildCleanup.kind === "surviving_orphan" || oldChildCleanup.kind === "unknown") {
    oldChildWarning = cleanupText;
  }
  if (oldChildCleanup.kind === "surviving_orphan") {
    ports.warn(
      `cc-lhc handoff: the old child (session ${request.oldSessionId}) is no longer routed to anything; ` +
        "kill it manually to reclaim its memory",
    );
  }
  ports.log(`cc-lhc handoff old-child cleanup: ${cleanupText}`);
  persistSuccessCleanup(ports, receipts, prepared, oldChildCleanup, nowIso());

  let captureWarning = switched.captureWarning;
  const reconcile = async (why: string): Promise<void> => {
    const reconciled = await settleAfterSwitch(ports, "capture reconciliation", () => {
      ports.reconcileCapture(why);
    });
    if (!reconciled.ok) captureWarning = `${captureWarning ?? why}; ${reconciled.warning}`;
  };
  if (switched.captureStarted) {
    const ready = await settleAfterSwitch(ports, "replacement capture readiness", () =>
      ports.awaitReplacementCaptureReady(readyTimeoutMs),
    );
    if (!ready.ok) {
      captureWarning = ready.warning;
      await reconcile("replacement capture readiness could not be observed");
    } else if (ready.value !== "ready") {
      captureWarning = `replacement capture ${ready.value} — reconciling from the transcript`;
      ports.warn(`cc-lhc handoff WARNING: ${captureWarning}`);
      await reconcile(`replacement capture ${ready.value}`);
    }
  } else {
    await reconcile(switched.captureWarning ?? "replacement capture did not start");
  }

  // Retrieval is a capability over the captured archive, so it publishes after
  // capture has caught up — never before, and never as a condition of the swap.
  let descriptorWarning: string | undefined;
  const published = await settleAfterSwitch(ports, "ready descriptor publication", () =>
    ports.publishReadyDescriptor(),
  );
  if (!published.ok) {
    descriptorWarning = published.warning;
  } else if (!published.value) {
    descriptorWarning = "ready descriptor publish failed — retrieval stays fail-closed this generation";
    ports.warn(`cc-lhc handoff WARNING: ${descriptorWarning}`);
  }

  ports.log(`cc-lhc handoff success (${request.operation}): session ${rebuiltId} live`);
  return {
    kind: "success",
    newSessionId: rebuiltId,
    evidence: established.evidence,
    attempts: established.attempts,
    oldChildCleanup,
    handoffId,
    ...(oldChildWarning === undefined ? {} : { oldChildWarning }),
    ...(lineageWarning === undefined ? {} : { lineageWarning }),
    ...(descriptorWarning === undefined ? {} : { descriptorWarning }),
    ...(captureWarning === undefined ? {} : { captureWarning }),
    ...(switchWarnings.length === 0 ? {} : { switchWarnings }),
  };
}
