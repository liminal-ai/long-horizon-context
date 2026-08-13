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

## Crash recovery protocol

1. **Inspect writer:** `getCompactContinuationWriterClaim(ref)`. If `claim === "lhc"`, the owning `attemptId` is the only attempt that may resume; a different attempt receives `compact_continuation_writer_conflict`.
2. **Inspect pending boundary:** `getPendingCompactContinuationBoundary(ref)`. Status `pending` or `failed_repairable` means compact/marker/install is incomplete — re-enter with the **same** `attemptId` and `continuation.kind: "active_non_tool"`. Do not force a second boundary.
3. **Completed attempt:** reusing a terminal `attemptId` returns the stored receipt (`replayedTerminalAttempt: true`) without re-compacting.
4. **Stage audit:** `listCompactContinuationStages(ref, attemptId)` is append-only.

Complete boundaries (`status: "complete"`) are ordinary continuation turns. Later below-trigger seams do not mutate; a later above-trigger active seam may create a **new** boundary with a new turn/marker id.

## Preflight (no mutation)

Settled-seam health refusals (incomplete capture, invalid identity, broken open turn, invalid tool correlation / durable pair proof, native writer conflict) and quiet seams (below trigger, missing usage, normal complete) **never** claim the writer or mutate the record/view.

## Test hooks

`testHooks` are test-only fault injection (interrupt after boundary/marker, fail install, fail finalize, skip real compact). Production hosts omit them.
