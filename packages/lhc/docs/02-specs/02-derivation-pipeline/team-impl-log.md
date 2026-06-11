# Team Impl Log — Epic 02: Derivation Pipeline

State: EPIC_VERIFY_ACTIVE
Current Story: — (all 7 accepted)
Current Phase: epic-review
Accepted: 00 (967a90f, 155) · 01 (794c877, 173) · 02 (cc304bb, 182) · 03 (c61397e, 195) · 04 (8b2d92b, 208) · 05 (da58dd5, 218) · 06 (64539ed, 231)
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

### 03-turn-composition-chunk-formation
- validate ready; run 04:44Z; implementor ~20min; verifier initial SV-3.8-001 → fixed; verifier follow-up pass (openFindings []).
- 05:14Z needs-ruling (spec-deviation). 05:15Z impl-lead APPROVED 3 deviations: truncateForFallback implemented in compose.ts (referenced Epic 01 util doesn't exist); handler-map test per-story amendment + red-manifest regen (F-03 procedure, scheduled by the test's own comment); handlers in derive.ts per story table over design sketch. Resumed → accept-story.

#### RECEIPT — 03-turn-composition-chunk-formation (ACCEPTED 2026-06-11T05:16Z)
- Implementor: 003-implementor.json. Verifier: pass after one fixed finding.
- Gates by impl-lead: green-verify PASS (176 tests, immutability OK 21 red files); verify-all PASS (195 tests).
- Baseline: 182 → 195 (no regression). TC-3.9 determinism + chunk golden cases in suite.
- Dispositions: SV-3.8-001 fixed. Deviations: 3 approved. Accepted-risk/defer: none. Open risks: none.

### 04-derivation-state-report-repair
- run 05:17Z; implementor ~25min; verifier BLOCKED on SV-04-001 (AC-4.7: turn/chunk reads lacked direct form-state attachment; implementor had routed states through turns.report only).
- 05:44Z needs-ruling (requirements-scope, ruling-012). Impl-lead REJECTED the deviation: AC-4.7 as written requires states attached on reads (Epic 03 consumer surface); sanctioned mechanical Epic 01 assertion edits if attachment broke exact shapes.
- Resume 1: story-continue completed the fix (ready-for-verification), then planner emitted invalid payload (Codex schema drift) → interrupted. Resume 2: fresh planner turn, verifier follow-up 008-verify.json PASS (SV-04-001 fixed — TC-4.7 asserts direct attachment on message/turn/chunk reads).
- 05:56Z spec-deviation ruling: impl-lead APPROVED final set (frozen-clock TC-4.2 mechanism; requeue at version+1; CLI parity in new process file — Story 1 file hash-locked; refusals reuse existing codes; original forms-deviation rejected-and-fixed). → accept-story.

#### RECEIPT — 04-derivation-state-report-repair (ACCEPTED 2026-06-11T05:57Z)
- Implementor: 003-implementor.json + story-continue. Verifier: 004 (block) → 008 (pass, openFindings []).
- Gates by impl-lead: green-verify PASS (186 tests, immutability OK 23 red files); verify-all PASS (208 tests).
- Baseline: 195 → 208 (no regression).
- Dispositions: SV-04-001 fixed (after rejected deviation). Deviations: final set approved. Accepted-risk/defer: none. Open risks: none.

### 05-message-edit-cascade
- run 05:58Z; implementor ~18min; verifier initial F-05-001 (open-turn enforcement) → fixed with regression test; verifier follow-up pass (openFindings []).
- 06:37Z needs-ruling (spec-deviation). 06:38Z impl-lead APPROVED 4 deviations: CLI parity in new cli-process-mutations.test.ts (Story 1 file hash-locked, Story 4 precedent); TC-5.4 via held manual-drain promise — real claimed pre-edit item across the edit, stale_discarded directly asserted (anti-shim satisfied); --message/--message-id aliases; tool_call edit content-verbatim noted for Story 6.
- Two planner payload glitches (Codex schema drift) required plain resumes; final terminal accept-story, all acceptance checks pass.

#### RECEIPT — 05-message-edit-cascade (ACCEPTED 2026-06-11T06:40Z)
- Implementor: 003-implementor.json. Verifier: initial + follow-up pass.
- Gates by impl-lead: green-verify PASS (194 tests, immutability OK 25 red files); verify-all PASS (218 tests).
- Baseline: 208 → 218 (no regression). TC-5.4 (epic's named architecture-risk race) green in suite.
- Dispositions: F-05-001 fixed. Deviations: 4 approved. Accepted-risk/defer: none. Open risks: none.

### 06-message-turn-delete
- run 06:40Z; first implementor attempt lost to runtime silence-timeout interruption (child internally completed but envelope failed; PROVIDER_UNAVAILABLE recorded) → resumed 06:56Z; re-implement ~55min; verifier initial PASS, zero findings.
- 07:58Z spec-deviation ruling: impl-lead APPROVED 2 deviations (new test files — target files hash-locked, Story 4/5 precedent; --message/--turn -id aliases). → accept-story, all acceptance checks pass.

#### RECEIPT — 06-message-turn-delete (ACCEPTED 2026-06-11T08:00Z)
- Implementor: re-run after interrupt. Verifier: pass, zero findings.
- Gates by impl-lead: green-verify PASS (204 tests, immutability OK 27 red files); verify-all PASS (231 tests — full-suite regression with deleted-read filter live, per story DoD).
- Baseline: 218 → 231 (no regression).
- Dispositions: none raised. Deviations: 2 approved. Accepted-risk/defer: none. Open risks: none.

## Epic Closeout

- 08:00Z epic-review (001-epic-review.json): reviewer-1 (fable-5) pass w/ 5 non-blocking; reviewer-2 (gpt-5.5) BLOCK w/ 2 majors, both dynamically verified; reconciliation upheld block.
  - EPIC-02-BLOCK-001: module-global poke seams → manual SDK can auto-drain after background SDK construction in-process. IMPL-LEAD RULING: per-instance seam scoping (not clear-globals, not refuse-multi-SDK).
  - EPIC-02-BLOCK-002: findPairedBlock reads deleted results (filter bug) + counterpart summary not cascaded. IMPL-LEAD RULING: pair is a source dependency per AC-2.8 symmetry — deleting/editing half a pair clears + requeues the counterpart summary; AC-6.2's bound applies across turns/chunks, not within the pair.
  - Non-blocking recorded (not in this batch): E02-NB-001 clock bypass in mutations/requeue; NB-003 deterministic provider only registered provider; NB-004 thrown handler errors → retryable; NB-005 attempts accounting inconsistency.
- 08:15Z epic-fix launched with fix-batch-001.md (both blockers, rulings embedded; 4 actionable items).
- epic-fix applied fix-batch-001 (all 4 items):
  - BLOCK-001 — per-SDK-instance seam scoping. Replaced the module-global poke/touch *as the SDK→scheduler binding*: each SDK now runs its operations inside an AsyncLocalStorage seam (background → its own scheduler; manual → no-op), carried onto `OperationContext.poke` and consulted by `openThreadDatabase`'s touch. The former global slots survive only as the below-SDK default seam (no SDK in scope: enqueue-atomicity tests + single-background direct-call production path), so they can never auto-drain a manual SDK whose own operations deliver to a no-op. Background still installs the default for direct top-level calls. Regression: `test/epic-fix-02.test.ts` (background-then-manual and manual-then-background, different threads, manual rows stay queued until explicit drain).
  - BLOCK-002a — `findPairedBlock` (and `findUnknownOutcomeCallSummary`) now `JOIN message … AND m.deleted_at IS NULL`: a tool_call whose paired result is deleted derives outcome `unknown`.
  - BLOCK-002b — pair counterpart joins the mutation cascade (`cascade.ts`: `pairedCounterpartSubject` added to the clear set in `cascadeFromMessage` and `cascadeMessageDelete`). Deleting/editing half a call/result pair clears + requeues the live counterpart's tool-activity summary at the next source version; it rebuilds from the live record only.
- **Cascade-scope clarification (fix-batch item 4, impl-lead ruling epic-fix-001):** pair-counterpart summaries are part of the mutation cascade — the call/result pair is a source dependency per **AC-2.8 symmetry**, so a source change to one half clears/requeues the other half's summary. AC-6.2's "nothing else changes" bounds the cascade *across other turns/chunks*; the paired counterpart inside the dependency graph is in scope.
  - Story-06 test-contract change: this ruling reverses exactly what the Story-06 architecture-risk test `mutations-delete.test.ts` TC-6.2 pinned ("nothing outside the chain"; m2's tool_call_summary byte-stable). TC-6.2's `cleared`/`queued` assertions were updated to include `message/m2/tool_call_summary` + `w-m2-tool_call_summary-v2`, and the red-manifest hash for `mutations-delete.test.ts` was re-recorded to bless the change. No other Red file changed.
- Fix-batch-001 execution record: attempt 1 PROVIDER_STALLED at 32min (no code landed); attempt 2 (08:46–09:20Z) landed all 4 items but final envelope malformed (PROVIDER_OUTPUT_INVALID) — work verified on disk by impl-lead. Gates on fixed tree by impl-lead: green-verify PASS (207), verify-all PASS (234).
- 09:29Z epic-reverify (002, fable-5): outcome **needs-fixes**. BLOCK-001/BLOCK-002 resolved. NEW: REVERIFY-02-001 (blocking-candidate) — cascadeTurnDelete missed the pair-counterpart cascade (third caller of DD-8's module; cross-turn pairs reachable, dynamically verified end-to-end). Retained non-blocking: E02-NB-001 (clock bypass), NB-003 (deterministic-only provider, by design), NB-004 (thrown→retryable, documented), NB-005 (attempts asymmetry).
- External spec-vs-build review (3 reviewer agents, via user) — impl-lead verified all findings against the tree, AGREES: Fix 1 (P2) background backoff stall (no timer on 'waiting' stop, scheduler.ts:286-295); Fix 2 (P2) tool-run grouping unimplemented (per-message parts, compose.ts); P3: story-3 max 8000→4400 doc fix; TC-2.7 thinking coverage; delete-side stale-straggler test; impl-log completeness (this entry).
- 09:45Z fix-batch-002.md compiled: Fix 1 P2 + Fix 2 P2 + REVERIFY-02-001 + 3 P3 items + deviation recording. epic-fix round 2 launched.
- epic-fix applied fix-batch-002 (all items):
  - **Fix 1 (P2)** — background backoff wake. `scheduler.ts`: a background drain pass stopping on `waiting` now arms one `unref()`'d wake at the head's `eligible_at` (delay from the SDK clock seam, floored to 5ms), routed through the existing single-flight/coalesce poke path; at most one pending wake per thread (a poke or newer wake clears it via `clearWake` in `schedule`/`armWake`), and `drainSettled` treats a pending wake as unsettled so it spans the retry. Manual mode unchanged (`waiting` stays terminal). The durable `claimNext` eligibility gate remains the correctness guard — the timer is only a nudge. Tests in `epic-fix-02.test.ts` (default suite): positive (fail-once-then-succeed → form ready, 2 provider calls, elapsed ≥ backoff) + negative (long backoff → no retry before `eligible_at`).
  - **Fix 2 (P2)** — tool-run grouping (AC-3.4 anti-shim restoration). `compose.ts`: `composeRenderingInput` folds maximal runs of consecutive tool_call/tool_result into one `RenderingPart` + one receipt with an outcome-explicit run account; prompts/assistant text break runs, thinking/runtime notes are transparent (interior fold inline, edge stand alone — recorded in story deviation table). Per-message mechanical stamping and gaps untouched; `ToolRunReceipt` shape unchanged (one per run now). `deterministic.ts` join unaffected (still `parts.map(p=>p.text)`). Red-committed `derivation-turns.test.ts` TC-3.4 + SV-3.8-001 updated to grouped reality and the red-manifest hash re-recorded to bless it (epic-fix-001 precedent); new grouping + mixed-outcome tests in `epic-fix-02.test.ts`.
  - **REVERIFY-02-001** — `cascadeTurnDelete` (the third DD-8 caller) now collects each deleted member's live paired counterpart (same-turn members skipped via deleted-read filter + explicit `memberSet`, deduped) into the clear set, exactly as `cascadeFromMessage`/`cascadeMessageDelete`. Cross-turn regression in `epic-fix-02.test.ts`: call in t1, late result in prompt-initiated t2 (summary rebuilt `succeeded`), `deleteTurn(t2)` → m2's call summary cleared/requeued v3, rebuilds `unknown`.
  - **Fix 3.1** — story-3 chunk-max doc `8000`→`4400`. **Fix 3.2** — TC-2.7 in `derivation-messages.test.ts` extended with an `assistant_thinking` event (no work rows, no derivation state); red-manifest re-recorded. **Fix 3.3** — delete-side stale-straggler test in `epic-fix-02.test.ts`: held claimed `tool_call_summary` for m2, delete m2 mid-flight → completion `stale_discarded`, tombstone + counterpart cascade intact, queue drains clean.
  - Deviation recording: tech-design Deviation Table rows E02-FIX1 (DD-4 completion) + E02-FIX2 (AC-3.4 spec-compliance restoration); story-3 Spec Deviations section (Fix 2 restoration + thinking/notes decision).
- Gates on fixed tree: green-verify PASS (213 tests, immutability OK 27 red files), verify-all PASS (240 tests incl. LHC_PROCESS_SUITE=1). Baseline 234 → 240 (no regression). Two red files re-recorded (`derivation-turns.test.ts`, `derivation-messages.test.ts`); no other Red file changed.
- Fix-batch-002 execution: attempt 1 blocked (auth expiry, no code). Attempt 2 (09:56–10:26Z) landed all 7 items: scheduler armWake timer (one per thread, unref'd, cleared on poke/newer wake — Fix 1); tool-run grouping in compose.ts (maximal consecutive runs → one part + one receipt, mixed outcomes explicit; thinking/notes don't break runs, recorded as story deviation — Fix 2); pairedCounterpartSubject in cascadeTurnDelete (REVERIFY-02-001); story-3 max 4400 doc fix; TC-2.7 thinking; delete-side stale-straggler test; epic-fix-02.test.ts +290 lines. Red manifest re-recorded for 2 amended files (blessed-change). Final envelope again PROVIDER_OUTPUT_INVALID — work verified on disk by impl-lead.
- Impl-lead gates on fix-batch-002 tree: green-verify PASS (213, immutability OK 27); verify-all PASS (240).
- Note: docs/02-specs/03-thread-views-and-smart-compact/* changes are the spec author's (outside this run) — kept out of fix commits.
- Commit 40facf7. Current Phase: epic-reverify (round 2) applied — pending re-verify
