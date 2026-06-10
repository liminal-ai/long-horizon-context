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
