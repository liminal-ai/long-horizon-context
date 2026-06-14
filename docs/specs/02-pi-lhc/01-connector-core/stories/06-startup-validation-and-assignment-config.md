# Story 6: Startup Validation and Assignment Config

### Summary
<!-- Jira: Summary field -->

Load seven derivation assignments from config, validate lanes at session start, report unreachable lanes, and keep capture running through validation failures.

### Description
<!-- Jira: Description field -->

**User Profile:** A developer using PI as their daily coding agent, with the `pi-lhc` extension loaded.

**Objective:** Bad derivation lanes are visible before first use, assignment overrides take effect on next session start, and capture survives validation failures.

**Scope In:**

- Config loading for all seven derivation kinds.
- Shipped default assignments.
- User overrides for provider, model, and prompt per kind.
- Startup validation against PI's registry before first derivation use.
- Interactive and headless reporting for unreachable lanes.
- Classified/queryable failures for derivations on affected lanes.

**Scope Out:**

- Derivation prompt quality tuning.
- Status-bar/footer UX beyond actionable startup-validation reporting.
- Context serving.

**Dependencies:** Story 5.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-5.1:** At session start the extension validates all seven model assignments against PI's registry before first derivation use.

**TC-5.1** — All seven assignments validate against the registry at session start before first use.

**AC-5.2:** An unreachable lane — not logged in, unknown model, unknown provider — is reported before first use, naming the derivation kind, the (provider, model), and the corrective action. The report reaches the user in interactive and headless modes alike (guarded on UI availability, never assuming a TUI).

**TC-5.2** — An unreachable lane reports kind + (provider, model) + fix; the report appears in a headless mode, not only the TUI.

**AC-5.3:** A validation failure leaves capture running. Derivations on the affected lanes fail, classified and queryable through health; the session is not broken.

**TC-5.3** — A validation failure leaves capture running; the affected lane's derivations fail classified and queryable.

**AC-5.4:** Model assignments load from the extension's config. Each of the seven derivation kinds resolves to a (provider, model, prompt), where the prompt names a registered prompt. The epic ships with default assignments so derivations function; assignment quality is a dial-in concern, not a build gate.

**TC-5.4** — Each of the seven kinds loads a (provider, model, prompt) from config with shipped defaults; the prompt resolves to a registered prompt.

**AC-5.5:** A user override — a different provider, model, or prompt for any kind — takes effect on the next session start with no code change. An incomplete or unknown assignment fails loudly at initialization with an actionable error, never a silent skip or a placeholder default that masks the misconfiguration.

**TC-5.5** — A user override of a kind's provider/model/prompt takes effect on the next session start with no code change.

**TC-5.6** — An incomplete or unknown assignment fails loudly at initialization with an actionable error; no placeholder default masks it.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 6 owns assignment loading and startup validation before first derivation use. Assignments provide provider, model, and prompt for all seven derivation kinds, with user overrides applied on the next start.

Validation has two layers: assignment shape is fail-loud at initialization, while reachability distinguishes unknown provider/model from configured-auth absence. Capture continues even when validation reports unreachable lanes.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The module surface is small, but incorrect validation can silently mask bad lanes or block capture.
- Red should pin all seven assignments, override behavior, loud shape failures, headless reporting, and capture continuity.

Risk Reminders:
- Use both `modelRegistry.find(provider, model)` and configured-auth checks (`hasConfiguredAuth` / `getAvailable`) so reports distinguish unknown lane from not logged in.
- Reporting must work without assuming a TUI.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Assignment loading | `packages/pi-lhc/src/inference/assignments.ts` |
| Startup validation | `packages/pi-lhc/src/inference/startup-validation.ts` |
| State diagnostics | `packages/pi-lhc/src/lifecycle/state.ts` |
| Hook routing | `packages/pi-lhc/src/index.ts` |
| Tests | `packages/pi-lhc/test/inference/startup-validation.test.ts`, `packages/pi-lhc/test/inference/assignments.test.ts` |

#### Design References

- [epic.md §Flow 5](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/epic.md:211), lines 211-223
- [tech-design.md §Module Responsibility Matrix](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:194), lines 194-195
- [tech-design.md §Flow 5](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:391), lines 391-403
- [tech-design.md §Interface Definitions](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:496), lines 496-519
- [tech-design.md §Chunk 6](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:670), lines 670-672
- [test-plan.md §Startup Validation Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:104), lines 104-118
- [test-plan.md §Chunk 6](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:182), lines 182-187

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-5.1 | `test/inference/startup-validation.test.ts` | All seven assignments validate at start before first derivation use. |
| TC-5.2 | `test/inference/startup-validation.test.ts` | Unreachable lane report names derivation kind, provider/model, reason, and fix; report appears in headless mode and state health. |
| TC-5.3 | `test/inference/startup-validation.test.ts` | Validation failure leaves capture running; affected derivations fail classified and queryable. |
| TC-5.4 | `test/inference/assignments.test.ts` | Shipped defaults load provider/model/prompt for all seven kinds and prompts resolve. |
| TC-5.5 | `test/inference/assignments.test.ts` | User override of provider/model/prompt takes effect on next start. |
| TC-5.6 | `test/inference/assignments.test.ts` | Missing kind, unknown prompt, incomplete assignment, or placeholder fails loudly at initialization. |

#### Architecture-Risk Tests

None.

#### Technical Notes

- Required kinds: `smoothed_prompt`, `tool_call_summary`, `tool_result_summary`, `turn_rendering`, `lower_band_projection`, `chunk_summary_detailed`, and `chunk_summary_brief`.
- Unknown provider/model reports a config fix; known lane without configured auth reports login/configure-auth fix.
- Always persist the structured validation report into `SessionState.health`, even when UI reporting succeeds.

#### Anti-Shim Requirements

- Do not silently substitute default assignments over incomplete or unknown user config.
- Do not skip validation because auth is unavailable; deterministic fakes must exercise the not-logged-in path.
- Do not collapse unknown lane and not-logged-in into one generic error.

#### Production Path Proof

- Entrypoint: `session_start` validation routing through `index.ts`.
- Registration/default path: assignments load from extension config, shape validation runs, reachability probe reports through UI/headless channel and `SessionState.health`.
- Evidence: validation tests assert before-first-use validation, headless reporting, capture continuity, overrides, and fail-loud config errors.

#### Verification

- Targeted: `pnpm --filter pi-lhc verify -- test/inference/startup-validation.test.ts test/inference/assignments.test.ts`
- Story gate: `pnpm --filter pi-lhc green-verify`
- Epic gate: `pnpm --filter pi-lhc verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- All Flow 5 ACs and TCs pass.
- Defaults cover all seven derivation kinds.
- User overrides apply on next session start.
- Missing, unknown, incomplete, or placeholder assignments fail loudly.
- Unreachable-lane reports work in interactive and headless modes.
- Capture continues through validation failure.
