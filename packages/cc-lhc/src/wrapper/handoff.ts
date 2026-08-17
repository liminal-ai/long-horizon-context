/**
 * Controlled handoff: the wrapper-owned child respawn that makes a rebuilt
 * session live. This module owns the ORDER of the transaction; run.ts supplies
 * the machinery through HandoffPorts (process, descriptor, capture, barrier).
 *
 * Invariants carried here:
 *  - Commit is the explicit point after the final gate when stdin switches
 *    from forwarding to ordered buffering. Pre-commit input reached only the
 *    old child; post-commit input reaches exactly one successfully rebound
 *    child, in order, exactly once — or is retained in a recovery artifact.
 *  - Old artifacts are never rewritten; the old rollout is only read.
 *  - Descriptor and canonical lineage advance only after the replacement
 *    capture generation is proven ready-after-replay.
 *  - Failure is a named recoverable state, preferring automatic rollback to
 *    the untouched old session; a failed replacement never claims success.
 */

import type { HandoffRequest } from "../commands/context-mutation.js";
import type { JournalDeliveryState } from "./input-journal.js";

export const DEFAULT_CAPTURE_READY_TIMEOUT_MS = 20_000;
/**
 * How long the replacement child gets to emit its first PTY output. A resumed
 * Claude renders the loaded history immediately; a child that dies or stays
 * mute before this deadline is not a live replacement. (Rollout growth was
 * rejected as the readiness contract: a healthy resumed child renders history
 * without appending anything until the next interaction.)
 */
export const DEFAULT_CHILD_LIVENESS_TIMEOUT_MS = 10_000;
/** After first output, the child must survive this window without exiting. */
export const DEFAULT_CHILD_STABLE_WINDOW_MS = 750;

export interface RecoveryArtifact {
  reason: string;
  oldSessionId: string;
  rebuiltSessionId: string;
  bufferedInputBytes: number;
  /**
   * Ordered post-commit user bytes, base64. Present ONLY when there is no
   * durable journal (manual/backward path, or a journal whose append failed).
   * When a durable journal exists the bytes live there and are NOT duplicated.
   */
  bufferedInputBase64?: string;
  /** Durable input-journal path/id/state (LIM-80 3B1), when the barrier was journaled. */
  inputJournalPath?: string;
  inputJournalId?: string;
  inputJournalState?: JournalDeliveryState;
  /** Explicit send-ambiguity flag: a crash/failure while `delivering`. Never auto-replay. */
  deliveryIndeterminate?: boolean;
}

/**
 * Optional typed recovery-stage instrumentation for the automatic handoff (LIM-80
 * Slice 3B1). Absent for manual compact/prune — then executeHandoff behaves
 * exactly as before. Each callback advances one durable attempt stage / proves
 * one exact identity through the native provider; failures before replacement
 * ready stop forward progress (the existing rollback/failure path runs), never
 * fake a stage. Lineage/descriptor advances are best-effort (warn, no gate).
 */
export interface HandoffRecoveryStagePort {
  /**
   * Before the input barrier: prove + store the exact old-child identity and
   * create + bind the durable input journal. A failure (identity unavailable,
   * journal not durable) cancels safely with no barrier and no termination.
   */
  prepareBarrier(): { ok: true } | { ok: false; reason: string };
  /** After the old child is proven exited: CAS advance old_child_exited. Throws → stop. */
  recordOldChildExited(): void;
  /**
   * After the replacement capture is ready and the child is stable: probe + store
   * the exact replacement identity and CAS advance replacement_ready. `ok:false`
   * (identity unavailable / CAS conflict) means NOT ready — kill/rollback.
   */
  recordReplacementReady(): { ok: true } | { ok: false; reason: string };
  /** After successful lineage registration: advance lineage_recorded (best-effort). */
  recordLineageRecorded(): void;
  /** After successful descriptor publish: advance descriptor_published (best-effort). */
  recordDescriptorPublished(): void;
}

export interface HandoffChild {
  write(data: string): void;
}

export interface HandoffPorts {
  /**
   * Final pre-commit gate (turn closed, capture generation unchanged, capture
   * ready, descriptor usable, input epoch unchanged, UI/modal passthrough).
   * Returns a refusal reason or null to proceed. Nothing has changed when it
   * refuses.
   */
  preCommitGate(): string | null;
  /** COMMIT POINT: stdin switches from forwarding to ordered raw buffering. */
  beginInputBarrier(): void;
  /**
   * Deliver the ordered buffer exactly once into the writer and resume normal
   * forwarding. Returns bytes delivered. Must be called at most once.
   */
  flushInputBarrier(child: HandoffChild): number;
  /** Stop buffering WITHOUT delivering; returns the ordered bytes. */
  takeInputBarrierBuffer(): Buffer;
  /** Fail-closed retrieval for the dying generation (close old descriptor). */
  closeOldDescriptor(): void;
  /** Graceful SIGTERM → bounded wait → process-group SIGKILL → bounded wait. */
  terminateOldChild(): Promise<{ exited: boolean; escalated: boolean }>;
  /** Final watcher flush + drain. Capture must remain attached through exit. */
  stopCurrentCapture(): Promise<void>;
  /** Spawn `claude --resume <sessionId>`; attaches output/exit handlers. Throws on spawn failure. */
  spawnChild(sessionId: string): HandoffChild;
  /** Writer to the currently attached child (used when the old child survives). */
  currentChild(): HandoffChild;
  /** Hard-kill the current (replacement) child after a failed handoff step. */
  killCurrentChild(): Promise<void>;
  /**
   * Start capture bound to the exact rebuilt session via the direct pending
   * capability (thread/sdk/prefix passed in-process; no lineage lookup).
   */
  startRebuiltCapture(request: HandoffRequest): void;
  /** Start capture for the rolled-back old session (its own durable lineage). */
  startRollbackCapture(oldSessionId: string): void;
  /** Ready-after-replay proof for the current capture generation. */
  awaitCaptureReady(timeoutMs: number): Promise<"ready" | "degraded" | "timeout">;
  /**
   * Non-semantic PTY liveness for the replacement child: it emitted output and
   * survived a short stabilization window, raced against exit and a bounded
   * timeout. Terminal content is never parsed and the PTY is never canonical —
   * this only proves a live, rendering child. Capture replay of the
   * pre-existing file is NOT child evidence and must not satisfy this.
   */
  awaitChildStabilized(timeoutMs: number, stableWindowMs: number): Promise<"stable" | "exited" | "timeout">;
  /** Success-only canonical lineage; called only after ready-after-replay. */
  registerSuccessLineage(request: HandoffRequest): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Publish the ready descriptor for the new generation. False = degraded. */
  publishReadyDescriptor(): boolean;
  /** Persist a recovery artifact; returns its path, or null when even that failed. */
  writeRecoveryArtifact(artifact: RecoveryArtifact): string | null;
  /**
   * LIM-80 3B1: false when the durable input journal lost integrity during the
   * barrier (an append/fsync failed). Absent (manual) means "durable" — no
   * journal, memory buffering only. A non-durable barrier must not be delivered.
   */
  inputBarrierDurable?(): boolean;
  log(message: string): void;
}

export type HandoffResult =
  | { kind: "cancelled"; reason: string }
  | {
      kind: "success";
      newSessionId: string;
      flushedInputBytes: number;
      lineageWarning?: string;
      descriptorWarning?: string;
    }
  | {
      kind: "rolled_back";
      reason: string;
      oldSessionId: string;
      flushedInputBytes: number;
      descriptorWarning?: string;
    }
  | {
      kind: "failed";
      reason: string;
      oldSessionId: string;
      rebuiltSessionId: string;
      /** True when a child process is still running (uncaptured). */
      childAlive: boolean;
      recoveryArtifactPath: string | null;
      retainedInputBytes: number;
    };

/** User-facing handoff result. It distinguishes absence from failed recovery. */
export function formatHandoffResult(result: HandoffResult): string {
  switch (result.kind) {
    case "success":
      return `handoff complete — session ${result.newSessionId} live`;
    case "cancelled":
      return `handoff cancelled: ${result.reason}`;
    case "rolled_back":
      return `handoff rolled back to ${result.oldSessionId}: ${result.reason}`;
    case "failed": {
      if (result.childAlive && result.retainedInputBytes === 0 && result.recoveryArtifactPath === null) {
        return (
          `handoff FAILED: ${result.reason}; old session ${result.oldSessionId} continues; ` +
          "no recovery artifact required"
        );
      }
      const recovery =
        result.recoveryArtifactPath === null
          ? "recovery artifact write FAILED"
          : `recovery ${result.recoveryArtifactPath}`;
      return (
        `handoff FAILED: ${result.reason}; old=${result.oldSessionId} rebuilt=${result.rebuiltSessionId}; ` +
        `${recovery}; retained input ${result.retainedInputBytes} byte(s)`
      );
    }
  }
}

export interface HandoffOptions {
  captureReadyTimeoutMs?: number;
  childLivenessTimeoutMs?: number;
  childStableWindowMs?: number;
  /** LIM-80 3B1 automatic-attempt stage instrumentation. Absent = manual, unchanged. */
  recoveryStages?: HandoffRecoveryStagePort;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Durability of the input barrier; a throwing check we cannot trust withholds. */
function barrierDurable(ports: HandoffPorts): boolean {
  if (ports.inputBarrierDurable === undefined) return true;
  try {
    return ports.inputBarrierDurable();
  } catch {
    return false;
  }
}

type Delivery = { ok: true; bytes: number } | { ok: false; result: HandoffResult };

/**
 * Deliver the buffered input via the SAME journal protocol on every path. A
 * non-durable barrier withholds delivery (fail-closed, artifact). A throw during
 * markDelivering / child.write / markDelivered is the send AMBIGUITY: the journal
 * `delivering` state records it and it is NEVER auto-replayed — return failed
 * with a recovery artifact. childAlive is preserved by the caller.
 */
function deliver(ports: HandoffPorts, request: HandoffRequest, child: HandoffChild, childAlive: boolean): Delivery {
  if (!barrierDurable(ports)) {
    return {
      ok: false,
      result: failed(ports, request, "input journal not durable during barrier — delivery withheld", childAlive),
    };
  }
  try {
    return { ok: true, bytes: ports.flushInputBarrier(child) };
  } catch (cause) {
    return {
      ok: false,
      result: failed(
        ports,
        request,
        `input delivery failed — ambiguous, never auto-replay: ${reasonOf(cause)}`,
        childAlive,
      ),
    };
  }
}

export async function executeHandoff(
  request: HandoffRequest,
  ports: HandoffPorts,
  options: HandoffOptions = {},
): Promise<HandoffResult> {
  const readyTimeoutMs = options.captureReadyTimeoutMs ?? DEFAULT_CAPTURE_READY_TIMEOUT_MS;
  const childLivenessTimeoutMs = options.childLivenessTimeoutMs ?? DEFAULT_CHILD_LIVENESS_TIMEOUT_MS;
  const childStableWindowMs = options.childStableWindowMs ?? DEFAULT_CHILD_STABLE_WINDOW_MS;
  const stages = options.recoveryStages;
  const rebuiltId = request.rebuilt.sessionId;

  const gate = ports.preCommitGate();
  if (gate !== null) {
    ports.log(`cc-lhc handoff cancelled pre-commit (${request.operation}): ${gate}`);
    return { kind: "cancelled", reason: gate };
  }

  // Prove the exact old-child identity and prepare the durable input journal
  // BEFORE any barrier or termination. Unavailable identity/journal — or a THROW
  // from the callback — cancels safely: nothing has changed (no barrier, no
  // descriptor close, no child touched).
  if (stages !== undefined) {
    let prep: { ok: true } | { ok: false; reason: string };
    try {
      prep = stages.prepareBarrier();
    } catch (cause) {
      ports.log(`cc-lhc handoff cancelled pre-commit (${request.operation}): prepare threw: ${reasonOf(cause)}`);
      return { kind: "cancelled", reason: `barrier prepare failed: ${reasonOf(cause)}` };
    }
    if (!prep.ok) {
      ports.log(`cc-lhc handoff cancelled pre-commit (${request.operation}): ${prep.reason}`);
      return { kind: "cancelled", reason: prep.reason };
    }
  }

  // ---- COMMIT ----
  // Past this point NO raw exception may escape without a named result + recovery
  // artifact + journal settlement.
  ports.beginInputBarrier();
  ports.log(`cc-lhc handoff commit (${request.operation}): ${request.oldSessionId} -> ${rebuiltId}`);
  // Closing the old descriptor is best-effort fail-closed retrieval; a throw here
  // must not abort the handoff (the new generation republishes).
  try {
    ports.closeOldDescriptor();
  } catch (cause) {
    ports.log(`cc-lhc handoff WARNING: closeOldDescriptor threw (continuing): ${reasonOf(cause)}`);
  }

  const rollbackTimeouts = { readyTimeoutMs, childLivenessTimeoutMs, childStableWindowMs };

  let term: { exited: boolean; escalated: boolean };
  try {
    term = await ports.terminateOldChild();
  } catch (cause) {
    // Old-child exit is unproven: fail closed, keep the buffered input.
    return failed(ports, request, `old child termination threw: ${reasonOf(cause)}`, true);
  }
  if (!term.exited) {
    // Pathological: the old child survived group SIGKILL. It still owns the
    // terminal — give its stdin back (ordered, once) IF the journal is durable;
    // a non-durable barrier is never delivered even to the surviving old child.
    const baseReason = "old child did not exit after SIGKILL";
    if (!barrierDurable(ports)) {
      return failed(ports, request, `${baseReason}; input journal not durable — delivery withheld`, true);
    }
    let flushed: number;
    try {
      flushed = ports.flushInputBarrier(ports.currentChild());
    } catch (cause) {
      return failed(ports, request, `${baseReason}; input delivery failed — ambiguous: ${reasonOf(cause)}`, true);
    }
    ports.log(
      `cc-lhc handoff FAILED (${request.operation}): ${baseReason}; old session continues; ` +
        `${flushed} buffered input byte(s) returned to it`,
    );
    return {
      kind: "failed",
      reason: baseReason,
      oldSessionId: request.oldSessionId,
      rebuiltSessionId: rebuiltId,
      childAlive: true,
      recoveryArtifactPath: null,
      retainedInputBytes: 0,
    };
  }
  if (term.escalated) ports.log("cc-lhc handoff: old child required SIGKILL escalation");

  // Old-child exit is proven: CAS advance old_child_exited BEFORE the capture
  // drain, so a later drain failure still leaves the durable stage at
  // old_child_exited. A stage failure stops forward progress (never faked) — the
  // old child is gone, so the existing rollback path re-establishes it.
  if (stages !== undefined) {
    try {
      stages.recordOldChildExited();
    } catch (cause) {
      return rollback(request, ports, rollbackTimeouts, `old_child_exited stage failed: ${reasonOf(cause)}`);
    }
  }

  // Capture stayed attached through child exit; now final flush + drain. A drain
  // throw after the proven exit routes to rollback (stage stays old_child_exited).
  try {
    await ports.stopCurrentCapture();
  } catch (cause) {
    return rollback(request, ports, rollbackTimeouts, `capture drain failed after exit: ${reasonOf(cause)}`);
  }

  // ---- replacement generation ----
  let child: HandoffChild;
  try {
    child = ports.spawnChild(rebuiltId);
  } catch (cause) {
    return rollback(request, ports, rollbackTimeouts, `replacement spawn failed: ${reasonOf(cause)}`);
  }

  try {
    ports.startRebuiltCapture(request);
  } catch (cause) {
    await ports.killCurrentChild().catch(() => {});
    await ports.stopCurrentCapture().catch(() => {});
    return rollback(request, ports, rollbackTimeouts, `rebuilt capture start failed: ${reasonOf(cause)}`);
  }

  let ready: "ready" | "degraded" | "timeout";
  try {
    ready = await ports.awaitCaptureReady(readyTimeoutMs);
  } catch (cause) {
    await ports.killCurrentChild().catch(() => {});
    await ports.stopCurrentCapture().catch(() => {});
    return rollback(request, ports, rollbackTimeouts, `replacement capture ready-wait threw: ${reasonOf(cause)}`);
  }
  if (ready !== "ready") {
    await ports.killCurrentChild().catch(() => {});
    await ports.stopCurrentCapture().catch(() => {});
    return rollback(request, ports, rollbackTimeouts, `replacement capture ${ready}`);
  }

  // Capture ready-after-replay proves the archive projection only. The child
  // must additionally prove it is a LIVE replacement: it emitted PTY output
  // and survived a short stabilization window. A child that dies after static
  // replay must never receive success, lineage, or buffered input.
  let liveness: "stable" | "exited" | "timeout";
  try {
    liveness = await ports.awaitChildStabilized(childLivenessTimeoutMs, childStableWindowMs);
  } catch (cause) {
    await ports.killCurrentChild().catch(() => {});
    await ports.stopCurrentCapture().catch(() => {});
    return rollback(request, ports, rollbackTimeouts, `replacement liveness-wait threw: ${reasonOf(cause)}`);
  }
  if (liveness !== "stable") {
    await ports.killCurrentChild().catch(() => {});
    await ports.stopCurrentCapture().catch(() => {});
    return rollback(request, ports, rollbackTimeouts, `replacement child liveness ${liveness}`);
  }

  // Replacement is a proven live child: probe + store its exact identity and CAS
  // advance replacement_ready. Unavailable identity, a CAS conflict, OR a THROW
  // means it is NOT ready — kill + rollback through the existing path.
  if (stages !== undefined) {
    let rep: { ok: true } | { ok: false; reason: string };
    try {
      rep = stages.recordReplacementReady();
    } catch (cause) {
      rep = { ok: false, reason: `replacement_ready stage threw: ${reasonOf(cause)}` };
    }
    if (!rep.ok) {
      await ports.killCurrentChild().catch(() => {});
      await ports.stopCurrentCapture().catch(() => {});
      return rollback(request, ports, rollbackTimeouts, `replacement not ready: ${rep.reason}`);
    }
  }

  // ---- proven ready-after-replay AND live child: advance lineage + descriptor ----
  // Lineage/descriptor are BEST-EFFORT: a registration/publish/stage failure OR
  // throw is a warning and leaves the stage truthfully un-advanced; never a gate.
  let lineageWarning: string | undefined;
  let lineage: { ok: true } | { ok: false; reason: string };
  try {
    lineage = await ports.registerSuccessLineage(request);
  } catch (cause) {
    lineage = { ok: false, reason: `lineage registration threw: ${reasonOf(cause)}` };
  }
  if (lineage.ok) {
    try {
      stages?.recordLineageRecorded();
    } catch (cause) {
      ports.log(`cc-lhc handoff WARNING: lineage_recorded stage not advanced: ${reasonOf(cause)}`);
    }
  } else {
    lineageWarning = `success lineage registration failed: ${lineage.reason}`;
    ports.log(`cc-lhc handoff WARNING: ${lineageWarning}`);
  }
  let descriptorWarning: string | undefined;
  let descriptorPublished: boolean;
  try {
    descriptorPublished = ports.publishReadyDescriptor();
  } catch (cause) {
    descriptorPublished = false;
    ports.log(`cc-lhc handoff WARNING: publishReadyDescriptor threw: ${reasonOf(cause)}`);
  }
  if (descriptorPublished) {
    try {
      stages?.recordDescriptorPublished();
    } catch (cause) {
      ports.log(`cc-lhc handoff WARNING: descriptor_published stage not advanced: ${reasonOf(cause)}`);
    }
  } else {
    descriptorWarning = "ready descriptor publish failed — retrieval stays fail-closed this generation";
    ports.log(`cc-lhc handoff WARNING: ${descriptorWarning}`);
  }

  // Delivery: durable-or-withhold, ambiguity-safe. A withheld/ambiguous delivery
  // is a failed handoff into the LIVE replacement child (childAlive true).
  const delivery = deliver(ports, request, child, true);
  if (!delivery.ok) return delivery.result;
  ports.log(
    `cc-lhc handoff success (${request.operation}): session ${rebuiltId} live, ` +
      `${delivery.bytes} buffered input byte(s) delivered`,
  );
  return {
    kind: "success",
    newSessionId: rebuiltId,
    flushedInputBytes: delivery.bytes,
    ...(lineageWarning === undefined ? {} : { lineageWarning }),
    ...(descriptorWarning === undefined ? {} : { descriptorWarning }),
  };
}

interface RollbackTimeouts {
  readyTimeoutMs: number;
  childLivenessTimeoutMs: number;
  childStableWindowMs: number;
}

async function rollback(
  request: HandoffRequest,
  ports: HandoffPorts,
  timeouts: RollbackTimeouts,
  reason: string,
): Promise<HandoffResult> {
  ports.log(`cc-lhc handoff rollback (${request.operation}): ${reason}`);
  let child: HandoffChild;
  try {
    child = ports.spawnChild(request.oldSessionId);
  } catch (cause) {
    return failed(ports, request, `${reason}; rollback spawn failed: ${reasonOf(cause)}`, false);
  }

  try {
    ports.startRollbackCapture(request.oldSessionId);
  } catch (cause) {
    return failed(ports, request, `${reason}; rollback capture start failed: ${reasonOf(cause)}`, true);
  }

  let ready: "ready" | "degraded" | "timeout";
  try {
    ready = await ports.awaitCaptureReady(timeouts.readyTimeoutMs);
  } catch (cause) {
    return failed(ports, request, `${reason}; rollback capture ready-wait threw: ${reasonOf(cause)}`, true);
  }
  if (ready !== "ready") {
    // The old child is alive; its capture is not proven. Retain the buffer —
    // delivering bytes into an uncaptured session would lose them from the record.
    return failed(ports, request, `${reason}; rollback capture ${ready}`, true);
  }

  // Same input-loss invariant as the forward path: never deliver buffered
  // input to a rollback child that has not proven PTY liveness.
  let liveness: "stable" | "exited" | "timeout";
  try {
    liveness = await ports.awaitChildStabilized(timeouts.childLivenessTimeoutMs, timeouts.childStableWindowMs);
  } catch (cause) {
    return failed(ports, request, `${reason}; rollback liveness-wait threw: ${reasonOf(cause)}`, true);
  }
  if (liveness !== "stable") {
    return failed(ports, request, `${reason}; rollback child liveness ${liveness}`, liveness !== "exited");
  }

  let descriptorWarning: string | undefined;
  let descriptorPublished: boolean;
  try {
    descriptorPublished = ports.publishReadyDescriptor();
  } catch (cause) {
    descriptorPublished = false;
    ports.log(`cc-lhc handoff WARNING: rollback publishReadyDescriptor threw: ${reasonOf(cause)}`);
  }
  if (!descriptorPublished) {
    descriptorWarning = "ready descriptor publish failed — retrieval stays fail-closed this generation";
    ports.log(`cc-lhc handoff WARNING: ${descriptorWarning}`);
  }

  // Rollback delivery uses the SAME durable-or-withhold, ambiguity-safe protocol.
  const delivery = deliver(ports, request, child, true);
  if (!delivery.ok) return delivery.result;
  ports.log(
    `cc-lhc handoff rolled back to ${request.oldSessionId}: ${reason}; ` +
      `${delivery.bytes} buffered input byte(s) delivered`,
  );
  return {
    kind: "rolled_back",
    reason,
    oldSessionId: request.oldSessionId,
    flushedInputBytes: delivery.bytes,
    ...(descriptorWarning === undefined ? {} : { descriptorWarning }),
  };
}

function failed(ports: HandoffPorts, request: HandoffRequest, reason: string, childAlive: boolean): HandoffResult {
  const buffer = ports.takeInputBarrierBuffer();
  const artifactPath = ports.writeRecoveryArtifact({
    reason,
    oldSessionId: request.oldSessionId,
    rebuiltSessionId: request.rebuilt.sessionId,
    bufferedInputBase64: buffer.toString("base64"),
    bufferedInputBytes: buffer.length,
  });
  ports.log(
    `cc-lhc handoff FAILED (${request.operation}): ${reason}; ` +
      `old=${request.oldSessionId} rebuilt=${request.rebuilt.sessionId} ` +
      `recovery=${artifactPath ?? "UNWRITTEN"} retainedInputBytes=${buffer.length}`,
  );
  return {
    kind: "failed",
    reason,
    oldSessionId: request.oldSessionId,
    rebuiltSessionId: request.rebuilt.sessionId,
    childAlive,
    recoveryArtifactPath: artifactPath,
    retainedInputBytes: buffer.length,
  };
}
