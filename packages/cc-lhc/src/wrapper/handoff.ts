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
  /** Ordered post-commit user bytes, base64; never silently discarded. */
  bufferedInputBase64: string;
  bufferedInputBytes: number;
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
        return `handoff FAILED: ${result.reason}; old session ${result.oldSessionId} continues; ` +
          "no recovery artifact required";
      }
      const recovery =
        result.recoveryArtifactPath === null
          ? "recovery artifact write FAILED"
          : `recovery ${result.recoveryArtifactPath}`;
      return `handoff FAILED: ${result.reason}; old=${result.oldSessionId} rebuilt=${result.rebuiltSessionId}; ` +
        `${recovery}; retained input ${result.retainedInputBytes} byte(s)`;
    }
  }
}

export interface HandoffOptions {
  captureReadyTimeoutMs?: number;
  childLivenessTimeoutMs?: number;
  childStableWindowMs?: number;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function executeHandoff(
  request: HandoffRequest,
  ports: HandoffPorts,
  options: HandoffOptions = {},
): Promise<HandoffResult> {
  const readyTimeoutMs = options.captureReadyTimeoutMs ?? DEFAULT_CAPTURE_READY_TIMEOUT_MS;
  const childLivenessTimeoutMs = options.childLivenessTimeoutMs ?? DEFAULT_CHILD_LIVENESS_TIMEOUT_MS;
  const childStableWindowMs = options.childStableWindowMs ?? DEFAULT_CHILD_STABLE_WINDOW_MS;
  const rebuiltId = request.rebuilt.sessionId;

  const gate = ports.preCommitGate();
  if (gate !== null) {
    ports.log(`cc-lhc handoff cancelled pre-commit (${request.operation}): ${gate}`);
    return { kind: "cancelled", reason: gate };
  }

  // ---- COMMIT ----
  ports.beginInputBarrier();
  ports.log(`cc-lhc handoff commit (${request.operation}): ${request.oldSessionId} -> ${rebuiltId}`);
  ports.closeOldDescriptor();

  const rollbackTimeouts = { readyTimeoutMs, childLivenessTimeoutMs, childStableWindowMs };

  const term = await ports.terminateOldChild();
  if (!term.exited) {
    // Pathological: the old child survived group SIGKILL. It still owns the
    // terminal — give its stdin back (ordered, once) and change nothing else.
    const reason = "old child did not exit after SIGKILL";
    const flushed = ports.flushInputBarrier(ports.currentChild());
    ports.log(
      `cc-lhc handoff FAILED (${request.operation}): ${reason}; old session continues; ` +
        `${flushed} buffered input byte(s) returned to it`,
    );
    return {
      kind: "failed",
      reason,
      oldSessionId: request.oldSessionId,
      rebuiltSessionId: rebuiltId,
      childAlive: true,
      recoveryArtifactPath: null,
      retainedInputBytes: 0,
    };
  }
  if (term.escalated) ports.log("cc-lhc handoff: old child required SIGKILL escalation");

  // Capture stayed attached through child exit; now final flush + drain.
  await ports.stopCurrentCapture();

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
    await ports.killCurrentChild();
    await ports.stopCurrentCapture().catch(() => {});
    return rollback(request, ports, rollbackTimeouts, `rebuilt capture start failed: ${reasonOf(cause)}`);
  }

  const ready = await ports.awaitCaptureReady(readyTimeoutMs);
  if (ready !== "ready") {
    await ports.killCurrentChild();
    await ports.stopCurrentCapture().catch(() => {});
    return rollback(request, ports, rollbackTimeouts, `replacement capture ${ready}`);
  }

  // Capture ready-after-replay proves the archive projection only. The child
  // must additionally prove it is a LIVE replacement: it emitted PTY output
  // and survived a short stabilization window. A child that dies after static
  // replay must never receive success, lineage, or buffered input.
  const liveness = await ports.awaitChildStabilized(childLivenessTimeoutMs, childStableWindowMs);
  if (liveness !== "stable") {
    ports.killCurrentChild();
    await ports.stopCurrentCapture().catch(() => {});
    return rollback(request, ports, rollbackTimeouts, `replacement child liveness ${liveness}`);
  }

  // ---- proven ready-after-replay AND live child: advance lineage + descriptor ----
  let lineageWarning: string | undefined;
  const lineage = await ports.registerSuccessLineage(request);
  if (!lineage.ok) {
    lineageWarning = `success lineage registration failed: ${lineage.reason}`;
    ports.log(`cc-lhc handoff WARNING: ${lineageWarning}`);
  }
  let descriptorWarning: string | undefined;
  if (!ports.publishReadyDescriptor()) {
    descriptorWarning = "ready descriptor publish failed — retrieval stays fail-closed this generation";
    ports.log(`cc-lhc handoff WARNING: ${descriptorWarning}`);
  }

  const flushedInputBytes = ports.flushInputBarrier(child);
  ports.log(
    `cc-lhc handoff success (${request.operation}): session ${rebuiltId} live, ` +
      `${flushedInputBytes} buffered input byte(s) delivered`,
  );
  return {
    kind: "success",
    newSessionId: rebuiltId,
    flushedInputBytes,
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

  const ready = await ports.awaitCaptureReady(timeouts.readyTimeoutMs);
  if (ready !== "ready") {
    // The old child is alive; its capture is not proven. Retain the buffer —
    // delivering bytes into an uncaptured session would lose them from the record.
    return failed(ports, request, `${reason}; rollback capture ${ready}`, true);
  }

  // Same input-loss invariant as the forward path: never deliver buffered
  // input to a rollback child that has not proven PTY liveness.
  const liveness = await ports.awaitChildStabilized(
    timeouts.childLivenessTimeoutMs,
    timeouts.childStableWindowMs,
  );
  if (liveness !== "stable") {
    return failed(
      ports,
      request,
      `${reason}; rollback child liveness ${liveness}`,
      liveness !== "exited",
    );
  }

  let descriptorWarning: string | undefined;
  if (!ports.publishReadyDescriptor()) {
    descriptorWarning = "ready descriptor publish failed — retrieval stays fail-closed this generation";
    ports.log(`cc-lhc handoff WARNING: ${descriptorWarning}`);
  }

  const flushedInputBytes = ports.flushInputBarrier(child);
  ports.log(
    `cc-lhc handoff rolled back to ${request.oldSessionId}: ${reason}; ` +
      `${flushedInputBytes} buffered input byte(s) delivered`,
  );
  return {
    kind: "rolled_back",
    reason,
    oldSessionId: request.oldSessionId,
    flushedInputBytes,
    ...(descriptorWarning === undefined ? {} : { descriptorWarning }),
  };
}

function failed(
  ports: HandoffPorts,
  request: HandoffRequest,
  reason: string,
  childAlive: boolean,
): HandoffResult {
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
