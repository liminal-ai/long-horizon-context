# Story 5: Inference Host Routing

### Summary
<!-- Jira: Summary field -->

Wire LHC derivation calls through PI's model registry and auth, classify provider failures, and prove capture-to-derivation recorded outcomes.

### Description
<!-- Jira: Description field -->

**User Profile:** A developer using PI as their daily coding agent, with the `pi-lhc` extension loaded.

**Objective:** LHC derivations reach the user's existing PI logins through one host-supplied model-call function, and queued derivation work persists ready forms or classified failures against the thread.

**Scope In:**

- Inject one `ModelCall` function into the LHC instance at initialization.
- Resolve `(provider, model)` through PI's model registry and auth.
- Route different derivation kinds to different provider/model pairs.
- Classify provider errors into LHC failure kinds.
- Prove a captured thread's queued derivation work runs through LHC's scheduler and records outcomes.

**Scope Out:**

- Assignment config loading and startup validation; owned by Story 6.
- Derivation prompt and model dial-in quality tuning.
- Context serving.

**Dependencies:** Story 1 for initialized LHC instance. Story 2 for captured content used by AC-4.5.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-4.1:** The extension supplies one model-call function to the LHC instance at initialization. Given a (provider, model) pair and a system/user message list, the function resolves the pair through PI's model registry and auth and returns either the completion text or a classified failure.

**TC-4.1** — The model-call function resolves a (provider, model) pair through PI's registry and returns completion text for a single-turn message list.

**AC-4.2:** Different derivation kinds may route to different (provider, model) pairs within the same session. The function routes each call by its provided keys; LHC does not interpret the keys.

**TC-4.2** — Two derivation kinds assigned to different (provider, model) pairs both route correctly in one session.

**AC-4.3:** Provider errors map to LHC's failure classification: auth and invalid-request are terminal; rate-limit, timeout, and network are retryable. A thrown exception classifies as the generic `other` kind.

**TC-4.3** — Auth and invalid-request map to terminal; rate-limit, timeout, network map to retryable; a thrown exception maps to `other`.

**AC-4.4:** A call that resolves but produces no output is classified as `empty_output` by the LHC adapter. The host's function never returns `empty_output` itself — it returns text or a transport/auth failure.

**TC-4.4** — A resolved call with no output is classified `empty_output` by the adapter; the host function returns text-or-transport-failure only.

**AC-4.5:** A captured thread's background derivation work invokes the injected model-call function and records a result against the thread: a queued derivation runs through LHC's scheduler, calls the function, and persists either a ready derived form or a classified failure, queryable through inspect/health. This closes the loop end to end — capture to derivation to recorded outcome — not just the function in isolation.

**TC-4.5** — A captured thread with queued derivation work, drained through LHC's scheduler with the injected function wired, persists at least one ready derived form (function returns text) and one classified failure (function returns a failure), both queryable through inspect/health — proving the capture→derivation→recorded-outcome loop, not just the function in isolation.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 5 owns the host-supplied `ModelCall` function that lets LHC derivations use PI's existing model registry and auth. LHC passes provider/model keys and messages; the connector resolves those keys through PI and returns text or a classified failure.

The closed-loop proof is part of this story: a captured thread's queued derivation work must call the injected function and persist either a ready derived form or a classified failure.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- The runtime boundary and failure classification must match LHC's contract exactly.
- The closed-loop check depends on real background scheduler behavior and captured content, not only the pure function.

Risk Reminders:
- The host function never returns `empty_output`; that classification is produced by LHC's adapter.
- Different derivation kinds may route to different provider/model pairs in one run.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Model call host | `packages/pi-lhc/src/inference/model-call.ts` |
| Failure classification | `packages/pi-lhc/src/inference/model-call.ts` |
| Instance injection | `packages/pi-lhc/src/lifecycle/instance.ts` |
| Deterministic fakes | `packages/pi-lhc/test/fixtures/model-call.ts` |
| Tests | `packages/pi-lhc/test/inference/model-call.test.ts`, `packages/pi-lhc/test/inference/closed-loop.test.ts` |

#### Design References

- [epic.md §Flow 4](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/epic.md:195), lines 195-207
- [tech-design.md §External Contracts](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:102), lines 102-123
- [tech-design.md §Module Responsibility Matrix](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:193), lines 193-197
- [tech-design.md §Flow 4](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:357), lines 357-389
- [tech-design.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:535), lines 535-549
- [tech-design.md §Chunk 5](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:666), lines 666-668
- [test-plan.md §Inference Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:88), lines 88-102
- [test-plan.md §Chunk 5](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:175), lines 175-180

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-4.1 | `test/inference/model-call.test.ts` | Function resolves provider/model via PI registry and returns completion text for a single-turn message list. |
| TC-4.2 | `test/inference/model-call.test.ts` | Two derivation kinds route to different provider/model pairs in one run and both succeed. |
| TC-4.3 | `test/inference/model-call.test.ts` | Auth and invalid-request classify terminal; rate-limit, timeout, and network classify retryable; thrown exception maps to `other`. |
| TC-4.4 | `test/inference/model-call.test.ts` | Resolved no-output completion becomes `empty_output` at the LHC adapter; host function returns text or transport/auth failure only. |
| TC-4.5 | `test/inference/closed-loop.test.ts` | Captured thread's queued derivation invokes injected function and persists one ready form plus one classified failure queryable through inspect/health. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Adapter / Runtime Boundary | `test/inference/model-call.test.ts` | Each PI/pi-ai failure shape maps to the exact `ModelCallFailureKind`. | "Classified failure" can pass while individual runtime errors map to the wrong code. |
| Concurrency / Lost Update | `test/inference/closed-loop.test.ts` | A stale background derivation result does not clobber newer thread state. | Closed-loop success does not prove background scheduler stale-result safety. |

#### Technical Notes

- `createModelCall(ctx)` resolves with `ctx.modelRegistry.find(provider, model)` and completes through PI's completion API.
- Calls are single-turn: system/user messages only, no tools, streaming, or multi-turn local state.
- TC coverage uses deterministic fakes, so auth availability never skips tests.

#### Anti-Shim Requirements

- Do not maintain a second credential store or provider registry.
- Do not return placeholder text for failed derivations; return classified failures.
- Do not prove the loop with a direct function call only; the scheduler must invoke the injected function on captured content.

#### Production Path Proof

- Entrypoint: LHC background scheduler invokes the `ModelCall` supplied during `initLhc`.
- Registration/default path: `instance.ts` injects `createModelCall(ctx)` into LHC construction.
- Evidence: model-call tests assert routing/classification; closed-loop test drains scheduler and verifies persisted ready/failure outcomes.

#### Verification

- Targeted: `pnpm --filter pi-lhc verify -- test/inference/model-call.test.ts test/inference/closed-loop.test.ts`
- Story gate: `pnpm --filter pi-lhc green-verify`
- Epic gate: `pnpm --filter pi-lhc verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- All Flow 4 ACs and TCs pass.
- One `ModelCall` function is injected into LHC initialization.
- Provider/model routing goes through PI's registry and auth.
- Failure classification matches LHC's contract.
- The capture-to-derivation-to-recorded-outcome loop is proven with queryable results.
