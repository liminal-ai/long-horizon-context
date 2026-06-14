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
