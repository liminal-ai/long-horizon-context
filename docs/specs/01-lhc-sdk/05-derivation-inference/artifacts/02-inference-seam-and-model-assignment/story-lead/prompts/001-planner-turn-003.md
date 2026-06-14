# Story Lead Base Prompt

## Role Charter
You are the story lead for `02-inference-seam-and-model-assignment` on durable story run `02-inference-seam-and-model-assignment-story-run-001`.
Select exactly one bounded next action for this `resume` turn.
This is planner turn 3.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/02-inference-seam-and-model-assignment.md
Bytes: 11213

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


### Test Plan
### test-plan
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md
Bytes: 15513

# Epic 05: Derivation Inference — Test Plan

**Epic:** `epic.md` (22 ACs / 15 TCs)
**Tech Design:** `tech-design.md`
**Coverage:** all 15 TCs mapped below; no TC unowned, none double-owned.

## Suite Layout

| File | Tier | TCs |
|------|------|-----|
| `test/inference-construction.test.ts` | default | TC-1.1 |
| `test/inference-routing.test.ts` | default | TC-1.2 |
| `test/inference-adapter.test.ts` | default | TC-2.1, TC-2.3 |
| `test/inference-prompts.test.ts` | default | TC-2.2 |
| `test/inference-classification.test.ts` | default | TC-3.1, TC-3.2 |
| `test/inference-real.test.ts` | opt-in (`LHC_OPENROUTER_KEY`) | TC-4.1, TC-4.2, TC-4.3 |
| `test/view-boundary.test.ts` (amended) + `test/view-boundary-turn-end.test.ts` (new) | default | TC-5.1, TC-5.2, TC-5.3 |
| `test/retirement.test.ts` | default | TC-6.1, TC-6.2 |

Deleted with Flow 6: the twelve `cli-process-*.test.ts` files. The `LHC_PROCESS_SUITE` gate leaves `verify-all`; the opt-in inference suite self-reports inside the default runner (it is env-gated, not script-gated).

## Fixture Contracts

**`test/fixtures/model-call.ts`** (Chunk 0) — the scripted-host builders every Flow 1–3 test uses:

- `recordingCall(responses: Record<FormKind, string>)` → `{ call: ModelCall, log: ModelCallInput[] }`. Resolves each call with the kind's canned text (kind inferred from the assignment the test built — in practice keyed by `model` string, which tests assign uniquely per kind). Every input pushed to `log`.
- `scriptedCall(script: ModelCallResult[])` → `ModelCall` returning script entries in order; throws if exhausted (a test calling more than scripted is a test bug, loudly).
- `throwingCall(error: Error)` → `ModelCall` that rejects/throws.
- `hangingCall()` → `ModelCall` that never settles (timeout leg; tests pass a small `timeoutMs`).
- `validAssignments(overrides?)` → a complete seven-kind assignment map for construction tests, each kind assigned a distinct fake provider/model string.

All builders return contract-conformant shapes (AC-1.2); the conformance helper below runs against `recordingCall`'s output in its own test, so fixture drift from the contract is caught by the suite, not discovered in stories.

**`test/fixtures/openrouter-call.ts`** (Chunk 5) — the real host: `createOpenRouterCall(key, defaultModel)` → `ModelCall` over `fetch` to OpenRouter's OpenAI-compatible chat-completions endpoint; implements the exact `ModelCall` contract (OpenRouter takes one model slug, so the fixture resolves the `provider`+`model` routing keys into that slug — the host-side interpretation AC-1.2 grants), maps HTTP 401/403 → `auth`, 429 → `rate_limit`, 400 → `invalid_request`, network errors → `network`, everything else → `other`, and extracts non-empty assistant text into the `ModelCallResult` success shape. `resolveRealSuiteEnv()` → `{ key, model } | { notRan: reason }`.

**`test/fixtures/seam-conformance.ts`** (Chunk 0) — the parameterized contract assertions (DD-13): `assertModelCallContract(call)` (shape of success/failure results on a probe call) and `assertRoutingThroughSdk(call, assignments)` (TC-1.2's routing assertions extracted so TC-4.3 runs them against the real host unchanged).

**Boundary fixtures** — `test/fixtures/` gains `seedTurnedToolResults(db, turns: { results: number[] }[])`: closed turns with tool results of given token estimates, plus turnless-result and open-turn variants. Built on the existing Epic 03 fixture helpers; token estimates seeded via content sized to the estimator (existing pattern from view-boundary tests).

## TC → Test Mapping

### TC-1.1 — Construction matrix (AC-1.1, AC-1.3)
`inference-construction.test.ts`
- missing one kind (each of seven, parameterized) → `TypeError` naming the kind
- unknown prompt name → `TypeError` naming kind and prompt
- unknown kind key in assignments → `TypeError` naming it
- both `provider` and `inference` → `TypeError` naming the XOR rule
- neither → `TypeError` naming the XOR rule
- empty `provider`/`model` string in one assignment → `TypeError`
- complete valid config → constructs; a seeded drain lands a form `ready` (operates, not just constructs)

### TC-1.2 — Routing (AC-1.2, AC-1.4)
`inference-routing.test.ts` — `recordingCall` + seven distinct lanes in `validAssignments`:
- seed a thread exercising all seven kinds; drain; assert `log` contains each kind's call carrying exactly its assigned provider/model strings
- every logged `messages` is single-turn shape (`system`+`user` roles only, string content)
- three-lane mixed config: per-call routing matches item kind with no cross-kind bleed
- `assertModelCallContract(recordingCall(...).call)` — fixture conformance leg

### TC-2.1 — Seven kinds land with canned content + provenance (AC-2.1, AC-2.2, AC-2.5)
`inference-adapter.test.ts`
- drain seeded thread → all seven `FormKind`s `ready`; content equals the canned text (post-shaping)
- handler equivalence: the same seeded thread drained under the deterministic provider lands the same form rows (states, subjects) with marker content — proving handlers unchanged (AC-2.1)
- outcomes/receipts on tool and rendering forms match the record, not the canned text (canned text deliberately claims the wrong outcome; the stamp must disagree with it)
- each form's `metadata.provenance` equals its assignment `{ provider, model, prompt }`; deterministic-provider forms carry none

### TC-2.2 — Prompt-rendering goldens (AC-2.2, AC-2.3)
`inference-prompts.test.ts` — golden files in `test/goldens/prompts/`:
- for each of the seven templates: `render(fixtureInput)` matches its golden (`smoothing-v1.golden.json` …) — fixture content embedded, single-turn shape
- registry completeness: every config-selectable name resolves; `PROMPT_REGISTRY` covers all seven default names
- brief-summary stripping: drive `summarizeChunkBrief` through the adapter with a recording call; the rendered messages contain outcome tokens but no receipt text from the fixture (the Epic 02 stripping contract holds through the adapter)
- bounding (DD-7): a `summarizeToolResult` input over `maxInputChars` renders with head+tail+marker, under-limit input renders whole

### TC-2.3 — Empty output is a failure (AC-2.4)
`inference-adapter.test.ts`
- `scriptedCall([{ ok: true, text: "  " }, { ok: true, text: "real" }])` → first attempt classifies `empty_output` retryable; retry lands `ready` with `"real"`
- exhaustion leg: all-whitespace script → form `failed`, reason `provider_failure`, last error names `empty_output`

### TC-3.1 — Classification table drives retry/terminal (AC-3.1, AC-3.2)
`inference-classification.test.ts`
- table assertion: `FAILURE_CLASSIFICATION` matches the AC-3.1 mapping exactly (data asserted as data)
- `rate_limit` ×2 then success → `ready`; attempts recorded on the path (report shows retrying mid-way under a paused clock, per existing Epic 02 clock-injection pattern)
- `auth` → `failed` first attempt; scripted call shows exactly one invocation; stable reason
- `network` to exhaustion → `failed`, `provider_failure`, `metadata.lastError` preserved

### TC-3.2 — Exception containment (AC-3.2, AC-3.3)
`inference-classification.test.ts`
- `throwingCall` on one kind amid a multi-kind drain → that item retries as `other`; all other items complete; drain returns normally (no escape)
- exhaustion lands thrown message as last error
- `hangingCall` with `timeoutMs: 50` → classified `timeout`, drain continues (DD-6 leg)

### TC-4.1 — Real round-trips + accounting (AC-4.1)
`inference-real.test.ts`
- keyed: each of seven kinds round-trips once → `ready`, non-empty, no marker pattern
- unkeyed (controlled: suite re-invoked with key stripped from env in a subprocess-free way — the guard function called directly with empty env) → `notRan` record with reason; assert the record's shape and that it is not a pass
- the suite-level guard emits exactly one ran/not-ran line into the run output

### TC-4.2 — Capstone (AC-4.2)
`inference-real.test.ts`
- Epic 04's lifecycle sequence against the real adapter: intake → drain → compact → pull → inspect → edit → rebuild → drain → compact → materialize
- structural assertions: every kind `ready` ≥ once; no marker pattern anywhere; provenance names the real model; mutation-cleared forms regenerate with content ≠ pre-edit content; second compact's view reflects post-edit content; health coherent at each checkpoint

### TC-4.3 — Contract conformance, both hosts (AC-1.2, AC-4.1)
`inference-real.test.ts`
- `assertModelCallContract(openRouterCall)` and `assertRoutingThroughSdk(openRouterCall, realAssignments)` — the same helpers TC-1.2 ran against the fake, unchanged (DD-13)

### TC-5.1 — Turn-end trigger + whole-turn eviction (AC-5.1, AC-5.2)
`view-boundary-turn-end.test.ts`
- mid-turn batches push zone past max → boundary unmoved; consecutive pulls byte-identical
- the `turn_end` batch commits → one advance; flipped set = whole oldest turns (every tool result in each evicted turn flipped together; assert per-turn all-or-nothing)
- next small turn closes under max → no movement
- turnless tool result (singleton group, DD-10) evicts whole-message

### TC-5.2 — Peek-ahead landing + config (AC-5.3, AC-5.4)
`view-boundary-turn-end.test.ts` — golden **G2** (worked in the design): 30k/25k/20k/15k turns, 64k/32k → boundary after the 25k group, zone 35k
- landing always in [target, target + one turn): G2 plus a variant where evicting the next turn would land exactly at target (boundary advances through it — `≥` boundary-condition leg)
- newest closed turn never evicted even when alone over target (oversized-newest variant)
- `maxTokens ≤ targetTokens` → construction `TypeError` naming the constraint; defaults resolve 64k/32k

### TC-5.3 — Epic 03 contract regression under the new trigger (AC-5.5)
`view-boundary.test.ts` (amended) + new file
- monotonic: flipped results stay flipped across later turn closes
- short form: summary-when-ready else truncation (existing assertions re-driven by turn-end trigger)
- compact reset: post-compact boundary = compact point, fresh full tail
- determinism: same record + budgets replayed → identical boundary trajectory (golden **G1**, re-cut for turn grouping)
- failure injection at `post-commit-advance` → intake unaffected, boundary unchanged, status shows over-budget zone, next turn close heals (Epic 03's failure-injection machinery — the `post-commit-advance` hook — retriggered)

### TC-6.1 — Deletion proof (AC-6.1, AC-6.2)
`retirement.test.ts`
- public-API surface snapshot: export-name set of the package entry equals the checked-in SDK-only list (no `resolveNamedProvider`, no `registeredProviderNames`)
- package manifest has no `bin`
- full default suite green is the suite run itself; the SDK-coverage comparison is a one-time story-completion check recorded in the story DoD (suite files and their domain-operation coverage unchanged from pre-deletion, process files excepted)

### TC-6.2 — Resolution path gone (AC-6.3)
`retirement.test.ts`
- source scan: zero `LHC_PROVIDER` / `--provider` references under `src/`
- constructing with neither `provider` nor `inference` → the XOR `TypeError` (no fallback resolution path exists to catch it)

## Epic 03 Test Amendment Ledger (Flow 5 / Chunk 6)

Spec-sanctioned amendments (the Epic 02 F-3 pattern: named, reasoned, red-manifest regenerated):

| Existing test (in `view-boundary.test.ts` / fixtures) | Change | Reason |
|---|---|---|
| floor-protection legs (newest-whole-message floor, oversized-newest-result, floor-blocks-target cases) | superseded → replaced by newest-turn-protection legs in TC-5.2 | `floorTokens` retired (AC-5.4, DD-11) |
| per-intake-advance legs (advance fires on non-turn-end batches) | inverted → become TC-5.1's mid-turn-never-moves assertions | trigger moved (AC-5.1) |
| message-grained eviction goldens (G1 as cut for Epic 03) | re-cut for turn grouping | eviction granularity (AC-5.2) |
| construction tests passing `floorTokens` | updated to two-field budgets; one new test: passing `floorTokens` is rejected as unknown config | config surface change |
| status `zoneTokens` legs | unchanged — shared-query invariant holds | none needed |

Lifecycle/capstone deterministic legs (Epic 04's exercise) are untouched: they run the deterministic provider and never asserted boundary trigger timing.

## Red/Green per Chunk

House pattern: Red = failing tests + skeleton stubs returning structured not-implemented failures; `red-verify` (build, typecheck, lint, boundaries — no behavior tests); Green = implementation until the chunk's tests pass; immutability check on test files after Green.

| Chunk | Red writes | Green implements | Exit gate |
|-------|-----------|------------------|-----------|
| 0: Foundation | fixture self-conformance test; prompt-registry completeness test (against skeleton registry) | `inference/types.ts`, fixture builders, registry skeleton, provenance type additions | `red-verify` + fixture conformance green; boundaries check includes `inference/ ↛ domains/` |
| 1: CLI retirement | `retirement.test.ts` (snapshot list authored = the post-deletion expected set) | deletions, manifest, verify-script rewrite | TC-6.1, TC-6.2 green; full default suite green; DoD coverage comparison recorded |
| 2: Seam | `inference-construction`, `inference-routing` | XOR + validation in `sdk.ts`, adapter construction wiring | TC-1.1, TC-1.2 green |
| 3: Adapter + prompts | `inference-adapter`, `inference-prompts` + goldens | seven operations, templates, bounding, empty-output | TC-2.1–2.3 green |
| 4: Classification | `inference-classification` | table, `safeCall`, handler provenance copies | TC-3.1, TC-3.2 green; full Epic 02 derivation suites still green (machinery untouched proof) |
| 5: Real suite | `inference-real` (guard testable unkeyed) | OpenRouter fixture, accounting guard, capstone leg | unkeyed: not-ran record asserted in CI; keyed: TC-4.1–4.3 green locally (run recorded in story DoD with model used) |
| 6: Boundary | `view-boundary-turn-end` + amendment ledger applied | gate, grouping, peek-ahead, config change | TC-5.1–5.3 green; amended Epic 03 suite green; red-manifest regenerated |

**Story-completion accounting for Chunk 5:** the keyed run cannot gate CI (no secret in CI by design). The story's DoD requires a recorded keyed run — date, model, pass state — in the deviation/completion notes. A keyed run that has never happened blocks epic acceptance: the capstone is the integration-readiness gate, and an unexercised gate is the silent-skip failure mode this suite exists to prevent.

## Architecture-Risk Tests

| Risk | Test |
|------|------|
| Adapter parses model output for mechanical facts | TC-2.1's adversarial canned text (claims wrong outcome; stamp must come from record) |
| Validation drifts from `FormKind` union | TC-1.1 parameterizes over the exported union; a new kind fails the matrix automatically |
| Queue machinery quietly forked for inference | Chunk 4 exit gate: Epic 02 derivation suites green untouched |
| Boundary decision and status sum diverge | shared-query invariant + TC-5.3's status leg after each advance |
| Silent real-suite skip | TC-4.1's unkeyed leg asserts the not-ran record exists and is not a pass |
| Behavior test deleted with process suites | TC-6.1 snapshot + full-suite green + DoD coverage comparison |


## Current Run Index
- planner_turn_index: 3
- mode: resume
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-implement completed with outcome ready-for-verification and status ok.
- latest_response_kind: implementor-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/005-implementor.json
- older_response_count: 0
- caller_input_artifact_count: 0
- prior_self_note_count: 1
- latest_self_note: "After implementation, require verifier evidence for TC-1.1, TC-1.2, and the configured story gate before considering acceptance."

## Response Trail
<current_response>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/005-implementor.json
bytes: 7938
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "4fd1f7d7-7249-401b-a2bc-a3ec43de6893"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "469f8650-6354-4ece-8aab-220bbaeb8a44"
    continuation:
      provider: "claude-code"
      sessionId: "469f8650-6354-4ece-8aab-220bbaeb8a44"
      storyId: "02-inference-seam-and-model-assignment"
    outcome: "ready-for-verification"
    story:
      id: "02-inference-seam-and-model-assignment"
      title: "Story 2: Inference Seam and Model Assignment"
    planSummary: "Built the Epic 05 inference seam plus its Chunk-0 foundation: new src/inference/ layer (boundary types, failure-classification table, name-keyed prompt registry with seven pre-dial-in templates, createInferenceProvider adapter implementing DerivationProvider with per-kind assignment routing and config-copied provenance); createSdk now validates provider XOR inference first, then the complete assignment map by iterating the exported FORM_KINDS runtime set (missing kind, unknown kind key, unknown prompt, empty provider/model — each a TypeError naming the violation, no partial construction) and slots the adapter into the same resolved.provider slot direct injection uses; FormKind became a const-derived union and ProviderResult/DerivedFormMetadata gained the provenance fields; the boundaries check gained the inference-may-not-import-domains rule; scripted-host fixtures (recordingCall/scriptedCall/throwingCall/hangingCall/validAssignments) and parameterized seam-conformance helpers (assertModelCallContract, assertRoutingThroughSdk) back TC-1.1/TC-1.2, with the routing helpers asserting the actual serialized ModelCall inputs emitted during a real intake→drain across all seven kinds."
    changedFiles:
      -
        path: "src/inference/types.ts"
        reason: "New boundary vocabulary: ModelCall/ModelCallInput/ModelCallResult/ModelCallFailureKind, ModelAssignment, InferenceConfig, ResolvedInferenceConfig (AC-1.2)"
      -
        path: "src/inference/classify.ts"
        reason: "FAILURE_CLASSIFICATION table mapping failure kinds to retryable (DD-3); needed now so the adapter maps host failures onto ProviderResult"
      -
        path: "src/inference/adapter.ts"
        reason: "createInferenceProvider: per-kind assignment lookup, prompt render, host call with thrown-exception containment, result mapping with config-copied provenance (DD-2, AC-1.4)"
      -
        path: "src/inference/prompts/index.ts"
        reason: "PromptTemplate type, PROMPT_REGISTRY (name-keyed, DD-8), DEFAULT_PROMPT_NAMES per kind"
      -
        path: "src/inference/prompts/smoothing-v1.ts"
        reason: "Smoothing template (placeholder pending POC port — see openQuestions)"
      -
        path: "src/inference/prompts/tool-call-v1.ts"
        reason: "Pre-dial-in tool-call summary template"
      -
        path: "src/inference/prompts/tool-result-v1.ts"
        reason: "Pre-dial-in tool-result summary template (system text per tech-design worked example)"
      -
        path: "src/inference/prompts/turn-compose-v1.ts"
        reason: "Pre-dial-in turn rendering template over RenderingPart[]"
      -
        path: "src/inference/prompts/lower-band-v1.ts"
        reason: "Pre-dial-in lower-band projection template"
      -
        path: "src/inference/prompts/chunk-detailed-v1.ts"
        reason: "Pre-dial-in detailed chunk summary template (projections + receipts)"
      -
        path: "src/inference/prompts/chunk-brief-v1.ts"
        reason: "Pre-dial-in brief chunk summary template (projections + outcomes only)"
      -
        path: "src/shared/derivation.ts"
        reason: "FORM_KINDS runtime const with FormKind derived from it (validation-drift risk mitigation); ProviderProvenance; provenance? on ProviderResult ok-branch and DerivedFormMetadata (DD-4 types); SdkConfig provider?/inference? XOR shape"
      -
        path: "src/sdk.ts"
        reason: "XOR rule validated first; resolveInferenceProvider assignment validation over FORM_KINDS; adapter construction into resolved.provider; type-only exports of the inference vocabulary (value-export surface unchanged, retirement snapshot holds)"
      -
        path: "scripts/check-boundaries.mjs"
        reason: "inference/ may not import domains/ (chunk-0 exit-gate rule)"
      -
        path: "test/fixtures/model-call.ts"
        reason: "Scripted-host builders: recordingCall, scriptedCall, throwingCall, hangingCall, validAssignments, cannedResponses (fixture contract, Chunk 0)"
      -
        path: "test/fixtures/seam-conformance.ts"
        reason: "assertModelCallContract and assertRoutingThroughSdk — parameterized so TC-4.3 reruns them against the real host unchanged (DD-13)"
      -
        path: "test/fixtures/index.ts"
        reason: "Re-export the new fixture builders and conformance helpers"
      -
        path: "test/inference-construction.test.ts"
        reason: "TC-1.1 construction matrix; missing-kind cases parameterized over the exported FORM_KINDS set"
      -
        path: "test/inference-routing.test.ts"
        reason: "TC-1.2 routing: seven-lane log assertions, single-turn message shape, three-lane mixed config, fixture conformance leg"
      -
        path: "test/red-manifest.json"
        reason: "Recorded the two new story test files for the green-phase immutability gate"
    tests:
      added:
        - "test/inference-construction.test.ts"
        - "test/inference-routing.test.ts"
      modified:
[]
      removed:
[]
      totalAfterStory: 327
      deltaFromPriorBaseline: 18
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/inference-construction.test.ts test/inference-routing.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify-all"
        result: "pass"
      -
        command: "cd packages/lhc && node scripts/check-test-immutability.mjs"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "Initial XOR check only caught the neither-supplied case; both-supplied now throws the same rule-naming TypeError before any downstream validation"
        - "FormKind validation initially risked a second literal list; replaced with the exported FORM_KINDS const that both sdk.ts validation and the parameterized tests iterate"
        - "fixtures/index.ts re-export was missing the FormKind type alias (typecheck failure), fixed"
      findingsSurfaced:
        - "FAILURE_CLASSIFICATION (a Chunk-4 deliverable) was forward-built because the adapter cannot map ModelCallResult failures onto ProviderResult.retryable without it; safeCall (timeout race), empty-output rejection, input bounding, and handler provenance copies were deliberately NOT built — they belong to Stories 3–4"
        - "Adapter failure reason format is 'kind: message' (kind-prefixed for machine readability per the sweep classification vocabulary, message preserved for the audit trail); DD-3 reads literally as reason = kind alone — Story 4's classification tests should pin the final format"
        - "Adapter stamps provenance on ok results (DD-4's adapter half); handlers do not yet copy it into form metadata, so it is currently dropped at the completion write — Story 4 ('handler provenance copies') lands that half"
    openQuestions:
      - "The POC's settled smoothing prompt text is not in this repository (referenced POC commits 1cf2dc45/6a9aa7a4/f12a850d are elsewhere); smoothing-v1 ships as a standard-conformant placeholder. The Story 3 implementor needs the POC source to port it verbatim per AC-2.3."
    specDeviations:
      - "classify.ts's FAILURE_CLASSIFICATION table landed in this story rather than Chunk 4 (adapter result mapping requires it); the table matches the AC-3.1 mapping exactly and Chunk 4's tests will assert it as data"
    recommendedNextStep: "Proceed to Story 3 (adapter + prompts): port the POC smoothing prompt verbatim, add the seven prompt goldens, empty-output rejection, input bounding (DD-7), and the TC-2.x adapter suites against the seam built here."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/005-implementor.json"
  startedAt: "2026-06-12T21:44:55.624Z"
  finishedAt: "2026-06-12T21:59:56.435Z"
```
</current_response>

<history_responses>
No older response entries are recorded yet.
</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/story-lead/001-current.json
Bytes: 2185

```yaml
storyRunId: "02-inference-seam-and-model-assignment-story-run-001"
storyId: "02-inference-seam-and-model-assignment"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-implement completed with outcome ready-for-verification and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "final-package"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/story-lead/001-final-package.json"
    provenance: "current-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/005-implementor.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "469f8650-6354-4ece-8aab-220bbaeb8a44"
    storyId: "02-inference-seam-and-model-assignment"
latestEventSequence: 10
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "No recoverable child implementation result is recorded; the prior story-implement attempt was interrupted by provider unavailability before producing evidence. Restarting implementation is the smallest safe action that advances the running story attempt."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/005-implementor.json"
replayBoundary: null
updatedAt: "2026-06-12T21:59:56.445Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After implementation, require verifier evidence for TC-1.1, TC-1.2, and the configured story gate before considering acceptance.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-12T21:31:09.751Z; note="After implementation, require verifier evidence for TC-1.1, TC-1.2, and the configured story gate before considering acceptance."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/story-lead/001-events.jsonl
Bytes: 5913

```yaml
-
  storyRunId: "02-inference-seam-and-model-assignment-story-run-001"
  sequence: 1
  timestamp: "2026-06-12T21:30:53.585Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "02-inference-seam-and-model-assignment-story-run-001"
  sequence: 2
  timestamp: "2026-06-12T21:31:09.729Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ebdbe-baa5-77c3-9dae-80e5226740b3"
-
  storyRunId: "02-inference-seam-and-model-assignment-story-run-001"
  sequence: 3
  timestamp: "2026-06-12T21:31:09.750Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation, require verifier evidence for TC-1.1, TC-1.2, and the configured story gate before considering acceptance."
-
  storyRunId: "02-inference-seam-and-model-assignment-story-run-001"
  sequence: 4
  timestamp: "2026-06-12T21:31:09.751Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation, require verifier evidence for TC-1.1, TC-1.2, and the configured story gate before considering acceptance."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "02-inference-seam-and-model-assignment-story-run-001"
  sequence: 5
  timestamp: "2026-06-12T21:37:22.573Z"
  type: "child-process-stopped"
  summary: "Stopped stale story-implement provider process 86416 after interruption handling."
  data:
    storyId: "02-inference-seam-and-model-assignment"
    storyRunId: "02-inference-seam-and-model-assignment-story-run-001"
    command: "story-implement"
    artifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/003-implementor.json"
    statusArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/progress/003-implementor.status.json"
    cleanedUpAt: "2026-06-12T21:37:22.573Z"
    provider: "claude-code"
    pid: 86416
    streamPaths:
      stdoutPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/streams/003-implementor.stdout.log"
      stderrPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/streams/003-implementor.stderr.log"
-
  storyRunId: "02-inference-seam-and-model-assignment-story-run-001"
  sequence: 6
  timestamp: "2026-06-12T21:37:22.586Z"
  type: "child-operation-failed"
  summary: "story-implement returned a failed runtime envelope before producing a recoverable child result."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/story-lead/001-final-package.json"
  data:
    terminalDecision: "interrupted"
    recoveryBoundary:
      smallestSafeStep: "resume-current-attempt"
      reasoning: "The attempt was interrupted and recorded a terminal recovery package, so the safest replay point is the current durable story-run snapshot."
      validArtifactPaths:
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/001-story-validate.json"
      requiresFreshStoryLeadSession: false
      requiresFreshChildProviderSession: false
    command: "story-implement"
    outcome: "blocked"
    status: "blocked"
    errors:
      -
        code: "PROVIDER_UNAVAILABLE"
        message: "Provider execution failed for claude-code."
    artifactPaths:
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/003-implementor.json"
-
  storyRunId: "02-inference-seam-and-model-assignment-story-run-001"
  sequence: 7
  timestamp: "2026-06-12T21:39:59.131Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
-
  storyRunId: "02-inference-seam-and-model-assignment-story-run-001"
  sequence: 8
  timestamp: "2026-06-12T21:44:55.568Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019ebdc7-0da1-7b73-9046-87039a66fabe"
-
  storyRunId: "02-inference-seam-and-model-assignment-story-run-001"
  sequence: 9
  timestamp: "2026-06-12T21:44:55.589Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "02-inference-seam-and-model-assignment-story-run-001"
  sequence: 10
  timestamp: "2026-06-12T21:59:56.445Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/02-inference-seam-and-model-assignment/005-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
```

## State Rules
### state-rules
Bytes: 2986

Requirements source for story-local acceptance: the story file and test plan below.
Current lifecycle state: awaiting_story_lead_action

Lifecycle rules:
State: initialized
Public status: running
Allowed actions: none
Meaning: Runtime scaffolding exists, but no planner turn or child operation has started yet.
Caller implication: Treat this as startup bookkeeping only; wait for the first planner transition before routing work.

State: awaiting_story_lead_action
Public status: running
Allowed actions: run-implement, run-continue, run-self-review, run-verify, run-quick-fix, accept-story, request-ruling, block-story, fail-story
Meaning: The durable record is ready and the next fresh story-lead turn may choose one bounded action.
Caller implication: Planner output is the next source of truth; the run is waiting for a valid bounded action selection.

State: running_child_operation
Public status: running
Allowed actions: none
Meaning: The runtime is executing one bounded child operation selected by the story lead.
Caller implication: Poll runtime artifacts instead of rerouting; the current child operation is still in flight.

State: recording_result
Public status: running
Allowed actions: none
Meaning: The child result or terminal decision is being written to durable artifacts before the next transition.
Caller implication: Do not treat the run as advanced until evidence and ledger updates are durably recorded.

State: terminal
Public status: terminal-only
Allowed actions: none
Meaning: A terminal public outcome has been recorded separately from lifecycleState and the story-lead loop will not continue automatically.
Caller implication: Read the public status and final package to decide impl-lead follow-up such as accept, reopen, or ruling.

Terminal outcome rules:
Outcome: accepted
Meaning: Story-lead evidence is complete enough to recommend acceptance for impl-lead review.
Caller implication: Impl-lead still owes receipt completion, verification gates, and the story commit before accepting the story.

Outcome: needs-ruling
Meaning: The run reached a boundary that requires an explicit caller or maintainer decision.
Caller implication: Surface the ruling request instead of guessing or downgrading the decision into cleanup debt.

Outcome: blocked
Meaning: A named blocker prevents safe forward progress with the current inputs or runtime state.
Caller implication: Resolve the blocker or change the plan before resuming; do not pretend the story is ready to continue.

Outcome: failed
Meaning: An unrecoverable runtime or planner failure ended the current story-lead attempt.
Caller implication: Inspect the failure details and durable artifacts before deciding whether to replay or open a new attempt.

Outcome: interrupted
Meaning: The run stopped before a planned transition finished, usually because the caller or runtime interrupted it.
Caller implication: Use status or resume against the durable artifacts to continue from the last safe checkpoint.

## Runtime Settings
### runtime-settings
Bytes: 255

```yaml
storyGate: "cd packages/lhc && pnpm run verify"
epicGate: "cd packages/lhc && pnpm run verify-all"
plannerTimeoutMs: 600000
wholeRunTimeoutMs: 7200000
providerStartupTimeoutMs: 300000
providerActiveSilenceTimeoutMs: 600000
```

## Action Protocol
Return exactly one JSON object matching `StoryLeadAction`.

Examples:
{"action":"run-implement","rationale":"...","inputs":{"promptAddendum":"optional"},"selfNote":"optional durable reminder"}
{"action":"run-continue","rationale":"...","inputs":{"continuationRef":"storyImplementor","promptAddendum":"..."}}
{"action":"run-self-review","rationale":"...","inputs":{"artifactRefs":["/abs/path.json"],"focus":"optional","continuationRef":"storyImplementor","passes":1}}
{"action":"run-verify","rationale":"...","inputs":{"artifactRefs":["/abs/path.json"],"focus":"optional","provider":"codex"}}
{"action":"run-verify","rationale":"...","inputs":{"artifactRefs":["/abs/path.json"],"verifierContinuationRef":"storyVerifier","responseArtifactRef":"/abs/path.json"}}
{"action":"run-quick-fix","rationale":"...","inputs":{"findingRefs":["finding-001"],"remediationGoal":"...","workingDirectory":"optional"}}
{"action":"request-ruling","rationale":"...","inputs":{"decisionType":"...","question":"...","defaultRecommendation":"...","evidence":["..."],"allowedResponses":["..."]}}
{"action":"accept-story","rationale":"...","inputs":{"summary":"...","acceptanceCheckRefs":["..."],"acceptanceChecks":[{"name":"...","status":"pass","evidence":["..."],"reasoning":"..."}],"recommendedImplLeadAction":"accept"},"verification":{"finalVerifierOutcome":"pass","findings":[{"id":"...","status":"fixed","evidence":["..."]}]}}
{"action":"block-story","rationale":"...","inputs":{"reason":"...","detail":"optional","evidence":["..."]},"verification":{"finalVerifierOutcome":"block","findings":[{"id":"...","status":"unresolved","evidence":["..."]}]}}
{"action":"fail-story","rationale":"...","inputs":{"reason":"...","detail":"optional","evidence":["..."]}}

Rules:
- Choose exactly one bounded next action.
- Use only the durable story-run record in this prompt. Do not assume hidden retained planner memory exists.
- Treat `<current_response>` as the latest bounded child response and `<history_responses>` as older response history.
- If the story file and test plan are insufficient for a safe next step, request a ruling instead of asking for epic, tech design, git status, or git diff by default.
- Include `selfNote` only when you want to leave a durable reminder for a later planner turn.

## Acceptance Rubric
Choose the smallest safe bounded action that advances the story using the durable evidence already present.
Prefer continuing from valid child-operation evidence over repeating work, and keep unresolved authority-boundary questions explicit.

## Acceptance Decision Standard
Choose `accept-story` only when the latest verifier result is `pass`, no open findings remain, required proof is present, and the configured story gate passed.
If readiness is promising but gate truth is failed, unavailable, or uncertain, do not accept. Choose the smallest safe next action: verify, quick-fix, block, or request a ruling.

## Ruling Boundaries
Request a ruling when story-local requirements are insufficient, when a blocker needs a caller decision, or when the evidence conflicts in a way that the durable record cannot resolve safely.
