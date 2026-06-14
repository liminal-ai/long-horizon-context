# Story Lead Base Prompt

## Role Charter
You are the story lead for `00-foundation` on durable story run `00-foundation-story-run-001`.
Select exactly one bounded next action for this `run` turn.
This is planner turn 2.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/stories/00-foundation.md
Bytes: 11456

# Story 0: Package Foundations

### Summary
<!-- Jira: Summary field -->

The walking skeleton everything else lands on: package scaffold, error/result vocabulary, fixture builders, CLI rail with fail-closed stubs, and the four verification gates.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): Primary user is the harness integrator wiring a harness to the SDK; agents and developers drive the CLI during integration and verification. This story serves them indirectly — it builds the structure every later story adds behavior to.

**Objective:** Every later story adds behavior to a structure that already builds, runs, and fails closed. After this story, the package compiles strict, the CLI routes every planned command to a typed structured failure, fixtures produce valid inputs, and all four verification gates run and provably fail when they should.

**Scope — in:**
- Package scaffold per the tech design's module structure: `domains/` (threads, intake-stream, messages, turns — surface + `internal/`), `tech-utils/` (work-queue, token-counting), `shared/` (errors, context, storage), `cli/`, `sdk.ts`
- `shared/errors.ts` complete: `ErrorClass`, `ErrorCode`, `ErrorResult`, `OpResult<T>` exactly as the tech design's Interfaces section defines them
- `tech-utils/token-counting` complete (pure and small): `estimateTokens`, `TOKEN_ESTIMATOR_ID = "js-tiktoken:o200k_base"`
- CLI rail: command routing for all planned commands, each landing on a fail-closed stub returning `{ ok: false, error: { errorClass: "system_error", code: "storage_failure", reason: "not implemented: <op>" } }`; `--help`; unknown-command handling; JSON rendering; exit codes
- Fixture builders: `tempStore()`, `validEvent(kind, overrides?)` returning the discriminated `MessageEventInput` member for its kind, `eventBatch(kinds[])`, `conversationTurn()`, `openRaw(path)`, `corruptTwoOpenTurns(path)` (shape only; meaningful from Story 4)
- Verification gates: `red-verify`, `verify`, `green-verify`, `verify-all` runnable; `scripts/check-boundaries.mjs` enforcing import rules (fixtures exempt); CLI process suite scaffold with labeled skip under plain `verify`
- Smoke tests proving the rail, fixture validity, tokenizer determinism, and gate correctness

**Scope — out:** All product behavior. No thread creation, no intake, no projection, no turns, no work items. Stubs fail closed; nothing fakes success.

**Dependencies:** None. First story.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

This story owns no epic ACs. Its acceptance is the numbered foundation criteria below (FC ids are this story's receipt vocabulary, mirroring AC/TC structure for enrichment and closeout):

- **FC-0.1**: Package builds and typechecks strict; `red-verify` passes
- **FC-0.2**: `verify-all` passes with zero behavior tests; the CLI process suite's absence from plain `verify` prints a labeled skip, never silent
- **FC-0.3**: CLI responds to `--help`; unknown commands exit non-zero with a structured error; every planned command routes to a fail-closed stub with the exact stub error shape
- **FC-0.4**: Fixture builders produce inputs that decode clean against the boundary schemas once Story 2 lands (golden-shaped until then); building an invalid kind/payload pairing requires an explicit cast at the call site
- **FC-0.5**: `estimateTokens` returns golden counts for known strings; same input, same count, every run
- **FC-0.6**: Boundary check fails on a deliberate sabotage import (test-only file, then removed) and passes on the clean tree
- **FC-0.7**: Gate self-test: a sacrificial failing test fails `verify`; an edited Red-phase test file fails `green-verify` — proven once here, then trusted

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story builds the structure every other story lands behavior in: the domain-surface module tree with enforced import boundaries, the error/result vocabulary every operation speaks, the fixture builders every test arranges with, and the four verification gates every phase exits through. Nothing here is product behavior — the CLI routes to fail-closed stubs and the SDK exports types and one finished util (token counting, which is pure and costs nothing to complete now).

The gates are the real deliverable. Red/Green discipline in Stories 1–5 leans on `green-verify` catching edited tests and `verify` catching real failures — so this story must *prove the gates fail correctly*, once, with sacrificial files, rather than assume they do.

#### Build Strategy

Strategy: simple-risk-reminders

Reason:
- Mostly scaffold with obvious shape; TDD against stubs that intentionally fail would be circular.

Risk Reminders:
- Stubs must fail closed with the exact typed error shape — a stub returning fake success poisons every later story's red phase.
- Gate self-test (FC-0.7) is load-bearing: an unproven gate is an assumed gate.
- The boundary script must fail on a real sabotage import before it is trusted to pass the clean tree.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Module tree | `src/domains/{threads,intake-stream,messages,turns}/{index.ts,internal/}`, `src/tech-utils/{work-queue,token-counting}/`, `src/shared/`, `src/cli/`, `src/sdk.ts` |
| Error vocabulary | `src/shared/errors.ts` |
| Operation context type | `src/shared/context.ts` |
| Storage helpers | `src/shared/storage.ts` (open, WAL pragmas, migration runner) |
| Token counting | `src/tech-utils/token-counting/index.ts` |
| CLI rail | `src/cli/index.ts`, `src/cli/render.ts` |
| Fixtures | `test/fixtures/` (builders, temp stores, `corrupt.ts`, `openRaw`) |
| Gates | `scripts/check-boundaries.mjs`, package scripts `red-verify`/`verify`/`green-verify`/`verify-all` |
| Smoke tests | `test/smoke.test.ts`, `test/fixtures.test.ts` (names inferred; Chunk 0 scope) |

#### Design References

- [02-tech-design.md §Module Structure](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:72), lines 72–119
- [02-tech-design.md §Design Decision 4: Error representation](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:157), lines 157–176
- [02-tech-design.md §Interfaces: Shared vocabulary](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:372), lines 372–407
- [02-tech-design.md §Verification Gates](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:574), lines 574–586
- [02-tech-design.md §Chunk 0: Foundations](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:593), lines 593–599
- [03-test-plan.md §Testing Strategy](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/03-test-plan.md:5), lines 5–23
- [03-test-plan.md §Fixture Contracts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/03-test-plan.md:24), lines 24–39

#### Test Mapping

No epic TCs. Story-owned checks are FC-0.1 through FC-0.7 (numbered in Acceptance Criteria above):

| FC | Test File / Check | Description |
|----|-------------------|-------------|
| FC-0.1 | `pnpm run red-verify` | build + typecheck + lint + boundaries, clean |
| FC-0.2 | `pnpm run verify-all` | passes with zero behavior tests; labeled CLI-suite skip under `verify` |
| FC-0.3 | `test/smoke.test.ts` | help, unknown command, stub failure shape |
| FC-0.4 | `test/fixtures.test.ts` | builder defaults golden-shaped; invalid pairings need explicit casts |
| FC-0.5 | `test/smoke.test.ts` | golden token counts, repeated runs identical |
| FC-0.6 | boundary-check self-test | sabotage import fails, clean tree passes |
| FC-0.7 | gate self-test (recorded, then removed) | failing test fails `verify`; edited Red file fails `green-verify` |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Fixture validity | `test/fixtures.test.ts` | builders produce valid default states | test substrate correctness, not product behavior — no TC names it |
| Boundary check guards itself | self-test in FC-0.6 | the guard fails when violated | a silently broken guard passes every later story while enforcing nothing |
| Gates fail correctly | FC-0.7 procedure | gates catch what they exist to catch | a gate that cannot fail certifies nothing |

#### Technical Notes

- Error result vocabulary (contractual for every later story): `errorClass` ∈ `caller_error` / `state_corruption` / `system_error`; stable `code` set `path_exists`, `thread_not_found`, `invalid_event`, `empty_batch`, `empty_stdin`, `turn_state_corrupt`, `storage_failure`; `eventIndex` on batch validation failures; `reason` human-readable, machine logic switches on `code`.
- `empty_stdin` is CLI-adapter-only, emitted before any SDK call. Operational failures return as `OpResult` errors, never thrown; programmer bugs may throw and are not contract outcomes.
- CLI conventions: every command body is one SDK call plus rendering; JSON output matching SDK shapes; exit 0/1.
- `shared/` is mechanism-only: primitive cross-cutting identifiers and the result vocabulary, no domain workflows, row shapes, or policies.

#### Anti-Shim Requirements

- Stub error shape is asserted exactly (`system_error` / `storage_failure` / `not implemented: <op>`) — not just "an error happened."
- The gate self-test must use real sacrificial files run through the real scripts; a gate "reviewed as correct" is not a gate proven to fail.
- Fixture builders return the discriminated `MessageEventInput` member per kind — invalid kind/payload pairings must be compile errors, demonstrated by an `@ts-expect-error` case, not convention.

#### Production Path Proof

- Entrypoint: `dist/cli.js` via the `lhc` bin; SDK via package exports.
- Registration/default path: `package.json` `bin` + `exports` maps; CLI router reaches every planned command.
- Evidence: process-suite legs (`--help`, unknown command, stub shape) spawn the built binary; `verify-all` includes them.

#### Verification

- Targeted: `pnpm test -- test/smoke.test.ts test/fixtures.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] Module tree matches the tech design's structure; every file belongs to one domain, util, shared, or cli
- [ ] `shared/errors.ts` and `tech-utils/token-counting` complete and exported
- [ ] All planned CLI commands route to fail-closed stubs; no stub returns fake success
- [ ] Fixture builders implemented; `corruptTwoOpenTurns` is the only below-SDK writer and lives in the exempt fixtures directory
- [ ] All four verification scripts runnable from `packages/lhc`; boundary check wired into `verify`
- [ ] Smoke suite green (4–6 tests) covering FC-0.1 through FC-0.7; gate self-test (FC-0.7) performed and recorded
- [ ] `verify-all` passes end to end


### Test Plan
### test-plan
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/test-plan.md
Bytes: 11854

# Epic 01: Thread Record and Intake — Test Plan

**Companion to:** `02-tech-design.md` · TCs from `01-epic.md`

## Testing Strategy

The system under test is the lhc package entered through its two real entry points: SDK operations and CLI commands. Internal modules — pipeline, projection, stores, registry — are exercised through those entries, never tested in isolation against mocked neighbors. Two deliberate exceptions get supplemental pure-function suites because they are genuinely pure logic with contractual behavior: the turn state machine (golden cases mirroring the epic's rule table) and token estimation (golden counts). Everything else earns its coverage through entry-point behavior.

**What gets mocked: nothing.** This epic has no network, no inference provider, no clock-sensitive contract beyond injected `clock`, and its filesystem behavior *is* the product (durability, atomicity, restart survival). Every test runs against real SQLite files in a per-test temp directory. The injected clock is fixed per test for deterministic `recordedAt`/`queuedAt`/`createdAt`; the tokenizer runs real because golden-counting real output is stronger than stubbing it.

**Test layers:**

| Layer | Runner | Enters through | In `verify` |
|-------|--------|----------------|-------------|
| SDK behavior | vitest | SDK operations on temp stores | yes |
| CLI in-process | vitest | command router with argv + stdin injection | yes |
| CLI process boundary | vitest, spawns `dist/cli.js` | real argv/stdin/exit codes | `verify-all` only (labeled skip otherwise) |
| Pure supplemental | vitest | state machine, tokenizer directly | yes |

CLI in-process tests cover command logic cheaply (parsing, SDK call, rendering); the process suite proves the executable boundary (shebang, stdin wiring, exit codes, JSON on stdout) for a representative subset, not every TC.

**Naming convention:** test titles carry their TC ids (`"TC-3.2: second prompt closes open turn"`), so traceability is greppable from the suite itself.

## Fixture Contracts

From `fixtures/` (test-only; exempt from boundary check):

| Builder | Produces | Default state |
|---------|----------|---------------|
| `tempStore()` | temp dir with registry path + thread path factory | empty, valid |
| `validEvent(kind, overrides?)` | one event input | valid per Flow 4 schemas; unique idempotency key; returns the discriminated `MessageEventInput` member for its kind, so kind-payload mismatches in test code are compile errors — building an invalid pairing requires an explicit cast at the call site |
| `eventBatch(kinds[])` | ordered event array | valid; keys unique within batch |
| `conversationTurn()` | `[user_prompt, assistant_text, tool_call, tool_result, turn_end]` | one complete turn |
| `threadWith(events)` | created thread + recorded batch via real SDK | post-Chunk-2: real pipeline output |
| `corruptTwoOpenTurns(path)` | below-SDK direct insert of second open turn row | the one sanctioned invalid-state fixture |
| `openRaw(path)` | direct `node:sqlite` handle for assertions | read-only use by convention |

Builder validity is itself tested (Chunk 0 smoke): defaults decode clean against the Flow 4 schemas. Invalid states are never builder defaults — tests construct invalidity explicitly via `overrides` (e.g. `validEvent("user_prompt", { payload: { wrong: true } })`), so a reader always sees the invalidity at the call site.

## TC → Test Mapping

File paths under `packages/lhc/test/`. Setup column shows the distinguishing arrangement; assertions are the TC's, restated only where the design sharpened them.

### Flow 1 — `threads.test.ts`

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-1.1 | create happy path | `tempStore()` | ok result; file exists; `openRaw` reads metadata row (threadId, createdAt, token_estimator); registry row matches |
| TC-1.2 | occupied path | pre-write a file at target | `path_exists`, `caller_error`; file bytes unchanged; registry row count unchanged |
| TC-1.3 | resolve known/unknown | one created thread | known: ok with path+metadata; unknown: `thread_not_found` |
| TC-1.4 | id/path equivalence | two identical threads, batch to one by id, one by path | identical BatchResults (modulo threadId); identical full read-back — *lives in `intake.test.ts`, owned by Chunk 2* |
| TC-1.5 | listing | three threads; also: list against absent registry | three rows, fields complete; absent registry → ok, empty array, no file created |
| TC-1.6 | compensation | `registryPath` whose parent is an existing regular file (deterministic cross-platform failure; read-only dirs are not — root and CI sandboxes ignore permission bits) | error result; thread file deleted; no registry |

### Flow 2 — `intake.test.ts` (recording), `projection.test.ts` (messages)

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-2.1 | order continuity | two 3-event batches | read-back: 6 events, orders 1–6, array order preserved |
| TC-2.2 | per-kind projection | `eventBatch` with all seven kinds | 6 messages (no turn_end); block types per design's mapping table; content verbatim |
| TC-2.3 | estimate determinism | same content, two threads | identical estimates; estimate present on all messages |
| TC-2.4 | tool-result fidelity | 300KB content string | read-back content byte-identical via SDK; repeated through spawned CLI in process suite |
| TC-2.5 | actor/harness carry | distinct values per event | values on event and message rows unchanged |
| TC-2.6 | result completeness | mixed batch (new, duplicate, prompt, turn_end) | per-event outcomes in order; messageIds; transitions; queuedWork; threadPosition |
| TC-2.7 | message work queued | prompt + tool_result batch | two items: `w-m1-prompt_smoothing`, `w-m2-tool_result_summary`; owner messages; status queued |
| TC-2.8 | empty batch | `[]` | `empty_batch`, `caller_error`; read-back unchanged |
| TC-2.9 | non-qualifying kinds | text/thinking/note batch | zero work items |

### Flow 3 — `turns.test.ts` + `state-machine.test.ts` (pure)

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-3.1 | open + stamp | prompt, text, tool_call, tool_result | one open turn; all four messages stamped to it |
| TC-3.2 | implicit close | prompt A activity, then prompt B | turn 1 closed, members frozen; turn 2 open, only prompt B |
| TC-3.3 | explicit close + work | prompt, text, turn_end | turn closed; `w-t1-turn_derivation` queued (work assertion owned by Chunk 5) |
| TC-3.4 | orphan turn_end | turn_end as first event | event recorded order 1; zero turns; zero work; next prompt opens t1 |
| TC-3.5 | frozen + gap | turn_end, then text, then prompt | text message turnId null; closed turn members unchanged; new turn holds only prompt |
| TC-3.6 | implicit close work parity | TC-3.2 setup | same work-item contract as explicit path (Chunk 5) |
| TC-3.7 | corruption | `corruptTwoOpenTurns`, then any batch | `turn_state_corrupt`, `state_corruption`; read-back unchanged |
| TC-3.8 | multi-turn batch | one batch: prompt, text, prompt, text, turn_end | two closed turns; correct membership; two turn work items |
| — | golden transitions | pure function | every rule-table row: (state, kind) → expected effect |

### Flow 4 — `validation.test.ts`

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-4.1 | four invalidity categories | four batches: unknown kind; missing idempotencyKey; caller-supplied eventOrder; turn_end with payload | each rejected whole; `invalid_event`; reason names the specific violation (server-field denial named as such) |
| TC-4.2 | first-failure index | valid, valid, invalid at index 2 | `eventIndex: 2`; events 0–1 not recorded |
| TC-4.3 | no trace | baseline thread, then rejected batch | full read-back (events, messages, turns, work) logically equal to baseline |
| TC-4.4 | class separation | one validation failure, one corruption (corrupt fixture), one storage failure (file-as-parent registryPath) | three distinct errorClasses, stable codes; same shapes via CLI in-process |
| TC-4.5 | valid-prefix rejection | new events + duplicates + one invalid | rejected whole; duplicates' originals unchanged; new events absent |
| — | unknown-field strictness | extra field at envelope, event, and payload levels | each rejected; three levels each named in reason |
| — | empty actor/harness | `validEvent` with `actor: ""` | rejected as missing required field |

### Flow 5 — `idempotency.test.ts`

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-5.1 | full resend | record 5, resend same 5 | zero recorded; five skips with `duplicate_idempotency_key`; read-back unchanged |
| TC-5.2 | partial resend | 3 recorded + 2 new | three skips, two recorded; orders continue dense (no gaps from skips) |
| TC-5.3 | cross-thread keys | same key, two threads | both record |
| TC-5.4 | skips inert | resend recorded prompt + turn_end mid-conversation | turn count/states unchanged; no transitions in result; work-item count unchanged; no duplicate message |
| TC-5.5 | key wins | key K with payload A recorded; resend K with valid payload B | skipped; read-back returns A; B nowhere in any table (`openRaw` scan) |

### CLI process suite — `cli-process.test.ts` (verify-all only)

Representative boundary proofs, not full TC repetition: `new-thread` → `resolve` round-trip; `message-events` via real stdin (including the 300KB tool result); TTY/empty stdin → `empty_stdin`, exit 1; one validation failure → JSON error shape, exit 1; `--help` and unknown command exit codes.

## Architecture-Risk Tests (non-TC)

Behaviors no TC names but the design promises; each exists because AC/TC mapping alone would miss it.

| Risk | Test | Why TCs miss it |
|------|------|-----------------|
| Atomicity under mid-walk failure | induced failure inside the transaction (test seam closes handle) → read-back equals baseline | TC-4.3 covers validation rejection; this covers in-transaction failure |
| Restart survival | record batch, close handle, reopen → identical read-back including work items | NFR, no TC; the durability claim itself |
| Rejected batch takes no lock | concurrent open succeeds while rejection-path runs | design promise (pure validation before transaction), invisible to single-connection TCs |
| system_error rollback parity | storage failure mid-batch → rollback whole, `system_error` class | AC-4.6 is class-independent; TCs only exercise caller-error rejection |
| Fixture validity | builder defaults decode against real schemas | test substrate correctness, not product behavior |
| Boundary-check self-test | sabotage import fails the script | guards the guard |
| Verification gates fail correctly | failing test fails `verify`; edited Red file fails `green-verify` | proves the gates once (Chunk 0), then trusted |
| Registry lazy-init non-creation | reads against absent registry create no file | easy to get accidentally wrong with open-or-create storage helpers |

## Coverage Summary

| Flow | TCs | Supplemental | Est. tests |
|------|-----|--------------|-----------|
| 1 | 6 | lazy-init | 9 |
| 2 | 9 | — | 12 |
| 3 | 8 | golden suite | 14 |
| 4 | 5 | strictness, empty-fields | 10 |
| 5 | 5 | — | 7 |
| CLI process | — | boundary proofs | 6 |
| Architecture-risk | — | 8 risks | 9 |
| Chunk 0 smoke | — | rail, fixtures, tokenizer, gates | 5 |
| **Total** | **33** | | **~72** |

Within the epic's 60–72 estimate, at the top because architecture-risk tests are enumerated rather than folded in. Every TC from the epic appears exactly once as an owned row; the two cross-chunk deferrals (TC-1.4 → Chunk 2; TC-3.3/3.6 work halves → Chunk 5) are marked at their rows and owed by their receiving chunks.


## Current Run Index
- planner_turn_index: 2
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-implement completed with outcome blocked and status blocked.
- latest_response_kind: implementor-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/00-foundation/003-implementor.json
- older_response_count: 0
- caller_input_artifact_count: 0
- prior_self_note_count: 1
- latest_self_note: "Next planner turn should evaluate the implementor artifact for FC-0.1 through FC-0.7 evidence before choosing verify or quick-fix."

## Response Trail
<current_response>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/00-foundation/003-implementor.json
bytes: 9853
payload:
  command: "story-implement"
  version: 1
  status: "blocked"
  outcome: "blocked"
  result:
    resultId: "b1cbd244-679c-45c0-bb59-04776c8dee6b"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "503ffff4-9a92-4d68-b24c-39042ca211c4"
    continuation:
      provider: "claude-code"
      sessionId: "503ffff4-9a92-4d68-b24c-39042ca211c4"
      storyId: "00-foundation"
    outcome: "blocked"
    story:
      id: "00-foundation"
      title: "Story 0: Package Foundations"
    planSummary: "Built the full Story 0 foundation: module tree per tech design (domains/{threads,intake-stream,messages,turns} with surface + internal/, tech-utils/{token-counting,work-queue}, shared/{errors,context,storage}, cli/, sdk.ts); shared/errors.ts exactly per the Interfaces section plus a notImplemented helper; complete pure token counting via js-tiktoken o200k_base with TOKEN_ESTIMATOR_ID; CLI rail routing all nine planned commands to fail-closed stubs with the exact stub error shape, --help, structured unknown-command errors, JSON rendering and 0/1 exit codes; fixture builders (tempStore, validEvent returning the discriminated member per kind, eventBatch, conversationTurn, openRaw, corruptTwoOpenTurns shape-only); zero-dependency gate scripts (check-boundaries.mjs with fixtures exemption, lint.mjs, check-test-immutability.mjs with red-manifest recording helper); all four verification scripts wired (red-verify/verify/green-verify/verify-all) with labeled cli-process skip under plain verify; smoke, fixtures, and cli-process test suites covering FC-0.1 through FC-0.5. BLOCKED: this environment denied every command-execution request (pnpm, node, tsx, local node_modules binaries, including the configured gate commands themselves), so no gate was run, the build is unverified, and the FC-0.6/FC-0.7 sacrificial self-tests (sabotage import, failing test, edited Red file) could not be performed. eslint installation was also denied, so the lint gate is a minimal zero-dependency in-repo script."
    changedFiles:
      -
        path: "packages/lhc/src/shared/errors.ts"
        reason: "ErrorClass/ErrorCode/ErrorResult/OpResult exactly per tech design Interfaces, plus notImplemented stub helper"
      -
        path: "packages/lhc/src/shared/context.ts"
        reason: "OperationContext type per Design Decision 8"
      -
        path: "packages/lhc/src/shared/storage.ts"
        reason: "sqlite open helper with WAL pragmas and user_version migration runner"
      -
        path: "packages/lhc/src/tech-utils/token-counting/index.ts"
        reason: "complete pure estimateTokens via js-tiktoken o200k_base and TOKEN_ESTIMATOR_ID constant"
      -
        path: "packages/lhc/src/tech-utils/work-queue/index.ts"
        reason: "WorkOwner/WorkKind/WorkSourceRef/WorkItemRecord contract types (behavior lands Story 5)"
      -
        path: "packages/lhc/src/domains/threads/index.ts"
        reason: "ThreadRef/NewThreadInput/ThreadInfo types and fail-closed stubs for newThread/resolve/listThreads"
      -
        path: "packages/lhc/src/domains/intake-stream/index.ts"
        reason: "MessageEventInput discriminated union, EventKind, BatchResult, EventRecord, fail-closed messageEvents/listEvents stubs"
      -
        path: "packages/lhc/src/domains/messages/index.ts"
        reason: "Block/MessageRecord types and fail-closed listMessages/listQueuedWork stubs"
      -
        path: "packages/lhc/src/domains/turns/index.ts"
        reason: "TurnRecord type and fail-closed listTurns/listQueuedWork stubs"
      -
        path: "packages/lhc/src/domains/threads/internal/.gitkeep"
        reason: "internal/ directory placeholder per module structure"
      -
        path: "packages/lhc/src/domains/intake-stream/internal/.gitkeep"
        reason: "internal/ directory placeholder per module structure"
      -
        path: "packages/lhc/src/domains/messages/internal/.gitkeep"
        reason: "internal/ directory placeholder per module structure"
      -
        path: "packages/lhc/src/domains/turns/internal/.gitkeep"
        reason: "internal/ directory placeholder per module structure"
      -
        path: "packages/lhc/src/cli/index.ts"
        reason: "CLI rail: parseArgs routing for all nine planned commands, --help, unknown-command structured error"
      -
        path: "packages/lhc/src/cli/render.ts"
        reason: "JSON rendering of OpResult shapes, exit codes, adapter-level CLI error rendering"
      -
        path: "packages/lhc/src/cli.ts"
        reason: "bin entry rewritten to await the new async CLI router"
      -
        path: "packages/lhc/src/sdk.ts"
        reason: "public SDK assembly: domain namespaces, token util, shared and contract types"
      -
        path: "packages/lhc/src/index.ts"
        reason: "package exports: SDK plus runCli/CliResult for in-process CLI tests"
      -
        path: "packages/lhc/scripts/check-boundaries.mjs"
        reason: "zero-dependency import-boundary check (cross-domain internal/ ban; tech-utils/shared may not import domains; fixtures exempt)"
      -
        path: "packages/lhc/scripts/lint.mjs"
        reason: "zero-dependency lint gate (no var, no any escapes, no console in src) — eslint install was denied"
      -
        path: "packages/lhc/scripts/check-test-immutability.mjs"
        reason: "green-verify guard comparing Red-phase test file hashes against test/red-manifest.json"
      -
        path: "packages/lhc/scripts/record-red-manifest.mjs"
        reason: "helper to record Red-phase test file hashes for later stories"
      -
        path: "packages/lhc/test/fixtures/index.ts"
        reason: "tempStore, validEvent (discriminated per kind), eventBatch, conversationTurn, openRaw builders"
      -
        path: "packages/lhc/test/fixtures/corrupt.ts"
        reason: "corruptTwoOpenTurns shape-only below-SDK writer (meaningful from Story 4)"
      -
        path: "packages/lhc/test/smoke.test.ts"
        reason: "FC-0.3 rail tests (help, unknown command, exact stub shape for all nine commands) and FC-0.5 tokenizer goldens/determinism"
      -
        path: "packages/lhc/test/fixtures.test.ts"
        reason: "FC-0.4 builder golden shapes, override behavior, @ts-expect-error invalid-pairing proof, tempStore/openRaw checks"
      -
        path: "packages/lhc/test/cli-process.test.ts"
        reason: "process-boundary suite scaffold spawning dist/cli.js (verify-all only)"
      -
        path: "packages/lhc/vitest.config.ts"
        reason: "excludes cli-process suite unless LHC_PROCESS_SUITE=1; keeps vitest default excludes"
      -
        path: "packages/lhc/tsconfig.test.json"
        reason: "noEmit typecheck config covering tests so @ts-expect-error fixture proofs are enforced"
      -
        path: "packages/lhc/package.json"
        reason: "added lint/boundaries scripts and the four gates: red-verify, verify (with labeled cli-process skip), green-verify, verify-all"
    tests:
      added:
        - "test/smoke.test.ts"
        - "test/fixtures.test.ts"
        - "test/cli-process.test.ts"
      modified:
[]
      removed:
[]
      totalAfterStory: 18
      deltaFromPriorBaseline: 18
    gatesRun:
      -
        command: "pnpm --dir packages/lhc run red-verify"
        result: "not-run"
      -
        command: "pnpm --dir packages/lhc run verify"
        result: "not-run"
      -
        command: "pnpm --dir packages/lhc run green-verify"
        result: "not-run"
      -
        command: "pnpm --dir packages/lhc run verify-all"
        result: "not-run"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "tsconfig.test.json originally inherited the base exclude (which excludes test/ and **/*.test.ts), so test files would never have been typechecked and the @ts-expect-error proof would be dead — overrode exclude"
        - "Verified js-tiktoken 1.0.21 export map and d.ts shapes against node_modules before relying on js-tiktoken/lite and js-tiktoken/ranks/o200k_base default-import under NodeNext"
      findingsSurfaced:
        - "Every command execution (pnpm, node, tsx, node_modules/.bin/*, including the configured gate commands) was denied approval in this environment — nothing was built, typechecked, linted, or tested; all gate results are unverified"
        - "FC-0.6 boundary sabotage self-test and FC-0.7 gate self-tests (sacrificial failing test, edited Red-file manifest check) were NOT performed — they require running the real scripts"
        - "Golden token counts asserted in smoke.test.ts (hello world = 2, empty = 0 under o200k_base) are from knowledge, not from an executed run; if wrong, the test will catch it on first verify run"
        - "eslint installation was denied, so the lint gate is scripts/lint.mjs, a minimal zero-dependency rule set (no var, no any escapes, no console in src) rather than ESLint"
    openQuestions:
      - "Unknown CLI commands emit code \"unknown_command\" (errorClass caller_error) — this code is CLI-adapter-only and outside the shared ErrorCode set, mirroring the empty_stdin precedent; confirm or name a preferred adapter code"
      - "Stub op names use CLI command spelling (e.g. \"not implemented: threads.new-thread\") — confirm this is the intended <op> vocabulary before later stories assert against it"
      - "Test immutability for green-verify is implemented as a hash manifest (test/red-manifest.json + record-red-manifest.mjs) rather than git-commit comparison — confirm this mechanism suits the harness workflow"
    specDeviations:
      - "Lint gate is a zero-dependency in-repo script (scripts/lint.mjs) instead of ESLint because dependency installation was denied in this environment"
      - "domain internal/ directories contain .gitkeep placeholders only — no internal modules exist yet, which is consistent with Story 0's no-behavior scope but means the literal files named in the tech design tree (registry.ts, validate.ts, etc.) arrive in Stories 1–5"
    recommendedNextStep: "Re-run in an environment that permits command execution (or grant Bash approval for pnpm/node in packages/lhc), then: (1) run pnpm run verify-all and fix any compile/test fallout — likely candidates are the unverified golden token counts and NodeNext import edges; (2) perform and record the FC-0.6 sabotage-import self-test and FC-0.7 gate self-tests with sacrificial files; (3) run green-verify as the story gate."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/00-foundation/003-implementor.json"
  startedAt: "2026-06-10T12:13:45.133Z"
  finishedAt: "2026-06-10T12:25:41.891Z"
```
</current_response>

<history_responses>
No older response entries are recorded yet.
</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/00-foundation/story-lead/001-current.json
Bytes: 1752

```yaml
storyRunId: "00-foundation-story-run-001"
storyId: "00-foundation"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-implement completed with outcome blocked and status blocked."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/00-foundation/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/00-foundation/003-implementor.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "503ffff4-9a92-4d68-b24c-39042ca211c4"
    storyId: "00-foundation"
latestEventSequence: 5
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "No bounded child response exists yet, and the durable record shows the run is waiting for the first story-lead action. The smallest safe next action is to start implementation against the story-local requirements and existing prior validation artifact."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/00-foundation/003-implementor.json"
replayBoundary: null
updatedAt: "2026-06-10T12:25:41.900Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: Next planner turn should evaluate the implementor artifact for FC-0.1 through FC-0.7 evidence before choosing verify or quick-fix.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-10T12:13:45.099Z; note="Next planner turn should evaluate the implementor artifact for FC-0.1 through FC-0.7 evidence before choosing verify or quick-fix."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/00-foundation/story-lead/001-events.jsonl
Bytes: 2025

```yaml
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 1
  timestamp: "2026-06-10T12:13:29.871Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 2
  timestamp: "2026-06-10T12:13:45.079Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/00-foundation/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019eb173-b518-7bd2-9401-18099ae7a8cb"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 3
  timestamp: "2026-06-10T12:13:45.099Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "Next planner turn should evaluate the implementor artifact for FC-0.1 through FC-0.7 evidence before choosing verify or quick-fix."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 4
  timestamp: "2026-06-10T12:13:45.099Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "Next planner turn should evaluate the implementor artifact for FC-0.1 through FC-0.7 evidence before choosing verify or quick-fix."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 5
  timestamp: "2026-06-10T12:25:41.900Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome blocked and status blocked."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/00-foundation/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "blocked"
    status: "blocked"
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
Bytes: 367

```yaml
storyGate: "pnpm --dir /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc run green-verify"
epicGate: "pnpm --dir /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc run verify-all"
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
