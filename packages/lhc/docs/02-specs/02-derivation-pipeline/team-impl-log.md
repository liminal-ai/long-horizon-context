# Team Impl Log — Epic 02: Derivation Pipeline

State: STORY_ACTIVE
Current Story: 01-queue-execution-drain
Current Phase: implement
Accepted: 00-foundation (commit 967a90f, baseline 155)
Spec-Pack Root: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline
Run Started: 2026-06-11T03:00Z (caller harness: Claude Code, impl-lead)

## Setup Record

### Spec pack
- inspect: `ready` (artifacts/inspect/001-inspect.json). Tech-design shape: **two-file** (tech-design.md + test-plan.md).
- Story inventory (in order): 00-foundation, 01-queue-execution-drain, 02-message-level-derivation, 03-turn-composition-chunk-formation, 04-derivation-state-report-repair, 05-message-edit-cascade, 06-message-turn-delete.
- Prompt inserts: both absent (non-blocking).
- All 7 stories + coverage.md + test-plan.md read in full before story work.

### Configuration (impl-run.config.json, validated by preflight 002)
- primary_harness: claude-code (authenticated, v2.1.172)
- secondary: codex available (codex-cli 0.139.0; auth status unknown — proceed-if-works note from preflight)
- story_lead_provider: codex / gpt-5.5 / high
- story_implementor: none (claude) / claude-fable-5 / medium
- quick_fixer: none / claude-opus-4-8 / xhigh
- story_verifier: codex / gpt-5.5 / xhigh
- epic_verifiers: epic-reviewer-1 = claude-fable-5 xhigh; epic-reviewer-2 = codex gpt-5.5 xhigh
- epic_reverifier: claude-fable-5 xhigh
- self_review passes: 3. Timeouts: skill defaults.
- No degraded-diversity condition (Codex present).

### Verification gates
- Story gate: `pnpm run green-verify` — source: explicit CLI flag to preflight; rationale: every story file's §Verification names green-verify as the story gate; the test-immutability guard is compatible because red-manifest regeneration is a sanctioned story step (Story 0 and Story 2 amendments, test-plan §Sanctioned Amendments). Candidates considered: `verify` (skill default when guard exists) vs `green-verify` (spec-pack policy) — spec pack won.
- Epic gate: `pnpm run verify-all` — source: explicit CLI flag; named by every story's §Verification and runs the process suite (LHC_PROCESS_SUITE=1).
- Gates run from `packages/lhc/`. Preflight persisted verification_gates into impl-run.config.json (expected side effect).

### Cumulative baseline
- Pre-epic baseline: Epic 01 suite = 118 tests (per spec pack; verify at Story 0 gate). Expected epic-end ≈ 178–188.

## Retained Operating Notes (compaction-safe)

- Impl-lead never implements/verifies; CLI runs bounded ops; acceptance + final gates + recovery strategy never delegated.
- Story cycle per story: `story-orchestrate validate` → `story-orchestrate run` (background, monitor via runtime progress artifacts + 5-min Monitor cadence; never rely on memory) → review final package → route fixes (story-continue / quick-fix / fresh implementor / escalate) → run story gate myself → write receipt with dispositions (fixed / accepted-risk / defer) → commit → advance.
- Closeout: epic-review → curate fix batch (only if current canonical review justifies) → epic-fix → epic-reverify loop → epic gate (verify-all) → mark COMPLETE.
- Pause for user: missing files, ambiguous gates, unresolved verifier/implementor disagreement, unclear replay boundary, product-judgment findings.
- Epic facts: 47 ACs / 46 TCs, deps 0→1→2→3→(4,5)→6. Architecture-risk four: TC-1.3 (SIGKILL restart), TC-1.4 (cross-process claim exclusion), TC-5.4 (stale-result/source-version), TC-3.9 (chunk determinism). Sanctioned Epic 01 amendments ONLY: Story 0 versioned work-item ids (`w-…-v<n>` sweep + red-manifest regen), Story 2 tool_call queueing (3→4 rows). Anything else = ruling.
- Test substrate: provider double at production seam; spawned tests use LHC_PROVIDER registry path; manual-mode SDK with budget 3 / backoff 0 / lease 200ms default; process suite gated by LHC_PROCESS_SUITE=1.
- Worktree was clean at run start (commit 823a48c, spec pack committed).

## Story Log

### 00-foundation
- validate: ready (artifacts/00-foundation/001-story-validate.json). Baseline seed before story: 353 test files (workspace-wide count, runtime metric). Epic 01 functional baseline: 118 tests.
- run: launched 2026-06-11T03:01Z (002-story-orchestrate-run.json); implementor child dispatched (003-implementor.json); status running/running_child_operation.
- User authorized full autonomous run through epic completion (overnight).
- 03:27Z terminal `needs-ruling` (ruling-012, test-scope-amendment-ratification): implementor changed thread-migration.test.ts schemaVersionOf assertions 4→5 (migration v5 consequence). Verifier finding 00F-001; all gates reported green by verifier; baseline 132→155.
- 03:30Z impl-lead RULING: ratified (ruling-012-response.json, decision ratify-schema-version-assertion-edits) — mechanical consequence of FC-0.5's migration v5 deliverable, same spirit as sanctioned versioned-id amendments. Resumed via story-orchestrate resume (first attempt rejected INVALID_RULING — schema needs rulingRequestId/decision/source; corrected and resubmitted).
- 03:30Z second ruling (spec-deviation): five deviations reviewed and APPROVED by impl-lead (ruling-spec-deviation-response.json): idx_work_item_queue without rowid (SQLite constraint, semantics preserved); sanctioned versioned-id amendment (17+2 literals, red manifest regenerated incl. thread-migration + fixtures); schema-version 4→5 (ratified ruling-012); scheduler poke seam in shared/context.ts (DD-5 semantics unchanged, avoids import cycle); DD-11 CLI provider resolution deferred to Story 1 (first provider-backed CLI command is drain).
- Story-lead terminal: accept-story (final package 001-final-package.json; all 11 acceptance checks pass; verifier 004/007-verify.json final outcome pass, 00F-001 fixed; commitReadiness ready).

#### RECEIPT — 00-foundation (ACCEPTED 2026-06-11T03:32Z)
- Implementor evidence: artifacts/00-foundation/003-implementor.json (FC-0.1–0.7 implemented; substrate per story scope).
- Verifier evidence: 004-verify.json (initial, finding 00F-001) + 007-verify.json (follow-up: pass, openFindings []).
- Gates run by impl-lead: `pnpm run green-verify` PASS (141 tests, 12 files, immutability OK 16 red files unchanged); `pnpm run verify-all` PASS (155 tests, 18 files, process suite included).
- Cumulative baseline: 132 → 155 (no regression; Epic 01's 118 green on migrated schema — FC-0.5 hard gate met within suite).
- Dispositions: 00F-001 fixed (via ruling-012 ratification). Spec deviations: 5 approved (see above). Accepted-risk: none. Defer: none.
- Open risks: none.
- Commit: pending → recorded below.

### 01-queue-execution-drain
- validate ready; run launched 03:34Z; implementor ~28min; verifier initial found 01F-001 → fixed in retained loop; final verifier pass (006-verify.json).
- 04:04Z terminal needs-ruling (spec-deviation). 04:12Z impl-lead APPROVED 7 deviations (ruling-spec-deviation-response.json): HandlerOutcome.forms centralizing version-checked write in complete(); fail-closed background gating on empty handler map; provider_not_configured code added; deterministic provider in src/providers/ (DD-11 registry reachable from dist/cli.js); payload {sourceVersion, forms}; attempts/lastError in DerivedFormMetadata; red-manifest regen. Resumed → story-lead accept-story.

#### RECEIPT — 01-queue-execution-drain (ACCEPTED 2026-06-11T04:14Z)
- Implementor evidence: artifacts/01-queue-execution-drain/003-implementor.json. Verifier: 004-verify.json (initial, 01F-001) + 006-verify.json (pass, openFindings []).
- Gates run by impl-lead: green-verify PASS (154 tests, immutability OK 19 red files); verify-all PASS (173 tests incl. process suite — TC-1.3 SIGKILL + TC-1.4 claim-exclusion ran).
- Cumulative baseline: 155 → 173 (no regression).
- Dispositions: 01F-001 fixed. Deviations: 7 approved. Accepted-risk/defer: none. Open risks: none.
- Commit: recorded below.

### 02-message-level-derivation
- validate ready; run 04:15Z; implementor ~19min; verifier initial 02F-001 (form read-back on message reads) → fixed; final verifier pass.
- 04:40Z needs-ruling (spec-deviation). 04:42Z impl-lead APPROVED 5 deviations: intake touches in messages/index.ts (Epic 01's actual kind-map placement); call-id index in-place in v5; outcome metadata on result summaries too (FC-0.3-consistent); read-back deferral superseded by 02F-001 fix; sanctioned amendment sweep extended to Epic 02 story 0/1 test files. Resumed → accept-story.

#### RECEIPT — 02-message-level-derivation (ACCEPTED 2026-06-11T04:43Z)
- Implementor: 003-implementor.json. Verifier: initial + follow-up pass (02F-001 fixed, openFindings []).
- Gates by impl-lead: green-verify PASS (163 tests, immutability OK 20 red files); verify-all PASS (182 tests).
- Baseline: 173 → 182 (no regression).
- Dispositions: 02F-001 fixed. Deviations: 5 approved. Accepted-risk/defer: none. Open risks: none.

## Epic Closeout

(pending)
