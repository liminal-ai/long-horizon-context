/**
 * Staged compact-continuation runtime (LIM-61 correction).
 *
 * Normative order at a settled seam:
 * 1. Validate host facts (closed).
 * 2. Seam eligibility / epoch (skip — no claim).
 * 3. Durable open-turn + pending-boundary detection (no mutation).
 * 4. Health proofs (capture/identity/open-turn/correlation/writer posture).
 * 5. Provider usage / pressure / continuation branch.
 * 6. Claim writer only when a compact path will mutate.
 * 7. Optional force_turn_end → compact prepare → marker → install.
 * 8. Atomic receipt + writer release.
 *
 * Crash recovery: re-enter with the same attemptId; resume from durable
 * boundary/stage state. Completed attemptId replays stored terminal receipt.
 */

import type { MessageEventInput } from "../../intake-stream/index.js";
import * as intakeStream from "../../intake-stream/index.js";
import {
  COMPACT_CONTINUATION_CONTRACT_VERSION,
  COMPACT_CONTINUATION_MARKER_ACTION,
  COMPACT_CONTINUATION_MARKER_CAUSE,
  COMPACT_CONTINUATION_MARKER_KIND,
  CONTEXT_COMPACT_CONTINUE_REASON,
  type CompactContinuationDecision,
  type CompactContinuationInput,
  type CompactContinuationPolicy,
  type CompactContinuationReceipt,
  type CompactContinuationSeam,
  type CompactMaterialFacts,
  compactContinuationMarkerIdempotencyKey,
  decideCompactContinuation,
  type ForcedContinuationBoundary,
  type PostMeasurementEstimate,
  type ProviderUsageAuthority,
  type WorkContinuation,
  type WriterClaim,
} from "../../shared-tech/compact-continuation/index.js";
import { storageFailure } from "../../shared-tech/errors.js";
import type { CompactReceipt, ErrorResult, OpResult, ViewCompactParams } from "../../shared-tech/index.js";
import { createDbReadTransaction, createDbWriteTransaction } from "../../shared-tech/persist.js";
import * as threadView from "../../thread-view/index.js";
import type { ThreadRef } from "../../threads/index.js";
import { resolveThreadRef } from "../../threads/index.js";
import { assembleCandidateFromPrepared } from "./candidate.js";
import {
  appendStageLog,
  type BoundaryRow,
  claimLhcWriter,
  listBoundaries,
  listReceipts,
  listStageLog,
  markerExistsByIdempotencyKey,
  persistReceipt,
  readOpenTurnIds,
  readOpenTurnMemberCount,
  readPendingBoundary,
  readReceiptByAttemptId,
  readWriterClaim,
  releaseLhcWriter,
  type StageName,
  type StoredCompactContinuationReceipt,
  upsertBoundary,
} from "./store.js";
import { provePendingToolPair } from "./tool-pair.js";
import { validateHostFacts } from "./validate-host.js";

// ── Host input ──────────────────────────────────────────────────────────────

export type CompactContinuationHostFacts = {
  /**
   * Stable attempt key. Repair reuses the same id. A completed attemptId
   * replays the stored terminal receipt without re-mutation.
   */
  attemptId: string;
  seam: CompactContinuationSeam;
  providerUsage: ProviderUsageAuthority;
  postMeasurementEstimate: PostMeasurementEstimate;
  policy: CompactContinuationPolicy;
  continuation: WorkContinuation;
  /**
   * Host writer posture at seam entry. `lhc` means this same attempt already
   * holds the claim (crash recovery). `native`/`conflict` refuse.
   */
  writerClaim: WriterClaim;
  captureComplete: boolean;
  providerIdentityValid: boolean;
  /** Optional; ignored when it contradicts durable single-open-turn state. */
  singleOpenTurn?: boolean;
  actor: string;
  harness: string;
  compact?: { profile?: string; params?: ViewCompactParams };
  testHooks?: CompactContinuationTestHooks;
};

export type CompactContinuationTestHooks = {
  forceCompactStructurallyValid?: boolean;
  forceInstallSucceeds?: boolean;
  forceUsefulReduction?: boolean;
  forceCanProduceValidProviderRequest?: boolean;
  forceDerivationsMissingOrFailed?: boolean;
  /** Skip real compact write (material still from hooks). Test-only. */
  skipRealCompact?: boolean;
  failInstallBeforeWrite?: boolean;
  interruptAfterBoundary?: boolean;
  interruptAfterMarker?: boolean;
  /** Fail the atomic receipt+release transaction. */
  failFinalizeWrite?: boolean;
  /** Fail only the receipt write (finalize aborts). */
  failReceiptWrite?: boolean;
};

export type CompactContinuationRunResult = {
  decision: CompactContinuationDecision;
  receipt: CompactContinuationReceipt;
  forcedBoundaryThisAttempt: boolean;
  continuationTurnId: string | null;
  markerPersisted: boolean;
  compactReceipt: CompactReceipt | null;
  nextProviderRequestAllowed: boolean;
  refuseReceiptFidelityDescribes: "installed_view_only";
  /** True when this call returned a previously stored terminal receipt. */
  replayedTerminalAttempt: boolean;
  /** Inspectable pending boundary, if any, after this call. */
  pendingBoundary: BoundaryRow | null;
};

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function callerError(code: ErrorResult["code"], reason: string): { ok: false; error: ErrorResult } {
  return { ok: false, error: { errorClass: "caller_error", code, reason } };
}

function isAtSeam(seam: CompactContinuationSeam): boolean {
  return (
    seam.modelResponseComplete && seam.requestedToolsSettled && seam.captureFlushed && seam.beforeNextProviderRequest
  );
}

function pressureAtOrAbove(facts: CompactContinuationHostFacts): boolean | null {
  if (!facts.providerUsage.available) return null;
  const next = facts.providerUsage.total + facts.postMeasurementEstimate.tokens;
  return next >= facts.policy.upperTriggerTokens;
}

function emptyMaterial(): CompactMaterialFacts {
  return {
    derivationsMissingOrFailed: false,
    lowerTargetMet: false,
    compactStructurallyValid: false,
    installSucceeds: false,
    usefulReduction: false,
    canProduceValidProviderRequest: false,
  };
}

function applyMaterialHooks(
  base: CompactMaterialFacts,
  hooks: CompactContinuationTestHooks | undefined,
): CompactMaterialFacts {
  if (hooks === undefined) return base;
  return {
    derivationsMissingOrFailed: hooks.forceDerivationsMissingOrFailed ?? base.derivationsMissingOrFailed,
    lowerTargetMet: base.lowerTargetMet,
    compactStructurallyValid: hooks.forceCompactStructurallyValid ?? base.compactStructurallyValid,
    installSucceeds: hooks.forceInstallSucceeds ?? base.installSucceeds,
    usefulReduction: hooks.forceUsefulReduction ?? base.usefulReduction,
    canProduceValidProviderRequest: hooks.forceCanProduceValidProviderRequest ?? base.canProduceValidProviderRequest,
  };
}

function buildOracleInput(
  facts: CompactContinuationHostFacts,
  invariants: CompactContinuationInput["invariants"],
  forcedContinuationBoundary: ForcedContinuationBoundary,
  compactMaterial: CompactMaterialFacts,
): CompactContinuationInput {
  return {
    contractVersion: COMPACT_CONTINUATION_CONTRACT_VERSION,
    seam: facts.seam,
    providerUsage: facts.providerUsage,
    postMeasurementEstimate: facts.postMeasurementEstimate,
    policy: facts.policy,
    continuation: facts.continuation,
    invariants,
    forcedContinuationBoundary,
    compactMaterial,
  };
}

function toRunResult(
  decision: CompactContinuationDecision,
  extras: {
    forcedBoundaryThisAttempt: boolean;
    continuationTurnId: string | null;
    compactReceipt: CompactReceipt | null;
    replayedTerminalAttempt: boolean;
    pendingBoundary: BoundaryRow | null;
  },
): CompactContinuationRunResult {
  return {
    decision,
    receipt: decision.receipt,
    forcedBoundaryThisAttempt: extras.forcedBoundaryThisAttempt,
    continuationTurnId: extras.continuationTurnId ?? decision.receipt.residual.continuationTurnId,
    markerPersisted: decision.receipt.residual.markerPersisted,
    compactReceipt: extras.compactReceipt,
    nextProviderRequestAllowed: decision.receipt.residual.nextProviderRequestAllowed,
    refuseReceiptFidelityDescribes: "installed_view_only",
    replayedTerminalAttempt: extras.replayedTerminalAttempt,
    pendingBoundary: extras.pendingBoundary,
  };
}

function markerEvent(facts: CompactContinuationHostFacts, continuationTurnId: string): MessageEventInput {
  return {
    eventKind: "compact_continuation_marker",
    idempotencyKey: compactContinuationMarkerIdempotencyKey(continuationTurnId),
    actor: facts.actor,
    harness: facts.harness,
    payload: {
      kind: COMPACT_CONTINUATION_MARKER_KIND,
      continuationTurnId,
      cause: COMPACT_CONTINUATION_MARKER_CAUSE,
      action: COMPACT_CONTINUATION_MARKER_ACTION,
      newUserRequest: false,
      waitForUser: false,
    },
  };
}

function turnEndEvent(facts: CompactContinuationHostFacts, attemptId: string): MessageEventInput {
  return {
    eventKind: "turn_end",
    idempotencyKey: `lhc.compact_continuation.force_turn_end:${attemptId}`,
    actor: facts.actor,
    harness: facts.harness,
    payload: {
      outcome: "completed",
      outcomeReason: CONTEXT_COMPACT_CONTINUE_REASON,
    },
  };
}

/**
 * Pending repair boundary from durable status table (not marker presence alone).
 * Complete boundaries are ordinary turns and do not force repair.
 */
function pendingBoundaryAsForced(pending: BoundaryRow | null): ForcedContinuationBoundary {
  if (pending === null) return { applied: false };
  if (pending.status !== "pending" && pending.status !== "failed_repairable") {
    return { applied: false };
  }
  return {
    applied: true,
    continuationTurnId: pending.continuationTurnId,
    forcedThisSeam: false,
    markerAlreadyPersisted: pending.markerPersisted,
  };
}

async function stageLog(
  ref: ThreadRef,
  attemptId: string,
  stage: StageName,
  clock: () => Date,
  detailObj?: Record<string, unknown>,
): Promise<OpResult<true>> {
  const result = await createDbWriteTransaction(
    ref,
    (tx) => {
      appendStageLog(tx.db, attemptId, stage, clock().toISOString(), detailObj);
      return true as const;
    },
    clock,
  );
  if (!result.ok) return result;
  return { ok: true, value: true };
}

/**
 * Atomic receipt persist + optional writer release in one transaction.
 * Returns storage failure if either write fails; does not claim success early.
 */
async function finalizeAttempt(
  ref: ThreadRef,
  facts: CompactContinuationHostFacts,
  decision: CompactContinuationDecision,
  opts: {
    releaseWriter: boolean;
    terminal: boolean;
    boundaryUpdate?: {
      continuationTurnId: string;
      status: "pending" | "complete" | "failed_repairable";
      markerPersisted: boolean;
      lastStage: string;
      forcedAt: string;
      completedAt?: string | null;
    };
    forcedBoundaryThisAttempt: boolean;
    continuationTurnId: string | null;
    compactReceipt: CompactReceipt | null;
  },
  clock: () => Date,
): Promise<OpResult<CompactContinuationRunResult>> {
  const hooks = facts.testHooks;
  if (hooks?.failFinalizeWrite === true || hooks?.failReceiptWrite === true) {
    return storageFailure("compact-continuation finalize write failed (test injection)");
  }

  const write = await createDbWriteTransaction(
    ref,
    (tx) => {
      const recordedAt = clock().toISOString();
      const status = persistReceipt(tx.db, facts.attemptId, recordedAt, decision, opts.terminal);
      if (status === "already_terminal") {
        // Another concurrent finalizer won; treat as success via stored row.
        return { kind: "already_terminal" as const };
      }
      appendStageLog(tx.db, facts.attemptId, "receipt_recorded", recordedAt, {
        terminal: opts.terminal,
        outcome: decision.receipt.outcome,
      });
      if (opts.boundaryUpdate !== undefined) {
        upsertBoundary(tx.db, {
          continuationTurnId: opts.boundaryUpdate.continuationTurnId,
          attemptId: facts.attemptId,
          status: opts.boundaryUpdate.status,
          markerPersisted: opts.boundaryUpdate.markerPersisted,
          lastStage: opts.boundaryUpdate.lastStage,
          forcedAt: opts.boundaryUpdate.forcedAt,
          completedAt: opts.boundaryUpdate.completedAt ?? null,
        });
      }
      if (opts.releaseWriter) {
        const released = releaseLhcWriter(tx.db, facts.attemptId);
        if (!released) {
          throw new Error(`failed to release writer for attempt ${facts.attemptId}`);
        }
        appendStageLog(tx.db, facts.attemptId, "writer_released", recordedAt);
      }
      return { kind: "ok" as const };
    },
    clock,
  );
  if (!write.ok) return write;

  const pending = await createDbReadTransaction(ref, (tx) => readPendingBoundary(tx.db));
  if (!pending.ok) return pending;

  return {
    ok: true,
    value: toRunResult(decision, {
      forcedBoundaryThisAttempt: opts.forcedBoundaryThisAttempt,
      continuationTurnId: opts.continuationTurnId,
      compactReceipt: opts.compactReceipt,
      replayedTerminalAttempt: write.value.kind === "already_terminal",
      pendingBoundary: pending.value,
    }),
  };
}

/**
 * Run one compact-continuation attempt against thread state.
 */
export async function runCompactContinuation(
  ref: ThreadRef,
  facts: CompactContinuationHostFacts,
  clock: () => Date = () => new Date(),
): Promise<OpResult<CompactContinuationRunResult>> {
  // ── Closed host-fact validation before any I/O ──────────────────────────
  const inputIssue = validateHostFacts(facts);
  if (inputIssue !== undefined) return { ok: false, error: inputIssue };

  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;

  const hooks = facts.testHooks;

  // ── Terminal attempt replay ─────────────────────────────────────────────
  const existing = await createDbReadTransaction(ref, (tx) => readReceiptByAttemptId(tx.db, facts.attemptId));
  if (!existing.ok) return existing;
  if (existing.value !== null && existing.value.terminal) {
    const pending = await createDbReadTransaction(ref, (tx) => readPendingBoundary(tx.db));
    if (!pending.ok) return pending;
    return {
      ok: true,
      value: toRunResult(existing.value.decision, {
        forcedBoundaryThisAttempt: false,
        continuationTurnId: existing.value.continuationTurnId,
        compactReceipt: null,
        replayedTerminalAttempt: true,
        pendingBoundary: pending.value,
      }),
    };
  }

  // ── Pre-seam skips (no writer claim) ────────────────────────────────────
  const preSkip =
    facts.seam.insideTransportRetry ||
    !isAtSeam(facts.seam) ||
    facts.seam.inputEpochAtDecision !== facts.seam.inputEpochAtApply;

  // Durable single-open-turn always wins over host override.
  const openRead = await createDbReadTransaction(ref, (tx) => {
    const ids = readOpenTurnIds(tx.db);
    return { singleOpenTurn: ids.length === 1, openIds: ids };
  });
  if (!openRead.ok) return openRead;
  const singleOpenTurn = openRead.value.singleOpenTurn;

  const pendingRead = await createDbReadTransaction(ref, (tx) => readPendingBoundary(tx.db));
  if (!pendingRead.ok) return pendingRead;
  const pendingBoundary = pendingRead.value;
  const forcedFromPending = pendingBoundaryAsForced(pendingBoundary);

  // Out-of-band release on skip when this attempt holds the claim.
  if (preSkip) {
    if (facts.writerClaim === "lhc") {
      const rel = await createDbWriteTransaction(ref, (tx) => releaseLhcWriter(tx.db, facts.attemptId), clock);
      if (!rel.ok) return rel;
    }
    const decision = decideCompactContinuation(
      buildOracleInput(
        facts,
        {
          captureComplete: facts.captureComplete,
          providerIdentityValid: facts.providerIdentityValid,
          singleOpenTurn,
          writerClaim: "none",
        },
        forcedFromPending,
        emptyMaterial(),
      ),
    );
    return finalizeAttempt(
      ref,
      facts,
      decision,
      {
        releaseWriter: false,
        terminal: true,
        forcedBoundaryThisAttempt: false,
        continuationTurnId: decision.receipt.residual.continuationTurnId,
        compactReceipt: null,
      },
      clock,
    );
  }

  // ── Settled seam: health / writer posture before any claim ──────────────
  // Native/conflict refuse without claiming.
  if (facts.writerClaim === "native" || facts.writerClaim === "conflict") {
    const decision = decideCompactContinuation(
      buildOracleInput(
        facts,
        {
          captureComplete: facts.captureComplete,
          providerIdentityValid: facts.providerIdentityValid,
          singleOpenTurn,
          writerClaim: facts.writerClaim,
        },
        forcedFromPending,
        emptyMaterial(),
      ),
    );
    return finalizeAttempt(
      ref,
      facts,
      decision,
      {
        releaseWriter: false,
        terminal: true,
        forcedBoundaryThisAttempt: false,
        continuationTurnId: decision.receipt.residual.continuationTurnId,
        compactReceipt: null,
      },
      clock,
    );
  }

  // Health proofs — refuse via oracle without mutation when unproven.
  const healthBad =
    !facts.captureComplete ||
    !facts.providerIdentityValid ||
    !singleOpenTurn ||
    (facts.continuation.kind === "pending_correlated_tool_result" && !facts.continuation.correlationValid);

  // Durable tool-pair proof for pending-tool path (host correlation insufficient).
  let toolPairOk = true;
  if (facts.continuation.kind === "pending_correlated_tool_result") {
    const toolCallId = facts.continuation.toolCallId;
    if (facts.continuation.correlationValid) {
      const proof = await createDbReadTransaction(ref, (tx) => provePendingToolPair(tx.db, toolCallId));
      if (!proof.ok) return proof;
      if (!proof.value.ok) {
        toolPairOk = false;
      }
    } else {
      toolPairOk = false;
    }
  }

  // Illegal applied-boundary + wrong continuation kind (repair path only).
  if (forcedFromPending.applied && facts.continuation.kind !== "active_non_tool") {
    const decision = decideCompactContinuation(
      buildOracleInput(
        facts,
        {
          captureComplete: facts.captureComplete,
          providerIdentityValid: facts.providerIdentityValid,
          singleOpenTurn,
          writerClaim: "none",
        },
        forcedFromPending,
        emptyMaterial(),
      ),
    );
    return finalizeAttempt(
      ref,
      facts,
      decision,
      {
        releaseWriter: false,
        terminal: true,
        forcedBoundaryThisAttempt: false,
        continuationTurnId: decision.receipt.residual.continuationTurnId,
        compactReceipt: null,
      },
      clock,
    );
  }

  if (healthBad || !toolPairOk) {
    // Force invalid_tool_correlation when durable pair fails even if host said valid.
    const cont =
      !toolPairOk && facts.continuation.kind === "pending_correlated_tool_result"
        ? { ...facts.continuation, correlationValid: false }
        : facts.continuation;
    const decision = decideCompactContinuation(
      buildOracleInput(
        { ...facts, continuation: cont },
        {
          captureComplete: facts.captureComplete,
          providerIdentityValid: facts.providerIdentityValid,
          singleOpenTurn,
          writerClaim: "none",
        },
        forcedFromPending.applied && facts.continuation.kind === "active_non_tool"
          ? forcedFromPending
          : { applied: false },
        emptyMaterial(),
      ),
    );
    return finalizeAttempt(
      ref,
      facts,
      decision,
      {
        releaseWriter: false,
        terminal: true,
        forcedBoundaryThisAttempt: false,
        continuationTurnId: decision.receipt.residual.continuationTurnId,
        compactReceipt: null,
      },
      clock,
    );
  }

  // ── Pressure / branch (no claim yet) ────────────────────────────────────
  const pressure = pressureAtOrAbove(facts);
  // Repair pending boundary always takes continue-turn path regardless of pressure.
  const needsContinueTurn =
    forcedFromPending.applied || (pressure === true && facts.continuation.kind === "active_non_tool");
  const needsPreserveTool =
    !forcedFromPending.applied &&
    pressure === true &&
    facts.continuation.kind === "pending_correlated_tool_result" &&
    toolPairOk;

  // No-compact quiet paths: never claim writer, never mutate.
  if (!needsContinueTurn && !needsPreserveTool) {
    const decision = decideCompactContinuation(
      buildOracleInput(
        facts,
        {
          captureComplete: facts.captureComplete,
          providerIdentityValid: facts.providerIdentityValid,
          singleOpenTurn,
          writerClaim: "none",
        },
        { applied: false },
        emptyMaterial(),
      ),
    );
    return finalizeAttempt(
      ref,
      facts,
      decision,
      {
        releaseWriter: false,
        terminal: true,
        forcedBoundaryThisAttempt: false,
        continuationTurnId: null,
        compactReceipt: null,
      },
      clock,
    );
  }

  // ── Claim writer only for compact paths ─────────────────────────────────
  const claimResult = await createDbWriteTransaction(
    ref,
    (tx) => {
      const claimed = claimLhcWriter(tx.db, facts.attemptId, clock().toISOString());
      if (claimed) {
        appendStageLog(tx.db, facts.attemptId, "claimed_writer", clock().toISOString());
      }
      return { claimed };
    },
    clock,
  );
  if (!claimResult.ok) return claimResult;
  if (!claimResult.value.claimed) {
    const held = await createDbReadTransaction(ref, (tx) => readWriterClaim(tx.db));
    if (!held.ok) return held;
    return callerError(
      "compact_continuation_writer_conflict",
      `cannot claim LHC writer for attempt ${facts.attemptId}; held by attempt ${held.value.attemptId ?? "unknown"} — resume with that attemptId`,
    );
  }

  let forcedBoundaryThisAttempt = false;
  let continuationTurnId: string | null = pendingBoundary?.continuationTurnId ?? null;
  let forcedContinuationBoundary: ForcedContinuationBoundary = forcedFromPending;
  let compactReceipt: CompactReceipt | null = null;
  let material = emptyMaterial();
  let boundaryForcedAt = pendingBoundary?.forcedAt ?? clock().toISOString();
  let markerPersistedDurable = pendingBoundary?.markerPersisted ?? false;

  try {
    // ── Force boundary if fresh continue-turn ─────────────────────────────
    if (needsContinueTurn && !forcedFromPending.applied) {
      const openCheck = await createDbReadTransaction(ref, (tx) => {
        const ids = readOpenTurnIds(tx.db);
        if (ids.length !== 1) return { ok: false as const, count: 0 };
        return { ok: true as const, count: readOpenTurnMemberCount(tx.db, ids[0]!) };
      });
      if (!openCheck.ok) {
        await createDbWriteTransaction(ref, (tx) => releaseLhcWriter(tx.db, facts.attemptId), clock);
        return openCheck;
      }
      if (!openCheck.value.ok || openCheck.value.count === 0) {
        // Active non-tool above trigger without forceable turn → oracle refuse.
        const decision = decideCompactContinuation(
          buildOracleInput(
            facts,
            {
              captureComplete: true,
              providerIdentityValid: true,
              singleOpenTurn: true,
              writerClaim: "lhc",
            },
            { applied: false },
            emptyMaterial(),
          ),
        );
        return finalizeAttempt(
          ref,
          facts,
          decision,
          {
            releaseWriter: true,
            terminal: true,
            forcedBoundaryThisAttempt: false,
            continuationTurnId: null,
            compactReceipt: null,
          },
          clock,
        );
      }

      const forceBatch = await intakeStream.messageEvents(ref, [turnEndEvent(facts, facts.attemptId)]);
      if (!forceBatch.ok) {
        await createDbWriteTransaction(ref, (tx) => releaseLhcWriter(tx.db, facts.attemptId), clock);
        // Reused attemptId for a new boundary often surfaces as no open transition.
        if (forceBatch.error.code === "storage_failure" || forceBatch.error.code === "invalid_event") {
          return forceBatch;
        }
        // turn_end idempotent skip → attempt conflict
        return callerError(
          "compact_continuation_attempt_conflict",
          `attemptId ${facts.attemptId} cannot force a new boundary (turn_end already recorded)`,
        );
      }
      const opened = forceBatch.value.turnTransitions.find((t) => t.action === "opened");
      if (opened === undefined) {
        await createDbWriteTransaction(ref, (tx) => releaseLhcWriter(tx.db, facts.attemptId), clock);
        return callerError(
          "compact_continuation_attempt_conflict",
          `attemptId ${facts.attemptId} force_turn_end did not open a continuation turn (likely reused attemptId)`,
        );
      }
      continuationTurnId = opened.turnId;
      forcedBoundaryThisAttempt = true;
      boundaryForcedAt = clock().toISOString();
      forcedContinuationBoundary = {
        applied: true,
        continuationTurnId,
        forcedThisSeam: true,
        markerAlreadyPersisted: false,
      };
      const boundWrite = await createDbWriteTransaction(
        ref,
        (tx) => {
          upsertBoundary(tx.db, {
            continuationTurnId: continuationTurnId!,
            attemptId: facts.attemptId,
            status: "pending",
            markerPersisted: false,
            lastStage: "force_turn_end",
            forcedAt: boundaryForcedAt,
          });
          appendStageLog(tx.db, facts.attemptId, "force_turn_end", boundaryForcedAt, {
            continuationTurnId,
          });
        },
        clock,
      );
      if (!boundWrite.ok) {
        await createDbWriteTransaction(ref, (tx) => releaseLhcWriter(tx.db, facts.attemptId), clock);
        return boundWrite;
      }

      if (hooks?.interruptAfterBoundary === true) {
        // Crash simulation: leave writer held, boundary pending, no terminal receipt.
        const decision = decideCompactContinuation(
          buildOracleInput(
            facts,
            {
              captureComplete: true,
              providerIdentityValid: true,
              singleOpenTurn: true,
              writerClaim: "lhc",
            },
            forcedContinuationBoundary,
            {
              ...emptyMaterial(),
              compactStructurallyValid: false,
              canProduceValidProviderRequest: false,
            },
          ),
        );
        await stageLog(ref, facts.attemptId, "interrupted", clock, {
          after: "force_turn_end",
          continuationTurnId,
        });
        const pending = await createDbReadTransaction(ref, (tx) => readPendingBoundary(tx.db));
        if (!pending.ok) return pending;
        return {
          ok: true,
          value: toRunResult(decision, {
            forcedBoundaryThisAttempt: true,
            continuationTurnId,
            compactReceipt: null,
            replayedTerminalAttempt: false,
            pendingBoundary: pending.value,
          }),
        };
      }
    } else if (forcedFromPending.applied) {
      continuationTurnId = forcedFromPending.continuationTurnId;
      forcedContinuationBoundary = forcedFromPending;
      markerPersistedDurable = forcedFromPending.markerAlreadyPersisted;
    }

    // ── Compact prepare + candidate material ──────────────────────────────
    let prepared: threadView.PreparedCompact | null = null;

    if (hooks?.skipRealCompact === true) {
      material = applyMaterialHooks(
        {
          derivationsMissingOrFailed: false,
          lowerTargetMet: true,
          compactStructurallyValid: true,
          installSucceeds: true,
          usefulReduction: true,
          canProduceValidProviderRequest: true,
        },
        hooks,
      );
    } else {
      const prepOpts: { profile?: string; params?: ViewCompactParams } = {};
      if (facts.compact?.profile !== undefined) prepOpts.profile = facts.compact.profile;
      if (facts.compact?.params !== undefined) prepOpts.params = facts.compact.params;
      const prep = await threadView.prepareCompact(ref, prepOpts);
      if (!prep.ok) {
        material = applyMaterialHooks(
          {
            derivationsMissingOrFailed: false,
            lowerTargetMet: false,
            compactStructurallyValid: false,
            installSucceeds: false,
            usefulReduction: false,
            canProduceValidProviderRequest: false,
          },
          hooks,
        );
      } else {
        prepared = prep.value;
        const candidate = await createDbReadTransaction(ref, (tx) =>
          assembleCandidateFromPrepared(tx.db, prepared!, facts.policy.lowerTargetTokens),
        );
        if (!candidate.ok) {
          await createDbWriteTransaction(ref, (tx) => releaseLhcWriter(tx.db, facts.attemptId), clock);
          return candidate;
        }
        material = applyMaterialHooks(
          {
            ...candidate.value.material,
            installSucceeds: false,
          },
          hooks,
        );
        await stageLog(ref, facts.attemptId, "compact_prepared", clock, {
          candidateTokens: candidate.value.candidateTokens,
          currentServedTokens: candidate.value.currentServedTokens,
          structuralIssues: candidate.value.structuralIssues,
        });
      }
    }

    // ── Marker before install (continue-turn only, when structure valid) ──
    if (
      needsContinueTurn &&
      forcedContinuationBoundary.applied === true &&
      material.compactStructurallyValid &&
      material.canProduceValidProviderRequest
    ) {
      const cTurnId = forcedContinuationBoundary.continuationTurnId;
      const already = await createDbReadTransaction(ref, (tx) =>
        markerExistsByIdempotencyKey(tx.db, compactContinuationMarkerIdempotencyKey(cTurnId)),
      );
      if (!already.ok) {
        await createDbWriteTransaction(ref, (tx) => releaseLhcWriter(tx.db, facts.attemptId), clock);
        return already;
      }
      if (!already.value) {
        const markerBatch = await intakeStream.messageEvents(ref, [markerEvent(facts, cTurnId)]);
        if (!markerBatch.ok) {
          await createDbWriteTransaction(ref, (tx) => releaseLhcWriter(tx.db, facts.attemptId), clock);
          return markerBatch;
        }
      }
      markerPersistedDurable = true;
      const markWrite = await createDbWriteTransaction(
        ref,
        (tx) => {
          upsertBoundary(tx.db, {
            continuationTurnId: cTurnId,
            attemptId: facts.attemptId,
            status: "pending",
            markerPersisted: true,
            lastStage: "marker_persisted",
            forcedAt: boundaryForcedAt,
          });
          appendStageLog(tx.db, facts.attemptId, "marker_persisted", clock().toISOString(), {
            continuationTurnId: cTurnId,
          });
        },
        clock,
      );
      if (!markWrite.ok) {
        await createDbWriteTransaction(ref, (tx) => releaseLhcWriter(tx.db, facts.attemptId), clock);
        return markWrite;
      }

      // Re-evaluate candidate after marker lands so model-visible structure includes it.
      if (prepared !== null && hooks?.skipRealCompact !== true) {
        const candidate2 = await createDbReadTransaction(ref, (tx) =>
          assembleCandidateFromPrepared(tx.db, prepared!, facts.policy.lowerTargetTokens),
        );
        if (candidate2.ok) {
          material = applyMaterialHooks({ ...candidate2.value.material, installSucceeds: false }, hooks);
        }
      }

      if (hooks?.interruptAfterMarker === true) {
        // Crash simulation: marker durable, writer still held, no terminal receipt.
        material = { ...material, installSucceeds: false };
        const decision = decideCompactContinuation(
          buildOracleInput(
            facts,
            {
              captureComplete: true,
              providerIdentityValid: true,
              singleOpenTurn: true,
              writerClaim: "lhc",
            },
            {
              applied: true,
              continuationTurnId: cTurnId,
              forcedThisSeam: forcedBoundaryThisAttempt,
              markerAlreadyPersisted: !forcedBoundaryThisAttempt,
            },
            material,
          ),
        );
        await stageLog(ref, facts.attemptId, "interrupted", clock, {
          after: "marker_persisted",
          continuationTurnId: cTurnId,
        });
        const pending = await createDbReadTransaction(ref, (tx) => readPendingBoundary(tx.db));
        if (!pending.ok) return pending;
        return {
          ok: true,
          value: toRunResult(decision, {
            forcedBoundaryThisAttempt,
            continuationTurnId: cTurnId,
            compactReceipt: null,
            replayedTerminalAttempt: false,
            pendingBoundary: pending.value,
          }),
        };
      }
    }

    // ── Install ───────────────────────────────────────────────────────────
    const canAttemptInstall =
      material.compactStructurallyValid &&
      material.canProduceValidProviderRequest &&
      (prepared !== null || hooks?.skipRealCompact === true);

    if (canAttemptInstall) {
      if (hooks?.failInstallBeforeWrite === true || hooks?.forceInstallSucceeds === false) {
        material = { ...material, installSucceeds: false };
      } else if (prepared !== null) {
        const installOpts: threadView.InstallPreparedOptions = {};
        if (needsContinueTurn && forcedContinuationBoundary.applied) {
          installOpts.allowedMarkerIdempotencyKey = compactContinuationMarkerIdempotencyKey(
            forcedContinuationBoundary.continuationTurnId,
          );
        }
        const installed = await threadView.installPreparedCompact(ref, prepared, installOpts);
        if (!installed.ok) {
          material = { ...material, installSucceeds: false };
        } else {
          material = {
            ...material,
            installSucceeds: true,
            usefulReduction: hooks?.forceUsefulReduction ?? material.usefulReduction,
            lowerTargetMet: installed.value.totalTokens <= facts.policy.lowerTargetTokens,
          };
          compactReceipt = installed.value;
          await stageLog(ref, facts.attemptId, "install_succeeded", clock, {
            viewId: installed.value.viewId,
          });
        }
      } else if (hooks?.skipRealCompact === true) {
        material = {
          ...material,
          installSucceeds: hooks.forceInstallSucceeds ?? true,
        };
        // Marker under skipRealCompact for continue-turn.
        if (
          needsContinueTurn &&
          forcedContinuationBoundary.applied &&
          material.compactStructurallyValid &&
          material.canProduceValidProviderRequest
        ) {
          const cTurnId = forcedContinuationBoundary.continuationTurnId;
          const already = await createDbReadTransaction(ref, (tx) =>
            markerExistsByIdempotencyKey(tx.db, compactContinuationMarkerIdempotencyKey(cTurnId)),
          );
          if (already.ok && !already.value) {
            await intakeStream.messageEvents(ref, [markerEvent(facts, cTurnId)]);
            markerPersistedDurable = true;
          }
        }
      }
    }

    // Final oracle boundary input.
    let finalBoundary: ForcedContinuationBoundary = { applied: false };
    if (needsContinueTurn && forcedContinuationBoundary.applied) {
      const cTurnId = forcedContinuationBoundary.continuationTurnId;
      const markerRead = await createDbReadTransaction(ref, (tx) =>
        markerExistsByIdempotencyKey(tx.db, compactContinuationMarkerIdempotencyKey(cTurnId)),
      );
      if (!markerRead.ok) {
        await createDbWriteTransaction(ref, (tx) => releaseLhcWriter(tx.db, facts.attemptId), clock);
        return markerRead;
      }
      finalBoundary = {
        applied: true,
        continuationTurnId: cTurnId,
        forcedThisSeam: forcedBoundaryThisAttempt,
        markerAlreadyPersisted: forcedBoundaryThisAttempt ? false : markerRead.value,
      };
      markerPersistedDurable = markerRead.value;
    }

    const decision = decideCompactContinuation(
      buildOracleInput(
        facts,
        {
          captureComplete: true,
          providerIdentityValid: true,
          singleOpenTurn: true,
          writerClaim: "lhc",
        },
        finalBoundary,
        material,
      ),
    );

    // Boundary completion: success outcomes complete; refuse after boundary is repairable.
    const successOutcomes = new Set(["compact_continue_turn", "degraded_compact", "no_reduction"]);
    const finalizeOpts: {
      releaseWriter: boolean;
      terminal: boolean;
      boundaryUpdate?: {
        continuationTurnId: string;
        status: "pending" | "complete" | "failed_repairable";
        markerPersisted: boolean;
        lastStage: string;
        forcedAt: string;
        completedAt?: string | null;
      };
      forcedBoundaryThisAttempt: boolean;
      continuationTurnId: string | null;
      compactReceipt: CompactReceipt | null;
    } = {
      releaseWriter: true,
      terminal: true,
      forcedBoundaryThisAttempt,
      continuationTurnId: finalBoundary.applied ? finalBoundary.continuationTurnId : continuationTurnId,
      compactReceipt,
    };
    if (finalBoundary.applied) {
      if (successOutcomes.has(decision.outcome) && material.installSucceeds) {
        finalizeOpts.boundaryUpdate = {
          continuationTurnId: finalBoundary.continuationTurnId,
          status: "complete",
          markerPersisted: true,
          lastStage: "install_succeeded",
          forcedAt: boundaryForcedAt,
          completedAt: clock().toISOString(),
        };
      } else if (decision.receipt.refused) {
        finalizeOpts.boundaryUpdate = {
          continuationTurnId: finalBoundary.continuationTurnId,
          status: "failed_repairable",
          markerPersisted: markerPersistedDurable,
          lastStage: material.installSucceeds === false ? "install_failed" : "compact_failed",
          forcedAt: boundaryForcedAt,
        };
      }
    }

    return finalizeAttempt(ref, facts, decision, finalizeOpts, clock);
  } catch (cause) {
    try {
      await createDbWriteTransaction(ref, (tx) => releaseLhcWriter(tx.db, facts.attemptId), clock);
    } catch {
      // best-effort
    }
    return storageFailure(`compact-continuation failed: ${detail(cause)}`);
  }
}

// ── Inspection surfaces ─────────────────────────────────────────────────────

export async function getCompactContinuationReceipt(
  ref: ThreadRef,
  attemptId: string,
): Promise<OpResult<StoredCompactContinuationReceipt | null>> {
  try {
    return await createDbReadTransaction(ref, (tx) => readReceiptByAttemptId(tx.db, attemptId));
  } catch (cause) {
    return storageFailure(`compact-continuation receipt read failed: ${detail(cause)}`);
  }
}

export async function listCompactContinuationReceipts(
  ref: ThreadRef,
  opts?: { limit?: number },
): Promise<OpResult<StoredCompactContinuationReceipt[]>> {
  try {
    return await createDbReadTransaction(ref, (tx) => listReceipts(tx.db, opts?.limit ?? 50));
  } catch (cause) {
    return storageFailure(`compact-continuation receipt list failed: ${detail(cause)}`);
  }
}

export async function getCompactContinuationWriterClaim(
  ref: ThreadRef,
): Promise<OpResult<{ claim: "none" | "lhc"; attemptId: string | null; claimedAt: string | null }>> {
  try {
    return await createDbReadTransaction(ref, (tx) => readWriterClaim(tx.db));
  } catch (cause) {
    return storageFailure(`compact-continuation writer read failed: ${detail(cause)}`);
  }
}

export async function hasCompactContinuationMarker(
  ref: ThreadRef,
  continuationTurnId: string,
): Promise<OpResult<boolean>> {
  try {
    return await createDbReadTransaction(ref, (tx) =>
      markerExistsByIdempotencyKey(tx.db, compactContinuationMarkerIdempotencyKey(continuationTurnId)),
    );
  } catch (cause) {
    return storageFailure(`compact-continuation marker probe failed: ${detail(cause)}`);
  }
}

export async function getPendingCompactContinuationBoundary(ref: ThreadRef): Promise<OpResult<BoundaryRow | null>> {
  try {
    return await createDbReadTransaction(ref, (tx) => readPendingBoundary(tx.db));
  } catch (cause) {
    return storageFailure(`compact-continuation boundary read failed: ${detail(cause)}`);
  }
}

export async function listCompactContinuationBoundaries(ref: ThreadRef): Promise<OpResult<BoundaryRow[]>> {
  try {
    return await createDbReadTransaction(ref, (tx) => listBoundaries(tx.db));
  } catch (cause) {
    return storageFailure(`compact-continuation boundary list failed: ${detail(cause)}`);
  }
}

export async function listCompactContinuationStages(
  ref: ThreadRef,
  attemptId: string,
): Promise<OpResult<Array<{ stage: string; detail: Record<string, unknown> | null; recordedAt: string }>>> {
  try {
    return await createDbReadTransaction(ref, (tx) => listStageLog(tx.db, attemptId));
  } catch (cause) {
    return storageFailure(`compact-continuation stage log read failed: ${detail(cause)}`);
  }
}
