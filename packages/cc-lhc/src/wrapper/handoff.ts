import { randomUUID } from "node:crypto";

import type { HandoffRequest } from "../commands/context-mutation.js";
import { type DurableHandoffReceipt, type HandoffReceiptPort, cleanupFields } from "./handoff-receipt-store.js";
import { formatOldChildCleanup, type OldChildCleanup } from "./old-child-cleanup.js";

export type { OldChildCleanup } from "./old-child-cleanup.js";
export { formatOldChildCleanup } from "./old-child-cleanup.js";

export const DEFAULT_CAPTURE_READY_TIMEOUT_MS = 20_000;
export const DEFAULT_CHILD_LIVENESS_TIMEOUT_MS = 10_000;
export const DEFAULT_CHILD_STABLE_WINDOW_MS = 750;
export const DEFAULT_REPLACEMENT_ATTEMPTS = 2;

export interface HandoffChild {
  write(data: string): void;
}

export interface CandidateChild {
  sessionId: string;
  pid: number;
  child: HandoffChild;
}

export interface ReplacementEvidence {
  processAlive: boolean;
  sessionFileWritten: boolean;
}

export type CandidateViability =
  | { kind: "viable"; evidence: ReplacementEvidence }
  | { kind: "exited"; evidence: ReplacementEvidence }
  | { kind: "no_output"; evidence: ReplacementEvidence };

export type SwitchOutcome =
  | { switched: false; reason: string }
  | {
      switched: true;
      captureStarted: boolean;
      captureWarning?: string;
      switchWarnings?: readonly string[];
    };

export interface HandoffPorts {
  preHandoffStop(): string | null;
  spawnCandidate(sessionId: string): CandidateChild;
  awaitCandidateViable(
    candidate: CandidateChild,
    timeoutMs: number,
    stableWindowMs: number,
  ): Promise<CandidateViability>;
  discardCandidate(candidate: CandidateChild): Promise<void>;
  switchToCandidate(candidate: CandidateChild): SwitchOutcome;
  killOldChild(): Promise<OldChildCleanup>;
  awaitReplacementCaptureReady(timeoutMs: number): Promise<"ready" | "degraded" | "timeout">;
  reconcileCapture(reason: string): void;
  registerSuccessLineage(request: HandoffRequest): Promise<{ ok: true } | { ok: false; reason: string }>;
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
      oldChildCleanup: OldChildCleanup;
      handoffId: string;
      oldChildWarning?: string;
      lineageWarning?: string;
      descriptorWarning?: string;
      captureWarning?: string;
      switchWarnings?: readonly string[];
    }
  | {
      kind: "replacement_nonviable";
      reason: string;
      attempts: number;
      oldSessionId: string;
      rebuiltSessionId: string;
    };

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
  handoffReceipts?: HandoffReceiptPort;
  uuidFn?: () => string;
  nowFn?: () => Date;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function failSoftReceipt(ports: HandoffPorts, phase: string, handoffId: string, step: () => void): void {
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

  const switched = ports.switchToCandidate(established.candidate);
  if (!switched.switched) {
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

  let lineageWarning: string | undefined;
  const lineage = await settleAfterSwitch(ports, "lineage registration", () => ports.registerSuccessLineage(request));
  if (!lineage.ok) {
    lineageWarning = lineage.warning;
  } else if (!lineage.value.ok) {
    lineageWarning = `success lineage registration failed: ${lineage.value.reason}`;
    ports.warn(`cc-lhc handoff WARNING: ${lineageWarning}`);
  }

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
