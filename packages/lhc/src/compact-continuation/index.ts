/**
 * Compact-continuation runtime surface (LIM-61).
 *
 * Pure contract/oracle: `shared-tech/compact-continuation`.
 * Staged thread operation: this module.
 */

export {
  type CompactContinuationHostFacts,
  type CompactContinuationRunResult,
  type CompactContinuationTestHooks,
  getCompactContinuationReceipt,
  getCompactContinuationWriterClaim,
  hasCompactContinuationMarker,
  listCompactContinuationReceipts,
  runCompactContinuation,
} from "./internal/run.js";

export type { StoredCompactContinuationReceipt, WriterClaimRow } from "./internal/store.js";
