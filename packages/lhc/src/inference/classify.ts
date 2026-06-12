// Failure classification (DD-3): a pure table from the boundary's failure
// vocabulary onto Epic 02's retryable-or-not. The queue machinery consumes
// `retryable` exactly as it always has — no queue changes, no new states.
// `safeCall` (timeout race + thrown-exception containment, DD-6/AC-3.3)
// lands with the classification story; the adapter's inline containment is
// the construction-time minimum until then.
import type { ModelCallFailureKind } from "./types.js";

export const FAILURE_CLASSIFICATION: Record<ModelCallFailureKind, { retryable: boolean }> = {
  rate_limit: { retryable: true },
  timeout: { retryable: true },
  network: { retryable: true },
  empty_output: { retryable: true },
  other: { retryable: true },
  auth: { retryable: false },
  invalid_request: { retryable: false },
};
