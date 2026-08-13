# Compact-continuation runtime (LIM-61)

Staged TypeScript runtime for the frozen LIM-60 contract.

| Surface | Path |
|---|---|
| API | `sdk.compactContinuation` / `packages/lhc/src/compact-continuation/` |
| Contract/oracle | `packages/lhc/src/shared-tech/compact-continuation/` |
| Schema | thread v9 (`compact_continuation_writer`, `boundary`, `receipt`, `attempt`, `force_intent`, stage log) |

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
- `replayedTerminalAttempt` — true when a completed attemptId was replayed
- `pendingBoundary` — durable pending/failed_repairable row after the call, if any

## Inspection

- `getCompactContinuationReceipt(ref, attemptId)`
- `listCompactContinuationReceipts(ref)`
- `getCompactContinuationWriterClaim(ref)`
- `getPendingCompactContinuationBoundary(ref)`
- `listCompactContinuationBoundaries(ref)`
- `listCompactContinuationStages(ref, attemptId)`
- `hasCompactContinuationMarker(ref, continuationTurnId)`

Receipts are **not** ordinary conversation messages.

## Lifecycle rules

### Terminal receipts (`terminal: true`)

Write terminal only for:

- Successful installed outcomes (`compact_continue_turn` / `degraded_compact` / `no_reduction` with `installSucceeds`)
- Final quiet non-mutating outcomes with **no** pending boundary owned by this attempt (below trigger, normal complete, missing usage)
- Health/native refuses when there is **no** pending/failed_repairable boundary for this attempt
- Terminal replay of a completed attempt with **matching** attempt-intent hash

### Nonterminal receipts (`terminal: false`)

- `failed_repairable` after boundary (install/compact fail after force) — same attempt must be able to repair
- Crash interrupt after boundary/marker (writer may stay held)
- preSkip / temporary health refuse **while** a boundary is pending/failed_repairable for this attempt

After successful repair: write terminal receipt + mark boundary `complete` + release writer **atomically**.

### Ownership

If `readPendingBoundary` returns a row and `facts.attemptId !== pending.attemptId`, return `compact_continuation_attempt_conflict` with the owner id **before any mutation** (including quiet/health paths). Boundary ownership is never overwritten.

### Attempt intent fingerprint

Before mutation (after validation), compute an immutable intent from host facts **excluding** `writerClaim` and `testHooks`:

`{ contractVersion, attemptId, actor, harness, seam, providerUsage, postMeasurementEstimate, policy, continuation, captureComplete, providerIdentityValid, compact? }`

Stable JSON (sorted keys) + sha256. Stored in `compact_continuation_attempt`.

- `exists_different` → `compact_continuation_attempt_conflict`
- Terminal replay requires matching `intent_hash`; different intent → conflict (not silent replay)

### Force crash gap

Before `intakeStream.messageEvents(turn_end)`:

1. Durable `recordForceIntent(attemptId, turnEndKey, now)` status=`intent`
2. Call `messageEvents`
3. Materialize boundary row from opened turn id
4. `markForceIntentApplied`

On any entry, if force intent exists with status intent/applied and no pending boundary:

- Resolve turn via `findContinuationTurnFromForceKey`
- If turn exists: `upsertBoundary` pending + mark reconciled; **do not** force again
- If turn does not exist and same attempt continues force path: re-send idempotent `turn_end`

## Crash recovery protocol

1. **Inspect writer:** `getCompactContinuationWriterClaim(ref)`. If `claim === "lhc"`, the owning `attemptId` is the only attempt that may resume; a different attempt receives `compact_continuation_writer_conflict`.
2. **Inspect pending boundary:** `getPendingCompactContinuationBoundary(ref)`. Status `pending` or `failed_repairable` means compact/marker/install is incomplete — re-enter with the **same** `attemptId` and `continuation.kind: "active_non_tool"`. Do not force a second boundary. Foreign attemptIds receive `compact_continuation_attempt_conflict`.
3. **Force intent gap:** if a prior force committed `turn_end` but died before the boundary row, resume with the same attemptId; runtime reconciles from the durable force key.
4. **Completed attempt:** reusing a terminal `attemptId` with the **same** intent returns the stored receipt (`replayedTerminalAttempt: true`) without re-compacting. Different intent → conflict.
5. **Stage audit:** `listCompactContinuationStages(ref, attemptId)` is append-only.

Complete boundaries (`status: "complete"`) are ordinary continuation turns. Later below-trigger seams do not mutate; a later above-trigger active seam may create a **new** boundary with a new turn/marker id and a **new** attemptId.

## Preflight (no mutation)

Settled-seam health refusals (incomplete capture, invalid identity, broken open turn, invalid tool correlation / durable pair proof, native writer conflict) and quiet seams (below trigger, missing usage, normal complete) **never** claim the writer or mutate the record/view — **unless** this attempt already owns a pending boundary (then the call may persist a nonterminal receipt and leave repair open).

preSkip release inspects the **durable** writer claim and only releases when `claim.attemptId === facts.attemptId`.

## Test hooks

`testHooks` are test-only fault injection:

- `interruptAfterTurnEndCommit` — after `turn_end` commit, before boundary materialization
- `interruptAfterBoundary` / `interruptAfterMarker`
- `failInstallBeforeWrite`, `skipRealCompact`, material force hooks
- `failFinalizeWrite` / `failReceiptWrite` (pre-txn)
- `failFinalizeAfterReceipt` / `failFinalizeAtRelease` (mid-txn)

Production hosts omit them; unknown hook keys are rejected by closed validation.
