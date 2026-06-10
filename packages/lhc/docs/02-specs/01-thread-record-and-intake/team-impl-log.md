# Team Implementation Log

## Run Overview
- State: BETWEEN_STORIES
- Spec Pack Root: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake
- Current Story: 04-turn-state-machine
- Current Phase: none
- Story 3 accepted; commit landing now
- Story 0 accepted and committed: f89f794 (manual impl-lead acceptance; story-run record stuck needs-ruling due to CLI ruling-application bug — see Open Risks)

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
- Degraded Diversity: false

## Verification Gates
- Story Gate: pnpm --dir /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc run green-verify
- Story Gate Source: explicit CLI flag
- Epic Gate: pnpm --dir /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc run verify-all
- Epic Gate Source: explicit CLI flag
- Gate Discovery Rationale: Gates taken verbatim from the spec pack's per-story Verification sections (story gate `pnpm run green-verify`, epic gate `pnpm run verify-all`, run from packages/lhc) and passed as explicit flags with `pnpm --dir` so they are cwd-independent. Package scripts do not exist yet — Story 0 creates all four gate scripts (red-verify/verify/green-verify/verify-all); the existing package.json only has build/typecheck/dev:cli/test. The skill's prefer-plain-`verify` guidance is overridden here because this spec pack explicitly designs `green-verify` as the story gate with Red-phase protection as a deliberate property (FC-0.7 proves it). Preflight persisted both gates into impl-run.config.json (expected side effect).

## Story Sequence
- 00-foundation
- 01-thread-creation-registry-resolution
- 02-event-recording-validation-idempotency
- 03-message-projection-tokens
- 04-turn-state-machine
- 05-derivation-work-queueing

## Current Continuation Handles
- Story Implementor: none
- Story Verifier: none

## Story Receipts

### 00-foundation
- Story Title: Story 0: Package Foundations
- Implementor Evidence: artifacts/00-foundation/003-implementor.json (initial pass, blocked on old-harness permissions); artifacts/quick-fix/001-quick-fix.json (fix pass, Opus quick-fixer)
- Verifier Evidence:
  - artifacts/00-foundation/004-verify.json (initial: revise, F-00-001 + F-00-002)
  - artifacts/00-foundation/006-verify.json (follow-up: both findings fixed; FC-0.1..0.7 all pass)
- Story Gate: pnpm --dir .../packages/lhc run green-verify — pass (run by impl-lead 2026-06-10T12:57Z; 14 tests, labeled cli-process skip)
- Completion Gate: pnpm --dir .../packages/lhc run verify-all — pass (run by impl-lead 2026-06-10T12:57Z; 18 tests incl. process suite)
- Dispositions:
  - F-00-001 (gates fail in test typecheck): fixed — green-verify/verify-all pass
  - F-00-002 (FC-0.7 self-test proof missing): fixed — fc07 self-test performed and recorded; proof verified by follow-up verifier
  - Spec deviation (zero-dep lint script instead of ESLint): approved by impl-lead ruling (artifacts/00-foundation/ruling-spec-deviation.json) — spec never mandates ESLint; post-cycle note to consider upgrading
  - Spec deviation (.gitkeep placeholders in internal/): approved — consistent with Story 0 no-behavior scope
- Open Risks:
  - Story-run record terminally `needs-ruling` despite recorded approve ruling and story-lead accept decision — lbuild-impl bug (ruling not applied to specDeviations[].approvalStatus). Manual impl-lead acceptance performed; see Open Risks section.
  - Implementor open questions accepted as impl-lead calls, queued for post-cycle review: unknown_command CLI-adapter error code; stub op names in CLI spelling; hash-manifest test-immutability mechanism.
- Baseline Before: 0 (lhc package)
- Baseline After: 18 (lhc package; 3 test files)

### 01-thread-creation-registry-resolution
- Story Title: Story 1: Thread Creation, Registry, Resolution
- Implementor Evidence: artifacts/01-thread-creation-registry-resolution/002-implementor.json (ready-for-verification; ran own Red/Green gates under fixed bypassPermissions harness)
- Verifier Evidence:
  - artifacts/01-thread-creation-registry-resolution/004-verify.json (pass, zero findings, first pass)
- Story Gate: pnpm --dir .../packages/lhc run green-verify — pass (impl-lead 2026-06-10T13:11Z; 26 tests + 1 todo; Red-manifest immutability OK)
- Completion Gate: pnpm --dir .../packages/lhc run verify-all — pass (impl-lead 2026-06-10T13:11Z; 31 tests + 1 todo incl. process suite)
- Dispositions: none (no findings)
- Open Risks:
  - TC-1.4 deferral to Story 2 recorded as named todo in test file (per spec)
  - Post-cycle queue addition: missing_flag CLI-adapter error code (same pattern as unknown_command/empty_stdin)
- Baseline Before: 18
- Baseline After: 31 (+1 todo)

### 02-event-recording-validation-idempotency
- Story Title: Story 2: Event Recording, Validation, Idempotency
- Implementor Evidence: artifacts/02-event-recording-validation-idempotency/003-implementor.json (ready-for-verification, own gates run)
- Verifier Evidence:
  - artifacts/02-event-recording-validation-idempotency/004-verify.json (revise: F-02-001, TC-1.4 stripped recordedAt)
  - artifacts/02-event-recording-validation-idempotency/006-verify.json (pass: F-02-001 resolved)
- Story Gate: green-verify — pass (impl-lead 2026-06-10T13:43Z; 49 tests; 7 Red-phase files unchanged)
- Completion Gate: verify-all — pass (impl-lead 2026-06-10T13:43Z; 58 tests)
- Dispositions:
  - F-02-001: fixed — TC-1.4 compares exact read-back incl. recordedAt via injected fixed clock
- Open Risks:
  - Mid-run interruption: story-lead planner turn after quick-fix #2 emitted invalid JSON (inputs.artifactRefs missing) → run finalized interrupted; resumed cleanly from durable checkpoint and accepted. Codex planner output-contract drift — for the lspec-core review list.
  - Story-lead again routed verifier findings to quick-fix despite recommendedFixScope same-session-implementor (2nd occurrence).
- Baseline Before: 31 (+1 todo)
- Baseline After: 58 (todo closed by TC-1.4 completion)

### 03-message-projection-tokens
- Story Title: Story 3: Message Projection and Token Estimates
- Implementor Evidence: artifacts/03-message-projection-tokens/003-implementor.json + two story-continue rounds
- Verifier Evidence:
  - artifacts/03-message-projection-tokens/004-verify.json (revise: F-03-001 schema migration gap)
  - artifacts/03-message-projection-tokens/006-verify.json (revise: F-03-001 resolved, F-03-002 lazy-migrate on arbitrary files)
  - artifacts/03-message-projection-tokens/008-verify.json (pass: both resolved)
- Story Gate: green-verify — pass (impl-lead 2026-06-10T14:18Z; 10 Red-phase files unchanged)
- Completion Gate: verify-all — pass (impl-lead 2026-06-10T14:18Z; 72 tests)
- Dispositions:
  - F-03-001: fixed — Story 2 thread files migrate to v2 before Story 3 write/read paths
  - F-03-002: fixed — non-thread files rejected caller_error/thread_not_found without mutation
- Open Risks: none
- Baseline Before: 58
- Baseline After: 72

## Cumulative Baselines
- Baseline Before Current Story: 72 tests / 10 test files (lhc package, after Story 3)
- Expected After Current Story: +~14 tests (state-machine golden + turns suites per test plan Flow 3)
- Latest Actual Total: 72 (verify-all 2026-06-10T14:18Z)

## Epic Closeout
- Current Epic Review Artifact: none
- Epic Review Status: not-started
- Epic Fix Status: not-started
- Epic Reverify Status: not-started
- Final Gate Status: not-run

## Open Risks / Accepted Risks
- lbuild-impl BUG (reported to user 2026-06-10): caller ruling responses are recorded (callerInputHistory + ruling-response artifact) but never applied to riskAndDeviationReview.specDeviations[].approvalStatus, so finalization re-emits needs-ruling even after the story-lead planner selects accept-story (terminalDecision "accept"). Story 0's run record is terminally needs-ruling despite full acceptance evidence; impl-lead performed manual acceptance. Every future story with declared spec deviations will hit this until fixed.
- Story-lead routed fix work to quick-fix (Opus) despite verifier recommendedFixScope same-session-implementor — worked here, flagged for lspec-core review.
- quick-fix result envelope carried only rawProviderOutputPreview (no structured taskSummary/changedFiles/gatesRun) under old-harness claude-code child (acceptEdits permission mode).
- Post-cycle review queue: consider ESLint upgrade for lint gate; unknown_command CLI-adapter code; stub op-name spelling; hash-manifest immutability mechanism.
- Spec-pack files were named 01-epic.md/02-tech-design.md/03-test-plan.md; renamed to contract names (epic.md/tech-design.md/test-plan.md) with compatibility symlinks at the old names so in-story design-reference paths still resolve. Inspect was blocked before the rename, ready after.
- Codex auth status reported "unknown" by preflight (binary present, v0.139.0); proceeding per preflight note.
- Target repo worktree was already dirty before this run: old MVP sources deleted/moved to packages/lhc/reference/ (src-green-thread-events-v1, test-green-thread-events-v1), src/ reduced to cli.ts + index.ts shells. This is the intended pre-epic state, not run damage.

## Setup Notes (transcribed retained notes)

### Environment
- Caller harness: Claude Code (impl-lead). Codex CLI 0.139.0 available as secondary.
- Target package: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc (pnpm workspace member; node >=24; deps effect, js-tiktoken; bin lhc -> dist/cli.js).
- Preflight envelope: artifacts/preflight/001-preflight.json (status ok / outcome ready).
- Inspect envelope: artifacts/inspect/002-inspect.json (ready; two-file shape; 6 stories; both prompt inserts absent).

### Spec-pack essentials
- Epic: LHC thread record + intake. Six stories = tech-design chunks 0-5, strictly linear deps, all extending one `messageEvents` walk: resolveThreadRef(S1) -> 3-layer closed validation(S2) -> BEGIN IMMEDIATE + corruption check(S2/S4) -> per-event walk [dedup(S2) -> record(S2) -> project message+blocks+estimate(S3) -> turn transition+stamp(S4) -> queue work(S5)] -> result -> COMMIT.
- Story 0: scaffold, errors.ts vocabulary (caller_error/state_corruption/system_error; codes path_exists, thread_not_found, invalid_event, empty_batch, empty_stdin, turn_state_corrupt, storage_failure), token-counting util (TOKEN_ESTIMATOR_ID "js-tiktoken:o200k_base"), CLI fail-closed stubs, fixture builders, four gates + boundary script, gate self-test FC-0.7. Owns FC-0.1..0.7, no epic ACs.
- Story 1: threads domain (newThread file-then-row + compensation, resolve, listThreads, resolveThreadRef single interpreter), registry lazy-create on write only. TC-1.4 deferred to S2.
- Story 2: heaviest, full-staged-risk. Validation precedes idempotency; skips consume no order numbers; key-wins-over-content; dense MAX(event_order). Four arch-risk tests: mid-walk rollback, restart survival, no-lock-on-rejection, system_error rollback parity. Closes TC-1.4. TC-4.4 corruption leg deferred to S4.
- Story 3: projection in same walk iteration/transaction; verbatim content (300KB byte-identical, SDK + spawned CLI); turnId stays null; projection failure rejects batch.
- Story 4: pure transition fn golden per rule table; transition-then-stamp order; corruption check once at state load; gap messages null forever; corrupt fixture = one sanctioned below-SDK write; completes TC-4.4. AC-3.6/work halves deferred to S5 (close paths simply don't call queue; nothing stubbed).
- Story 5: work-queue util domain-blind, no public SDK surface; kind gate prompt->prompt_smoothing, tool_result->tool_result_summary (messages), turn close->turn_derivation (turns); ids w-<sourceId>-<kind>; gated on recorded. Named exit step: WorkItemRecord field-by-field shape review vs epic contract table, recorded in receipt. Closes full epic TC table.
- Test plan: mock nothing; real SQLite per-test temp dirs; injected fixed clock; ~72 tests expected. Test titles carry TC ids. CLI process suite only in verify-all (labeled skip in verify). TC-1.6 compensation via parent-is-regular-file.
- Coverage: 37/37 ACs, 33/33 TCs single-owner; debts: TC-1.4 S1->S2; TC-4.4 corruption S2->S4; TC-3.3/3.6 work halves + TC-3.8 count S4->S5; TC-5.4 clause ladder S2-S5; AC-4.6 rollback ladder S2-S5.

### Operating reminders
- story-orchestrate validate before run, every story. Background provider-backed calls; poll status.json/updatedAt/lastOutputAt; Claude Code: 1-2 quick checks then persistent 5-min Monitor until terminal.
- Acceptance never delegated: run story gate myself, write receipt (implementor evidence, verifier evidence, gate result, dispositions, risks, baselines), commit lands, then advance.
- Baseline rule: compare test totals before/after each story; a drop blocks acceptance.
