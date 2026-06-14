# Story 4: Failure Classification

### Summary
<!-- Jira: Summary field -->

Classify model-call failures into Epic 02's retryable or terminal provider-result machinery without changing the queue.

### Description
<!-- Jira: Description field -->

**User Profile:** The operator needs model failures to appear as durable derivation state, not crashed drains or hidden transport errors.

**Objective:** Convert structured model-call failures and thrown host exceptions into the existing retry, exhaustion, and terminal-failure paths.

**Scope In:** Classification table, `safeCall`, timeout containment, thrown-exception containment, `ProviderResult` failure mapping, and tests proving Epic 02 machinery remains the owner of retries.

**Scope Out:** Assignment validation, prompt rendering, and real endpoint verification.

**Dependencies:** Stories 2 and 3 provide the model-call boundary and adapter call site.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-3.1**: Classification is a fixed table: `rate_limit`, `timeout`, `network`, `empty_output`, `other` → retryable; `auth`, `invalid_request` → terminal. The table is data, asserted directly.
- **AC-3.2**: Classified failures drive Epic 02's machinery unchanged: retryable failures back off and retry within budget; exhaustion → `failed` with reason `provider_failure`, attempts and last error in form metadata; terminal failures → `failed` on first attempt, no further calls for that item.
- **AC-3.3**: A thrown exception from the model-call function is caught, classified `other`, and the drain continues. No host function behavior can crash a drain.

**Test Conditions**

- **TC-3.1** (AC-3.1, AC-3.2): `inference-classification.test.ts`
  - table assertion: `FAILURE_CLASSIFICATION` matches AC-3.1 exactly as data
  - function returns `rate_limit` twice then succeeds; form lands `ready` and attempts are recorded
  - function returns `auth`; form lands `failed` immediately, exactly one call is made, stable reason is recorded
  - `network` failures exhaust; form lands `failed`, reason `provider_failure`, and `metadata.lastError` is preserved
- **TC-3.2** (AC-3.2, AC-3.3): `inference-classification.test.ts`
  - `throwingCall` on one kind during a multi-kind drain retries as `other`
  - all other items complete and the drain returns normally
  - exhaustion lands the thrown message as last error
  - `hangingCall` with `timeoutMs: 50` classifies as `timeout` and the drain continues

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story turns host and adapter failures into the existing Epic 02 provider-result failure path. It adds the fixed classification table and containment wrapper, then relies on the queue machinery that already owns retry budget, terminal failure, exhaustion, and metadata recording.

The adapter returns `retryable` and `reason`; it does not reimplement backoff, attempts, queue state, or repair reporting.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The classification table is small but must be asserted directly.
- Exception and timeout containment are easy to miss unless tests exercise a real rejecting or hanging host function.

Risk Reminders:
- Do not fork queue retry behavior.
- `empty_output` is adapter-generated but classified by the same table.
- Terminal failures must stop after one call.

#### Implementation Targets

| Area | Files / Modules |
|---|---|
| Classification | `src/inference/classify.ts` |
| Adapter failure mapping | `src/inference/adapter.ts` |
| Failure types | `src/inference/types.ts` |
| Fake failure fixtures | `test/fixtures/model-call.ts` |
| Story-owned tests | `test/inference-classification.test.ts` |

#### Design References

- [epic.md §Flow 3](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md:115), lines 115-132
- [epic.md §Data Contracts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md:236), line 236
- [tech-design.md §Design Decisions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:22), lines 22-25
- [tech-design.md §Module Responsibility Matrix](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:89), lines 89-101
- [tech-design.md §Flow 3](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:151), lines 151-167
- [tech-design.md §Interface Definitions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:252), lines 252-258
- [tech-design.md §Error Contract](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:289), lines 289-291
- [test-plan.md §TC-3.1 / TC-3.2](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:78), lines 78-89
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:168), lines 168-174
- [coverage.md §Story Shape Review](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/coverage.md:75), line 75

#### Test Mapping

| TC | Test File / Check | Test Description |
|---|---|---|
| TC-3.1 | `test/inference-classification.test.ts` | exact table assertion, retryable success-after-retry, terminal auth first-attempt failure, network exhaustion |
| TC-3.2 | `test/inference-classification.test.ts` | thrown exception classifies as `other`, drain continues, last error preserved, hanging call times out |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|---|---|---|---|
| Queue machinery quietly forked for inference | Epic 02 derivation suite exit gate plus `test/inference-classification.test.ts` | Proves adapter returns provider failures and queue behavior remains existing machinery | Direct classification tests alone could pass even if retries were reimplemented differently |
| Terminal failures accidentally retry | `test/inference-classification.test.ts` auth leg | Exactly one call is made for terminal failure | Final failed state alone would not reveal wasted retry budget |

#### Technical Notes

Relevant contracts:

```ts
export type ModelCallFailureKind =
  | "rate_limit" | "timeout" | "network" | "empty_output" | "other"
  | "auth" | "invalid_request";

export const FAILURE_CLASSIFICATION: Record<ModelCallFailureKind, { retryable: boolean }> = {
  rate_limit: { retryable: true },
  timeout: { retryable: true },
  network: { retryable: true },
  empty_output: { retryable: true },
  other: { retryable: true },
  auth: { retryable: false },
  invalid_request: { retryable: false },
};

export function safeCall(
  call: ModelCall,
  input: ModelCallInput,
  timeoutMs: number,
): Promise<ModelCallResult>;
```

Mapping to Epic 02:

| Model failure | Provider result | Queue behavior |
|---|---|---|
| retryable kind | `{ ok: false, retryable: true, reason: kind }` | backoff and retry within budget |
| retryable exhausted | existing failed-form path | `failed`, reason `provider_failure`, attempts and last error preserved |
| terminal kind | `{ ok: false, retryable: false, reason: kind }` | `failed` on first attempt |
| thrown exception | `other` retryable | drain continues |
| timeout race | `timeout` retryable | drain continues |

Queue machinery, drain state, repair report, and retry budgets are unchanged.

#### Anti-Shim Requirements

- Do not encode classification with scattered conditionals instead of the asserted table.
- Do not catch exceptions at a higher drain layer; containment belongs at the model-call wrapper.
- Do not add new queue states or retry paths for inference.

#### Production Path Proof

- Entrypoint: adapter calls the host `ModelCall` through `safeCall`.
- Registration/default path: adapter maps `ModelCallResult` failure into Epic 02 `ProviderResult` failure.
- Evidence: classification tests verify retryable, terminal, thrown, and timeout behavior through drained forms; Epic 02 derivation suites remain green.

#### Verification

- Targeted: `cd packages/lhc && pnpm exec vitest run test/inference-classification.test.ts`
- Story gate: `cd packages/lhc && pnpm run red-verify && pnpm exec vitest run test/inference-classification.test.ts`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- `FAILURE_CLASSIFICATION` exists as a directly asserted data table.
- `safeCall` catches thrown exceptions and applies the adapter-owned timeout.
- Adapter failure results map into Epic 02 `ProviderResult` failures without forking queue behavior.
- Retryable, terminal, exhaustion, thrown-exception, and timeout legs are covered.
- TC-3.1 and TC-3.2 are green, with Epic 02 derivation suites still green.
