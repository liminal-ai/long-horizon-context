# Story 2: Inference Seam and Model Assignment

### Summary
<!-- Jira: Summary field -->

Add the `createSdk` inference construction path: one host model-call function plus complete per-kind model assignments.

### Description
<!-- Jira: Description field -->

**User Profile:** The operator configures which models run LHC derivations while the host process owns credentials and transport.

**Objective:** Establish the production inference seam and validate model assignments loudly at SDK construction.

**Scope In:** `provider` XOR `inference`, `ModelCall` contract, complete assignment validation, adapter construction wiring, and per-call provider/model routing.

**Scope Out:** Prompt content, output shaping, failure retry behavior, and real endpoint verification; those belong to Stories 3-5.

**Dependencies:** Story 1 should be complete so the final provider-arrival shape is SDK-only. Story 3 depends on this seam.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-1.1**: `createSdk` accepts exactly one of `provider` (a `DerivationProvider`, unchanged) or `inference` (model-call function + assignments). Both supplied, or neither, is a caller error naming the rule.
- **AC-1.2**: The model-call function contract: it receives `{ provider, model, messages }` for a single-turn completion and returns `{ ok: true, text }` or `{ ok: false, kind, message }` with `kind` from the failure vocabulary (Data Contracts). LHC never inspects credentials, never constructs API clients, and sends nothing but this call shape across the boundary.
- **AC-1.3**: Assignment validation at construction: all seven kinds present, each naming a known prompt; a missing kind, unknown kind key, or unknown prompt name fails `createSdk` with a caller error naming the specific kind/prompt. No partial construction.
- **AC-1.4**: Per-call routing: each drained work item looks up its kind's assignment and the function receives that assignment's provider and model strings. Different kinds routing to different providers in one config work item-by-item with no cross-kind interference.

**Test Conditions**

- **TC-1.1** (AC-1.1, AC-1.3): `inference-construction.test.ts`
  - missing one kind, parameterized across all seven kinds, returns `TypeError` naming the kind
  - unknown prompt name returns `TypeError` naming kind and prompt
  - unknown kind key in assignments returns `TypeError` naming it
  - both `provider` and `inference` returns `TypeError` naming the XOR rule
  - neither returns `TypeError` naming the XOR rule
  - empty `provider` or `model` string in one assignment returns `TypeError`
  - complete valid config constructs and a seeded drain lands a form `ready`
- **TC-1.2** (AC-1.2, AC-1.4): `inference-routing.test.ts`
  - a recording fake function logs every call while a seeded thread exercises all seven kinds
  - each logged call carries exactly its assigned provider/model strings
  - every logged `messages` value is single-turn shape with only `system` and `user` roles and string content
  - three-lane mixed config routes each call to its item kind with no cross-kind bleed
  - `assertModelCallContract(recordingCall(...).call)` catches fixture drift from the contract

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story establishes the SDK construction boundary for real inference. `createSdk` accepts exactly one provider arrival path: direct `provider` injection or `inference` config. On the inference path, SDK validation resolves the assignment map and builds the real adapter into the same `DerivationProvider` slot the deterministic provider already uses.

The external boundary is the host-supplied `ModelCall`. LHC owns provider/model assignment and prompt selection; the host owns credentialed transport.

#### Build Strategy

Strategy: tdd-lite

Reason:
- Construction validation has many fail-fast cases and is easy to partially implement.
- Routing proof must inspect the actual serialized `ModelCall` input, not a helper-level intention.

Risk Reminders:
- Iterate the exported `FormKind` set instead of maintaining a second literal list.
- Validate the XOR rule before downstream validation so errors name the right caller mistake.
- Keep `provider` injection unchanged for deterministic tests.

#### Implementation Targets

| Area | Files / Modules |
|---|---|
| Inference boundary types | `src/inference/types.ts` |
| SDK construction | `src/sdk.ts` |
| Adapter construction slot | `src/inference/adapter.ts` |
| Prompt lookup dependency | `src/inference/prompts/index.ts` |
| Fake host fixtures | `test/fixtures/model-call.ts`, `test/fixtures/seam-conformance.ts` |
| Story-owned tests | `test/inference-construction.test.ts`, `test/inference-routing.test.ts` |

#### Design References

- [epic.md §Flow 1](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md:71), lines 71-89
- [epic.md §Data Contracts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md:192), lines 192-238
- [tech-design.md §Design Decisions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:20), lines 20-24
- [tech-design.md §Module Responsibility Matrix](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:88), lines 88-92
- [tech-design.md §Flow 1](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:105), lines 105-128
- [tech-design.md §Interface Definitions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:210), lines 210-242
- [tech-design.md §Error Contract](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:289), lines 289-291
- [test-plan.md §Fixture Contracts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:24), lines 24-32
- [test-plan.md §TC-1.1 / TC-1.2](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:42), lines 42-57
- [coverage.md §Story Shape Review](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/coverage.md:73), line 73

#### Test Mapping

| TC | Test File / Check | Test Description |
|---|---|---|
| TC-1.1 | `test/inference-construction.test.ts` | construction matrix for missing kinds, unknown prompt, unknown kind, XOR failures, empty provider/model, and valid operation |
| TC-1.2 | `test/inference-routing.test.ts` | recording fake verifies per-kind provider/model routing, single-turn messages, mixed lanes, and fake-host contract conformance |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|---|---|---|---|
| Validation drift from `FormKind` | `test/inference-construction.test.ts` | missing-kind cases parameterized across the exported kind set | A literal list can pass current examples while failing when a new kind appears |
| Fake host fixture drift | `test/fixtures/seam-conformance.ts` via routing tests | asserts fake call shape conforms to `ModelCall` | Routing logs are useful only if the fake itself honors the boundary contract |

#### Technical Notes

Relevant contracts:

```ts
export type ModelCall = (input: {
  provider: string;
  model: string;
  messages: { role: "system" | "user"; content: string }[];
}) => Promise<ModelCallResult>;

export type ModelCallResult =
  | { ok: true; text: string }
  | { ok: false; kind: ModelCallFailureKind; message: string };

export type ModelCallFailureKind =
  | "rate_limit" | "timeout" | "network" | "empty_output" | "other"
  | "auth" | "invalid_request";

export interface ModelAssignment {
  provider: string;
  model: string;
  prompt: string;
}

export interface InferenceConfig {
  call: ModelCall;
  assignments: Record<FormKind, ModelAssignment>;
  timeoutMs?: number;
  maxInputChars?: number;
}

export interface SdkConfig {
  provider?: DerivationProvider;
  inference?: InferenceConfig;
}
```

Assignment example:

```ts
inference: {
  call: hostModelCallFunction,
  assignments: {
    smoothed_prompt:        { provider: "openai-codex",   model: "gpt-5.4-mini",     prompt: "smoothing-v1" },
    tool_call_summary:      { provider: "openai-codex",   model: "gpt-5.4-mini",     prompt: "tool-call-v1" },
    tool_result_summary:    { provider: "github-copilot", model: "gpt-5.4-mini",     prompt: "tool-result-v1" },
    turn_rendering:         { provider: "anthropic",      model: "claude-haiku-4.5", prompt: "turn-compose-v1" },
    lower_band_projection:  { provider: "anthropic",      model: "claude-haiku-4.5", prompt: "lower-band-v1" },
    chunk_summary_detailed: { provider: "anthropic",      model: "claude-haiku-4.5", prompt: "chunk-detailed-v1" },
    chunk_summary_brief:    { provider: "openai",         model: "gpt-5-nano",       prompt: "chunk-brief-v1" },
  }
}
```

Construction errors are `TypeError`s naming the violated rule:

| Case | Required error subject |
|---|---|
| both or neither `provider` / `inference` | exactly one of provider or inference |
| missing kind | missing kind name |
| unknown kind key | unknown kind key |
| unknown prompt | kind and prompt name |
| empty provider/model | assignment field and kind |

#### Anti-Shim Requirements

- Do not route through a hardcoded default provider/model.
- Do not accept partial assignment maps.
- Do not test only the resolved config object; assert the actual `ModelCall` input emitted during drain.
- Do not move prompt content ownership into the host function.

#### Production Path Proof

- Entrypoint: `createSdk({ inference: { call, assignments } })`.
- Registration/default path: SDK resolves the inference config into the same `resolved.provider` slot used by direct provider injection.
- Evidence: construction tests prove valid construction operates; routing tests prove drained work reaches the host function with the assigned provider/model strings.

#### Verification

- Targeted: `cd packages/lhc && pnpm exec vitest run test/inference-construction.test.ts test/inference-routing.test.ts`
- Story gate: `cd packages/lhc && pnpm run red-verify && pnpm exec vitest run test/inference-construction.test.ts test/inference-routing.test.ts`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- `createSdk` validates `provider` XOR `inference` before partial construction.
- Inference assignments validate all seven `FormKind`s, reject unknown keys, reject unknown prompts, and reject empty provider/model strings.
- The resolved inference config constructs a `DerivationProvider` adapter slot without changing downstream domain handlers.
- Routing tests prove mixed provider/model lanes work item-by-item.
- TC-1.1 and TC-1.2 are green.
