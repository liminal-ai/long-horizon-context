# Compact-continuation runtime (LIM-61)

Staged TypeScript runtime for the frozen LIM-60 contract.

| Surface | Path |
|---|---|
| API | `sdk.compactContinuation` / `packages/lhc/src/compact-continuation/` |
| Contract/oracle | `packages/lhc/src/shared-tech/compact-continuation/` |
| Schema | thread v7 (`compact_continuation_writer`, `compact_continuation_receipt`) |

## Entry point

```ts
const result = await sdk.compactContinuation.runCompactContinuation(ref, {
  attemptId: "attempt-1",
  seam: { /* settled seam flags + epochs */ },
  providerUsage: { available: true, inputTokens, cacheCreationTokens, cacheReadTokens, total, domain: "provider_reported_input" },
  postMeasurementEstimate: { tokens, source, domain: "source_labelled_estimate" },
  policy: { upperTriggerTokens, lowerTargetTokens, hostCapability: "full_state_machine" },
  continuation: { kind: "active_non_tool" } | { kind: "pending_correlated_tool_result", toolCallId, correlationValid } | { kind: "none" },
  writerClaim: "none", // or "lhc" for same-attempt repair; native/conflict refuse
  captureComplete: true,
  providerIdentityValid: true,
  actor: "host",
  harness: "codex",
});
```

Host trigger policy (when to call) is **outside** the SDK.

## Result shape

`CompactContinuationRunResult` includes:

- `decision` / `receipt` — oracle classification (effects, residual, transition path)
- `forcedBoundaryThisAttempt`, `continuationTurnId`, `markerPersisted`
- `compactReceipt` — view install receipt when install succeeded
- `nextProviderRequestAllowed` — host gate for the next provider request
- `refuseReceiptFidelityDescribes: "installed_view_only"` — refuse fidelity is not attempt-scoped

## Inspection

- `getCompactContinuationReceipt(ref, attemptId)`
- `listCompactContinuationReceipts(ref)`
- `getCompactContinuationWriterClaim(ref)`
- `hasCompactContinuationMarker(ref, continuationTurnId)`

Receipts are **not** ordinary conversation messages.

## Test hooks

`testHooks` on host facts enable failure injection (interrupt after boundary/marker, fail install, skip real compact). Production hosts omit them.
