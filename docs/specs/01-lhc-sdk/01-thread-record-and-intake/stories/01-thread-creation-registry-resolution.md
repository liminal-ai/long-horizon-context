# Story 1: Thread Creation, Registry, Resolution

### Summary
<!-- Jira: Summary field -->

`threads new-thread`, `resolve`, and `list` on SDK and CLI; the registry with lazy initialization; id-or-path thread references.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): Primary user is the harness integrator wiring a harness to the SDK — creation is the first call any integration makes. Agents and developers create test threads from the CLI.

**Objective:** A thread exists, carries its identity in its own file, and can be found. Creation writes the thread file with its id stored once as file-level metadata, registers it, and compensates correctly when registration fails. Resolution and listing work, including against a registry that has never been written.

**Scope — in:**
- `newThread` against a non-existent path: file creation, schema v1, metadata row (thread id, created-at, `token_estimator`), registry row
- Refusal with `path_exists` against an occupied path; compensation (file deleted) when the registry insert fails
- `resolve` and `listThreads`; registry lazy-create on first write; reads against an absent registry return empty list / `thread_not_found` without creating it
- `resolveThreadRef` — the single interpreter of `{ threadId }` vs `{ filePath }` references
- CLI: `threads new-thread`, `threads resolve`, `threads list` with `--registry`
- Read-path id/path equivalence

**Scope — out:** Registry cache refresh and cached statistics (later epic). Thread deletion, relocation, archival. Full id/path equivalence under intake (TC-1.4) — exercisable only after Story 2 delivers `message-events`; noted there as a completion debt.

**Dependencies:** Story 0 (error vocabulary, temp-dir fixtures, CLI rail, gates).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-1.1**: Creating a thread against a path that does not exist creates the thread file and returns the new thread id and the path.
  - **TC-1.1** (AC-1.1, 1.3, 1.4): Create a thread at a fresh path → file exists, id returned, id readable from file metadata, registry row present with matching id and path.
- **AC-1.2**: Creating a thread against a path that already exists fails with `path_exists`; the existing file is untouched and no registry row is added.
  - **TC-1.2** (AC-1.2): Create a thread at an occupied path → `path_exists` error; pre-existing file bytes unchanged; registry row count unchanged.
  - **TC-1.6** (AC-1.2): Creation failure leaves no orphan registry row pointing at a never-created file.
- **AC-1.3**: The created thread file stores its thread id once, as file-level metadata, and the id is readable back from the file alone (without the registry).
  - Verified by TC-1.1 (`openRaw` reads the metadata row directly).
- **AC-1.4**: Creation adds one registry row holding the thread id, file path, optional title, and created-at time.
  - Verified by TC-1.1.
- **AC-1.5**: Resolving a known thread id returns its file path and registry metadata; resolving an unknown id fails with `thread_not_found`.
  - **TC-1.3** (AC-1.5): Resolve the created id → correct path; resolve a random id → `thread_not_found`.
- **AC-1.6**: Every thread-scoped operation accepts the thread by id or by file path, and both reach the same thread with identical behavior.
  - This story proves read-path equivalence (resolve-then-read vs direct-path read). **TC-1.4 is owned by Story 2** — full equivalence under `message-events` cannot run before intake exists. This story must not claim AC-1.6 complete.
- **AC-1.7**: Listing threads returns the registry's rows.
  - **TC-1.5** (AC-1.7): Create three threads → list returns all three with ids, paths, titles, created-at. Supplemental: list against an absent registry → ok, empty array, no registry file created.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story makes threads exist and be findable — the `threads` domain surface, the registry database, and the reference-resolution seam every later operation enters through. Two design facts dominate. First, creation spans two databases that cannot share a transaction, so the order is file-then-row with compensation: the invariant "no registry row without its file" is absolute, while an orphan file from a crash between the writes is documented harmless. Second, `resolveThreadRef` is the *single* interpreter of `{ threadId }` vs `{ filePath }` — no other code ever reads a thread reference, which is what makes id/path equivalence structural rather than tested-into-existence.

The thread file this story creates is the substrate of every later story: schema v1 plus the metadata row (thread id stored once, created-at, `token_estimator = "js-tiktoken:o200k_base"`).

#### Build Strategy

Strategy: tdd-lite

Reason:
- Behavior is well-specified with clear red targets (TC-1.1–1.6), but the compensation path and lazy-init are easy to shortcut — a naive open-or-create storage helper silently breaks both.

Risk Reminders:
- Compensation must be exercised by a real registry failure (file-as-parent path), not a mocked insert error.
- Lazy-init non-creation: reads against an absent registry must not create the file — easy to get wrong with open-or-create helpers (named architecture risk).
- The metadata row is contractual: `openRaw` must read the id back without the registry (AC-1.3).

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Surface | `src/domains/threads/index.ts` (newThread, resolve, listThreads, resolveThreadRef) |
| Registry | `src/domains/threads/internal/registry.ts` (lazy open/create, row ops) |
| Creation + compensation | `src/domains/threads/internal/create.ts` |
| Thread-file schema v1 | via `src/shared/storage.ts` migration runner |
| CLI | `src/cli/` — `threads new-thread`, `threads resolve`, `threads list`, `--registry` |
| Tests | `test/threads.test.ts` |

#### Design References

- [02-tech-design.md §Flow 1: Thread Creation and Resolution](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:222), lines 222–261
- [02-tech-design.md §Design Decision 2: Transaction boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:147), lines 147–152
- [02-tech-design.md §Design Decision 6: Registry location](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:181), lines 181–184
- [02-tech-design.md §Design Decision 7: Deterministic ids](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:185), lines 185–197
- [02-tech-design.md §Interfaces: threads surface](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:416), lines 416–435
- [03-test-plan.md §Flow 1](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/03-test-plan.md:44), lines 44–54

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-1.1 | `test/threads.test.ts` | create happy path: file, metadata row via `openRaw`, registry row |
| TC-1.2 | `test/threads.test.ts` | occupied path: `path_exists`, file untouched, row count unchanged |
| TC-1.3 | `test/threads.test.ts` | resolve known → path; unknown → `thread_not_found` |
| TC-1.5 | `test/threads.test.ts` | three threads listed; absent registry → empty, nothing created |
| TC-1.6 | `test/threads.test.ts` | forced registry failure → file deleted, no registry |

Related dependency reference: full id/path equivalence under intake needs `message-events` and is owned by Story 2; this story proves read-path equivalence only and records the deferral as a named todo in the test file.

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Registry lazy-init non-creation | `test/threads.test.ts` | absent-registry reads create no file | an open-or-create helper passes every TC while silently violating the read contract |

#### Technical Notes

- Thread reference: `{ threadId, registryPath? }` resolves through the registry; `{ filePath }` passes through untouched. Both shapes land on `resolveThreadRef`.
- Registry default `~/.lhc/registry.sqlite`; tests always pass temp paths; CLI flag `--registry`.
- Thread id is the one random id (global uniqueness scope); generated once at creation, stored once in metadata.
- The existence check and file creation are not atomic against a concurrent creator — accepted under single-writer (A1); the loser gets `system_error`, not corruption.

#### Anti-Shim Requirements

- TC-1.6's registry failure must be real (parent-is-a-regular-file path), exercising the actual compensation code — not a mocked insert error.
- TC-1.2's "file untouched" asserts pre-existing file bytes unchanged, not merely that an error was returned.
- AC-1.3 is proven by reading the metadata row through `openRaw` with no registry involvement — not by trusting the creation result.

#### Production Path Proof

- Entrypoint: `lhc threads new-thread | resolve | list` via `dist/cli.js`; SDK exports.
- Registration/default path: CLI router from Story 0 routes these commands to the real surface, replacing the fail-closed stubs.
- Evidence: process-suite leg — `new-thread` → `resolve` round-trip through the spawned binary.

#### Verification

- Targeted: `pnpm test -- test/threads.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-1.1, TC-1.2, TC-1.3, TC-1.5, TC-1.6 green via SDK
- [ ] Same five via CLI in-process; `new-thread` → `resolve` round-trip through the spawned binary in the process suite
- [ ] Lazy-init supplemental test green (absent-registry reads create nothing)
- [ ] Read-path id/path equivalence demonstrated; TC-1.4 deferral to Story 2 recorded in test file as a named todo, not a silent gap
- [ ] Thread-file metadata row carries `token_estimator = "js-tiktoken:o200k_base"`
- [ ] `green-verify` passes (Red tests unmodified); `verify-all` green
