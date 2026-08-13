/**
 * Compact-continuation contract package surface.
 * See README.md and contract.ts for the full specification.
 */

export {
  COMPACT_CONTINUATION_CONTRACT_VERSION,
  COMPACT_CONTINUATION_INVARIANTS,
  COMPACT_CONTINUATION_MARKER_KIND,
  COMPACT_CONTINUATION_OUTCOME_KINDS,
  COMPACT_CONTINUATION_REFUSE_CODES,
  COMPACT_CONTINUATION_STATES,
  COMPACT_CONTINUATION_TRANSITION_ORDER,
  CONTEXT_COMPACT_CONTINUE_REASON,
  type CompactContinuationDecision,
  type CompactContinuationEffect,
  type CompactContinuationEffectType,
  type CompactContinuationHostCapability,
  type CompactContinuationInput,
  type CompactContinuationInvariantId,
  type CompactContinuationInvariants,
  type CompactContinuationLowerTargetReceipt,
  type CompactContinuationOutcomeKind,
  type CompactContinuationPolicy,
  type CompactContinuationPressureReceipt,
  type CompactContinuationReceipt,
  type CompactContinuationRefuseCode,
  type CompactContinuationSeam,
  type CompactContinuationState,
  type CompactContinuationTransitionStep,
  type CompactMaterialFacts,
  type LhcRenderedHistoryAccounting,
  type PostMeasurementEstimate,
  type ProviderReportedInputAccounting,
  type ProviderUsageAuthority,
  type SourceLabelledEstimateAccounting,
  type TokenAccountingDomain,
  type WorkContinuation,
  type WriterClaim,
} from "./contract.js";

// Re-export CompactMaterialFacts under the shorter alias used above if needed.
// contract exports CompactMaterialFacts directly.

export { decideCompactContinuation } from "./decide.js";

export {
  asCompactContinuationInput,
  assertDecisionParity,
  type ValidationIssue,
  type ValidationResult,
  validateCompactContinuationDecision,
  validateCompactContinuationInput,
  validateCompactContinuationReceipt,
} from "./validate.js";
