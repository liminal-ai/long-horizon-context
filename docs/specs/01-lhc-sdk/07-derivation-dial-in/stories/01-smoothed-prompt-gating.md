# Story 1: Smoothed-Prompt Input-Size Cap and Suspicious-Output Guard

### Summary
<!-- Jira: Summary field -->

Add input-size gating and suspicious-output validation for `smoothed_prompt`.

### Description
<!-- Jira: Description field -->

**User Profile:** Primary user is the operator configuring LHC derivations, and the host process that supplies the model-call function at `createSdk`.

**Objective:** Skip low-value smoothing calls for large prompts and discard implausibly short smoothing outputs while preserving the deterministic floor and `ready` derivation behavior.

**Scope In:** Flow 4 AC-4.1 through AC-4.4.

**Scope Out:** No model-call contract change, no recovery cascade change, no retry behavior for skip/discard cases.

**Dependencies:** Story 0; `maxInputTokens` and `suspiciousOutputRatio` defaults are available in assignment/guard config.

**Architecture Constraints:** This is message-derivation behavior owned by `messages`. Shared utilities may support token counting and model-call safety, but domain decisions remain in the owning domain.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-4.1:** Inference smoothing is skipped when the prompt exceeds the configured input-size cap; the deterministic floor is stored as `ready`.

- **TC-4.1a:** Over-cap skips inference
  - Given: a prompt above the configured cap
  - When: smoothing derives
  - Then: no model call is made and the deterministic floor is stored as `ready`

**AC-4.2:** The input-size cap is configurable in the model assignment config with a default value.

- **TC-4.2a:** Cap configurable
  - Given: a config with `smoothed_prompt` cap set to 500
  - When: a 600-token prompt is smoothed
  - Then: inference is skipped
- **TC-4.2b:** Default cap applied
  - Given: a config with no explicit cap for `smoothed_prompt`
  - When: a prompt above the default cap is smoothed
  - Then: inference is skipped

**AC-4.3:** When inference produces output that is suspiciously short relative to the input (below a configured ratio threshold), the output is discarded, the deterministic floor is used, the discard reason is recorded in the derivation's metadata, and the discard is logged.

- **TC-4.3a:** Suspicious output discarded and recorded
  - Given: a 500-token prompt where inference returns 50 tokens
  - When: the output ratio is below the configured threshold
  - Then: the inference output is discarded, the deterministic floor is stored, the discard reason is recorded in derivation metadata, and a warning is logged

**AC-4.4:** Over-cap skipping and suspicious-output discard are normal operational behavior, not error states; both land as `ready` with no retry.

- **TC-4.4a:** Skip and discard land ready
  - Given: an over-cap prompt and a suspicious-output case
  - When: each completes
  - Then: both derivations are `ready`, not `failed` or `pending`

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story is owned by `messages` because `smoothed_prompt` is a message-level derivation. The handler chooses between a provider call and the deterministic prompt floor using two guards: `guards.smoothedPrompt.maxInferenceTokens` and `guards.smoothedPrompt.suspiciousOutputRatio`.

Both guarded outcomes are normal successful derivations. They land `ready`, do not enqueue retry work, and preserve queryable metadata when a suspicious model output is discarded.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The implementation is small but easy to fake by checking only logs or provider call count. Tests should first pin row state, floor content, metadata, and retry absence.

Risk Reminders:
- `discardReason` must be persisted in derivation metadata, not only logged.
- Skip/discard must not introduce a new derivation state.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Message derivation handler | `src/messages/internal/handlers.ts` |
| Guard config types/defaults | `src/shared-tech/inference-types.ts`, `src/sdk.ts` |
| Token counting | `src/shared-tech/token-counting/` |
| Logging | `src/shared-tech/logging/` |
| Tests | `smoothed-prompt-guards.test.ts` |

#### Design References

- [tech-design.md §TDQ-2: Suspicious-output ratio](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:70), lines 70-76
- [tech-design.md §TDQ-7: Assignment config shape](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:107), lines 107-136
- [tech-design.md §Flow 4: Smoothed-Prompt Guards](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:558), lines 558-585
- [tech-design.md §Derived-State Provenance](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:1083), lines 1083-1096
- [test-plan.md §Flow 4: Smoothed-Prompt Guards](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:66), lines 66-74
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:98), lines 98-110

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-4.1a | `smoothed-prompt-guards.test.ts` | Over-cap prompt records zero smoothing calls and stores the deterministic floor as `ready`. |
| TC-4.2a | `smoothed-prompt-guards.test.ts` | Configured cap of 500 shifts the skip threshold. |
| TC-4.2b | `smoothed-prompt-guards.test.ts` | Missing guard config uses the default cap of 700. |
| TC-4.3a | `smoothed-prompt-guards.test.ts` | Suspicious output is discarded; floor content, metadata reason, and warning log are present. |
| TC-4.4a | `smoothed-prompt-guards.test.ts` | Over-cap and suspicious-output cases both land `ready` and enqueue no retry. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Discard reason is only transient logging | `smoothed-prompt-guards.test.ts` | Read through inspect/report path and assert derivation metadata contains `discardReason: "suspicious_output_ratio"`. | A test can satisfy the AC text by checking a log line while leaving operators unable to inspect the derivation later. |

#### Technical Notes

- Default `maxInferenceTokens` is 700.
- Default `suspiciousOutputRatio` is 0.15.
- The deterministic floor for skipped/discarded smoothing is raw prompt text per the tech design.

#### Anti-Shim Requirements

- Assert persisted derivation row content and metadata, not just handler return values.
- Assert provider spy call count at the host `ModelCall` boundary.
- Assert no retry work is queued for guarded ready outcomes.

#### Production Path Proof

- Entrypoint: message-level `smoothed_prompt` derivation work handled by `messages/internal/handlers.ts`.
- Registration/default path: SDK construction fills guard defaults; message creation queues the derivation through existing message derivation wiring.
- Evidence: `smoothed-prompt-guards.test.ts` uses real handlers with a host `ModelCall` spy and real temp SQLite.

#### Source/Derived State Risk

- Source truth remains the message content.
- Derived state is overwritten with floor content when the cap or suspicious-output guard fires.
- Metadata from prior attempts is overwritten, not appended.

#### Verification

- Targeted: `pnpm run verify`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Over-cap prompts skip inference and land `ready`.
- Configured and default caps are both exercised.
- Suspicious-output discard records metadata and writes a warning log.
- Skip and discard cases do not produce `failed`, `pending`, or retry work.
