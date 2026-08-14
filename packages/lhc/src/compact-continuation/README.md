# Compact-continuation runtime (LIM-61)

Staged TypeScript runtime for the frozen LIM-60 contract.

| Surface | Path |
|---|---|
| API | `sdk.compactContinuation` / `packages/lhc/src/compact-continuation/` |
| Contract/oracle | `packages/lhc/src/shared-tech/compact-continuation/` |
| Schema | thread v10 (`compact_continuation_writer`, `boundary`, `receipt`, `attempt`, `force_intent`, stage log) |

## Entry point

```ts
const result = await sdk.compactContinuation.runCompactContinuation(ref, {
  attemptId: "attempt-1",
  seam: { /* settled seam flags + epochs */ },
  providerUsage: { available: true, inputTokens, cacheCreationTokens, cacheReadTokens, total, domain: "provider_reported_input" },
  postMeasurementEstimate: { tokens, source, domain: "source_labelled_estimate" },
  policy: { upperTriggerTokens, lowerTargetTokens, hostCapability: "full_state_machine" },
  continuation: { kind: "active_non_tool" } | { kind: "pending_correlated_tool_result", protectedToolCallIds, correlationValid } | { kind: "none" },
  writerClaim: "none", // host posture for oracle; durable ownership always re-read from storage
  captureComplete: true,
  providerIdentityValid: true,
  actor: "host",
  harness: "codex",
});
```

Host trigger policy (when to call) is **outside** the SDK.

Public closed validation rejects `testHooks`. Fault injection is test-only via
`runCompactContinuationForTests` (fixtures path).

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

Receipts are **not** ordinary conversation messages. Stage log is append-only
and includes per-entry `retry_posture` snapshots.

## Lifecycle rules

### Writer claim ownership

- Durable writer state is read at entry and after reconciliation.
- Release only when durable claim owner equals `facts.attemptId`. Never trust
  host `writerClaim` alone; never release another owner.
- Quiet, missing-usage, normal-completion, health-refusal, native/conflict, and
  terminal-replay paths must not leave this attempt's claim held.
- Do not terminalize an attempt until its owned writer is released successfully
  (or was never held).
- Receipt residual `writerReleased` reflects the actual release action.
- Completed matching terminal replay that finds a stale same-owner claim
  repairs/releases it with durable `writer_claim_repaired` /
  `recovery_maintenance` stage evidence without overwriting the terminal receipt.
- Claim-only crash (writer held, no boundary/force): same-attempt re-entry under
  quiet/health releases; mutating resume continues. Fresh attempts remain blocked
  until the owner resumes.

### Terminal receipts (`terminal: true`)

Write terminal only for:

- Successful installed outcomes (`compact_continue_turn` / `degraded_compact` / `no_reduction` with `installSucceeds`)
- Final quiet non-mutating outcomes with **no** pending boundary owned by this attempt and owned writer released
- Health/native refuses when there is **no** pending/failed_repairable boundary for this attempt and owned writer released
- Terminal replay of a completed attempt with **matching** operation identity hash

### Nonterminal receipts (`terminal: false`)

- `failed_repairable` after boundary (install/compact fail after force) — same attempt must be able to repair
- Crash interrupt after boundary/marker (writer may stay held)
- preSkip / temporary health refuse **while** a boundary is pending/failed_repairable for this attempt

After successful repair: write terminal receipt + mark boundary `complete` + release writer **atomically**.

### Ownership

If `readPendingBoundary` returns a row and `facts.attemptId !== pending.attemptId`, return `compact_continuation_attempt_conflict` with the owner id **before any mutation** (including quiet/health paths). Boundary ownership is never overwritten. Schema enforces at most one unresolved boundary; inspection throws on corruption rather than hiding a second row. Ownership-safe upsert throws if zero rows change due to owner mismatch.

### Immutable identity vs retry posture

**Immutable identity** (must match on every replay/resume; stored as
`intent_hash` / `intent_json` on `compact_continuation_attempt`):

- contract version, attempt id, actor, harness
- continuation kind + protectedToolCallIds (correlationValid is posture)
- policy, compact profile/params

**Retry posture** (may change; appended per invocation as stage `retry_posture`):

- seam flags and epochs, provider usage, post-measurement estimate
- capture/identity observations, host/durable writer posture

Identity drift → `compact_continuation_attempt_conflict` before mutation.
Posture drift on same-owner repair is accepted and audited.

### Force crash gap

Before `intakeStream.messageEvents(turn_end)`:

1. Durable `recordForceIntent(attemptId, turnEndKey, now)` status=`intent`
2. Call `messageEvents`
3. Materialize boundary row from opened turn id
4. `markForceIntentApplied` (throws if force-intent row missing)

On any entry, if force intent exists with status intent/applied and no pending boundary:

- Resolve turn via `findContinuationTurnFromForceKey`
- If turn exists: `upsertBoundary` pending + mark reconciled; **do not** force again
- If turn does not exist and same attempt continues force path: re-send idempotent `turn_end`

### Marker-event → boundary-status crash gap

After the canonical marker event commits and **before**
`compact_continuation_boundary.marker_persisted` / `last_stage` update:

1. Marker exists under idempotency key `lhc.compact_continuation:<turnId>`.
2. Boundary row may still show `markerPersisted: false`.
3. Same-attempt resume: detect marker by key; set `markerPersisted: true` on
   the owned boundary (no second marker insert); continue install or remain
   honestly `failed_repairable`; release writer on terminal success; append-only
   stages record the interrupt and reconcile.

Test-only seam: `interruptAfterMarkerEvent` (fixtures internal runner only).

### Finalize / OpResult

Every `finalizeAttempt` is awaited. Transaction exceptions are caught and
returned as `{ok:false, error.code:"storage_failure"}` — no raw rejection escapes
`runCompactContinuation`. Mid-txn faults roll back receipt/stage/boundary/release
together; same-attempt recovery succeeds once the fault is gone.

## Crash recovery protocol

1. **Inspect writer:** `getCompactContinuationWriterClaim(ref)`. If `claim === "lhc"`, the owning `attemptId` is the only attempt that may resume; a different attempt receives `compact_continuation_writer_conflict` (or cannot steal a pending boundary).
2. **Inspect pending boundary:** `getPendingCompactContinuationBoundary(ref)`. Status `pending` or `failed_repairable` means compact/marker/install is incomplete — re-enter with the **same** `attemptId` and `continuation.kind: "active_non_tool"`.
3. **Force intent gap:** if a prior force committed `turn_end` but died before the boundary row, resume with the same attemptId; runtime reconciles from the durable force key.
4. **Claim-only gap:** writer held with no boundary — same attempt quiet/health releases; mutating resumes.
5. **Completed attempt:** reusing a terminal `attemptId` with the **same** identity returns the stored receipt (`replayedTerminalAttempt: true`) without re-compacting. Different identity → conflict. Stale same-owner claim is repaired on replay.
6. **Stage audit:** `listCompactContinuationStages(ref, attemptId)` is append-only.

Complete boundaries (`status: "complete"`) are ordinary continuation turns. Later below-trigger seams do not mutate; a later above-trigger active seam may create a **new** boundary with a new turn/marker id and a **new** attemptId.

## Preflight (no mutation)

Settled-seam health refusals (incomplete capture, invalid identity, broken open turn, invalid tool correlation / durable pair proof, native writer conflict) and quiet seams (below trigger, missing usage, normal complete) **never** claim a new writer or mutate the record/view — **unless** this attempt already owns a pending boundary (then the call may persist a nonterminal receipt and leave repair open). Claim-only held writers owned by this attempt are released on these paths.

## Accounting domains

- **Upper trigger:** provider-reported input (`providerUsage.total` is the
  authoritative provider total; not re-summed from components).
- **Lower target:** LHC rendered-history domain only (`lhc_rendered_history`) —
  candidate estimate pre-install and post-install band/token_estimate sum are
  both in that domain.

## Install source validation

Marker-allowed install recomputes the source digest with exactly the marker
event/message/block removed and compares to the prepared digest. Fingerprint
covers derivation content/state/provenance, turn/chunk placement, boundary,
installed view identity, post-compact-point tail, and **every turn referenced
by prepared selection entries** (`message_excerpt`, stored_turn, chunk-member
fallbacks, etc. — not only chunk members). Selected turn ids are persisted on
`PreparedCompact.selectedSourceTurnIds`.

`source_state_json` stores the **validated pre-replace** source snapshot
written from `beforeReplace` after validation: includes marker max event order
when present; `installedViewId` and `structureDigest` are pre-replace /
pre-empty-chunk-drop.

Public `compact()` / `installPreparedCompact` may return `stale_prepared_compact`
under concurrent source change.

## Oracle effects vs residual (LIM-62 parity)

Oracle `effects` list the **prescribed protocol** for a completed seam
classification. Runtime residual and durable stage/writer/boundary state record
**what actually completed** on interrupted or repair paths (e.g. deferring
`release_writer` while a pending boundary is still owned). Residual/durable
state is the truth surface for hosts; effects must not be treated as
already-applied facts. Rust parity must preserve both without collapsing them.

## Empty open turn

When above-trigger active work has a single open turn with zero members, the
runtime refuses via the oracle's `invalid_pending_boundary_continuation` path
(conservative mapping: cannot force a continuation boundary from an empty open
turn). Reason text reflects that oracle path; hosts should treat it as a hard
refuse with writer released.
