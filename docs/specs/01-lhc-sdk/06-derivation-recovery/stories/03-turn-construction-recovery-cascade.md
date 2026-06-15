# Story 3: Turn Construction and Recovery Cascade

### Summary
<!-- Jira: Summary field -->

Resolve turn components through the recovery cascade, compose complete turns, log fallbacks, and write resolved outputs back safely.

### Description
<!-- Jira: Description field -->

**User Profile:** the harness/operator running long-horizon agentic work whose threads must keep serving coherent context even when background derivation lags, fails, or hits damaged sources.

**Objective:** instantiate the floor-and-recovery contract at turn construction so turns never block or omit spans because a derivation is pending or failed.

**Scope In:**
- Ready derivations used directly.
- Pending and failed derivations handled identically through recovery.
- Deterministic floor then original-source fallback, except tool results never fall below truncation.
- Non-derived components placed verbatim.
- Fallback logging.
- Recovery write-back to `ready` except when live work remains claimed or pending.
- Turn-construction recovery may call provider outside DB transaction.

**Scope Out:**
- Compact-time recovery, owned by Story 4.
- Logging storage implementation, owned by Story 0.

**Dependencies:** Stories 1 and 2.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-3.1:** When a component's derivation is `ready`, turn construction uses it directly.

- **TC-3.1a:** Ready component used
  - Given: a turn whose smoothed prompt is `ready`
  - When: the turn is constructed
  - Then: the smoothed prompt is used as-is

**AC-3.2:** When a component's derivation is not ready (`pending` or `failed`, treated identically), construction attempts recovery and then falls through deterministic floor → original, always landing a usable component.

- **TC-3.2a:** Pending recovers to floor
  - Given: a turn whose smoothed prompt is `pending` and re-derivation does not complete
  - When: the turn is constructed
  - Then: the deterministic-cleaned prompt is used and the turn still constructs
- **TC-3.2b:** Failed handled like pending
  - Given: a turn whose smoothed prompt is `failed`
  - When: the turn is constructed
  - Then: the same cascade runs (no separate failed handling) and a usable component results
- **TC-3.2c:** Floor unavailable → original
  - Given: a component whose deterministic floor cannot be produced
  - When: the turn is constructed
  - Then: the original source content is used

**AC-3.3:** A tool-result component never falls below its truncation floor during construction; it is never inserted raw/full as a fallback.

- **TC-3.3a:** Tool result floored to truncation
  - Given: a turn whose `tool_result_summary` is not ready
  - When: the turn is constructed
  - Then: the deterministic truncation is used, not the full raw result

**AC-3.4:** Non-derived components (assistant text, assistant thinking, runtime-change blocks) are placed verbatim in the constructed turn.

- **TC-3.4a:** Verbatim placement
  - Given: a turn with assistant text, thinking, and a runtime-change block
  - When: the turn is constructed
  - Then: those components appear unchanged and in order

**AC-3.5:** Turn construction never blocks on a derivation and never omits a component span; a not-ready derivation degrades, it does not stall or hole the turn.

- **TC-3.5a:** No block, no hole
  - Given: a turn with multiple not-ready derivations
  - When: the turn is constructed
  - Then: construction completes and every component is present as some rendering

**AC-3.6:** Every component that fell back during construction is logged with enough detail to act on it: derivation type, subject id, why it floored (not-ready vs failed-floor), and which floor was used.

- **TC-3.6a:** Fallback logged with detail
  - Given: a turn construction where a smoothed prompt fell to its deterministic floor
  - When: construction completes
  - Then: a log entry records the derivation type, subject id, reason, and floor used
- **TC-3.6b:** No fallback → no fallback log
  - Given: a turn where all derivations are ready
  - When: construction completes
  - Then: no fallback log entries are written for it

**AC-3.7:** Turn construction performs no provider work inside a DB write transaction.

- **TC-3.7a:** Provider work outside transaction
  - Given: turn construction attempts re-derivation of a not-ready component
  - When: it runs
  - Then: any provider call happens outside the write transaction that persists the turn

**AC-3.8:** When turn-construction recovery resolves a not-ready component — by re-derivation, deterministic floor, or original-source floor — the resolved content is written back to the component's derivation record as `ready`, **except when a work item is still claimed or pending for that derivation**, in which case the record is left untouched (the floor is used in the rendering, but the in-flight worker is allowed to produce the real result). Persisted recovery outcomes land plain `ready`; there is no "degraded" state and no floor-used marker (no upgrade process consumes such a marker). The fallback *event* is logged; the canonical subject and any `ready` output carry no marker. A tool result's floor is deterministic truncation, never the raw full result.

- **TC-3.8a:** Re-derivation lands ready
  - Given: a `failed` component that recovery re-derives successfully
  - When: construction completes
  - Then: the derivation record is `ready` with the re-derived content
- **TC-3.8b:** Floor recovery also lands ready
  - Given: a `pending` component that recovery cannot re-derive, resolved at its deterministic floor
  - When: construction completes
  - Then: the derivation record is `ready` with the floored content, carries no degraded marker, and the fallback event is logged
- **TC-3.8c:** Tool-result floor is truncation, never raw
  - Given: a tool-result component whose summary is not ready and cannot be re-derived
  - When: construction resolves it
  - Then: the floor written back is deterministic truncation, never the raw full result
- **TC-3.8d:** Write-back defers to live work
  - Given: a not-ready component that still has a claimed or pending work item
  - When: construction resolves it at the floor
  - Then: the floor is used in the rendering but the derivation record is left untouched (not overwritten), so the in-flight worker still produces the real `ready` result

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 3 turns the existing compose fallback behavior into durable recovery. `composeRenderingInput` resolves ready-or-floor parts and records gaps; `derive` logs each fallback and calls `recoverDerivation(...)` for recovered content. Persisted recovery lands plain `ready`; the fallback event is log-only.

Turn-construction recovery may call the provider, but the provider call sits outside any DB write transaction. `recoverDerivation(...)` is a dedicated version-checked short transaction and skips persistence when a live work item is pending or claimed, leaving the worker to produce the real result.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- This story combines consumption-time recovery, logging, source/derived state separation, write-back, and provider transaction boundaries.
- The race between floor write-back and live worker completion needs explicit red/green coverage.

Risk Reminders:
- Transition-state atomicity: recovered content writes `ready` only when source version matches and no live work exists.
- Concurrency/lost update: floor write must not clobber in-flight real derivation.
- Provider outside transaction: prove with a competing write during provider call.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Compose fallback receipts | `packages/lhc/src/domains/turns/internal/compose.ts` |
| Recovery write-back | `packages/lhc/src/domains/turns/internal/derive.ts`, `packages/lhc/src/domains/turns/internal/store.ts` |
| Recovery helper | `packages/lhc/src/domains/turns/internal/recovery.ts` (inferred target for `recoverDerivation`) |
| Logging calls | `packages/lhc/src/tech-utils/logging/index.ts` |
| Provider doubles | `packages/lhc/test/fixtures/provider-double.ts` |
| Story tests | `packages/lhc/test/turn-cascade.test.ts` (planned) |

#### Design References

- [tech-design.md §DD-4](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:113), lines 113-125
- [tech-design.md §DD-7](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:140), lines 140-144
- [tech-design.md §Recovery write-back](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:214), lines 214-224
- [tech-design.md §Cascade write-back mechanics](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:266), lines 266-281
- [tech-design.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:299), lines 299-309
- [test-plan.md §Flow 3](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:64), lines 64-81
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:121), lines 121-135

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-3.1a | `packages/lhc/test/turn-cascade.test.ts` | Ready smoothed prompt is used as-is in turn construction. |
| TC-3.2a | `packages/lhc/test/turn-cascade.test.ts` | Pending smoothed prompt recovers to deterministic floor and turn constructs. |
| TC-3.2b | `packages/lhc/test/turn-cascade.test.ts` | Failed smoothed prompt uses same cascade path as pending. |
| TC-3.2c | `packages/lhc/test/turn-cascade.test.ts` | Component with unavailable floor falls back to original source. |
| TC-3.3a | `packages/lhc/test/turn-cascade.test.ts` | Not-ready tool-result summary uses truncation, never raw full result. |
| TC-3.4a | `packages/lhc/test/turn-cascade.test.ts` | Assistant text, thinking, and runtime-change blocks render verbatim in order. |
| TC-3.5a | `packages/lhc/test/turn-cascade.test.ts` | Multiple not-ready derivations still produce a complete turn with every span present. |
| TC-3.6a | `packages/lhc/test/turn-cascade.test.ts` | Fallback log includes derivation type, subject id, reason, and floor used. |
| TC-3.6b | `packages/lhc/test/turn-cascade.test.ts` | All-ready turn construction writes no fallback logs. |
| TC-3.7a | `packages/lhc/test/turn-cascade.test.ts` | `probingProvider` competing write acquires lock while provider call is pending. |
| TC-3.8a | `packages/lhc/test/turn-cascade.test.ts` | Failed component re-derived successfully persists `ready` through `recoverDerivation`. |
| TC-3.8b | `packages/lhc/test/turn-cascade.test.ts` | Pending component resolved to floor persists `ready` with no degraded marker and logs fallback. |
| TC-3.8c | `packages/lhc/test/turn-cascade.test.ts` | Tool-result recovery writes truncation floor, never raw full result. |
| TC-3.8d | `packages/lhc/test/turn-cascade.test.ts` | Live claimed/pending work causes `recoverDerivation` to return `persisted:false`; worker later wins. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| No transaction across provider | `packages/lhc/test/turn-cascade.test.ts` | Competing SQLite write succeeds while provider call is pending. | A delayed provider test does not prove the DB lock was released. |
| Recovery write-back defers to live work | `packages/lhc/test/turn-cascade.test.ts` | Claimed work item exists, floor renders but does not persist, later worker completion persists real output. | Simple write-back tests miss the race with in-flight workers. |
| Stale recovery discarded | `packages/lhc/test/turn-cascade.test.ts` | Version-bump variant proves `recoverDerivation` refuses stale source version. | AC happy paths can pass while stale writes remain possible. |
| Source/derived separation | `packages/lhc/test/turn-cascade.test.ts` | Canonical subject has no fallback marker; recovered ready output has no floor marker. | Log presence alone does not prove subject cleanliness. |

#### Technical Notes

- `recoverDerivation(...)` is not `complete()` and requires no `ClaimedWorkItem`.
- It writes in one short `BEGIN IMMEDIATE`, version-checks source, and checks for live pending/claimed work.
- Tool-result floor remains deterministic truncation; raw full tool output is never a fallback rendering.
- Use Story 0 logging surface; do not create a turn-local diagnostics table.

#### Anti-Shim Requirements

- Do not mark derivations `ready` before checking live pending/claimed work.
- Do not hold a transaction open across provider calls.
- Do not encode floor provenance on the canonical subject or ready derivation content.
- Do not make failed and pending derivations take separate recovery logic.

#### Production Path Proof

- Entrypoint: turn close invokes turn derivation and composition through `domains/turns`.
- Registration/default path: existing work-queue turn handlers call compose/derive; recovery runs in the same production handler path, not a test-only helper.
- Evidence: `packages/lhc/test/turn-cascade.test.ts` exercises the production compose/derive path with real storage and provider doubles.

#### Verification

- Targeted: `cd packages/lhc && pnpm run test -- test/turn-cascade.test.ts`
- Story gate: `cd packages/lhc && pnpm run verify`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- AC-3.1 through AC-3.8 pass with their listed TCs.
- Pending and failed derivations share one recovery path.
- Turn-construction recovery provider calls, when used, occur outside DB write transactions.
- Fallback logs include derivation type, subject id, reason, and floor used.
- Tool-result fallback writes truncation, never raw full result.
