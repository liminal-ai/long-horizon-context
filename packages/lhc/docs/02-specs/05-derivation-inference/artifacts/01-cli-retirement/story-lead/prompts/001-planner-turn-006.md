# Story Lead Base Prompt

## Role Charter
You are the story lead for `01-cli-retirement` on durable story run `01-cli-retirement-story-run-001`.
Select exactly one bounded next action for this `resume` turn.
This is planner turn 6.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/01-cli-retirement.md
Bytes: 8639

# Story 1: CLI Retirement

### Summary
<!-- Jira: Summary field -->

Delete the CLI surface and its provider-resolution machinery so LHC publishes an SDK-only public API.

### Description
<!-- Jira: Description field -->

**User Profile:** The operator configures LHC through `createSdk` inside a host process; no supported consumer drives LHC through a bundled process CLI.

**Objective:** Retire the CLI deletion-first so later inference stories do not maintain parity legs for a dead surface.

**Scope In:** Delete `src/cli/`, package `bin`, spawned-process suites, the named-provider registry, CLI-only exports, and env/flag provider resolution.

**Scope Out:** SDK behavior changes. Every former CLI-fronted operation remains available through the SDK surface.

**Dependencies:** None. This story intentionally precedes inference plumbing.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-6.1**: `src/cli/` is deleted; the package publishes no binary; SDK exports drop the CLI-only entries (`resolveNamedProvider`, `registeredProviderNames`, and the registry module). The public API surface is SDK-only.
- **AC-6.2**: All spawned-process suites are deleted; the full remaining suite is green with no spawned-process dependency anywhere; no SDK behavior test was weakened or removed with them.
- **AC-6.3**: The env/flag provider-resolution path is gone: no code path reads `LHC_PROVIDER`, and provider arrival is injection at `createSdk` only.

**Test Conditions**

- **TC-6.1** (AC-6.1, AC-6.2): `retirement.test.ts`
  - public-API surface snapshot: export-name set of the package entry equals the checked-in SDK-only list; no `resolveNamedProvider`, no `registeredProviderNames`
  - package manifest has no `bin`
  - full default suite green is the suite run itself
  - SDK-coverage comparison is a story-completion check: suite files and domain-operation coverage unchanged from pre-deletion, process suites excepted
- **TC-6.2** (AC-6.3): `retirement.test.ts`
  - source scan: zero `LHC_PROVIDER` / `--provider` references under `src/`
  - constructing with neither `provider` nor `inference` returns the XOR `TypeError`; no fallback resolution path catches it

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This is a deletion-first packaging story. It removes the process CLI, its package binary, the named-provider registry, env/flag provider resolution, and spawned-process parity suites before the inference seam lands.

The SDK remains the product surface. The deterministic provider stays because it is the CI-default fixture provider; only the CLI-only arrival path is removed.

Story completion must carry the Epic 04 parity deviation accurately: spawned `inspect health` parity was backfilled before Epic 05, and this story deletes the spawned-process parity surface instead of carrying it forward.

#### Build Strategy

Strategy: simple-risk-reminders

Reason:
- The implementation is mostly deletion and export cleanup, but public API and test-suite deletion need proof that no SDK behavior test disappears with the process transport.

Risk Reminders:
- Public API break must be intentional and snapshot-tested.
- Process-suite deletion must not delete unique SDK behavior coverage.
- Verify-script changes must remove the process-suite gate while preserving the default non-network suite.

#### Implementation Targets

| Area | Files / Modules |
|---|---|
| CLI surface | `src/cli/`, `src/cli.ts` (the bin entrypoint — a separate file outside the directory), package `bin` entry, `dev:cli` script |
| Provider registry | `src/providers/registry.ts`, CLI-only re-exports in `src/sdk.ts` |
| Process suites | twelve `cli-process-*.test.ts` files |
| Verification scripts | `packages/lhc/package.json` scripts |
| Retirement proof | `test/retirement.test.ts` |

#### Design References

- [epic.md §Flow 6: CLI Retirement](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md:173), lines 173-190
- [tech-design.md §Design Decisions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:31), lines 31-32
- [tech-design.md §Flow 6](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:199), lines 199-203
- [tech-design.md §Interface Definitions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:277), lines 277-285
- [test-plan.md §TC-6.1 / TC-6.2](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:127), lines 127-136
- [test-plan.md §Red/Green per Chunk](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:156), lines 156-159
- [coverage.md §Story Shape Review](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/coverage.md:72), line 72

#### Test Mapping

| TC | Test File / Check | Test Description |
|---|---|---|
| TC-6.1 | `test/retirement.test.ts` | SDK-only export snapshot, no package `bin`, full default suite green, SDK coverage comparison recorded |
| TC-6.2 | `test/retirement.test.ts` | zero `LHC_PROVIDER` / `--provider` references under `src/`; neither-provider-nor-inference construction hits the XOR error |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|---|---|---|---|
| Behavior test deleted with process suites | `test/retirement.test.ts` plus story-completion coverage comparison | Proves deleted files were process parity only | ACs require deletion; this proof guards against deleting the only behavior assertion for an SDK operation |
| Accidental public API removal beyond CLI-only exports | public-API surface snapshot | Export-name set equals checked-in SDK-only list | Import/build success alone would not show unintended removals |

#### Technical Notes

Relevant contract:

```ts
// sdk.ts export cleanup
// removed exports: resolveNamedProvider, registeredProviderNames

export interface SdkConfig {
  provider?: DerivationProvider;
  inference?: InferenceConfig;
  // existing fields unchanged
}
```

Deletion targets stay deletion-only:

| Target | Change |
|---|---|
| `src/cli/` | Delete entirely |
| `src/cli.ts` | Delete — the bin entrypoint lives outside `src/cli/`; leaving it breaks the build with a dead import |
| package manifest | Remove `bin` and the `dev:cli` script |
| `src/providers/registry.ts` | Delete named-provider registry and `LHC_PROVIDER` resolution |
| spawned-process suites | Delete all twelve `cli-process-*.test.ts` files |
| verify scripts | Remove `LHC_PROCESS_SUITE` gate and process-suite accounting |

#### Anti-Shim Requirements

- Do not leave a hidden `bin`, wrapper command, registry adapter, or env fallback behind.
- Do not preserve CLI exports as deprecated no-ops; the public API is SDK-only.
- Do not weaken SDK behavior tests to make process-suite deletion pass.

#### Production Path Proof

- Entrypoint: package root export and `createSdk`.
- Registration/default path: package publishes no binary; providers arrive through `createSdk` injection only.
- Evidence: `test/retirement.test.ts` export snapshot, package manifest check, source scan, and full default suite.

#### Verification

- Targeted: `cd packages/lhc && pnpm exec vitest run test/retirement.test.ts`
- Story gate: `cd packages/lhc && pnpm run verify`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

Epic 04 parity note to record at story completion: spawned `inspect health` parity was backfilled before Epic 05; this story deletes the spawned-process parity surface instead of carrying it forward.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- CLI directory, binary manifest entry, registry module, registry exports, and spawned-process suites are gone.
- `retirement.test.ts` proves SDK-only exports, no package binary, no source references to `LHC_PROVIDER` / `--provider`, and XOR construction behavior.
- Full remaining default suite is green.
- SDK behavior coverage comparison is recorded: only process parity suites were removed.
- Epic 04 parity-gap deviation note is recorded in this pack: the missing spawned `inspect health` parity proof was backfilled before this epic, and Story 1 deletes the spawned-process parity surface instead of carrying it forward.


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
- planner_turn_index: 6
- mode: resume
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-verify completed with outcome pass and status ok.
- latest_response_kind: verifier-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/007-verify.json
- older_response_count: 1
- caller_input_artifact_count: 0
- prior_self_note_count: 3
- latest_self_note: "After implementation returns, verify recorded evidence includes retirement proof, full default suite result, SDK coverage comparison, and the Epic 04 parity deviation note before any acceptance recommendation."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/007-verify.json
bytes: 5838
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "pass"
  result:
    resultId: "00ed12c5-e092-46d7-b770-4a1d27c4b365"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019ebd9f-dc5a-7253-8957-dae1b2a5c1eb"
    continuation:
      provider: "codex"
      sessionId: "019ebd9f-dc5a-7253-8957-dae1b2a5c1eb"
      storyId: "01-cli-retirement"
    mode: "initial"
    story:
      id: "01-cli-retirement"
      title: "Story 1: CLI Retirement"
    artifactsRead:
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/01-cli-retirement.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/coverage.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/006-implementor.json"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/package.json"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/index.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/sdk.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared/derivation.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared/errors.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/vitest.config.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/retirement.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/smoke.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/intake.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/epic-fix.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/projection.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/threads.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/turns.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/validation.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/work-queue.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/inspect-view.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/fixtures.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/fixtures/threads.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/fixtures/lifecycle.ts"
    reviewScopeSummary: "Verified Story 1 CLI retirement against AC-6.1 through AC-6.3 and TC-6.1 through TC-6.2, including the required docs, package/public API surface, deleted CLI/provider-registry paths, modified test coverage, production-path audit, focused retirement test, story gate, and epic gate."
    priorFindingStatuses:
[]
    newFindings:
[]
    openFindings:
[]
    requirementCoverage:
      verified:
        - "AC-6.1 / TC-6.1: src/cli, src/cli.ts, and src/providers/registry.ts are deleted per git diff; package.json has no bin and no dev:cli; src/index.ts exports only ./sdk.js; src/sdk.ts no longer exports resolveNamedProvider or registeredProviderNames; test/retirement.test.ts lines 58-90 asserts the SDK-only export snapshot, absent CLI entries, no package binary, and deleted surfaces."
        - "AC-6.2 / TC-6.1: all twelve test/cli-process*.test.ts files are deleted; find test -name cli-process*.test.ts returned no files; rg found no child_process/spawn/execFile/execa usage in package.json, vitest.config.ts, or remaining tests; pnpm run verify passed with 33 test files and 309 tests; diff review showed removed default-suite blocks were CLI in-process/parity blocks while SDK describes remained; check-test-immutability passed."
        - "AC-6.3 / TC-6.2: rg found zero LHC_PROVIDER or --provider references under src, package.json, or vitest.config.ts; createSdk throws TypeError(\"createSdk config: exactly one of provider or inference\") when neither provider nor inference is supplied; retirement.test.ts lines 93-122 asserts the source scan and confirms LHC_PROVIDER=\"deterministic\" does not trigger fallback resolution."
        - "Configured story gate: cd packages/lhc && pnpm run verify passed."
        - "Configured epic gate: cd packages/lhc && pnpm run verify-all passed."
      unverified:
[]
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/retirement.test.ts"
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
    productionPathFindings:
[]
    recommendedNextStep: "pass"
    recommendedFixScope: "same-session-implementor"
    openQuestions:
[]
    additionalObservations:
      - "Focused retirement suite passed: 1 file, 6 tests."
      - "Story and epic gates both ran red-verify plus full vitest successfully: build, typecheck, lint, boundaries, and 309 tests passed."
      - "Production-path audit found no material fake adapter, registry shim, hidden binary, wrapper command, or env/flag provider fallback in runtime code or built dist output."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/007-verify.json"
  startedAt: "2026-06-12T20:57:10.856Z"
  finishedAt: "2026-06-12T21:01:08.160Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/006-implementor.json
bytes: 12698
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "867bad85-4cc9-4aae-b9f7-179e61700485"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "9f78dc1a-4fbe-4699-948e-9b3f41e6eacd"
    continuation:
      provider: "claude-code"
      sessionId: "9f78dc1a-4fbe-4699-948e-9b3f41e6eacd"
      storyId: "01-cli-retirement"
    outcome: "ready-for-verification"
    story:
      id: "01-cli-retirement"
      title: "Story 1: CLI Retirement"
    planSummary: "Deletion-first CLI retirement per Flow 6 / DD-12. Deleted src/cli/ (8 modules), the src/cli.ts bin entrypoint, the named-provider registry (src/providers/registry.ts), the package bin entry and dev:cli script, and all twelve spawned cli-process-*.test.ts suites. src/index.ts now re-exports sdk.js only (runCli/CliResult gone); sdk.ts dropped the registry re-exports and gained the XOR construction error ('createSdk config: exactly one of provider or inference') ahead of all other validation, so the neither-provider-nor-inference case names the final contract with no fallback path. Verify scripts lost the LHC_PROCESS_SUITE gate and the SKIP echo; vitest.config.ts collapsed to one default no-network tier. Beyond the twelve spawned suites, the in-process CLI parity legs embedded in nine default-suite files (and the twinThreads parity fixture) were removed surgically — every SDK behavior assertion they accompanied was retained, verified by before/after suite comparison (328 default tests -> 309 = 25 parity-only legs removed + 6 new retirement tests). test/retirement.test.ts proves the SDK-only export snapshot, no bin manifest, deleted-surface absence, zero LHC_PROVIDER/--provider references under src/, and the XOR TypeError surviving a set LHC_PROVIDER env var. Red-manifest regenerated for amended/deleted/added test files."
    changedFiles:
      -
        path: "src/cli/index.ts"
        reason: "Deleted — CLI command dispatch (AC-6.1)"
      -
        path: "src/cli/inspect.ts"
        reason: "Deleted — CLI surface"
      -
        path: "src/cli/messages-mutate.ts"
        reason: "Deleted — CLI surface"
      -
        path: "src/cli/messages-read.ts"
        reason: "Deleted — CLI surface"
      -
        path: "src/cli/render.ts"
        reason: "Deleted — CLI surface (CliResult)"
      -
        path: "src/cli/turns-mutate.ts"
        reason: "Deleted — CLI surface"
      -
        path: "src/cli/view.ts"
        reason: "Deleted — CLI surface"
      -
        path: "src/cli/work.ts"
        reason: "Deleted — CLI surface; only consumer of env/flag provider resolution"
      -
        path: "src/cli.ts"
        reason: "Deleted — bin entrypoint outside src/cli/; leaving it breaks the build with a dead import"
      -
        path: "src/providers/registry.ts"
        reason: "Deleted — named-provider registry and LHC_PROVIDER resolution (AC-6.3, DD-12)"
      -
        path: "src/index.ts"
        reason: "Package entry now exports sdk.js only; runCli/CliResult exports removed (AC-6.1)"
      -
        path: "src/sdk.ts"
        reason: "Removed resolveNamedProvider/registeredProviderNames re-exports; added the XOR TypeError for neither-provider-nor-inference construction, first in validation order per tech-design Flow 1"
      -
        path: "src/shared/errors.ts"
        reason: "Removed CLI-only ErrorCode members empty_stdin and provider_not_configured (only consumers were the deleted CLI adapter and process suites; anti-shim — no dead vocabulary left behind)"
      -
        path: "package.json"
        reason: "Removed bin entry and dev:cli script; verify drops the SKIP echo; verify-all drops the LHC_PROCESS_SUITE gate (both now red-verify + full vitest); description no longer claims a CLI"
      -
        path: "vitest.config.ts"
        reason: "Removed the LHC_PROCESS_SUITE gating, process-suite exclusion list, and process timeout floor — one default no-network tier"
      -
        path: "test/cli-process.test.ts"
        reason: "Deleted — spawned-process parity suite (1 of 12, AC-6.2)"
      -
        path: "test/cli-process-intake.test.ts"
        reason: "Deleted — spawned-process parity suite"
      -
        path: "test/cli-process-projection.test.ts"
        reason: "Deleted — spawned-process parity suite"
      -
        path: "test/cli-process-turns.test.ts"
        reason: "Deleted — spawned-process parity suite"
      -
        path: "test/cli-process-work-queue.test.ts"
        reason: "Deleted — spawned-process parity suite"
      -
        path: "test/cli-process-work.test.ts"
        reason: "Deleted — spawned-process parity suite"
      -
        path: "test/cli-process-report-repair.test.ts"
        reason: "Deleted — spawned-process parity suite"
      -
        path: "test/cli-process-mutations.test.ts"
        reason: "Deleted — spawned-process parity suite"
      -
        path: "test/cli-process-mutations-delete.test.ts"
        reason: "Deleted — spawned-process parity suite"
      -
        path: "test/cli-process-fix.test.ts"
        reason: "Deleted — spawned-process parity suite"
      -
        path: "test/cli-process-view.test.ts"
        reason: "Deleted — spawned-process parity suite"
      -
        path: "test/cli-process-inspect.test.ts"
        reason: "Deleted — spawned-process parity suite (incl. the backfilled inspect-health parity leg; see specDeviations)"
      -
        path: "test/retirement.test.ts"
        reason: "New TC-6.1/TC-6.2 proof: SDK-only export snapshot, no bin, deleted surfaces absent, zero LHC_PROVIDER/--provider under src/, XOR TypeError with no env fallback"
      -
        path: "test/smoke.test.ts"
        reason: "Removed FC-0.3 CLI-rail describe (CLI-only behavior); FC-0.5 token-counting tests retained"
      -
        path: "test/intake.test.ts"
        reason: "Removed the 'Flow 2 (CLI in-process): stdin handling' describe (4 parity tests); all SDK recording/rollback tests retained"
      -
        path: "test/epic-fix.test.ts"
        reason: "Removed the 'CLI in-process: usage errors' describe; SDK F-EPIC-001/002 legs retained"
      -
        path: "test/turns.test.ts"
        reason: "Removed the 'Flow 3 (CLI in-process): turns list' describe and TC-4.4's trailing CLI-rendering sub-assertion; the three-way SDK error-class assertion retained intact"
      -
        path: "test/projection.test.ts"
        reason: "Removed the 'CLI in-process: messages list' describe (1 parity test)"
      -
        path: "test/threads.test.ts"
        reason: "Removed the 'Flow 1 (CLI in-process): threads commands' describe (5 parity tests mirroring TC-1.1–1.6 SDK legs, which remain)"
      -
        path: "test/work-queue.test.ts"
        reason: "Removed the 'CLI in-process: list-queued-work' describe (2 parity tests); SDK queue assertions retained"
      -
        path: "test/validation.test.ts"
        reason: "Removed TC-4.4's trailing CLI-adapter sub-assertions; SDK caller/system class assertions retained intact"
      -
        path: "test/inspect-view.test.ts"
        reason: "Removed the 'CLI parity: lhc inspect view' describe (1 parity test); SDK inspect.view/describe assertions retained"
      -
        path: "test/fixtures.test.ts"
        reason: "Removed FC-0.6 twin SDK/CLI read-back parity test"
      -
        path: "test/fixtures/threads.ts"
        reason: "Removed the twinThreads parity fixture (its only remaining consumer was FC-0.6)"
      -
        path: "test/fixtures/index.ts"
        reason: "Removed twinThreads re-export"
      -
        path: "test/fixtures/lifecycle.ts"
        reason: "createLifecycleSdk now injects createDeterministicProvider() directly — the registry resolution seam no longer exists"
      -
        path: "test/red-manifest.json"
        reason: "Regenerated: 11 deleted cli-process entries removed, 9 amended files re-hashed, retirement.test.ts added (spec-sanctioned amendment path; check-test-immutability passes)"
      -
        path: "scripts/lint.mjs"
        reason: "Comment-only: dropped the CLI render/CliResult rationale from the no-console rule"
      -
        path: "scripts/check-boundaries.mjs"
        reason: "Comment-only: inspect's consumers no longer include cli/"
    tests:
      added:
        - "test/retirement.test.ts — TC-6.1: export-name snapshot equals checked-in SDK-only list"
        - "test/retirement.test.ts — TC-6.1: CLI-only entries (resolveNamedProvider, registeredProviderNames, runCli) absent"
        - "test/retirement.test.ts — TC-6.1: package manifest has no bin, no dev:cli, no LHC_PROCESS_SUITE in scripts"
        - "test/retirement.test.ts — TC-6.1: src/cli, src/cli.ts, providers/registry.ts, and all cli-process suites absent on disk"
        - "test/retirement.test.ts — TC-6.2: zero LHC_PROVIDER / --provider references under src/"
        - "test/retirement.test.ts — TC-6.2: neither provider nor inference throws the XOR TypeError even with LHC_PROVIDER set in env"
      modified:
        - "test/turns.test.ts — TC-4.4 trailing CLI sub-assertion removed; SDK three-class assertion unchanged"
        - "test/validation.test.ts — TC-4.4 trailing CLI sub-assertions removed; SDK legs unchanged"
        - "test/smoke.test.ts, test/intake.test.ts, test/epic-fix.test.ts, test/projection.test.ts, test/threads.test.ts, test/work-queue.test.ts, test/inspect-view.test.ts, test/fixtures.test.ts — CLI-parity describes removed, SDK describes untouched"
        - "test/fixtures/lifecycle.ts — provider arrival switched from registry resolution to direct injection (assertion-neutral; lifecycle suite green unchanged)"
      removed:
        - "12 spawned-process suites: test/cli-process*.test.ts (parity-only; ran under verify-all's LHC_PROCESS_SUITE gate, outside the default tier)"
        - "25 in-process CLI parity legs across 9 default-suite files: smoke FC-0.3 (3), intake stdin describe (4), epic-fix CLI usage describe (6), turns CLI describe (2), projection (1), threads CLI TC-1.x legs (5), work-queue (2), inspect-view CLI parity (1), fixtures FC-0.6 twin (1)"
      totalAfterStory: 309
      deltaFromPriorBaseline: -19
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/retirement.test.ts"
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
        - "Default-suite tests and fixtures used the in-process CLI beyond the twelve spawned suites (runCli in 9 test files, twinThreads fixture, resolveNamedProvider in the lifecycle fixture) — each removed/rewired surgically with SDK assertions verified retained, rather than deleting whole files"
        - "src/shared/errors.ts comment contained the literal '--provider / LHC_PROVIDER' string, which would have failed TC-6.2's source scan — removed along with the two dead CLI-only error codes"
        - "Block cuts left trailing/double blank lines at EOF in several test files — normalized"
        - "Stale CLI references in lint.mjs, check-boundaries.mjs, and turns/intake test headers — updated"
        - "red-manifest.json regenerated after all test amendments so green-verify's immutability check passes (37 files OK)"
      findingsSurfaced:
        - "Suite-count accounting: default tier went 32 files/328 tests -> 33 files/309 tests; the -25/+6 delta is fully attributed to named parity-only legs plus the new retirement suite — no SDK domain-operation coverage was lost (every removed leg had a retained SDK twin in the same file)"
        - "verify and verify-all are now command-identical (red-verify + full vitest); they stay separate names per the four-tier convention — verify-all diverges again in Story 5 when the env-gated inference suite self-reports inside the runner"
    openQuestions:
[]
    specDeviations:
      - "Epic 04 parity-gap note (required by DoD): spawned `inspect health` parity was backfilled before Epic 05 (cli-process-inspect.test.ts), and this story deletes the spawned-process parity surface instead of carrying it forward."
      - "SdkConfig keeps `provider` as a required typed field this story; the runtime XOR TypeError ('createSdk config: exactly one of provider or inference') is in place per TC-6.2, but the typed `provider?`/`inference?` reshape needs InferenceConfig and lands in Story 2 per the chunk dependency order (0 -> 2). The retirement test exercises the runtime contract via an unknown-shape cast."
      - "Removed two CLI-only ErrorCode union members (`empty_stdin`, `provider_not_configured`) beyond the named export deletions — their only consumers were the deleted CLI adapter and process suites; leaving them would be dead resolution vocabulary contrary to the anti-shim requirements."
      - "In-process CLI parity legs inside default behavior suites (25 tests across 9 files, plus the twinThreads fixture and FC-0.6) were removed in addition to the twelve spawned suites named by the story — the CLI surface they drove no longer exists; each was parity-only and the red-manifest amendment path was used."
    recommendedNextStep: "Proceed to story verification, then Story 2 (inference seam and model assignment), which builds the typed provider-XOR-inference construction path on the runtime XOR rule this story planted."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/006-implementor.json"
  startedAt: "2026-06-12T20:44:32.006Z"
  finishedAt: "2026-06-12T20:57:02.052Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/story-lead/001-current.json
Bytes: 2306

```yaml
storyRunId: "01-cli-retirement-story-run-001"
storyId: "01-cli-retirement"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-verify completed with outcome pass and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "final-package"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/story-lead/001-final-package.json"
    provenance: "current-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/006-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/007-verify.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "9f78dc1a-4fbe-4699-948e-9b3f41e6eacd"
    storyId: "01-cli-retirement"
  storyVerifier:
    provider: "codex"
    sessionId: "019ebd9f-dc5a-7253-8957-dae1b2a5c1eb"
    storyId: "01-cli-retirement"
latestEventSequence: 17
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "Implementation reports ready-for-verification with required gates and completion evidence, but acceptance requires an independent verifier pass first."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/007-verify.json"
replayBoundary: null
updatedAt: "2026-06-12T21:01:08.168Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After implementation returns, verify recorded evidence includes retirement proof, full default suite result, SDK coverage comparison, and the Epic 04 parity deviation note before any acceptance recommendation.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-12T20:42:24.088Z; note="After implementation, verify the record includes SDK coverage comparison evidence and the Epic 04 parity deviation note before any acceptance recommendation."
- sequence=8; actionSequence=7; createdAt=2026-06-12T20:43:19.776Z; note="After the implementor response, verify recorded evidence includes retirement proof, full default suite result, SDK coverage comparison, and the Epic 04 parity deviation note before any acceptance recommendation."
- sequence=13; actionSequence=12; createdAt=2026-06-12T20:44:31.971Z; note="After implementation returns, verify recorded evidence includes retirement proof, full default suite result, SDK coverage comparison, and the Epic 04 parity deviation note before any acceptance recommendation."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/story-lead/001-events.jsonl
Bytes: 7621

```yaml
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 1
  timestamp: "2026-06-12T20:42:13.559Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 2
  timestamp: "2026-06-12T20:42:24.067Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ebd92-2cf0-7010-af92-4dd903107d03"
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 3
  timestamp: "2026-06-12T20:42:24.087Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation, verify the record includes SDK coverage comparison evidence and the Epic 04 parity deviation note before any acceptance recommendation."
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 4
  timestamp: "2026-06-12T20:42:24.088Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation, verify the record includes SDK coverage comparison evidence and the Epic 04 parity deviation note before any acceptance recommendation."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 5
  timestamp: "2026-06-12T20:43:05.663Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 6
  timestamp: "2026-06-12T20:43:19.751Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019ebd92-f6ef-7d42-b535-09d56fc49cf2"
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 7
  timestamp: "2026-06-12T20:43:19.776Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-continue."
  data:
    actionType: "run-continue"
    turn: 1
    selfNote: "After the implementor response, verify recorded evidence includes retirement proof, full default suite result, SDK coverage comparison, and the Epic 04 parity deviation note before any acceptance recommendation."
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 8
  timestamp: "2026-06-12T20:43:19.776Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After the implementor response, verify recorded evidence includes retirement proof, full default suite result, SDK coverage comparison, and the Epic 04 parity deviation note before any acceptance recommendation."
    actionSequence: 7
    actionType: "run-continue"
    turn: 1
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 9
  timestamp: "2026-06-12T20:43:19.804Z"
  type: "provider-output-invalid"
  summary: "Story-lead referenced unknown continuation handle 'storyImplementor'."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/story-lead/001-final-package.json"
  data:
    terminalDecision: "interrupted"
    recoveryBoundary:
      smallestSafeStep: "resume-from-last-valid-artifact"
      reasoning: "Provider output became invalid after durable artifacts were written, so replay should resume from the last valid artifact boundary."
      validArtifactPaths:
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/001-story-validate.json"
      requiresFreshStoryLeadSession: false
      requiresFreshChildProviderSession: true
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 10
  timestamp: "2026-06-12T20:44:20.667Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 11
  timestamp: "2026-06-12T20:44:31.945Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/story-lead/prompts/001-planner-turn-004.md"
    sessionId: "019ebd94-1bef-7da3-9df1-0c6662a84510"
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 12
  timestamp: "2026-06-12T20:44:31.970Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation returns, verify recorded evidence includes retirement proof, full default suite result, SDK coverage comparison, and the Epic 04 parity deviation note before any acceptance recommendation."
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 13
  timestamp: "2026-06-12T20:44:31.971Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation returns, verify recorded evidence includes retirement proof, full default suite result, SDK coverage comparison, and the Epic 04 parity deviation note before any acceptance recommendation."
    actionSequence: 12
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 14
  timestamp: "2026-06-12T20:57:02.062Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/006-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 15
  timestamp: "2026-06-12T20:57:10.797Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/story-lead/prompts/001-planner-turn-005.md"
    sessionId: "019ebd9f-bb66-7df2-b599-e86f5b9ad06a"
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 16
  timestamp: "2026-06-12T20:57:10.818Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "01-cli-retirement-story-run-001"
  sequence: 17
  timestamp: "2026-06-12T21:01:08.168Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome pass and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/artifacts/01-cli-retirement/007-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "pass"
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
