# Story 6: Verification — All-Derivation Smoke Run

### Summary
<!-- Jira: Summary field -->

Verify the new derivation pipeline works across all derivation types, prompts, defaults, and production methods.

### Description
<!-- Jira: Description field -->

**User Profile:** Primary user is the operator configuring LHC derivations, and the host process that supplies the model-call function at `createSdk`.

**Objective:** Exercise the full post-Epic-07 pipeline after Stories 0–5 land.

**Scope In:** Capstone verification across all flows. This story owns no primary epic ACs or TCs; it performs secondary verification over AC coverage already owned by Stories 0–5.

**Scope Out:** No new product behavior, no new ACs, no changes to host-side model-call contract.

**Dependencies:** Stories 1–5.

**Architecture Constraints:** Verification must preserve domain ownership: `messages` owns message-level derivations, `turns` owns turn/chunk derivations, `thread-view` assembles views from stored artifacts, and provider calls do not occur during intake or context-serving.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

No primary epic ACs or TCs are assigned to this story. It verifies the integrated behavior after all owned AC/TC stories have landed.

Suggested verification scenarios:

- All derivation defaults are inspectable after SDK construction.
- A prompt over cap lands `smoothed_prompt` as `ready` without a provider call.
- A large tool result is classified, excerpted, and summarized through the configured provider.
- A non-tiny closed turn produces `smooth_turn_compression` through inference.
- A chunk detailed summary concatenates member compressed turns with no provider call.
- A chunk brief summary consumes detailed text and produces past-tense memory.
- `pnpm run verify-all` passes.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story is secondary verification only. It owns no primary Epic 07 ACs or TCs, and it must not move any coverage from Stories 0-5. Its job is to prove the fully assembled derivation pipeline works with the same host-provided `ModelCall` fixture that the extension path will use.

The real-inference suite checks loose production properties: non-empty inference outputs, ready states, provenance naming the configured provider/model, and zero provider calls for deterministic derivations.

#### Build Strategy

Strategy: simple-risk-reminders

Reason:
- This story is a capstone check over implemented behavior, not a new behavior slice. The main risk is false confidence from silently skipped real-inference tests.

Risk Reminders:
- Missing auth/fixture must produce a NOT-RAN line with reason, not pass-shaped output.
- Deterministic derivations must record zero provider calls even in the full pipeline.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Real inference verification | `inference-real.test.ts` |
| Host model-call fixture | Existing pi-lhc-provided `ModelCall` fixture |
| Manual scenario evidence | Verification notes/output from real multi-turn run |

#### Design References

- [tech-design.md §Testing Strategy](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:800), lines 800-837
- [tech-design.md §Story 6: Verification smoke run](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:1050), lines 1050-1068
- [tech-design.md §Runtime Prerequisites](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:1072), lines 1072-1079
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:98), lines 98-110
- [test-plan.md §Test Count Reconciliation](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:186), lines 186-203
- [test-plan.md §Manual Scenario Verification](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:207), lines 207-220

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| None | `inference-real.test.ts` | Secondary verification only; primary TC ownership remains with Stories 0-5. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Real-inference suite silently passes without auth | `inference-real.test.ts` | With no host `ModelCall` fixture, emit exactly one NOT-RAN line with reason and no pass-shaped result. | No product AC covers test harness accounting. |
| Deterministic derivations call providers in full pipeline | `inference-real.test.ts` | Verify `turn_rendering` and `chunk_summary_detailed` record zero provider calls. | Unit tests can pass while full-pipeline routing drifts. |

#### Technical Notes

- Use the host-provided `ModelCall` fixture; do not add a standalone OpenRouter/OpenAI client in this suite.
- Assertions should be loose for model content and strict for state/provenance/routing.

#### Anti-Shim Requirements

- Do not mark real-inference checks as passed when prerequisites are missing.
- Do not test only private helpers; exercise the full derivation pipeline.

#### Production Path Proof

- Entrypoint: full SDK construction plus queue drain over a real thread DB.
- Registration/default path: defaults route each inference derivation through configured provider/model metadata; deterministic derivations stay inside domain handlers.
- Evidence: `inference-real.test.ts` and the manual scenario checklist.

#### Fixture Fidelity

- Use real temp thread files and the same host fixture shape as pi-lhc.
- Preserve provider/model provenance in assertions.
- Record NOT-RAN accounting explicitly when auth or host fixture is unavailable.

#### Verification

- Targeted: `pnpm run verify`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Capstone verification scenario covers every derivation type.
- Deterministic derivations are observed with no provider calls.
- Inference derivations use configured provider lane/model/prompt metadata.
- Verification output records concrete pass/fail results.
- `pnpm run verify-all` passes after all implementation stories land.
