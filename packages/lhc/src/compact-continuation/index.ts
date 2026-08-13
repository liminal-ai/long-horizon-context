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
 *    `continuation.kind: "active_non_tool"`.
 * 3. Completed `attemptId` replays the stored terminal receipt without mutation.
 * 4. Stage history is append-only via `listCompactContinuationStages`.
 */

export {
  type CompactContinuationHostFacts,
  type CompactContinuationRunResult,
  type CompactContinuationTestHooks,
  getCompactContinuationReceipt,
  getCompactContinuationWriterClaim,
  getPendingCompactContinuationBoundary,
  hasCompactContinuationMarker,
  listCompactContinuationBoundaries,
  listCompactContinuationReceipts,
  listCompactContinuationStages,
  runCompactContinuation,
} from "./internal/run.js";

export type {
  BoundaryRow,
  BoundaryStatus,
  StageName,
  StoredCompactContinuationReceipt,
  WriterClaimRow,
} from "./internal/store.js";

export { provePendingToolPair, type ToolPairProof } from "./internal/tool-pair.js";
export { validateHostFacts } from "./internal/validate-host.js";
