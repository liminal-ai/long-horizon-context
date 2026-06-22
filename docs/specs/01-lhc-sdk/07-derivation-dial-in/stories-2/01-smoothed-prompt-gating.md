# Story 1: Smoothed-Prompt Input-Size Cap and Suspicious-Output Guard

### Summary
<!-- Jira: Summary field -->

Wire guard config into the smoothed-prompt handler, lower the input-size cap, and add suspicious-output validation.

### Description
<!-- Jira: Description field -->

**User Profile:** Primary user is the operator configuring LHC derivations, and the host process that supplies the model-call function at `initLhc`.

**Objective:** Skip low-value smoothing calls for large prompts and discard implausibly short smoothing outputs while preserving the deterministic floor and `ready` derivation behavior.

**Scope In:** Input-size cap wiring and default change, suspicious-output guard, guard config consolidation for `smoothed_prompt`.

**Scope Out:** No model-call contract change, no recovery cascade change, no retry behavior for skip/discard cases, no changes to tool-result or turn-compression guards (those are later stories).

**Dependencies:** None. The refactor landed the guard config types (`DerivationGuards`), defaults (`DEFAULT_GUARDS`), and resolution (`resolveGuards`). The handler cap mechanism exists but reads from the wrong config path.

**Architecture Constraints:** This is message-derivation behavior owned by `messages`. The handler reads operational limits from the SDK config; the guard config path is the source of truth for those limits.

**Current State:**
- The cap mechanism exists in `messages/internal/handlers.ts:76`: `estimateTokens(cleaned) > run.config.smoothing.maxInferenceTokens`.
- The handler reads from `ResolvedSdkConfig.smoothing.maxInferenceTokens`, which defaults to **4000**.
- The guard config `DEFAULT_GUARDS.smoothedPrompt.maxInferenceTokens` defaults to **700** but is resolved at construction and passed into the inference adapter — it never reaches the handler.
- The recovery path in `turns/internal/derive.ts:183` also reads `run.config.smoothing.maxInferenceTokens`.
- `HandlerRunContext.config` is `ResolvedSdkConfig`, which has no `guards` field.
- No suspicious-output ratio check exists.
- No `discardReason` metadata is written.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-1.1:** The smoothed-prompt handler reads its input-size cap from guard config, not from `ResolvedSdkConfig.smoothing.maxInferenceTokens`. The default cap is 700.

- **TC-1.1a:** Default cap is 700
  - Given: a default-config SDK
  - When: a 900-token prompt is smoothed
  - Then: inference is skipped and the deterministic floor is stored as `ready`
- **TC-1.1b:** Old smoothing config path removed from handler paths
  - Given: the updated codebase
  - When: a search for `smoothing.maxInferenceTokens` is run
  - Then: no handler or recovery path reads it for the cap decision. Allowed remaining sites: the `SdkConfig` type definition (if the field is kept as a deprecated input alias) and `sdk.ts` construction resolution. No other file reads `smoothing.maxInferenceTokens`.

**AC-1.2:** The input-size cap is configurable through `SdkConfig.guards.smoothedPrompt.maxInferenceTokens` (top-level, works for both inference-config and direct-callback hosts).

- **TC-1.2a:** Custom cap respected
  - Given: a config with `guards.smoothedPrompt.maxInferenceTokens` set to 500
  - When: a 600-token prompt is smoothed
  - Then: inference is skipped
- **TC-1.2b:** Custom cap below threshold allows inference
  - Given: a config with `guards.smoothedPrompt.maxInferenceTokens` set to 1000
  - When: a 600-token prompt is smoothed
  - Then: inference runs

**AC-1.3:** When inference produces output whose token count is below the configured `suspiciousOutputRatio` × the cleaned prompt's token count, the output is discarded, the deterministic floor is stored as `ready`, a `discardReason` is recorded in derivation metadata, and a warning is logged.

- **TC-1.3a:** Suspicious output discarded and recorded
  - Given: a 500-token cleaned prompt where inference returns 50 tokens (ratio 0.10, below default threshold 0.15)
  - When: the handler evaluates the inference result
  - Then: the inference output is discarded, the deterministic floor (the cleaned prompt) is stored as `ready`, derivation metadata contains `discardReason: "suspicious_output_ratio"`, and a warning is written through the logging surface

**AC-1.4:** Over-cap skipping and suspicious-output discard are normal operational behavior, not error states; both land as `ready` with no retry.

- **TC-1.4a:** Skip and discard land ready
  - Given: an over-cap prompt and a suspicious-output case
  - When: each completes
  - Then: both derivations are `ready`, not `failed` or `pending`, and no retry work is queued

**AC-1.5:** Guard config is reachable from the handler run context through `ResolvedSdkConfig.guards`. The resolved guards live on `ResolvedSdkConfig` because `HandlerRunContext.config` already carries `ResolvedSdkConfig`, and all hosts — whether using the `inference` config path or direct `inferenceCallbacks` — produce a `ResolvedSdkConfig` through `initLhc`.

- **TC-1.5a:** Guards on resolved config
  - Given: a handler receiving `HandlerRunContext`
  - When: it reads `run.config.guards.smoothedPrompt.maxInferenceTokens`
  - Then: the resolved value (700 by default) is available
- **TC-1.5b:** Direct-callback host gets guard defaults
  - Given: an SDK constructed with `inferenceCallbacks` (no `inference` config)
  - When: a handler reads `run.config.guards`
  - Then: the default guards are resolved and available

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story is owned by `messages` because `smoothed_prompt` is a message-level derivation. The handler reads guard config from `HandlerRunContext.config` and decides between a provider call and the deterministic prompt floor using two guards: the input-size cap and the suspicious-output ratio.

The core change is wiring the guard config into the handler's decision path. The guard types, defaults, and resolution already exist in `shared-tech/inference-types.ts`. What's missing is the path from resolved guards to the handler.

Both guarded outcomes are normal successful derivations. They land `ready`, do not enqueue retry work, and preserve queryable metadata when a suspicious model output is discarded.

#### Config Consolidation

There are two config paths for the smoothing cap today:

| Path | Default | Used by |
|------|---------|---------|
| `ResolvedSdkConfig.smoothing.maxInferenceTokens` | 4000 | `handlers.ts:76`, `derive.ts:183` |
| `DEFAULT_GUARDS.smoothedPrompt.maxInferenceTokens` | 700 | Resolved at construction, passed to adapter, not read by handlers |

This story collapses them. The resolution:

1. **`SdkConfig.guards?: DerivationGuards`** becomes a top-level input field (alongside `smoothing`, `toolResult`, etc). This works for both the `inference` config path and the direct `inferenceCallbacks` path — a direct-callback host that never constructs an `InferenceConfig` can still configure guards.
2. **`InferenceConfig.guards`** is retired. If a host currently passes guards there, move them to top-level `SdkConfig.guards`. If both are provided, `initLhc` throws a construction error.
3. **`ResolvedSdkConfig.guards: DerivationGuards`** is added as a required field, resolved from `SdkConfig.guards` via `resolveGuards` (same function, just called from a different site). Handlers read `run.config.guards.smoothedPrompt.maxInferenceTokens`.
4. **`smoothing`** is removed entirely from both `SdkConfig` and `ResolvedSdkConfig`. Its only field was `maxInferenceTokens`, which now lives under guards. Pre-1.0, no external consumers, clean removal. Reintroduce `smoothing` if/when future smoothing config unrelated to operational guards lands.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The implementation is small but easy to fake by checking only logs or provider call count. Tests should first pin row state, floor content, metadata, and retry absence.

Risk Reminders:
- `discardReason` must be persisted in derivation metadata, not only logged.
- Skip/discard must not introduce a new derivation state.
- The recovery path in `turns/internal/derive.ts:183` must also move to the guard config path.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Message derivation handler | `src/messages/internal/handlers.ts` — add suspicious-output check, switch cap source to `run.config.guards` |
| Turn recovery path | `src/turns/internal/derive.ts` ~line 183 — switch cap source to `run.config.guards` |
| Guard config types | `src/shared-tech/inference-types.ts` — keep `DerivationGuards`, `DEFAULT_GUARDS`, `resolveGuards`; retire `InferenceConfig.guards` field |
| Config shapes + metadata | `src/shared-tech/derivation.ts` — add `guards?: DerivationGuards` to `SdkConfig`, add `guards: DerivationGuards` to `ResolvedSdkConfig`, add `discardReason?: string` to `DerivationMetadata` |
| SDK construction | `src/sdk.ts` — resolve guards from `SdkConfig.guards` onto `ResolvedSdkConfig.guards`; remove `smoothing.maxInferenceTokens` from resolved config |
| Logging | `src/shared-tech/logging/` — warning log for suspicious output discard |
| Tests | `test/smoothed-prompt-guards.test.ts` |

#### Design References

- [tech-design.md §TDQ-2: Suspicious-output ratio](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:70), lines 70-76
- [tech-design.md §TDQ-7: Assignment config shape](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:107), lines 107-136
- [tech-design.md §Flow 4: Smoothed-Prompt Guards](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:558), lines 558-585

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-1.1a | `smoothed-prompt-guards.test.ts` | Default-config SDK, 900-token prompt: zero smoothing calls, deterministic floor stored as `ready`. |
| TC-1.1b | grep / code inspection | No handler or recovery path reads `smoothing.maxInferenceTokens` for the cap decision. |
| TC-1.2a | `smoothed-prompt-guards.test.ts` | Custom cap 500, 600-token prompt: inference skipped. |
| TC-1.2b | `smoothed-prompt-guards.test.ts` | Custom cap 1000, 600-token prompt: inference runs. |
| TC-1.3a | `smoothed-prompt-guards.test.ts` | 500-token prompt, model returns 50 tokens: floor stored, metadata has `discardReason: "suspicious_output_ratio"`, warning log present. |
| TC-1.4a | `smoothed-prompt-guards.test.ts` | Over-cap and suspicious-output: both `ready`, no `failed`/`pending`, no queued retry work. |
| TC-1.5a | `smoothed-prompt-guards.test.ts` | Handler run context exposes resolved guard values via `run.config.guards`. |
| TC-1.5b | `smoothed-prompt-guards.test.ts` | SDK constructed with direct `inferenceCallbacks` (no `inference` config) still has default guards on `run.config.guards`. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Discard reason is only transient logging | `smoothed-prompt-guards.test.ts` | Read derivation metadata through the messages surface and assert it contains `discardReason: "suspicious_output_ratio"`. | A test can satisfy the AC by checking a log line while leaving operators unable to inspect the derivation later. |
| Recovery path uses stale config | `smoothed-prompt-guards.test.ts` | Create a closed turn with an over-cap user prompt whose `smoothed_prompt` derivation is pending/missing, then call `turns.deriveTurn` so the recovery path in `recoverMessageDerivations` attempts prompt smoothing. Assert it skips inference using the guard cap (700), not the old smoothing default (4000). | The primary handler could be correct while the recovery path still reads the old default of 4000. |

#### Technical Notes

- Default `maxInferenceTokens` is 700 (from `DEFAULT_GUARDS`).
- Default `suspiciousOutputRatio` is 0.15 (from `DEFAULT_GUARDS`).
- The deterministic floor for skipped/discarded smoothing is the cleaned prompt text (output of `cleanPrompt`).
- The suspicious-output check runs after a successful inference call. It compares `estimateTokens(modelOutput)` against `ratio * estimateTokens(cleanedPrompt)` — the comparison is always against the cleaned prompt that was sent to inference.
- `discardReason` is added as an optional string field on `DerivationMetadata` (`shared-tech/derivation.ts`). It does not exist today. The handler sets it on the `HandlerDerivationWrite`; the completion transaction persists it.
- The over-cap skip path writes no metadata — it is a pre-call decision, not a discard. Only the suspicious-output path writes `discardReason`.
- Warning logging follows the existing `logFallback` pattern in `turns/internal/derive.ts`: `writeLog({ db: run.openDb(), threadId: readThreadId(run), filePath: "" }, { level: "warning", ... })`. The log write is a separate short transaction, not part of the completion transaction.

#### Anti-Shim Requirements

- Assert persisted derivation row content and metadata, not just handler return values.
- Assert provider spy call count at the host `ModelCall` boundary.
- Assert no retry work is queued for guarded ready outcomes.
- Do not leave `smoothing.maxInferenceTokens` as a parallel authority for the cap.

#### Production Path Proof

- Entrypoint: message-level `smoothed_prompt` derivation work handled by `messages/internal/handlers.ts`.
- Registration/default path: SDK construction resolves guard defaults (`resolveGuards`); guards are wired into `ResolvedSdkConfig`; handler reads them via `run.config`.
- Recovery path: `turns/internal/derive.ts` recovery also reads the guard config through the same `run.config` path.
- Evidence: `smoothed-prompt-guards.test.ts` uses real handlers with a host `ModelCall` spy and real temp SQLite.

#### Source/Derived State Risk

- Source truth remains the message content.
- Derived state is overwritten with floor content when the cap or suspicious-output guard fires.
- Metadata from prior attempts is overwritten, not appended.

#### Verification

- Targeted: `pnpm run verify`
- Story gate: `pnpm run verify`
- Epic gate: `pnpm run verify:all`

#### Spec Deviations

- **Numbering:** ACs renumbered from 4.x to 1.x. This is Story 1 in the updated sequence; the old numbering referenced Flow 4 from the original epic.
- **Config path:** The original story assumed guards were already wired. This story includes the config consolidation as AC-1.5 because the dual path is a pre-existing snag that must be resolved for the guards to work.
- **Verification scripts:** `green-verify` and `verify-all` do not exist. Story gate is `pnpm run verify`. Epic gate is `pnpm run verify:all`.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- `SdkConfig.guards` is a top-level input field; `InferenceConfig.guards` is retired.
- `ResolvedSdkConfig.guards` is populated for both inference-config and direct-callback hosts.
- Guard config is reachable from handlers via `run.config.guards`.
- Over-cap prompts skip inference and land `ready` at the guard default of 700.
- Configured and default caps are both exercised.
- Suspicious-output discard records `discardReason` in derivation metadata and writes a warning log.
- Over-cap skip writes no `discardReason` metadata.
- Skip and discard cases do not produce `failed`, `pending`, or retry work.
- Both the primary handler and the recovery path read from the guard config, not from `smoothing.maxInferenceTokens`.
- `pnpm run verify` passes.
