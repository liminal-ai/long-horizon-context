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
import { readPartsActivation } from "../../thread-view/internal/snapshot.js";
import type { ThreadRef } from "../../threads/index.js";
import { resolveThreadRef } from "../../threads/index.js";
import { assembleCandidateFromPrepared } from "./candidate.js";
import { computeOperationIdentity, computeRetryPosture, hashAttemptIntent, hashRecord } from "./identity.js";
import { errorDetail as detail } from "./read.js";
import {
  appendStageLog,
  type BoundaryRow,
  claimLhcWriter,
  deleteBoundary,
  findContinuationTurnFromForceKey,
  insertAttemptIntent,
  listStageLog,
  markerExistsByIdempotencyKey,
  markForceIntentApplied,
  persistReceipt,
  readForceIntent,
  readOpenTurnIds,
  readOpenTurnMemberCount,
  readPendingBoundary,
  readReceiptByAttemptId,
  readWriterClaim,
  recordForceIntent,
  recordHostValidationAwaiting,
  releaseLhcWriter,
  type StageName,
  upsertBoundary,
} from "./store.js";
import { proveProtectedToolPairSet } from "./tool-pair.js";
import { validateHostFacts } from "./validate-host.js";

export type CompactContinuationHostFacts = {
  attemptId: string;
  seam: CompactContinuationSeam;
  providerUsage: ProviderUsageAuthority;
  postMeasurementEstimate: PostMeasurementEstimate;
  policy: CompactContinuationPolicy;
  continuation: WorkContinuation;
  writerClaim: WriterClaim;
  captureComplete: boolean;
  providerIdentityValid: boolean;
  singleOpenTurn?: boolean;
  actor: string;
  harness: string;
  compact?: { profile?: string; params?: ViewCompactParams };
};

export type CompactContinuationTestHooks = {
  forceCompactStructurallyValid?: boolean;
  forceInstallSucceeds?: boolean;
  forceUsefulReduction?: boolean;
  forceCanProduceValidProviderRequest?: boolean;
  forceDerivationsMissingOrFailed?: boolean;
  skipRealCompact?: boolean;
  failInstallBeforeWrite?: boolean;
  interruptAfterBoundary?: boolean;
  interruptAfterMarker?: boolean;
  interruptAfterMarkerEvent?: boolean;
  interruptAfterTurnEndCommit?: boolean;
  failFinalizeWrite?: boolean;
  failReceiptWrite?: boolean;
  failFinalizeAfterReceipt?: boolean;
  failFinalizeAtRelease?: boolean;
  failFinalizeAfterReleaseBeforeCommit?: boolean;
};

export type CompactContinuationWriterOwnershipCheck = (args: {
  threadId: string;
  attemptId: string;
}) => boolean | Promise<boolean>;

export type CompactContinuationRunOptions = {
  writerOwnershipCheck?: CompactContinuationWriterOwnershipCheck;
  testHooks?: CompactContinuationTestHooks;
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
  reclaimedStaleWriterRow: boolean;
  replayedTerminalAttempt: boolean;
  pendingBoundary: BoundaryRow | null;
};

function callerError(code: ErrorResult["code"], reason: string): { ok: false; error: ErrorResult } {
  return { ok: false, error: { errorClass: "caller_error", code, reason } };
}

function attemptConflict(attemptId: string, ownerAttemptId: string, reason: string): { ok: false; error: ErrorResult } {
  return callerError(
    "compact_continuation_attempt_conflict",
    `${reason} (caller attemptId=${attemptId}, owner attemptId=${ownerAttemptId})`,
  );
}

function readCanonicalThreadId(db: { prepare: (sql: string) => { get: () => unknown } }): string {
  const row = db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").get() as
    | { thread_id: string }
    | undefined;
  if (row === undefined || typeof row.thread_id !== "string" || row.thread_id.length === 0) {
    throw new Error("thread_metadata.thread_id is missing; cannot key host writer ownership");
  }
  return row.thread_id;
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
    projectedPressureTokens: null,
    renderedSavingsTokens: 0,
    renderedSavingsSource: "lhc_rendered_history_estimate",
    renderedSavingsDomain: "source_labelled_estimate",
    safeRunwayThresholdTokens: null,
    safeRunwayThresholdSource: null,
    projectedPressureSafe: null,
    protectedEscalationApplied: false,
    visibilityBoundaryBefore: null,
    visibilityBoundaryAfter: null,
    compactPointAtInstall: null,
    maximalPruneInsufficient: false,
    hostValidationStatus: "not_required",
  };
}

function applyMaterialHooks(
  base: CompactMaterialFacts,
  hooks: CompactContinuationTestHooks | undefined,
): CompactMaterialFacts {
  if (hooks === undefined) return base;
  return {
    ...base,
    derivationsMissingOrFailed: hooks.forceDerivationsMissingOrFailed ?? base.derivationsMissingOrFailed,
    compactStructurallyValid: hooks.forceCompactStructurallyValid ?? base.compactStructurallyValid,
    installSucceeds: hooks.forceInstallSucceeds ?? base.installSucceeds,
    usefulReduction: hooks.forceUsefulReduction ?? base.usefulReduction,
    canProduceValidProviderRequest: hooks.forceCanProduceValidProviderRequest ?? base.canProduceValidProviderRequest,
  };
}

function compactPathInvariants(
  facts: CompactContinuationHostFacts,
  singleOpenTurn: boolean,
  reclaimedStaleWriterRow: boolean,
): CompactContinuationInput["invariants"] {
  if (reclaimedStaleWriterRow) {
    return {
      captureComplete: facts.captureComplete,
      providerIdentityValid: facts.providerIdentityValid,
      singleOpenTurn,
      writerClaim: facts.writerClaim,
      writerOwnershipAuthority: "no_live_owner",
    };
  }
  return {
    captureComplete: facts.captureComplete,
    providerIdentityValid: facts.providerIdentityValid,
    singleOpenTurn,
    writerClaim: "lhc",
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
    reclaimedStaleWriterRow?: boolean;
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
    reclaimedStaleWriterRow: extras.reclaimedStaleWriterRow ?? false,
    replayedTerminalAttempt: extras.replayedTerminalAttempt,
    pendingBoundary: extras.pendingBoundary,
  };
}

function projectedPressureOf(
  facts: CompactContinuationHostFacts,
  currentServedTokens: number,
  candidateTokens: number,
): {
  projected: number | null;
  savings: number;
  safe: boolean | null;
  threshold: number | null;
  thresholdSource: string | null;
} {
  const savings = Math.max(0, currentServedTokens - candidateTokens);
  const threshold = facts.policy.safeRunwayThresholdTokens ?? null;
  const thresholdSource = facts.policy.safeRunwayThresholdSource ?? null;
  if (!facts.providerUsage.available) {
    return { projected: null, savings, safe: null, threshold, thresholdSource };
  }
  const projected = Math.max(0, facts.providerUsage.total + facts.postMeasurementEstimate.tokens - savings);
  const safe = threshold === null ? null : projected < threshold;
  return { projected, savings, safe, threshold, thresholdSource };
}

function materialFromCandidate(
  facts: CompactContinuationHostFacts,
  candidate: {
    material: {
      derivationsMissingOrFailed: boolean;
      lowerTargetMet: boolean;
      compactStructurallyValid: boolean;
      usefulReduction: boolean;
      canProduceValidProviderRequest: boolean;
    };
    candidateTokens: number;
    currentServedTokens: number;
  },
  over: Partial<CompactMaterialFacts> = {},
): CompactMaterialFacts {
  const proj = projectedPressureOf(facts, candidate.currentServedTokens, candidate.candidateTokens);
  return {
    ...emptyMaterial(),
    derivationsMissingOrFailed: candidate.material.derivationsMissingOrFailed,
    lowerTargetMet: candidate.material.lowerTargetMet,
    compactStructurallyValid: candidate.material.compactStructurallyValid,
    usefulReduction: candidate.material.usefulReduction,
    canProduceValidProviderRequest: candidate.material.canProduceValidProviderRequest,
    installSucceeds: false,
    projectedPressureTokens: proj.projected,
    renderedSavingsTokens: proj.savings,
    renderedSavingsSource: "lhc_rendered_history_estimate",
    renderedSavingsDomain: "source_labelled_estimate",
    safeRunwayThresholdTokens: proj.threshold,
    safeRunwayThresholdSource: proj.thresholdSource,
    projectedPressureSafe: proj.safe,
    ...over,
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

function turnEndIdempotencyKey(attemptId: string): string {
  return `lhc.compact_continuation.force_turn_end:${attemptId}`;
}

function turnEndEvent(facts: CompactContinuationHostFacts, attemptId: string): MessageEventInput {
  return {
    eventKind: "turn_end",
    idempotencyKey: turnEndIdempotencyKey(attemptId),
    actor: facts.actor,
    harness: facts.harness,
    payload: {
      outcome: "completed",
      outcomeReason: CONTEXT_COMPACT_CONTINUE_REASON,
    },
  };
}

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
    boundaryDiscard?: { continuationTurnId: string };
    forcedBoundaryThisAttempt: boolean;
    continuationTurnId: string | null;
    compactReceipt: CompactReceipt | null;
    reclaimedStaleWriterRow?: boolean;
  },
  clock: () => Date,
  hooks?: CompactContinuationTestHooks,
): Promise<OpResult<CompactContinuationRunResult>> {
  try {
    if (hooks?.failFinalizeWrite === true || hooks?.failReceiptWrite === true) {
      return storageFailure("compact-continuation finalize write failed (test injection)");
    }

    let terminal = opts.terminal;
    if (terminal && !opts.releaseWriter) {
      const held = await createDbReadTransaction(ref, (tx) => readWriterClaim(tx.db));
      if (!held.ok) return held;
      if (held.value.claim === "lhc" && held.value.attemptId === facts.attemptId) {
        terminal = false;
      }
    }

    let decisionForPersist = decision;
    if (opts.releaseWriter) {
      if (decision.receipt.residual.writerReleased !== true) {
        decisionForPersist = {
          ...decision,
          receipt: {
            ...decision.receipt,
            residual: { ...decision.receipt.residual, writerReleased: true },
          },
        };
      }
    } else {
      const held = await createDbReadTransaction(ref, (tx) => readWriterClaim(tx.db));
      if (!held.ok) return held;
      if (held.value.claim === "lhc" && held.value.attemptId === facts.attemptId) {
        if (decision.receipt.residual.writerReleased !== false) {
          decisionForPersist = {
            ...decision,
            receipt: {
              ...decision.receipt,
              residual: { ...decision.receipt.residual, writerReleased: false },
            },
          };
        }
      }
    }

    const write = await createDbWriteTransaction(
      ref,
      (tx) => {
        const recordedAt = clock().toISOString();
        const status = persistReceipt(tx.db, facts.attemptId, recordedAt, decisionForPersist, terminal);
        if (status === "already_terminal") {
          return { kind: "already_terminal" as const };
        }
        appendStageLog(tx.db, facts.attemptId, "receipt_recorded", recordedAt, {
          terminal,
          outcome: decisionForPersist.receipt.outcome,
          writerReleased: decisionForPersist.receipt.residual.writerReleased,
          releaseWriter: opts.releaseWriter,
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
        if (opts.boundaryDiscard !== undefined) {
          deleteBoundary(tx.db, opts.boundaryDiscard.continuationTurnId, facts.attemptId);
          appendStageLog(tx.db, facts.attemptId, "boundary_discarded", recordedAt, {
            continuationTurnId: opts.boundaryDiscard.continuationTurnId,
            reason: "compact_retry_budget_exhausted",
          });
        }
        if (hooks?.failFinalizeAfterReceipt === true) {
          throw new Error("compact-continuation finalize after receipt failed (test injection)");
        }
        if (opts.releaseWriter) {
          if (hooks?.failFinalizeAtRelease === true) {
            throw new Error("compact-continuation finalize at release failed (test injection)");
          }
          const released = releaseLhcWriter(tx.db, facts.attemptId);
          if (!released) {
            throw new Error(`failed to release writer for attempt ${facts.attemptId}`);
          }
          appendStageLog(tx.db, facts.attemptId, "writer_released", recordedAt);
          if (hooks?.failFinalizeAfterReleaseBeforeCommit === true) {
            throw new Error("compact-continuation finalize after release before commit failed (test injection)");
          }
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
      value: toRunResult(decisionForPersist, {
        forcedBoundaryThisAttempt: opts.forcedBoundaryThisAttempt,
        continuationTurnId: opts.continuationTurnId,
        compactReceipt: opts.compactReceipt,
        replayedTerminalAttempt: write.value.kind === "already_terminal",
        pendingBoundary: pending.value,
        reclaimedStaleWriterRow: opts.reclaimedStaleWriterRow ?? false,
      }),
    };
  } catch (cause) {
    return storageFailure(`compact-continuation finalize failed: ${detail(cause)}`);
  }
}

async function releaseOwnWriterIfHeld(ref: ThreadRef, attemptId: string, clock: () => Date): Promise<OpResult<true>> {
  const rel = await createDbWriteTransaction(
    ref,
    (tx) => {
      const claim = readWriterClaim(tx.db);
      if (claim.claim === "lhc" && claim.attemptId === attemptId) {
        const released = releaseLhcWriter(tx.db, attemptId);
        if (!released) {
          throw new Error(`failed to release writer for attempt ${attemptId}`);
        }
        appendStageLog(tx.db, attemptId, "writer_released", clock().toISOString());
      }
      return true as const;
    },
    clock,
  );
  if (!rel.ok) return rel;
  return { ok: true, value: true };
}

export async function runCompactContinuation(
  ref: ThreadRef,
  facts: CompactContinuationHostFacts,
  clock: () => Date = () => new Date(),
  opts: { writerOwnershipCheck?: CompactContinuationWriterOwnershipCheck } = {},
): Promise<OpResult<CompactContinuationRunResult>> {
  return runCompactContinuationInner(ref, facts, clock, undefined, opts.writerOwnershipCheck);
}

export async function runCompactContinuationForTests(
  ref: ThreadRef,
  facts: CompactContinuationHostFacts,
  clock: () => Date = () => new Date(),
  hooks?: CompactContinuationTestHooks,
  writerOwnershipCheck?: CompactContinuationWriterOwnershipCheck,
): Promise<OpResult<CompactContinuationRunResult>> {
  return runCompactContinuationInner(ref, facts, clock, hooks, writerOwnershipCheck);
}

async function runCompactContinuationInner(
  ref: ThreadRef,
  facts: CompactContinuationHostFacts,
  clock: () => Date,
  hooks: CompactContinuationTestHooks | undefined,
  writerOwnershipCheck?: CompactContinuationWriterOwnershipCheck,
): Promise<OpResult<CompactContinuationRunResult>> {
  const inputIssue = validateHostFacts(facts);
  if (inputIssue !== undefined) return { ok: false, error: inputIssue };

  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;

  const activated = await createDbReadTransaction(ref, (tx) => readPartsActivation(tx.db));
  if (!activated.ok) return activated;
  if (activated.value !== null) {
    return callerError(
      "compact_continuation_parts_thread",
      `compact-continuation refused: this thread has served turn parts since ${activated.value}; mid-turn relief on it is threadView.midTurnCompact`,
    );
  }

  const identity = computeOperationIdentity(facts);
  const { intentHash, intentJson } = hashAttemptIntent(identity);

  const existing = await createDbReadTransaction(ref, (tx) => readReceiptByAttemptId(tx.db, facts.attemptId));
  if (!existing.ok) return existing;
  if (existing.value?.terminal) {
    const intentRow = await createDbReadTransaction(ref, (tx) => {
      const row = tx.db
        .prepare(`SELECT intent_hash FROM compact_continuation_attempt WHERE attempt_id = ?`)
        .get(facts.attemptId) as { intent_hash: string } | undefined;
      return row?.intent_hash ?? null;
    });
    if (!intentRow.ok) return intentRow;
    if (intentRow.value === null || intentRow.value !== intentHash) {
      return attemptConflict(
        facts.attemptId,
        facts.attemptId,
        `attemptId ${facts.attemptId} already completed with a different operation identity`,
      );
    }
    const writerRepair = await createDbWriteTransaction(
      ref,
      (tx) => {
        const claim = readWriterClaim(tx.db);
        if (claim.claim === "lhc" && claim.attemptId === facts.attemptId) {
          const released = releaseLhcWriter(tx.db, facts.attemptId);
          if (!released) {
            throw new Error(`failed to release stale writer for completed attempt ${facts.attemptId}`);
          }
          const recordedAt = clock().toISOString();
          appendStageLog(tx.db, facts.attemptId, "writer_claim_repaired", recordedAt, {
            reason: "terminal_replay_stale_same_owner_claim",
          });
          appendStageLog(tx.db, facts.attemptId, "recovery_maintenance", recordedAt, {
            action: "release_stale_writer_on_terminal_replay",
            receiptIntact: true,
          });
          appendStageLog(tx.db, facts.attemptId, "writer_released", recordedAt, {
            onTerminalReplay: true,
          });
          return { repaired: true as const };
        }
        return { repaired: false as const };
      },
      clock,
    );
    if (!writerRepair.ok) return writerRepair;

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

  const preSkip = facts.seam.insideTransportRetry || !isAtSeam(facts.seam);

  const openRead = await createDbReadTransaction(ref, (tx) => {
    const ids = readOpenTurnIds(tx.db);
    return { singleOpenTurn: ids.length === 1, openIds: ids };
  });
  if (!openRead.ok) return openRead;
  const singleOpenTurn = openRead.value.singleOpenTurn;

  const stateRead = await createDbReadTransaction(ref, (tx) => {
    const pendingBoundary = readPendingBoundary(tx.db);
    const forceIntent = readForceIntent(tx.db, facts.attemptId);
    const writer = readWriterClaim(tx.db);
    return { pendingBoundary, forceIntent, writer };
  });
  if (!stateRead.ok) return stateRead;
  let pendingBoundary = stateRead.value.pendingBoundary;
  const forceIntent = stateRead.value.forceIntent;
  const durableWriter = stateRead.value.writer;

  if (pendingBoundary !== null && pendingBoundary.attemptId !== facts.attemptId) {
    return attemptConflict(
      facts.attemptId,
      pendingBoundary.attemptId,
      `pending boundary ${pendingBoundary.continuationTurnId} is owned by another attempt`,
    );
  }

  const intentWrite = await createDbWriteTransaction(
    ref,
    (tx) => insertAttemptIntent(tx.db, facts.attemptId, intentHash, intentJson, clock().toISOString()),
    clock,
  );
  if (!intentWrite.ok) return intentWrite;
  if (intentWrite.value === "exists_different") {
    return attemptConflict(
      facts.attemptId,
      facts.attemptId,
      `attemptId ${facts.attemptId} already registered with a different operation identity`,
    );
  }

  const posture = computeRetryPosture(facts, durableWriter);
  const { hash: postureHash, json: postureJson } = hashRecord(posture);
  const postureWrite = await createDbWriteTransaction(
    ref,
    (tx) => {
      appendStageLog(tx.db, facts.attemptId, "retry_posture", clock().toISOString(), {
        postureHash,
        posture: JSON.parse(postureJson) as Record<string, unknown>,
      });
      return true as const;
    },
    clock,
  );
  if (!postureWrite.ok) return postureWrite;

  if (
    forceIntent !== null &&
    (forceIntent.status === "intent" || forceIntent.status === "applied") &&
    pendingBoundary === null
  ) {
    const reconcile = await createDbWriteTransaction(
      ref,
      (tx) => {
        const turnId =
          findContinuationTurnFromForceKey(tx.db, forceIntent.turnEndIdempotencyKey) ?? forceIntent.continuationTurnId;
        if (turnId === null) {
          return { kind: "no_turn" as const };
        }
        const now = clock().toISOString();
        upsertBoundary(tx.db, {
          continuationTurnId: turnId,
          attemptId: facts.attemptId,
          status: "pending",
          markerPersisted: markerExistsByIdempotencyKey(tx.db, compactContinuationMarkerIdempotencyKey(turnId)),
          lastStage: "force_turn_end",
          forcedAt: forceIntent.recordedAt || now,
        });
        markForceIntentApplied(tx.db, facts.attemptId, turnId);
        appendStageLog(tx.db, facts.attemptId, "force_turn_end", now, {
          continuationTurnId: turnId,
          reconciled: true,
        });
        return { kind: "reconciled" as const, turnId };
      },
      clock,
    );
    if (!reconcile.ok) return reconcile;
    if (reconcile.value.kind === "reconciled") {
      const pending = await createDbReadTransaction(ref, (tx) => readPendingBoundary(tx.db));
      if (!pending.ok) return pending;
      pendingBoundary = pending.value;
    }
  }

  const forcedFromPending = pendingBoundaryAsForced(pendingBoundary);
  const ownsPending = pendingBoundary !== null && pendingBoundary.attemptId === facts.attemptId;

  if (preSkip) {
    const ownsWriter = durableWriter.claim === "lhc" && durableWriter.attemptId === facts.attemptId;
    const oracleWriter: WriterClaim = ownsWriter ? "lhc" : "none";
    const decision = decideCompactContinuation(
      buildOracleInput(
        facts,
        {
          captureComplete: facts.captureComplete,
          providerIdentityValid: facts.providerIdentityValid,
          singleOpenTurn,
          writerClaim: oracleWriter,
        },
        forcedFromPending,
        emptyMaterial(),
      ),
    );
    return await finalizeAttempt(
      ref,
      facts,
      decision,
      {
        releaseWriter: ownsWriter,
        terminal: !ownsPending,
        forcedBoundaryThisAttempt: false,
        continuationTurnId: decision.receipt.residual.continuationTurnId,
        compactReceipt: null,
      },
      clock,
      hooks,
    );
  }

  let reclaimedStaleWriterRow = false;
  if (facts.writerClaim === "native" || facts.writerClaim === "conflict") {
    let liveOwner = true;
    let authoritySupplied = false;
    if (writerOwnershipCheck !== undefined) {
      authoritySupplied = true;
      const threadIdRead = await createDbReadTransaction(ref, (tx) => readCanonicalThreadId(tx.db));
      if (!threadIdRead.ok) return threadIdRead;
      try {
        liveOwner = (await writerOwnershipCheck({ threadId: threadIdRead.value, attemptId: facts.attemptId })) === true;
      } catch (cause) {
        liveOwner = true;
        const authLog = await stageLog(ref, facts.attemptId, "recovery_maintenance", clock, {
          action: "writer_ownership_check_failed",
          detail: detail(cause),
          treatedAs: "live_owner",
        });
        if (!authLog.ok) return authLog;
      }
    }
    if (liveOwner) {
      const ownsWriter = durableWriter.claim === "lhc" && durableWriter.attemptId === facts.attemptId;
      const decision = decideCompactContinuation(
        buildOracleInput(
          facts,
          {
            captureComplete: facts.captureComplete,
            providerIdentityValid: facts.providerIdentityValid,
            singleOpenTurn,
            writerClaim: facts.writerClaim,
            writerOwnershipAuthority: authoritySupplied ? "live_owner" : null,
          },
          forcedFromPending,
          emptyMaterial(),
        ),
      );
      return await finalizeAttempt(
        ref,
        facts,
        decision,
        {
          releaseWriter: ownsWriter,
          terminal: !ownsPending,
          forcedBoundaryThisAttempt: false,
          continuationTurnId: decision.receipt.residual.continuationTurnId,
          compactReceipt: null,
        },
        clock,
        hooks,
      );
    }
    reclaimedStaleWriterRow = true;
    const reclaimLog = await stageLog(ref, facts.attemptId, "recovery_maintenance", clock, {
      action: "reclaim_stale_writer_row",
      priorClaim: facts.writerClaim,
      hostAuthority: "no_live_owner",
    });
    if (!reclaimLog.ok) return reclaimLog;
  }

  let toolPairOk = true;
  if (facts.continuation.kind === "pending_correlated_tool_result") {
    if (facts.continuation.correlationValid) {
      const proof = await createDbReadTransaction(ref, (tx) =>
        proveProtectedToolPairSet(
          tx.db,
          facts.continuation.kind === "pending_correlated_tool_result" ? facts.continuation.protectedToolCallIds : [],
        ),
      );
      if (!proof.ok) return proof;
      if (!proof.value.ok) {
        toolPairOk = false;
      }
    } else {
      toolPairOk = false;
    }
  }

  if (
    forcedFromPending.applied &&
    facts.continuation.kind !== "active_non_tool" &&
    facts.continuation.kind !== "pending_correlated_tool_result"
  ) {
    const ownsWriter = durableWriter.claim === "lhc" && durableWriter.attemptId === facts.attemptId;
    const decision = decideCompactContinuation(
      buildOracleInput(
        facts,
        {
          captureComplete: facts.captureComplete,
          providerIdentityValid: facts.providerIdentityValid,
          singleOpenTurn,
          writerClaim: ownsWriter ? "lhc" : "none",
        },
        forcedFromPending,
        emptyMaterial(),
      ),
    );
    return await finalizeAttempt(
      ref,
      facts,
      decision,
      {
        releaseWriter: ownsWriter,
        terminal: !ownsPending,
        forcedBoundaryThisAttempt: false,
        continuationTurnId: decision.receipt.residual.continuationTurnId,
        compactReceipt: null,
      },
      clock,
      hooks,
    );
  }

  if (!toolPairOk) {
    const cont =
      facts.continuation.kind === "pending_correlated_tool_result"
        ? { ...facts.continuation, correlationValid: false }
        : facts.continuation;
    const ownsWriter = durableWriter.claim === "lhc" && durableWriter.attemptId === facts.attemptId;
    const releaseWriter = ownsWriter && !ownsPending;
    const oracleWriter: WriterClaim = ownsWriter ? "lhc" : "none";
    const decision = decideCompactContinuation(
      buildOracleInput(
        { ...facts, continuation: cont },
        {
          captureComplete: facts.captureComplete,
          providerIdentityValid: facts.providerIdentityValid,
          singleOpenTurn,
          writerClaim: oracleWriter,
        },
        forcedFromPending,
        emptyMaterial(),
      ),
    );
    return await finalizeAttempt(
      ref,
      facts,
      decision,
      {
        releaseWriter,
        terminal: !ownsPending,
        forcedBoundaryThisAttempt: false,
        continuationTurnId: decision.receipt.residual.continuationTurnId,
        compactReceipt: null,
      },
      clock,
      hooks,
    );
  }

  const pressure = pressureAtOrAbove(facts);
  let needsContinueTurn =
    forcedFromPending.applied || (pressure === true && facts.continuation.kind === "active_non_tool");
  if (forcedFromPending.applied && facts.continuation.kind === "pending_correlated_tool_result" && toolPairOk) {
    needsContinueTurn = true;
  }
  let needsPreserveTool =
    !forcedFromPending.applied &&
    pressure === true &&
    facts.continuation.kind === "pending_correlated_tool_result" &&
    toolPairOk;

  if (!needsContinueTurn && !needsPreserveTool) {
    const ownsWriter = durableWriter.claim === "lhc" && durableWriter.attemptId === facts.attemptId;
    const releaseWriter = ownsWriter && !ownsPending;
    const oracleWriter: WriterClaim = ownsWriter ? "lhc" : "none";
    const decision = decideCompactContinuation(
      buildOracleInput(
        facts,
        {
          captureComplete: facts.captureComplete,
          providerIdentityValid: facts.providerIdentityValid,
          singleOpenTurn,
          writerClaim: oracleWriter,
        },
        { applied: false },
        emptyMaterial(),
      ),
    );
    return await finalizeAttempt(
      ref,
      facts,
      decision,
      {
        releaseWriter,
        terminal: !ownsPending,
        forcedBoundaryThisAttempt: false,
        continuationTurnId: null,
        compactReceipt: null,
      },
      clock,
      hooks,
    );
  }

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

  const priorStages = await createDbReadTransaction(ref, (tx) => listStageLog(tx.db, facts.attemptId));
  if (!priorStages.ok) return priorStages;
  const priorAttemptFailures = priorStages.value.filter(
    (row) => row.stage === "compact_failed" || row.stage === "install_failed",
  ).length;
  const compactAttemptIndex = priorAttemptFailures + 1;

  let forcedBoundaryThisAttempt = false;
  let continuationTurnId: string | null = pendingBoundary?.continuationTurnId ?? null;
  let forcedContinuationBoundary: ForcedContinuationBoundary = forcedFromPending;
  let compactReceipt: CompactReceipt | null = null;
  let material = emptyMaterial();
  let boundaryForcedAt = pendingBoundary?.forcedAt ?? clock().toISOString();
  let markerPersistedDurable = pendingBoundary?.markerPersisted ?? false;

  try {
    let pendingEscalated = false;
    let proposedVisibilityBoundary: number | null = null;
    let visibilityBoundaryBefore: number | null = null;
    const protectedIds: string[] =
      facts.continuation.kind === "pending_correlated_tool_result"
        ? [...facts.continuation.protectedToolCallIds].sort()
        : [];

    if (needsPreserveTool && !needsContinueTurn && hooks?.skipRealCompact !== true) {
      const prepOpts: { profile?: string; params?: ViewCompactParams } = {};
      if (facts.compact?.profile !== undefined) prepOpts.profile = facts.compact.profile;
      if (facts.compact?.params !== undefined) prepOpts.params = facts.compact.params;
      const prep0 = await threadView.prepareCompact(ref, prepOpts);
      if (prep0.ok) {
        const cand0 = await createDbReadTransaction(ref, (tx) =>
          assembleCandidateFromPrepared(tx.db, prep0.value, facts.policy.lowerTargetTokens),
        );
        if (!cand0.ok) {
          const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
          if (!rel.ok) return rel;
          return cand0;
        }
        const proj0 = projectedPressureOf(facts, cand0.value.currentServedTokens, cand0.value.candidateTokens);
        const preserveUseful = cand0.value.material.usefulReduction;
        const preserveSafe = proj0.safe === true;
        if (preserveUseful && preserveSafe && cand0.value.material.compactStructurallyValid) {
        } else {
          pendingEscalated = true;
          needsContinueTurn = true;
          needsPreserveTool = false;
        }
      }
    }

    if (needsContinueTurn && !forcedFromPending.applied) {
      const openCheck = await createDbReadTransaction(ref, (tx) => {
        const ids = readOpenTurnIds(tx.db);
        if (ids.length !== 1) return { ok: false as const, count: 0 };
        return { ok: true as const, count: readOpenTurnMemberCount(tx.db, ids[0]!) };
      });
      if (!openCheck.ok) {
        const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
        if (!rel.ok) return rel;
        return openCheck;
      }
      if (!openCheck.value.ok || openCheck.value.count === 0) {
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
        return await finalizeAttempt(
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
          hooks,
        );
      }

      const turnEndKey = turnEndIdempotencyKey(facts.attemptId);

      const existingTurn = await createDbReadTransaction(ref, (tx) =>
        findContinuationTurnFromForceKey(tx.db, turnEndKey),
      );
      if (!existingTurn.ok) {
        const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
        if (!rel.ok) return rel;
        return existingTurn;
      }

      if (existingTurn.value !== null) {
        continuationTurnId = existingTurn.value;
        forcedBoundaryThisAttempt = false;
        boundaryForcedAt = forceIntent?.recordedAt ?? clock().toISOString();
        forcedContinuationBoundary = {
          applied: true,
          continuationTurnId,
          forcedThisSeam: false,
          markerAlreadyPersisted: false,
        };
        const boundWrite = await createDbWriteTransaction(
          ref,
          (tx) => {
            const markerAlready = markerExistsByIdempotencyKey(
              tx.db,
              compactContinuationMarkerIdempotencyKey(continuationTurnId!),
            );
            upsertBoundary(tx.db, {
              continuationTurnId: continuationTurnId!,
              attemptId: facts.attemptId,
              status: "pending",
              markerPersisted: markerAlready,
              lastStage: "force_turn_end",
              forcedAt: boundaryForcedAt,
            });
            markForceIntentApplied(tx.db, facts.attemptId, continuationTurnId!);
            appendStageLog(tx.db, facts.attemptId, "force_turn_end", clock().toISOString(), {
              continuationTurnId,
              reconciled: true,
            });
            forcedContinuationBoundary = {
              applied: true,
              continuationTurnId: continuationTurnId!,
              forcedThisSeam: false,
              markerAlreadyPersisted: markerAlready,
            };
            markerPersistedDurable = markerAlready;
          },
          clock,
        );
        if (!boundWrite.ok) {
          const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
          if (!rel.ok) return rel;
          return boundWrite;
        }
      } else {
        const intentRec = await createDbWriteTransaction(
          ref,
          (tx) => {
            recordForceIntent(tx.db, facts.attemptId, turnEndKey, clock().toISOString());
            appendStageLog(tx.db, facts.attemptId, "force_intent", clock().toISOString(), {
              turnEndIdempotencyKey: turnEndKey,
            });
          },
          clock,
        );
        if (!intentRec.ok) {
          const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
          if (!rel.ok) return rel;
          return intentRec;
        }

        const forceBatch = await intakeStream.messageEvents(ref, [turnEndEvent(facts, facts.attemptId)]);
        if (!forceBatch.ok) {
          const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
          if (!rel.ok) return rel;
          if (forceBatch.error.code === "storage_failure" || forceBatch.error.code === "invalid_event") {
            return forceBatch;
          }
          return attemptConflict(
            facts.attemptId,
            facts.attemptId,
            `attemptId ${facts.attemptId} cannot force a new boundary (turn_end already recorded)`,
          );
        }

        if (hooks?.interruptAfterTurnEndCommit === true) {
          const gapLog = await stageLog(ref, facts.attemptId, "interrupted", clock, {
            after: "turn_end_commit",
            forceIntent: true,
          });
          if (!gapLog.ok) {
            const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
            if (!rel.ok) return rel;
            return gapLog;
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
              { applied: false },
              {
                ...emptyMaterial(),
                compactStructurallyValid: false,
                canProduceValidProviderRequest: false,
              },
            ),
          );
          const pending = await createDbReadTransaction(ref, (tx) => readPendingBoundary(tx.db));
          if (!pending.ok) return pending;
          return {
            ok: true,
            value: toRunResult(decision, {
              forcedBoundaryThisAttempt: false,
              continuationTurnId: null,
              compactReceipt: null,
              replayedTerminalAttempt: false,
              pendingBoundary: pending.value,
            }),
          };
        }

        const opened = forceBatch.value.turnTransitions.find((t) => t.action === "opened");
        const openedFromKey = await createDbReadTransaction(ref, (tx) =>
          findContinuationTurnFromForceKey(tx.db, turnEndKey),
        );
        if (!openedFromKey.ok) {
          const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
          if (!rel.ok) return rel;
          return openedFromKey;
        }
        const openedTurnId = opened?.turnId ?? openedFromKey.value;
        if (openedTurnId === null || openedTurnId === undefined) {
          const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
          if (!rel.ok) return rel;
          return attemptConflict(
            facts.attemptId,
            facts.attemptId,
            `attemptId ${facts.attemptId} force_turn_end did not open a continuation turn (likely reused attemptId)`,
          );
        }
        continuationTurnId = openedTurnId;
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
            markForceIntentApplied(tx.db, facts.attemptId, continuationTurnId!);
            appendStageLog(tx.db, facts.attemptId, "force_turn_end", boundaryForcedAt, {
              continuationTurnId,
            });
          },
          clock,
        );
        if (!boundWrite.ok) {
          const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
          if (!rel.ok) return rel;
          return boundWrite;
        }

        if (hooks?.interruptAfterBoundary === true) {
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
          const gapLog = await stageLog(ref, facts.attemptId, "interrupted", clock, {
            after: "force_turn_end",
            continuationTurnId,
          });
          if (!gapLog.ok) {
            const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
            if (!rel.ok) return rel;
            return gapLog;
          }
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
      }
    } else if (forcedFromPending.applied) {
      continuationTurnId = forcedFromPending.continuationTurnId;
      forcedContinuationBoundary = forcedFromPending;
      markerPersistedDurable = forcedFromPending.markerAlreadyPersisted;
    }

    let maximalPruneInsufficient = false;
    let boundaryWalkTargetLimited = false;
    if (
      (pendingEscalated || (needsContinueTurn && facts.continuation.kind === "pending_correlated_tool_result")) &&
      protectedIds.length > 0 &&
      hooks?.skipRealCompact !== true
    ) {
      const threshold = facts.policy.safeRunwayThresholdTokens;
      const preview = await threadView.previewProtectedBoundary(ref, {
        protectedToolCallIds: protectedIds,
        ...(threshold !== undefined ? { targetZoneTokens: threshold } : {}),
      });
      if (!preview.ok) {
        const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
        if (!rel.ok) return rel;
        return preview;
      }
      visibilityBoundaryBefore = preview.value.previousBoundary;
      proposedVisibilityBoundary = preview.value.proposedBoundary;
      maximalPruneInsufficient = preview.value.maximalPruneInsufficient;
      boundaryWalkTargetLimited = threshold !== undefined;
    }

    let prepared: threadView.PreparedCompact | null = null;

    if (hooks?.skipRealCompact === true) {
      material = applyMaterialHooks(
        {
          ...emptyMaterial(),
          lowerTargetMet: true,
          compactStructurallyValid: true,
          installSucceeds: true,
          usefulReduction: true,
          canProduceValidProviderRequest: true,
          projectedPressureSafe: true,
          projectedPressureTokens: 0,
        },
        hooks,
      );
    } else {
      const prepOpts: threadView.PrepareCompactOptions = {};
      if (facts.compact?.profile !== undefined) prepOpts.profile = facts.compact.profile;
      if (facts.compact?.params !== undefined) prepOpts.params = facts.compact.params;
      if (proposedVisibilityBoundary !== null) {
        prepOpts.visibilityBoundaryOverride = proposedVisibilityBoundary;
        prepOpts.compactPointUpperBound = proposedVisibilityBoundary;
      }
      const prep = await threadView.prepareCompact(ref, prepOpts);
      if (!prep.ok) {
        material = applyMaterialHooks(emptyMaterial(), hooks);
      } else {
        prepared = prep.value;
        const candidate = await createDbReadTransaction(ref, (tx) =>
          assembleCandidateFromPrepared(tx.db, prepared!, facts.policy.lowerTargetTokens, {
            ...(proposedVisibilityBoundary !== null ? { boundaryPositionOverride: proposedVisibilityBoundary } : {}),
          }),
        );
        if (!candidate.ok) {
          const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
          if (!rel.ok) return rel;
          return candidate;
        }
        const escalated =
          pendingEscalated || (needsContinueTurn && facts.continuation.kind === "pending_correlated_tool_result");
        material = applyMaterialHooks(
          materialFromCandidate(facts, candidate.value, {
            protectedEscalationApplied: escalated,
            visibilityBoundaryBefore,
            visibilityBoundaryAfter: proposedVisibilityBoundary,
            compactPointAtInstall: prepared.selection.compactPoint,
            maximalPruneInsufficient,
            hostValidationStatus: escalated ? "awaiting" : "not_required",
          }),
          hooks,
        );
        if (
          escalated &&
          material.projectedPressureSafe === false &&
          boundaryWalkTargetLimited &&
          material.compactStructurallyValid
        ) {
          const maximalPreview = await threadView.previewProtectedBoundary(ref, {
            protectedToolCallIds: protectedIds,
            compactPointOverride: prepared.selection.compactPoint,
          });
          if (!maximalPreview.ok) {
            const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
            if (!rel.ok) return rel;
            return maximalPreview;
          }
          if (
            proposedVisibilityBoundary !== null &&
            maximalPreview.value.proposedBoundary > proposedVisibilityBoundary
          ) {
            proposedVisibilityBoundary = maximalPreview.value.proposedBoundary;
            const maxPrep = await threadView.prepareCompact(ref, {
              ...prepOpts,
              visibilityBoundaryOverride: proposedVisibilityBoundary,
              compactPointUpperBound: proposedVisibilityBoundary,
            });
            if (maxPrep.ok) {
              prepared = maxPrep.value;
              const maxCandidate = await createDbReadTransaction(ref, (tx) =>
                assembleCandidateFromPrepared(tx.db, prepared!, facts.policy.lowerTargetTokens, {
                  boundaryPositionOverride: proposedVisibilityBoundary!,
                }),
              );
              if (!maxCandidate.ok) {
                const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
                if (!rel.ok) return rel;
                return maxCandidate;
              }
              material = applyMaterialHooks(
                materialFromCandidate(facts, maxCandidate.value, {
                  protectedEscalationApplied: true,
                  visibilityBoundaryBefore,
                  visibilityBoundaryAfter: proposedVisibilityBoundary,
                  compactPointAtInstall: prepared.selection.compactPoint,
                  maximalPruneInsufficient: maximalPreview.value.maximalPruneInsufficient,
                  hostValidationStatus: "awaiting",
                }),
                hooks,
              );
            }
          }
        }
        if (escalated && material.projectedPressureSafe === true && material.maximalPruneInsufficient) {
          material = { ...material, maximalPruneInsufficient: false };
        }
        if (
          escalated &&
          (material.projectedPressureSafe === false ||
            (material.projectedPressureSafe === null && material.maximalPruneInsufficient))
        ) {
          material = { ...material, maximalPruneInsufficient: true };
        }
        const prepLog = await stageLog(ref, facts.attemptId, "compact_prepared", clock, {
          candidateTokens: candidate.value.candidateTokens,
          currentServedTokens: candidate.value.currentServedTokens,
          structuralIssues: candidate.value.structuralIssues,
          projectedPressureTokens: material.projectedPressureTokens,
          protectedEscalationApplied: material.protectedEscalationApplied,
          proposedVisibilityBoundary,
        });
        if (!prepLog.ok) {
          const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
          if (!rel.ok) return rel;
          return prepLog;
        }
      }
    }

    if (
      needsContinueTurn &&
      forcedContinuationBoundary.applied === true &&
      material.compactStructurallyValid &&
      (prepared !== null || hooks?.skipRealCompact === true)
    ) {
      const cTurnId = forcedContinuationBoundary.continuationTurnId;
      const already = await createDbReadTransaction(ref, (tx) =>
        markerExistsByIdempotencyKey(tx.db, compactContinuationMarkerIdempotencyKey(cTurnId)),
      );
      if (!already.ok) {
        const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
        if (!rel.ok) return rel;
        return already;
      }
      if (!already.value) {
        const markerBatch = await intakeStream.messageEvents(ref, [markerEvent(facts, cTurnId)]);
        if (!markerBatch.ok) {
          const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
          if (!rel.ok) return rel;
          return markerBatch;
        }
      }

      if (hooks?.interruptAfterMarkerEvent === true) {
        const gapLog = await stageLog(ref, facts.attemptId, "interrupted", clock, {
          after: "marker_event_commit",
          before: "boundary_marker_status",
          continuationTurnId: cTurnId,
          markerExists: true,
          boundaryMarkerPersisted: false,
        });
        if (!gapLog.ok) {
          const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
          if (!rel.ok) return rel;
          return gapLog;
        }
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
              markerAlreadyPersisted: already.value,
            },
            material,
          ),
        );
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
        const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
        if (!rel.ok) return rel;
        return markWrite;
      }

      if (prepared !== null && hooks?.skipRealCompact !== true) {
        const candidate2 = await createDbReadTransaction(ref, (tx) =>
          assembleCandidateFromPrepared(tx.db, prepared!, facts.policy.lowerTargetTokens, {
            ...(proposedVisibilityBoundary !== null ? { boundaryPositionOverride: proposedVisibilityBoundary } : {}),
          }),
        );
        if (!candidate2.ok) {
          const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
          if (!rel.ok) return rel;
          return candidate2;
        }
        material = applyMaterialHooks(
          materialFromCandidate(facts, candidate2.value, {
            protectedEscalationApplied: material.protectedEscalationApplied,
            visibilityBoundaryBefore: material.visibilityBoundaryBefore,
            visibilityBoundaryAfter: material.visibilityBoundaryAfter,
            compactPointAtInstall: material.compactPointAtInstall,
            maximalPruneInsufficient: material.maximalPruneInsufficient,
            hostValidationStatus: material.hostValidationStatus,
          }),
          hooks,
        );
      }

      if (hooks?.interruptAfterMarker === true) {
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
        const intLog = await stageLog(ref, facts.attemptId, "interrupted", clock, {
          after: "marker_persisted",
          continuationTurnId: cTurnId,
        });
        if (!intLog.ok) {
          const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
          if (!rel.ok) return rel;
          return intLog;
        }
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

    const canAttemptInstall =
      material.compactStructurallyValid && (prepared !== null || hooks?.skipRealCompact === true);

    if (canAttemptInstall) {
      if (hooks?.failInstallBeforeWrite === true || hooks?.forceInstallSucceeds === false) {
        material = { ...material, installSucceeds: false };
      } else if (prepared !== null) {
        const installOpts: threadView.InstallPreparedOptions = {};
        if (proposedVisibilityBoundary !== null) {
          installOpts.visibilityBoundary = proposedVisibilityBoundary;
          if (visibilityBoundaryBefore !== null) {
            installOpts.expectedPreviousBoundary = visibilityBoundaryBefore;
          }
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
          material = {
            ...material,
            installSucceeds: true,
            compactPointAtInstall: installed.value.compactPoint,
            visibilityBoundaryAfter: proposedVisibilityBoundary ?? material.visibilityBoundaryAfter,
          };
          if (material.protectedEscalationApplied && material.hostValidationStatus === "awaiting") {
            const hv = await createDbWriteTransaction(
              ref,
              (tx) => {
                recordHostValidationAwaiting(tx.db, facts.attemptId, clock().toISOString());
                appendStageLog(tx.db, facts.attemptId, "install_succeeded", clock().toISOString(), {
                  viewId: installed.value.viewId,
                  hostValidation: "awaiting",
                });
                return true as const;
              },
              clock,
            );
            if (!hv.ok) {
              const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
              if (!rel.ok) return rel;
              return hv;
            }
          } else {
            const instLog = await stageLog(ref, facts.attemptId, "install_succeeded", clock, {
              viewId: installed.value.viewId,
            });
            if (!instLog.ok) {
              const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
              if (!rel.ok) return rel;
              return instLog;
            }
          }
        }
      } else if (hooks?.skipRealCompact === true) {
        material = {
          ...material,
          installSucceeds: hooks.forceInstallSucceeds ?? true,
        };
        if (needsContinueTurn && forcedContinuationBoundary.applied && material.compactStructurallyValid) {
          const cTurnId = forcedContinuationBoundary.continuationTurnId;
          const already = await createDbReadTransaction(ref, (tx) =>
            markerExistsByIdempotencyKey(tx.db, compactContinuationMarkerIdempotencyKey(cTurnId)),
          );
          if (!already.ok) {
            const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
            if (!rel.ok) return rel;
            return already;
          }
          if (!already.value) {
            const markerBatch = await intakeStream.messageEvents(ref, [markerEvent(facts, cTurnId)]);
            if (!markerBatch.ok) {
              const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
              if (!rel.ok) return rel;
              return markerBatch;
            }
            markerPersistedDurable = true;
          }
        }
      }
    }

    let finalBoundary: ForcedContinuationBoundary = { applied: false };
    if (needsContinueTurn && forcedContinuationBoundary.applied) {
      const cTurnId = forcedContinuationBoundary.continuationTurnId;
      const markerRead = await createDbReadTransaction(ref, (tx) =>
        markerExistsByIdempotencyKey(tx.db, compactContinuationMarkerIdempotencyKey(cTurnId)),
      );
      if (!markerRead.ok) {
        const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
        if (!rel.ok) return rel;
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
      buildOracleInput(facts, compactPathInvariants(facts, singleOpenTurn, reclaimedStaleWriterRow), finalBoundary, {
        ...material,
        compactAttemptIndex,
      }),
    );

    const successOutcomes = new Set([
      "compact_continue_turn",
      "degraded_compact",
      "no_reduction",
      "compact_preserve_tool_escalated",
    ]);
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
      boundaryDiscard?: { continuationTurnId: string };
      forcedBoundaryThisAttempt: boolean;
      continuationTurnId: string | null;
      compactReceipt: CompactReceipt | null;
      reclaimedStaleWriterRow?: boolean;
    } = {
      releaseWriter: true,
      terminal: true,
      forcedBoundaryThisAttempt,
      continuationTurnId: finalBoundary.applied ? finalBoundary.continuationTurnId : continuationTurnId,
      compactReceipt,
      reclaimedStaleWriterRow,
    };

    if (finalBoundary.applied) {
      if (successOutcomes.has(decision.outcome) && material.installSucceeds) {
        finalizeOpts.terminal = true;
        finalizeOpts.boundaryUpdate = {
          continuationTurnId: finalBoundary.continuationTurnId,
          status: "complete",
          markerPersisted: true,
          lastStage: "install_succeeded",
          forcedAt: boundaryForcedAt,
          completedAt: clock().toISOString(),
        };
      } else {
        const failStage: StageName =
          material.compactStructurallyValid && material.installSucceeds === false ? "install_failed" : "compact_failed";
        if (decision.receipt.retry.retryAuthorized) {
          finalizeOpts.terminal = false;
          finalizeOpts.boundaryUpdate = {
            continuationTurnId: finalBoundary.continuationTurnId,
            status: "failed_repairable",
            markerPersisted: markerPersistedDurable,
            lastStage: failStage,
            forcedAt: boundaryForcedAt,
          };
        } else {
          finalizeOpts.terminal = true;
          finalizeOpts.boundaryDiscard = { continuationTurnId: finalBoundary.continuationTurnId };
        }
        const failLog = await stageLog(ref, facts.attemptId, failStage, clock, {
          continuationTurnId: finalBoundary.continuationTurnId,
          outcome: decision.outcome,
          compactStructurallyValid: material.compactStructurallyValid,
          canProduceValidProviderRequest: material.canProduceValidProviderRequest,
          installSucceeds: material.installSucceeds,
        });
        if (!failLog.ok) {
          const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
          if (!rel.ok) return rel;
          return failLog;
        }
      }
    }

    return await finalizeAttempt(ref, facts, decision, finalizeOpts, clock, hooks);
  } catch (cause) {
    try {
      const rel = await releaseOwnWriterIfHeld(ref, facts.attemptId, clock);
      if (!rel.ok) {
        return storageFailure(
          `compact-continuation failed: ${detail(cause)}; also release failed: ${rel.error.reason}`,
        );
      }
    } catch (releaseCause) {
      return storageFailure(
        `compact-continuation failed: ${detail(cause)}; also release threw: ${detail(releaseCause)}`,
      );
    }
    return storageFailure(`compact-continuation failed: ${detail(cause)}`);
  }
}
