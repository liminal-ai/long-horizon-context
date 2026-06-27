# Workqueue Drain Parallelization Research

Date: 2026-06-27

## Problem Statement

LHC's durable work queue currently drains one item at a time per thread. That is correct but too slow for tool-heavy threads where many queued message derivations require inference. The current head-first drain can stay behind when intake produces prompt smoothing and tool-result work faster than one inference call can finish.

The safe target is not an unordered worker pool. The queue encodes dependency and ordering constraints: message derivations feed turn derivation, turn derivation places turns into chunks, closed chunks enqueue detailed and brief chunk summaries, and stale completions are fenced by source version. The useful first step is a parallel run-length batch drain: claim only the oldest compatible prefix of eligible work, run that prefix with bounded concurrency, complete each item through the existing fenced completion path, then re-read the queue.

## Required Reading Done

- Onboarding: `docs/onboard/01-core-concepts.md`, `docs/onboard/02-domain-design.md`.
- Bad code log: `docs/bad-code-log.md`.
- Queue/drain code and tests: files listed below.
- External references:
  - AWS SQS FIFO message groups: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html
  - AWS SQS visibility timeout: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html
  - Google Cloud Tasks queue rate limits and retry config: https://cloud.google.com/tasks/docs/configuring-queues
  - Temporal retry policy docs: https://docs.temporal.io/encyclopedia/retry-policies
  - BullMQ worker concurrency docs: https://docs.bullmq.io/guide/workers/concurrency

The external systems converge on the same mechanics this repo already uses: durable claims/leases, bounded concurrency, ordered groups for dependency boundaries, retry budgets, backoff, and explicit rate/concurrency caps.

## Current Architecture

Durable state is per thread in SQLite. The schema creates `work_item` with `status`, `attempts`, `last_error`, `claimed_at`, `claim_expires_at`, `eligible_at`, `payload`, and `claim_epoch`; derivation state lives in `derivation` keyed by `(subject_kind, subject_id, derivation_type)` with `source_version` fencing ([packages/lhc/src/threads/internal/create.ts:61](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/threads/internal/create.ts:61)).

Work enqueue is transactional. `enqueue` writes the work row, creates or resets target derivations to `pending`, and registers a post-commit scheduler poke ([packages/lhc/src/shared-tech/work-queue/index.ts:137](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/work-queue/index.ts:137)). Work ids are deterministic and version-scoped: `w-<sourceId>-<kind>-v<sourceVersion>` ([packages/lhc/src/shared-tech/work-queue/index.ts:89](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/work-queue/index.ts:89)).

The current drain loop is `drainOpenDb`. It calls `claimNext`, dispatches one handler, then records success, retry, terminal failure, stale discard, or lost lease before claiming the next item ([packages/lhc/src/shared-tech/scheduler.ts:93](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/scheduler.ts:93)). It runs handlers without an open transaction and uses short transactions for claim/retry/complete.

`claimNext` is intentionally head-first. It only considers the oldest live row; a live claimed head returns `in_flight`, and a backing-off queued head returns `waiting` ([packages/lhc/src/shared-tech/work-queue/index.ts:424](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/work-queue/index.ts:424)). This is the core ordering constraint and the source of current head-of-line delay.

The scheduler is per-thread single-flight with a pending flag and one wake timer for retry eligibility or claim expiry ([packages/lhc/src/shared-tech/scheduler.ts:1](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/scheduler.ts:1)). `initLhc` wires config defaults, dispatchers, background/manual mode, `work.drain`, and `drainSettled` ([packages/lhc/src/sdk.ts:519](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/sdk.ts:519), [packages/lhc/src/sdk.ts:628](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/sdk.ts:628)).

Retry defaults are `budget: 3`, `backoffBaseMs: 5000`, `backoffCapMs: 60000`; lease default is `durationMs: 120000` ([packages/lhc/src/sdk.ts:523](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/sdk.ts:523)). The retry budget should remain 3 unless real dial-in evidence says otherwise.

## Work Kinds And Data Flow

- `prompt_smoothing`: message-owned, inference-backed unless guard logic uses the cleaned prompt directly. Handler: [packages/lhc/src/messages/internal/handlers.ts:115](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/messages/internal/handlers.ts:115).
- `tool_result_summary`: message-owned, deterministic pass-through for small tool results, inference-backed for larger ones. Handler: [packages/lhc/src/messages/internal/handlers.ts:145](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/messages/internal/handlers.ts:145).
- `turn_derivation`: turn-owned. It reads member messages and message derivations, opportunistically recovers missing message derivations, composes `turn_rendering`, calls `compressSmoothTurn` when needed, writes both turn derivations, places the turn into chunks, and may enqueue chunk summaries ([packages/lhc/src/turns/internal/derive.ts:179](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/turns/internal/derive.ts:179), [packages/lhc/src/turns/internal/derive.ts:197](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/turns/internal/derive.ts:197)).
- `chunk_summary_detailed`: deterministic, consumes member turn compressions and may return a retryable member-not-ready reason when dependencies are not ready ([packages/lhc/src/turns/internal/derive.ts:330](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/turns/internal/derive.ts:330)).
- `chunk_summary_brief`: inference-backed, consumes the detailed chunk derivation. If detailed is missing/pending it defers by deleting the claimed brief item and enqueueing detailed then brief at the same source version ([packages/lhc/src/turns/internal/derive.ts:401](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/turns/internal/derive.ts:401)).

The PI connector supplies model calls through provider/model assignments and PI's model registry. LHC does not currently know "Claude Code session" as a first-class backend type; PI resolves provider/model and calls `pi-ai` ([packages/pi-lhc/src/inference/model-call.ts:105](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/inference/model-call.ts:105)).

## What Must Remain Serial

- Queue head classification must remain serial. If the oldest live row is unexpired claimed or still backing off, the drain must stop or arm a wake. Do not skip around another process' live claim.
- `turn_derivation` completion must remain serial in v1 because `onApplied` calls `placeTurn`, and chunk placement depends on completion order. Parallel turn completions can create chunk membership in completion order instead of turn order.
- `chunk_summary_brief` must not run in the same batch as its same-chunk `chunk_summary_detailed` unless detailed is already ready before claim.
- Claimed expired rows should be reclaimed one at a time in v1. A previously claimed row may still have a late worker, and current lost-lease tests depend on exact ownership fencing.
- Completion writes must keep `claim_epoch` and `source_version` checks. Late old-version work must continue to return `stale_discarded` or `lost_lease`, not overwrite current derivations.
- Background scheduling should remain one drain loop per thread. Parallelism should happen inside that drain loop, not by allowing multiple schedulers to drain the same thread.

## Proposed Pattern

Add a `claimCompatibleBatch` path beside `claimNext`.

Behavior:

1. Start at the oldest live row, under `BEGIN IMMEDIATE`.
2. If the head is `claimed` with a live lease, return `in_flight`.
3. If the head is `queued` but `eligible_at` is in the future, return `waiting`.
4. If the head is expired claimed, reclaim exactly that one row.
5. If the head is queued and eligible, classify its compatibility group and scan forward in row order.
6. Claim only the longest eligible queued prefix that is compatible with the head group, capped by `maxParallelItems` and `maxBatchItems`.
7. Stop scanning at the first claimed row, backing-off row, unknown kind, serial kind, dependency barrier, or incompatible kind.
8. Run the claimed batch concurrently with a limiter.
9. Complete each item through the existing dispatcher and completion helpers.
10. Append report entries in queue claim order, then re-read the queue for the next batch.

Initial compatibility groups:

| Group | Kinds | Parallel in v1 | Rule |
| --- | --- | --- | --- |
| `message_derivation` | `prompt_smoothing`, `tool_result_summary` | Yes | Different message/version targets are independent. This is the highest-impact group. |
| `turn_derivation` | `turn_derivation` | No | Serial barrier because completion places turns into chunks. |
| `chunk_detailed` | `chunk_summary_detailed` | Optional v1.1 | Safe across different chunks only when member turn compressions are already terminal enough for the handler to finish. |
| `chunk_brief` | `chunk_summary_brief` | Optional v1.1 | Safe across different chunks only when same-chunk detailed is ready before claim. |
| `unknown` | unregistered kinds | No | Keep existing terminal failure behavior one at a time. |

Recommended first implementation: parallelize only `message_derivation`; keep all other groups serial. This directly targets the current pressure source: many queued messages requiring inference. It avoids changing turn placement, chunk dependency recovery, and brief deferral semantics in the first slice.

Do not implement continuous slot refill in v1. Claim one compatible wave, wait for that wave, then claim the next. Continuous refill is possible later, but it requires the selector to scan past rows already claimed by this same drain while still stopping on claims owned by other drains. The wave model is simpler, preserves current head-gating semantics, and still turns N independent inference calls from serial latency into roughly `ceil(N / maxParallelItems)` waves.

## Config Knobs

Add config under `SdkConfig` and `ResolvedSdkConfig`:

```ts
drain?: {
  maxParallelItems?: number; // default 1 in core LHC at first, PI may opt in
  maxBatchItems?: number; // default same as maxParallelItems
};
inferenceConcurrency?: {
  maxParallelCalls?: number; // default equals drain.maxParallelItems
  perProvider?: Record<string, number>;
  perBackend?: Record<string, number>;
  claudeCodeMaxSessions?: number; // default 5
};
```

Validation:

- All values positive integers.
- `maxBatchItems >= maxParallelItems` is not required; effective batch size is `min(maxBatchItems, maxParallelItems)`.
- `claudeCodeMaxSessions` must be `<= 5` unless the caller explicitly overrides with a clearly named escape hatch. The default should be 5 as a hard cap, not as a target worker count.
- If a call has no backend/provider label, apply `maxParallelCalls` only.

Default recommendation:

- Core LHC default: `drain.maxParallelItems = 1` for one release to preserve behavior unless a host opts in.
- PI connector default after dogfooding: `drain.maxParallelItems = 4`, `inferenceConcurrency.maxParallelCalls = 4`, `claudeCodeMaxSessions = 5`.
- Never allow Claude Code-labelled calls above 5 concurrent sessions by default. Five is the right hard cap from the stated operational constraint; four is a safer default active concurrency because it leaves one slot for user-visible foreground work or another thread.

Backend classification:

- For `inference` assignment mode, the adapter can derive a concurrency key from assignment provider/model/prompt. Add an internal helper such as `concurrencyKeyForAssignment(kind, assignment)`.
- For direct `inferenceCallbacks`, LHC cannot infer backend. Either direct callbacks accept the global cap only, or a future optional callback wrapper supplies `backendKey`.
- PI-lHC should map provider/model lanes that launch Claude Code to `backend = "claude-code"` before calling into the limiter. Current PI-lHC model-call code does provider/model routing but no backend/session cap.

## Failure Handling And Retry Semantics

Keep the existing retry contract:

- A retryable failure increments attempts and requeues the item with exponential backoff.
- `attempts < retry.budget` retries; budget exhaustion writes terminal `failed`.
- `blocked` writes terminal `blocked`.
- `stale_discarded` remains success-disposition cleanup for old source versions.
- `lost_lease` remains non-terminal report evidence that this worker no longer owns the row.

Batch-specific rules:

- One item failing must not cancel sibling items in the batch.
- A retryable failure in one item should not stop already claimed siblings. After the wave completes, the next queue read will see the failed item back at the head with `eligible_at`; current `waiting` behavior then gates later work.
- If the process dies with multiple claimed rows, restart recovery reclaims them one by one or in a later eligible batch after lease expiry. This preserves current lease semantics.
- `maxItems` should count completed item attempts, not claimed rows. For deterministic reporting, if `maxItems` is set below `maxParallelItems`, effective parallelism for that drain call should be capped to remaining `maxItems`.

## Observability

Existing `DrainReport` has `ran`, `stoppedBecause`, `waitingUntil`, `claimExpiresAt`, and `remaining` ([packages/lhc/src/shared-tech/scheduler.ts:42](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/scheduler.ts:42)). Extend it minimally:

```ts
interface DrainReport {
  batches?: Array<{
    compatibility: "message_derivation" | "turn_derivation" | "chunk_detailed" | "chunk_brief" | "single";
    claimed: number;
    maxParallelItems: number;
    startedAt: string;
    finishedAt: string;
  }>;
  peakInFlight?: number;
  capWaits?: Array<{ key: string; waitedMs: number }>;
}
```

Add warning/error log entries only for unusual conditions:

- batch selector sees a corrupt payload;
- a per-backend cap delays work longer than a threshold;
- a batch item reports `lost_lease`;
- a wave finishes with mixed terminal and retry outcomes.

Do not turn queue inspection into a domain surface. The bad code log calls out raw queue detail on message surfaces as a known design problem.

## Detailed Implementation Plan

1. Add config types and validation.
   - Edit [packages/lhc/src/shared-tech/derivation.ts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/derivation.ts) to add `drain` and `inferenceConcurrency` config shapes.
   - Edit [packages/lhc/src/sdk.ts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/sdk.ts:519) to resolve defaults and validate positive integer caps.

2. Add queue batch claim mechanics.
   - In [packages/lhc/src/shared-tech/work-queue/index.ts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/work-queue/index.ts:424), keep `claimNext` for serial tests and manual compatibility.
   - Add `claimCompatibleBatch(db, now, leaseDurationMs, opts)` returning `claimed | empty | in_flight | waiting`.
   - Reuse `toClaimedItem`, `parseWorkPayload`, source-version payloads, and `claim_epoch`.
   - Claim by selected `work_item_id`s in one `BEGIN IMMEDIATE` transaction with `status = 'queued'` guards. Do not claim rows after the first barrier.
   - For v1, `message_derivation` is the only multi-item class. All other claimable heads return a one-item batch.

3. Add a small compatibility classifier.
   - Put it in `shared-tech/work-queue` or a sibling `drain-compatibility.ts`.
   - Inputs: raw row metadata plus parsed payload.
   - Output: `message_derivation`, `single`, or `barrier`.
   - Rules must be data-based, not handler-based. No domain reads in the selector for v1.

4. Refactor drain item execution.
   - Extract the body of one item from `drainOpenDb` into `runClaimedItem(db, deps, item, identity): Promise<DrainReport["ran"][number]>`.
   - Preserve exact existing handling for unknown kind, missing operation, thrown handler, blocked, retryable, terminal, stale, and lost lease.
   - Keep report entry creation centralized.

5. Implement wave-based parallel `drainOpenDb`.
   - In [packages/lhc/src/shared-tech/scheduler.ts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/scheduler.ts:93), call `claimCompatibleBatch` when `resolved.drain.maxParallelItems > 1`; otherwise keep `claimNext`.
   - For a multi-item batch, run items through a simple promise pool capped by `maxParallelItems`.
   - Sort report entries by batch claim order before appending to `ran`.
   - If any item requeues with backoff, finish the wave, then re-read queue; the backing-off head will return `waiting`.

6. Use per-item DB handles or prove shared-handle safety.
   - Preferred: each parallel item opens its own thread DB handle through `deps.openThreadDatabase(identity.filePath)` and closes it after completion.
   - Keep the claim selector on the drain's primary handle.
   - Completion transactions will serialize through SQLite write locks; no transaction is held during inference.

7. Add inference concurrency limiter.
   - Add a small limiter in `shared-tech`, owned by SDK construction, not by domains.
   - Wrap `InferenceCallbacks` at init time so handlers do not learn about caps.
   - For assignment-backed callbacks, limit by global key and provider/backend key.
   - For direct callbacks, limit by global key only unless the caller supplies metadata later.

8. PI-lHC backend caps.
   - In [packages/pi-lhc/src/inference/model-call.ts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/inference/model-call.ts:105), add host-side classification for lanes that spawn Claude Code sessions, or pass provider/model keys to LHC's limiter.
   - Ensure Claude Code-labelled calls cannot exceed 5 concurrent sessions by default.

9. Scheduler behavior.
   - Keep per-thread single-flight in [packages/lhc/src/shared-tech/scheduler.ts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/scheduler.ts:284).
   - `drainSettled` must wait for all items in the active wave plus any wake timer.
   - `testPassCount` should count drain passes, not items.

10. Documentation.
   - Update onboarding language after implementation because it currently states "Items are processed one at a time per thread" in `docs/onboard/02-domain-design.md`.
   - Update Story 1 notes only after tests prove the new contract.

## Alternatives Considered

- Multiple independent drain processes per thread: higher risk. SQLite leases prevent double ownership, but unordered skip-ahead would violate the current head-first contract and dependency barriers.
- Worker pool over all queued rows: not appropriate. It would need a full dependency graph and would conflict with turn placement ordering.
- Parallelize `turn_derivation` immediately: tempting because turn compression can be expensive, but unsafe while completion performs chunk placement.
- Continuous slot refill in v1: useful later, but it complicates the selector because it must scan past rows owned by the same drain while stopping on rows owned by another drain.
- Move dependency logic into queue rows: larger schema and enqueue-surface change. Not needed for first value slice.
- Retry count increase: does not address lag. Keep default 3.

## Test Plan

Unit tests:

- `claimCompatibleBatch` claims a prefix of `prompt_smoothing` and `tool_result_summary` rows up to cap.
- It stops at `turn_derivation`, backing-off rows, live claimed rows, unknown kind, and incompatible source duplicates.
- It returns `waiting` and `in_flight` with the same fields as `claimNext`.
- Config validation rejects non-integers, zero, negative caps, and bad Claude Code caps.

SDK-flow tests:

- Three message derivations with delayed callbacks run concurrently; captured start times overlap; report order remains queue order.
- A batch `message, message, turn_derivation` runs the two messages in parallel, then the turn serially after they finish.
- `maxItems: 1` with `maxParallelItems: 4` runs one item and leaves the rest live.
- One retryable failure in a parallel message wave requeues that item and does not cancel sibling success; next read stops at `waiting`.
- A terminal failure in one wave item writes only that derivation failed; sibling derivations land ready.
- Background mode `drainSettled` waits for all parallel items and retry wakes.

Regression tests:

- Existing head-gates-queue test still passes when the head is backing off.
- Existing lost-lease tests still pass when a stale older claim completes after a newer reclaim.
- Existing stale source-version tests still pass during message edit/delete.
- Existing chunk brief deferral tests still pass.
- Existing turn placement/chunk membership tests still pass with `maxParallelItems > 1`.

Stress/concurrency cases:

- 50 prompt/tool-result message derivations with mixed delays and failures drain to the same final derivation states as serial mode.
- Process kill after a batch claim and before completion leaves multiple claimed rows; after lease expiry, restart drains without duplicated ready writes.
- Two manual drains from separate SDK instances: first claims a message batch; second sees the claimed head and reports `in_flight`.
- Two different thread drains run concurrently but obey global and backend caps.
- Claude Code-labelled model calls never exceed 5 active calls; recommended active default is 4.

## Migration And Rollout

No storage migration is required for v1. Existing `work_item` fields already carry status, claim epoch, lease expiry, attempts, source version payload, and derivation targets.

Rollout sequence:

1. Land batch claim and parallel drain behind default `maxParallelItems = 1`.
2. Run the full LHC suite with default serial behavior.
3. Add targeted tests with `maxParallelItems = 4`.
4. Dogfood PI-lHC with `maxParallelItems = 2`, then `4`.
5. Keep `turn_derivation` serial until a separate design splits inference work from ordered placement.
6. After real usage confirms stability, decide whether core LHC default stays 1 or moves to a conservative value.

Risk analysis:

- Highest correctness risk: turn placement if turn work is parallelized too early. Mitigation: serial barrier.
- Highest operational risk: backend/session overrun. Mitigation: global and per-backend limiter, Claude Code cap 5.
- Highest test risk: tests that assume report order equals completion order. Mitigation: report in claim order.
- Highest performance risk: wave-based batching underuses slots when one item is slow. Mitigation: accept for v1; evaluate continuous refill after safe batching lands.

## Open Questions

- Which PI provider/model lanes actually spawn Claude Code sessions, and can PI-lHC label them reliably?
- Should PI-lHC opt into `maxParallelItems = 4` by default while core LHC stays serial?
- Should `DrainReport` expose batch observability publicly, or should it remain test/internal until behavior settles?
- Is per-item DB handle overhead acceptable on macOS SQLite under 4 to 5 concurrent inference calls? Validate with a 50-message stress test.
- Should chunk detailed/brief parallelism be enabled in v1.1 after message batching, or is most pressure solved by message derivations alone?
