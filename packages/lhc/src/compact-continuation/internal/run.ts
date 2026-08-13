/**
 * Staged compact-continuation runtime (LIM-61).
 *
 * Executes COMPACT_CONTINUATION_TRANSITION_ORDER against live thread state,
 * gathers attempt results, then classifies via the pure whole-seam oracle.
 * Host supplies seam/usage/policy/continuation/identity/writer posture —
 * the SDK does not invent host thresholds.
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
import {
  claimLhcWriter,
  listReceipts,
  markerExistsByIdempotencyKey,
  readOpenTurnIds,
  readOpenTurnMemberCount,
  readReceiptByAttemptId,
  readWriterClaim,
  releaseLhcWriter,
  type StoredCompactContinuationReceipt,
  upsertReceipt,
} from "./store.js";

// ── Host input (pre-decision facts the runtime must not invent) ─────────────

export type CompactContinuationHostFacts = {
  /**
   * Stable idempotency key for this attempt (writer claim + receipt).
   * Repair after interruption reuses the same key.
   */
  attemptId: string;
  seam: CompactContinuationSeam;
  providerUsage: ProviderUsageAuthority;
  postMeasurementEstimate: PostMeasurementEstimate;
  policy: CompactContinuationPolicy;
  continuation: WorkContinuation;
  /**
   * Host-observed writer posture at seam entry, excluding the claim this
   * operation itself holds. Supply `none` for a free seam; `lhc` only when
   * this same attempt already holds the claim (repair). `native`/`conflict`
   * refuse without claiming.
   */
  writerClaim: WriterClaim;
  /** Capture / identity proofs. */
  captureComplete: boolean;
  providerIdentityValid: boolean;
  /**
   * Optional override for single-open-turn; when omitted the runtime reads
   * durable turn state.
   */
  singleOpenTurn?: boolean;
  /** Actor/harness stamps for any events this operation records. */
  actor: string;
  harness: string;
  /** Compact profile / params (host policy). Default: continuation profile. */
  compact?: { profile?: string; params?: ViewCompactParams };
  /**
   * Failure-injection / dependency seams for deterministic tests.
   * Production hosts omit this.
   */
  testHooks?: CompactContinuationTestHooks;
};

export type CompactContinuationTestHooks = {
  /** Force compact assembly structural validity classification. */
  forceCompactStructurallyValid?: boolean;
  /** Force install success/failure after a real or skipped write. */
  forceInstallSucceeds?: boolean;
  /** Force usefulReduction classification. */
  forceUsefulReduction?: boolean;
  /** Force canProduceValidProviderRequest. */
  forceCanProduceValidProviderRequest?: boolean;
  /** Force derivationsMissingOrFailed. */
  forceDerivationsMissingOrFailed?: boolean;
  /** Skip real compact write; treat as structurally valid for material facts. */
  skipRealCompact?: boolean;
  /** Fail install without writing (prior view intact). */
  failInstallBeforeWrite?: boolean;
  /** Interrupt after force_turn_end (before compact). */
  interruptAfterBoundary?: boolean;
  /** Interrupt after marker persist (before install). */
  interruptAfterMarker?: boolean;
};

export type CompactContinuationRunResult = {
  decision: CompactContinuationDecision;
  receipt: CompactContinuationReceipt;
  /** True when this call applied force_turn_end on the thread. */
  forcedBoundaryThisAttempt: boolean;
  /** Continuation turn id when a boundary is applied (this or prior). */
  continuationTurnId: string | null;
  /** Marker was present after this attempt (residual). */
  markerPersisted: boolean;
  /** Compact view receipt when install succeeded. */
  compactReceipt: CompactReceipt | null;
  /**
   * Whether the host may proceed with a next provider request under this
   * machine's authorization. Mirrors residual.nextProviderRequestAllowed.
   */
  nextProviderRequestAllowed: boolean;
  /**
   * Refuse-receipt fidelity note (Fable LIM-60 ride-along): refuse receipts
   * from the oracle report fidelity "full" with empty degradationReasons even
   * when effects include degrade_fidelity. That describes the *installed*
   * view (none on refuse) rather than attempted material. Hosts that need
   * attempt-scoped fidelity should read effects for degrade_fidelity causes.
   */
  refuseReceiptFidelityDescribes: "installed_view_only";
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

/**
 * Detect an already-applied forced continuation boundary by durable state:
 * prior closed turn has outcomeReason `context_compact_continue` and the open
 * turn is empty or already holds the boundary-keyed marker.
 */
function detectAppliedBoundary(db: Parameters<typeof readOpenTurnIds>[0]): ForcedContinuationBoundary {
  const openIds = readOpenTurnIds(db);
  if (openIds.length !== 1) return { applied: false };
  const openTurnId = openIds[0]!;
  const members = readOpenTurnMemberCount(db, openTurnId);
  const markerKey = compactContinuationMarkerIdempotencyKey(openTurnId);
  const markerPresent = markerExistsByIdempotencyKey(db, markerKey);

  const prior = db
    .prepare(
      `SELECT turn_id, outcome_reason FROM turns
       WHERE status = 'closed' AND turn_order = (
         SELECT turn_order - 1 FROM turns WHERE turn_id = ?
       )`,
    )
    .get(openTurnId) as { turn_id: string; outcome_reason: string | null } | undefined;

  const forcedByReason = prior?.outcome_reason === CONTEXT_COMPACT_CONTINUE_REASON;
  if (!forcedByReason && !markerPresent) {
    return { applied: false };
  }
  if (members === 0 || markerPresent) {
    return {
      applied: true,
      continuationTurnId: openTurnId,
      forcedThisSeam: false,
      markerAlreadyPersisted: markerPresent,
    };
  }
  return { applied: false };
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

function classifyFromPrepared(
  prepared: threadView.PreparedCompact,
  policy: CompactContinuationPolicy,
): CompactMaterialFacts {
  const degraded = prepared.degraded.length > 0 || prepared.gaps.length > 0 || prepared.warnings.length > 0;
  const totalBandTokens = prepared.bands.reduce((sum, band) => sum + band.tokenCount, 0);
  const usefulReduction = prepared.selection.compactPoint > 0 || prepared.bands.length > 0;
  return {
    derivationsMissingOrFailed: degraded,
    lowerTargetMet: totalBandTokens <= policy.lowerTargetTokens || prepared.selection.compactPoint > 0,
    compactStructurallyValid: true,
    installSucceeds: false,
    usefulReduction,
    canProduceValidProviderRequest: true,
  };
}

function toRunResult(
  decision: CompactContinuationDecision,
  extras: {
    forcedBoundaryThisAttempt: boolean;
    continuationTurnId: string | null;
    compactReceipt: CompactReceipt | null;
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
  };
}

async function persistReceipt(
  ref: ThreadRef,
  attemptId: string,
  decision: CompactContinuationDecision,
  clock: () => Date,
): Promise<void> {
  await createDbWriteTransaction(
    ref,
    (tx) => {
      upsertReceipt(tx.db, attemptId, clock().toISOString(), decision);
    },
    clock,
  );
}

async function releaseWriterTx(ref: ThreadRef, attemptId: string, clock: () => Date): Promise<void> {
  await createDbWriteTransaction(
    ref,
    (tx) => {
      releaseLhcWriter(tx.db, attemptId);
    },
    clock,
  );
}

async function claimWriterTx(ref: ThreadRef, attemptId: string, clock: () => Date): Promise<OpResult<true>> {
  const result = await createDbWriteTransaction(
    ref,
    (tx): { claimed: boolean } => {
      return { claimed: claimLhcWriter(tx.db, attemptId, clock().toISOString()) };
    },
    clock,
  );
  if (!result.ok) return result;
  if (!result.value.claimed) {
    return callerError(
      "compact_continuation_writer_conflict",
      `cannot claim LHC compact-continuation writer for attempt ${attemptId}; another claim is held`,
    );
  }
  return { ok: true, value: true };
}

async function readSingleOpenTurn(ref: ThreadRef): Promise<OpResult<boolean>> {
  return createDbReadTransaction(ref, (tx) => readOpenTurnIds(tx.db).length === 1);
}

async function readDurableBoundary(ref: ThreadRef): Promise<OpResult<ForcedContinuationBoundary>> {
  return createDbReadTransaction(ref, (tx) => detectAppliedBoundary(tx.db));
}

async function markerPresent(ref: ThreadRef, continuationTurnId: string): Promise<OpResult<boolean>> {
  return createDbReadTransaction(ref, (tx) =>
    markerExistsByIdempotencyKey(tx.db, compactContinuationMarkerIdempotencyKey(continuationTurnId)),
  );
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

async function finish(
  ref: ThreadRef,
  facts: CompactContinuationHostFacts,
  decision: CompactContinuationDecision,
  extras: {
    forcedBoundaryThisAttempt: boolean;
    continuationTurnId: string | null;
    compactReceipt: CompactReceipt | null;
    releaseWriter: boolean;
  },
  clock: () => Date,
): Promise<OpResult<CompactContinuationRunResult>> {
  await persistReceipt(ref, facts.attemptId, decision, clock);
  if (extras.releaseWriter) {
    await releaseWriterTx(ref, facts.attemptId, clock);
  }
  return {
    ok: true,
    value: toRunResult(decision, {
      forcedBoundaryThisAttempt: extras.forcedBoundaryThisAttempt,
      continuationTurnId: extras.continuationTurnId,
      compactReceipt: extras.compactReceipt,
    }),
  };
}

/**
 * Run one compact-continuation attempt against thread state.
 *
 * Recoverable at every durable stage: force_turn_end, marker insert, compact
 * install, and receipt are separate durable steps. Repair re-enters with the
 * same attemptId and detects boundary/marker from durable state.
 */
export async function runCompactContinuation(
  ref: ThreadRef,
  facts: CompactContinuationHostFacts,
  clock: () => Date = () => new Date(),
): Promise<OpResult<CompactContinuationRunResult>> {
  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;

  const hooks = facts.testHooks;

  // ── Pre-seam skips: no writer claim. If host already held LHC for this
  // attempt, release out-of-band so residual writerReleased stays truthful
  // (Fable LIM-60: skip-with-held-claim has no release effect in the oracle).
  const preSkip =
    facts.seam.insideTransportRetry ||
    !isAtSeam(facts.seam) ||
    facts.seam.inputEpochAtDecision !== facts.seam.inputEpochAtApply;

  if (preSkip) {
    if (facts.writerClaim === "lhc") {
      await releaseWriterTx(ref, facts.attemptId, clock);
    }
    let singleOpenTurn = facts.singleOpenTurn;
    if (singleOpenTurn === undefined) {
      const open = await readSingleOpenTurn(ref);
      if (!open.ok) return open;
      singleOpenTurn = open.value;
    }
    const boundary = await readDurableBoundary(ref);
    if (!boundary.ok) return boundary;

    const decision = decideCompactContinuation(
      buildOracleInput(
        facts,
        {
          captureComplete: facts.captureComplete,
          providerIdentityValid: facts.providerIdentityValid,
          singleOpenTurn,
          // After out-of-band release, residual claim is none for skip path.
          writerClaim: "none",
        },
        boundary.value,
        emptyMaterial(),
      ),
    );
    return finish(
      ref,
      facts,
      decision,
      {
        forcedBoundaryThisAttempt: false,
        continuationTurnId: decision.receipt.residual.continuationTurnId,
        compactReceipt: null,
        releaseWriter: false,
      },
      clock,
    );
  }

  // ── Settled seam ────────────────────────────────────────────────────────
  let singleOpenTurn = facts.singleOpenTurn;
  if (singleOpenTurn === undefined) {
    const open = await readSingleOpenTurn(ref);
    if (!open.ok) return open;
    singleOpenTurn = open.value;
  }

  const durableBoundary = await readDurableBoundary(ref);
  if (!durableBoundary.ok) return durableBoundary;

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
        durableBoundary.value,
        emptyMaterial(),
      ),
    );
    return finish(
      ref,
      facts,
      decision,
      {
        forcedBoundaryThisAttempt: false,
        continuationTurnId: decision.receipt.residual.continuationTurnId,
        compactReceipt: null,
        releaseWriter: false,
      },
      clock,
    );
  }

  // Claim LHC writer (idempotent for same attemptId).
  const claimed = await claimWriterTx(ref, facts.attemptId, clock);
  if (!claimed.ok) return claimed;

  let forcedBoundaryThisAttempt = false;
  let continuationTurnId: string | null = null;
  let forcedContinuationBoundary: ForcedContinuationBoundary = durableBoundary.value;
  let compactReceipt: CompactReceipt | null = null;
  let material = emptyMaterial();

  try {
    const pressure = pressureAtOrAbove(facts);
    const needsContinueTurn =
      durableBoundary.value.applied === true || (pressure === true && facts.continuation.kind === "active_non_tool");
    const needsPreserveTool = pressure === true && facts.continuation.kind === "pending_correlated_tool_result";

    // No compact branch (below trigger / no usage / normal complete / health refuse).
    if (!needsContinueTurn && !needsPreserveTool) {
      const decision = decideCompactContinuation(
        buildOracleInput(
          facts,
          {
            captureComplete: facts.captureComplete,
            providerIdentityValid: facts.providerIdentityValid,
            singleOpenTurn,
            writerClaim: "lhc",
          },
          { applied: false },
          emptyMaterial(),
        ),
      );
      return finish(
        ref,
        facts,
        decision,
        {
          forcedBoundaryThisAttempt: false,
          continuationTurnId: null,
          compactReceipt: null,
          releaseWriter: true,
        },
        clock,
      );
    }

    // ── Force boundary if fresh continue-turn ─────────────────────────────
    if (needsContinueTurn && durableBoundary.value.applied === false) {
      const openCheck = await createDbReadTransaction(ref, (tx) => {
        const ids = readOpenTurnIds(tx.db);
        if (ids.length !== 1) return { ok: false as const, count: 0 };
        return { ok: true as const, count: readOpenTurnMemberCount(tx.db, ids[0]!) };
      });
      if (!openCheck.ok) return openCheck;

      if (!openCheck.value.ok || openCheck.value.count === 0) {
        const decision = decideCompactContinuation(
          buildOracleInput(
            facts,
            {
              captureComplete: facts.captureComplete,
              providerIdentityValid: facts.providerIdentityValid,
              singleOpenTurn,
              writerClaim: "lhc",
            },
            { applied: false },
            emptyMaterial(),
          ),
        );
        return finish(
          ref,
          facts,
          decision,
          {
            forcedBoundaryThisAttempt: false,
            continuationTurnId: null,
            compactReceipt: null,
            releaseWriter: true,
          },
          clock,
        );
      }

      const forceBatch = await intakeStream.messageEvents(ref, [turnEndEvent(facts, facts.attemptId)]);
      if (!forceBatch.ok) {
        await releaseWriterTx(ref, facts.attemptId, clock);
        return forceBatch;
      }
      const opened = forceBatch.value.turnTransitions.find((t) => t.action === "opened");
      if (opened === undefined) {
        await releaseWriterTx(ref, facts.attemptId, clock);
        return storageFailure("force_turn_end did not open a continuation turn");
      }
      continuationTurnId = opened.turnId;
      forcedBoundaryThisAttempt = true;
      forcedContinuationBoundary = {
        applied: true,
        continuationTurnId,
        forcedThisSeam: true,
        markerAlreadyPersisted: false,
      };

      if (hooks?.interruptAfterBoundary === true) {
        const decision = decideCompactContinuation(
          buildOracleInput(
            facts,
            {
              captureComplete: facts.captureComplete,
              providerIdentityValid: facts.providerIdentityValid,
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
        return finish(
          ref,
          facts,
          decision,
          {
            forcedBoundaryThisAttempt: true,
            continuationTurnId,
            compactReceipt: null,
            releaseWriter: true,
          },
          clock,
        );
      }
    } else if (durableBoundary.value.applied === true) {
      continuationTurnId = durableBoundary.value.continuationTurnId;
      forcedContinuationBoundary = durableBoundary.value;
    }

    // ── Compact assembly + optional marker + install ──────────────────────
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
        material = applyMaterialHooks(classifyFromPrepared(prepared, facts.policy), hooks);
      }
    }

    const canInstall =
      material.compactStructurallyValid && material.canProduceValidProviderRequest && prepared !== null;

    // Marker before install (continue-turn only).
    if (needsContinueTurn && forcedContinuationBoundary.applied === true) {
      const cTurnId = forcedContinuationBoundary.continuationTurnId;
      if (material.compactStructurallyValid && material.canProduceValidProviderRequest) {
        const already = await markerPresent(ref, cTurnId);
        if (!already.ok) {
          await releaseWriterTx(ref, facts.attemptId, clock);
          return already;
        }
        if (!already.value) {
          const markerBatch = await intakeStream.messageEvents(ref, [markerEvent(facts, cTurnId)]);
          if (!markerBatch.ok) {
            await releaseWriterTx(ref, facts.attemptId, clock);
            return markerBatch;
          }
        }

        if (hooks?.interruptAfterMarker === true) {
          material = { ...material, installSucceeds: false };
          const decision = decideCompactContinuation(
            buildOracleInput(
              facts,
              {
                captureComplete: facts.captureComplete,
                providerIdentityValid: facts.providerIdentityValid,
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
          return finish(
            ref,
            facts,
            decision,
            {
              forcedBoundaryThisAttempt,
              continuationTurnId: cTurnId,
              compactReceipt: null,
              releaseWriter: true,
            },
            clock,
          );
        }
      }
    }

    // Install (when structurally valid and we have a prepared snapshot).
    if (canInstall && material.compactStructurallyValid && material.canProduceValidProviderRequest) {
      if (hooks?.failInstallBeforeWrite === true || hooks?.forceInstallSucceeds === false) {
        material = { ...material, installSucceeds: false };
      } else if (prepared !== null) {
        const installed = await threadView.installPreparedCompact(ref, prepared);
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
        }
      }
    } else if (hooks?.skipRealCompact === true) {
      // Synthetic install classification for test doubles without a view write.
      if (hooks.failInstallBeforeWrite === true || hooks.forceInstallSucceeds === false) {
        material = { ...material, installSucceeds: false };
      } else {
        material = {
          ...material,
          installSucceeds: hooks.forceInstallSucceeds ?? true,
        };
      }
      // Still insert marker for continue-turn under skipRealCompact.
      if (
        needsContinueTurn &&
        forcedContinuationBoundary.applied === true &&
        material.compactStructurallyValid &&
        material.canProduceValidProviderRequest
      ) {
        const cTurnId = forcedContinuationBoundary.continuationTurnId;
        const already = await markerPresent(ref, cTurnId);
        if (!already.ok) {
          await releaseWriterTx(ref, facts.attemptId, clock);
          return already;
        }
        if (!already.value) {
          const markerBatch = await intakeStream.messageEvents(ref, [markerEvent(facts, cTurnId)]);
          if (!markerBatch.ok) {
            await releaseWriterTx(ref, facts.attemptId, clock);
            return markerBatch;
          }
        }
      }
    }

    // Final boundary for oracle: forcedThisSeam + markerAlreadyPersisted legality.
    let finalBoundary: ForcedContinuationBoundary = { applied: false };
    if (needsContinueTurn && forcedContinuationBoundary.applied === true) {
      const cTurnId = forcedContinuationBoundary.continuationTurnId;
      const markerRead = await markerPresent(ref, cTurnId);
      if (!markerRead.ok) {
        await releaseWriterTx(ref, facts.attemptId, clock);
        return markerRead;
      }
      finalBoundary = {
        applied: true,
        continuationTurnId: cTurnId,
        forcedThisSeam: forcedBoundaryThisAttempt,
        // Fresh force: always false at oracle entry (marker this attempt is
        // attempt-scoped via install/marker effects). Repair: actual residual.
        markerAlreadyPersisted: forcedBoundaryThisAttempt ? false : markerRead.value,
      };
    }

    const decision = decideCompactContinuation(
      buildOracleInput(
        facts,
        {
          captureComplete: facts.captureComplete,
          providerIdentityValid: facts.providerIdentityValid,
          singleOpenTurn: true,
          writerClaim: "lhc",
        },
        finalBoundary,
        material,
      ),
    );
    return finish(
      ref,
      facts,
      decision,
      {
        forcedBoundaryThisAttempt,
        continuationTurnId: finalBoundary.applied ? finalBoundary.continuationTurnId : continuationTurnId,
        compactReceipt,
        releaseWriter: true,
      },
      clock,
    );
  } catch (cause) {
    try {
      await releaseWriterTx(ref, facts.attemptId, clock);
    } catch {
      // best-effort release
    }
    return storageFailure(`compact-continuation failed: ${detail(cause)}`);
  }
}

/** Read durable receipt by attempt id. */
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

/** List recent durable compact-continuation receipts (newest first). */
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

/** Inspect writer claim residual. */
export async function getCompactContinuationWriterClaim(
  ref: ThreadRef,
): Promise<OpResult<{ claim: "none" | "lhc"; attemptId: string | null; claimedAt: string | null }>> {
  try {
    return await createDbReadTransaction(ref, (tx) => readWriterClaim(tx.db));
  } catch (cause) {
    return storageFailure(`compact-continuation writer read failed: ${detail(cause)}`);
  }
}

/** Whether the boundary-keyed marker is present in the canonical record. */
export async function hasCompactContinuationMarker(
  ref: ThreadRef,
  continuationTurnId: string,
): Promise<OpResult<boolean>> {
  try {
    return await markerPresent(ref, continuationTurnId);
  } catch (cause) {
    return storageFailure(`compact-continuation marker probe failed: ${detail(cause)}`);
  }
}
