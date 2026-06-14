# Team Implementation Log

## Run Overview
- State: BETWEEN_STORIES
- Spec Pack Root: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core
- Current Story: 02-event-capture-and-turn-derivation (next to start)
- Current Phase: none
- Last Completed Checkpoint: Story 1 ACCEPTED by impl-lead (deviations approved under Lee's standing authorization) + committed. (Receipt below.) Lee directed (2026-06-14) NOT to block on AskUserQuestion for deviation/interpretation calls — make the call and proceed. See memory autonomous-deviation-rulings-no-blocking.
- Prior Current Phase note (historical): verify (plain resume after transient codex planner output-invalid; continue 013 succeeded)
- Update2: continue 013 (healthy fc8b0d70, 20min timeout) SUCCEEDED = ready-for-verification; SV-001/002 fixes on disk (index.ts +296, thread-resolution.ts +174). Then the codex story-lead PLANNER's next turn emitted invalid JSON (provider-output-invalid) -> resume terminated `interrupted`. Transient planner blip, NOT a continue failure (the 20min timeout fixed the continue-stall). The continue work is durable. Plain `story-orchestrate resume` to let the planner retry -> run-verify on the SV fixes. (Earlier 005/007 continue failures were the old broken session + 10min timeout; resolved.)
- Update (recovery worked): reopen review-request -> planner ran FRESH implement 010 (healthy session fc8b0d70). It fixed SV-003 (newThread title) and the placeholder-activate path. Verifier 011 = `revise` (fresh-fix-path), 2 open findings: SV-001 (reload uses module-scope rememberedSessionThreadId, not durable registry re-resolution -> AC-1.5 + arch-risk test) and SV-002 (production --resume auto-resumes most-recent cwd thread, not operator selection -> AC-1.7). Wiring research confirms PI v0.79.2 has ctx.ui.notify (output) but NO interactive input/selection surface -> SV-002 fix must wire picker presentation + selection via available surface OR record an explicit declared deviation (not a silent AC bypass). Routing a `revise` review-request (/tmp/lbuild/s1-review-request-2.json) to story-continue on the HEALTHY fc8b0d70. baseline now 381->384. story-orchestrate will re-emit needs-ruling at the end (deviations); after verifier=pass I rule+accept directly. If verifier still blocks SV-002 as infeasible interactive selection, escalate to user.
- Last Completed Checkpoint: Story 1 attempt-1 stuck. Implement 003 (40m, fresh session) landed substantial+compiling code (pi-lhc lifecycle + A-8 lhc registry). Verifier 004 = `revise`, 3 major findings (SV-001 placeholder activate path; SV-002 reload-from-memory not durable [AC-1.5]; SV-003 newThread missing title), recommendedFixScope=fresh-fix-path. story-continue then failed TWICE resuming implementor session 3bd99b80 (005: silence-timeout stall; 007: PROVIDER_OUTPUT_INVALID truncated-stream after stale-session kill). Runtime replayBoundary keeps saying resume-current-attempt w/ requiresFreshChildProviderSession=false (won't auto-fresh the dead session); validate=blocked resume-required (can't start a new attempt). RECOVERY: raised story_implementor_silence_timeout_ms 600000->1200000, and resuming with an impl-lead review-request (decision=reopen, /tmp/lbuild/s1-review-request.json) that DIRECTS run-implement (fresh session) building on the on-disk code + fixing SV-001/002/003. If the planner still run-continues the dead session and fails, escalate to primitive recovery (fresh story-implement) or user.
- LEARNING: resuming a large/mid-turn-killed claude-code implementor session is unreliable; prefer fresh rehydration (per ls-impl recovery rule). Captured as a follow-up to the needs-ruling memory.
- NOTE: Story 1 includes A-8 LHC-side registry work in packages/lhc (cwd column, partial-id resolve, cwd-filtered listThreads, title). Configured gates are pi-lhc-scoped only, so at Story 1 acceptance ALSO run `pnpm --filter lhc verify` (or lhc test) to catch LHC regressions the pi-lhc gate cannot. Same rule for any later story that touches packages/lhc.

## Orchestration Note: story-orchestrate + implementor-surfaced spec deviations
When the story implementor surfaces spec deviations, the CLI's `buildStoryLeadFinalPackage` (lspec-core dist lbuild-impl.js ~L13567) UNCONDITIONALLY re-injects them with approvalStatus="needs-ruling" on every final-package build, and a caller ruling never mutates those item records. So `story-orchestrate run/resume` will ALWAYS terminate `needs-ruling` for such a story — the story-lead loop cannot self-clear deviations. This is by design: implementor-surfaced deviations are a hard authority boundary handed to impl-lead. RESOLUTION (do not loop resume): deliver the ruling (durable record via --ruling-file), then ACCEPT THE STORY DIRECTLY as impl-lead (independent gate + complete receipt + commit). Acceptance is impl-lead authority; the CLI never accepts.

## Setup Outcome (2026-06-14)
- preflight => ready. Artifact: artifacts/preflight/001-preflight.json
- Provider matrix: primary claude-code available + authenticated (claude.ai, max sub, liminal.builder@gmail.com); secondary codex available (codex-cli 0.139.0), authStatus UNKNOWN (no non-mutating check) — preflight advised proceed if CLI works. WATCH: codex-backed roles (story_lead_provider, story_verifier, quick_fixer) will fail if codex is not logged in; implementor is Claude-backed so implementation itself is unaffected.
- verification_gates persisted into impl-run.config.json by preflight (expected side effect).
- Prompt assets ready; no blockers.

## Run Configuration
- Primary Harness: claude-code
- Story Lead Provider: codex / gpt-5.5 / high
- Story Implementor: none (claude) / claude-opus-4-8 / max
- Quick Fixer: codex / gpt-5.5 / medium
- Story Verifier: codex / gpt-5.5 / xhigh
- Self Review Passes: 3
- Epic Reviewer 1: none (claude) / claude-opus-4-8 / max
- Epic Reviewer 2: codex / gpt-5.5 / high
- Epic Reverifier: none (claude) / claude-opus-4-8[1m] / max
- Degraded Diversity: false (codex secondary harness available at /opt/homebrew/bin/codex)

## Verification Gates
- Story Gate: pnpm --filter pi-lhc verify
- Story Gate Source: explicit CLI flag (preflight --story-gate); persisted to impl-run.config.json
- Epic Gate: pnpm --filter pi-lhc verify-all
- Epic Gate Source: explicit CLI flag (preflight --epic-gate); persisted to impl-run.config.json
- Gate Discovery Rationale: pi-lhc/package.json has no scripts yet (Story 0 creates them), so package-script discovery is empty pre-Story-0. Gate composition mirrors the lhc package (verified): verify = build+typecheck+lint+boundaries+vitest; green-verify = verify + check-test-immutability; verify-all = verify. Per ls-impl setup guidance, story gate = `verify` is preferred over `green-verify` because green-verify's check-test-immutability guard would trip on stories that legitimately add tests. Story files name green-verify (S1-S6) / red-verify (S0) per-story; run-level orchestration uses one uniform story gate (`verify`), which is a strict superset of red-verify and avoids the immutability-guard conflict. Epic gate = verify-all (== verify in this package).

## Story Sequence
- 00-foundation
- 01-session-lifecycle-and-thread-resolution
- 02-event-capture-and-turn-derivation
- 03-capture-verification
- 04-fork-as-new-thread
- 05-inference-host-routing
- 06-startup-validation-and-assignment-config

## Current Continuation Handles
- Story Implementor:
  - Story: 01-session-lifecycle-and-thread-resolution
  - Provider: claude-code
  - Session ID: fc8b0d70-702e-4abc-9faa-dda18cc81eaf (HEALTHY fresh session from reopen-implement 010; old 3bd99b80 abandoned)
  - Result Artifact: artifacts/01-session-lifecycle-and-thread-resolution/010-implementor.json
- Story Verifier:
  - Story: 01-session-lifecycle-and-thread-resolution
  - Provider: codex
  - Session ID: 019ec4a2-e6a9-7261-a8a1-c863991dc47a
  - Result Artifact: artifacts/01-session-lifecycle-and-thread-resolution/011-verify.json

## Story Receipts

### 00-foundation
- Story Title: Story 0: Extension Foundation
- Implementor Evidence: artifacts/00-foundation/003-implementor.json (claude-code session 814546fe-4436-4e4f-8c69-071884ddc90c)
- Verifier Evidence:
  - artifacts/00-foundation/004-verify.json
  - artifacts/00-foundation/005-verify.json (S0-001 resolved; no open findings; codex session 019ec436-5dff-7ec1-a099-fca4b5b8d01c)
- Story Gate: pnpm --filter pi-lhc verify — PASS (impl-lead independent run 2026-06-14: build/typecheck/lint OK (29 files), boundaries OK (19 src files), vitest 6 files / 19 tests pass; story-lead also reported verify-all=pass)
- Dispositions:
  - S0-001 (verifier finding): fixed
  - Spec-deviation #1 (local PI extension types in src/pi/types.ts): accepted-risk — APPROVED by impl-lead ruling (artifacts/00-foundation/story-lead/001-ruling-response-001.json). Verified @earendil-works/* absent from node_modules, pnpm-lock.yaml, and all package.json; local declaration is a faithful, strongly-typed mirror of verified v0.79.2 research, reversible to real imports. Environmental necessity, not a design change.
  - Spec-deviation #2 (initLhc thin wrapper over createSdk): accepted-risk — APPROVED; spec-anticipated by tech-arch A-4 / tech-design Q2 (mechanical).
- Open Risks:
  - Swap local PI types -> real @earendil-works/pi-coding-agent + pi-ai imports when the dependency is installed (Epic 2 serving / Epic 4 packaging).
- Baseline Before: 375
- Baseline After: 381
- Acceptance: story-orchestrate terminal=needs-ruling (structural, see Orchestration Note above). Accepted directly by impl-lead per operating model; committed.

### 01-session-lifecycle-and-thread-resolution
- Story Title: Story 1: Session Lifecycle and Thread Resolution
- Implementor Evidence: artifacts/01-.../010-implementor.json (fresh implement, claude-code fc8b0d70) + artifacts/01-.../013-continue.json (SV-001/002 fix, ready-for-verification). Old session 3bd99b80 abandoned (unstable resume).
- Verifier Evidence:
  - artifacts/01-.../011-verify.json (revise: SV-001 reload, SV-002 --resume)
  - latest resume4 verify (final outcome block on SV-001/SV-002 — literal-AC reading of PI-platform-constrained behavior; codex 019ec4a2)
- Story Gate: pnpm --filter pi-lhc verify — PASS (impl-lead run 2026-06-14: 8 test files / 33 tests). ALSO pnpm --filter lhc verify — PASS (41 files / 388 passed, 9 skipped real-inference) confirming A-8 registry changes cause NO lhc regression.
- Dispositions:
  - placeholder-activate path (orig SV-001): fixed (real activate/hook lifecycle wired).
  - title metadata (orig SV-003): fixed (newThread sets title = cwd leaf default).
  - SV-001 reload reconstruction: accepted-risk — reload now re-resolves from the durable LHC registry (cwd-most-recent), NOT module memory; exact-prior-thread reconstruction deferred (design forbids a PI-session->thread map and a durable resolved-id store). Approved by impl-lead under Lee's standing authorization.
  - SV-002 --resume operator selection: accepted-risk — PI v0.79.2 exposes no interactive input/selection surface (verified wiring research); picker logic is implemented + tested; production presents candidates via ctx.ui.notify and auto-selects most-recent. Approved by impl-lead. UPSTREAM REQUEST: PI extension input/selection API needed for real --resume picker + exact-thread reload.
  - Story 0 inherited deviations (local PI types, initLhc wrapper): accepted-risk (already approved Story 0).
- Open Risks:
  - PI lacks an extension input/selection API -> real --resume operator selection and exact-prior-thread reload are deferred until that API exists (or real PI is wired, Epic 2/4). Filed as an upstream request.
- Baseline Before: 381
- Baseline After: 384
- Acceptance note: verifier final = block on SV-001/SV-002 (PI-platform-constrained ACs). Per ls-impl, accepting a blocked finding as risk is permitted when concrete tech-arch evidence supports the interpretation AND the user accepts; the tech-arch explicitly states PI-API gaps "constrain what an epic can promise" and Lee gave standing authorization to rule such deviations autonomously. A-8 LHC registry work (cwd column, partial-id resolve, cwd-filtered listThreads, title) landed in packages/lhc and passes lhc verify.

## Cumulative Baselines
- Baseline metric: count of workspace test FILES matching `\.(test|spec)\.[cm]?[jt]sx?$` (the runtime's regression metric, from validate baselineSeed) — NOT pi-lhc test-case count.
- Story 0 (00-foundation): before 375 -> after 381 (+6 pi-lhc foundation test files). No regression. ACCEPTED.
- Story 1 (01-session-lifecycle): before 381 -> after 384. No regression (pi-lhc 8 files/33 tests pass; lhc 41 files/388 pass after A-8). ACCEPTED.
- Latest Actual Total: 384
- Next: Story 2 baseline-before = 384.

## Epic Closeout
- Current Epic Review Artifact: none
- Epic Review Status: not-started
- Epic Fix Status: not-started
- Epic Reverify Status: not-started
- Final Gate Status: not-run

## Open Risks / Accepted Risks
- A-8 (LHC registry additions: cwd column, partial-id resolve, cwd-filtered listThreads, title) is Story 1 implementation scope and touches packages/lhc/, not just packages/pi-lhc/. Gated before AC-1.6/1.7.
- M0 inputs pending per spec: recorded corpora are Story 3 fixtures; image/file-ref handling (safe interim = degrade-to-runtime_note) and tool-call rendering are M0 decisions. Story 3 fixture breadth widens as corpora arrive.
- createSdk→initLhc rename (A-4) pending but mechanical; spec uses initLhc.

## Retained Operating Notes (carried forward to survive compaction)
- I am impl-lead (orchestrator) running inside Claude Code (caller harness). lbuild-impl CLI runs ONE bounded op per call; all decisions between calls are mine. Never delegate: acceptance, final gates, recovery strategy.
- Happy path per story: `story-orchestrate validate` -> `story-orchestrate run` -> review final package -> route fixes (story-continue / quick-fix / fresh implementor / escalate) -> run story gate MYSELF -> write complete receipt -> commit -> advance.
- Provider-backed calls run long. POLLING (Claude Code): background the call, 1-2 quick checks, then a persistent ~5-min Monitor cadence on the SAME command until terminal. Never rely on memory to "check back later" (documented stranding failure). Poll progress/<base>.status.json (updatedAt, lastOutputAt) + streams logs; final routing comes from the JSON envelope, not progress.
- Story-lead boundary: story-orchestrate runs one story-lead for one story; it never accepts on my behalf. I review and decide accept/reject/reopen/pause.
- Dispositions: fixed | accepted-risk | defer. Story not accepted until receipt complete AND commit landed. Compare Baseline After vs Before each story (drop = regression = block).
- Tech-design shape: two-file (tech-design.md + test-plan.md). Prompt inserts: both absent. Epic 1 is observe-only.
- Pause for user only on blocked transitions: missing/invalid spec files, ambiguous gate after precedence, unresolved verifier/implementor disagreement, unclear replay boundary, epic-review findings needing product judgment.
