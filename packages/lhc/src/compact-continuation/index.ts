/**
 * Compact-continuation runtime surface (LIM-61).
 *
 * Pure contract/oracle: `shared-tech/compact-continuation`.
 * Staged thread operation: this module.
 *
 * ## Crash recovery protocol
 *
 * 1. Inspect `getCompactContinuationWriterClaim` — if claim is `lhc`, resume
 *    with that `attemptId` (do not invent a new one; another attempt cannot steal).
 * 2. Inspect `getPendingCompactContinuationBoundary` — if status is
 *    `pending` or `failed_repairable`, re-enter with the same attemptId and
 *    `continuation.kind: "active_non_tool"`. Foreign attemptIds conflict.
 * 3. Completed `attemptId` with matching operation identity replays the stored
 *    terminal receipt without mutation; different identity conflicts.
 * 4. Force-intent gap: resume reconciles `turn_end` into one pending boundary.
 * 5. Claim-only crash (writer held, no boundary): same attempt may re-enter under
 *    quiet/health/mutating facts; quiet/health release the owned claim; mutating
 *    resumes. Fresh attempts stay blocked until the owner resumes or releases.
 *    Hosts must re-enter with the **stored** operation identity from
 *    `getCompactContinuationAttemptIntent` (continuation kind/protectedToolCallIds, policy,
 *    compact, actor/harness) — live seam continuation cannot recreate a
 *    response-scoped protectedToolCallIds after restart.
 * 6. Stage history is append-only via `listCompactContinuationStages` (includes
 *    per-entry `retry_posture` snapshots).
 *
 * Public `runCompactContinuation` does **not** accept `testHooks`. Fault
 * injection is test-only via fixtures/`runCompactContinuationForTests`.
 */

export {
  type CompactContinuationHostFacts,
  type CompactContinuationRunResult,
  computeAttemptIntent,
  computeOperationIdentity,
  computeRetryPosture,
  getCompactContinuationAttemptIntent,
  getCompactContinuationHostValidation,
  getCompactContinuationReceipt,
  getCompactContinuationWriterClaim,
  getPendingCompactContinuationBoundary,
  hasCompactContinuationMarker,
  hashAttemptIntent,
  hashRecord,
  listCompactContinuationBoundaries,
  listCompactContinuationReceipts,
  listCompactContinuationStages,
  parseStoredOperationIdentity,
  recordCompactContinuationHostValidation,
  runCompactContinuation,
  type StoredOperationIdentity,
} from "./internal/run.js";

export type {
  AttemptRow,
  BoundaryRow,
  BoundaryStatus,
  ForceIntentRow,
  StageName,
  StoredCompactContinuationReceipt,
  WriterClaimRow,
} from "./internal/store.js";

export {
  type ProtectedToolPairSetProof,
  provePendingToolPair,
  proveProtectedToolPairSet,
  type ToolPairProof,
} from "./internal/tool-pair.js";
export { validateHostFacts } from "./internal/validate-host.js";
