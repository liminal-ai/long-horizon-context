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
 * 3. Completed `attemptId` with matching attempt intent replays the stored
 *    terminal receipt without mutation; different intent conflicts.
 * 4. Force-intent gap: resume reconciles `turn_end` into one pending boundary.
 * 5. Stage history is append-only via `listCompactContinuationStages`.
 */

export {
  type CompactContinuationHostFacts,
  type CompactContinuationRunResult,
  type CompactContinuationTestHooks,
  computeAttemptIntent,
  getCompactContinuationReceipt,
  getCompactContinuationWriterClaim,
  getPendingCompactContinuationBoundary,
  hasCompactContinuationMarker,
  hashAttemptIntent,
  listCompactContinuationBoundaries,
  listCompactContinuationReceipts,
  listCompactContinuationStages,
  runCompactContinuation,
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

export { provePendingToolPair, type ToolPairProof } from "./internal/tool-pair.js";
export { validateHostFacts } from "./internal/validate-host.js";
