/**
 * Staged compact-continuation runtime (LIM-61 P1 lifecycle).
 *
 * Normative order at a settled seam:
 * 1. Validate host facts (closed).
 * 2. Attempt-intent fingerprint (before mutation); terminal replay requires match.
 * 3. Seam eligibility (skip — no claim; nonterminal if pending owned).
 * 4. Pending-boundary ownership + force-intent reconcile (no silent steal).
 * 5. Writer posture: a native/conflict row is resolved by host ownership
 *    authority — reclaim the stale row when no live owner holds this LHC thread,
 *    otherwise continue this attempt's current request.
 * 6. Health facts (capture/identity/open-turn) are carried into the receipt as
 *    warnings; an unprovable protected pair set declines into the ordinary
 *    settled-seam compact. Neither stops the seam.
 * 7. Provider usage / pressure / continuation branch.
 * 8. Claim writer only when a compact path will mutate.
 * 9. Force intent → turn_end → boundary materialize → compact → marker → install.
 * 10. Atomic receipt + boundary status + writer release (terminal only when complete).
 *
 * ## CX-S5: no stop in the compact path
 *
 * Input-epoch drift is diagnostic only. Incomplete capture, unproven provider
 * identity, an unverified open-turn invariant, an unsafe projected runway and an
 * unprovable provider request all warn and proceed. A failed compact or install
 * is bounded retry (`compactAttemptIndex` counts prior failures for this attempt
 * against `policy.compactRetryBudget`) and then continues on the current body.
 *
 * Crash recovery: re-enter with the same attemptId; resume from durable
 * boundary/force-intent/stage state. Completed attemptId replays stored terminal
 * receipt only when intent matches.
 */

import { createHash } from "node:crypto";
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
  type AttemptRow,
  appendStageLog,
  type BoundaryRow,
  claimLhcWriter,
  findContinuationTurnFromForceKey,
  insertAttemptIntent,
  listBoundaries,
  listReceipts,
  listStageLog,
  markerExistsByIdempotencyKey,
  markForceIntentApplied,
  persistReceipt,
  readAttemptIntent,
  readForceIntent,
  readHostValidation,
  readOpenTurnIds,
  readOpenTurnMemberCount,
  readPendingBoundary,
  readReceiptByAttemptId,
  readWriterClaim,
  recordForceIntent,
  recordHostValidationAwaiting,
  recordHostValidationResult,
  releaseLhcWriter,
  type StageName,
  type StoredCompactContinuationReceipt,
  deleteBoundary,
  upsertBoundary,
  type WriterClaimRow,
} from "./store.js";
import { proveProtectedToolPairSet } from "./tool-pair.js";
import { validateHostFacts } from "./validate-host.js";

// ── Host input ──────────────────────────────────────────────────────────────

/**
 * Public host facts for compact-continuation. Closed validation rejects
 * unknown fields including `testHooks` — fault injection is internal-only
 * via `runCompactContinuationForTests`.
 */
export type CompactContinuationHostFacts = {
  /**
   * Stable attempt key. Repair reuses the same id. A completed attemptId
   * replays the stored terminal receipt without re-mutation when identity matches.
   */
  attemptId: string;
  seam: CompactContinuationSeam;
  providerUsage: ProviderUsageAuthority;
  postMeasurementEstimate: PostMeasurementEstimate;
  policy: CompactContinuationPolicy;
  continuation: WorkContinuation;
  /**
   * Host writer posture at seam entry. Informational for the oracle; durable
   * claim ownership is always re-read from storage and never released based on
   * host `writerClaim` alone. A `native`/`conflict` row is resolved by
   * `CompactContinuationRunOptions.writerOwnershipCheck`, never by refusing.
   */
  writerClaim: WriterClaim;
  captureComplete: boolean;
  providerIdentityValid: boolean;
  /** Optional; ignored when it contradicts durable single-open-turn state. */
  singleOpenTurn?: boolean;
  actor: string;
  harness: string;
  compact?: { profile?: string; params?: ViewCompactParams };
};

/** Test-only fault injection. Not part of the public host-facts surface. */
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
  /**
   * After marker event commits and boundary marker_persisted is written.
   * Models crash after durable marker status update, before install.
   */
  interruptAfterMarker?: boolean;
  /**
   * After canonical marker event commits, **before** boundary
   * marker_persisted/last_stage update. Models the marker→status crash gap.
   */
  interruptAfterMarkerEvent?: boolean;
  /**
   * After messageEvents(turn_end) returns, before boundary materialization.
   * Leaves force_intent durable and writer held for resume reconcile.
   */
  interruptAfterTurnEndCommit?: boolean;
  /** Fail the atomic receipt+release transaction (pre-txn). */
  failFinalizeWrite?: boolean;
  /** Fail only the receipt write (finalize aborts pre-txn). */
  failReceiptWrite?: boolean;
  /** Throw inside finalize txn after persistReceipt, before release. */
  failFinalizeAfterReceipt?: boolean;
  /** Throw at release inside finalize txn. */
  failFinalizeAtRelease?: boolean;
  /**
   * After releaseLhcWriter succeeds and stage log is written, before COMMIT.
   * Proves rollback restores prior writer claim after a successful release update.
   */
  failFinalizeAfterReleaseBeforeCommit?: boolean;
};

/**
 * Host ownership authority for a `native`/`conflict` writer row (R23-S8).
 *
 * The registry lives **host-side** — a process-global map keyed by LHC
 * `thread_id`, because two sessions or aliases can map to the same thread and
 * would otherwise hold two independent per-session flags. The SDK never owns
 * that registry; it only asks whether a live owner still holds the thread.
 *
 * Return `true` when a live owner holds it (this attempt is the loser and
 * continues its current request), `false` when the row is stale from a dead
 * owner (reclaim proceeds). When no check is supplied the SDK assumes a live
 * owner and never reclaims.
 */
export type CompactContinuationWriterOwnershipCheck = (args: {
  /** Canonical LHC thread id the writer row belongs to. */
  threadId: string;
  /** Attempt asking for the row. */
  attemptId: string;
}) => boolean | Promise<boolean>;

/** Internal run options. Production callers use runCompactContinuation. */
export type CompactContinuationRunOptions = {
  /** Host ownership authority for stale-writer-row reclaim. */
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
  /**
   * True when this attempt reclaimed a stale `native`/`conflict` writer row
   * after host ownership authority confirmed no live owner held the thread.
   */
  reclaimedStaleWriterRow: boolean;
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

function attemptConflict(attemptId: string, ownerAttemptId: string, reason: string): { ok: false; error: ErrorResult } {
  return callerError(
    "compact_continuation_attempt_conflict",
    `${reason} (caller attemptId=${attemptId}, owner attemptId=${ownerAttemptId})`,
  );
}

/** Canonical LHC thread id for host-side writer-ownership lookups. */
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

/**
 * Oracle invariants for a mutating compact path. Health facts are carried
 * through as-is so incomplete capture / unproven identity / an unverified
 * open-turn invariant land on the receipt as warnings instead of vanishing.
 *
 * A reclaimed stale writer row is reported as its original `native`/`conflict`
 * posture plus the `no_live_owner` authority, so the receipt records the
 * reclaim + warning ahead of this attempt's own `claim_writer`.
 */
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

/** Stable JSON with sorted object keys (arrays keep order). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Immutable operation identity — must match on every replay/resume.
 * Drift returns compact_continuation_attempt_conflict before mutation.
 *
 * Includes: contract version, attempt id, actor/harness, continuation kind +
 * toolCallId (correlationValid is posture), policy, compact profile/params.
 * Excludes seam flags/epochs, usage, estimate, capture/identity, writer posture.
 */
export function computeOperationIdentity(facts: CompactContinuationHostFacts): Record<string, unknown> {
  const continuationIdentity: Record<string, unknown> =
    facts.continuation.kind === "pending_correlated_tool_result"
      ? {
          kind: facts.continuation.kind,
          protectedToolCallIds: [...facts.continuation.protectedToolCallIds].sort(),
        }
      : { kind: facts.continuation.kind };
  return {
    contractVersion: COMPACT_CONTINUATION_CONTRACT_VERSION,
    attemptId: facts.attemptId,
    actor: facts.actor,
    harness: facts.harness,
    continuation: continuationIdentity,
    policy: facts.policy,
    ...(facts.compact !== undefined ? { compact: facts.compact } : {}),
  };
}

/**
 * Mutable retry posture — may change across same-attempt repair entries.
 * Appended to the stage log per invocation; never silently retained as identity.
 */
export function computeRetryPosture(
  facts: CompactContinuationHostFacts,
  durableWriter: WriterClaimRow,
): Record<string, unknown> {
  return {
    seam: facts.seam,
    providerUsage: facts.providerUsage,
    postMeasurementEstimate: facts.postMeasurementEstimate,
    captureComplete: facts.captureComplete,
    providerIdentityValid: facts.providerIdentityValid,
    hostWriterClaim: facts.writerClaim,
    durableWriter: {
      claim: durableWriter.claim,
      attemptId: durableWriter.attemptId,
    },
    ...(facts.continuation.kind === "pending_correlated_tool_result"
      ? { correlationValid: facts.continuation.correlationValid }
      : {}),
  };
}

/** @deprecated Use computeOperationIdentity. Kept as alias for call sites/tests. */
export function computeAttemptIntent(facts: CompactContinuationHostFacts): Record<string, unknown> {
  return computeOperationIdentity(facts);
}

export function hashAttemptIntent(intent: Record<string, unknown>): { intentHash: string; intentJson: string } {
  const intentJson = stableStringify(intent);
  const intentHash = createHash("sha256").update(intentJson).digest("hex");
  return { intentHash, intentJson };
}

export function hashRecord(value: Record<string, unknown>): { hash: string; json: string } {
  const json = stableStringify(value);
  const hash = createHash("sha256").update(json).digest("hex");
  return { hash, json };
}

/**
 * Parsed immutable operation identity from a durable attempt-intent row.
 *
 * Read-only recovery surface: hosts re-enter claim-only / same-attempt repair
 * with these fields so the intent hash matches. Mutable posture (seam, usage,
 * estimate, capture, writer claim host assertion, correlationValid) is not
 * stored here and must be rebuilt fresh.
 */
export type StoredOperationIdentity = {
  contractVersion: string;
  attemptId: string;
  actor: string;
  harness: string;
  continuation:
    | { kind: "none" }
    | { kind: "active_non_tool" }
    | { kind: "pending_correlated_tool_result"; protectedToolCallIds: string[] };
  policy: CompactContinuationPolicy;
  compact?: { profile?: string; params?: ViewCompactParams };
  /** Stored sha256 of intent_json (identity bytes as written). */
  intentHash: string;
  /** Raw stored intent JSON (stable-stringified identity). */
  intentJson: string;
  createdAt: string;
};

function requireStringField(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${ctx}: missing or empty string field '${key}'`);
  }
  return v;
}

function requireFiniteNumber(obj: Record<string, unknown>, key: string, ctx: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${ctx}: missing or non-finite number field '${key}'`);
  }
  return v;
}

/**
 * Fail-fast parse of a stored attempt-intent row into operation identity.
 * Never synthesizes missing fields; throws with a storage-corruption detail.
 */
export function parseStoredOperationIdentity(row: AttemptRow): StoredOperationIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.intentJson);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`compact-continuation attempt intent JSON corrupt for attemptId=${row.attemptId}: ${msg}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`compact-continuation attempt intent JSON must be an object for attemptId=${row.attemptId}`);
  }
  const obj = parsed as Record<string, unknown>;
  const contractVersion = requireStringField(obj, "contractVersion", "operation identity");
  const attemptId = requireStringField(obj, "attemptId", "operation identity");
  if (attemptId !== row.attemptId) {
    throw new Error(`operation identity attemptId mismatch: row=${row.attemptId} json=${attemptId}`);
  }
  const actor = requireStringField(obj, "actor", "operation identity");
  const harness = requireStringField(obj, "harness", "operation identity");

  const contRaw = obj["continuation"];
  if (contRaw === null || typeof contRaw !== "object" || Array.isArray(contRaw)) {
    throw new Error("operation identity: continuation must be an object");
  }
  const contObj = contRaw as Record<string, unknown>;
  const contKind = requireStringField(contObj, "kind", "operation identity.continuation");
  let continuation: StoredOperationIdentity["continuation"];
  if (contKind === "none") {
    continuation = { kind: "none" };
  } else if (contKind === "active_non_tool") {
    continuation = { kind: "active_non_tool" };
  } else if (contKind === "pending_correlated_tool_result") {
    const idsRaw = contObj["protectedToolCallIds"];
    if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
      throw new Error("operation identity: protectedToolCallIds must be a non-empty array");
    }
    const protectedToolCallIds: string[] = [];
    for (const id of idsRaw) {
      if (typeof id !== "string" || id.length === 0) {
        throw new Error("operation identity: protectedToolCallIds entries must be non-empty strings");
      }
      protectedToolCallIds.push(id);
    }
    continuation = {
      kind: "pending_correlated_tool_result",
      protectedToolCallIds: [...protectedToolCallIds].sort(),
    };
  } else {
    throw new Error(`operation identity: unknown continuation.kind '${contKind}'`);
  }

  const policyRaw = obj["policy"];
  if (policyRaw === null || typeof policyRaw !== "object" || Array.isArray(policyRaw)) {
    throw new Error("operation identity: policy must be an object");
  }
  const policyObj = policyRaw as Record<string, unknown>;
  const hostCapability = requireStringField(policyObj, "hostCapability", "operation identity.policy");
  if (hostCapability !== "full_state_machine" && hostCapability !== "capability_limited") {
    throw new Error(`operation identity: invalid policy.hostCapability '${hostCapability}'`);
  }
  const policy: CompactContinuationPolicy = {
    upperTriggerTokens: requireFiniteNumber(policyObj, "upperTriggerTokens", "operation identity.policy"),
    lowerTargetTokens: requireFiniteNumber(policyObj, "lowerTargetTokens", "operation identity.policy"),
    hostCapability,
  };
  if (policyObj["safeRunwayThresholdTokens"] !== undefined) {
    policy.safeRunwayThresholdTokens = requireFiniteNumber(
      policyObj,
      "safeRunwayThresholdTokens",
      "operation identity.policy",
    );
  }
  if (policyObj["safeRunwayThresholdSource"] !== undefined) {
    const src = policyObj["safeRunwayThresholdSource"];
    if (typeof src !== "string" || src.length === 0) {
      throw new Error("operation identity: policy.safeRunwayThresholdSource must be a non-empty string");
    }
    policy.safeRunwayThresholdSource = src;
  }

  let compact: StoredOperationIdentity["compact"];
  if (obj["compact"] !== undefined) {
    const compactRaw = obj["compact"];
    if (compactRaw === null || typeof compactRaw !== "object" || Array.isArray(compactRaw)) {
      throw new Error("operation identity: compact must be an object when present");
    }
    const compactObj = compactRaw as Record<string, unknown>;
    const out: { profile?: string; params?: ViewCompactParams } = {};
    if (compactObj["profile"] !== undefined) {
      if (typeof compactObj["profile"] !== "string") {
        throw new Error("operation identity: compact.profile must be a string");
      }
      out.profile = compactObj["profile"];
    }
    if (compactObj["params"] !== undefined) {
      if (
        compactObj["params"] === null ||
        typeof compactObj["params"] !== "object" ||
        Array.isArray(compactObj["params"])
      ) {
        throw new Error("operation identity: compact.params must be an object");
      }
      out.params = compactObj["params"] as ViewCompactParams;
    }
    compact = out;
  }

  // Integrity: intent_hash must be sha256 of the stored intent_json bytes.
  // Do not re-serialize parsed fields (float/key drift would false-fail).
  const recomputed = createHash("sha256").update(row.intentJson).digest("hex");
  if (recomputed !== row.intentHash) {
    throw new Error(
      `operation identity intent_hash mismatch for attemptId=${row.attemptId}: stored=${row.intentHash} recomputed=${recomputed}`,
    );
  }

  return {
    contractVersion,
    attemptId,
    actor,
    harness,
    continuation,
    policy,
    ...(compact !== undefined ? { compact } : {}),
    intentHash: row.intentHash,
    intentJson: row.intentJson,
    createdAt: row.createdAt,
  };
}

/**
 * Read-only inspection: load and parse the durable attempt-intent / operation
 * identity for `attemptId`. Returns `null` when no row exists. Corrupt JSON or
 * incomplete identity fails as `storage_failure` — never synthesizes or clears.
 */
export async function getCompactContinuationAttemptIntent(
  ref: ThreadRef,
  attemptId: string,
): Promise<OpResult<StoredOperationIdentity | null>> {
  if (typeof attemptId !== "string" || attemptId.length === 0) {
    return storageFailure("compact-continuation attempt intent requires a non-empty attemptId");
  }
  try {
    return await createDbReadTransaction(ref, (tx) => {
      const row = readAttemptIntent(tx.db, attemptId);
      if (row === null) return null;
      return parseStoredOperationIdentity(row);
    });
  } catch (cause) {
    return storageFailure(`compact-continuation attempt intent read failed: ${detail(cause)}`);
  }
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
 * Atomic receipt persist + optional boundary update + optional writer release.
 * Catches transaction exceptions and returns storageFailure — never throws out
 * of runCompactContinuation. Supports mid-txn fault hooks. Never ignores
 * release failures. Does not terminalize while an owned writer remains held.
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
    /**
     * Discard this attempt's boundary bookkeeping row (R23-S9/S10 budget
     * exhaustion). Mutually exclusive with `boundaryUpdate`.
     */
    boundaryDiscard?: { continuationTurnId: string };
    forcedBoundaryThisAttempt: boolean;
    continuationTurnId: string | null;
    compactReceipt: CompactReceipt | null;
    /** This attempt reclaimed a stale native/conflict writer row (R23-S8). */
    reclaimedStaleWriterRow?: boolean;
  },
  clock: () => Date,
  hooks?: CompactContinuationTestHooks,
): Promise<OpResult<CompactContinuationRunResult>> {
  try {
    if (hooks?.failFinalizeWrite === true || hooks?.failReceiptWrite === true) {
      return storageFailure("compact-continuation finalize write failed (test injection)");
    }

    // Never terminalize while this attempt still holds the durable writer and
    // is not releasing it in this same transaction.
    let terminal = opts.terminal;
    if (terminal && !opts.releaseWriter) {
      const held = await createDbReadTransaction(ref, (tx) => readWriterClaim(tx.db));
      if (!held.ok) return held;
      if (held.value.claim === "lhc" && held.value.attemptId === facts.attemptId) {
        terminal = false;
      }
    }

    // Align residual writerReleased with the actual release action when we will
    // release (oracle may already say true; keep consistent). When we release,
    // residual must report released. When we do not, and we still hold the claim,
    // force residual.writerReleased false so receipts stay truthful.
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

/** Best-effort release of this attempt's durable writer claim; never ignores failure. */
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
      // Never release another attempt's claim.
      return true as const;
    },
    clock,
  );
  if (!rel.ok) return rel;
  return { ok: true, value: true };
}

/**
 * Public entry: closed validation rejects testHooks; no fault injection surface.
 *
 * `opts.writerOwnershipCheck` is the host's ownership authority for a stale
 * `native`/`conflict` writer row. Without it the SDK never reclaims.
 */
export async function runCompactContinuation(
  ref: ThreadRef,
  facts: CompactContinuationHostFacts,
  clock: () => Date = () => new Date(),
  opts: { writerOwnershipCheck?: CompactContinuationWriterOwnershipCheck } = {},
): Promise<OpResult<CompactContinuationRunResult>> {
  return runCompactContinuationInner(ref, facts, clock, undefined, opts.writerOwnershipCheck);
}

/**
 * Test-only entry: same runtime with optional fault hooks.
 * Exported only via sanctioned test-fixtures / internal path — not public SDK types.
 */
export async function runCompactContinuationForTests(
  ref: ThreadRef,
  facts: CompactContinuationHostFacts,
  clock: () => Date = () => new Date(),
  hooks?: CompactContinuationTestHooks,
  writerOwnershipCheck?: CompactContinuationWriterOwnershipCheck,
): Promise<OpResult<CompactContinuationRunResult>> {
  return runCompactContinuationInner(ref, facts, clock, hooks, writerOwnershipCheck);
}

/**
 * Run one compact-continuation attempt against thread state.
 */
async function runCompactContinuationInner(
  ref: ThreadRef,
  facts: CompactContinuationHostFacts,
  clock: () => Date,
  hooks: CompactContinuationTestHooks | undefined,
  writerOwnershipCheck?: CompactContinuationWriterOwnershipCheck,
): Promise<OpResult<CompactContinuationRunResult>> {
  // ── Closed host-fact validation before any I/O ──────────────────────────
  const inputIssue = validateHostFacts(facts);
  if (inputIssue !== undefined) return { ok: false, error: inputIssue };

  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;

  const identity = computeOperationIdentity(facts);
  const { intentHash, intentJson } = hashAttemptIntent(identity);

  // ── Terminal attempt replay (matching identity only) ────────────────────
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
    // Repair stale same-owner writer claim left after a prior terminal path.
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

  // ── Pre-seam / durable state (read-only) ────────────────────────────────
  // Input-epoch drift is diagnostic only (CX-S5 / R1): settled history is not
  // invalidated by input that arrived later in the turn.
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

  // ── Ownership: foreign pending/failed_repairable cannot be stolen ───────
  if (pendingBoundary !== null && pendingBoundary.attemptId !== facts.attemptId) {
    return attemptConflict(
      facts.attemptId,
      pendingBoundary.attemptId,
      `pending boundary ${pendingBoundary.continuationTurnId} is owned by another attempt`,
    );
  }

  // ── Register immutable operation identity before further mutation ───────
  // Identity drift always conflicts (including nonterminal repair). Posture
  // (seam/usage/health) may change and is recorded per entry below.
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

  // Append retry posture snapshot for this invocation (append-only audit).
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

  // ── Force crash-gap reconcile on any entry ──────────────────────────────
  // If force intent exists (intent/applied) and no pending boundary, recover
  // the continuation turn from the durable turn_end key without re-forcing
  // when the turn already exists.
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
    // If no turn yet, same attempt will re-send idempotent turn_end on force path.
  }

  const forcedFromPending = pendingBoundaryAsForced(pendingBoundary);
  const ownsPending = pendingBoundary !== null && pendingBoundary.attemptId === facts.attemptId;

  // ── Pre-seam skips ──────────────────────────────────────────────────────
  if (preSkip) {
    // Release durable claim owned by this attempt — never another attempt's.
    // Quiet/skip paths must not leave a claim-only wedge.
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
    // Pending owned by this attempt: nonterminal so later settled repair can proceed.
    // Terminal only when no pending AND writer is released (or was not held).
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

  // ── Settled seam: stale native/conflict row under host authority ─────────
  // A row claiming the thread for someone else is never a stop. The host's
  // ownership registry (process-global, keyed by LHC thread id) decides: reclaim
  // a stale row from a dead owner, otherwise this attempt is the loser and
  // continues its current request.
  let reclaimedStaleWriterRow = false;
  if (facts.writerClaim === "native" || facts.writerClaim === "conflict") {
    let liveOwner = true;
    let authoritySupplied = false;
    if (writerOwnershipCheck !== undefined) {
      authoritySupplied = true;
      // Canonical LHC thread id — the only key that stays stable across two
      // sessions or aliases pointing at the same thread.
      const threadIdRead = await createDbReadTransaction(ref, (tx) => readCanonicalThreadId(tx.db));
      if (!threadIdRead.ok) return threadIdRead;
      try {
        liveOwner = (await writerOwnershipCheck({ threadId: threadIdRead.value, attemptId: facts.attemptId })) === true;
      } catch (cause) {
        // An authority that cannot answer is not authority to steal.
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
      // Loser: release only a claim this attempt owns, mutate nothing else, and
      // let the session continue its current request.
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

  // Durable protected-pair-set proof for pending-tool path (host correlation insufficient).
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

  // Unusable applied-boundary + wrong continuation kind (repair path only).
  // The oracle discards the boundary and starts the seam fresh (R23-S12). The
  // durable boundary row is left inspectable and repairable — the decision is
  // nonterminal — because the continuation turn it names really was opened.
  // v2: pending_correlated_tool_result is legal with applied boundary (protected escalation).
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
        // Keep nonterminal when boundary still needs repair.
        terminal: !ownsPending,
        forcedBoundaryThisAttempt: false,
        continuationTurnId: decision.receipt.residual.continuationTurnId,
        compactReceipt: null,
      },
      clock,
      hooks,
    );
  }

  // Capture / identity / open-turn health no longer gates the seam: those facts
  // travel with the oracle input and surface as receipt warnings. Only an
  // unprovable protected pair set changes the route — the pair cannot be
  // protected through compact, so this seam declines into the host's ordinary
  // settled-seam compact on canonical state and mutates nothing.
  if (!toolPairOk) {
    const cont =
      facts.continuation.kind === "pending_correlated_tool_result"
        ? { ...facts.continuation, correlationValid: false }
        : facts.continuation;
    // When a pending boundary is owned and repairable, keep the claim for resume.
    // When this is a claim-only crash (no pending boundary), release so quiet/
    // decline re-entry does not wedge the writer.
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
        // Declining is terminal only when no pending boundary for this attempt.
        terminal: !ownsPending,
        forcedBoundaryThisAttempt: false,
        continuationTurnId: decision.receipt.residual.continuationTurnId,
        compactReceipt: null,
      },
      clock,
      hooks,
    );
  }

  // ── Pressure / branch (no claim yet) ────────────────────────────────────
  const pressure = pressureAtOrAbove(facts);
  // Repair pending boundary always takes continue-turn path regardless of pressure.
  // let so pending-tool path can escalate to continue-turn mid-attempt.
  let needsContinueTurn =
    forcedFromPending.applied || (pressure === true && facts.continuation.kind === "active_non_tool");
  // Protected-escalation repair: pending boundary + pending tool set also continues.
  if (forcedFromPending.applied && facts.continuation.kind === "pending_correlated_tool_result" && toolPairOk) {
    needsContinueTurn = true;
  }
  let needsPreserveTool =
    !forcedFromPending.applied &&
    pressure === true &&
    facts.continuation.kind === "pending_correlated_tool_result" &&
    toolPairOk;

  // No-compact quiet paths: never claim a new writer; release owned claim-only
  // crash wedges so fresh attempts can proceed. With a pending owned boundary,
  // keep the claim for resume (nonterminal).
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
        // Quiet outcomes are terminal only with no pending owned boundary.
        terminal: !ownsPending,
        forcedBoundaryThisAttempt: false,
        continuationTurnId: null,
        compactReceipt: null,
      },
      clock,
      hooks,
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

  // Bounded retry index: 1 + the number of compact/install failures already
  // recorded for this attempt identity. `policy.compactRetryBudget` bounds it;
  // exhaustion continues on the current body rather than stopping.
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
    // ── Pending-tool prepare/evaluate (may escalate to continue-turn) ─────
    let pendingEscalated = false;
    let proposedVisibilityBoundary: number | null = null;
    let visibilityBoundaryBefore: number | null = null;
    const protectedIds: string[] =
      facts.continuation.kind === "pending_correlated_tool_result"
        ? [...facts.continuation.protectedToolCallIds].sort()
        : [];

    if (needsPreserveTool && !needsContinueTurn && hooks?.skipRealCompact !== true) {
      // 1) Prepare ordinary preserve candidate without installing.
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
          // Normal preserve path: keep prepared for install below.
          // Fall through with needsPreserveTool; material filled in prepare section.
        } else {
          // Escalate before any preserve install: force boundary + protected prune.
          pendingEscalated = true;
          // Flip into continue-turn flow for force/marker; continuation kind stays pending set.
          // Force path uses needsContinueTurn — set local flag.
          needsContinueTurn = true;
          needsPreserveTool = false;
        }
      }
    }

    // ── Force boundary if fresh continue-turn ─────────────────────────────
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

      // If turn already exists from a prior force, materialize boundary only.
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
        // 1. Durable force intent before turn_end commit.
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

        // 2. Canonical turn_end (idempotent by attempt key).
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

        // Crash gap: after turn_end commit, before boundary materialization.
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
          // Writer stays held; force_intent remains; next resume reconciles one boundary.
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

        // 3. Materialize boundary from opened turn id.
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
            // 4. Mark force intent applied/reconciled with continuation turn id.
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

    // ── Protected visibility boundary (escalated pending only) ────────────
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

    // ── Compact prepare + candidate material ──────────────────────────────
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
        // Escalated candidate unsafe at the target-limited walk: before any
        // refuse, apply maximal eligible pruning once (story: refuse only when
        // maximal eligible pruning still cannot produce safe runway).
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
        // Pressure formula is authoritative. When the projected pressure is
        // provably safe, the zone-proxy insufficiency flag is advisory noise —
        // clear it so oracle classification matches the installed reality.
        if (escalated && material.projectedPressureSafe === true && material.maximalPruneInsufficient) {
          material = { ...material, maximalPruneInsufficient: false };
        }
        // CX-S5 / R24: an unsafe projected runway after maximal eligible pruning
        // is a diagnostic, not a gate. The relief still installs and the oracle
        // records `unsafe_runway_projection`. Oversized outgoing content is ours
        // to truncate as a ladder rung, and the host's exact body check is
        // downstream. maximalPruneInsufficient stays proven for the receipt.
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

    // ── Marker before install (continue-turn only, when structure valid) ──
    // Skipped when the attempt already resolved not to install (prepared
    // cleared, e.g. unsafe-runway refuse): a marker persisted on a certain
    // refuse would contradict the receipt residual. Repair reasserts by key.
    // An unprovable provider request never blocks the marker or the install
    // (R21): the best available body is sent and the provider decides.
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

      // Crash gap: marker event durable, boundary.marker_persisted not yet updated.
      // Resume detects marker by idempotency key, reconciles status, no second marker.
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
              // Boundary row may still say marker false; residual presence is true in record.
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

      // Re-evaluate candidate after marker lands so model-visible structure includes it.
      // Do not silently keep pre-marker material when re-assembly fails.
      if (prepared !== null && hooks?.skipRealCompact !== true) {
        const candidate2 = await createDbReadTransaction(ref, (tx) =>
          // Same boundary override as the pre-marker assembly: dropping it here
          // would recompute escalated savings against full bodies and misreport
          // an installed-safe candidate as unsafe.
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

    // ── Install ───────────────────────────────────────────────────────────
    const canAttemptInstall =
      material.compactStructurallyValid && (prepared !== null || hooks?.skipRealCompact === true);

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

    // Final oracle boundary input.
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

    // Boundary completion vs failed_repairable (nonterminal until repair succeeds).
    // compact_preserve_tool_escalated is an installed success like the rest:
    // omitting it finalized a successfully installed escalation as
    // failed_repairable / compact_failed, contradicting its own receipt.
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
        // Successful installed outcomes — terminal + complete boundary.
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
        // Install/compact fail after force.
        // compact_failed: candidate structure invalid (never reached a valid install).
        // install_failed: valid candidate reached install and install failed.
        // A structurally valid candidate that reached install and failed is an
        // install failure; anything earlier is a compact failure.
        //
        // Bounded retry, never a stop — but bounded means bounded (R23-S9/S10):
        // while the oracle still authorizes retry the boundary stays
        // failed_repairable and the attempt is nonterminal; once the budget is
        // exhausted (continue_current_body / compact_retry_budget_exhausted)
        // the attempt terminalizes so the same attempt replays without
        // mutating, and its speculative boundary bookkeeping is discarded so a
        // fresh attempt starts clean. Canonical turn/marker bytes and the
        // terminal receipt stay; nextProviderRequestAllowed remains true.
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
    // Never silently drop release failure.
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

/**
 * Provider-neutral host validation acknowledgment after successful core install.
 * Does not roll back core view/boundary. Blocks next provider request until ok
 * when status is awaiting/failed. LHC never validates the host provider body.
 */
export async function recordCompactContinuationHostValidation(
  ref: ThreadRef,
  attemptId: string,
  result: "ok" | "failed",
  opts: { reason?: string; clock?: () => Date } = {},
): Promise<OpResult<{ attemptId: string; status: "ok" | "failed"; reason: string | null }>> {
  if (typeof attemptId !== "string" || attemptId.length === 0) {
    return storageFailure("host validation requires non-empty attemptId");
  }
  if (result !== "ok" && result !== "failed") {
    return storageFailure("host validation result must be ok|failed");
  }
  const clock = opts.clock ?? (() => new Date());
  try {
    return await createDbWriteTransaction(
      ref,
      (tx) => {
        const row = recordHostValidationResult(tx.db, attemptId, result, clock().toISOString(), opts.reason);
        appendStageLog(tx.db, attemptId, "receipt_recorded", clock().toISOString(), {
          hostValidation: result,
          reason: opts.reason ?? null,
        });
        return {
          attemptId,
          status: row.status === "ok" || row.status === "failed" ? row.status : result,
          reason: row.reason,
        };
      },
      clock,
    );
  } catch (cause) {
    return storageFailure(`host validation record failed: ${detail(cause)}`);
  }
}

export async function getCompactContinuationHostValidation(
  ref: ThreadRef,
  attemptId: string,
): Promise<OpResult<{ attemptId: string; status: "awaiting" | "ok" | "failed"; reason: string | null } | null>> {
  try {
    return await createDbReadTransaction(ref, (tx) => {
      const row = readHostValidation(tx.db, attemptId);
      if (row === null) return null;
      return { attemptId: row.attemptId, status: row.status, reason: row.reason };
    });
  } catch (cause) {
    return storageFailure(`host validation read failed: ${detail(cause)}`);
  }
}
