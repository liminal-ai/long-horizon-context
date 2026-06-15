# Story 4: Chunk Derivation and Compact Recovery

### Summary
<!-- Jira: Summary field -->

Derive independent chunk summaries and make smart compact fall back to deterministic stored-member concatenation without provider calls.

### Description
<!-- Jira: Description field -->

**User Profile:** the harness/operator running long-horizon agentic work whose threads must keep serving coherent context even when background derivation lags, fails, or hits damaged sources.

**Objective:** instantiate recovery at chunk and compact level so compact produces usable band material with warnings and blocks only on canonical source corruption.

**Scope In:**
- Independent `chunk_summary_detailed` and `chunk_summary_brief` work items and states.
- Smart compact recovery through `turns.compactChunkMaterial`.
- Deterministic stored-member concatenation fallback with no model call.
- Compact warnings and stoppability.
- Compact fallback logging.
- Background chunk-summary requeue/wait behavior for not-ready member `lower_band_projection`.
- Thread-view calls turns surface, never turns internals.

**Scope Out:**
- pi-lhc rendering mechanics for warning buffers.
- Provider calls during smart compact.

**Dependencies:** Story 3.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-4.1:** A closed chunk's detailed and brief summaries are derived as two independent work items with independent states.

- **TC-4.1a:** Two independent items
  - Given: a chunk closes
  - When: its summaries are queued
  - Then: detailed and brief are separate work items
- **TC-4.1b:** Independent states
  - Given: detailed succeeds and brief fails
  - When: states are read
  - Then: detailed is `ready` and brief is `failed`, independently

**AC-4.2:** At compact, a chunk summary that is not ready (`pending` or `failed`) resolves through `turns.compactChunkMaterial` to a deterministic stored-member concatenation; compact makes no provider call and does not re-derive the summary.

- **TC-4.2a:** Compact uses concat, no provider call
  - Given: a compact needs a `failed` detailed summary, with a provider spy installed
  - When: compact runs
  - Then: the band entry is the deterministic stored-member concat and zero provider calls occur

**AC-4.3:** When a chunk summary still cannot be made ready, compact falls back to a deterministic concatenation of the chunk's member content (uncompressed) rather than leaving a gap.

- **TC-4.3a:** Concat fallback, no gap
  - Given: a chunk summary that is not ready at compact time
  - When: compact assembles the band
  - Then: the band entry is the deterministic concatenation of member content, and no span is missing

**AC-4.4:** Compact surfaces a visible warning for each fallback it performs; the user can see the cleanup/derivation work is delaying the compact and can stop it.

- **TC-4.4a:** Warning surfaced
  - Given: a compact performs a chunk-summary fallback
  - When: it runs
  - Then: a warning is emitted (visible channel) naming what fell back
- **TC-4.4b:** Stoppable
  - Given: a compact is performing its fallback assembly
  - When: the user requests stop
  - Then: compact halts without corrupting the thread

**AC-4.5:** A smart compact never fails because a derivation is missing or failed; it fails only when canonical source state needed for the compacted span is corrupt or unreadable.

- **TC-4.5a:** Missing derivation degrades
  - Given: multiple missing/failed chunk summaries
  - When: compact runs
  - Then: it completes with fallbacks, not a failure
- **TC-4.5b:** Source corruption blocks
  - Given: canonical source for a chunk's turns is corrupt
  - When: compact runs
  - Then: compact refuses with a corruption error rather than fabricating content

**AC-4.6:** Smart compact performs no provider calls at all; background chunk derivation performs no provider work inside a DB write transaction.

- **TC-4.6a:** Compact makes zero provider calls
  - Given: a compact over a thread with not-ready chunk summaries, provider spy installed
  - When: it runs
  - Then: zero provider calls occur during the entire compact

**AC-4.7:** Every compact-time fallback is logged with derivation type, subject id, reason, and the fallback used.

- **TC-4.7a:** Compact fallback logged
  - Given: a compact falls back to concatenation for a chunk
  - When: it completes
  - Then: a log entry records the chunk, derivation type, reason, and fallback

**AC-4.8:** Background chunk-summary derivation behaves differently from compact-time recovery when a member `lower_band_projection` is not ready: because no consumer is waiting, it **requeues and waits** for the input rather than concatenating or failing. It blocks (no progress) only on source corruption of a member; a not-ready member input degrades to a requeue, never a hole or a terminal failure.

- **TC-4.8a:** Background summary requeues on not-ready input
  - Given: a chunk summary derives in the background while a member `lower_band_projection` is `pending`
  - When: the worker runs
  - Then: the chunk summary work requeues (waits) rather than concatenating or landing `failed`
- **TC-4.8b:** Member source corruption surfaces
  - Given: a member turn's canonical source is corrupt
  - When: the background chunk summary attempts to derive
  - Then: it surfaces the source problem (does not silently loop or fabricate)

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 4 owns the chunk and compact recovery boundary. Background chunk-summary derivation waits for member `lower_band_projection` inputs because no consumer is waiting. Compact is a consumer path and never calls a provider; it asks the turns surface for ready summary material or deterministic stored-member concatenation.

Thread-view calls `turns.compactChunkMaterial(...)` and never imports `domains/turns/internal/*`. Compact logs and warns on fallback, can stop cleanly, and blocks only when canonical source material is corrupt.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- The story spans background worker wait behavior, thread-view compact assembly, public turns surface, source-corruption blocking, warning/stop behavior, and fallback logging.
- The compact no-provider invariant must be proven through the production compact path, not a helper.

Risk Reminders:
- Thread-view/turns boundary: thread-view must use the turns surface only.
- Degraded-state scoping: missing summaries degrade to concat; source corruption blocks.
- Active path/source path selection: compact must read stored member content for the compacted span.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Background chunk summary | `packages/lhc/src/domains/turns/internal/chunks.ts` |
| Turns public surface | `packages/lhc/src/domains/turns/index.ts` |
| Chunk fallback assembly | `packages/lhc/src/domains/turns/internal/chunk-recovery.ts` (NEW per tech design) |
| Compact snapshot | `packages/lhc/src/domains/thread-view/internal/snapshot.ts` |
| Readiness sweep dependency | `packages/lhc/src/domains/thread-view/internal/sweep.ts` |
| Boundary checks | `packages/lhc/scripts/check-boundaries.mjs` |
| Story tests | `packages/lhc/test/chunk-compact-recovery.test.ts` (planned) |

#### Design References

- [tech-design.md §Context](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:10), lines 10-27
- [tech-design.md §Module Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:61), lines 61-81
- [tech-design.md §DD-6](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:131), lines 131-138
- [tech-design.md §DD-7](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:140), lines 140-144
- [tech-design.md §Compact chunk material interface](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:226), lines 226-236
- [tech-design.md §Compact chunk material mechanics](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:283), lines 283-295
- [test-plan.md §Flow 4](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:83), lines 83-98
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:121), lines 121-135

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-4.1a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Chunk close queues detailed and brief summaries as separate work items. |
| TC-4.1b | `packages/lhc/test/chunk-compact-recovery.test.ts` | Detailed and brief summary states can diverge independently. |
| TC-4.2a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Failed detailed summary at compact returns stored-member concat through `compactChunkMaterial` and zero provider calls. |
| TC-4.3a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Unready summary yields deterministic concat band entry with no missing span. |
| TC-4.4a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Compact fallback emits visible warning naming what fell back. |
| TC-4.4b | `packages/lhc/test/chunk-compact-recovery.test.ts` | Stop request during fallback assembly halts without corrupting thread. |
| TC-4.5a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Multiple missing/failed summaries complete compact with concat fallbacks. |
| TC-4.5b | `packages/lhc/test/chunk-compact-recovery.test.ts` | Corrupt canonical source makes `compactChunkMaterial` return blocked and compact refuse with `state_corruption`. |
| TC-4.6a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Compact over not-ready summaries records zero provider calls for the entire compact. |
| TC-4.7a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Compact concat fallback writes log entry with chunk, derivation type, reason, and fallback. |
| TC-4.8a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Background chunk summary requeues with `member_projection_not_ready`, not concat/failed/provider failure. |
| TC-4.8b | `packages/lhc/test/chunk-compact-recovery.test.ts` | Member turn source corruption surfaces instead of looping or fabricating. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Compact makes no provider call | `packages/lhc/test/chunk-compact-recovery.test.ts` | `spyProvider` observes zero calls through full compact path with not-ready summaries. | Helper-level concat tests would not prove compact avoids provider work. |
| Thread-view boundary | `cd packages/lhc && pnpm run boundaries` | Boundary check fails if thread-view imports `domains/turns/internal/*`. | Functional tests can pass while the module boundary is violated. |
| Dependency-wait classification | `packages/lhc/test/chunk-compact-recovery.test.ts` | Not-ready member projection requeues with `member_projection_not_ready`. | A generic retry test can misclassify normal dependency waiting as provider failure. |
| Idempotent background wait | `packages/lhc/test/chunk-compact-recovery.test.ts` | Requeue-and-wait does not duplicate work items across retries. | Single-run checks do not prove retry stability. |
| Corruption blocks | `packages/lhc/test/chunk-compact-recovery.test.ts` | Canonical source corruption blocks compact while missing derivations degrade. | Fallback tests alone can accidentally fabricate corrupt source content. |

#### Technical Notes

- Compact never calls a model/provider. Not-ready chunk summaries compact through `turns.compactChunkMaterial(...)` to stored-member concat; healing is sweep plus background drain plus next compact.
- Background summary waits on not-ready member `lower_band_projection` and returns retryable reason `member_projection_not_ready`.
- `compactChunkMaterial(...)` returns `ready`, `concat`, or `blocked`; thread-view handles warning/logging/refusal based on that result.

#### Anti-Shim Requirements

- Do not import `domains/turns/internal/*` from thread-view.
- Do not call provider from compact or hide a provider call behind the turns surface.
- Do not satisfy fallback with placeholder text; concat must use stored member content.
- Do not classify member-projection waiting as provider failure.

#### Production Path Proof

- Entrypoint: smart compact through `domains/thread-view/internal/snapshot.ts`.
- Registration/default path: snapshot calls public `domains/turns/index.ts` `compactChunkMaterial(...)` for not-ready chunk summaries.
- Evidence: `packages/lhc/test/chunk-compact-recovery.test.ts` runs compact with `spyProvider` and `cd packages/lhc && pnpm run boundaries` proves thread-view uses the turns surface, never internals.

#### Verification

- Targeted: `cd packages/lhc && pnpm run test -- test/chunk-compact-recovery.test.ts`
- Story gate: `cd packages/lhc && pnpm run verify`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- AC-4.1 through AC-4.8 pass with their listed TCs.
- Smart compact makes zero provider calls.
- Compact uses `turns.compactChunkMaterial`; thread-view calls turns surface, never turns internals.
- Missing derivations degrade through stored-member concatenation; canonical source corruption blocks.
- Background chunk-summary derivation requeues on not-ready member `lower_band_projection`.
