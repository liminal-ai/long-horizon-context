# Story Lead Base Prompt

## Role Charter
You are the story lead for `04-failure-classification` on durable story run `04-failure-classification-story-run-001`.
Select exactly one bounded next action for this `resume` turn.
This is planner turn 4.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/04-failure-classification.md
Bytes: 9244

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
- planner_turn_index: 4
- mode: resume
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: ruling-received
- current_child_operation: none
- current_summary: Caller ruling recorded and story-lead finalization is resuming.
- latest_response_kind: verifier-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/004-verify.json
- older_response_count: 1
- caller_input_artifact_count: 1
- prior_self_note_count: 1
- latest_self_note: "After implementation, verify table assertion, retryable success-after-retry, terminal auth one-call failure, network exhaustion, thrown exception containment, and timeout containment evidence before considering acceptance."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/004-verify.json
bytes: 4239
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "pass"
  result:
    resultId: "4ba39fe5-6bfb-454c-ae15-560c0a7524d2"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019ebe17-2df1-7e83-b2c6-c525b191c92c"
    continuation:
      provider: "codex"
      sessionId: "019ebe17-2df1-7e83-b2c6-c525b191c92c"
      storyId: "04-failure-classification"
    mode: "initial"
    story:
      id: "04-failure-classification"
      title: "Story 4: Failure Classification"
    artifactsRead:
      - "packages/lhc/docs/02-specs/05-derivation-inference/stories/04-failure-classification.md"
      - "packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md"
      - "packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md"
      - "packages/lhc/docs/02-specs/05-derivation-inference/epic.md"
      - "packages/lhc/docs/02-specs/05-derivation-inference/team-impl-log.md"
      - "packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/003-implementor.json"
      - "packages/lhc/src/inference/classify.ts"
      - "packages/lhc/src/inference/adapter.ts"
      - "packages/lhc/src/inference/types.ts"
      - "packages/lhc/src/sdk.ts"
      - "packages/lhc/src/shared/derivation.ts"
      - "packages/lhc/src/tech-utils/work-queue/index.ts"
      - "packages/lhc/test/inference-classification.test.ts"
      - "packages/lhc/test/fixtures/model-call.ts"
      - "packages/lhc/test/red-manifest.json"
    reviewScopeSummary: "Verified Story 4 failure classification against AC-3.1 through AC-3.3 and TC-3.1 through TC-3.2. Checked classification table, safeCall containment, adapter failure mapping, unchanged Epic 02 queue ownership, story tests, red-manifest hashes, and configured gates."
    priorFindingStatuses:
[]
    newFindings:
[]
    openFindings:
[]
    requirementCoverage:
      verified:
        - "AC-3.1: FAILURE_CLASSIFICATION in packages/lhc/src/inference/classify.ts:15-23 matches the exact retryable/terminal table, and packages/lhc/test/inference-classification.test.ts:129-138 asserts it directly as data."
        - "AC-3.2 / TC-3.1: packages/lhc/test/inference-classification.test.ts:141-199 covers rate_limit retry-to-success with attempts, auth terminal first-attempt failure with one call, and network exhaustion with provider_failure-led reason plus metadata.lastError. packages/lhc/src/tech-utils/work-queue/index.ts:388-416 remains the retry/exhaustion owner, and git diff showed no queue/domain handler changes for this story."
        - "AC-3.3 / TC-3.2: safeCall catches rejected and synchronous throws as other and races timeout in packages/lhc/src/inference/classify.ts:26-56. The adapter calls the host through safeCall in packages/lhc/src/inference/adapter.ts:70-79. packages/lhc/test/inference-classification.test.ts:204-328 covers thrown mid-drain, timeout continuation, retryable timeout success, and direct safeCall containment legs."
        - "Story gate and epic gate: targeted classification suite, pnpm run verify, pnpm run verify-all, and green-verify all passed locally."
      unverified:
[]
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/inference-classification.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify-all"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run green-verify"
        result: "pass"
    productionPathFindings:
[]
    recommendedNextStep: "pass"
    recommendedFixScope: "same-session-implementor"
    openQuestions:
[]
    additionalObservations:
      - "Production path audit found no material fake adapter, shim, placeholder, or fallback execution path in the story-owned production files. Test fakes are confined to packages/lhc/test/fixtures/model-call.ts."
      - "The retryable reason format follows the approved Story 3 team-impl-log ruling: retryable failures lead with provider_failure and terminal failures are kind-led. Tests consume that approved format."
      - "test-immutability passed; sha256 evidence matched red-manifest entries for inference-classification.test.ts and inference-prompts.test.ts."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/004-verify.json"
  startedAt: "2026-06-12T23:07:30.500Z"
  finishedAt: "2026-06-12T23:11:30.060Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/003-implementor.json
bytes: 6063
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "d5b5a0ec-5aa8-47d9-bf37-17f1c27b2b8c"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "6f6a66f7-9908-4860-b5a4-ba92a559f344"
    continuation:
      provider: "claude-code"
      sessionId: "6f6a66f7-9908-4860-b5a4-ba92a559f344"
      storyId: "04-failure-classification"
    outcome: "ready-for-verification"
    story:
      id: "04-failure-classification"
      title: "Story 4: Failure Classification"
    planSummary: "Story 4 (failure classification): implemented safeCall in src/inference/classify.ts — an async wrapper folding thrown host exceptions (sync or rejected) into structured { ok: false, kind: 'other' } failures and racing the adapter-owned timeout into { ok: false, kind: 'timeout' }, with timer cleanup on settle. Rewired src/inference/adapter.ts to call the host exclusively through safeCall(config.call, input, config.timeoutMs), replacing the Story 3 interim inline try/catch; the existing classifiedFailure mapping (FAILURE_CLASSIFICATION table → ProviderResult { ok: false, retryable, reason }) is unchanged and consumes the timeout/other kinds through the same table. FAILURE_CLASSIFICATION itself landed in Story 2 per its approved deviation ruling; this story asserts it directly as data per AC-3.1. No queue, drain, state, or handler changes — Epic 02 machinery proven unchanged by the full suite staying green. Tests follow the Story 3 reason-format ruling: retryable reasons are 'provider_failure: <kind>: <message>', terminal kinds are kind-led."
    changedFiles:
      -
        path: "packages/lhc/src/inference/classify.ts"
        reason: "Added safeCall (try/catch containment classifying thrown exceptions as `other`, Promise.race timeout classifying as `timeout`, timer cleared on settle); updated header comment to reflect containment now living here"
      -
        path: "packages/lhc/src/inference/adapter.ts"
        reason: "Replaced the Story 3 interim inline try/catch with safeCall(config.call, input, config.timeoutMs); removed now-unused ModelCallResult import; updated header comment"
      -
        path: "packages/lhc/test/inference-classification.test.ts"
        reason: "New story-owned suite: TC-3.1 (exact table assertion, rate_limit×2-then-success with attempts recorded, terminal auth single-call, network exhaustion with lastError) and TC-3.2 (throwing host on one kind amid a multi-kind drain, hanging host timeout legs, direct safeCall unit legs)"
      -
        path: "packages/lhc/test/red-manifest.json"
        reason: "Recorded Red hash for inference-classification.test.ts; re-recorded inference-prompts.test.ts to its accepted HEAD content (pre-existing stale hash from Story 3's sanctioned SV-03-001 fix — see findingsSurfaced)"
    tests:
      added:
        - "test/inference-classification.test.ts (12 tests: 4 TC-3.1 legs, 3 TC-3.2 drain legs, 5 safeCall unit legs)"
      modified:
[]
      removed:
[]
      totalAfterStory: 365
      deltaFromPriorBaseline: 12
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/inference-classification.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run red-verify (Red phase: build, typecheck, lint, boundaries with safeCall stub + recorded manifest; targeted suite confirmed failing 7/12 before Green)"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run green-verify (verify + test-immutability: OK, 49 Red-phase files unchanged)"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify-all"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "Caught a typo in my draft table assertion (auth marked retryable: true) before recording the Red manifest; corrected to retryable: false per AC-3.1"
        - "safeCall clears its timeout timer in a finally around the race, so a settled host call never leaves a live timer; a never-settling host leaves only an already-fired timer"
        - "Added a sync-throwing-host safeCall leg beyond the story's throwingCall requirement — the host's promise contract is not trusted (async wrapper folds synchronous throws into the same `other` path)"
      findingsSurfaced:
        - "Pre-existing red-manifest drift, not from this story: test/inference-prompts.test.ts as committed in HEAD (Story 3, accepted) hashed c747a4d… while the committed manifest held the pre-SV-03-001-fix hash 0d354e…, so green-verify's immutability check failed before any Story 4 change. The Story 3 fix was verifier-sanctioned and accepted, but the manifest was never re-recorded (Story 3's gates used `verify`, which skips the immutability check). I re-recorded that one hash to the accepted HEAD content; the file itself is untouched by this story (git shows no diff on it)."
        - "Workspace carried pre-existing uncommitted modifications unrelated to this story (AGENTS.md, Epic 04 docs, scripts/check-boundaries.mjs, new Epic 05 doc files) — present in git status before implementation began; left untouched."
    openQuestions:
[]
    specDeviations:
      - "None in behavior. Bookkeeping note: re-recorded the stale Story 3 hash for test/inference-prompts.test.ts in test/red-manifest.json (file content unchanged from the accepted Story 3 commit) so the immutability guard's baseline matches the accepted state; flagged for impl-lead ratification since the manifest entry belongs to a prior story."
    recommendedNextStep: "Proceed to verification. Verifier should confirm: (1) the adapter's only host-call path is safeCall (no residual inline try/catch), (2) the inference-prompts manifest re-record matches HEAD content exactly (git diff shows no change to the test file itself), (3) Epic 02 derivation suites green untouched (verify-all 365/365). Then Story 5 (real suite + capstone) per chunk order."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/003-implementor.json"
  startedAt: "2026-06-12T22:59:18.171Z"
  finishedAt: "2026-06-12T23:07:18.760Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/story-lead/001-current.json
Bytes: 3155

```yaml
storyRunId: "04-failure-classification-story-run-001"
storyId: "04-failure-classification"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Caller ruling recorded and story-lead finalization is resuming."
currentPhase: "ruling-received"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/003-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/004-verify.json"
    provenance: "current-run"
  -
    kind: "final-package"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/story-lead/001-final-package.json"
    provenance: "current-run"
  -
    kind: "ruling-response"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/story-lead/001-ruling-response-001.json"
    provenance: "caller-input"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "6f6a66f7-9908-4860-b5a4-ba92a559f344"
    storyId: "04-failure-classification"
  storyVerifier:
    provider: "codex"
    sessionId: "019ebe17-2df1-7e83-b2c6-c525b191c92c"
    storyId: "04-failure-classification"
latestEventSequence: 13
callerInputHistory:
  reviewRequests:
[]
  rulings:
    -
      rulingRequestId: "04-failure-classification-story-run-001-ruling-spec-deviation"
      decision: "approve"
      rationale: "Approved: the only flagged item is bookkeeping — re-recording the stale Story 3 hash for test/inference-prompts.test.ts in test/red-manifest.json. Impl-lead verified via git that the test file content is unchanged from the accepted Story 3 commit (b7139e1), so the manifest update aligns the immutability baseline with accepted state and changes no behavior. Ratified."
      source: "impl-lead"
nextIntent:
  actionType: "apply-ruling"
  summary: "04-failure-classification-story-run-001-ruling-spec-deviation: approve"
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/story-lead/001-ruling-response-001.json"
replayBoundary: null
updatedAt: "2026-06-12T23:14:47.272Z"
```

## Caller Input Artifacts

### ruling-response
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/story-lead/001-ruling-response-001.json
Bytes: 528

```yaml
rulingRequestId: "04-failure-classification-story-run-001-ruling-spec-deviation"
decision: "approve"
rationale: "Approved: the only flagged item is bookkeeping — re-recording the stale Story 3 hash for test/inference-prompts.test.ts in test/red-manifest.json. Impl-lead verified via git that the test file content is unchanged from the accepted Story 3 commit (b7139e1), so the manifest update aligns the immutability baseline with accepted state and changes no behavior. Ratified."
source: "impl-lead"
```

## Prior Self Notes
Latest note highlight: After implementation, verify table assertion, retryable success-after-retry, terminal auth one-call failure, network exhaustion, thrown exception containment, and timeout containment evidence before considering acceptance.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-12T22:59:18.135Z; note="After implementation, verify table assertion, retryable success-after-retry, terminal auth one-call failure, network exhaustion, thrown exception containment, and timeout containment evidence before considering acceptance."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/story-lead/001-events.jsonl
Bytes: 5568

```yaml
-
  storyRunId: "04-failure-classification-story-run-001"
  sequence: 1
  timestamp: "2026-06-12T22:59:09.496Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "04-failure-classification-story-run-001"
  sequence: 2
  timestamp: "2026-06-12T22:59:18.113Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ebe0f-88ed-77f3-8a6c-0ded38735f5c"
-
  storyRunId: "04-failure-classification-story-run-001"
  sequence: 3
  timestamp: "2026-06-12T22:59:18.135Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation, verify table assertion, retryable success-after-retry, terminal auth one-call failure, network exhaustion, thrown exception containment, and timeout containment evidence before considering acceptance."
-
  storyRunId: "04-failure-classification-story-run-001"
  sequence: 4
  timestamp: "2026-06-12T22:59:18.135Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation, verify table assertion, retryable success-after-retry, terminal auth one-call failure, network exhaustion, thrown exception containment, and timeout containment evidence before considering acceptance."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "04-failure-classification-story-run-001"
  sequence: 5
  timestamp: "2026-06-12T23:07:18.770Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "04-failure-classification-story-run-001"
  sequence: 6
  timestamp: "2026-06-12T23:07:30.443Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019ebe17-0193-7ca3-aa0b-fb54f41c4ee5"
-
  storyRunId: "04-failure-classification-story-run-001"
  sequence: 7
  timestamp: "2026-06-12T23:07:30.462Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "04-failure-classification-story-run-001"
  sequence: 8
  timestamp: "2026-06-12T23:11:30.070Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome pass and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/004-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "pass"
    status: "ok"
-
  storyRunId: "04-failure-classification-story-run-001"
  sequence: 9
  timestamp: "2026-06-12T23:11:43.251Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/story-lead/prompts/001-planner-turn-003.md"
    sessionId: "019ebe1a-d6f3-74e3-b988-2e3c8456e84c"
-
  storyRunId: "04-failure-classification-story-run-001"
  sequence: 10
  timestamp: "2026-06-12T23:11:43.287Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected accept-story."
  data:
    actionType: "accept-story"
    turn: 3
-
  storyRunId: "04-failure-classification-story-run-001"
  sequence: 11
  timestamp: "2026-06-12T23:11:43.319Z"
  type: "needs-ruling"
  summary: "Story-lead finalized 04-failure-classification-story-run-001 with outcome needs-ruling."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/story-lead/001-final-package.json"
  data:
    terminalDecision: "accept"
-
  storyRunId: "04-failure-classification-story-run-001"
  sequence: 12
  timestamp: "2026-06-12T23:14:47.217Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
-
  storyRunId: "04-failure-classification-story-run-001"
  sequence: 13
  timestamp: "2026-06-12T23:14:47.271Z"
  type: "ruling-received"
  summary: "Caller ruling received for 04-failure-classification-story-run-001-ruling-spec-deviation."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/04-failure-classification/story-lead/001-ruling-response-001.json"
  data:
    rulingRequestId: "04-failure-classification-story-run-001-ruling-spec-deviation"
    decision: "approve"
    source: "impl-lead"
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
