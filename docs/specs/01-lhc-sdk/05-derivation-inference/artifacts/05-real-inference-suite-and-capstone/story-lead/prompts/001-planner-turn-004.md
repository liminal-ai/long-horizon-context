# Story Lead Base Prompt

## Role Charter
You are the story lead for `05-real-inference-suite-and-capstone` on durable story run `05-real-inference-suite-and-capstone-story-run-001`.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/05-real-inference-suite-and-capstone.md
Bytes: 10849

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
- current_phase: story-orchestrate-resume
- current_child_operation: none
- current_summary: Story orchestration resume requested and durable state has been reopened.
- latest_response_kind: verifier-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/004-verify.json
- older_response_count: 1
- caller_input_artifact_count: 0
- prior_self_note_count: 2
- latest_self_note: "If verifier passes unkeyed/default behavior but keyed run evidence is still absent, do not accept; request ruling or block on the missing keyed proof required by the story DoD."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/004-verify.json
bytes: 8278
payload:
  command: "story-verify"
  version: 1
  status: "blocked"
  outcome: "block"
  result:
    resultId: "4e498349-81ad-4659-b3e3-e0ff5103c649"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019ebe2c-e38d-7d73-ab55-af3a2ba17a06"
    continuation:
      provider: "codex"
      sessionId: "019ebe2c-e38d-7d73-ab55-af3a2ba17a06"
      storyId: "05-real-inference-suite-and-capstone"
    mode: "initial"
    story:
      id: "05-real-inference-suite-and-capstone"
      title: "Story 5: Real-Inference Suite and Capstone"
    artifactsRead:
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/AGENTS.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/05-real-inference-suite-and-capstone.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/coverage.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/team-impl-log.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/001-story-validate.json"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/003-implementor.json"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/package.json"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/inference-real.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/fixtures/openrouter-call.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/fixtures/lifecycle.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/fixtures/seam-conformance.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/fixtures/index.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/fixtures/model-call.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/inference/adapter.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/inference/types.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/inference/classify.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/sdk.ts"
    reviewScopeSummary: "Initial verification for Story 5 covered AC-4.1, AC-4.2, TC-4.1, TC-4.2, and TC-4.3. I inspected the OpenRouter test host, suite accounting guard, keyed test wiring, shared seam helpers, lifecycle capstone wiring, package scripts, and relevant production inference paths; I ran the configured story and epic gates plus the focused unkeyed real-suite test."
    priorFindingStatuses:
[]
    newFindings:
      -
        id: "SV-05-001"
        severity: "major"
        title: "Required keyed real-inference proof is missing"
        evidence: "The required keyed evidence was not established: the local environment has no LHC_OPENROUTER_KEY, `pnpm exec vitest run test/inference-real.test.ts` printed `NOT-RAN: real-inference (LHC_OPENROUTER_KEY unset)` and reported `4 passed | 9 skipped`, so the keyed TC-4.1, TC-4.2, and TC-4.3 legs did not execute. The implementor artifact also records that the keyed local run and completion note are absent. The story DoD requires TC-4.1, TC-4.2, and TC-4.3 green in a keyed local run and completion notes with date, model, and pass state; test-plan.md states an unexercised keyed run blocks acceptance."
        affectedFiles:
          - "packages/lhc/test/inference-real.test.ts"
          - "packages/lhc/test/fixtures/openrouter-call.ts"
          - "packages/lhc/docs/02-specs/05-derivation-inference/stories/05-real-inference-suite-and-capstone.md"
          - "packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md"
          - "packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/003-implementor.json"
        requirementIds:
          - "AC-4.1"
          - "AC-4.2"
          - "TC-4.1"
          - "TC-4.2"
          - "TC-4.3"
          - "Definition of Done"
        recommendedFixScope: "human-ruling"
        blocking: true
    openFindings:
      -
        id: "SV-05-001"
        severity: "major"
        title: "Required keyed real-inference proof is missing"
        evidence: "The required keyed evidence was not established: the local environment has no LHC_OPENROUTER_KEY, `pnpm exec vitest run test/inference-real.test.ts` printed `NOT-RAN: real-inference (LHC_OPENROUTER_KEY unset)` and reported `4 passed | 9 skipped`, so the keyed TC-4.1, TC-4.2, and TC-4.3 legs did not execute. The implementor artifact also records that the keyed local run and completion note are absent. The story DoD requires TC-4.1, TC-4.2, and TC-4.3 green in a keyed local run and completion notes with date, model, and pass state; test-plan.md states an unexercised keyed run blocks acceptance."
        affectedFiles:
          - "packages/lhc/test/inference-real.test.ts"
          - "packages/lhc/test/fixtures/openrouter-call.ts"
          - "packages/lhc/docs/02-specs/05-derivation-inference/stories/05-real-inference-suite-and-capstone.md"
          - "packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md"
          - "packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/003-implementor.json"
        requirementIds:
          - "AC-4.1"
          - "AC-4.2"
          - "TC-4.1"
          - "TC-4.2"
          - "TC-4.3"
          - "Definition of Done"
        recommendedFixScope: "human-ruling"
        blocking: true
    requirementCoverage:
      verified:
        - "TC-4.1 unkeyed accounting: resolveRealSuiteEnv returns a not-ran record for absent or blank key; emitRealSuiteAccounting records one visible line; unkeyed focused suite output showed exactly one NOT-RAN line."
        - "AC-4.1 fixture code path: createOpenRouterCall is test-owned code using plain fetch to the OpenRouter endpoint and maps HTTP/network failures to ModelCall failure kinds."
        - "TC-4.2 test wiring exists: runLifecycle accepts an InferenceConfig and inference-real.test.ts wires the real adapter into the Epic 04 lifecycle sequence when keyed."
        - "TC-4.3 test wiring exists: inference-real.test.ts invokes assertModelCallContract and assertRoutingThroughSdk against createOpenRouterCall when keyed."
      unverified:
        - "AC-4.1 keyed execution: no keyed evidence that all seven derivation kinds round-tripped real inference to ready non-empty non-marker forms."
        - "AC-4.2 keyed capstone: no keyed evidence that the real-adapter lifecycle completed with all kinds ready, real provenance, cleared-then-ready mutation behavior, and post-edit compact content."
        - "TC-4.3 keyed real-host conformance: the shared helper legs were skipped because LHC_OPENROUTER_KEY was unset."
        - "Definition of Done: no story completion note records keyed run date, model, and pass state."
    gatesRun:
      -
        command: "cd packages/lhc && pnpm run verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify-all"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm exec vitest run test/inference-real.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && LHC_OPENROUTER_KEY=<key> pnpm exec vitest run test/inference-real.test.ts"
        result: "not-run"
    productionPathFindings:
[]
    recommendedNextStep: "block"
    recommendedFixScope: "human-ruling"
    openQuestions:
      - "Provide a keyed run receipt for `cd packages/lhc && LHC_OPENROUTER_KEY=<key> pnpm exec vitest run test/inference-real.test.ts`, including date, model, and pass state, then rerun verification."
    additionalObservations:
      - "Default CI posture is behaving as designed: the unkeyed suite reports NOT-RAN visibly and the story/epic gates passed without a network key."
      - "No material production-path fake adapter, shim, or placeholder was found in the inspected inference production path; the OpenRouter host is confined to test fixtures."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/004-verify.json"
  startedAt: "2026-06-12T23:31:13.249Z"
  finishedAt: "2026-06-12T23:34:47.395Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/003-implementor.json
bytes: 6611
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "8a045ed8-52f2-4167-a2ec-a55326cb9daa"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "7428c05c-eec6-4310-9738-8828ad5ff5b2"
    continuation:
      provider: "claude-code"
      sessionId: "7428c05c-eec6-4310-9738-8828ad5ff5b2"
      storyId: "05-real-inference-suite-and-capstone"
    outcome: "ready-for-verification"
    story:
      id: "05-real-inference-suite-and-capstone"
      title: "Story 5: Real-Inference Suite and Capstone"
    planSummary: "Implemented Chunk 5 (Story 5: Real-Inference Suite and Capstone). Added the test-owned OpenRouter ModelCall host (test/fixtures/openrouter-call.ts) implementing the AC-1.2 contract over plain fetch with the story's HTTP-status→failure-kind mapping (401/403→auth, 429→rate_limit, 400→invalid_request, network→network, other→other), resolveRealSuiteEnv key/model resolution (LHC_OPENROUTER_MODEL optional, fixture default openai/gpt-4o-mini), and a suite-level accounting emitter that writes exactly one visible RAN/NOT-RAN line. Parameterized the Epic 04 lifecycle fixture with an optional InferenceConfig so the capstone replays the identical sequence with the real adapter in the provider-arrival slot. Wrote test/inference-real.test.ts: four always-run accounting tests (unkeyed not-ran record with reason, shape distinguishable from a pass, whitespace-key leg, model defaulting, exactly-one-emission assertion) plus key-gated legs — TC-4.3 runs the unchanged assertModelCallContract/assertRoutingThroughSdk seam-conformance helpers against the real host, TC-4.1 asserts all seven kinds land ready with non-empty non-marker content and config-stamped openrouter provenance, TC-4.2 runs the full Epic 04 lifecycle (intake→drain→compact→pull→inspect→edit→rebuild→drain→compact→materialize) asserting every kind ready ≥ once, no deterministic marker anywhere (forms, both pulls, materialized file), real-model provenance, cleared-then-ready regeneration with content different from the pre-edit snapshot, checkpoint-coherent health (settled / cleared-set-pending-unclaimed / settled), and post-edit content in the second compact's view. CI default makes zero network calls; keyed legs report as skipped (never passes) with one NOT-RAN line. No package.json change needed: Story 1's verify rewrite already runs the env-gated suite in the default vitest tier."
    changedFiles:
      -
        path: "packages/lhc/test/fixtures/openrouter-call.ts"
        reason: "New real host fixture: createOpenRouterCall (ModelCall over fetch, contract-conformant failure mapping, host-side slug interpretation of opaque routing keys), resolveRealSuiteEnv, and the one-line ran/not-ran accounting emitter with an inspectable emission log"
      -
        path: "packages/lhc/test/fixtures/index.ts"
        reason: "Export the OpenRouter fixture surface alongside the other seam fixtures"
      -
        path: "packages/lhc/test/fixtures/lifecycle.ts"
        reason: "createLifecycleSdk/runLifecycle gain an optional InferenceConfig so the TC-4.2 capstone replays the exact Epic 04 sequence with the real adapter; deterministic default unchanged"
      -
        path: "packages/lhc/test/inference-real.test.ts"
        reason: "New opt-in real-inference suite: TC-4.1 accounting + seven real round-trips, TC-4.2 lifecycle capstone structural assertions, TC-4.3 shared seam-conformance against the real host"
      -
        path: "packages/lhc/test/red-manifest.json"
        reason: "Recorded sha256 of test/inference-real.test.ts per the house Red-phase manifest pattern (record-red-manifest.mjs)"
    tests:
      added:
        - "test/inference-real.test.ts"
      modified:
[]
      removed:
[]
      totalAfterStory: 378
      deltaFromPriorBaseline: 13
    gatesRun:
      -
        command: "cd packages/lhc && pnpm run verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run green-verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify-all"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "Removed a union type cast in the keyed describe by hoisting realKey resolution to module scope with proper narrowing"
        - "Switched a vitest options-object timeout to the classic third-argument form for runner-version safety"
      findingsSurfaced:
        - "Keyed-run flake surface: assertRoutingThroughSdk asserts drain stops 'empty' with retry budget 3 / zero backoff, so sustained real-endpoint rate limiting could exhaust retries and fail the keyed leg; acceptable per spec (retryable classification is under test) but worth knowing when running keyed"
        - "TC-4.2's regeneration assertion (post-rebuild content !== pre-edit content) is probabilistic against a real model in principle, but mutation-cleared forms re-derive from changed inputs, so collision is implausible; it is the spec's own assertion"
        - "The healthAfterMutate queued/claimed:0 checkpoint reuses the lifecycle fixture's microtask-cascade timing guarantee, which is provider-independent (background drain always starts on a macrotask) — verified the guarantee documented in the fixture header still holds on the inference path"
    openQuestions:
      - "DoD item 'keyed seven-kind real round-trip / capstone green in keyed local run, recorded with date, model, pass state' cannot be completed in this environment: LHC_OPENROUTER_KEY is not set and no key exists in the repo or shell profile. A human must run `cd packages/lhc && LHC_OPENROUTER_KEY=<key> pnpm exec vitest run test/inference-real.test.ts` once and record date, model (default openai/gpt-4o-mini unless LHC_OPENROUTER_MODEL set), and pass state in the story completion notes. Per the test plan this blocks epic acceptance, not the unkeyed story gate, which is green."
    specDeviations:
      - "Implementation target 'Verify accounting: packages/lhc/package.json scripts' required no change — Story 1's verify/verify-all rewrite already runs the env-gated suite inside the default vitest tier, and the suite self-reports its one ran/not-ran line there (observed in gate output: 'NOT-RAN: real-inference (LHC_OPENROUTER_KEY unset)')."
    recommendedNextStep: "Run story verification; in parallel, have the operator perform the one keyed local run with LHC_OPENROUTER_KEY and record date/model/pass-state in the completion notes to satisfy the remaining DoD line before epic acceptance."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/003-implementor.json"
  startedAt: "2026-06-12T23:20:34.922Z"
  finishedAt: "2026-06-12T23:31:00.944Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/story-lead/001-current.json
Bytes: 2221

```yaml
storyRunId: "05-real-inference-suite-and-capstone-story-run-001"
storyId: "05-real-inference-suite-and-capstone"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Story orchestration resume requested and durable state has been reopened."
currentPhase: "story-orchestrate-resume"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/003-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/004-verify.json"
    provenance: "current-run"
  -
    kind: "final-package"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/story-lead/001-final-package.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "7428c05c-eec6-4310-9738-8828ad5ff5b2"
    storyId: "05-real-inference-suite-and-capstone"
  storyVerifier:
    provider: "codex"
    sessionId: "019ebe2c-e38d-7d73-ab55-af3a2ba17a06"
    storyId: "05-real-inference-suite-and-capstone"
latestEventSequence: 13
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "resume-attempt"
  summary: "Continue the existing durable story-lead attempt from its latest checkpoint."
replayBoundary: null
updatedAt: "2026-06-12T23:41:05.013Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: If verifier passes unkeyed/default behavior but keyed run evidence is still absent, do not accept; request ruling or block on the missing keyed proof required by the story DoD.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-12T23:20:34.878Z; note="After implementation, verify whether keyed OpenRouter proof is present. If no keyed run evidence exists, do not recommend acceptance until that gap is resolved or ruled on."
- sequence=8; actionSequence=7; createdAt=2026-06-12T23:31:13.215Z; note="If verifier passes unkeyed/default behavior but keyed run evidence is still absent, do not accept; request ruling or block on the missing keyed proof required by the story DoD."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/story-lead/001-events.jsonl
Bytes: 5791

```yaml
-
  storyRunId: "05-real-inference-suite-and-capstone-story-run-001"
  sequence: 1
  timestamp: "2026-06-12T23:20:24.124Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "05-real-inference-suite-and-capstone-story-run-001"
  sequence: 2
  timestamp: "2026-06-12T23:20:34.856Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ebe22-fbf4-7ce2-a5bc-75caa79274ac"
-
  storyRunId: "05-real-inference-suite-and-capstone-story-run-001"
  sequence: 3
  timestamp: "2026-06-12T23:20:34.877Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation, verify whether keyed OpenRouter proof is present. If no keyed run evidence exists, do not recommend acceptance until that gap is resolved or ruled on."
-
  storyRunId: "05-real-inference-suite-and-capstone-story-run-001"
  sequence: 4
  timestamp: "2026-06-12T23:20:34.878Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation, verify whether keyed OpenRouter proof is present. If no keyed run evidence exists, do not recommend acceptance until that gap is resolved or ruled on."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "05-real-inference-suite-and-capstone-story-run-001"
  sequence: 5
  timestamp: "2026-06-12T23:31:00.956Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "05-real-inference-suite-and-capstone-story-run-001"
  sequence: 6
  timestamp: "2026-06-12T23:31:13.195Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019ebe2c-b39e-7d21-aca1-5134f4777ea2"
-
  storyRunId: "05-real-inference-suite-and-capstone-story-run-001"
  sequence: 7
  timestamp: "2026-06-12T23:31:13.214Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
    selfNote: "If verifier passes unkeyed/default behavior but keyed run evidence is still absent, do not accept; request ruling or block on the missing keyed proof required by the story DoD."
-
  storyRunId: "05-real-inference-suite-and-capstone-story-run-001"
  sequence: 8
  timestamp: "2026-06-12T23:31:13.215Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "If verifier passes unkeyed/default behavior but keyed run evidence is still absent, do not accept; request ruling or block on the missing keyed proof required by the story DoD."
    actionSequence: 7
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "05-real-inference-suite-and-capstone-story-run-001"
  sequence: 9
  timestamp: "2026-06-12T23:34:47.405Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome block and status blocked."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/004-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "block"
    status: "blocked"
-
  storyRunId: "05-real-inference-suite-and-capstone-story-run-001"
  sequence: 10
  timestamp: "2026-06-12T23:34:59.453Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/story-lead/prompts/001-planner-turn-003.md"
    sessionId: "019ebe30-281a-7852-a4b2-36831a107dad"
-
  storyRunId: "05-real-inference-suite-and-capstone-story-run-001"
  sequence: 11
  timestamp: "2026-06-12T23:34:59.477Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected block-story."
  data:
    actionType: "block-story"
    turn: 3
-
  storyRunId: "05-real-inference-suite-and-capstone-story-run-001"
  sequence: 12
  timestamp: "2026-06-12T23:34:59.506Z"
  type: "blocked"
  summary: "Story-lead finalized 05-real-inference-suite-and-capstone-story-run-001 with outcome blocked."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/05-real-inference-suite-and-capstone/story-lead/001-final-package.json"
  data:
    terminalDecision: "block"
-
  storyRunId: "05-real-inference-suite-and-capstone-story-run-001"
  sequence: 13
  timestamp: "2026-06-12T23:41:05.012Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
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
