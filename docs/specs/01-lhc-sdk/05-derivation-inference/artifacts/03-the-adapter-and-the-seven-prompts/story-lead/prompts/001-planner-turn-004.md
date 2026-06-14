# Story Lead Base Prompt

## Role Charter
You are the story lead for `03-the-adapter-and-the-seven-prompts` on durable story run `03-the-adapter-and-the-seven-prompts-story-run-001`.
Select exactly one bounded next action for this `run` turn.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/03-the-adapter-and-the-seven-prompts.md
Bytes: 12036

# Story 3: The Adapter and the Seven Prompts

### Summary
<!-- Jira: Summary field -->

Implement the real `DerivationProvider` adapter, seven LHC-owned prompts, output shaping, empty-output handling, and provenance stamping.

### Description
<!-- Jira: Description field -->

**User Profile:** The operator expects real derived forms while hosts still provide only model transport.

**Objective:** Make all seven derivation operations render prompts, call the injected function, and land real form content through the unchanged Epic 02 seam.

**Scope In:** `src/inference/adapter.ts`, prompt registry/modules, prompt goldens, shaped text output, record-authored mechanical facts, pre-dial-in prompt markers, input bounding, and provenance metadata.

**Scope Out:** Retry/terminal classification table and real endpoint suite; those belong to Stories 4 and 5.

**Dependencies:** Story 2 establishes construction, assignment lookup, and the `ModelCall` boundary.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-2.1**: The adapter implements all seven `DerivationProvider` operations over the injected function. Domain handlers are untouched: the same handler code runs against the deterministic provider and the adapter.
- **AC-2.2**: Each operation renders its kind's prompt around the operation's input into the messages array; the response text, shaped, becomes the form content. Outcomes and receipts remain mechanically stamped from the record — no provider-authored facts (Epic 02 outcome and receipt-stripping contracts hold under real inference).
- **AC-2.3**: Prompts are named and versioned in LHC; the smoothing prompt is the POC's settled version; the other six exist, render correctly, and are marked pre-dial-in. The config's prompt name selects among them.
- **AC-2.4**: Empty or whitespace-only response text is a classified failure (`kind: empty_output`, retryable), never a `ready` form.
- **AC-2.5**: Every form the adapter lands `ready` carries provenance in its metadata: provider, model, and prompt version that produced it — mechanically stamped by the adapter, never parsed from output.

**Test Conditions**

- **TC-2.1** (AC-2.1, AC-2.2, AC-2.5): `inference-adapter.test.ts`
  - with a scripted fake function returning distinct canned text per kind, drain a seeded thread and assert all seven `FormKind`s land `ready`
  - content equals the canned response after shaping
  - handler equivalence: the same seeded thread drained under the deterministic provider lands the same form rows, states, and subjects with marker content
  - outcomes/receipts on tool and rendering forms match the record, not adversarial canned text
  - each form's `metadata.provenance` equals its assignment `{ provider, model, prompt }`
  - deterministic-provider forms carry no provenance
- **TC-2.2** (AC-2.2, AC-2.3): `inference-prompts.test.ts`
  - for each of the seven templates, `render(fixtureInput)` matches its golden file
  - fixture content is embedded and messages remain single-turn shape
  - registry completeness: every config-selectable name resolves and default names cover all seven kinds
  - brief-summary rendering contains outcome tokens but no receipt text from its input
  - oversized `summarizeToolResult` input renders head + tail + marker under `maxInputChars`; under-limit input renders whole
- **TC-2.3** (AC-2.4): `inference-adapter.test.ts`
  - fake function returns `{ ok: true, text: "  " }`, then success; first attempt classifies `empty_output` retryable and retry lands `ready`
  - all-whitespace script exhausts budget; form lands `failed` with reason `provider_failure` and last error naming `empty_output`

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story builds the semantic inference layer behind the unchanged Epic 02 provider seam. The adapter implements `DerivationProvider`, renders LHC-owned prompt templates, calls the host `ModelCall`, shapes successful text, and returns config-stamped provenance.

Domain handlers remain provider-agnostic. They keep stamping mechanical facts from records and only copy provenance from the provider result; provider prose is never parsed for outcomes, receipts, or other source facts.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- The story combines seven operations, prompt goldens, source/derived metadata, and failure entry for empty output.
- It is tempting to pass tests by mocking internal helpers or parsing model text; staged red/green keeps the actual adapter boundary visible.

Risk Reminders:
- `inference/` must not import `domains/`.
- The chunk-brief path must preserve receipt stripping through the adapter.
- Provenance must come from assignment config, not model output.
- Prompt quality is out of scope; structural rendering is in scope.

#### Implementation Targets

| Area | Files / Modules |
|---|---|
| Adapter | `src/inference/adapter.ts` |
| Prompt registry | `src/inference/prompts/index.ts` |
| Prompt modules | `src/inference/prompts/smoothing-v1.ts`, `tool-call-v1.ts`, `tool-result-v1.ts`, `turn-compose-v1.ts`, `lower-band-v1.ts`, `chunk-detailed-v1.ts`, `chunk-brief-v1.ts` |
| Provenance type | `src/shared/derivation.ts` |
| Provenance copy | `src/domains/messages/internal/...`, `src/domains/turns/internal/...` |
| Test goldens | `test/goldens/prompts/` |
| Story-owned tests | `test/inference-adapter.test.ts`, `test/inference-prompts.test.ts` |

#### Design References

- [epic.md §Flow 2](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md:91), lines 91-113
- [epic.md §Data Contracts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md:230), lines 230-236
- [tech-design.md §Design Decisions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:21), lines 21-27
- [tech-design.md §Top-Tier Surfaces](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:40), lines 40-46
- [tech-design.md §Module Responsibility Matrix](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:88), lines 88-94
- [tech-design.md §Flow 2](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:130), lines 130-149
- [tech-design.md §Interface Definitions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:244), lines 244-270
- [test-plan.md §TC-2.1 / TC-2.2 / TC-2.3](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:59), lines 59-76
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:168), lines 168-173
- [coverage.md §Story Shape Review](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/coverage.md:74), line 74

#### Test Mapping

| TC | Test File / Check | Test Description |
|---|---|---|
| TC-2.1 | `test/inference-adapter.test.ts` | seven kinds ready with canned content, handler equivalence, record-authored facts, provenance, deterministic provider without provenance |
| TC-2.2 | `test/inference-prompts.test.ts` | prompt goldens, registry completeness, brief-summary receipt stripping, tool-result input bounding |
| TC-2.3 | `test/inference-adapter.test.ts` | whitespace success classifies as `empty_output`, retries once in scripted leg, and fails with last error on exhaustion |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|---|---|---|---|
| Adapter parses model output for mechanical facts | `test/inference-adapter.test.ts` adversarial canned text | Canned text claims wrong outcome; stored outcome must still match record | A ready form alone would not prove the source of mechanical facts |
| Source/derived provenance authored from output | `test/inference-adapter.test.ts` metadata assertions | Provenance equals assignment provider/model/prompt and deterministic provider has none | Model text could accidentally contain plausible provenance strings |
| Prompt/fixture drift | prompt golden files | Rendered messages must match golden structure for each kind | A provider call could succeed while prompts silently lose required input fields |

#### Technical Notes

Relevant contracts:

```ts
export interface PromptTemplate<I = unknown> {
  name: string;
  render(input: I): { role: "system" | "user"; content: string }[];
}

export const PROMPT_REGISTRY: Record<string, PromptTemplate<never>>;

export function createInferenceProvider(config: ResolvedInferenceConfig): DerivationProvider;

export interface ProviderProvenance {
  provider: string;
  model: string;
  prompt: string;
}

// ProviderResult ok-branch addition:
// { ok: true; text: string; provenance?: ProviderProvenance }

// DerivedFormMetadata addition:
// provenance?: ProviderProvenance
```

Prompt modules:

| Prompt | Status |
|---|---|
| `smoothing-v1` | ported from POC, settled |
| `tool-call-v1` | pre-dial-in |
| `tool-result-v1` | pre-dial-in; input bounding applies |
| `turn-compose-v1` | pre-dial-in |
| `lower-band-v1` | pre-dial-in |
| `chunk-detailed-v1` | pre-dial-in |
| `chunk-brief-v1` | pre-dial-in; receipt-stripping contract reasserted |

Adapter operation pipeline:

1. Bound input where configured by `maxInputChars`.
2. Render the selected prompt into single-turn messages.
3. Call the host `ModelCall` with the kind's provider/model assignment.
4. Treat empty or whitespace-only success text as `empty_output`.
5. Return shaped text plus config-known provenance.

The adapter never parses model text for outcomes, receipts, or mechanical facts. Those remain handler-authored from the record.

#### Source/Derived State Risk

- Source facts stay in record-owned handlers.
- Provider text is derived content only.
- `DerivedFormMetadata.provenance` is copied from the provider result, which is stamped by the adapter from config-known strings.

#### Anti-Shim Requirements

- Do not satisfy tests by calling prompt renderers directly without exercising the adapter operation.
- Do not parse output text for facts, receipts, or provenance.
- Do not create prompt placeholders without golden coverage.
- Do not let an empty string land as `ready`.

#### Production Path Proof

- Entrypoint: domain handlers call the configured `DerivationProvider` operations during drain.
- Registration/default path: Story 2 constructs the adapter into the SDK provider slot; this story implements the adapter behind that slot.
- Evidence: handler-equivalence leg proves unchanged handlers run under deterministic provider and adapter; adapter tests prove drained forms receive real-adapter content and provenance.

#### Verification

- Targeted: `cd packages/lhc && pnpm exec vitest run test/inference-adapter.test.ts test/inference-prompts.test.ts`
- Story gate: `cd packages/lhc && pnpm run red-verify && pnpm exec vitest run test/inference-adapter.test.ts test/inference-prompts.test.ts`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- All seven `DerivationProvider` operations are implemented through the adapter.
- Seven prompt templates exist, are registry-addressable by name, and have golden coverage.
- The smoothing prompt is the POC-settled version; the other six are explicitly marked pre-dial-in.
- Empty success text is retryable `empty_output`, not a ready form.
- Ready real-adapter forms carry config-stamped provenance; deterministic-provider forms do not.
- TC-2.1, TC-2.2, and TC-2.3 are green.


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
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: quick-fix completed with outcome ready-for-verification and status ok.
- latest_response_kind: quick-fix-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/quick-fix/001-quick-fix.json
- older_response_count: 2
- caller_input_artifact_count: 0
- prior_self_note_count: 1
- latest_self_note: "After implementation, require verifier evidence for TC-2.1, TC-2.2, TC-2.3 and confirm story gate status before any acceptance recommendation."

## Response Trail
<current_response>
```yaml
kind: quick-fix-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/quick-fix/001-quick-fix.json
bytes: 9728
payload:
  command: "quick-fix"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    provider: "claude-code"
    model: "claude-opus-4-8"
    rawProviderOutputPreview: |-
      {"type":"system","subtype":"init","cwd":"/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc","session_id":"7cef6c87-78e2-45ca-98c2-725c469882de","tools":["Task","AskUserQuestion","Bash","CronCreate","CronDelete","CronList","DesignSync","Edit","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","Monitor","NotebookEdit","PushNotification","Read","RemoteTrigger","ScheduleWakeup","Skill","TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate","ToolSearch","WebFetch","WebSearch","Workflow","Write"],"mcp_servers":[],"model":"claude-opus-4-8","permissionMode":"bypassPermissions","slash_commands":["deep-research","design-sync","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","loop","schedule","claude-api","run","run-skill-generator","clear","compact","context","heapdump","init","reload-skills","review","security-review","usage-credits","extra-usage","usage","insights","goal","team-onboarding"],"apiKeySource":"none","claude_code_version":"2.1.176","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],"skills":["deep-research","design-sync","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","loop","schedule","claude-api","run","run-skill-generator"],"plugins":[],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"538e164b-04cb-4223-9557-c8316a7acf07","memory_paths":{"auto":"/Users/leemoore/.claude/projects/-Users-leemoore-code-pi-long-horizon-liminal-context/memory/"},"fast_mode_state":"off"}
      {"type":"system","subtype":"status","status":"requesting","uuid":"9ef5ef97-24a9-4f6d-bc62-45cea102e927","session_id":"7cef6c87-78e2-45ca-98c2-725c469882de"}
      {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1781317800,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false},"uuid":"88554471-c99f-4408-969c-17c45858da6e","session_id":"7cef6c87-78e2-45ca-98c2-725c469882de"}
      {"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-4-8","id":"msg_01VrjGF1KuhBe53YmbtDv3Ef","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":1983,"cache_creation_input_tokens":3076,"cache_read_input_tokens":15848,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":3076},"output_tokens":7,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null}},"session_id":"7cef6c87-78e2-45ca-98c2-725c469882de","parent_tool_use_id":null,"uuid":"a57513b5-46a5-497c-a5eb-3c2dd5a8f9f4","ttft_ms":2361}
      {"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}},"session_id":"7cef6c87-78e2-45ca-98c2-725c469882de","parent_tool_use_id":null,"uuid":"50c609b9-f949-4f7a-bb03-97fc15df2130"}
      {"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50,"uuid":"fa6ed9e3-4adf-429f-a8f4-855f762027a6","session_id":"7cef6c87-78e2-45ca-98c2-725c469882de"}
      {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"","estimated_tokens":50}},"session_id":"7cef6c87-78e2-45ca-98c2-725c469882de","parent_tool_use_id":null,"uuid":"c1d96f4c-1d99-4b85-930c-b13ea3366cef"}
      {"type":"system","subtype":"thinking_tokens","estimated_tokens":174,"estimated_tokens_delta":124,"uuid":"c6ba18c8-e36a-44a6-9623-8b4c57f4f573","session_id":"7cef6c87-78e2-45ca-98c2-725c469882de"}
      {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"ErEFCmMIDhgCKkCQZzZon1Xl8cnXQLrl4ytWI4YmCEcvlMPfPjt3oC0JCC/firwRiqRmLcyiypbH+3xbOHsTIc5V+1Psvy5x508VMg9jbGF1ZGUtb3B1cy00LTg4AEIIdGhpbmtpbmcSDNgX7nonbRPkwAkCUhoMB3INmAKOouJeZzMJIjBDwnNBkasPMvUEzHzP1F3GKvNu/9/72BQxxVrUO0R3ZjlDS8Ixf7xBEDGlHaEr4jsq+wN2/1L9rByxuO11o1f+PnEJEsDgXphFHhiEUqSApyf9ETnvTsqzaFF8eMPBWXCrlFRQFWHZmiPloq97BDAvZZYH9dP43LiWu9DLgUfvHfPTmZsosuNXwG79lREgV50Iv6fEinLB1MG72SY1qfrqnN4O5UL5n3SW35tQ7U408A+2aC0IuMLDj9cZlcoxfQV7C9LkCA0Mckj7h+xclHiCXpm2bbeuF0ulQYRTDsiBwgTeAkIWEt0gqfGcSJBkkWVaCSMoLfWFXy7C8RhPtuoBmgwn/jA/xGAR7z+6u9WikbRbA/Yp19F1riXvIaEI707QXVeLwkilqOUV715JJBBLcfgoBFfP70ekZ/mLomkF7P3bHyKWnEyz03Iop8wQP9uEk75BLEEkpTJ5N0/C4csnmJU7Ajbg/wN20s+OVG33uEm0ELTmELGzUlcmuC0QH+AZc7fe/Iwqj42jtKTbQRDt5J1bAja7/uwa1JfZz0a7Bkwe676dlHOBax7PBy+a3nhM4+nZYsxi+i+CnFrpXzF0le2IcbSoUC4cwnmnorrXIBTouskzXbys9IakyZsSrNYqXSuTQPpmj5sFOAzQ6sePBN7OOpHS0MaJi3wQa80gDF9y0YDVHAVB+dIjq0b6R0UNhR2xgtDbwEvYaf7XpidjycK3XdYs/aPm/6EiYo0YAQ=="}},"session_id":"7cef6c87-78e2-45ca-98c2-725c469882de","parent_tool_use_id":null,"uuid":"25c22f38-eefb-47fb-9f9b-ae0db0c5a5fd"}
      {"type":"assistant","message":{"model":"claude-opus-4-8","id":"msg_01VrjGF1KuhBe53YmbtDv3Ef","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"ErEFCmMIDhgCKkCQZzZon1Xl8cnXQLrl4ytWI4YmCEcvlMPfPjt3oC0JCC/firwRiqRmLcyiypbH+3xbOHsTIc5V+1Psvy5x508VMg9jbGF1ZGUtb3B1cy00LTg4AEIIdGhpbmtpbmcSDNgX7nonbRPkwAkCUhoMB3INmAKOouJeZzMJIjBDwnNBkasPMvUEzHzP1F3GKvNu/9/72BQxxVrUO0R3ZjlDS8Ixf7xBEDGlHaEr4jsq+wN2/1L9rByxuO11o1f+PnEJEsDgXphFHhiEUqSApyf9ETnvTsqzaFF8eMPBWXCrlFRQFWHZmiPloq97BDAvZZYH9dP43LiWu9DLgUfvHfPTmZsosuNXwG79lREgV50Iv6fEinLB1MG72SY1qfrqnN4O5UL5n3SW35tQ7U408A+2aC0IuMLDj9cZlcoxfQV7C9LkCA0Mckj7h+xclHiCXpm2bbeuF0ulQYRTDsiBwgTeAkIWEt0gqfGcSJBkkWVaCSMoLfWFXy7C8RhPtuoBmgwn/jA/xGAR7z+6u9WikbRbA/Yp19F1riXvIaEI707QXVeLwkilqOUV715JJBBLcfgoBFfP70ekZ/mLomkF7P3bHyKWnEyz03Iop8wQP9uEk75BLEEkpTJ5N0/C4csnmJU7Ajbg/wN20s+OVG33uEm0ELTmELGzUlcmuC0QH+AZc7fe/Iwqj42jtKTbQRDt5J1bAja7/uwa1JfZz0a7Bkwe676dlHOBax7PBy+a3nhM4+nZYsxi+i+CnFrpXzF0le2IcbSoUC4cwnmnorrXIBTouskzXbys9IakyZsSrNYqXSuTQPpmj5sFOAzQ6sePBN7OOpHS0MaJi3wQa80gDF9y0YDVHAVB+dIjq0b6R0UNhR2xgtDbwEvYaf7XpidjycK3XdYs/aPm/6EiYo0YAQ=="}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":1983,"cache_creation_input_tokens":3076,"cache_read_input_tokens":15848,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":3076},"output_tokens":7,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"7cef6c87-78e2-45ca-98c2-725c469882de","uuid":"f44f4433-9f7b-4fdb-95e5-ac5b953362bb","request_id":"req_011CbzBADibk544xBp2naVy2"}
      {"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":"7cef6c87-78e2-45ca-98c2-725c469882de","parent_tool_use_id":null,"uuid":"d49948a1-8ca6-480e-bfb4-5ef1776387c3"}
      {"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01Tu2CqBiuYgPMiKToen3y1z","name":"Read","input":{},"caller":{"type":"direct"}}},"session_id":"7cef6c87-78e2-45ca-98c2-725c469882de","parent_tool_use_id":null,"uuid":"b2015fb0-c390-405a-a0fd-9314997d35dd"}
      {"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}},"session_id":"7cef6c87-78e2-45ca-98c2-725c469882de","parent_tool_use_id":null,"uuid":"81783d06-1c79-4c02-b666-a6b0a68e0d77"}
      {"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\": \"/Users/leemoore/code/pi-long-horizon/liminal-context/packages/l"}},"session_id":"7cef6c87-78e2-45ca-98c2-725c469882de","parent_tool_use_id":null,"uuid":"e3dc0e74-c32e-4da3-ad3d-4d937b677c59"}
      {"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"hc/src/inference/adapter.ts"}},"session_id":"7cef6c87-78e2-45ca-98c2-725c469882de","parent_tool_use_id":null,"uuid":"b90dc79f-3f83-422a-8d8b-0c639a891416"}
      {"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"}"}},"session_id":"7cef6c87-78e2-45ca-98c2-725c469882de","parent_tool_use_id":null,"uuid":"2354ee8c-f4b7-4666-a029-ee1824c2e07d"}
      {"type":"assistant","message":{"model":"claude-opus-4-8","id":"msg_01VrjGF1KuhBe53YmbtDv3Ef","type":"m
    rawProviderOutputBytes: 267739
    rawProviderOutputTruncated: true
    rawProviderOutputLogPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/quick-fix/streams/001-quick-fix.stdout.log"
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/quick-fix/001-quick-fix.json"
  startedAt: "2026-06-12T22:44:39.421Z"
  finishedAt: "2026-06-12T22:46:58.272Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/003-implementor.json
bytes: 7536
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "0398a37d-eaf5-44a6-adb0-e203ffa94a28"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "d415efd0-0780-463c-9946-d0cae549777f"
    continuation:
      provider: "claude-code"
      sessionId: "d415efd0-0780-463c-9946-d0cae549777f"
      storyId: "03-the-adapter-and-the-seven-prompts"
    outcome: "ready-for-verification"
    story:
      id: "03-the-adapter-and-the-seven-prompts"
      title: "Story 3: The Adapter and the Seven Prompts"
    planSummary: "Implemented the Story 3 adapter pipeline behind the unchanged Epic 02 seam: each operation now bounds input where DD-7 applies (summarizeToolResult head+tail+marker under maxInputChars), renders its kind's prompt, calls the host ModelCall, rejects empty/whitespace-only success text as retryable empty_output, and returns trimmed text with config-stamped provenance. Ported the POC's settled smoothing prompt verbatim into smoothing-v1 (the other six templates remain marked pre-dial-in with golden coverage). Handlers copy result.provenance into DerivedFormMetadata at all five form-write sites (messages landForm; turns rendering/projection/chunk-summary); the deterministic provider sets none, so its forms carry none. Wrote prompt goldens for all seven templates plus the two story suites covering TC-2.1, TC-2.2, and TC-2.3, demonstrated red on the new behaviors before implementing, and recorded the new Red files in the immutability manifest."
    changedFiles:
      -
        path: "packages/lhc/src/inference/adapter.ts"
        reason: "Five-step operation pipeline: tool-result input bounding (DD-7), empty/whitespace-only success classified empty_output retryable (AC-2.4), output shaping via trim, classified failure reasons (retryable reasons lead with the provider_failure code, kind named next), provenance stamped from assignment config (AC-2.5)"
      -
        path: "packages/lhc/src/inference/prompts/smoothing-v1.ts"
        reason: "Replaced the pre-dial-in placeholder with the POC's settled smoothing system prompt, ported verbatim (AC-2.3)"
      -
        path: "packages/lhc/src/domains/messages/internal/handlers.ts"
        reason: "landForm takes ProviderResult and copies result.provenance into form metadata alongside the existing mechanical stamps (DD-4, AC-2.5)"
      -
        path: "packages/lhc/src/domains/turns/internal/derive.ts"
        reason: "One-line provenance copy on each of the three turn-owned form writes: turn_rendering (merged with receipts metadata), lower_band_projection, and chunk summaries (DD-4, AC-2.5)"
      -
        path: "packages/lhc/test/inference-adapter.test.ts"
        reason: "TC-2.1 and TC-2.3: seven kinds ready with canned content and assignment provenance, record-authored outcomes/receipts disagreeing with adversarial canned text, handler equivalence under the deterministic provider with no provenance, empty-output retry/exhaustion/shaping legs"
      -
        path: "packages/lhc/test/inference-prompts.test.ts"
        reason: "TC-2.2: per-template goldens with fixture embedding and single-turn shape, registry completeness, brief receipt-stripping proven through the adapter against a detailed-lane contrast, tool-result bounding through the adapter operation"
      -
        path: "packages/lhc/test/goldens/prompts/smoothing-v1.golden.json"
        reason: "Golden pinning the POC-settled smoothing rendering"
      -
        path: "packages/lhc/test/goldens/prompts/tool-call-v1.golden.json"
        reason: "Golden pinning tool-call-v1 rendering"
      -
        path: "packages/lhc/test/goldens/prompts/tool-result-v1.golden.json"
        reason: "Golden pinning tool-result-v1 rendering"
      -
        path: "packages/lhc/test/goldens/prompts/turn-compose-v1.golden.json"
        reason: "Golden pinning turn-compose-v1 rendering"
      -
        path: "packages/lhc/test/goldens/prompts/lower-band-v1.golden.json"
        reason: "Golden pinning lower-band-v1 rendering"
      -
        path: "packages/lhc/test/goldens/prompts/chunk-detailed-v1.golden.json"
        reason: "Golden pinning chunk-detailed-v1 rendering including the receipts section"
      -
        path: "packages/lhc/test/goldens/prompts/chunk-brief-v1.golden.json"
        reason: "Golden pinning chunk-brief-v1 rendering including the outcomes-only section"
      -
        path: "packages/lhc/test/red-manifest.json"
        reason: "Recorded the story's Red-phase test files and goldens for the immutability guard"
    tests:
      added:
        - "test/inference-adapter.test.ts (6 tests: seven-kinds ready with canned content + provenance; record-authored outcomes/receipts vs adversarial text; handler equivalence with marker content and no provenance; empty_output retry lands ready; all-whitespace exhaustion fails with provider_failure/empty_output; whitespace shaping)"
        - "test/inference-prompts.test.ts (19 tests: 7 golden matches, 7 fixture-embedding/single-turn legs, 2 registry-completeness legs, 1 brief receipt-stripping leg through the adapter, 2 tool-result bounding legs)"
      modified:
[]
      removed:
[]
      totalAfterStory: 352
      deltaFromPriorBaseline: 25
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/inference-adapter.test.ts test/inference-prompts.test.ts (pre-implementation Red check: 6 failed on exactly the new Story 3 behaviors)"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify-all"
        result: "pass"
      -
        command: "node scripts/check-test-immutability.mjs (48 Red-phase files unchanged)"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
[]
      findingsSurfaced:
        - "Degenerate-config corner: a maxInputChars smaller than the truncation marker itself (~80 chars) yields marker-only bounded content slightly over the bound; config validation only requires a positive number. Harmless at the 200_000 default and the test's 200, but dial-in could add a sane floor."
        - "The POC smoothing prompt's protected-literals sentence was ported verbatim even though LHC's smoothing input carries no literals list — the clause is inert by design (post-epic-4-work.md retired the regex-extract-then-verify pattern); noted in the module comment so dial-in can reword under a new versioned name."
    openQuestions:
[]
    specDeviations:
      - "Retryable failure reasons are formatted `provider_failure: <kind>: <message>` rather than DD-3's literal 'reason is the kind string itself'. The Epic 02 queue copies the provider's reason verbatim onto exhausted forms (failTerminal sets form.reason and metadata.lastError from one string), and immutable Epic 02 tests pin that verbatim copy — so TC-2.3's required exhaustion shape ('reason provider_failure and last error naming empty_output') is only reachable if the adapter authors retryable reasons with the provider_failure code leading, matching the reason-code-before-first-colon convention Epic 02 established. Terminal kinds (auth, invalid_request) stay kind-led and land failed immediately, per the tech design's Error Contract. Story 4's classification tests (TC-3.1 asserts the same exhaustion shape for network) should consume this format."
    recommendedNextStep: "Run story verification for TC-2.1/2.2/2.3, then proceed to Story 4 (classification table, safeCall timeout/exception containment), which should adopt the provider_failure-led retryable reason format recorded in specDeviations."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/003-implementor.json"
  startedAt: "2026-06-12T22:12:10.962Z"
  finishedAt: "2026-06-12T22:29:44.133Z"
```
</history_entry>

<history_entry>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/004-verify.json
bytes: 6934
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "revise"
  result:
    resultId: "2cc52a86-805c-4a7b-8f7d-dd2d9c8996d2"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019ebdf4-ca32-7f12-909e-44b6a3f3f337"
    continuation:
      provider: "codex"
      sessionId: "019ebdf4-ca32-7f12-909e-44b6a3f3f337"
      storyId: "03-the-adapter-and-the-seven-prompts"
    mode: "initial"
    story:
      id: "03-the-adapter-and-the-seven-prompts"
      title: "Story 3: The Adapter and the Seven Prompts"
    artifactsRead:
      - "packages/lhc/docs/02-specs/05-derivation-inference/stories/03-the-adapter-and-the-seven-prompts.md"
      - "packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md"
      - "packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md"
      - "packages/lhc/docs/02-specs/05-derivation-inference/epic.md"
      - "packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/003-implementor.json"
      - "packages/lhc/src/inference/adapter.ts"
      - "packages/lhc/src/inference/types.ts"
      - "packages/lhc/src/inference/classify.ts"
      - "packages/lhc/src/inference/prompts/index.ts"
      - "packages/lhc/src/inference/prompts/smoothing-v1.ts"
      - "packages/lhc/src/inference/prompts/tool-call-v1.ts"
      - "packages/lhc/src/inference/prompts/tool-result-v1.ts"
      - "packages/lhc/src/inference/prompts/turn-compose-v1.ts"
      - "packages/lhc/src/inference/prompts/lower-band-v1.ts"
      - "packages/lhc/src/inference/prompts/chunk-detailed-v1.ts"
      - "packages/lhc/src/inference/prompts/chunk-brief-v1.ts"
      - "packages/lhc/src/shared/derivation.ts"
      - "packages/lhc/src/domains/messages/internal/handlers.ts"
      - "packages/lhc/src/domains/turns/internal/derive.ts"
      - "packages/lhc/src/sdk.ts"
      - "packages/lhc/src/tech-utils/work-queue/index.ts"
      - "packages/lhc/scripts/check-boundaries.mjs"
      - "packages/lhc/package.json"
      - "packages/lhc/test/inference-adapter.test.ts"
      - "packages/lhc/test/inference-prompts.test.ts"
      - "packages/lhc/test/inference-construction.test.ts"
      - "packages/lhc/test/inference-routing.test.ts"
      - "packages/lhc/test/fixtures/model-call.ts"
      - "packages/lhc/test/fixtures/seam-conformance.ts"
      - "packages/lhc/test/goldens/prompts/*.golden.json"
      - "../src/thread/async-thread/services/pi-codex-user-prompt-smoothing-provider.ts"
    reviewScopeSummary: "Verified Story 3 against AC-2.1 through AC-2.5 and TC-2.1 through TC-2.3, including adapter code, prompt registry/modules, provenance copy sites, focused tests, prompt goldens, POC smoothing prompt source, and configured gates. One blocking TC-2.2 production-path bounding issue remains."
    priorFindingStatuses:
[]
    newFindings:
      -
        id: "SV-03-001"
        severity: "major"
        title: "Tool-result bounding can exceed maxInputChars for small valid configs"
        evidence: "TC-2.2 requires oversized summarizeToolResult input to render head + tail + marker under maxInputChars. src/sdk.ts accepts any positive maxInputChars, but src/inference/adapter.ts:30-36 builds a truncation marker and returns it even when marker.length exceeds maxInputChars. Reproduced from the same formula with maxInputChars=10 and 1000 chars of content: markerLength=75, boundedLength=75, so the rendered input is over the configured bound. The existing test at test/inference-prompts.test.ts:219-233 only covers MAX_INPUT_CHARS=200, where the marker is shorter than the bound."
        affectedFiles:
          - "packages/lhc/src/inference/adapter.ts"
          - "packages/lhc/src/sdk.ts"
          - "packages/lhc/test/inference-prompts.test.ts"
        requirementIds:
          - "AC-2.2"
          - "TC-2.2"
        recommendedFixScope: "quick-fix"
        blocking: true
    openFindings:
      -
        id: "SV-03-001"
        severity: "major"
        title: "Tool-result bounding can exceed maxInputChars for small valid configs"
        evidence: "TC-2.2 requires oversized summarizeToolResult input to render head + tail + marker under maxInputChars. src/sdk.ts accepts any positive maxInputChars, but src/inference/adapter.ts:30-36 builds a truncation marker and returns it even when marker.length exceeds maxInputChars. Reproduced from the same formula with maxInputChars=10 and 1000 chars of content: markerLength=75, boundedLength=75, so the rendered input is over the configured bound. The existing test at test/inference-prompts.test.ts:219-233 only covers MAX_INPUT_CHARS=200, where the marker is shorter than the bound."
        affectedFiles:
          - "packages/lhc/src/inference/adapter.ts"
          - "packages/lhc/src/sdk.ts"
          - "packages/lhc/test/inference-prompts.test.ts"
        requirementIds:
          - "AC-2.2"
          - "TC-2.2"
        recommendedFixScope: "quick-fix"
        blocking: true
    requirementCoverage:
      verified:
        - "AC-2.1 / TC-2.1: all seven DerivationProvider operations exist on the adapter, seeded drains land all seven kinds ready, and deterministic-provider handler equivalence is covered by inference-adapter.test.ts."
        - "AC-2.2: adapter uses assignment.prompt to render messages, shaped provider text becomes form content, and adversarial provider prose does not change record-stamped outcomes or receipts."
        - "AC-2.3: seven named prompt modules exist, registry/default names cover all seven kinds, six non-smoothing prompts are marked PRE-DIAL-IN, goldens cover all seven, and smoothing-v1 matches the POC system prompt source."
        - "AC-2.4 / TC-2.3: whitespace-only success is classified as retryable empty_output, retry can land ready, and exhaustion lands failed with provider_failure plus lastError naming empty_output."
        - "AC-2.5 / TC-2.1: ready adapter forms carry assignment-stamped provider/model/prompt provenance, and deterministic-provider forms carry no provenance."
        - "TC-2.2 partial: prompt goldens, fixture embedding, single-turn shape, registry completeness, brief receipt stripping, and normal-case tool-result bounding at maxInputChars=200 are covered and passing."
      unverified:
        - "TC-2.2 full input-bounding contract for all valid maxInputChars values: values below the truncation marker length exceed the configured bound."
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/inference-adapter.test.ts test/inference-prompts.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify-all"
        result: "pass"
    productionPathFindings:
      - "src/inference/adapter.ts boundContent can emit bounded tool-result content longer than the configured maxInputChars when maxInputChars is shorter than the truncation marker."
    recommendedNextStep: "revise"
    recommendedFixScope: "quick-fix"
    openQuestions:
[]
    additionalObservations:
      - "No fake adapter, shim, placeholder, or mock path was found in production inference code; test fakes are confined to test fixtures."
      - "The configured gates pass, but they do not cover the small-valid-maxInputChars counterexample."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/004-verify.json"
  startedAt: "2026-06-12T22:29:56.616Z"
  finishedAt: "2026-06-12T22:44:31.407Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/story-lead/001-current.json
Bytes: 2568

```yaml
storyRunId: "03-the-adapter-and-the-seven-prompts-story-run-001"
storyId: "03-the-adapter-and-the-seven-prompts"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "quick-fix completed with outcome ready-for-verification and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/003-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/004-verify.json"
    provenance: "current-run"
  -
    kind: "quick-fix-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/quick-fix/001-quick-fix.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "d415efd0-0780-463c-9946-d0cae549777f"
    storyId: "03-the-adapter-and-the-seven-prompts"
  storyVerifier:
    provider: "codex"
    sessionId: "019ebdf4-ca32-7f12-909e-44b6a3f3f337"
    storyId: "03-the-adapter-and-the-seven-prompts"
latestEventSequence: 11
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "Latest verifier outcome is revise with one blocking finding, SV-03-001. The smallest safe next action is a targeted fix for tool-result bounding so rendered oversized input stays within maxInputChars for all valid positive configs, with focused coverage for the small-bound counterexample."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/quick-fix/001-quick-fix.json"
replayBoundary: null
updatedAt: "2026-06-12T22:46:58.279Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After implementation, require verifier evidence for TC-2.1, TC-2.2, TC-2.3 and confirm story gate status before any acceptance recommendation.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-12T22:12:10.927Z; note="After implementation, require verifier evidence for TC-2.1, TC-2.2, TC-2.3 and confirm story gate status before any acceptance recommendation."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/story-lead/001-events.jsonl
Bytes: 4879

```yaml
-
  storyRunId: "03-the-adapter-and-the-seven-prompts-story-run-001"
  sequence: 1
  timestamp: "2026-06-12T22:12:01.661Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "03-the-adapter-and-the-seven-prompts-story-run-001"
  sequence: 2
  timestamp: "2026-06-12T22:12:10.906Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ebde4-63d6-72d0-9f6b-1d8ff8d8dabd"
-
  storyRunId: "03-the-adapter-and-the-seven-prompts-story-run-001"
  sequence: 3
  timestamp: "2026-06-12T22:12:10.926Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation, require verifier evidence for TC-2.1, TC-2.2, TC-2.3 and confirm story gate status before any acceptance recommendation."
-
  storyRunId: "03-the-adapter-and-the-seven-prompts-story-run-001"
  sequence: 4
  timestamp: "2026-06-12T22:12:10.927Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation, require verifier evidence for TC-2.1, TC-2.2, TC-2.3 and confirm story gate status before any acceptance recommendation."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "03-the-adapter-and-the-seven-prompts-story-run-001"
  sequence: 5
  timestamp: "2026-06-12T22:29:44.147Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "03-the-adapter-and-the-seven-prompts-story-run-001"
  sequence: 6
  timestamp: "2026-06-12T22:29:56.559Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019ebdf4-9989-7cf0-af92-2463465318aa"
-
  storyRunId: "03-the-adapter-and-the-seven-prompts-story-run-001"
  sequence: 7
  timestamp: "2026-06-12T22:29:56.579Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "03-the-adapter-and-the-seven-prompts-story-run-001"
  sequence: 8
  timestamp: "2026-06-12T22:44:31.418Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome revise and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/004-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "revise"
    status: "ok"
-
  storyRunId: "03-the-adapter-and-the-seven-prompts-story-run-001"
  sequence: 9
  timestamp: "2026-06-12T22:44:39.358Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/03-the-adapter-and-the-seven-prompts/story-lead/prompts/001-planner-turn-003.md"
    sessionId: "019ebe02-22eb-7861-8ccf-f710ae82326e"
-
  storyRunId: "03-the-adapter-and-the-seven-prompts-story-run-001"
  sequence: 10
  timestamp: "2026-06-12T22:44:39.383Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-quick-fix."
  data:
    actionType: "run-quick-fix"
    turn: 3
-
  storyRunId: "03-the-adapter-and-the-seven-prompts-story-run-001"
  sequence: 11
  timestamp: "2026-06-12T22:46:58.279Z"
  type: "child-operation-completed"
  summary: "quick-fix completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/quick-fix/001-quick-fix.json"
  data:
    actionType: "run-quick-fix"
    command: "quick-fix"
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
