# Story 5: Real-Inference Suite and Capstone

### Summary
<!-- Jira: Summary field -->

Add the opt-in OpenRouter-backed suite with visible ran/not-ran accounting and the real-adapter lifecycle capstone.

### Description
<!-- Jira: Description field -->

**User Profile:** The operator needs proof that the inference seam works against a real model while CI remains network-free by default.

**Objective:** Verify all seven derivation kinds and the Epic 04 lifecycle sequence through a real endpoint when keyed, with explicit not-ran accounting when unkeyed.

**Scope In:** Test-owned OpenRouter `ModelCall`, suite guard, ran/not-ran output, seven real round-trips, shared seam-conformance assertions, and lifecycle capstone structural checks.

**Scope Out:** Prompt quality evaluation, model/prompt dial-in, PI extension wiring, and the full integrated harness.

**Dependencies:** Stories 2-4 provide the seam, adapter, prompts, provenance, and failure classification.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-4.1**: The real-inference suite is opt-in on key presence and its outcome is always visible: ran (with the model assignments used) or not-ran (with reason) in the suite output. Absence of the key can never produce a silent pass. The suite's model-call function lives in test code, implements the AC-1.2 contract, and reaches a real endpoint.
- **AC-4.2**: The capstone: the Epic 04 lifecycle sequence with the real adapter completes with every derivation kind landing `ready` at least once — non-empty content, no deterministic-marker strings, provenance naming the real model — and the deterministic leg's checkpoint-coherence assertions hold structurally (cleared-then-ready around mutations; second compact reflects post-edit content).

**Test Conditions**

- **TC-4.1** (AC-4.1): `inference-real.test.ts`
  - with `LHC_OPENROUTER_KEY`, each of the seven kinds round-trips real inference once
  - each result lands `ready`, has non-empty content, and contains no deterministic marker pattern
  - with the key absent in a controlled leg, the suite emits a not-ran record with reason
  - the not-ran record is distinguishable from a pass
  - the suite-level guard emits exactly one ran/not-ran line into run output
- **TC-4.2** (AC-4.2): `inference-real.test.ts`
  - run Epic 04's lifecycle sequence against the real adapter: intake, drain, compact, pull, inspect, edit, rebuild, drain, compact, materialize
  - every form kind appears `ready` at least once
  - no deterministic marker pattern appears anywhere
  - provenance names the real model
  - mutation-cleared forms regenerate with content different from pre-edit content
  - second compact's view reflects post-edit content
  - health is coherent at each checkpoint
- **TC-4.3** (AC-1.2, AC-4.1): `inference-real.test.ts`
  - `assertModelCallContract(openRouterCall)` runs against the real host function
  - `assertRoutingThroughSdk(openRouterCall, realAssignments)` runs the same routing helper used by Story 2's fake-host seam test, unchanged

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story proves the same `ModelCall` seam against a real endpoint without making CI depend on network credentials. The OpenRouter function is test-owned host code, not production LHC transport code, and exists to prove that the injected-function contract is sufficient.

The capstone reuses the Epic 04 lifecycle sequence with real-adapter structural assertions: ready forms, non-marker content, real-model provenance, mutation regeneration, and coherent checkpoints.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- The story has an external endpoint, auth-gated execution, visible accounting, and a capstone path spanning intake, drain, compact, mutation, rebuild, and materialization.
- The not-ran path is as important as the keyed path because silent pass is the failure mode.

Risk Reminders:
- CI-default run must make zero network calls.
- The suite guard must report one visible ran/not-ran fact.
- Keyed run evidence must be recorded in story completion notes.

#### Implementation Targets

| Area | Files / Modules |
|---|---|
| Real host fixture | `test/fixtures/openrouter-call.ts` |
| Shared seam helpers | `test/fixtures/seam-conformance.ts` |
| Real suite | `test/inference-real.test.ts` |
| Verify accounting | `packages/lhc/package.json` scripts |
| Lifecycle fixtures | existing Epic 04 lifecycle test helpers |

#### Design References

- [epic.md §Flow 4](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md:134), lines 134-149
- [epic.md §Non-Functional Requirements](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md:240), lines 240-246
- [tech-design.md §Design Decisions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:32), line 32
- [tech-design.md §Flow 4](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:169), lines 169-173
- [tech-design.md §Runtime Prerequisites](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:293), lines 293-301
- [tech-design.md §Testing Strategy](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:303), lines 303-309
- [test-plan.md §Fixture Contracts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:34), lines 34-36
- [test-plan.md §TC-4.1 / TC-4.2 / TC-4.3](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:91), lines 91-104
- [test-plan.md §Story-completion accounting](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:166), line 166
- [coverage.md §Story Shape Review](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/coverage.md:76), line 76

#### Test Mapping

| TC | Test File / Check | Test Description |
|---|---|---|
| TC-4.1 | `test/inference-real.test.ts` | keyed seven-kind real round-trips; unkeyed not-ran record; exactly one suite-level ran/not-ran output line |
| TC-4.2 | `test/inference-real.test.ts` | Epic 04 lifecycle sequence under real adapter with structural checkpoint assertions |
| TC-4.3 | `test/inference-real.test.ts` | OpenRouter host passes shared `ModelCall` contract and SDK routing helpers |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|---|---|---|---|
| Silent real-suite skip | `test/inference-real.test.ts` unkeyed guard leg | Not-ran record has reason and cannot look like pass | A skipped keyed suite could leave default CI green without proving anything |
| Fixture does not represent host boundary | `test/fixtures/seam-conformance.ts` helpers | Same contract/routing helpers run against fake and real host functions | A direct OpenRouter call could pass while violating the SDK boundary shape |
| Capstone only checks one derivation | lifecycle structural assertions | Every form kind reaches ready at least once with real provenance | A single ready result would not prove the whole derivation catalog works |

#### Technical Notes

Relevant contract:

```ts
export type ModelCall = (input: {
  provider: string;
  model: string;
  messages: { role: "system" | "user"; content: string }[];
}) => Promise<
  | { ok: true; text: string }
  | { ok: false; kind: ModelCallFailureKind; message: string }
>;
```

Runtime prerequisites:

| Prerequisite | Where | Verification |
|---|---|---|
| `LHC_OPENROUTER_KEY` | opt-in suite only | suite reports ran or not-ran |
| `LHC_OPENROUTER_MODEL` | opt-in suite optional | fixture default used when unset |
| native `fetch` | test fixture | Node runtime already provides it |

Real-suite fixtures:

| Fixture | Responsibility |
|---|---|
| `test/fixtures/openrouter-call.ts` | `createOpenRouterCall(key, defaultModel)` implements `ModelCall` over OpenRouter using plain `fetch` |
| `resolveRealSuiteEnv()` | returns `{ key, model }` or `{ notRan: reason }` |
| `test/fixtures/seam-conformance.ts` | shared `assertModelCallContract` and `assertRoutingThroughSdk` helpers |

OpenRouter failure mapping:

| Source | Failure kind |
|---|---|
| HTTP 401/403 | `auth` |
| HTTP 429 | `rate_limit` |
| HTTP 400 | `invalid_request` |
| network error | `network` |
| other non-success | `other` |

The CI-default suite makes zero network calls. The keyed run is recorded in story completion notes with date, model, and pass state.

#### Runtime Contract Assumptions

- `LHC_OPENROUTER_KEY` controls keyed execution.
- `LHC_OPENROUTER_MODEL` may select the cheap model; fixture default applies when unset.
- OpenRouter provider/model interpretation is host-side and still returns the AC-1.2 `ModelCallResult` shape.

#### Anti-Shim Requirements

- Do not use deterministic provider output in the real-suite ready assertions.
- Do not hide missing key with test skip semantics indistinguishable from pass.
- Do not mock `fetch` in the keyed leg; the point is real endpoint proof.
- Do not assert output quality; assert structure, non-marker content, provenance, and checkpoint coherence.

#### Production Path Proof

- Entrypoint: `test/inference-real.test.ts` constructs SDK with a real host `ModelCall`.
- Registration/default path: env-gated suite in default runner reports ran/not-ran; keyed execution reaches OpenRouter through plain `fetch`.
- Evidence: keyed seven-kind round-trips, shared seam-conformance helpers, and real-adapter lifecycle capstone.

#### Verification

- Targeted: `cd packages/lhc && pnpm exec vitest run test/inference-real.test.ts`
- Story gate: `cd packages/lhc && pnpm run red-verify && pnpm exec vitest run test/inference-real.test.ts`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- OpenRouter-backed test `ModelCall` fixture exists and conforms to AC-1.2.
- Suite guard emits exactly one visible ran/not-ran record and unkeyed absence cannot look like a pass.
- Keyed seven-kind real round-trip passes with non-empty, non-marker ready forms and real-model provenance.
- Real-adapter lifecycle capstone passes structural checkpoint assertions.
- TC-4.1, TC-4.2, and TC-4.3 are green in the keyed local run; unkeyed not-ran accounting is green in default CI.
- Story completion notes record keyed run date, model, and pass state.
