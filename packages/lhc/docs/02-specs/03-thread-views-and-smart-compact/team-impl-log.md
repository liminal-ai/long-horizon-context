# Team Implementation Log

## Run Overview
- State: BETWEEN_STORIES
- Spec Pack Root: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact
- Current Story: 01-pull-and-status
- Current Phase: none
- Preflight: ready (artifacts/preflight/001-preflight.json, 2026-06-11). CLI persisted verification_gates into impl-run.config.json (expected side effect). Codex auth status unknown per preflight note; binary present.

## Run Configuration
- Primary Harness: claude-code
- Story Lead Provider: codex / gpt-5.5 / high
- Story Implementor: none (claude) / claude-fable-5 / medium
- Quick Fixer: none (claude) / claude-opus-4-8 / xhigh
- Story Verifier: codex / gpt-5.5 / xhigh
- Self Review Passes: 3
- Epic Reviewer 1: none (claude) / claude-fable-5 / xhigh
- Epic Reviewer 2: codex / gpt-5.5 / xhigh
- Epic Reverifier: none (claude) / claude-fable-5 / xhigh
- Degraded Diversity: false (codex-cli 0.139.0 available)

## Verification Gates
- Story Gate: pnpm run green-verify (cwd: packages/lhc)
- Story Gate Source: package scripts + spec-pack test-plan policy (test-plan.md L77: "Green exits on green-verify with test immutability")
- Epic Gate: pnpm run verify-all (cwd: packages/lhc)
- Epic Gate Source: package scripts + spec-pack test-plan policy (process suite runs at completion via verify-all)
- Gate Discovery Rationale: candidates were `verify`, `green-verify`, `verify-all`. The generic prefer-plain-verify heuristic was overridden because this spec pack's test plan explicitly pins green-verify as the Green exit (immutability guard is intended project policy) and verify-all (LHC_PROCESS_SUITE=1) as the completion/epic gate. `verify` remains the in-iteration check the stories reference.

## Story Sequence
- 00-foundation
- 01-pull-and-status
- 02-smart-compact
- 03-readiness-sweep
- 04-tool-result-visibility
- 05-render-targets

## Current Continuation Handles
- Story Implementor: none
- Story Verifier: none

## Story Receipts

### 00-foundation
- Story Title: Story 0: Foundation
- Implementor Evidence: artifacts/00-foundation/003-implementor.json
- Verifier Evidence:
  - artifacts/00-foundation/004-verify.json
- Story Gate: pnpm run green-verify — pass (228 default tests, immutability OK)
- Completion Gate: pnpm run verify-all — pass (255 tests incl. process suite)
- Dispositions:
  - spec-deviation-1 (SdkViewConfig.profiles typed ViewProfileOverride[]): fixed-by-design — approved via ruling 00-foundation-story-run-001-ruling-spec-deviation (required to express FC-0.2 unknown-override violation; complete ViewProfile remains assignable)
  - spec-deviation-2 (view_boundary migration seed uses strftime): accepted-risk (benign) — approved via same ruling; one-time static-SQL seed, production writers use injected clock
- Open Risks: none
- Baseline Before: 240
- Baseline After: 255
- Story-lead run: 00-foundation-story-run-001, terminal needs-ruling (spec-deviation); ruling approved and durably recorded in callerInputHistory; planner re-asked same ruling id on resume, so impl-lead completed acceptance directly per ownership model. Final package: artifacts/00-foundation/story-lead/001-final-package.json
- Commit: pending → landed (see git log)

## Cumulative Baselines
- Baseline Before Current Story: 255 (lhc package, verify-all count after 00-foundation)
- Expected After Current Story: ~264 (story 1 estimate ~9 tests)
- Latest Actual Total: 255

## Epic Closeout
- Current Epic Review Artifact: none
- Epic Review Status: not-started
- Epic Fix Status: not-started
- Epic Reverify Status: not-started
- Final Gate Status: not-run

## Open Risks / Accepted Risks
- Story 3 hard gate (cross-epic): before 03-readiness-sweep starts, verify (1) Epic 02 requeue patch landed (live-work-only queue rows), (2) terminal-failure write path persists a classifiable reason class. If opaque, halt story and surface the named Epic 02 patch (stamp provider `retryable` at exhaustion). FC-0.4 in Story 0 is the fixture-side proof.
- Stories 3 and 4 are mutually independent; if Story 3's gate is unmet after Story 2, run Story 4 first and slot Story 3 after.

## Skill/CLI Improvement Notes (for ls-impl / lbuild-impl review)

1. **Ruling file format undocumented.** The skill docs (phases/20, operations/30) describe `--ruling-file <path>` but never specify its content format. First attempt (markdown) failed `INVALID_RULING: not valid JSON`; second attempt (JSON with guessed keys `rulingId`/`response`) failed schema validation. Required shape had to be reverse-engineered from the zod error: `{ rulingRequestId, decision, source, rationale? }`. Skill should document the ruling-file and review-request-file JSON schemas; CLI `--help` could include an example.
2. **Ruling not consumed on resume — possible loop.** After a valid `approve` ruling was recorded (visible in callerInputHistory), two consecutive `resume` calls re-emitted the identical ruling request (`...-ruling-spec-deviation`) with terminal `needs-ruling` and `recommendedImplLeadAction: ask-ruling`, even though the final package said `commitReadiness: ready-for-impl-lead-commit`. Either the planner should see the recorded ruling and terminate `accepted`, or the CLI should treat a recorded ruling matching the open request id as resolving it. Impl-lead worked around by completing acceptance directly (gates + receipt + commit), which the ownership model permits, but the loop wastes a planner turn per resume.
3. **Exit code 2 background failure semantics.** `story-orchestrate run` exiting 2 (needs-ruling) surfaces as a "failed" background task in the caller harness even though it is a normal decision point. Cosmetic, but the skill could note that exit 2 = decision-required, not failure.
4. **Heartbeats not observed on backgrounded run.** Monitor polled the story-lead status.json fine, but no stderr heartbeat content reached the background output file until the terminal envelope. Worth verifying heartbeat emission when stdout/stderr is redirected to a file (non-TTY).
5. **storyRunSelection/baseline mismatch.** `validate` reported `baselineBeforeCurrentStory: 365` (workspace-wide test-file count), while the story-lead final package reported baseline 240→255 (lhc package test count). Two different baseline definitions under one name; skill/CLI should pin which one impl-lead compares.

## Retained Notes (compaction-resilient)

### Spec pack
- Two-file tech-design shape. 38 ACs / 27 TCs; coverage.md confirms 27/27 single-owner mapping. Prompt inserts: both absent (inactive).
- Sequence 0→1→2→{3,4}→5. Story 2 ships sweep-absent (receipt literal `absent`; Story 3 flips it). Story 5 closes deferred process-suite legs for Stories 3/4 and epic parity legs.
- Test plan: 8 test files; ~65 tests total (chunk estimates 6/9/16/10/13/11); default vitest suites + process suite under LHC_PROCESS_SUITE=1. Goldens: Selection G1–G4 + Boundary G1, committed JSON, hand-derived before implementation, immutable once committed.
- Anti-shim themes: fixture states via production drains only (never hand-written derived_form rows); no test-only advance() surface; sweep never waits; materialize renders pull output only; PI format fixture must come from a real PI session with provenance.

### Process
- Per story: story-orchestrate validate → run (background; 1-2 quick checks then persistent 5-min Monitor until terminal) → review final package → fix routing if needed → impl-lead runs story gate (green-verify) + verify-all → baseline check (never lower) → receipt → story commit → advance.
- Closeout: epic-review → epic-fix (curated actionable list-item batch) → epic-reverify loop → impl-lead runs epic gate (verify-all) → COMPLETE.
- Test slices during diagnosis: `bun run test -- --run <files>` (never raw `bun test`).
- Local working dir: repo root /Users/leemoore/code/pi-long-horizon/liminal-context; package under packages/lhc.
